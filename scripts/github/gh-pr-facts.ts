import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { CliErrorObject } from "../../src/lib/cli";
import { isAgentCoauthor } from "../../src/lib/contrib/agent-coauthors";
import { intake, type ChangedFile } from "../../src/lib/contrib/intake";
import { computeTier, type HistorySummary } from "../../src/lib/contrib/tiers";
import { parsePrBlock } from "../../src/lib/contrib/pr-block";
import { compileLeakPatterns, excuses, globToRegex, type AllowedHit, type LeakPattern } from "../../src/lib/leak-scan";
import { truncateDiff } from "../../src/lib/triage/artefact";
import { TriageArtefactMetadataSchema } from "../../src/types/triage";
import { GitHub, entry, prNumbers } from "./api";
import { lineDiff } from "./line-diff";

export type Pull = {
  number: number;
  body: string | null;
  state: string;
  draft: boolean;
  created_at: string;
  updated_at: string;
  user: { login: string };
  labels: { name: string }[];
  head: { sha: string; ref?: string; repo?: { full_name: string } | null };
  base: { sha: string; repo?: { full_name: string } | null };
  changed_files: number;
  additions: number;
  deletions: number;
  merged_at?: string | null;
  closed_at?: string | null;
};
const media =
  /\.(?:png|jpe?g|gif|webp|avif|heic|ico|tiff?|bmp|mp4|mov|mkv|webm|avi|m4v|mp3|wav|aac|flac|ogg|m4a|aiff?|woff2?|ttf|otf|glb|gltf|blend|fbx|obj|hdr|exr|pdf|zip)$/i;
export type ApiFile = {
  filename: string;
  previous_filename?: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string;
};
export type Signature = {
  login: string;
  name: string;
  claCommit: string;
  claBlob?: string;
  commentId: number;
  signedAt: string;
};
/** The repository owner is the Licensor and grants the CLA rather than signing it. */
export const claExempt = (api: GitHub, login: string) => login.toLowerCase() === api.repo.split("/")[0]!.toLowerCase();
const PULLS_ROUTE = "/pulls?state=all&sort=created&direction=desc";
/** Every PR in the repository; fetch once per run and pass to getFacts for each PR. */
export const allPulls = (api: GitHub) => api.pages<Pull>(PULLS_ROUTE);
export type History = (prs: Pull[], overrides: unknown, author: string, now: Date) => HistorySummary;
export async function plannedHistory(
  prs: Pull[],
  overrides: unknown,
  author: string,
  now: Date,
): Promise<HistorySummary> {
  const modulePath = "../../src/lib/contrib/history.ts";
  const module = (await import(modulePath)) as {
    historySummary?: (prs: Pull[], now: Date, overrides: unknown, author: string) => HistorySummary;
  };
  if (!module.historySummary)
    throw new Error(
      "Pending contrib-tools integration: history.ts must export historySummary(prs, now, overrides, author)",
    );
  return module.historySummary(prs, now, overrides, author);
}
export async function signatures(api: GitHub): Promise<{ signatures: Signature[]; sha?: string }> {
  const file = await api.content("signatures.json", "cla-signatures");
  if (!file) return { signatures: [] };
  const data = JSON.parse(file.text) as { signatures?: Signature[] };
  if (
    !Array.isArray(data.signatures) ||
    data.signatures.some((item) => typeof item.login !== "string" || !/^[a-f\d]{40}$/i.test(item.claCommit))
  )
    throw new Error("Invalid CLA signatures registry");
  return { signatures: data.signatures, sha: file.sha };
}
export async function claAuthors(api: GitHub, pr: Pull): Promise<{ authors: string[]; unresolved: string[] }> {
  const commits = await api.pages<{
    author: { login: string } | null;
    commit: { author: { email: string }; message: string };
  }>(`/pulls/${pr.number}/commits`);
  const authors = new Set([pr.user.login.toLowerCase()]);
  const emails = new Map<string, string>();
  const unresolved: string[] = [];
  for (const commit of commits) {
    if (commit.author) {
      authors.add(commit.author.login.toLowerCase());
      emails.set(commit.commit.author.email.toLowerCase(), commit.author.login.toLowerCase());
    } else unresolved.push(commit.commit.author.email);
  }
  for (const commit of commits)
    for (const match of commit.commit.message.matchAll(/^Co-authored-by:\s*.+?\s*<([^>]+)>\s*$/gim)) {
      const email = match[1]!.toLowerCase();
      // Listed agents (contrib/agent-coauthors.json) cannot sign; checked before the noreply fallback so an agent login is never a missing signatory.
      if (isAgentCoauthor(email)) continue;
      const login = emails.get(email) ?? /^(?:\d+\+)?([\w-]+)@users\.noreply\.github\.com$/.exec(email)?.[1];
      if (login) authors.add(login);
      else unresolved.push(email);
    }
  return { authors: [...authors], unresolved: [...new Set(unresolved)] };
}
export function leakHit(files: ApiFile[]): boolean {
  const config = JSON.parse(readFileSync("public-export.json", "utf8")) as {
    leakPatterns: LeakPattern[];
    allowedHits: AllowedHit[];
  };
  const patterns = compileLeakPatterns(config.leakPatterns);
  return files.some((file) => {
    if (file.status === "removed") return false;
    const texts = [file.filename, ...(file.patch ?? "").split("\n").filter((line) => line.startsWith("+"))];
    return texts.some((text) =>
      patterns.some(
        (pattern) =>
          pattern.regex.test(text) &&
          !config.allowedHits.some(
            (rule) =>
              rule.pattern === pattern.name &&
              globToRegex(rule.glob).test(file.filename) &&
              excuses(rule, pattern, text),
          ),
      ),
    );
  });
}
/**
 * The patch of a text file GitHub lists without one (it omits patches of large files such as uv.lock): rebuilt from the
 * merge base and head contents, which is what a PR's file diff compares. Accepted only when the minimal diff's counts
 * equal GitHub's additions and deletions; otherwise, or on any read failure, undefined and the file stays uncertain.
 */
async function reconstructedPatch(api: GitHub, pr: Pull, file: ApiFile, head: string): Promise<string | undefined> {
  try {
    let before = "";
    if (file.status !== "added") {
      const { merge_base_commit } = await api.call<{ merge_base_commit?: { sha?: string } }>(
        `/compare/${pr.base.sha}...${pr.head.sha}?per_page=1`,
      );
      const mergeBase = merge_base_commit?.sha;
      if (!mergeBase || !/^[0-9a-f]{40}$/.test(mergeBase)) return undefined;
      const base = await api.content(file.previous_filename ?? file.filename, mergeBase);
      if (!base || base.text.includes("\0")) return undefined;
      before = base.text;
    }
    const diff = lineDiff(before, head);
    return diff && diff.additions === file.additions && diff.deletions === file.deletions ? diff.patch : undefined;
  } catch {
    return undefined;
  }
}
export async function getFacts(
  api: GitHub,
  number: number,
  history: History | typeof plannedHistory = plannedHistory,
  now = new Date(),
  pulls?: Pull[],
) {
  const pr = await api.call<Pull>(`/pulls/${number}`);
  const rawFiles = await api.pages<ApiFile>(`/pulls/${number}/files`);
  if (rawFiles.length !== pr.changed_files || rawFiles.length >= 3000)
    throw new Error("Incomplete PR files; human review required");
  const changedFiles: ChangedFile[] = [];
  const uncertainFiles: string[] = [];
  for (const file of rawFiles) {
    const status = (
      { added: "A", removed: "D", renamed: "R", modified: "M", copied: "A", changed: "M", unchanged: "M" } as Record<
        string,
        string
      >
    )[file.status];
    if (!status) throw new Error(`Unknown file status: ${file.status}`);
    const changed: ChangedFile = {
      path: file.filename,
      additions: file.additions,
      deletions: file.deletions,
      status,
      binary: status !== "D" && media.test(file.filename),
      ...(file.patch !== undefined ? { patch: file.patch } : {}),
      ...(file.previous_filename ? { previousPath: file.previous_filename } : {}),
    };
    if (
      file.filename === "package.json" ||
      file.filename === "README.md" ||
      /^\.changes\/[^/]+\.md$/.test(file.filename)
    ) {
      if (status !== "D") changed.content = (await api.content(file.filename, pr.head.sha))?.text;
      if (["package.json", "README.md"].includes(file.filename) && status !== "A")
        changed.previousContent = (await api.content(file.previous_filename ?? file.filename, pr.base.sha))?.text;
    }
    if (status !== "D" && !changed.binary && file.patch === undefined) {
      try {
        const value = await api.content(file.filename, pr.head.sha);
        if (!value) uncertainFiles.push(file.filename);
        else {
          changed.binary = value.text.includes("\0");
          if (!changed.binary && (file.additions || file.deletions)) {
            const patch = await reconstructedPatch(api, pr, file, value.text);
            if (patch === undefined) uncertainFiles.push(file.filename);
            else file.patch = changed.patch = patch;
          }
        }
      } catch (error) {
        if (error instanceof Error && error.message === "Unsupported GitHub content encoding")
          uncertainFiles.push(file.filename);
        else throw error;
      }
    }
    if (file.patch !== undefined && !changed.binary) {
      const lines = file.patch.split("\n");
      if (
        lines.filter((line) => line.startsWith("+")).length !== file.additions ||
        lines.filter((line) => line.startsWith("-")).length !== file.deletions
      )
        uncertainFiles.push(file.filename);
    }
    changedFiles.push(changed);
  }
  const releaseConfig =
    pr.head.ref && pr.head.repo?.full_name && pr.head.repo.full_name === pr.base.repo?.full_name
      ? await api.content("contrib/release.json", pr.base.sha)
      : undefined;
  const release = {
    authorLogin: pr.user.login,
    headBranch: pr.head.ref ?? "",
    headRepo: pr.head.repo?.full_name ?? "",
    baseRepo: pr.base.repo?.full_name ?? "",
    config: releaseConfig ? (JSON.parse(releaseConfig.text) as unknown) : {},
  };
  const authorPulls = (pulls ?? (await allPulls(api))).filter(
    (item) => item.user.login.toLowerCase() === pr.user.login.toLowerCase(),
  );
  const trustFile = await api.content(".github/trust.json", pr.base.sha);
  const authorTier = computeTier(
    await history(
      authorPulls,
      trustFile ? JSON.parse(trustFile.text) : { version: 1, overrides: [] },
      pr.user.login,
      now,
    ),
  );
  const registry = await signatures(api);
  const contributors = await claAuthors(api, pr);
  const cla =
    !contributors.unresolved.length &&
    contributors.authors.every(
      (login) =>
        claExempt(api, login) || registry.signatures.some((signature) => signature.login.toLowerCase() === login),
    );
  let ownerMatches = false;
  try {
    ownerMatches =
      parsePrBlock(pr.body ?? "")
        .owner.replace(/^@/, "")
        .toLowerCase() === pr.user.login.toLowerCase();
  } catch {
    /* Intake reports the malformed block. */
  }
  const labels = pr.labels.map((label) => label.name);
  return {
    pr,
    release,
    changedFiles,
    rawFiles,
    uncertainFiles,
    authorTier,
    cla: cla && ownerMatches,
    contributors,
    labels,
    openPrCount: authorPulls.filter((item) => item.state === "open").length,
    newestPr: authorPulls.find((item) => item.state === "open")?.number === pr.number,
    leakHit: leakHit(rawFiles),
  };
}
export type Facts = Awaited<ReturnType<typeof getFacts>>;
export function evaluate(facts: Facts) {
  return intake({
    prBody: facts.pr.body ?? "",
    changedFiles: facts.changedFiles,
    authorTier: facts.authorTier,
    cla: facts.cla,
    openPrCount: facts.openPrCount,
    labels: facts.labels,
    release: facts.release,
  });
}
export function writeArtefact(facts: Facts, out: string) {
  mkdirSync(out, { recursive: true });
  const patch = facts.rawFiles
    .map(
      (file) =>
        `diff --git ${JSON.stringify(`a/${file.filename}`)} ${JSON.stringify(`b/${file.filename}`)}\n${file.patch ?? "(binary or omitted patch)"}`,
    )
    .join("\n");
  const diff = truncateDiff(patch, 61440);
  const metadata = TriageArtefactMetadataSchema.parse({
    pr: facts.pr.number,
    head: facts.pr.head.sha,
    files: facts.changedFiles.map((file) => ({
      path: file.path,
      additions: file.additions,
      deletions: file.deletions,
    })),
    diff: {
      truncated: diff.truncated || facts.uncertainFiles.length > 0,
      originalBytes: Buffer.byteLength(patch),
      includedBytes: Buffer.byteLength(diff.text),
    },
  });
  if (Buffer.byteLength(JSON.stringify(metadata.files)) > 1024 * 1024)
    throw new Error("Complete file summary exceeds 1 MiB; human review required");
  const data = {
    "metadata.json": JSON.stringify(metadata),
    "body.md": facts.pr.body ?? "",
    "change.md": facts.changedFiles
      .filter((file) => file.path.startsWith(".changes/"))
      .map((file) => file.content ?? "")
      .join("\n"),
    "diff.patch": diff.text,
  };
  for (const [file, text] of Object.entries(data)) writeFileSync(path.join(out, file), text);
}
entry(import.meta.url, async (api, args) => {
  const facts = [];
  for (const number of await prNumbers(api, args)) {
    const value = await getFacts(api, number);
    if (args.out) writeArtefact(value, args.out);
    const result = evaluate(value);
    facts.push({ ...value, intake: result });
    // A Dependabot lockfile diff may exceed GitHub's patch limit; that route always waits for human review.
    if (
      args.check &&
      ((value.uncertainFiles.length && !result.facts.dependabotRoute) ||
        value.leakHit ||
        result.findings.some((finding) => finding.severity === "block"))
    )
      throw new CliErrorObject({
        code: "VALIDATION",
        message: "Intake blocked",
        details: {
          pr: number,
          findings: result.findings,
          leakHit: value.leakHit,
          uncertainFiles: value.uncertainFiles,
        },
      });
  }
  return { facts };
});
