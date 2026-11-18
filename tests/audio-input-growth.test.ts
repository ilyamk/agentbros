import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import {
  localInputHash,
  assertRegularLocalInput,
  readLocalJson,
  localPublicSource,
} from "../src/lib/audio/local-input";

test("hash reads only captured initial bytes plus one growth probe under continuous real appends", (t) => {
  const root = fs.mkdtempSync(path.join(tmpdir(), "audio-growth-")),
    file = path.join(root, "source");
  fs.writeFileSync(file, "1234567");
  const originalRead = fs.readSync,
    requested: number[] = [];
  let returned = 0;
  try {
    t.mock.method(
      fs,
      "readSync",
      (fd: number, buffer: Buffer, offset: number, length: number, position: number | null) => {
        requested.push(length);
        fs.appendFileSync(file, Buffer.alloc(65536, 65));
        if (requested.length > 3) throw new Error("Regression: hashing followed growing EOF");
        const count = originalRead(fd, buffer, offset, length, position);
        returned += count;
        return count;
      },
    );
    syncBuiltinESMExports();
    assert.throws(() => localInputHash(file), /source changed/);
    assert.deepEqual(requested, [7, 1]);
    assert.equal(returned, 8);
    assert.equal(fs.statSync(file).size, 7 + 2 * 65536);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("same-size pathname replacement is rejected although original descriptor bytes stay stable", (t) => {
  const root = fs.mkdtempSync(path.join(tmpdir(), "audio-replace-")),
    file = path.join(root, "source");
  fs.writeFileSync(file, "1234567");
  const originalRead = fs.readSync;
  let replaced = false;
  try {
    t.mock.method(
      fs,
      "readSync",
      (fd: number, buffer: Buffer, offset: number, length: number, position: number | null) => {
        if (!replaced) {
          replaced = true;
          fs.renameSync(file, path.join(root, "old"));
          fs.writeFileSync(file, "1234567");
        }
        return originalRead(fd, buffer, offset, length, position);
      },
    );
    syncBuiltinESMExports();
    assert.throws(() => localInputHash(file), /source changed/);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test(
  "final symlinks refuse hash/probe/metadata/public-source; canonical parent aliases remain valid",
  { skip: process.platform === "win32" },
  () => {
    const root = fs.mkdtempSync(path.join(tmpdir(), "audio-symlink-")),
      file = path.join(root, "source"),
      link = path.join(root, "link");
    fs.mkdirSync(path.join(root, "public"));
    fs.writeFileSync(file, '{"original":true}');
    fs.symlinkSync(file, link);
    try {
      for (const read of [localInputHash, assertRegularLocalInput, readLocalJson])
        assert.throws(() => read(link), /final symlink/);
      assert.throws(() => localPublicSource(link, root), /final symlink/);
      const alias = path.join(root, "parent-alias");
      fs.symlinkSync(root, alias, "dir");
      const hash = createHash("sha256").update(fs.readFileSync(file)).digest("hex");
      assert.equal(localInputHash(path.join(alias, "source")), hash);
      assert.equal(localInputHash(path.join(fs.realpathSync(root), "source")), hash);
      assert.deepEqual(readLocalJson(path.join(alias, "source")), { original: true });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);

test("final symlink swapped after lstat is rejected by nofollow open", { skip: process.platform === "win32" }, (t) => {
  const root = fs.mkdtempSync(path.join(tmpdir(), "audio-symlink-race-")),
    file = path.join(root, "source"),
    other = path.join(root, "other");
  fs.writeFileSync(file, "1234567");
  fs.writeFileSync(other, "7654321");
  const originalOpen = fs.openSync;
  let replaced = false;
  try {
    t.mock.method(fs, "openSync", (value: fs.PathLike, flags: string | number, mode?: fs.Mode) => {
      if (String(value) === file && !replaced) {
        replaced = true;
        fs.unlinkSync(file);
        fs.symlinkSync(other, file);
      }
      return originalOpen(value, flags, mode);
    });
    syncBuiltinESMExports();
    assert.throws(() => localInputHash(file), /ELOOP|symlink/);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
