import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import os from "node:os";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { OperationStore } from "../src/lib/jobs/store";
import { executeElevenLabsRequest, inferAudioProject } from "../src/lib/jobs/elevenlabs-boundary";
import { generateVoiceoverV3 } from "../src/lib/elevenlabs/tts";
import { USER_GRANT } from "./helpers/ceiling-grant";
function setup(ceilingUsd = 1) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "audio-budget-"));
  const store = new OperationStore("fixture", { directory });
  store.configure(
    {
      ceilingUsd,
      maxJobUsd: ceilingUsd,
      repairReserveFraction: 0,
    },
    USER_GRANT,
  );
  return { directory, store };
}
test("audio reserves before any POST and missing unknown price cannot run", async () => {
  const { directory, store } = setup(0.01);
  let calls = 0;
  const perform = async () => {
    calls++;
    return new Response("audio");
  };
  try {
    await assert.rejects(
      executeElevenLabsRequest({
        endpoint: "fixture",
        model: "elevenlabs:tts-v2",
        identity: { text: "hello" },
        anchor: "fixture.mp3",
        units: 1,
        paid: { store },
        perform,
      }),
      /limit|ceiling|allocation/,
    );
    await assert.rejects(
      executeElevenLabsRequest({
        endpoint: "fixture",
        model: "elevenlabs:sfx",
        identity: { text: "whoosh" },
        anchor: "fixture.mp3",
        paid: { store },
        perform,
      }),
      /Unknown audio price/,
    );
    assert.equal(calls, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
test("TTS v3 library is journaled and repeated output saves replay one response", async () => {
  const { directory, store } = setup();
  const originalFetch = globalThis.fetch,
    originalKey = process.env.ELEVENLABS_API_KEY;
  let calls = 0;
  const source = path.join(directory, "fixture.wav");
  const generated = spawnSync("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:duration=0.2",
    source,
  ]);
  assert.equal(generated.status, 0);
  const audioBytes = readFileSync(source);
  globalThis.fetch = async () => {
    calls++;
    return new Response(audioBytes, {
      headers: { "xi-request-id": "speech-request" },
    });
  };
  process.env.ELEVENLABS_API_KEY = "fixture-never-sent";
  try {
    const outputPath = path.join(directory, "speech.mp3");
    const options = {
      text: "hello",
      voiceId: "fixture",
      outputPath,
      paid: { store },
    };
    await generateVoiceoverV3(options);
    await generateVoiceoverV3(options);
    assert.equal(calls, 1);
    assert.deepEqual(readFileSync(outputPath), audioBytes);
    assert.equal(Object.values(store.snapshot().jobs)[0].providerRequestId, "speech-request");
    assert.equal(Object.values(store.snapshot().jobs)[0].quote.model, "elevenlabs:tts-v3");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.ELEVENLABS_API_KEY;
    else process.env.ELEVENLABS_API_KEY = originalKey;
    rmSync(directory, { recursive: true, force: true });
  }
});
test("source bytes participate in operation identity; external paths cannot infer a project", () => {
  assert.equal(inferAudioProject("public/projects/fixture/voiceover/hook.mp3"), "fixture");
  assert.equal(inferAudioProject("public/projects/../external/hook.mp3"), undefined);
  assert.equal(inferAudioProject("/tmp/hook.mp3"), undefined);
});

test("invalid provider audio cannot overwrite an existing take or trigger another POST", async () => {
  const { directory, store } = setup();
  const originalFetch = globalThis.fetch,
    originalKey = process.env.ELEVENLABS_API_KEY;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response("not-audio");
  };
  process.env.ELEVENLABS_API_KEY = "fixture-never-sent";
  try {
    const outputPath = path.join(directory, "existing.mp3");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(outputPath, "original-take");
    const options = {
      text: "hello",
      voiceId: "fixture",
      outputPath,
      paid: { store },
    };
    await assert.rejects(generateVoiceoverV3(options), /inspect|audio/i);
    await assert.rejects(generateVoiceoverV3(options), /inspect|audio/i);
    assert.equal(calls, 1);
    assert.equal(readFileSync(outputPath, "utf8"), "original-take");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.ELEVENLABS_API_KEY;
    else process.env.ELEVENLABS_API_KEY = originalKey;
    rmSync(directory, { recursive: true, force: true });
  }
});
