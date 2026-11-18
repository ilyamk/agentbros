import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { ReferenceSourceSchema, type ReferenceSource } from "../../types/reference";
import { corpusCandidates } from "./corpus";
import { excludedReferenceIds, excludeFile, flaggedPrivateIds } from "./private";
import { readFullSpeechText } from "./speech-text";
import { referenceVerbatim } from "./verbatim";

// What a contribution of reference analyses may carry: our analyses (JSON and Markdown) and nothing of the film itself.
// Every check is local and read-only; the result lists each problem with its fix.

export type ContributeIssue = {
  check: "private" | "media" | "verbatim" | "provenance" | "inspired-by" | "private-id";
  file?: string;
  message: string;
};
export type ContributeReference = { id: string; issues: ContributeIssue[]; filmTextLocal: boolean };
export type ContributeReport = {
  passed: boolean;
  checked: ContributeReference[];
  /** Private references left out of --all: they stay on this machine. */
  localOnly: string[];
  /** Problems not tied to one checked reference: private ids in tracked files or commit messages, unknown references in inspiredBy. */
  repository: ContributeIssue[];
  warnings: string[];
};

/** Only these kinds of file may be tracked under a reference: see the allow-list in .gitignore. */
const ALLOWED = /\.(json|md)$/;
const LOCAL_ONLY = /^(media|visuals|compare)\//;

function git(cwd: string, args: string[]): string | undefined {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (error) {
    // git grep exits 1 when nothing matches: that is an answer, not a failure
    const status = (error as { status?: number }).status;
    return status === 1 ? "" : undefined;
  }
}

const lines = (text: string | undefined) => (text ?? "").split("\n").filter(Boolean);

/** Rows of CREDITS.md section 2: first cell (the reference id or a neutral name) and the whole row. */
export function creditRows(credits: string): { name: string; cells: string[]; row: string }[] {
  const start = credits.search(/^## 2\. /m);
  if (start < 0) return [];
  const rest = credits.slice(start);
  const end = rest.slice(3).search(/^## /m);
  const section = end < 0 ? rest : rest.slice(0, end + 3);
  return section
    .split("\n")
    .filter((line) => line.startsWith("| ") && !line.startsWith("| Brand / title") && !/^\|[-|\s]+\|$/.test(line))
    .map((row) => {
      const cells = row
        .slice(1, -1)
        .split(" | ")
        .map((cell) => cell.trim());
      return { name: cells[0]!, cells, row };
    });
}

/** A row's problems for one reference: the sha256 prefix and the rights status must match its source.json. */
export function provenanceIssues(id: string, source: ReferenceSource, rows: ReturnType<typeof creditRows>): string[] {
  const row = rows.find((candidate) => candidate.name === id);
  if (!row)
    return [
      `CREDITS.md section 2 has no row for ${id}: add one with its source (link, or "unrecorded" and the file name), Rights and the media's sha256 prefix.`,
    ];
  const issues: string[] = [];
  const prefixes = [...row.row.matchAll(/sha256 `([a-f0-9]{8,64})/g)].map((match) => match[1]!);
  if (!prefixes.length)
    issues.push(
      `CREDITS.md row ${id} gives no sha256 prefix: add sha256 \`${source.sha256.slice(0, 8)}…\` from source.json.`,
    );
  else if (!prefixes.some((prefix) => source.sha256.startsWith(prefix)))
    issues.push(
      `CREDITS.md row ${id}: sha256 ${prefixes.join(", ")} is not a prefix of source.json's ${source.sha256.slice(0, 8)}…`,
    );
  const rights = row.cells[2] ?? "";
  if (!rights.split(/[^a-z-]+/).includes(source.rights.status))
    issues.push(
      `CREDITS.md row ${id}: Rights "${rights}" differs from source.json rights.status "${source.rights.status}".`,
    );
  if (!(row.cells[1] ?? "").trim())
    issues.push(`CREDITS.md row ${id} has no source: give the link, or "unrecorded" with the file name.`);
  return issues;
}

/** Reference ids an inspiredBy entry names: a library path, or a known id as a whole word. */
export function referencesNamed(entry: string, knownIds: Iterable<string>): string[] {
  const found = new Set<string>();
  for (const match of entry.matchAll(/design-reference\/library\/([a-z0-9][a-z0-9-]*)/g)) found.add(match[1]!);
  const lower = entry.toLowerCase();
  for (const id of knownIds)
    if (new RegExp(`(^|[^a-z0-9-])${id.replace(/-/g, "\\-")}($|[^a-z0-9-])`).test(lower)) found.add(id);
  return [...found].sort();
}

/** A regex for a private id in any spelling a person might write: hyphens, underscores, spaces or none between its parts. */
export const idPattern = (id: string) => `(^|[^a-z0-9])${id.split("-").join("[-_ ]?")}([^a-z0-9]|$)`;

/** Tracked and staged files (the index) whose text names a private id, and commit messages on this branch that do. */
export function privateIdLeaks(repoRoot: string, ids: string[], base?: string): ContributeIssue[] {
  const issues: ContributeIssue[] = [];
  for (const id of ids) {
    for (const file of lines(git(repoRoot, ["grep", "--cached", "-I", "-i", "-l", "-E", "-e", idPattern(id)])))
      issues.push({
        check: "private-id",
        file,
        message: `${file} names the private reference ${id}: write "a private reference" instead.`,
      });
    for (const file of lines(git(repoRoot, ["ls-files"])).filter((file) => new RegExp(idPattern(id), "i").test(file)))
      issues.push({
        check: "private-id",
        file,
        message: `A tracked path names the private reference ${id}: ${file}. Remove it from the index (git rm --cached) and ignore it in .git/info/exclude.`,
      });
    if (base) {
      const messages = git(repoRoot, ["log", "--format=%H %B", `${base}..HEAD`]) ?? "";
      if (new RegExp(idPattern(id), "i").test(messages))
        issues.push({
          check: "private-id",
          message: `A commit message since ${base} names the private reference ${id}: reword it before pushing.`,
        });
    }
  }
  return issues;
}

/** The checks behind `pnpm ref:contribute`; `repoRoot` is the checkout, `libraryRoot` relative to it or absolute. */
export function checkContribution(request: {
  repoRoot: string;
  libraryRoot: string;
  ids?: string[];
  all?: boolean;
  base?: string;
  credits?: string;
  catalogue?: string;
}): ContributeReport {
  const libraryRoot = path.resolve(request.repoRoot, request.libraryRoot);
  const libraryRelative = path.relative(request.repoRoot, libraryRoot).split(path.sep).join("/");
  const warnings: string[] = [];
  const repository: ContributeIssue[] = [];
  const flagged = new Set(flaggedPrivateIds(libraryRoot));
  const excluded = new Set(excludedReferenceIds(libraryRoot));
  const privateIds = [...new Set([...flagged, ...excluded])].sort();
  const known = existsSync(libraryRoot)
    ? corpusCandidates(libraryRoot).filter((id) => existsSync(path.join(libraryRoot, id, "source.json")))
    : [];
  const ids = request.all ? known.filter((id) => !privateIds.includes(id)) : (request.ids ?? []);
  const localOnly = request.all ? known.filter((id) => privateIds.includes(id)) : [];

  const ignored = (id: string) => {
    try {
      execFileSync("git", ["check-ignore", "-q", "--no-index", `${libraryRelative}/${id}/source.json`], {
        cwd: request.repoRoot,
        stdio: "ignore",
      });
      return true;
    } catch {
      return false;
    }
  };
  for (const id of flagged)
    if (!excluded.has(id) && excludeFile(libraryRoot) && !ignored(id))
      repository.push({
        check: "private",
        message: `${id} is private: true but not ignored in .git/info/exclude, so git add would take it: run pnpm ref:add --id ${id} --private.`,
      });

  const creditsText = existsSync(path.join(request.repoRoot, request.credits ?? "CREDITS.md"))
    ? readFileSync(path.join(request.repoRoot, request.credits ?? "CREDITS.md"), "utf8")
    : "";
  const rows = creditRows(creditsText);
  const credited = new Set(rows.map((row) => row.name));
  const tracked = lines(git(request.repoRoot, ["ls-files", "--", libraryRelative]));
  const untracked = lines(git(request.repoRoot, ["ls-files", "--others", "--exclude-standard", "--", libraryRelative]));

  const checked = ids.map((id): ContributeReference => {
    const directory = path.join(libraryRoot, id);
    const issues: ContributeIssue[] = [];
    if (!existsSync(path.join(directory, "source.json")))
      return {
        id,
        issues: [{ check: "provenance", message: `No reference ${id} in ${libraryRelative}.` }],
        filmTextLocal: false,
      };
    if (privateIds.includes(id))
      issues.push({
        check: "private",
        message: `${id} is a private reference (${flagged.has(id) ? "private: true in source.json" : ""}${flagged.has(id) && excluded.has(id) ? ", " : ""}${excluded.has(id) ? "ignored in .git/info/exclude" : ""}): it is never contributed.`,
      });
    const prefix = `${libraryRelative}/${id}/`;
    for (const file of tracked.filter((file) => file.startsWith(prefix))) {
      const inside = file.slice(prefix.length);
      if (!ALLOWED.test(inside) || LOCAL_ONLY.test(inside))
        issues.push({
          check: "media",
          file,
          message: `${file} is tracked or staged: only our .json and .md analyses may be. git rm --cached it; the ignore rules keep it local.`,
        });
    }
    for (const file of untracked.filter((file) => file.startsWith(prefix))) {
      const inside = file.slice(prefix.length);
      if (!ALLOWED.test(inside) || LOCAL_ONLY.test(inside))
        issues.push({
          check: "media",
          file,
          message: `${file} is not ignored, so git add would take it: move it under media/ or visuals/, or delete it.`,
        });
    }
    const film = readFullSpeechText(directory);
    for (const finding of referenceVerbatim(directory, film))
      issues.push({
        check: "verbatim",
        file: `${prefix}${finding.file}`,
        message:
          finding.kind === "speech-text"
            ? `${prefix}${finding.file} holds the film's words: run pnpm ref:redact --id ${id}.`
            : `${prefix}${finding.file} ${finding.where}: ${finding.kind === "quote" ? "quotes" : "copies"} ${finding.words} of the film's words ("${finding.excerpt}"); describe the copy instead.`,
      });
    if (!film)
      warnings.push(
        `${id}: no local text for the film (media/speech-text.full.json), so only quotation marks were checked, not unquoted copies of its words.`,
      );
    try {
      const source = ReferenceSourceSchema.parse(JSON.parse(readFileSync(path.join(directory, "source.json"), "utf8")));
      for (const message of provenanceIssues(id, source, rows))
        issues.push({ check: "provenance", file: request.credits ?? "CREDITS.md", message });
    } catch (error) {
      issues.push({
        check: "provenance",
        file: `${prefix}source.json`,
        message: `source.json does not parse: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
    return { id, issues, filmTextLocal: !!film };
  });

  // Blocks that cite a reference must have its credit row; with --id, only the blocks citing those references.
  const cataloguePath = path.join(request.repoRoot, request.catalogue ?? "docs/library/catalogue.json");
  if (existsSync(cataloguePath)) {
    const catalogue = JSON.parse(readFileSync(cataloguePath, "utf8")) as {
      items?: { id: string; inspiredBy?: string[] }[];
      styles?: { id: string; inspiredBy?: string[] }[];
    };
    const names = new Set([...known, ...credited, ...privateIds]);
    for (const block of [...(catalogue.items ?? []), ...(catalogue.styles ?? [])])
      for (const entry of block.inspiredBy ?? [])
        for (const id of referencesNamed(entry, names)) {
          if (!request.all && !ids.includes(id)) continue;
          if (privateIds.includes(id))
            repository.push({
              check: "private-id",
              file: "docs/library/catalogue.json",
              message: `Block ${block.id} names the private reference ${id} in inspiredBy: cite its neutral CREDITS name instead.`,
            });
          else if (!credited.has(id))
            repository.push({
              check: "inspired-by",
              file: "docs/library/catalogue.json",
              message: `Block ${block.id} cites ${id} in inspiredBy, which has no CREDITS.md section 2 row.`,
            });
        }
  } else
    warnings.push(
      `No ${request.catalogue ?? "docs/library/catalogue.json"}: inspiredBy not checked. Run pnpm library:catalogue.`,
    );

  repository.push(...privateIdLeaks(request.repoRoot, privateIds, request.base));
  const passed = !repository.length && checked.every((row) => !row.issues.length);
  return { passed, checked, localOnly, repository, warnings };
}
