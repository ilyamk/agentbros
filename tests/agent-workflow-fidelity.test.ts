import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { WorkflowObserver } from "../src/lib/bench/workflow-observer";
import { workflowScenarios } from "../src/lib/bench/workflow-scenarios";
import {
  contractWorkflow,
  consumeRecording,
  consumeVoice,
  stageWorkflowMaterial,
} from "../src/lib/bench/workflow-fixtures";
import { voiceResultForRequest } from "../src/lib/bench/workflow-assertions";
import { digest } from "../src/lib/bench/io";
import { LocalTextRequestSchema } from "../src/types/local-capabilities";

const repo = process.cwd();
async function setup(t: test.TestContext, id: string) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "workflow-fidelity-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const entry = workflowScenarios(repo).find((e) => e.scenario.id === id)!;
  const workspace = path.join(root, "workspace");
  mkdirSync(workspace);
  const observer = new WorkflowObserver(repo, workspace, path.join(root, "evidence"), entry.scenario);
  await stageWorkflowMaterial(observer);
  return { root, workspace, observer };
}
test("a same-duration replacement recording cannot redefine the task original", async (t) => {
  const { workspace, observer } = await setup(t, "recording-shorts");
  assert.equal(
    spawnSync(
      "ffmpeg",
      [
        "-v",
        "error",
        "-nostdin",
        "-y",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=880:duration=3",
        "-c:a",
        "pcm_s16le",
        path.join(workspace, "input.wav"),
      ],
      { timeout: 15000 },
    ).status,
    0,
  );
  await assert.rejects(
    observer.execute("transcribe", [
      "--input",
      "input.wav",
      "--from-raw",
      "material/scribe.json",
      "--output",
      "transcript.json",
    ]),
    /original changed/,
  );
});
test("unrelated leaf help does not establish a cross-actor artefact handoff", async (t) => {
  const { observer } = await setup(t, "leaf-handoff");
  observer.actors.set("leaf-1", "root");
  const help = await observer.execute("speech:local", ["--help"], { actor: "leaf-1" });
  assert.equal(help.event.passed, true);
  const producer = await observer.execute("transcribe", [
    "--input",
    "input.wav",
    "--from-raw",
    "material/scribe.json",
    "--output",
    "root-transcript.json",
  ]);
  assert.equal(producer.event.passed, true);
  const consumer = await observer.execute("shorts:prepare", [
    "--transcript",
    "root-transcript.json",
    "--output-dir",
    "shorts",
  ]);
  assert.equal(consumer.event.passed, true);
  await assert.rejects(consumeRecording(observer, "input.wav", true, ["leaf-1"]), /not produced by.*leaf/);
});
test("a later identical leaf output cannot retroactively own an earlier root consumption", async (t) => {
  const { observer, workspace } = await setup(t, "leaf-handoff");
  observer.actors.set("leaf-1", "root");
  const args = ["--input", "input.wav", "--from-raw", "material/scribe.json", "--output", "transcript.json"];
  const first = await observer.execute("transcribe", args);
  assert.equal(first.event.passed, true);
  const before = observer.pin("transcript.json");
  assert.equal(
    (await observer.execute("shorts:prepare", ["--transcript", "transcript.json", "--output-dir", "shorts-before"]))
      .event.passed,
    true,
  );
  rmSync(path.join(workspace, "transcript.json"));
  assert.equal((await observer.execute("transcribe", args, { actor: "leaf-1" })).event.passed, true);
  assert.equal(
    observer.pin("transcript.json").sha256,
    before.sha256,
    "identical bytes exercise the causal edge rather than content mismatch",
  );
  await assert.rejects(consumeRecording(observer, "input.wav", true, ["leaf-1"]), /not produced by.*leaf/);
  assert.equal(
    (await observer.execute("shorts:prepare", ["--transcript", "transcript.json", "--output-dir", "shorts-after"]))
      .event.passed,
    true,
  );
  assert.equal(await consumeRecording(observer, "input.wav", true, ["leaf-1"]), "handoff");
});
test("a language override cannot qualify a different voice language as the requested draft", () => {
  const request = LocalTextRequestSchema.parse({
    version: 1,
    kind: "scenes",
    sourceLanguage: "en",
    units: [{ id: "scene-1", text: "Hold on the product." }],
  });
  const result = { language: "en-US", units: [{ id: "scene-1", sourceTextHash: digest(request.units[0]!.text) }] };
  assert.doesNotThrow(() => voiceResultForRequest(result, request));
  assert.throws(() => voiceResultForRequest({ ...result, language: "ru-RU" }, request), /language differs/);
  assert.throws(
    () => voiceResultForRequest({ ...result, units: [{ ...result.units[0], id: "invented" }] }, request),
    /identifiers/,
  );
});
test("voice request IDs/text and observed receipt bytes are independent acceptance boundaries", async (t) => {
  const { workspace, observer } = await setup(t, "voice-draft");
  assert.equal(await contractWorkflow(observer), "draft-refused");
  const source = path.join(workspace, "material/voice.json"),
    bytes = readFileSync(source);
  const request = JSON.parse(bytes.toString());
  request.units[0].text = "An unrelated script.";
  writeFileSync(source, JSON.stringify(request));
  await assert.rejects(consumeVoice(observer), /Frozen voice task changed/);
  writeFileSync(source, bytes);
  const resultFile = path.join(workspace, "voice.json"),
    result = JSON.parse(readFileSync(resultFile, "utf8"));
  result.result.units[0].sourceTextHash = "a".repeat(64);
  writeFileSync(resultFile, JSON.stringify(result));
  await assert.rejects(consumeVoice(observer), /voice result changed/);
});
test("word times beyond actual media duration are refused by the owning transcription command", async (t) => {
  const { workspace, observer } = await setup(t, "recording-shorts");
  const raw = JSON.parse(readFileSync(path.join(workspace, "material/scribe.json"), "utf8"));
  raw.words[0].end = 1000;
  const file = path.join(workspace, "bad-raw.json");
  writeFileSync(file, JSON.stringify(raw));
  // Invoke the real owning CLI directly: its refusal must not depend on the evaluator's frozen-material guard.
  const child = spawnSync(
    process.execPath,
    [
      path.join(repo, "node_modules/tsx/dist/cli.mjs"),
      path.join(repo, "scripts/transcribe.ts"),
      "--input",
      "input.wav",
      "--from-raw",
      "bad-raw.json",
      "--output",
      "bad-transcript.json",
    ],
    {
      cwd: workspace,
      env: {
        AGENTBROS_NO_DOTENV: "1",
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        TMPDIR: process.env.TMPDIR,
        AGENTBROS_MEMORY_ROOT: process.env.AGENTBROS_MEMORY_ROOT,
      },
      encoding: "utf8",
      timeout: 30000,
    },
  );
  assert.equal(child.status, 1);
  const result = JSON.parse(child.stdout);
  assert.equal(result.error, "VALIDATION");
  assert.match(result.message, /actual source duration/);
});
