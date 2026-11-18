import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readlinkSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { CliErrorObject } from "../cli";

export interface RepositoryText {
  files: string[];
  read(file: string): string | undefined;
  exists(file: string): boolean;
  ignored?(file: string): boolean;
  linkTarget?(file: string): string | undefined;
}

export function gitText(root: string, args: string[]): string {
  try {
    return execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    throw new CliErrorObject({
      code: "INVALID_INPUT",
      message: `Cannot read repository data: git ${args[0]}. Check the repository and refs.`,
    });
  }
}

export function commitOf(root: string, ref: string): string {
  return gitText(root, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`]).trim();
}

/** Lazily reads requested text; private environment files and paths outside the repository stay closed. */
export function repositoryText(root: string, ref?: string): RepositoryText {
  const commit = ref === undefined ? undefined : commitOf(root, ref);
  const files = gitText(root, commit ? ["ls-tree", "-r", "--name-only", "-z", commit] : ["ls-files", "-z"])
    .split("\0")
    .filter(Boolean)
    .sort();
  const names = new Set(files);
  const cache = new Map<string, string | undefined>();
  const ignored = new Map<string, boolean>();
  const safe = (file: string) =>
    file !== "" &&
    !path.isAbsolute(file) &&
    !file
      .split("/")
      .some((part) => part === ".." || part === ".env" || (part.startsWith(".env.") && part !== ".env.example"));
  const inside = (file: string) => {
    const absolute = path.join(root, file);
    if (!existsSync(absolute)) return false;
    const relative = path.relative(realpathSync(root), realpathSync(absolute));
    return !relative.startsWith("..") && safe(relative);
  };
  return {
    files,
    linkTarget: (file) =>
      !commit && safe(file) && lstatSync(path.join(root, file), { throwIfNoEntry: false })?.isSymbolicLink()
        ? readlinkSync(path.join(root, file))
        : undefined,
    exists: (file) =>
      safe(file) &&
      (commit ? names.has(file) || files.some((name) => name.startsWith(`${file.replace(/\/$/, "")}/`)) : inside(file)),
    ignored: (file) => {
      if (!safe(file) || commit) return false;
      if (!ignored.has(file)) {
        try {
          ignored.set(file, gitText(root, ["check-ignore", "--", file]).trim().length > 0);
        } catch {
          ignored.set(file, false);
        }
      }
      return ignored.get(file)!;
    },
    read: (file) => {
      if (!safe(file)) return undefined;
      if (!cache.has(file))
        cache.set(
          file,
          commit
            ? names.has(file)
              ? gitText(root, ["show", `${commit}:${file}`])
              : undefined
            : inside(file) && statSync(path.join(root, file)).isFile()
              ? readFileSync(path.join(root, file), "utf8")
              : undefined,
        );
      return cache.get(file);
    },
  };
}

export const isSkill = (file: string): boolean => /^\.agents\/skills\/[^/]+\/SKILL\.md$/.test(file);
export const isAgent = (file: string): boolean =>
  /^\.agents\/agents\/[^/]+\.md$/.test(file) && !file.endsWith("/README.md");
export const isInstruction = (file: string): boolean =>
  /(^|\/)AGENTS\.md$/.test(file) ||
  file === "CONTRIBUTING.md" ||
  /^contrib\/.*\.md$/.test(file) ||
  isSkill(file) ||
  isAgent(file);

/** The repository uses scalar descriptions; folded/literal YAML blocks are also accepted. */
export function descriptionOf(text: string): string {
  const front = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)?.[1];
  const match = front && /^description:[ \t]*(.*)(?:\n((?:[ \t]+[^\n]*(?:\n|$))*))?/m.exec(front);
  if (!match) return "";
  const scalar = match[1]!.trim();
  if (/^[>|][-+]?$/.test(scalar))
    return (match[2] ?? "")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .join(scalar.startsWith(">") ? " " : "\n");
  const folded = [
    scalar,
    ...(match[2] ?? "")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean),
  ].join(" ");
  if (folded.startsWith('"')) {
    try {
      return JSON.parse(folded) as string;
    } catch {
      return folded;
    }
  }
  return folded.replace(/^'(.*)'$/, "$1").replaceAll("''", "'");
}
