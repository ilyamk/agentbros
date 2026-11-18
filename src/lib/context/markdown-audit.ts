import { createHash } from "node:crypto";
import path from "node:path";
import type { RepositoryText } from "./repository";
import { auditRepositoryHygiene } from "../workspace/hygiene";

type Role =
  | "instruction"
  | "prompt"
  | "reference"
  | "fixture"
  | "release"
  | "licence"
  | "protocol"
  | "guide"
  | "plan"
  | "historical"
  | "evidence"
  | "other";
type Reference = { file: string; line: number; kind: "code-or-config" | "document" | "historical" };
type MarkdownFile = {
  path: string;
  bytes: number;
  sha256: string;
  heading: string;
  status: string;
  role: Role;
  historical: boolean;
  decision: "keep" | "review";
  reason: string;
  connected: boolean;
  references: Reference[];
};

const MARKDOWN = /\.mdx?$/i;
const TEXT = /\.(?:mdx?|[cm]?[jt]sx?|json|ya?ml|toml|py|sh|swift|html|css|txt)$/i;
const PROTECTED = new Set<Role>(["instruction", "prompt", "reference", "fixture", "release", "licence", "protocol"]);
const ARCHIVE = /^(?:docs\/(?:archive|workstreams|verification)\/)|(?:^|\/)[^/]*-pins\.json$/;
const PATH_TOKEN = /(?:\.{1,2}\/|\/)?(?:[\p{L}\p{N}_.@%+~-]+\/)*[\p{L}\p{N}_.@%+~-]+\.mdx?\b/giu;

function describe(file: string, text: string): { role: Role; historical: boolean; status: string; heading: string } {
  const opening = text.split(/\r?\n/).slice(0, 20);
  const status = opening.find((line) => /^Status:/i.test(line)) ?? "";
  const pending = /\b(?:in progress|pending|remaining|incomplete|not (?:claimed )?complete)\b/i.test(status);
  const historical =
    /^docs\/(?:archive|workstreams)\//.test(file) ||
    /^Status:\s*(?:historical|superseded|archived)/i.test(status) ||
    (!pending && /^Status:\s*(?:implemented\b|(?:zero-spend )?implementation and verification complete)/i.test(status));
  const basename = path.posix.basename(file);
  let role: Role = "other";
  if (/^(?:AGENTS|CLAUDE)\.md$/i.test(basename) || file.startsWith("contrib/")) role = "instruction";
  else if (/^(?:LICEN[CS]E|NOTICE|COPYING|COPYRIGHT|CLA|COMMERCIAL-LICENSE)(?:\.|$)/i.test(basename)) role = "licence";
  else if (file.startsWith(".agents/")) role = "prompt";
  else if (file.startsWith("tests/fixtures/")) role = "fixture";
  else if (file.startsWith(".changes/")) role = "release";
  else if (file.startsWith("design-reference/")) role = "reference";
  else if (file.startsWith("examples/") || file.startsWith("vendor/")) role = "reference";
  else if (basename === "README.md" && /^(?:bench|community)\//.test(file)) role = "protocol";
  else if (historical) role = "historical";
  else if (file.startsWith("docs/verification/")) role = "evidence";
  else if (file.startsWith("tests/")) role = "other";
  else if (/(?:^|\/)[^/]*plan\.md$/i.test(file) || file.startsWith("docs/rfcs/")) role = "plan";
  else if (
    /^docs\/(?:[^/]+\.md|workflows\/|blender-arsenal\/)/.test(file) ||
    basename === "README.md" ||
    /^(?:contrib|playbooks)\//.test(file) ||
    /^(?:CONTRIBUTING|SECURITY|CODE_OF_CONDUCT|ROADMAP|CHANGELOG)\.md$/.test(file)
  )
    role = "guide";
  return { role, historical, status, heading: opening.find((line) => /^#\s/.test(line))?.replace(/^#\s+/, "") ?? "" };
}

function normaliseTarget(raw: string): string | undefined {
  if (/^(?:[a-z][\w+.-]*:|#|\/\/)/i.test(raw) || /[{}*$]/.test(raw)) return undefined;
  try {
    return decodeURIComponent(raw.split(/[?#]/)[0]!).replace(/:\d+(?::\d+)?$/, "");
  } catch {
    return undefined;
  }
}

/** Static references are review evidence, never proof that a file executes or is safe to delete. */
export function auditMarkdown(repo: RepositoryText) {
  const hygiene = auditRepositoryHygiene(repo);
  const unsuitable = new Set(hygiene.findings.map((finding) => finding.file));
  const sources = new Map<string, string>();
  const skipped: string[] = [];
  for (const file of [...new Set(repo.files)].sort()) {
    if (!TEXT.test(file) || file.split("/").some((part) => part === ".env" || part.startsWith(".env."))) continue;
    const text = repo.read(file);
    if (text === undefined || text.includes("\0")) {
      skipped.push(file);
      continue;
    }
    sources.set(file, text);
  }
  const files: MarkdownFile[] = [...sources]
    .filter(([file]) => MARKDOWN.test(file))
    .map(([file, text]) => ({
      path: file,
      bytes: Buffer.byteLength(text),
      sha256: createHash("sha256").update(text).digest("hex"),
      ...describe(file, text),
      decision: "review",
      reason: "No declared role or current reference found",
      connected: false,
      references: [],
    }));
  const byPath = new Map(files.map((file) => [file.path, file]));
  const outgoing = new Map<string, Set<string>>();
  const brokenLinks: { file: string; line: number; target: string }[] = [];
  const add = (source: string, target: string, line: number) => {
    const row = byPath.get(target);
    if (!row || target === source) return;
    const origin = byPath.get(source);
    const kind =
      ARCHIVE.test(source) ||
      source.startsWith("tests/fixtures/") ||
      origin?.historical ||
      origin?.role === "fixture" ||
      origin?.role === "release"
        ? "historical"
        : origin
          ? "document"
          : "code-or-config";
    if (!row.references.some((ref) => ref.file === source && ref.line === line))
      row.references.push({ file: source, line, kind });
    if (kind !== "historical") {
      const links = outgoing.get(source) ?? new Set<string>();
      links.add(target);
      outgoing.set(source, links);
    }
  };
  for (const [source, text] of sources) {
    const document = byPath.has(source);
    let fence: string | undefined;
    text.split(/\r?\n/).forEach((line, index) => {
      const marker = document && /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
      if (marker) {
        if (!fence) fence = marker;
        else if (marker[0] === fence[0] && marker.length >= fence.length) fence = undefined;
        return;
      }
      if (!/\.mdx?\b/i.test(line)) return;
      if (document && !fence) {
        const rendered = line.replace(/(`+)(.*?)\1/g, "");
        for (const match of rendered.matchAll(
          /\[[^\]\n]*\]\((?:<([^>\n]+)>|([^\s)>]+))(?:\s+"[^"]*")?\)|^\s*\[[^\]]+\]:\s*(?:<([^>\n]+)>|(\S+))/g,
        )) {
          const target = normaliseTarget((match[1] ?? match[2] ?? match[3] ?? match[4])!);
          if (!target || !MARKDOWN.test(target)) continue;
          const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(source), target));
          if (byPath.has(resolved)) add(source, resolved, index + 1);
          else if (!repo.exists(resolved)) brokenLinks.push({ file: source, line: index + 1, target });
        }
      }
      const local = line.replace(/(?:https?|file|git):\/\/[^\s<>"'`)]+/g, "");
      const literals = [...local.matchAll(/(["'`])([^\n]*?)\1/g)]
        .map((match) => match[2]!)
        .filter((value) => /\.mdx?(?:[?#].*)?$/i.test(value));
      for (const raw of [...literals, ...[...local.matchAll(PATH_TOKEN)].map((match) => match[0])]) {
        const target = normaliseTarget(raw);
        if (!target || target.startsWith("/")) continue;
        const relative = path.posix.normalize(path.posix.join(path.posix.dirname(source), target));
        // Bare names resolve locally first; root-relative paths are also common in code and instructions.
        if (byPath.has(relative)) add(source, relative, index + 1);
        else if (byPath.has(target)) add(source, target, index + 1);
      }
    });
  }
  const queue = files
    .filter(
      (file) =>
        PROTECTED.has(file.role) ||
        /^(?:README|AGENTS|CONTRIBUTING|SECURITY|CODE_OF_CONDUCT|ROADMAP|CHANGELOG)\.md$/.test(file.path) ||
        (file.role === "plan" &&
          !file.historical &&
          /\b(?:in progress|draft|proposed|pending|remaining|not (?:claimed )?complete|open)\b/i.test(file.status)) ||
        file.references.some((ref) => ref.kind === "code-or-config"),
    )
    .map((file) => file.path);
  const connected = new Set(queue);
  for (let index = 0; index < queue.length; index++) {
    const source = queue[index]!;
    if (byPath.get(source)?.historical) continue;
    for (const target of outgoing.get(source) ?? [])
      if (!connected.has(target)) {
        connected.add(target);
        queue.push(target);
      }
  }
  for (const file of files) {
    file.connected = connected.has(file.path);
    if (unsuitable.has(file.path))
      file.reason =
        "Machine-specific content or maintenance output; remove from source or make the functional input portable. References do not override repository hygiene.";
    else if (PROTECTED.has(file.role)) {
      file.decision = "keep";
      file.reason = `Required ${file.role} material`;
    } else if (file.historical)
      file.reason = file.connected
        ? "Completed or superseded record; resolve current references before removal"
        : "Completed or superseded record; candidate for removal after content review";
    else if (file.connected) {
      file.decision = "keep";
      file.reason =
        file.role === "plan"
          ? "Product plan with declared pending scope or a current consumer"
          : "Referenced by code/configuration or reachable current documentation";
    } else if (file.role === "evidence")
      file.reason = "Dated evidence without a detected current consumer; review unique acceptance claims";
    else file.reason = "No connection from code, agent instructions or current documentation detected; review content";
  }
  const directories = new Map<
    string,
    {
      path: string;
      totalFiles: number;
      otherFiles: number;
      markdown: number;
      ownMarkdown: number;
      keep: number;
      review: number;
      connected: number;
      roles: Partial<Record<Role, number>>;
    }
  >();
  for (const file of [...new Set(repo.files)].sort()) {
    if (!repo.exists(file)) continue;
    const md = byPath.get(file);
    let directory = path.posix.dirname(file);
    const own = directory;
    while (true) {
      const row = directories.get(directory) ?? {
        path: directory,
        totalFiles: 0,
        otherFiles: 0,
        markdown: 0,
        ownMarkdown: 0,
        keep: 0,
        review: 0,
        connected: 0,
        roles: {},
      };
      row.totalFiles++;
      if (md) {
        row.markdown++;
        row[md.decision]++;
        row.roles[md.role] = (row.roles[md.role] ?? 0) + 1;
        if (md.connected) row.connected++;
        if (directory === own) row.ownMarkdown++;
      } else row.otherFiles++;
      directories.set(directory, row);
      if (directory === ".") break;
      directory = path.posix.dirname(directory);
    }
  }
  const folders = [...directories.values()]
    .map((row) => ({
      ...row,
      disposition:
        row.markdown === 0 ? "no-markdown" : row.keep === 0 ? "review-only" : row.review === 0 ? "keep" : "mixed",
    }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const reviewOnlyDirectories = folders
    .filter((row) => row.path !== "." && row.ownMarkdown > 0 && row.keep === 0 && row.otherFiles === 0)
    .map((row) => row.path);
  const groups = new Map<string, string[]>();
  for (const file of files) groups.set(file.sha256, [...(groups.get(file.sha256) ?? []), file.path]);
  return {
    version: 1,
    scope:
      "Git working tree: tracked and non-ignored untracked files; no dependency, cache, project or personal-memory sweep",
    summary: {
      markdown: files.length,
      bytes: files.reduce((sum, file) => sum + file.bytes, 0),
      keep: files.filter((file) => file.decision === "keep").length,
      review: files.filter((file) => file.decision === "review").length,
      historical: files.filter((file) => file.historical).length,
      directories: folders.length - (directories.has(".") ? 1 : 0),
      markdownDirectories: folders.filter((row) => row.path !== "." && row.ownMarkdown > 0).length,
      reviewOnlyDirectories: reviewOnlyDirectories.length,
      brokenLinks: brokenLinks.length,
      hygieneIssues: hygiene.findings.length,
    },
    repositoryHygiene: hygiene,
    reviewOnlyDirectories,
    directories: folders,
    files,
    brokenLinks,
    duplicates: [...groups.values()].filter((group) => group.length > 1),
    skipped,
    limitations: [
      "Static literal references include comments and declared output paths; they do not prove runtime execution.",
      "Dynamically assembled paths, directory-wide loaders and external consumers may be missed; an unreferenced file is not automatically rubbish.",
      "Historical snapshots and test/release Markdown do not make their referenced documents current.",
      "Keep/review are advisory classifications. This command never deletes or edits source files.",
    ],
  };
}

export function markdownAuditTsv(report: ReturnType<typeof auditMarkdown>): string {
  const cell = (value: unknown) => String(value).replace(/[\t\r\n]/g, " ");
  return (
    [
      ["path", "decision", "role", "bytes", "connected", "status", "reason", "references"],
      ...report.files.map((file) => [
        file.path,
        file.decision,
        file.role,
        file.bytes,
        file.connected,
        file.status,
        file.reason,
        file.references.map((ref) => `${ref.file}:${ref.line} (${ref.kind})`).join("; "),
      ]),
    ]
      .map((row) => row.map(cell).join("\t"))
      .join("\n") + "\n"
  );
}

export function markdownFoldersTsv(report: ReturnType<typeof auditMarkdown>): string {
  return (
    [
      [
        "path",
        "disposition",
        "totalFiles",
        "otherFiles",
        "markdown",
        "ownMarkdown",
        "keep",
        "review",
        "connected",
        "roles",
      ],
      ...report.directories.map((row) => [
        row.path,
        row.disposition,
        row.totalFiles,
        row.otherFiles,
        row.markdown,
        row.ownMarkdown,
        row.keep,
        row.review,
        row.connected,
        JSON.stringify(row.roles),
      ]),
    ]
      .map((row) => row.map((value) => String(value).replace(/[\t\r\n]/g, " ")).join("\t"))
      .join("\n") + "\n"
  );
}
