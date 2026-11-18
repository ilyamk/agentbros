import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { creditsDocument, readCredits, writeCredits } from "../src/lib/release/credits";
import { CreditSchema } from "../src/types/credits";

test("every real credit column survives a byte-identical document round trip", () => {
  const credits = readCredits(process.cwd());
  assert.ok(credits.length > 0);
  assert.deepEqual([...new Set(credits.map((credit) => credit.section))].sort(), [
    "assets",
    "films",
    "repositories",
    "tools",
  ]);
  assert.equal(creditsDocument(credits), readFileSync("CREDITS.md", "utf8"));
  assert.equal(creditsDocument([...credits].reverse()), creditsDocument(credits));
  assert.equal(writeCredits(process.cwd(), true), credits.length);
});

test("credits CLI checks staleness and regenerates missing documents with one JSON line", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "credits-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  cpSync("credits", path.join(root, "credits"), { recursive: true });
  const expected = readFileSync("CREDITS.md", "utf8");
  const run = (args: string[]) =>
    spawnSync(
      process.execPath,
      [
        "--import",
        path.resolve("node_modules/tsx/dist/loader.mjs"),
        path.resolve("scripts/credits-write-doc.ts"),
        ...args,
      ],
      { cwd: root, encoding: "utf8", env: { AGENTBROS_NO_DOTENV: "1", PATH: process.env.PATH } },
    );
  const generated = run([]);
  assert.equal(generated.status, 0, generated.stdout + generated.stderr);
  assert.equal(generated.stdout.trim().split("\n").length, 1);
  assert.equal(JSON.parse(generated.stdout).metadata.sources, readCredits(root).length);
  assert.equal(readFileSync(path.join(root, "CREDITS.md"), "utf8"), expected);
  assert.equal(run(["--check"]).status, 0);
  writeFileSync(path.join(root, "CREDITS.md"), "Stale.\n");
  const stale = run(["--check"]);
  assert.equal(stale.status, 1);
  assert.equal(JSON.parse(stale.stdout).error, "VALIDATION");
  assert.equal(readFileSync(path.join(root, "CREDITS.md"), "utf8"), "Stale.\n");
  assert.equal(run([]).status, 0);
  assert.equal(readFileSync(path.join(root, "CREDITS.md"), "utf8"), expected);
  assert.equal(JSON.parse(run(["--help"]).stdout).metadata.help, true);
});

test("credit schemas reject missing columns, unknown columns and embedded newlines", () => {
  const credit = readCredits(process.cwd()).find((item) => item.section === "tools")!;
  assert.equal(CreditSchema.safeParse({ ...credit, role: undefined }).success, false);
  assert.equal(CreditSchema.safeParse({ ...credit, extra: "unknown" }).success, false);
  assert.equal(CreditSchema.safeParse({ ...credit, role: "One\nTwo" }).success, false);
});

test("credit generation refuses a dangling document symlink", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "credits-link-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  cpSync("credits", path.join(root, "credits"), { recursive: true });
  const target = path.join(root, "missing.md");
  symlinkSync(target, path.join(root, "CREDITS.md"));
  assert.throws(() => writeCredits(root), /regular file/);
  assert.equal(existsSync(target), false);
});
