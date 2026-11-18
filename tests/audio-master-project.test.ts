import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync, cpSync, mkdirSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { spawnSync, execFileSync } from "node:child_process";
import { audioProject } from "./helpers/review-audio";
import { planProjectRender } from "../src/lib/render-plan";
import { projectAudioMix, projectAudioMixWithInputs } from "../src/lib/audio/project-mix";
import { assertAudioMasterInputs } from "../src/lib/audio/master-inputs";
import { mixLocalAudio } from "../src/lib/audio/local-mix";
import { TimelineEditStore } from "../src/lib/timeline-ir/store";
const r = (num: number) => ({ num, den: 1 });

test(
  "genuine project CLI master pins effective inputs; same-duration edits stale, undo/visual-only/relocation remain compatible",
  { timeout: 30000 },
  () => {
    const root = mkdtempSync(path.join(tmpdir(), "master-project-")),
      moved = mkdtempSync(path.join(tmpdir(), "master-relocation-"));
    const { project, store } = audioProject(root),
      output = path.join(project, "master.wav"),
      sidecar = output + ".json";
    const configFile = path.join(project, "project.json"),
      config = JSON.parse(readFileSync(configFile, "utf8"));
    config.musicVolume = 0;
    writeFileSync(configFile, JSON.stringify(config));
    const initial = store.read();
    initial.timeline.tracks.find((t) => t.kind === "voiceover")!.clips[0].assetId = "projects/demo/voiceover.wav";
    writeFileSync(store.file, JSON.stringify(initial));
    const guard = path.join(root, "deny-network.cjs");
    writeFileSync(
      guard,
      "globalThis.fetch=()=>{throw Error('Forbidden network')};for(const id of ['node:http','node:https']){const m=require(id);m.get=m.request=()=>{throw Error('Forbidden network')};}require('node:net').Socket.prototype.connect=()=>{throw Error('Forbidden network')};",
    );
    const cli = path.resolve("node_modules/tsx/dist/cli.mjs"),
      script = path.resolve("scripts/mix-audio.ts");
    const invoke = (args: string[]) =>
      spawnSync(process.execPath, ["--require", guard, cli, script, ...args], {
        cwd: root,
        env: { AGENTBROS_NO_DOTENV: "1", PATH: process.env.PATH },
        encoding: "utf8",
        timeout: 20000,
        killSignal: "SIGKILL",
      });
    const render = () => planProjectRender("demo", "square", root, { timeline: true, audioMaster: sidecar });
    try {
      const before = readFileSync(store.file),
        child = invoke(["--project", "demo", "--output", output]);
      assert.equal(child.error, undefined);
      assert.equal(child.status, 0, child.stderr);
      assert.equal(child.stdout.trim().split("\n").length, 1);
      const result = JSON.parse(child.stdout);
      assert.equal(result.ok, true);
      assert.equal(result.metadata.apiCalls, 0);
      assert.deepEqual(readFileSync(store.file), before);
      const master = JSON.parse(readFileSync(sidecar, "utf8"));
      assert.equal(master.projectInputs.projectId, "demo");
      assert.ok(master.projectInputs.sources.every((s: { source: string }) => !path.isAbsolute(s.source)));
      assert.equal(render().jobs[0].durationInFrames, 90);
      assert.ok(Math.abs(master.durationSec - 3) < 0.001);
      if (process.env.AUDIO_MASTER_INPUTS_ARTIFACTS_DIR) {
        const destination = path.resolve(process.env.AUDIO_MASTER_INPUTS_ARTIFACTS_DIR, "project-cli");
        mkdirSync(destination, { recursive: true });
        cpSync(path.join(root, "public"), path.join(destination, "public"), { recursive: true });
        writeFileSync(
          path.join(destination, "evidence.json"),
          JSON.stringify(
            {
              loadedRevision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
              label: "Local synthetic three-tone 3s diagnostic, not creative acceptance",
              cli: {
                ok: result.ok,
                apiCalls: result.metadata.apiCalls,
                stdoutLines: child.stdout.trim().split("\n").length,
              },
              master,
              compiledFrames: 90,
              rootReplay: { projectId: "demo", timeline: true, audioMaster: "public/projects/demo/master.wav.json" },
            },
            null,
            2,
          ),
        );
      }
      assert.throws(
        () => planProjectRender("demo", "square", root, { audioMaster: sidecar }),
        /original project timeline/,
      );
      for (const command of [
        { type: "audio-gain", trackId: "music", clipId: "clip", gain: 0.5 },
        { type: "trim", trackId: "sfx", clipId: "clip", start: r(1), end: r(90) },
        { type: "rate", trackId: "sfx", clipId: "clip", rate: { num: 2, den: 1 } },
        {
          type: "batch",
          commands: [
            { type: "audio-loop", trackId: "music", clipId: "clip", loop: false },
            { type: "trim", trackId: "music", clipId: "clip", start: r(0), end: r(30) },
          ],
        },
      ]) {
        const revision = store.read().revision;
        store.apply(command, revision);
        assert.throws(render, /inputs changed/);
        store.undo(revision + 1);
        assert.equal(render().jobs[0].durationInFrames, 90);
      }
      const automation = path.join(project, "pipeline/audio-mix.json"),
        originalAutomation = readFileSync(automation);
      const changed = JSON.parse(originalAutomation.toString());
      changed.tracks[0].keyframes[0].volume = 0.2;
      writeFileSync(automation, JSON.stringify(changed));
      assert.throws(render, /inputs changed/);
      writeFileSync(automation, originalAutomation);
      render();
      const originalJournal = readFileSync(store.file),
        doc = store.read();
      doc.timeline.tracks.find((t) => t.kind === "visual")!.clips[0].payload!.scene = {
        ...(doc.timeline.tracks.find((t) => t.kind === "visual")!.clips[0].payload!.scene as object),
        headline: "Visual only",
      };
      doc.timeline.tracks.find((t) => t.kind === "voiceover")!.clips[0].captions[0].text = "Caption-only edit";
      doc.revision += 100;
      writeFileSync(store.file, JSON.stringify(doc));
      render();
      writeFileSync(store.file, originalJournal);
      const source = projectAudioMix("demo", { rootDir: root }).tracks[0].source,
        sourceBytes = readFileSync(source);
      const sameDuration = Buffer.from(sourceBytes);
      sameDuration[100] ^= 1;
      writeFileSync(source, sameDuration);
      assert.throws(render, /inputs changed/);
      writeFileSync(source, sourceBytes);
      render();
      const durationDoc = store.read();
      durationDoc.timeline.tracks.find((t) => t.kind === "visual")!.clips[0].source.end = r(120);
      writeFileSync(store.file, JSON.stringify(durationDoc));
      assert.throws(render, /inputs changed|duration/);
      writeFileSync(store.file, originalJournal);
      cpSync(path.join(root, "public"), path.join(moved, "public"), { recursive: true });
      const relocated = planProjectRender("demo", "square", moved, {
        timeline: true,
        audioMaster: path.join(moved, "public/projects/demo/master.wav.json"),
      });
      assert.deepEqual(relocated.jobs[0].props.audioMaster?.projectInputs, master.projectInputs);
      // Legacy/manual sidecars deliberately have no project binding and retain explicit mode.
      delete master.projectInputs;
      writeFileSync(sidecar, JSON.stringify(master));
      store.apply({ type: "audio-gain", trackId: "music", clipId: "clip", gain: 0 }, store.read().revision);
      render();
      const standalone = path.join(project, "standalone.wav"),
        planFile = path.join(root, "plan.json");
      writeFileSync(planFile, JSON.stringify(projectAudioMix("demo", { rootDir: root })));
      const standaloneChild = invoke(["--plan", planFile, "--output", standalone]);
      assert.equal(standaloneChild.status, 0, standaloneChild.stderr);
      assert.equal(JSON.parse(readFileSync(standalone + ".json", "utf8")).projectInputs, undefined);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(moved, { recursive: true, force: true });
    }
  },
);

test("concurrent project inputs changed before atomic publication leave output unpublished and old forced output untouched", () => {
  const root = mkdtempSync(path.join(tmpdir(), "master-concurrent-"));
  const { project, store } = audioProject(root),
    output = path.join(project, "master.wav");
  try {
    const captured = projectAudioMixWithInputs("demo", { rootDir: root });
    const beforePublish = () => {
      store.apply({ type: "audio-gain", trackId: "music", clipId: "clip", gain: 0.5 }, store.read().revision);
      assertAudioMasterInputs(captured.inputs, projectAudioMixWithInputs("demo", { rootDir: root }).inputs);
    };
    assert.throws(() => mixLocalAudio(captured.plan, output, { beforePublish }), /inputs changed/);
    assert.equal(existsSync(output), false);
    writeFileSync(output, "previous explicitly supplied master bytes");
    const prior = readFileSync(output);
    assert.throws(
      () =>
        mixLocalAudio(captured.plan, output, {
          force: true,
          beforePublish: () =>
            assertAudioMasterInputs(captured.inputs, projectAudioMixWithInputs("demo", { rootDir: root }).inputs),
        }),
      /inputs changed/,
    );
    assert.deepEqual(readFileSync(output), prior);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
