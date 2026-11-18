import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { ReferenceSourceSchema } from "../../types/reference";

// A private reference (a client's film) takes part in the local corpus and nowhere else. Two marks, both local:
// `private: true` in its source.json says what it is, and a line in .git/info/exclude (never .gitignore, which is
// tracked and would name the id) keeps git from offering its files. `ref:add --private` writes both; an exclude line
// alone, the older way, is still recognised.

function git(cwd: string, args: string[]): string | undefined {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return undefined;
  }
}

/** The repository's top level and its info/exclude (shared by every worktree), or undefined outside a repository. */
export function excludeFile(cwd: string): { root: string; file: string } | undefined {
  const root = git(cwd, ["rev-parse", "--show-toplevel"]);
  const file = root && git(root, ["rev-parse", "--git-path", "info/exclude"]);
  return root && file ? { root, file: path.resolve(root, file) } : undefined;
}

/** A path with symlinks resolved (macOS /var is /private/var), so it compares with git's top level; parts not yet created are kept. */
const realPath = (target: string) => {
  let at = path.resolve(target);
  const rest: string[] = [];
  while (!existsSync(at)) {
    rest.unshift(path.basename(at));
    at = path.dirname(at);
  }
  return path.join(realpathSync(at), ...rest);
};
const nearestExisting = (directory: string) => {
  let at = realPath(directory);
  while (!existsSync(at)) at = path.dirname(at);
  return at;
};

/** Ignores a reference directory in .git/info/exclude unless git already ignores it. */
export function excludeReference(directory: string): {
  excludeFile?: string;
  line?: string;
  added: boolean;
  reason?: string;
} {
  const found = excludeFile(nearestExisting(directory));
  if (!found) return { added: false, reason: "not inside a git repository; nothing to exclude" };
  const relative = path.relative(found.root, realPath(directory)).split(path.sep).join("/");
  if (relative.startsWith("..")) return { added: false, reason: "outside the repository" };
  const line = `/${relative}/`;
  const ignored = git(found.root, ["check-ignore", "-q", "--no-index", `${relative}/source.json`]) !== undefined;
  if (ignored) return { excludeFile: found.file, line, added: false, reason: "already ignored" };
  mkdirSync(path.dirname(found.file), { recursive: true });
  const existing = existsSync(found.file) ? readFileSync(found.file, "utf8") : "";
  appendFileSync(
    found.file,
    `${existing && !existing.endsWith("\n") ? "\n" : ""}# private reference (ref:add --private)\n${line}\n`,
  );
  return { excludeFile: found.file, line, added: true };
}

/** Reference ids under `libraryRoot` that .git/info/exclude ignores by a line naming their directory. */
export function excludedReferenceIds(libraryRoot: string): string[] {
  const found = excludeFile(nearestExisting(libraryRoot));
  if (!found || !existsSync(found.file)) return [];
  const library = path.relative(found.root, realPath(libraryRoot)).split(path.sep).join("/");
  const ids = new Set<string>();
  for (const raw of readFileSync(found.file, "utf8").split("\n")) {
    const line = raw
      .trim()
      .replace(/^\//, "")
      .replace(/\/\*{0,2}$/, "");
    if (!line || line.startsWith("#") || line.startsWith("!")) continue;
    if (line.startsWith(`${library}/`)) {
      const id = line.slice(library.length + 1);
      if (/^[a-z0-9][a-z0-9-]*$/.test(id)) ids.add(id);
    }
  }
  return [...ids].sort();
}

/** Ids whose source.json says `private: true`. */
export function flaggedPrivateIds(libraryRoot: string): string[] {
  if (!existsSync(libraryRoot)) return [];
  return readdirSync(libraryRoot)
    .filter((id) => {
      const file = path.join(libraryRoot, id, "source.json");
      if (!existsSync(file)) return false;
      try {
        return ReferenceSourceSchema.parse(JSON.parse(readFileSync(file, "utf8"))).private === true;
      } catch {
        return false;
      }
    })
    .sort();
}

/** Every private reference id this machine knows: flagged in source.json or excluded in .git/info/exclude. */
export function privateReferenceIds(libraryRoot: string): string[] {
  return [...new Set([...flaggedPrivateIds(libraryRoot), ...excludedReferenceIds(libraryRoot)])].sort();
}
