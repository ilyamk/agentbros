import { gitText, commitOf } from "../context/repository";
import { execFileSync } from "node:child_process";
import type { ChangedFile } from "./intake";

export function gitBytes(root: string, commit: string, file: string): Buffer {
  return execFileSync("git", ["show", `${commit}:${file}`], {
    cwd: root,
    maxBuffer: 32 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

export function contributionBase(root: string, requested?: string): string {
  const mergeBase = (ref: string) => gitText(root, ["merge-base", commitOf(root, ref), "HEAD"]).trim();
  if (requested) {
    try {
      return mergeBase(requested);
    } catch {
      throw new Error(
        "Cannot resolve the requested base; pass --base <commit> with a commit sharing history with HEAD.",
      );
    }
  }
  for (const ref of ["upstream/main", "origin/main"]) {
    try {
      return mergeBase(ref);
    } catch {
      /* Try the next remote. */
    }
  }
  for (const remote of gitText(root, ["remote"]).split("\n").filter(Boolean)) {
    try {
      return mergeBase(gitText(root, ["symbolic-ref", `refs/remotes/${remote}/HEAD`]).trim());
    } catch {
      /* Try the next remote's default branch. */
    }
  }
  try {
    return mergeBase("main");
  } catch {
    /* Supply a useful hint for remote-less clones. */
  }
  throw new Error("Cannot discover a contribution base; pass --base <commit> with a commit sharing history with HEAD.");
}
export function changedFiles(root: string, base: string, headRef = "HEAD"): ChangedFile[] {
  const head = commitOf(root, headRef);
  const options = ["--no-ext-diff", "--no-textconv", "--no-renames", "-z", base, head, "--"];
  const statuses = gitText(root, ["diff", "--name-status", ...options]).split("\0");
  const status = new Map<string, string>();
  for (let i = 0; i + 1 < statuses.length; i += 2) status.set(statuses[i + 1]!, statuses[i]!);
  return gitText(root, ["diff", "--numstat", ...options])
    .split("\0")
    .filter(Boolean)
    .map((row) => {
      const match = /^(\d+|-)\t(\d+|-)\t([\s\S]+)$/.exec(row);
      if (!match) throw new Error("Invalid Git numstat record");
      const added = match[1]!,
        removed = match[2]!,
        file = match[3]!;
      const record: ChangedFile = {
        path: file,
        additions: added === "-" ? 0 : Number(added),
        deletions: removed === "-" ? 0 : Number(removed),
        binary: added === "-" || removed === "-",
        status: status.get(file)!,
      };
      if (file === "package.json" || /^\.changes\/[^/]+\.md$/.test(file)) {
        if (record.status !== "D") record.content = gitText(root, ["show", `${head}:${file}`]);
        if (file === "package.json" && record.status !== "A")
          record.previousContent = gitText(root, ["show", `${base}:${file}`]);
      }
      return record;
    });
}

/** Untracked source/config/tests can also affect gates; prose PR drafts are harmless. */
export function uncommittedCode(root: string): string[] {
  const tracked = gitText(root, ["diff", "--no-ext-diff", "--no-textconv", "--name-only", "-z", "HEAD", "--"])
    .split("\0")
    .filter(Boolean);
  const untracked = gitText(root, ["ls-files", "--others", "--exclude-standard", "-z"])
    .split("\0")
    .filter(
      (file) =>
        !file.startsWith(".contrib/") &&
        (/^(?:src|scripts|tests|playbooks|contrib|\.agents|\.github|\.changes)\//.test(file) ||
          /\.(?:[cm]?[jt]sx?|json|ya?ml)$/.test(file)),
    );
  return [...new Set([...tracked, ...untracked])].sort();
}
