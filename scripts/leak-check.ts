import { spawnSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import path from "node:path";
import { CliErrorObject, parseArgs, runScript } from "../src/lib/cli";
import {
  compileLeakPatterns,
  excuses,
  globToRegex,
  isBinary,
  loadLeakPatterns,
  type AllowedHit,
  type LeakPattern,
} from "../src/lib/leak-scan";

const SPECS = [
  {
    name: "mode",
    default: "tree",
    choices: ["tree", "diff"],
    description: "Scan the working tree or only added diff lines and paths",
  },
  { name: "base", description: "Base commit or ref (required in diff mode)" },
  { name: "head", default: "HEAD", description: "Head commit or ref in diff mode" },
  { name: "local", type: "boolean", description: "Require and merge the maintainer's local pattern file" },
  { name: "config", default: "public-export.json", description: "Generic leak patterns and allowed hits" },
  {
    name: "dry-run",
    type: "boolean",
    description: "Scan without loading environment files; this command never writes",
  },
] as const;

type Hit = { file: string; line: number; pattern: string; text: string };

function gitBytes(root: string, args: string[]): Buffer {
  const result = spawnSync("git", ["-C", root, ...args], { maxBuffer: 256 * 1024 * 1024 });
  if (result.status !== 0)
    throw new CliErrorObject({ code: "INVALID_INPUT", message: `git ${args[0]} failed: ${result.stderr}` });
  return result.stdout;
}

function git(root: string, args: string[]): string {
  return gitBytes(root, args).toString("utf8");
}

void runScript(async () => {
  const args = parseArgs(SPECS);
  if (args.mode === "diff" && !args.base)
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "--mode diff requires --base <ref>" });
  if (args.mode === "tree" && (args.base || args.head !== "HEAD"))
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "--base and --head require --mode diff" });
  const root = git(process.cwd(), ["rev-parse", "--show-toplevel"]).trim();
  const config = JSON.parse(readFileSync(path.resolve(root, args.config!), "utf8")) as {
    leakPatterns: LeakPattern[];
    allowedHits: AllowedHit[];
  };
  const { leakPatterns, localPatterns } = loadLeakPatterns(root, config.leakPatterns, args.local ? "required" : "none");
  const patterns = compileLeakPatterns(leakPatterns);
  const allowed = config.allowedHits.map((rule) => ({ ...rule, regex: globToRegex(rule.glob) }));
  const hits: Hit[] = [];
  const explainedHits: (Hit & { reason: string })[] = [];
  const scan = (file: string, line: number, text: string) => {
    for (const pattern of patterns) {
      if (!pattern.regex.test(text)) continue;
      const hit = { file, line, pattern: pattern.name, text: line === 0 ? "(path)" : text.trim().slice(0, 160) };
      const rule = allowed.find(
        (item) => item.pattern === pattern.name && item.regex.test(file) && excuses(item, pattern, text),
      );
      if (rule) explainedHits.push({ ...hit, reason: rule.reason });
      else hits.push(hit);
    }
  };

  let files: string[];
  let base: string | undefined;
  let head: string | undefined;
  if (args.mode === "tree") {
    files = [
      ...new Set(
        git(root, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"]).split("\0").filter(Boolean),
      ),
    ]
      .filter((file) => {
        try {
          return lstatSync(path.join(root, file)).isFile();
        } catch {
          return false;
        }
      })
      .sort();
    for (const file of files) {
      scan(file, 0, file);
      const bytes = readFileSync(path.join(root, file));
      if (!isBinary(bytes))
        bytes
          .toString("utf8")
          .split("\n")
          .forEach((line, index) => scan(file, index + 1, line));
    }
  } else {
    base = git(root, ["rev-parse", "--verify", "--end-of-options", `${args.base}^{commit}`]).trim();
    head = git(root, ["rev-parse", "--verify", "--end-of-options", `${args.head}^{commit}`]).trim();
    const changes = git(root, [
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--no-renames",
      "--name-status",
      "-z",
      base,
      head,
      "--",
    ])
      .split("\0")
      .filter(Boolean);
    files = [];
    for (let i = 0; i < changes.length; i += 2) {
      const status = changes[i]!;
      const file = changes[i + 1]!;
      if (status === "D") continue;
      files.push(file);
      if (status === "A") scan(file, 0, file);
      if (git(root, ["ls-tree", "-z", head, "--", `:(literal)${file}`]).startsWith("160000 ")) continue;
      if (isBinary(gitBytes(root, ["cat-file", "blob", `${head}:${file}`]))) continue;
      // Attributes can mark plaintext as -diff; use the same byte test as tree mode.
      const diff = git(root, [
        "diff",
        "--text",
        "--no-ext-diff",
        "--no-textconv",
        "--no-color",
        "--no-renames",
        "--unified=0",
        base,
        head,
        "--",
        `:(literal)${file}`,
      ]);
      let line: number | undefined;
      for (const text of diff.split("\n")) {
        const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
        if (hunk) line = Number(hunk[1]);
        else if (line !== undefined && text.startsWith("+")) scan(file, line++, text.slice(1));
        else if (line !== undefined && text.startsWith(" ")) line++;
      }
    }
  }

  const metadata = {
    mode: args.mode,
    localPatterns,
    ...(base ? { base, head } : {}),
    filesScanned: files.length,
    hits,
    explainedHits,
  };
  if (hits.length)
    throw new CliErrorObject({ code: "VALIDATION", message: `Leak scan found ${hits.length} hits`, details: metadata });
  return { metadata };
});
