import { writeBudgetBrief } from "./helpers/ceiling-grant";
import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { buildFalMusicOperation, FAL_MUSIC_MODELS } from "../src/lib/providers/fal-music";
import { runFalMusic } from "../src/lib/music/fal-generate";
import { quote } from "../src/lib/pricing";
import { OperationStore } from "../src/lib/jobs/store";
import type { JobProvider } from "../src/lib/jobs/runner";

const noNetwork = (async () => {
  throw new Error("No network permitted");
}) as typeof fetch;

function project(t: test.TestContext) {
  const projectId = `fal-music-${randomUUID()}`;
  const directory = path.resolve("public/projects", projectId);
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, "project.json"), "{}");
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return { projectId, directory };
}

test("each endpoint builds its schema-pinned input and quotes from fal list prices", () => {
  const el = buildFalMusicOperation("fal-ai/elevenlabs/music", { prompt: "tech", durationSec: 16, instrumental: true });
  assert.deepEqual(el.input, {
    output_format: "mp3_44100_192",
    prompt: "tech",
    music_length_ms: 16000,
    force_instrumental: true,
  });
  assert.equal(quote({ model: el.model, units: el.units }).highUsd, 0.6);

  const plan = buildFalMusicOperation("fal-ai/elevenlabs/music", {
    compositionPlan: {
      sections: [
        { section_name: "Intro", duration_ms: 4000 },
        { section_name: "Drop", duration_ms: 12000 },
      ],
    },
  });
  const composition = plan.input.composition_plan as {
    positive_global_styles: unknown;
    negative_global_styles: unknown;
    sections: unknown[];
  };
  assert.deepEqual(
    [composition.positive_global_styles, composition.negative_global_styles, composition.sections.length],
    [[], [], 2],
  );
  assert.equal(plan.input.respect_sections_durations, true);
  assert.equal(plan.units, 1);

  const lyria = buildFalMusicOperation("fal-ai/lyria2", { prompt: "tech", seed: 3, negativePrompt: "vocals" });
  assert.deepEqual(lyria.input, { prompt: "tech", negative_prompt: "vocals", seed: 3 });
  assert.equal(lyria.container, "wav");
  assert.equal(quote({ model: lyria.model, units: lyria.units }).highUsd, 0.1);

  const minimax = buildFalMusicOperation("fal-ai/minimax-music/v2.6", {
    prompt: "modern tech launch",
    instrumental: true,
  });
  assert.equal(minimax.input.is_instrumental, true);
  assert.equal(quote({ model: minimax.model, units: minimax.units }).highUsd, 0.15);

  const music3 = buildFalMusicOperation("minimax/music-3", { prompt: "tech", instrumental: true, durationSec: 16 });
  assert.deepEqual(music3.input, { prompt: "tech", lyrics: "[instrumental]", duration: 16 });
  assert.equal(quote({ model: music3.model, units: music3.units }).highUsd, 0.032);

  const stable = buildFalMusicOperation("fal-ai/stable-audio-3/small/music/text-to-audio", {
    prompt: "tech",
    durationSec: 16,
  });
  assert.equal(stable.input.duration, 16);
  const stableQuote = quote({ model: stable.model, units: stable.units });
  assert.equal(stableQuote.highUsd, 0.0217);
  assert.match(stableQuote.source, /api\.fal\.ai\/v1\/models\/pricing/);
  assert.equal(stableQuote.asOf, "2026-11-11");
  assert.equal(Object.keys(FAL_MUSIC_MODELS).length, 5);
});

test("requests a model cannot honour are refused before any spend", () => {
  const cases: [string, Parameters<typeof buildFalMusicOperation>[1], RegExp][] = [
    ["fal-ai/unknown-music", { prompt: "x" }, /Unsupported fal music endpoint/],
    ["fal-ai/lyria2", { prompt: "x", durationSec: 16 }, /no duration input/],
    ["fal-ai/minimax-music/v2.6", { prompt: "short" }, /10–2000 characters/],
    ["fal-ai/minimax-music/v2.6", { prompt: "long enough prompt", seed: 1 }, /does not accept --seed/],
    ["minimax/music-3", { prompt: "x", durationSec: 16 }, /instrumental tracks only/],
    ["fal-ai/lyria2", { compositionPlan: { sections: [] } }, /does not accept a composition plan/],
    ["fal-ai/elevenlabs/music", { prompt: "x" }, /needs --duration/],
    [
      "fal-ai/elevenlabs/music",
      { compositionPlan: { sections: [{ section_name: "Short", duration_ms: 2000 }] } },
      /between 3000 and 120000/,
    ],
    ["fal-ai/stable-audio-3/small/music/text-to-audio", { prompt: "x", durationSec: 121 }, /1–120 seconds/],
    [
      "fal-ai/stable-audio-3/small/music/text-to-audio",
      { prompt: "x", compositionPlan: { sections: [] } },
      /exactly one/,
    ],
  ];
  for (const [endpoint, request, pattern] of cases)
    assert.throws(() => buildFalMusicOperation(endpoint, request), pattern, endpoint);
});

test("dry-run quotes offline and writes nothing", async (t) => {
  const { projectId, directory } = project(t);
  const output = path.join(directory, "music/take.mp3");
  const dry = await runFalMusic({
    endpoint: "fal-ai/stable-audio-3/small/music/text-to-audio",
    prompt: "tech",
    durationSec: 16,
    output,
    projectId,
    dryRun: true,
    fetch: noNetwork,
  });
  assert.equal(dry.metadata.dryRun, true);
  assert.equal((dry.metadata.quote as { highUsd: number }).highUsd, 0.0217);
  assert.deepEqual(readdirSync(directory), ["project.json"]);
});

test("a paid run saves the request, keeps the provider request ID and resumes without resubmitting", async (t) => {
  const { projectId, directory } = project(t);
  writeBudgetBrief(directory);
  const output = path.join(directory, "music/take.mp3");
  let submits = 0;
  const provider: JobProvider = {
    submit: async () => {
      submits++;
      return { requestId: "fal-request-1" };
    },
    inspect: async () => ({ state: "running" }),
  };
  const run = {
    endpoint: "fal-ai/minimax-music/v2.6",
    prompt: "modern tech launch",
    instrumental: true,
    output,
    projectId,
    assetId: "music-take",
    provider,
    fetch: noNetwork,
    pollMs: 1,
    timeoutMs: 0,
  };
  await assert.rejects(runFalMusic(run), /still running/);
  await assert.rejects(runFalMusic(run), /still running/);
  assert.equal(submits, 1);
  const jobs = Object.values(new OperationStore(projectId).snapshot().jobs);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0]!.providerRequestId, "fal-request-1");
  assert.equal(jobs[0]!.endpoint, "fal-ai/minimax-music/v2.6");
  assert.equal(jobs[0]!.quote.highUsd, 0.15);
  const requests = readdirSync(path.join(directory, "pipeline/model-requests"));
  assert.equal(requests.length, 1);
  const saved = JSON.parse(readFileSync(path.join(directory, "pipeline/model-requests", requests[0]!), "utf8"));
  assert.equal(saved.endpoint, "fal-ai/minimax-music/v2.6");
  assert.equal(saved.input.is_instrumental, true);
  assert.equal(existsSync(output), false);
});

test("an unknown price needs an explicit bound, and paid runs need a project", async (t) => {
  const { projectId, directory } = project(t);
  const output = path.join(directory, "music/take.mp3");
  await assert.rejects(
    runFalMusic({ endpoint: "fal-ai/lyria2", prompt: "tech", output, fetch: noNetwork }),
    /requires --project/,
  );
  const { PRICING } = await import("../src/lib/pricing");
  const original = PRICING["fal:lyria2"];
  PRICING["fal:lyria2"] = { ...original, disclosed: false, usdPerUnit: null };
  t.after(() => {
    PRICING["fal:lyria2"] = original;
  });
  await assert.rejects(
    runFalMusic({
      endpoint: "fal-ai/lyria2",
      prompt: "tech",
      output,
      projectId,
      fetch: noNetwork,
      provider: {
        submit: async () => {
          throw new Error("must not submit");
        },
        inspect: async () => ({ state: "running" }),
      },
    }),
    /explicit --max-cost-usd/,
  );
  const bounded = await runFalMusic({
    endpoint: "fal-ai/lyria2",
    prompt: "tech",
    output,
    projectId,
    maxCostUsd: 0.5,
    dryRun: true,
    fetch: noNetwork,
  });
  assert.equal((bounded.metadata.quote as { confidence: string }).confidence, "user-bound");
});
