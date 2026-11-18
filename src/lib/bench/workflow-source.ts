import { lstatSync } from "node:fs";
import path from "node:path";
import { boundedFile } from "../apple/runtime";
import { command, contained, digest, fail } from "./io";

const roots = [
  "src",
  "scripts",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  ".nvmrc",
  ".nvmrc.fallback",
  "AGENTS.md",
  ".agents",
  "playbooks",
  "docs/commands.md",
  "docs/local-macos.md",
];
export function captureWorkflowSource(root: string) {
  const names = () =>
    command("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", ...roots], root)
      .split("\0")
      .filter(Boolean)
      .sort();
  const paths = names(),
    files = paths.map((name) => {
      const file = contained(root, name),
        stat = lstatSync(file);
      return {
        path: name,
        sha256: digest(boundedFile(file, 32 * 1024 * 1024)),
        stat: `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`,
      };
    });
  const sha256 = digest(JSON.stringify(files.map((f) => ({ path: f.path, sha256: f.sha256 }))));
  const dirty = command("git", ["status", "--porcelain", "--untracked-files=all", "--", ...roots], root).length > 0;
  return {
    sha256,
    dirty,
    files: files.map((f) => ({ path: f.path, sha256: f.sha256 })),
    verify() {
      if (JSON.stringify(paths) !== JSON.stringify(names())) fail("Trusted source inventory changed during evaluation");
      for (const pin of files) {
        const file = path.join(root, pin.path),
          stat = lstatSync(file);
        if (
          `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}` !== pin.stat &&
          digest(boundedFile(contained(root, pin.path), 32 * 1024 * 1024)) !== pin.sha256
        )
          fail(`Trusted source changed during evaluation: ${pin.path}`);
      }
    },
  };
}
export type WorkflowSource = ReturnType<typeof captureWorkflowSource>;
