import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { MEDIA_BINARY, TRACKED_MEDIA_FOLDERS } from "../src/lib/workspace/hygiene";

// The repository is the harness: projects, renders and generated media live in git-ignored folders (AGENTS.md).
const git = (args: string[]) => spawnSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
const inRepo = git(["rev-parse", "--is-inside-work-tree"]).stdout.trim() === "true";
const list = (args: string[]) => git(args).stdout.split("\0").filter(Boolean);

const PROJECT_LOCATIONS = ["public/projects/", "src/projects/", "out/", ".cache/"];
const ALLOWED_IN_PROJECT_LOCATIONS = new Set(["public/projects/.gitkeep"]);

const IMPORT = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)(["'])([^"']+)\1/g;

test("no tracked file lies in a project location", { skip: !inRepo }, () => {
  const offending = list(["ls-files", "-z"]).filter(
    (file) =>
      PROJECT_LOCATIONS.some((location) => file.startsWith(location)) && !ALLOWED_IN_PROJECT_LOCATIONS.has(file),
  );
  assert.deepEqual(offending, []);
});

test("nothing is tracked that .gitignore excludes", { skip: !inRepo }, () => {
  assert.deepEqual(
    list(["ls-files", "-z", "--cached", "--ignored", "--exclude-standard"]),
    [],
    "fix .gitignore, or move the file to a project location or behind a manifest (docs/assets.md)",
  );
});

test("tracked code never imports project code or project data", { skip: !inRepo }, () => {
  const code = list(["ls-files", "-z", "--", "*.ts", "*.tsx", "*.mts", "*.mjs", "*.js"]);
  const offending: string[] = [];
  for (const file of code) {
    let source: string;
    try {
      source = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const match of source.matchAll(IMPORT)) {
      const specifier = match[2]!;
      const target = specifier.startsWith("@/")
        ? path.join("src", specifier.slice(2))
        : specifier.startsWith(".")
          ? path.normalize(path.join(path.dirname(file), specifier))
          : undefined;
      if (target && /^(src|public)\/projects\//.test(target.split(path.sep).join("/")))
        offending.push(`${file} -> ${specifier}`);
    }
  }
  assert.deepEqual(offending, []);
});

// The same rule runs in `pnpm repo:hygiene --check` (media-binary); the list lives in src/lib/workspace/hygiene.ts.
test("tracked media binaries are only the documented exceptions", { skip: !inRepo }, () => {
  const offending = list(["ls-files", "-z"]).filter(
    (file) => MEDIA_BINARY.test(file) && !TRACKED_MEDIA_FOLDERS.some((folder) => file.startsWith(folder)),
  );
  assert.deepEqual(
    offending,
    [],
    "fetch it from a manifest (docs/assets.md), or add it to inventory row (c) and to TRACKED_MEDIA_FOLDERS",
  );
});
