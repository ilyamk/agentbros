import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { hashFile } from "../src/lib/assets/registry";
import { planProjectRender } from "../src/lib/render-plan";
function fixture(t: test.TestContext) {
  const root = mkdtempSync(path.join(os.tmpdir(), "audio-master-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, "public/projects/master");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "project.json"),
    JSON.stringify({
      name: "master",
      productName: "master",
      formats: ["vertical", "square", "landscape"],
      colors: {},
      musicVolume: 0,
      scenes: [
        {
          id: "hook",
          text: "A",
          headline: "A",
          visualType: "title",
          durationInFrames: 30,
        },
      ],
    }),
  );
  const audio = path.join(dir, "master.wav");
  execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=880:duration=1", audio]);
  const master = {
    source: "projects/master/master.wav",
    sourceSha256: hashFile(audio),
    durationSec: 1,
    integratedLufs: -16,
    truePeakDb: -1.5,
    targetLufs: -16,
    createdAt: "2026-10-11T00:00:00Z",
  };
  const sidecar = path.join(dir, "master.wav.json");
  writeFileSync(sidecar, JSON.stringify(master));
  return { root, dir, sidecar, audio, master };
}
test("explicit measured master is pinned in every format and ordinary render remains unchanged", (t) => {
  const { root, sidecar } = fixture(t);
  assert.equal(planProjectRender("master", undefined, root).jobs[0].props.audioMaster, undefined);
  const plan = planProjectRender("master", undefined, root, {
    audioMaster: sidecar,
  });
  assert.equal(plan.jobs.length, 3);
  for (const job of plan.jobs) {
    assert.equal(job.durationInFrames, 30);
    assert.equal(job.props.audioMaster?.source, "projects/master/master.wav");
  }
});
test("stale hashes, wrong durations, remote masters and escaping paths fail before renderer", (t) => {
  const { root, sidecar, master, audio } = fixture(t);
  for (const patch of [
    { sourceSha256: "0".repeat(64) },
    { durationSec: 2 },
    { source: "https://example.test/master.wav" },
    { source: "../outside.wav" },
  ]) {
    writeFileSync(sidecar, JSON.stringify({ ...master, ...patch }));
    assert.throws(() => planProjectRender("master", undefined, root, { audioMaster: sidecar }));
  }
  writeFileSync(sidecar, JSON.stringify(master));
  writeFileSync(audio, "changed");
  assert.throws(() => planProjectRender("master", undefined, root, { audioMaster: sidecar }), /checksum/);
});
