import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { RepositoryText } from "../src/lib/context/repository";

export function textRepository(files: Record<string, string>): RepositoryText {
  return { files: Object.keys(files), read: (file) => files[file], exists: (file) => Object.hasOwn(files, file) };
}
export const changeText = (category = "docs") =>
  `---\ncategory: ${category}\nbump: patch\nbreaking: false\npr: 0\nauthors: [tester]\nharness: codex\n---\nRepair a concrete problem.\n`;
export function temporaryRepository() {
  const root = mkdtempSync(path.join(tmpdir(), "contrib-tools-"));
  const env = {
    PATH: process.env.PATH,
    HOME: root,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: path.join(root, "no-config"),
    GIT_AUTHOR_NAME: "Test",
    GIT_AUTHOR_EMAIL: "test@example.invalid",
    GIT_COMMITTER_NAME: "Test",
    GIT_COMMITTER_EMAIL: "test@example.invalid",
  };
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: root, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const write = (file: string, content: string | Buffer) => {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), content);
  };
  const cli = (name: string, ...args: string[]) =>
    spawnSync(
      process.execPath,
      ["--import", path.resolve("node_modules/tsx/dist/loader.mjs"), path.resolve(`scripts/${name}.ts`), ...args],
      { cwd: root, env, encoding: "utf8" },
    );
  git("init", "-b", "main");
  write("docs/guide.md", "Before\n");
  git("add", ".");
  git("commit", "-m", "base");
  const base = git("rev-parse", "HEAD");
  git("checkout", "-b", "contribution");
  write("docs/guide.md", "After\n");
  write(".changes/repair.md", changeText());
  git("add", ".");
  git("commit", "-m", "repair");
  return { root, git, write, cli, base, env, dispose: () => rmSync(root, { recursive: true, force: true }) };
}
