import test from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { OperationStore } from "../src/lib/jobs/store";
import { COMMANDS } from "../src/mcp/catalog";
import { invokeCommand, prepareCommand } from "../src/mcp/bridge";
import { USER_GRANT } from "./helpers/ceiling-grant";

const codeRoot = path.resolve(import.meta.dirname, "..");
function fixture(t: test.TestContext) {
  const root = mkdtempSync(path.join(tmpdir(), "audio-mcp-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, "public/projects/demo"), { recursive: true });
  writeFileSync(path.join(root, "public/projects/demo/project.json"), "{}");
  return { root, codeRoot, projectScope: "demo", allowPaid: false, timeoutMs: 60_000 };
}
const tool = (name: string) => COMMANDS.find((command) => command.name === name)!;

test("MCP typed speech defaults to a no-write plan even when the caller requests execute", async (t) => {
  const options = fixture(t),
    request = "speech.json";
  writeFileSync(
    path.join(options.root, request),
    JSON.stringify({
      version: 1,
      task: "tts",
      projectId: "demo",
      output: "public/projects/demo/new.mp3",
      voiceId: "voice_A",
      model: "eleven_v3",
      language: "en",
      text: "Fixture",
    }),
  );
  const result = await invokeCommand(
    tool("generate_voiceover"),
    { project: "demo", request, "dry-run": false },
    options,
  );
  assert.equal(result.ok, true);
  assert.equal((result.metadata as Record<string, unknown>).state, "planned");
  assert.equal(existsSync(path.join(options.root, "public/projects/demo/pipeline")), false);
  for (const name of ["voices_manage", "generate_dialogue", "audio_transform", "dubbing"]) {
    const plan = prepareCommand(tool(name), { project: "demo", request, action: "execute", "dry-run": false }, options);
    assert.equal(plan.flags["dry-run"], true);
    assert.equal(plan.flags["scope-root"], realpathSync(options.root));
  }
});

test("nested transform/dubbing/conformance paths remain inside the trusted workspace", async (t) => {
  const options = fixture(t);
  for (const [name, request] of [
    [
      "audio_transform",
      {
        version: 1,
        task: "isolate",
        projectId: "demo",
        output: "public/projects/demo/new.mp3",
        source: "../outside.wav",
      },
    ],
    [
      "dubbing",
      {
        version: 1,
        task: "create",
        projectId: "demo",
        output: "public/projects/demo/new.wav",
        source: "../outside.wav",
        targetLanguage: "ru",
      },
    ],
    [
      "dubbing_conform",
      {
        version: 1,
        projectId: "demo",
        binding: "../outside.json",
        targetLanguage: "ru",
        clips: [{ sceneId: "intro", startSec: 0, endSec: 1, output: "public/projects/demo/intro.mp3" }],
      },
    ],
  ] as const) {
    writeFileSync(path.join(options.root, "request.json"), JSON.stringify(request));
    const result = await invokeCommand(tool(name), { project: "demo", request: "request.json" }, options);
    assert.equal(result.ok, false, name);
    assert.match(String(result.message), /outside|escapes/i);
  }
});

test("Earshot MCP refuses executable/recipe surfaces and installation remains CLI-only", (t) => {
  const options = fixture(t);
  assert.throws(() =>
    prepareCommand(tool("sfx_synth"), { project: "demo", engine: "earshot", recipe: "os.system" }, options),
  );
  assert.throws(() =>
    prepareCommand(tool("audio_review"), { project: "demo", input: "local.wav", executable: "/bin/sh" }, options),
  );
  assert.equal(
    COMMANDS.some((command) => command.name === "media_prepare"),
    false,
  );
  const plan = prepareCommand(
    tool("sfx_synth"),
    {
      project: "demo",
      engine: "earshot",
      "bank-id": "whoosh_fast/crisp",
      kind: "whoosh",
      align: "peak",
      seed: 19,
      output: "public/projects/demo/whoosh.wav",
    },
    options,
  );
  assert.equal(plan.flags.align, "peak");
});

test("actual CLI cwd keeps paid responses private and recovers missing takes without another mocked POST", (t) => {
  const options = fixture(t),
    project = path.join(options.root, "public/projects/demo");
  const store = new OperationStore("demo", { directory: path.join(project, "pipeline") });
  store.configure({ ceilingUsd: 2, maxJobUsd: 1, repairReserveFraction: 0 }, USER_GRANT);
  const tone = spawnSync("ffmpeg", [
    "-v",
    "error",
    "-nostdin",
    "-f",
    "lavfi",
    "-i",
    "sine=duration=1",
    "-f",
    "mp3",
    "pipe:1",
  ]);
  assert.equal(tone.status, 0);
  const text = "Fixture",
    response = {
      audio_base64: tone.stdout.toString("base64"),
      alignment: {
        characters: [...text],
        character_start_times_seconds: [...text].map((_, i) => i * 0.05),
        character_end_times_seconds: [...text].map((_, i) => (i + 1) * 0.05),
      },
    };
  const hook = path.join(options.root, "fake.cjs"),
    calls = path.join(options.root, "calls");
  writeFileSync(
    hook,
    `globalThis.fetch=async(url)=>{if(!String(url).startsWith('https://api.elevenlabs.io/'))throw Error('Network forbidden');require('node:fs').appendFileSync(${JSON.stringify(calls)},'x');return new Response(${JSON.stringify(JSON.stringify(response))},{headers:{'content-type':'application/json'}});};`,
  );
  writeFileSync(
    path.join(options.root, "request.json"),
    JSON.stringify({
      version: 1,
      task: "tts",
      projectId: "demo",
      output: "public/projects/demo/voice.mp3",
      text,
      voiceId: "voice_A",
      model: "eleven_v3",
      language: "en",
      maxCostUsd: 1,
    }),
  );
  const cli = (...flags: string[]) => {
    const child = spawnSync(
      process.execPath,
      [
        path.join(codeRoot, "node_modules/tsx/dist/cli.mjs"),
        path.join(codeRoot, "scripts/generate-voiceover.ts"),
        "--project",
        "demo",
        "--request",
        "request.json",
        ...flags,
      ],
      {
        cwd: options.root,
        env: {
          AGENTBROS_NO_DOTENV: "1",
          PATH: process.env.PATH,
          NODE_OPTIONS: `--require=${hook}`,
          ELEVENLABS_API_KEY: "FAKE_FIXTURE_ONLY",
        },
        encoding: "utf8",
        timeout: 60_000,
      },
    );
    assert.equal(child.status, 0, child.stderr + child.stdout);
    const result = JSON.parse(child.stdout);
    assert.equal(result.ok, true);
    return result;
  };
  cli("--dry-run=false");
  assert.equal(readFileSync(calls, "utf8"), "x");
  assert.ok(readdirSync(path.join(options.root, ".cache/paid-responses/demo")).some((file) => file.endsWith(".bin")));
  assert.equal(existsSync(path.join(project, "pipeline/private-responses")), false);
  const take = JSON.parse(readFileSync(path.join(project, "voice.mp3.take.json"), "utf8"));
  cli("--dry-run=false", "--operation-id", take.operationId, "--max-cost-usd", "0.000001");
  rmSync(path.join(project, "voice.mp3.take.json"));
  rmSync(path.join(project, "voice.words.json"));
  cli("--dry-run=false", "--max-cost-usd", "0.000001");
  assert.ok(existsSync(path.join(project, "voice.words.json")));
  rmSync(path.join(project, "voice.words.json"));
  cli("--dry-run=true");
  assert.equal(existsSync(path.join(project, "voice.words.json")), false);
  cli("--dry-run=false");
  assert.equal(readFileSync(calls, "utf8"), "x");
});

test("scene dry-run reports the pinned model and voice rather than legacy defaults", async (t) => {
  const options = fixture(t),
    pipeline = path.join(options.root, "public/projects/demo/pipeline");
  mkdirSync(pipeline);
  writeFileSync(
    path.join(pipeline, "script.json"),
    JSON.stringify({
      narratorVoice: "custom",
      voiceRef: { provider: "elevenlabs", voiceId: "voice_A", model: "eleven_v4", language: "en" },
      voiceoverEnabled: true,
      language: "en",
      beats: [{ id: "intro", kind: "hook", text: "Fixture", durationSec: 2 }],
    }),
  );
  const result = await invokeCommand(
    tool("generate_voiceover"),
    { project: "demo", "dry-run": true, "max-cost-usd": 1 },
    options,
  );
  assert.equal(result.ok, true, JSON.stringify(result));
  const metadata = result.metadata as Record<string, any>;
  assert.equal(metadata.model, "eleven_v4");
  assert.equal(metadata.voice, "voice_A");
  assert.equal(metadata.plans[0].request.model, "eleven_v4");
  assert.equal(existsSync(path.join(pipeline, "operations.json")), false);
});
