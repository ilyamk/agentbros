import test from "node:test";
import assert from "node:assert/strict";
import {
  compareVersions,
  detectOs,
  formatReport,
  hintFor,
  meetsMinimum,
  overall,
  parseVersion,
  type DoctorCheck,
} from "../src/lib/doctor";

test("versions compare numerically and tolerate prefixes", () => {
  assert.deepEqual(parseVersion("v20.12.1"), [20, 12, 1]);
  assert.deepEqual(parseVersion("ffmpeg version 7.1 Copyright"), [7, 1, 0]);
  assert.equal(parseVersion("unknown"), undefined);
  assert.equal(compareVersions("20.9.0", "20.12.0"), -1);
  assert.equal(compareVersions("22.0.0", "20.12.0"), 1);
  assert.equal(compareVersions("20.12", "20.12.0"), 0);
  assert.ok(meetsMinimum("20.12.0", "20.12.0"));
  assert.ok(!meetsMinimum("20.11.1", "20.12.0"));
  assert.ok(!meetsMinimum("garbage", "20.12.0"));
});

test("host detection reads platform and os-release", () => {
  assert.equal(detectOs("darwin"), "macos");
  assert.equal(detectOs("win32"), "windows");
  assert.equal(detectOs("linux", 'NAME="Ubuntu"\nID=ubuntu\nID_LIKE=debian\n'), "debian");
  assert.equal(detectOs("linux", "ID=debian\n"), "debian");
  assert.equal(detectOs("linux", "ID=fedora\n"), "linux");
});

test("hints follow the host package manager", () => {
  assert.equal(hintFor("ffmpeg", "macos"), "brew install ffmpeg");
  assert.equal(hintFor("ffmpeg", "debian"), "sudo apt-get install -y ffmpeg");
  assert.match(hintFor("ffmpeg", "windows") ?? "", /winget.*choco/);
  assert.match(hintFor("chromium", "debian") ?? "", /libnss3.*remotion browser ensure/);
  assert.doesNotMatch(hintFor("ffmpeg", "linux") ?? "", /apt-get/);
  assert.equal(hintFor("swiftc", "windows"), undefined);
});

test("only failures make the report fail, and key values are never printed", () => {
  const checks: DoctorCheck[] = [
    { id: "node", label: "Node.js", status: "ok", detail: "22.0.0", required: true },
    { id: "uv", label: "uv", status: "warn", detail: "not on PATH", required: false, hint: "brew install uv" },
  ];
  assert.deepEqual(overall(checks), { ok: true, counts: { ok: 1, warn: 1, fail: 0 } });
  assert.equal(
    overall([...checks, { id: "ffmpeg", label: "ffmpeg", status: "fail", detail: "missing", required: true }]).ok,
    false,
  );
  const report = formatReport(checks, [{ name: "FAL_KEY", set: true, unlocks: "images" }]);
  assert.match(report, /fix: brew install uv/);
  assert.match(report, /set\s+FAL_KEY/);
  const failed = formatReport([{ id: "pnpm", label: "pnpm", status: "fail", detail: "missing", required: true }], []);
  assert.match(failed, /run pnpm preflight again/);
  assert.doesNotMatch(failed, /run pnpm doctor/);
});
