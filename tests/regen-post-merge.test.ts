import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { FALLBACK_GENERATORS, regeneratePostMerge } from "../src/lib/release/post-merge";
import { parseChangeEntry } from "../src/lib/contrib/changes";

const git = (root: string, args: string[]) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const entry = (pr = 0) =>
  `---\ncategory: fix\nbump: patch\nbreaking: false\npr: ${pr}\nauthors: [person]\n---\nRepair.\n\npr: 0\n`;
function fixture(t: test.TestContext) {
  const root = mkdtempSync(path.join(tmpdir(), "regen-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, ".changes"));
  mkdirSync(path.join(root, "area"));
  writeFileSync(path.join(root, "package.json"), '{"scripts":{}}');
  writeFileSync(path.join(root, "AGENTS.md"), "# Root\n\nLast updated: 2026-01-01\n\nOld.\n");
  writeFileSync(path.join(root, "area/AGENTS.md"), "# Area\n\nLast updated: 2026-01-01\n");
  writeFileSync(path.join(root, ".changes/old.md"), entry());
  writeFileSync(path.join(root, ".changes/README.md"), "Guide.\n");
  git(root, ["init", "-q"]);
  git(root, ["config", "user.email", "fixture@example.test"]);
  git(root, ["config", "user.name", "Fixture"]);
  git(root, ["add", "."]);
  git(root, ["commit", "-qm", "Base"]);
  const base = git(root, ["rev-parse", "HEAD"]);
  writeFileSync(path.join(root, "AGENTS.md"), "# Root\n\nLast updated: 2026-01-01\n\nChanged.\n");
  writeFileSync(path.join(root, ".changes/new.md"), entry());
  writeFileSync(path.join(root, ".changes/known.md"), entry(17));
  git(root, ["add", "."]);
  git(root, ["commit", "-qm", "Head"]);
  const head = git(root, ["rev-parse", "HEAD"]);
  return { root, base, head };
}

test("post-merge regenerates first, dates only changed instructions and fills only added zero PRs", (t) => {
  const { root, base, head } = fixture(t);
  const calls: (readonly string[])[] = [];
  const run = (_root: string, args: readonly string[]) => {
    calls.push(args);
    if (args[0] === "commands")
      writeFileSync(path.join(root, "AGENTS.md"), "# Root\n\nLast updated: 2026-01-01\n\nGenerated catalogue.\n");
  };
  const result = regeneratePostMerge(root, { base, head, pr: 99, date: "2026-01-16" }, run);
  assert.deepEqual(calls, FALLBACK_GENERATORS);
  assert.deepEqual(result.outputs, ["AGENTS.md", ".changes/new.md"]);
  assert.match(readFileSync(path.join(root, "AGENTS.md"), "utf8"), /Last updated: 2026-01-16\n\nGenerated catalogue/);
  assert.match(readFileSync(path.join(root, "area/AGENTS.md"), "utf8"), /Last updated: 2026-01-01/);
  assert.equal(parseChangeEntry(readFileSync(path.join(root, ".changes/new.md"), "utf8")).pr, 99);
  assert.match(readFileSync(path.join(root, ".changes/new.md"), "utf8"), /Repair\.\n\npr: 0/);
  assert.equal(parseChangeEntry(readFileSync(path.join(root, ".changes/old.md"), "utf8")).pr, 0);
  assert.equal(parseChangeEntry(readFileSync(path.join(root, ".changes/known.md"), "utf8")).pr, 17);
  assert.equal(git(root, ["rev-parse", "HEAD"]), head);
  regeneratePostMerge(root, { base, head, pr: 99, date: "2026-01-16" }, () => {});
  assert.equal(parseChangeEntry(readFileSync(path.join(root, ".changes/new.md"), "utf8")).pr, 99);
});

test("post-merge uses the planned regen alias or the existing regen script before the fallback", (t) => {
  const { root, base, head } = fixture(t);
  const calls: (readonly string[])[] = [];
  const run = (_root: string, args: readonly string[]) => {
    calls.push(args);
  };
  writeFileSync(path.join(root, "package.json"), '{"scripts":{"regen":"tsx scripts/regen.ts"}}');
  regeneratePostMerge(root, { base, head }, run);
  assert.deepEqual(calls, [["regen"]]);
  calls.length = 0;
  writeFileSync(path.join(root, "package.json"), '{"scripts":{}}');
  mkdirSync(path.join(root, "scripts"));
  writeFileSync(path.join(root, "scripts/regen.ts"), "// Fixture");
  regeneratePostMerge(root, { base, head }, run);
  assert.deepEqual(calls, [["exec", "tsx", "scripts/regen.ts"]]);
});

test("post-merge rejects invalid dates, refs and PR numbers before calling generators", (t) => {
  const { root, base, head } = fixture(t);
  let calls = 0;
  const run = () => {
    calls++;
  };
  for (const options of [
    { base, head, date: "2026-02-30" },
    { base, head, date: "yesterday" },
    { base, head, pr: -1 },
    { base: "missing", head },
  ])
    assert.throws(() => regeneratePostMerge(root, options, run));
  assert.equal(calls, 0);
});

test("post-merge fills CRLF front matter without altering its comment or Markdown body", (t) => {
  const { root, base } = fixture(t);
  writeFileSync(
    path.join(root, ".changes/new.md"),
    entry().replace("pr: 0\n", "pr: 0 # assigned after merge\n").replace(/\n/g, "\r\n"),
  );
  git(root, ["add", "."]);
  git(root, ["commit", "-qm", "CRLF entry"]);
  const head = git(root, ["rev-parse", "HEAD"]);
  regeneratePostMerge(root, { base, head, pr: 25 }, () => {});
  const source = readFileSync(path.join(root, ".changes/new.md"), "utf8");
  assert.match(source, /pr: 25 # assigned after merge\r\n/);
  assert.match(source, /Repair\.\r\n\r\npr: 0\r\n$/);
});

test("post-merge CLI captures generator output inside one JSON result and propagates failure", (t) => {
  const { root, base, head } = fixture(t);
  const bin = path.join(root, "bin");
  mkdirSync(bin);
  writeFileSync(path.join(root, "package.json"), '{"scripts":{"regen":"fixture"}}');
  const executable = path.join(bin, "pnpm");
  writeFileSync(executable, `#!${process.execPath}\nprocess.stdout.write(JSON.stringify({ok:true})+'\\n');\n`);
  chmodSync(executable, 0o755);
  const run = (args: string[]) =>
    spawnSync(
      process.execPath,
      [
        "--import",
        path.resolve("node_modules/tsx/dist/loader.mjs"),
        path.resolve("scripts/regen-post-merge.ts"),
        ...args,
      ],
      {
        cwd: root,
        encoding: "utf8",
        env: { AGENTBROS_NO_DOTENV: "1", PATH: `${bin}${path.delimiter}${process.env.PATH}` },
      },
    );
  const args = ["--base", base, "--head", head, "--pr", "55", "--date", "2026-01-20"];
  const success = run(args);
  assert.equal(success.status, 0, success.stdout + success.stderr);
  assert.equal(success.stdout.trim().split("\n").length, 1);
  assert.equal(JSON.parse(success.stdout).ok, true);
  writeFileSync(
    executable,
    `#!${process.execPath}\nprocess.stdout.write(JSON.stringify({ok:false,message:'Fixture failure'})+'\\n');process.exitCode=1;\n`,
  );
  const failure = run(args);
  assert.equal(failure.status, 1);
  assert.match(JSON.parse(failure.stdout).message, /Fixture failure/);
  assert.equal(JSON.parse(run(["--help"]).stdout).metadata.help, true);
});
