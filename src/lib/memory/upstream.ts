/**
 * Upstream export of an applied improvement: its commits as `git format-patch` files plus a generalised PR.md, leak-scanned
 * against the export patterns and the user's memory. Local only: it never pushes, opens a pull request or touches the network.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { MEMORY_DIRS, type MemoryProposal } from "../../types/memory";
import { CliErrorObject } from "../cli";
import {
  compileLeakPatterns,
  excuses,
  findShingles,
  globToRegex,
  loadLeakPatterns,
  memoryShingleIndex,
  PUBLIC_AUTHOR,
  PUBLIC_EMAIL,
  type AllowedHit,
  type LeakPattern,
  type LeakTester,
  type ShingleIndex,
} from "../leak-scan";
import { getMemory, loadMemory, memoryDir } from "./index";

export type GitResult = { status: number | null; stdout: string; stderr: string };
/** Runs git with a literal argument array; injectable so tests can record every call. */
export type GitRunner = (args: readonly string[], cwd: string) => GitResult;

export const runGit: GitRunner = (args, cwd) => {
  const result = spawnSync("git", [...args], { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? (result.error ? String(result.error) : "") };
};

/** Paths no upstream commit may touch: personal, generated or secret. */
export const FORBIDDEN_PREFIXES = ["memory/", "public/projects/", "src/projects/", "out/", ".cache/"] as const;
/** Tracked harness files under a forbidden prefix (mirrors public-export.json's memory exception). */
export const ALLOWED_PATHS = new Set(["memory/AGENTS.md"]);
/** Public addresses that may appear in a patch: the neutral author and the co-author trailer. */
export const PUBLIC_ADDRESSES = new Set([PUBLIC_EMAIL, "noreply@anthropic.com"]);

/** A public-export.json deny rule: paths that never leave this checkout. */
export type DenyRule = { glob: string; except?: string[]; reason: string };
export type UpstreamHit = { file: string; line: number; pattern: string; text: string };
export type UpstreamFile = { name: string; content: string };
export type UpstreamResult = { outDir: string; files: UpstreamFile[]; commits: { sha: string; subject: string }[]; hits: UpstreamHit[]; written: boolean };

const CHANGE_TEXT: Record<MemoryProposal["change"], { title: string; what: string }> = {
  sensor: { title: "Add or tighten a sensor", what: "Adds or tightens a sensor so that the problem is measured before a film is delivered." },
  rule: { title: "Change an agent rule", what: "Changes an agent rule so that the problem is avoided earlier in the work." },
  playbook: { title: "Adjust a playbook", what: "Adjusts a playbook's method so that the kind of video it covers avoids the problem." },
  tool: { title: "Improve a tool", what: "Changes a command or tool so that the workaround it needed is no longer necessary." },
  chain: { title: "Change a film chain step", what: "Changes a step of the bespoke film chain so that the problem is caught where it starts." },
  critic: { title: "Sharpen the critic", what: "Changes what the critic checks so that the problem is named in review." },
  retire: { title: "Retire a change that did not help", what: "Removes a rule or sensor whose problem kept recurring after it was applied." },
};

export function forbiddenReason(file: string): string | undefined {
  if (ALLOWED_PATHS.has(file)) return undefined;
  const prefix = FORBIDDEN_PREFIXES.find((item) => file.startsWith(item));
  if (prefix) return `touches ${prefix}`;
  if (path.posix.basename(file).startsWith(".env")) return "touches an environment file";
  return undefined;
}

function git(run: GitRunner, cwd: string, args: string[]): string {
  const result = run(args, cwd);
  if (result.status !== 0) throw new CliErrorObject({ code: "INTERNAL", message: `git ${args[0]} failed: ${result.stderr.trim()}` });
  return result.stdout;
}

/** The nearest existing ancestor's real path, joined with the rest: macOS tmp paths resolve through /private. */
function realish(target: string): string {
  let head = path.resolve(target);
  const rest: string[] = [];
  while (!existsSync(head)) {
    rest.unshift(path.basename(head));
    const parent = path.dirname(head);
    if (parent === head) break;
    head = parent;
  }
  return path.join(realpathSync(head), ...rest);
}

const inside = (parent: string, child: string) => child === parent || child.startsWith(parent + path.sep);

function resolveOut(repo: string, id: string, out: string | undefined, run: GitRunner): string {
  if (!out) return path.join(memoryDir(repo), "upstream", id);
  const target = realish(out);
  const realRepo = realpathSync(repo);
  if (inside(realRepo, target)) {
    const relative = path.relative(realRepo, target);
    if (!relative || run(["check-ignore", "-q", "--no-index", "--", relative], realRepo).status !== 0)
      throw new CliErrorObject({ code: "INVALID_INPUT", message: "--out inside the workspace must be a git-ignored folder" });
    return target;
  }
  const scratch = [...new Set([tmpdir(), "/tmp"].filter(existsSync).map((dir) => realpathSync(dir)))];
  if (!scratch.some((dir) => inside(dir, target))) throw new CliErrorObject({ code: "INVALID_INPUT", message: "--out must be inside the workspace or the temporary folder" });
  return target;
}

/** Validates each commit and returns its full sha and subject, in the proposal's order. */
export function checkCommits(repo: string, shas: readonly string[], run: GitRunner = runGit, deny: readonly DenyRule[] = []): { sha: string; subject: string }[] {
  const rules = deny.map((rule) => ({ reason: rule.reason, regex: globToRegex(rule.glob), except: (rule.except ?? []).map(globToRegex) }));
  const denied = (file: string) => rules.find((rule) => rule.regex.test(file) && !rule.except.some((regex) => regex.test(file)))?.reason;
  const problems: string[] = [];
  const commits: { sha: string; subject: string }[] = [];
  for (const short of shas) {
    const resolved = run(["rev-parse", "--verify", "--quiet", `${short}^{commit}`], repo);
    if (resolved.status !== 0) { problems.push(`${short}: no such commit`); continue; }
    const sha = resolved.stdout.trim();
    const parents = git(run, repo, ["rev-list", "--parents", "-n", "1", sha]).trim().split(/\s+/).length - 1;
    if (parents > 1) { problems.push(`${short}: a merge commit`); continue; }
    const files = git(run, repo, ["diff-tree", "--root", "--no-commit-id", "--no-renames", "-r", "--name-only", "-z", sha]).split("\0").filter(Boolean);
    for (const file of files) {
      const reason = forbiddenReason(file)
        ?? (run(["check-ignore", "-q", "--no-index", "--", file], repo).status === 0 ? "touches a git-ignored path" : undefined)
        ?? (denied(file) ? `touches a file the public export denies: ${denied(file)}` : undefined);
      if (reason) problems.push(`${short}: ${reason} (${file})`);
    }
    commits.push({ sha, subject: git(run, repo, ["log", "-1", "--format=%s", sha]).trim() });
  }
  if (problems.length > 0) throw new CliErrorObject({ code: "VALIDATION", message: `The proposal's commits cannot go upstream: ${problems.join("; ")}`, details: { problems } });
  return commits;
}

/** Header lines of a patch, each with its folded continuation lines, and the index where the body starts. */
function headerFields(lines: readonly string[]): { start: number; end: number }[] {
  const stop = lines.indexOf("");
  const limit = stop < 0 ? lines.length : stop;
  const fields: { start: number; end: number }[] = [];
  for (let i = 0; i < limit; i++) {
    let end = i;
    while (end + 1 < limit && /^[ \t]/.test(lines[end + 1]!)) end++;
    fields.push({ start: i, end });
    i = end;
  }
  return fields;
}

/** Replaces the From: header with the neutral public identity and the Date: header with the same instant in UTC (no local offset). */
export function neutraliseHeader(patch: string): string {
  const lines = patch.split("\n");
  const out: string[] = [];
  let next = 0;
  for (const { start, end } of headerFields(lines)) {
    out.push(...lines.slice(next, start));
    const field = lines.slice(start, end + 1).join(" ");
    if (field.startsWith("From: ")) out.push(`From: ${PUBLIC_AUTHOR} <${PUBLIC_EMAIL}>`);
    else if (field.startsWith("Date: ")) {
      const date = new Date(field.slice(6).trim());
      out.push(`Date: ${Number.isNaN(date.getTime()) ? "Thu, 1 Jan 1970 00:00:00 +0000" : date.toUTCString().replace("GMT", "+0000")}`);
    } else out.push(...lines.slice(start, end + 1));
    next = end + 1;
  }
  return [...out, ...lines.slice(next)].join("\n");
}

/** RFC 2047 encoded words (=?charset?Q|B?text?=) decoded; adjacent encoded words join without the space between them. */
export function decodeEncodedWords(text: string): string {
  const word = /=\?([^?]+)\?([QqBb])\?([^?]*)\?=/g;
  return text.replace(/(=\?[^?]+\?[QqBb]\?[^?]*\?=)\s+(?==\?)/g, "$1").replace(word, (_whole, _charset: string, encoding: string, data: string) => {
    if (encoding.toUpperCase() === "B") return Buffer.from(data, "base64").toString("utf8");
    const bytes: number[] = [];
    for (let i = 0; i < data.length; i++) {
      const c = data[i]!;
      if (c === "_") bytes.push(0x20);
      else if (c === "=" && /^[0-9A-Fa-f]{2}$/.test(data.slice(i + 1, i + 3))) { bytes.push(parseInt(data.slice(i + 1, i + 3), 16)); i += 2; }
      else bytes.push(c.charCodeAt(0));
    }
    return Buffer.from(bytes).toString("utf8");
  });
}

/** What the scanner reads: header fields unfolded onto their first line and decoded, continuation lines blanked, so line numbers stay those of the file. */
export function scanView(patch: string): string {
  const lines = patch.split("\n");
  for (const { start, end } of headerFields(lines)) {
    lines[start] = decodeEncodedWords(lines.slice(start, end + 1).map((line, index) => (index ? line.trim() : line)).join(" "));
    for (let i = start + 1; i <= end; i++) lines[i] = "";
  }
  return lines.join("\n");
}

const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export type UpstreamScanner = { testers: LeakTester[]; shingles: ShingleIndex };

/** Line testers (config patterns with public addresses excepted, project ids as whole tokens, private emails) and the memory shingles (every entry's words, proposal quotes and verdicts included). */
export function upstreamScanner(repo: string, leakPatterns: readonly LeakPattern[], emails: readonly string[]): UpstreamScanner {
  const testers = compileLeakPatterns(leakPatterns).map(({ name, regex }) => {
    if (!(regex instanceof RegExp)) return { name, regex };
    const global = new RegExp(regex.source, regex.flags.includes("g") ? regex.flags : `${regex.flags}g`);
    return { name, regex: { test: (text: string) => [...text.matchAll(global)].some((match) => !PUBLIC_ADDRESSES.has(match[0].toLowerCase())) } };
  });
  const dir = memoryDir(repo);
  // Entry folders only: an earlier PR.md under memory/upstream is output, not an entry.
  const shingles = memoryShingleIndex(Object.values(MEMORY_DIRS).map((folder) => path.join(dir, folder)));
  const { entries } = loadMemory(repo);
  const projects = [...new Set(entries.map((entry) => entry.scope.project).filter((value): value is string => Boolean(value)))];
  for (const project of projects) {
    const token = new RegExp(`(?<![A-Za-z0-9-])${escapeRegex(project)}(?![A-Za-z0-9-])`, "i");
    testers.push({ name: "memory-project", regex: token });
  }
  for (const email of new Set(emails.map((item) => item.trim().toLowerCase()).filter((item) => item.includes("@") && !PUBLIC_ADDRESSES.has(item)))) {
    testers.push({ name: "author-email", regex: { test: (text: string) => text.toLowerCase().includes(email) } });
  }
  return { testers, shingles };
}

/** Hits in one file (a patch read through scanView); lines of a diff section take that path's allowed hits from the export config. */
export function scanFile(file: UpstreamFile, { testers, shingles }: UpstreamScanner, allowed: readonly AllowedHit[] = []): UpstreamHit[] {
  const allow = allowed.map((item) => ({ ...item, regex: globToRegex(item.glob) }));
  const hits: UpstreamHit[] = [];
  for (const tester of testers) if (tester.regex.test(file.name)) hits.push({ file: file.name, line: 0, pattern: tester.name, text: "(name)" });
  const content = file.name.endsWith(".patch") ? scanView(file.content) : file.content;
  const lines = content.split("\n");
  let current: string | undefined;
  lines.forEach((line, index) => {
    const diff = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
    if (diff) current = diff[2];
    for (const tester of testers) {
      if (!tester.regex.test(line)) continue;
      if (current && allow.some((item) => item.pattern === tester.name && item.regex.test(current!) && excuses(item, tester, line))) continue;
      hits.push({ file: file.name, line: index + 1, pattern: tester.name, text: line.trim().slice(0, 160) });
    }
  });
  for (const hit of findShingles(content, shingles)) hits.push({ file: file.name, line: hit.line, pattern: `memory-entry ${hit.id}`, text: lines[hit.line - 1]!.trim().slice(0, 160) });
  return hits.sort((a, b) => a.line - b.line);
}

/** A generalised pull-request description: from the change type, targets, test and commit subjects only, never memory text or ids. */
export function pullRequestText(proposal: MemoryProposal, commits: readonly { sha: string; subject: string }[]): string {
  const text = CHANGE_TEXT[proposal.change];
  const first = proposal.targets[0]!;
  const more = proposal.targets.length > 1 ? ` and ${proposal.targets.length - 1} more` : "";
  const test = proposal.test ?? "the suites that cover the targets";
  const command = proposal.test?.endsWith(".test.ts") ? `pnpm exec tsx --test ${proposal.test}` : "pnpm check";
  return [
    `# ${text.title}: ${first}${more}`,
    "",
    "## What changes",
    "",
    text.what,
    "",
    ...proposal.targets.map((target) => `- \`${target}\``),
    "",
    "## Why",
    "",
    "The same problem recurred in local use of the harness. The change was reviewed and applied locally; this patch set offers it for the shared repository.",
    "",
    "## Test",
    "",
    `Guarded by \`${test}\`. Run \`${command}\`, then \`pnpm check\`.`,
    "",
    "## Commits",
    "",
    ...commits.map((commit) => `- ${commit.sha.slice(0, 12)} ${commit.subject}`),
    "",
    "Apply with `git am *.patch`.",
    "",
    "---",
    "",
    "Produced locally by `pnpm memory:upstream`. Nothing was pushed and no pull request was opened.",
    "",
  ].join("\n");
}

const slug = (subject: string) => subject.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 52) || "change";

export type UpstreamOptions = { repo: string; id: string; out?: string; dryRun?: boolean; git?: GitRunner };

/** Builds, scans and (unless dry-run or a leak) writes the patch set and PR.md. A leak or an invalid proposal writes nothing. */
export function upstreamProposal({ repo, id, out, dryRun = false, git: run = runGit }: UpstreamOptions): UpstreamResult {
  const entry = getMemory(id, repo);
  const proposal = entry.proposal;
  if (entry.type !== "proposal" || !proposal) throw new CliErrorObject({ code: "VALIDATION", message: `${id} is not a proposal` });
  if (proposal.state !== "applied" && proposal.state !== "verified")
    throw new CliErrorObject({ code: "VALIDATION", message: `${id} is ${proposal.state}: only an applied or verified proposal goes upstream` });
  if (proposal.commits.length === 0) throw new CliErrorObject({ code: "VALIDATION", message: `${id} names no commits` });

  const outDir = resolveOut(repo, id, out, run);
  if (existsSync(outDir) && readdirSync(outDir).length > 0) throw new CliErrorObject({ code: "FILE_EXISTS", message: `${outDir} is not empty; remove it first` });

  const configFile = path.join(repo, "public-export.json");
  const config = existsSync(configFile)
    ? (JSON.parse(readFileSync(configFile, "utf8")) as { deny?: DenyRule[]; leakPatterns?: LeakPattern[]; allowedHits?: AllowedHit[] })
    : {};
  const commits = checkCommits(repo, proposal.commits, run, config.deny ?? []);
  const files: UpstreamFile[] = commits.map((commit, index) => {
    const patch = git(run, repo, [
      "-c", "diff.noprefix=false", "-c", "diff.mnemonicPrefix=false",
      "format-patch", "-1", "--stdout", "--no-color", "--binary", "--no-signature", `--start-number=${index + 1}`, commit.sha,
    ]);
    if (/^GIT binary patch$/m.test(patch))
      throw new CliErrorObject({ code: "VALIDATION", message: `${commit.sha.slice(0, 12)} carries a binary hunk, which the leak scan cannot read; media goes through manifests, not commits` });
    return { name: `${String(index + 1).padStart(4, "0")}-${slug(commit.subject)}.patch`, content: neutraliseHeader(patch) };
  });
  files.push({ name: "PR.md", content: pullRequestText(proposal, commits) });

  const emails = [git(run, repo, ["config", "--default", "", "--get", "user.email"])];
  for (const commit of commits) emails.push(...git(run, repo, ["log", "-1", "--format=%ae%n%ce", commit.sha]).split("\n"));
  const { leakPatterns } = loadLeakPatterns(repo, config.leakPatterns ?? []);
  const scanner = upstreamScanner(repo, leakPatterns, emails);
  const hits = files.flatMap((file) => scanFile(file, scanner, config.allowedHits ?? []));
  if (hits.length > 0 || dryRun) return { outDir, files, commits, hits, written: false };

  mkdirSync(outDir, { recursive: true });
  for (const file of files) writeFileSync(path.join(outDir, file.name), file.content);
  const after = files.flatMap((file) => scanFile({ name: file.name, content: readFileSync(path.join(outDir, file.name), "utf8") }, scanner, config.allowedHits ?? []));
  if (after.length > 0) {
    for (const file of files) rmSync(path.join(outDir, file.name), { force: true });
    return { outDir, files, commits, hits: after, written: false };
  }
  return { outDir, files, commits, hits: [], written: true };
}
