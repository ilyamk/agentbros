/**
 * Build a clean public tree from this working copy: allowed files only, leak-scanned, optionally one git commit.
 * Never touches the source repository's git and never pushes.
 */
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { CliErrorObject, emitProgress, parseArgs, runScript } from "../src/lib/cli";
import {
  compileLeakPatterns,
  excuses,
  globToRegex,
  isBinary,
  loadLeakPatterns,
  memoryContent,
  PUBLIC_AUTHOR as AUTHOR,
  PUBLIC_EMAIL as EMAIL,
  type AllowedHit,
  type LeakPattern,
} from "../src/lib/leak-scan";

const SPECS = [
  { name: "output", description: "Directory for the public tree (must not exist or be empty)" },
  { name: "config", default: "public-export.json", description: "Denylist and allowed leak hits" },
  { name: "dry-run", type: "boolean", description: "Compute the file set and scan the sources without writing" },
  { name: "git", type: "boolean", description: "git init and one commit inside the output directory" },
  { name: "allow-leaks", type: "boolean", description: "Exit zero even when the leak scan finds hits" },
] as const;

type Rule = { glob: string; except?: string[]; reason: string };
type ContentRule = { within: string; pattern: string; reason: string };
type Config = { deny: Rule[]; denyByContent: ContentRule[]; leakPatterns: LeakPattern[]; allowedHits: AllowedHit[] };
type Hit = { file: string; line: number; pattern: string; text: string };

const CODE = /\.(ts|tsx|js|cjs|mjs|jsx)$/;

function git(root: string, args: string[]): string {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  if (result.status !== 0)
    throw new CliErrorObject({ code: "INTERNAL", message: `git ${args.join(" ")} failed: ${result.stderr}` });
  return result.stdout;
}

function resolveImport(from: string, spec: string, files: Set<string>): string | undefined {
  if (!spec.startsWith(".")) return undefined;
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(from), spec));
  const stem = base.replace(/\.(js|jsx|mjs|cjs)$/, "");
  const candidates = [
    base,
    `${stem}.ts`,
    `${stem}.tsx`,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    `${base}.json`,
    `${base}/index.ts`,
    `${base}/index.tsx`,
  ];
  return candidates.find((candidate) => files.has(candidate));
}

const IMPORT = /(?:from\s*|import\s*\(\s*|require\s*\(\s*|import\s+)["'`](\.{1,2}\/[^"'`]+)["'`]/g;

void runScript(async () => {
  const args = parseArgs(SPECS);
  const root = realpathSync(git(process.cwd(), ["rev-parse", "--show-toplevel"]).trim());
  const config = JSON.parse(readFileSync(path.resolve(root, args.config!), "utf8")) as Config;
  if (!args["dry-run"] && !args.output)
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "--output is required unless --dry-run" });

  let output: string | undefined;
  if (args.output) {
    output = path.resolve(args.output);
    let ancestor = output;
    const missing: string[] = [];
    for (;;) {
      try {
        lstatSync(ancestor);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        missing.unshift(path.basename(ancestor));
        ancestor = path.dirname(ancestor);
      }
    }
    const real = path.join(realpathSync(ancestor), ...missing);
    if (real === root || real.startsWith(root + path.sep) || output.startsWith(root + path.sep))
      throw new CliErrorObject({ code: "INVALID_INPUT", message: "--output must be outside the source repository" });
    if (!args["dry-run"] && existsSync(output) && readdirSync(output).length > 0)
      throw new CliErrorObject({ code: "FILE_EXISTS", message: `${output} is not empty` });
  }

  const tracked = new Set(git(root, ["ls-files", "--cached", "-z"]).split("\0").filter(Boolean));
  const listed = git(root, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"])
    .split("\0")
    .filter(Boolean);
  const kind = (file: string) => {
    let parent = path.dirname(path.join(root, file));
    while (parent !== root) {
      if (existsSync(parent) && lstatSync(parent).isSymbolicLink())
        throw new CliErrorObject({ code: "VALIDATION", message: `Source path has a symlink ancestor: ${file}` });
      parent = path.dirname(parent);
    }
    try {
      const stat = lstatSync(path.join(root, file));
      return stat.isFile() ? "file" : stat.isSymbolicLink() ? "link" : "other";
    } catch {
      return "other";
    }
  };
  const candidates = [...new Set(listed)].sort();
  const files = candidates.filter((file) => kind(file) === "file");
  const links = candidates.filter((file) => kind(file) === "link");
  const fileSet = new Set(files);
  const untracked = files.filter((file) => !tracked.has(file));

  const denied = new Map<string, string>();
  const rules = config.deny.map((rule) => ({
    ...rule,
    regex: globToRegex(rule.glob),
    except: (rule.except ?? []).map(globToRegex),
  }));
  const unusedRules = new Set(config.deny.map((rule) => rule.glob));
  for (const file of files) {
    const rule = rules.find((item) => item.regex.test(file) && !item.except.some((regex) => regex.test(file)));
    if (rule) {
      denied.set(file, rule.reason);
      unusedRules.delete(rule.glob);
    }
  }
  const contentRules = config.denyByContent.map((rule) => ({
    ...rule,
    within: globToRegex(rule.within),
    regex: new RegExp(rule.pattern),
  }));
  const text = new Map<string, string | null>();
  const snapshots = new Map<string, { bytes: Buffer; mode: number }>();
  const read = (file: string) => {
    if (!text.has(file)) {
      const bytes = readFileSync(path.join(root, file));
      snapshots.set(file, { bytes, mode: lstatSync(path.join(root, file)).mode & 0o777 });
      text.set(file, isBinary(bytes) ? null : bytes.toString("utf8"));
    }
    return text.get(file)!;
  };
  for (const file of files) {
    if (denied.has(file)) continue;
    const rule = contentRules.find(
      (item) => item.within.test(file) && read(file) !== null && item.regex.test(read(file)!),
    );
    if (rule) denied.set(file, rule.reason);
  }

  // Closure: a test importing or naming a denied file is denied too; anything else importing one is reported.
  const brokenImports: { file: string; imports: string }[] = [];
  for (let changed = true; changed;) {
    changed = false;
    for (const file of files) {
      if (denied.has(file)) continue;
      const source = read(file);
      if (source === null) continue;
      if (file.startsWith("tests/")) {
        const target = [...denied.keys()].find((item) => item.includes("/") && source.includes(item));
        if (target) {
          denied.set(file, `reads denied ${target}`);
          changed = true;
          continue;
        }
      }
      if (!CODE.test(file)) continue;
      for (const match of source.matchAll(IMPORT)) {
        const target = resolveImport(file, match[1]!, fileSet);
        if (!target || !denied.has(target)) continue;
        if (file.startsWith("tests/")) {
          denied.set(file, `imports denied ${target}`);
          changed = true;
          break;
        }
        if (!brokenImports.some((item) => item.file === file && item.imports === target))
          brokenImports.push({ file, imports: target });
      }
    }
  }

  const allowed = files.filter((file) => !denied.has(file));

  // Symlinks (`.claude/skills` → `.agents/skills`) are kept, recreated with a relative target, when the link's own path
  // is allowed and its target resolves inside the tree to an allowed file or to a directory that is not denied itself and
  // still holds allowed files. A tracked link lost for any other reason fails the export.
  const keptLinks: { path: string; target: string }[] = [];
  const droppedLinks: { path: string; target: string; reason: string; tracked: boolean }[] = [];
  const denyRuleFor = (file: string) =>
    rules.find((item) => item.regex.test(file) && !item.except.some((regex) => regex.test(file)));
  for (const link of links) {
    const target = readlinkSync(path.join(root, link));
    const own = denyRuleFor(link);
    if (own) {
      denied.set(link, own.reason);
      unusedRules.delete(own.glob);
      continue;
    }
    const drop = (reason: string) => droppedLinks.push({ path: link, target, reason, tracked: tracked.has(link) });
    // An absolute target is compared through its real path, as `root` is (macOS /var is /private/var).
    const absolute = path.isAbsolute(target)
      ? existsSync(target)
        ? realpathSync(target)
        : path.resolve(target)
      : path.resolve(root, path.dirname(link), target);
    const resolved = path.relative(root, absolute).split(path.sep).join("/");
    if (!resolved || resolved === ".." || resolved.startsWith("../") || path.isAbsolute(resolved)) {
      drop("target resolves outside the tree");
      continue;
    }
    if (fileSet.has(resolved)) {
      if (denied.has(resolved)) {
        drop(`target is denied: ${denied.get(resolved)}`);
        continue;
      }
    } else {
      const ownTarget = denyRuleFor(`${resolved}/`) ?? denyRuleFor(resolved);
      if (ownTarget) {
        drop(`target is denied: ${ownTarget.reason}`);
        continue;
      }
      if (!allowed.some((file) => file.startsWith(`${resolved}/`))) {
        drop("target holds no allowed file (missing, ignored or wholly denied)");
        continue;
      }
    }
    const relative = path.posix.relative(path.posix.dirname(link), resolved) || ".";
    keptLinks.push({ path: link, target: relative });
  }
  const lostTracked = droppedLinks.filter((item) => item.tracked);

  const deniedPaths = [...denied.keys()];
  const references: { file: string; references: string }[] = [];
  const findable = deniedPaths.filter((file) => file.includes("/") || /\.(md|json)$/.test(file));
  for (const file of allowed) {
    const source = read(file);
    if (source === null) continue;
    for (const target of findable) if (source.includes(target)) references.push({ file, references: target });
  }

  const { leakPatterns, localPatterns } = loadLeakPatterns(root, config.leakPatterns);
  const patterns = compileLeakPatterns(leakPatterns);
  // The user's memory is git-ignored and denied, so it should never be a candidate; its content appearing anywhere is a leak.
  const memoryNeedles = memoryContent(
    [
      path.join(root, "memory"),
      ...(process.env.AGENTBROS_MEMORY_ROOT ? [path.resolve(process.env.AGENTBROS_MEMORY_ROOT)] : []),
    ],
    ["upstream"],
  );
  patterns.push(
    ...memoryNeedles.map(({ id, needle }) => ({
      name: `memory-entry ${id}`,
      regex: { test: (text: string) => text.includes(needle) },
    })),
  );
  const allowedHits = config.allowedHits.map((item) => ({ ...item, regex: globToRegex(item.glob) }));
  const hits: Hit[] = [];
  const explained: (Hit & { reason: string })[] = [];
  const record = (hit: Hit, pattern: (typeof patterns)[number], text: string) => {
    const allow = allowedHits.find(
      (item) => item.pattern === hit.pattern && item.regex.test(hit.file) && excuses(item, pattern, text),
    );
    if (allow) explained.push({ ...hit, reason: allow.reason });
    else hits.push(hit);
  };
  for (const file of allowed) {
    for (const pattern of patterns)
      if (pattern.regex.test(file)) record({ file, line: 0, pattern: pattern.name, text: "(path)" }, pattern, file);
    const source = read(file);
    if (source === null) continue;
    source.split("\n").forEach((line, index) => {
      for (const pattern of patterns) {
        if (pattern.regex.test(line))
          record({ file, line: index + 1, pattern: pattern.name, text: line.trim().slice(0, 160) }, pattern, line);
      }
    });
  }
  for (const link of keptLinks) {
    for (const pattern of patterns) {
      if (pattern.regex.test(link.path))
        record({ file: link.path, line: 0, pattern: pattern.name, text: "(path)" }, pattern, link.path);
      if (pattern.regex.test(link.target))
        record(
          { file: link.path, line: 0, pattern: pattern.name, text: `(symlink target) ${link.target}` },
          pattern,
          link.target,
        );
    }
  }

  // Markdown links to denied files are unlinked in the copy; list items that only carried such a link are dropped.
  const rewritten = new Map<string, string>();
  const linkEdits = { files: 0, unlinked: 0, droppedLines: 0 };
  const deniedTarget = (file: string, href: string) => {
    const clean = decodeURI(href.split("#")[0]!.split("?")[0]!.trim());
    if (!clean || /^[a-z]+:/i.test(clean)) return false;
    const resolved = clean.startsWith("/")
      ? clean.slice(1)
      : path.posix.normalize(path.posix.join(path.posix.dirname(file), clean));
    return (
      denied.has(resolved) || [...denied.keys()].some((item) => item.startsWith(`${resolved.replace(/\/$/, "")}/`))
    );
  };
  const LINK = /(!?)\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  for (const file of allowed) {
    if (!/\.(md|mdx)$/i.test(file)) continue;
    const source = read(file);
    if (source === null) continue;
    let unlinked = 0,
      dropped = 0;
    const lines = source.split("\n").flatMap((line) => {
      let hit = false;
      const next = line.replace(LINK, (whole, image: string, label: string, href: string) => {
        if (!deniedTarget(file, href)) return whole;
        hit = true;
        unlinked++;
        return image ? "" : label;
      });
      if (
        hit &&
        /^\s*(?:[-*+]|\d+\.)\s/.test(line) &&
        line
          .replace(LINK, "")
          .replace(/^\s*(?:[-*+]|\d+\.)\s*/, "")
          .replace(/[\s:—–.,;()-]/g, "") === ""
      ) {
        dropped++;
        return [];
      }
      return [next];
    });
    if (unlinked > 0) {
      rewritten.set(file, lines.join("\n"));
      linkEdits.files++;
      linkEdits.unlinked += unlinked;
      linkEdits.droppedLines += dropped;
    }
  }

  // A tree that would silently lose a tracked symlink is never written.
  if (output && !args["dry-run"] && lostTracked.length === 0 && (hits.length === 0 || args["allow-leaks"])) {
    emitProgress(`Copying ${allowed.length} files to ${output}`);
    for (const file of allowed) {
      const target = path.join(output, file);
      mkdirSync(path.dirname(target), { recursive: true });
      const snapshot = snapshots.get(file)!;
      writeFileSync(target, rewritten.get(file) ?? snapshot.bytes, { mode: snapshot.mode });
    }
    for (const link of keptLinks) {
      const target = path.join(output, link.path);
      mkdirSync(path.dirname(target), { recursive: true });
      symlinkSync(link.target, target);
    }
  }

  let commit: string | undefined;
  if (
    args.git &&
    output &&
    !args["dry-run"] &&
    lostTracked.length === 0 &&
    (hits.length === 0 || args["allow-leaks"])
  ) {
    const env = {
      ...process.env,
      GIT_AUTHOR_NAME: AUTHOR,
      GIT_AUTHOR_EMAIL: EMAIL,
      GIT_COMMITTER_NAME: AUTHOR,
      GIT_COMMITTER_EMAIL: EMAIL,
    };
    const run = (gitArgs: string[]) => {
      const result = spawnSync(
        "git",
        ["-C", output!, "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...gitArgs],
        { encoding: "utf8", env, maxBuffer: 64 * 1024 * 1024 },
      );
      if (result.status !== 0)
        throw new CliErrorObject({ code: "INTERNAL", message: `git ${gitArgs[0]} in output failed: ${result.stderr}` });
      return result.stdout;
    };
    run(["init", "-q", "-b", "main"]);
    run(["add", "--force", "-A"]);
    run(["commit", "-q", "-m", "Initial public release"]);
    commit = run(["rev-parse", "HEAD"]).trim();
  }

  const byReason: Record<string, number> = {};
  for (const reason of denied.values()) byReason[reason] = (byReason[reason] ?? 0) + 1;
  const metadata = {
    dryRun: Boolean(args["dry-run"]),
    localPatterns,
    output: output ?? null,
    candidates: files.length + links.length,
    untrackedIncluded: untracked.filter((file) => !denied.has(file)).length,
    allowed: allowed.length,
    denied: denied.size,
    deniedByReason: byReason,
    deniedFiles: Object.fromEntries(denied),
    unusedDenyRules: [...unusedRules],
    brokenImports,
    symlinks: { kept: keptLinks, dropped: droppedLinks },
    references,
    linkEdits: { ...linkEdits, changed: [...rewritten.keys()] },
    leaks: { hits: hits.length, explained: explained.length, files: [...new Set(hits.map((hit) => hit.file))].length },
    hits,
    explainedHits: explained,
    commit: commit ?? null,
  };
  if (lostTracked.length > 0) {
    throw new CliErrorObject({
      code: "VALIDATION",
      message: `${lostTracked.length} tracked symlink(s) would be lost: ${lostTracked.map((item) => `${item.path} (${item.reason})`).join("; ")}`,
      details: metadata,
    });
  }
  if (hits.length > 0 && !args["allow-leaks"]) {
    throw new CliErrorObject({
      code: "VALIDATION",
      message: `Leak scan found ${hits.length} hits in ${metadata.leaks.files} files`,
      details: metadata,
    });
  }
  return { outputs: output && !args["dry-run"] ? [output] : [], metadata };
});
