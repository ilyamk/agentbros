import { SPAWN_TIMEOUT_MS } from "./helpers/timeouts";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { readHarnessJson } from "../src/lib/assets/harness-runtime";

const invalid = (error: unknown) => (error as { code?: string }).code === "VALIDATION";
function fixture(t: test.TestContext, bytes: string | Buffer = '{"value":"original"}') {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), "harness-snapshot-")));
  const directory = path.join(root, "inputs");
  fs.mkdirSync(directory);
  const file = path.join(directory, "request.json");
  fs.writeFileSync(file, bytes);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, file, relative: "inputs/request.json" };
}
/** Scoped syscall observation changes only owned fixture files, never production state. */
function interceptRead<T>(
  hook: (fd: number, length: number, call: number) => void,
  run: () => T,
): { result: T; reads: number; closes: number } {
  const read = fs.readSync,
    close = fs.closeSync;
  let reads = 0,
    closes = 0,
    heldFd: number | undefined;
  fs.readSync = ((fd: number, buffer: Buffer, offset: number, length: number, position: number | null) => {
    heldFd ??= fd;
    hook(fd, length, ++reads);
    return read(fd, buffer, offset, length, position);
  }) as typeof fs.readSync;
  fs.closeSync = ((fd: number) => {
    if (fd === heldFd) closes++;
    return close(fd);
  }) as typeof fs.closeSync;
  syncBuiltinESMExports();
  try {
    return { result: run(), reads, closes };
  } finally {
    fs.readSync = read;
    fs.closeSync = close;
    syncBuiltinESMExports();
  }
}

test("snapshot reader preserves valid Unicode/whitespace and original BOM rejection", (t) => {
  const f = fixture(t, ' \n{"value":"\u043f\u0440\u0438\u0432\u0435\u0442 \u00e9 \ud83d\ude80"}\t');
  assert.deepEqual(readHarnessJson(f.root, f.relative), {
    value: "\u043f\u0440\u0438\u0432\u0435\u0442 \u00e9 \ud83d\ude80",
  });
  fs.writeFileSync(f.file, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("{}")]));
  assert.throws(() => readHarnessJson(f.root, f.relative), invalid);
});
test("malformed UTF8 that replacement decoding accepts is rejected without repaired content", (t) => {
  const bytes = Buffer.concat([Buffer.from('{"value":"'), Buffer.from([0xc3, 0x28]), Buffer.from('"}')]);
  assert.doesNotThrow(() => JSON.parse(bytes.toString("utf8")));
  const f = fixture(t, bytes);
  assert.throws(() => readHarnessJson(f.root, f.relative), invalid);
});
test("captured size uses bounded chunks and exactly one EOF growth probe", (t) => {
  const value = "a".repeat(2 * 1024 ** 2 + 19),
    f = fixture(t, JSON.stringify({ value })),
    lengths: number[] = [];
  const observed = interceptRead(
    (_fd, length) => lengths.push(length),
    () => readHarnessJson(f.root, f.relative),
  );
  assert.deepEqual(observed.result, { value });
  assert.equal(observed.closes, 1);
  assert.deepEqual(lengths, [1024 ** 2, 1024 ** 2, fs.statSync(f.file).size - 2 * 1024 ** 2, 1]);
});
test("growth after captured size refuses after the one-byte probe and closes fd", (t) => {
  const f = fixture(t),
    lengths: number[] = [];
  const observed = interceptRead(
    (_fd, length, call) => {
      lengths.push(length);
      if (call === 1) fs.appendFileSync(f.file, " ".repeat(1024));
    },
    () => assert.throws(() => readHarnessJson(f.root, f.relative), invalid),
  );
  assert.equal(observed.reads, 2);
  assert.equal(lengths[1], 1);
  assert.equal(observed.closes, 1);
});
test("shrink after capture refuses early EOF and closes fd", (t) => {
  const f = fixture(t);
  const observed = interceptRead(
    (_fd, _length, call) => {
      if (call === 1) fs.truncateSync(f.file, 1);
    },
    () => assert.throws(() => readHarnessJson(f.root, f.relative), invalid),
  );
  assert.equal(observed.reads, 2);
  assert.equal(observed.closes, 1);
});
test("same-byte lexical replacement cannot authenticate held old inode", (t) => {
  const f = fixture(t),
    replacement = path.join(path.dirname(f.file), "replacement.json");
  fs.copyFileSync(f.file, replacement);
  const observed = interceptRead(
    (_fd, _length, call) => {
      if (call === 1) fs.renameSync(replacement, f.file);
    },
    () => assert.throws(() => readHarnessJson(f.root, f.relative), invalid),
  );
  assert.equal(observed.closes, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.file, "utf8")), { value: "original" });
});
test("leaf and ancestor alias replacement refuses even when held original bytes survive", async (t) => {
  for (const kind of ["leaf", "ancestor"] as const)
    await t.test(kind, (t) => {
      const f = fixture(t),
        backup = path.join(f.root, "backup");
      const observed = interceptRead(
        (_fd, _length, call) => {
          if (call !== 1) return;
          if (kind === "leaf") {
            fs.renameSync(f.file, backup);
            fs.symlinkSync(backup, f.file);
          } else {
            fs.renameSync(path.dirname(f.file), backup);
            fs.symlinkSync(backup, path.dirname(f.file));
          }
        },
        () => assert.throws(() => readHarnessJson(f.root, f.relative), invalid),
      );
      assert.equal(observed.closes, 1);
    });
});
test(
  "CLI emits one failure envelope for corrupt encoding without persisting operation",
  { timeout: SPAWN_TIMEOUT_MS + 10_000 },
  (t) => {
    const f = fixture(t, Buffer.concat([Buffer.from('{"value":"'), Buffer.from([0xff]), Buffer.from('"}')]));
    const environment = Object.fromEntries(
      ["PATH", "HOME", "TMPDIR"].filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]]),
    );
    const child = spawnSync(
      process.execPath,
      [
        path.resolve("node_modules/tsx/dist/cli.mjs"),
        path.resolve("scripts/harness-assets.ts"),
        "--action",
        "capabilities",
        "--capabilities",
        f.relative,
        "--scope-root",
        f.root,
      ],
      { cwd: f.root, env: environment, encoding: "utf8", timeout: SPAWN_TIMEOUT_MS, maxBuffer: 65536 },
    );
    assert.equal(child.error, undefined);
    assert.equal(child.status, 1, child.stderr);
    assert.equal(child.stdout.trim().split("\n").length, 1);
    const envelope = JSON.parse(child.stdout);
    assert.equal(envelope.ok, false);
    assert.equal(envelope.error, "VALIDATION");
    assert.equal(fs.existsSync(path.join(f.root, "public")), false);
  },
);
test("regular parent/root replacement refuses even with exactly the same hardlinked leaf", async (t) => {
  for (const kind of ["parent", "root"] as const)
    await t.test(kind, (t) => {
      const f = fixture(t),
        parent = kind === "root" ? f.root : path.dirname(f.file);
      const alternate = parent + "-alternate",
        backup = parent + "-backup";
      const leafRelative = path.relative(parent, f.file),
        alternateLeaf = path.join(alternate, leafRelative);
      fs.mkdirSync(path.dirname(alternateLeaf), { recursive: true });
      fs.linkSync(f.file, alternateLeaf);
      t.after(() => {
        fs.rmSync(alternate, { recursive: true, force: true });
        fs.rmSync(backup, { recursive: true, force: true });
      });
      const original = fs.statSync(f.file),
        parentBefore = fs.statSync(parent),
        bytes = fs.readFileSync(f.file);
      const observed = interceptRead(
        (_fd, _length, call) => {
          if (call === 1) {
            fs.renameSync(parent, backup);
            fs.renameSync(alternate, parent);
          }
        },
        () => assert.throws(() => readHarnessJson(f.root, f.relative), invalid),
      );
      const current = fs.statSync(f.file);
      for (const key of ["dev", "ino", "size", "mtimeMs", "ctimeMs"] as const)
        assert.equal(current[key], original[key]);
      assert.notEqual(fs.statSync(parent).ino, parentBefore.ino);
      assert.deepEqual(fs.readFileSync(f.file), bytes);
      assert.equal(observed.closes, 1);
    });
});
test("unrelated sibling writes do not invalidate an unchanged directory identity", (t) => {
  const f = fixture(t),
    parent = fs.statSync(path.dirname(f.file));
  const observed = interceptRead(
    (_fd, _length, call) => {
      if (call === 1) fs.writeFileSync(path.join(path.dirname(f.file), "sibling.json"), "{}");
    },
    () => readHarnessJson(f.root, f.relative),
  );
  assert.equal(fs.statSync(path.dirname(f.file)).ino, parent.ino);
  assert.deepEqual(observed.result, { value: "original" });
  assert.equal(observed.closes, 1);
});
