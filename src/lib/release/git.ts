import { execFileSync } from "node:child_process";

export function git(root: string, args: string[]): string {
  // Whole files are read out of git (docs/api/surface.json is over 1 MiB): the default 1 MiB buffer fails with ENOBUFS.
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 256 * 1024 * 1024,
  }).trimEnd();
}

export function commit(root: string, ref: string): string {
  return git(root, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`]);
}

export function lastRelease(root: string, since?: string): { tag: string; commit: string; date: string } | undefined {
  let tag = since;
  if (tag === undefined) {
    const tags = git(root, ["tag", "--merged", "HEAD", "--list"])
      .split("\n")
      .filter((value) => /^v\d+\.\d+\.\d+$/.test(value));
    if (!tags.length) return undefined;
    tag = git(root, ["describe", "--tags", "--abbrev=0", ...tags.flatMap((value) => ["--match", value]), "HEAD"]);
  }
  const sha = commit(root, tag);
  const tagDate = git(root, ["for-each-ref", "--format=%(creatordate:iso-strict)", `refs/tags/${tag}`]);
  return { tag, commit: sha, date: tagDate || git(root, ["show", "-s", "--format=%cI", sha]) };
}

export function addedFiles(root: string, base?: string, head = "HEAD"): string[] {
  const sha = commit(root, head);
  return git(
    root,
    base
      ? ["diff", "--name-only", "--diff-filter=A", "-z", commit(root, base), sha, "--"]
      : ["ls-tree", "-r", "--name-only", "-z", sha],
  )
    .split("\0")
    .filter(Boolean);
}
