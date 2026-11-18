import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { syncBuiltinESMExports } from "node:module";
import { RhythmReadContext } from "../src/lib/audio/rhythm-files";

function fixture(t: test.TestContext) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), "rhythm-refusal-data-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "source.bin");
  fs.writeFileSync(file, "PRIVATE_DATA_A");
  const reader = new RhythmReadContext(root),
    pin = reader.read("source.bin", 1024).pin;
  return { root, file, reader, pin };
}
function refusal(action: () => unknown, primary: string) {
  let thrown: unknown;
  try {
    action();
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown instanceof Error);
  assert.ok(thrown.message.startsWith(primary + "; rhythmRefusal="));
  const data = (thrown as Error & { rhythmRefusal: any }).rhythmRefusal;
  assert.deepEqual(Object.keys(data), ["version", "path", "reasons", "expected", "observed"]);
  assert.equal(data.version, 1);
  assert.equal(data.path, "source.bin");
  assert.ok(Buffer.byteLength(JSON.stringify(data)) <= 8192);
  assert.ok(data.reasons.length <= 12);
  assert.ok(
    Object.isFrozen(data) &&
      Object.isFrozen(data.expected) &&
      Object.isFrozen(data.expected.identity) &&
      Object.isFrozen(data.observed) &&
      Object.isFrozen(data.reasons),
  );
  return { error: thrown, data };
}

test("changed same-length hash reports first exact consumed pin without content or authority refresh", (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.file, "PRIVATE_DATA_B");
  const { data } = refusal(() => f.reader.assertUnchanged(), "Rhythm current file pin changed");
  assert.ok(data.reasons.includes("sha256"));
  assert.equal(data.expected.sha256, f.pin.sha256);
  assert.notEqual(data.observed.sha256, f.pin.sha256);
  assert.equal(data.expected.bytes, data.observed.bytes);
  assert.equal(data.observed.kind, "regular");
  assert.equal(JSON.stringify(data).includes("PRIVATE_DATA_"), false);
  assert.equal(JSON.stringify(data).includes(f.root), false);
  assert.deepEqual(f.reader.snapshotPins(), [{ kind: "present", ...f.pin }]);
  assert.throws(() => f.reader.assertUnchanged(), /Rhythm current file pin changed/);
});
test("same-byte restore still refuses strict metadata and preserves original hash authority", (t) => {
  const f = fixture(t),
    before = fs.statSync(f.file);
  fs.writeFileSync(f.file, "changed");
  fs.writeFileSync(f.file, "PRIVATE_DATA_A");
  fs.utimesSync(f.file, before.atime, new Date(before.mtimeMs + 1000));
  const { data } = refusal(() => f.reader.assertUnchanged(), "Rhythm current file pin changed");
  assert.equal(data.observed.sha256, data.expected.sha256);
  assert.ok(data.reasons.includes("mtimeMs"));
  assert.deepEqual(f.reader.snapshotPins(), [{ kind: "present", ...f.pin }]);
});
test("same-byte inode replacement preserves strict inode refusal", (t) => {
  const f = fixture(t),
    replacement = path.join(f.root, "new.bin");
  fs.writeFileSync(replacement, "PRIVATE_DATA_A");
  fs.renameSync(replacement, f.file);
  const { data } = refusal(() => f.reader.assertUnchanged(), "Rhythm current file pin changed");
  assert.ok(data.reasons.includes("ino"));
  assert.equal(data.observed.sha256, data.expected.sha256);
  assert.notEqual(data.observed.identity.ino, data.expected.identity.ino);
});
test("delete keeps earlier membership guard and reports missing known direct member without reopening", (t) => {
  const f = fixture(t);
  fs.unlinkSync(f.file);
  const { data } = refusal(() => f.reader.assertUnchanged(), "Rhythm directory membership changed");
  assert.deepEqual(data.reasons, ["missing"]);
  assert.equal(data.observed.kind, "missing");
  assert.equal(data.observed.sha256, null);
  assert.equal(data.observed.identity, null);
  assert.equal(data.expected.sha256, f.pin.sha256);
});
test("symlink refusal neither follows nor discloses its absolute target or contents", (t) => {
  const f = fixture(t),
    target = path.join(f.root, "..", "private-target-" + path.basename(f.root));
  fs.writeFileSync(target, "ABSOLUTE_TARGET_SECRET");
  t.after(() => fs.rmSync(target, { force: true }));
  fs.unlinkSync(f.file);
  fs.symlinkSync(target, f.file);
  const { data } = refusal(() => f.reader.assertUnchanged(), "Rhythm input must be regular/non-alias");
  assert.ok(data.reasons.includes("nonregular"));
  assert.equal(data.observed.kind, "symlink");
  assert.equal(data.observed.sha256, null);
  assert.equal(data.observed.bytes, null);
  for (const forbidden of [target, f.root, "ABSOLUTE_TARGET_SECRET", "PRIVATE_DATA_A"])
    assert.equal(JSON.stringify(data).includes(forbidden), false);
});
test("repeat read keeps primary refusal and immutable closed diagnostic", (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.file, "PRIVATE_DATA_B");
  const { error, data } = refusal(() => f.reader.read("source.bin", 1024), "Rhythm consumed pin changed");
  assert.equal(Object.getOwnPropertyDescriptor(error, "rhythmRefusal")?.writable, false);
  assert.throws(() => {
    data.path = "/host/secret";
  }, TypeError);
  assert.throws(() => {
    data.expected.identity.ino = 0;
  }, TypeError);
  assert.deepEqual(f.reader.snapshotPins(), [{ kind: "present", ...f.pin }]);
});
test("refusal hashes the same consumed bytes with exactly one data FD and no diagnostic reopen", async (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.file, "PRIVATE_DATA_B");
  const api = (await import("node:fs")).default,
    original = api.openSync;
  let opens = 0;
  api.openSync = ((...args: Parameters<typeof original>) => {
    if (args[0] === f.file) opens++;
    return Reflect.apply(original, api, args);
  }) as typeof original;
  syncBuiltinESMExports();
  try {
    const { data } = refusal(() => f.reader.assertUnchanged(), "Rhythm current file pin changed");
    assert.ok(data.reasons.includes("sha256"));
    assert.equal(opens, 1);
  } finally {
    api.openSync = original;
    syncBuiltinESMExports();
  }
});
test("diagnostic attachment preserves even a nonextensible primary IO Error object", async (t) => {
  const f = fixture(t),
    api = (await import("node:fs")).default,
    original = api.openSync,
    primary = Object.freeze(Error("fixed nonextensible IO refusal"));
  api.openSync = ((...args: Parameters<typeof original>) => {
    if (args[0] === f.file) throw primary;
    return Reflect.apply(original, api, args);
  }) as typeof original;
  syncBuiltinESMExports();
  try {
    assert.throws(
      () => f.reader.assertUnchanged(),
      (error) => error === primary,
    );
    assert.equal(primary.message, "fixed nonextensible IO refusal");
  } finally {
    api.openSync = original;
    syncBuiltinESMExports();
  }
});
