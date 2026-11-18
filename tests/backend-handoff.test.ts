import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { prepareHandoff, executeResolveHandoff, type ResolveAdapter } from "../src/lib/backends/handoff";
import { fraction as f } from "../src/lib/timeline-ir/rational";
import { probeBlender, probeResolve, listOptionalBackends } from "../src/lib/backends/probe";
import { captureBlender } from "../src/lib/backends/blender";
const fixture = async (run: (directory: string, manifest: ReturnType<typeof prepareHandoff>) => Promise<void>) => {
  const root = mkdtempSync(path.join(tmpdir(), "handoff-"));
  const original = path.join(root, "original.mp4");
  writeFileSync(original, "original immutable bytes");
  const timeline = {
    version: 1,
    projectId: "demo",
    timebase: f(30),
    tracks: [
      {
        id: "video",
        kind: "visual",
        clips: [
          {
            id: "clip",
            assetId: "original",
            start: f(0),
            source: { start: f(10), end: f(40), timebase: f(30) },
            rate: f(1),
            transition: { kind: "cut" },
            captions: [],
          },
        ],
      },
    ],
  };
  try {
    const manifest = prepareHandoff(
      timeline,
      { original: { path: original, kind: "video", durationFrames: f(60), timebase: f(30) } },
      path.join(root, "handoff"),
      "original-timeline",
    );
    await run(path.join(root, "handoff"), manifest);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};
function adapter(
  expected: Record<string, unknown>,
  options: { contradict?: boolean; wrongClone?: boolean; failClone?: boolean } = {},
) {
  const calls: string[] = [];
  const value: ResolveAdapter = {
    probe: async () => ({
      backend: "resolve",
      available: true,
      version: "20.2.0",
      capabilities: ["clone", "import-into-clone", "readback", "original-fingerprint"],
      liveVerified: false,
    }),
    fingerprintOriginal: async (id) => {
      assert.equal(id, "original-timeline");
      return "unchanged";
    },
    cloneTimeline: async (id) => {
      assert.equal(id, "original-timeline");
      calls.push("clone");
      if (options.failClone) throw new Error("lost acknowledgement");
      return { timelineId: options.wrongClone ? id : "clone-timeline" };
    },
    importIntoClone: async (id) => {
      assert.equal(id, "clone-timeline");
      calls.push("import");
    },
    readback: async (id) => {
      assert.equal(id, "clone-timeline");
      calls.push("readback");
      return options.contradict ? { changed: true } : expected;
    },
  };
  return { value, calls };
}
test("checksummed handoff clones only, verifies exact readback and resume never repeats mutations", () =>
  fixture(async (directory, manifest) => {
    const mock = adapter(manifest.expected);
    assert.equal((await executeResolveHandoff(directory, mock.value)).state, "verified");
    assert.equal((await executeResolveHandoff(directory, mock.value)).state, "verified");
    assert.equal(mock.calls.filter((call) => call === "clone").length, 1);
    assert.equal(mock.calls.filter((call) => call === "import").length, 1);
    assert.equal(readFileSync(manifest.originals[0]!.path, "utf8"), "original immutable bytes");
  }));
test("readback contradiction retained for recovery; no blind import retry", () =>
  fixture(async (directory, manifest) => {
    const mock = adapter(manifest.expected, { contradict: true });
    assert.equal((await executeResolveHandoff(directory, mock.value)).state, "contradiction");
    assert.equal((await executeResolveHandoff(directory, mock.value)).state, "contradiction");
    assert.equal(mock.calls.filter((call) => call === "import").length, 1);
  }));
test("ambiguous clone submit does not repeat; unsafe clone ID cannot receive import", () =>
  fixture(async (directory, manifest) => {
    const mock = adapter(manifest.expected, { failClone: true });
    await assert.rejects(() => executeResolveHandoff(directory, mock.value), /lost acknowledgement/);
    assert.equal((await executeResolveHandoff(directory, mock.value)).state, "unknown");
    assert.equal(mock.calls.filter((call) => call === "clone").length, 1);
  }));
test("same-original clone and altered source/export fail before application", () =>
  fixture(async (directory, manifest) => {
    const mock = adapter(manifest.expected, { wrongClone: true });
    await assert.rejects(() => executeResolveHandoff(directory, mock.value), /isolated clone/);
    assert.ok(!mock.calls.includes("import"));
    writeFileSync(manifest.originals[0]!.path, "changed");
    await assert.rejects(() => executeResolveHandoff(directory, mock.value), /checksum/);
  }));
test("unsupported/missing external software stays structured unavailable without fake installation", () =>
  fixture(async (directory, manifest) => {
    const mock = adapter(manifest.expected);
    mock.value.probe = async () => ({
      backend: "resolve",
      available: false,
      capabilities: [],
      reason: "not installed",
      liveVerified: false,
    });
    assert.equal((await executeResolveHandoff(directory, mock.value)).state, "unavailable");
    assert.deepEqual(mock.calls, []);
    const unavailable = () => ({ status: 127, stdout: "", stderr: "not installed" });
    assert.equal(probeBlender("missing", unavailable).available, false);
    assert.equal(probeResolve("missing", unavailable).available, false);
    assert.equal(captureBlender({ frames: [10, 0, 3] }, directory, { runner: unavailable }).state, "unavailable");
    assert.ok(
      listOptionalBackends()
        .filter((b) => ["opencut", "hyperframes-html"].includes(b.backend))
        .every((b) => b.available === false),
    );
  }));
test("read-only real local probes report actual availability and require full mutation adapter separately", () => {
  const blender = probeBlender();
  assert.equal(typeof blender.available, "boolean");
  assert.equal(blender.liveVerified, false);
  const resolve = probeResolve();
  assert.ok(!resolve.capabilities.includes("clone"));
});
test("Blender worker parses as local Python and actual installed captures are repeatable by random frame seek", async (context) => {
  const { execFileSync } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const worker = fileURLToPath(new URL("../scripts/workers/blender_capture.py", import.meta.url));
  execFileSync("python3", ["-c", 'import ast,sys; ast.parse(open(sys.argv[1], encoding="utf8").read())', worker]);
  if (!probeBlender().available) {
    context.skip("Blender 4.2+/5.x not installed: actual capture unavailable");
    return;
  }
  const root = mkdtempSync(path.join(tmpdir(), "actual-blender-"));
  try {
    const sequential = captureBlender(
      { frames: [0, 3, 10], width: 96, height: 96 },
      path.join(root, "sequential"),
    ) as any;
    const random = captureBlender({ frames: [10, 0, 3], width: 96, height: 96 }, path.join(root, "random")) as any;
    for (const frame of sequential.frames)
      assert.equal(frame.sha256, random.frames.find((f: any) => f.frame === frame.frame).sha256);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
