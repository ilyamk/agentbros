import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { executeDubbing, assertDubbingSnapshot, syncDubbingBinding } from "../src/lib/elevenlabs/dubbing";
import { executeVoiceManagement } from "../src/lib/elevenlabs/voices";
import { DubbingRequestSchema } from "../src/types/elevenlabs";
import { OperationStore } from "../src/lib/jobs/store";
import { dubbingTranscript, dubbingTranslations } from "../src/lib/elevenlabs/dubbing-inputs";
import { hashFile } from "../src/lib/assets/registry";
import { encodeWav } from "../src/lib/audio/sfx-synth";
import { USER_GRANT } from "./helpers/ceiling-grant";

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
function setup(t: test.TestContext) {
  const root = mkdtempSync(path.join(tmpdir(), "el-dub-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, "public/projects/demo");
  mkdirSync(project, { recursive: true });
  writeFileSync(path.join(project, "project.json"), "{}");
  const samples = Float32Array.from({ length: 48000 }, (_, i) => Math.sin((i * 440 * 2 * Math.PI) / 48000) * 0.1),
    bytes = encodeWav(samples, 48000);
  const source = path.join(root, "source.wav");
  writeFileSync(source, bytes);
  const store = new OperationStore("demo", {
    directory: path.join(project, "pipeline"),
    responseCacheDirectory: path.join(root, ".cache/paid-responses"),
  });
  store.configure({ ceilingUsd: 10, maxJobUsd: 2, repairReserveFraction: 0 }, USER_GRANT);
  return { root, project, source, bytes, store };
}
test("dubbing prepays its first language once, refreshes failed downloads and rejects stale selected snapshots", async (t) => {
  const env = setup(t);
  let posts = 0,
    downloads = 0,
    sourceRevision = 0,
    revision = 1,
    status = "completed";
  const transport = (async (url, init) => {
    const route = String(url);
    if (init?.method === "POST" && route.endsWith("/transcript/regenerate")) {
      posts++;
      assert.equal(init.body, undefined);
      status = "processing";
      return json({ regenerated_segment_ids: ["segment"] });
    }
    if (init?.method === "POST") {
      posts++;
      assert.equal(route, "https://api.elevenlabs.io/v1/dubbing/project");
      assert.ok(init.body instanceof FormData);
      assert.equal(init.body.get("target_language"), "ru");
      return json({ project_id: "remote_project", status: "queued", revision: 0 });
    }
    if (route.includes("storage.googleapis.com")) {
      downloads++;
      return downloads === 1 ? json({}, 403) : new Response(new Uint8Array(env.bytes));
    }
    const target = {
      language_id: "target_ru",
      project_id: "remote_project",
      target_language: "ru",
      status,
      revision,
      output_revision: revision,
      outputs: { lossless_audio: `https://storage.googleapis.com/fixture/dub-${downloads}.wav` },
    };
    if (route.includes("/language?")) return json({ languages: [target] });
    if (route.endsWith("/language/target_ru")) return json(target);
    return json({ project_id: "remote_project", status: "ready", revision: sourceRevision });
  }) as typeof fetch;
  const request = {
    version: 1,
    task: "create",
    projectId: "demo",
    source: env.source,
    output: "public/projects/demo/ru.wav",
    sourceLanguage: "en",
    targetLanguage: "ru",
    maxCostUsd: 1,
  };
  const options = { rootDir: env.root, store: env.store, fetch: transport, apiKey: "FAKE", dryRun: false };
  const planned = await executeDubbing(request, { ...options, dryRun: true });
  assert.equal(planned.metadata.state, "planned");
  assert.equal(posts, 0);
  const failed = await executeDubbing(request, options);
  assert.equal(failed.metadata.state, "failed");
  assert.equal(posts, 1);
  const result = await executeDubbing(request, options);
  assert.equal(result.metadata.state, "published");
  assert.equal(posts, 1);
  assert.equal(downloads, 2);
  assert.equal(Object.keys(env.store.snapshot().jobs).length, 1, "there is no second first-language reservation");
  const binding = path.join(env.project, "ru.wav.dubbing.json");
  assert.equal(assertDubbingSnapshot(env.root, binding, "ru").selectedRevision, 1);
  const saved = JSON.parse(readFileSync(binding, "utf8"));
  delete saved.targets.ru.sha256;
  delete saved.targets.ru.selectedRevision;
  delete saved.targets.ru.selectedSourceRevision;
  saved.targets.ru.status = "planned";
  writeFileSync(binding, JSON.stringify(saved));
  await executeDubbing({ ...request, operationId: saved.operationId, maxCostUsd: 2 }, options);
  assert.equal(posts, 1);
  assert.equal(assertDubbingSnapshot(env.root, binding, "ru").selectedRevision, 1);
  revision = 2;
  await syncDubbingBinding(binding, options);
  await assert.rejects(async () => assertDubbingSnapshot(env.root, binding, "ru"), /stale/);
  sourceRevision = 1;
  await syncDubbingBinding(binding, options);
  assert.throws(() => assertDubbingSnapshot(env.root, binding, "ru"), /stale/);
  await executeDubbing(request, options);
  assert.throws(() => assertDubbingSnapshot(env.root, binding, "ru"), /stale/);
  status = "stale";
  const regenerate = {
    version: 1,
    task: "regenerate",
    projectId: "demo",
    output: "public/projects/demo/ru-v2.wav",
    binding,
    targetLanguage: "ru",
    enterprise: true,
    expectedRevision: 2,
    maxCostUsd: 1,
  };
  const pending = await executeDubbing(regenerate, options);
  assert.equal(pending.metadata.state, "running");
  assert.equal(posts, 2);
  status = "completed";
  await executeDubbing({ ...regenerate, operationId: pending.metadata.operationId }, options);
  assert.equal(posts, 2);
  assert.equal(assertDubbingSnapshot(env.root, binding, "ru").selectedRevision, 2);
  await executeDubbing(regenerate, options);
  assert.equal(assertDubbingSnapshot(env.root, binding, "ru").status, "completed");
  assert.equal(posts, 2);
});

test("ambiguous dubbing create cannot send a replacement POST", async (t) => {
  const env = setup(t);
  let calls = 0;
  const request = {
    version: 1,
    task: "create",
    projectId: "demo",
    source: env.source,
    output: "public/projects/demo/unknown.wav",
    targetLanguage: "ru",
    maxCostUsd: 1,
  };
  const options = {
    rootDir: env.root,
    store: env.store,
    dryRun: false,
    apiKey: "FAKE",
    fetch: (async () => {
      calls++;
      throw Error("Lost response after submit");
    }) as typeof fetch,
  };
  assert.equal((await executeDubbing(request, options)).metadata.state, "unknown");
  assert.equal((await executeDubbing(request, options)).metadata.state, "unknown");
  assert.equal(calls, 1);
});

test("a binding changed during planning cannot mutate a stale remote language", async (t) => {
  const env = setup(t),
    bindingFile = path.join(env.project, "binding.json");
  const binding = {
    version: 1,
    projectId: "demo",
    operationId: "create-fixture",
    inputHash: "fixture",
    remoteProjectId: "remote",
    source: { file: "source.wav", sha256: hashFile(env.source), durationSec: 1 },
    prepaidLanguage: "ru",
    sourceRevision: 0,
    targets: {
      ru: {
        languageId: "old-language",
        operationId: "create-fixture",
        output: "old.wav",
        revision: 1,
        status: "stale",
      },
    },
    liveVerified: false,
  };
  writeFileSync(bindingFile, JSON.stringify(binding));
  const snapshot = env.store.snapshot.bind(env.store);
  let reads = 0,
    requests = 0;
  t.mock.method(env.store, "snapshot", () => {
    if (++reads === 1) {
      binding.targets.ru.languageId = "new-language";
      writeFileSync(bindingFile, JSON.stringify(binding));
    }
    return snapshot();
  });
  await assert.rejects(
    executeDubbing(
      {
        version: 1,
        task: "regenerate",
        projectId: "demo",
        output: "public/projects/demo/new.wav",
        binding: bindingFile,
        targetLanguage: "ru",
        expectedRevision: 1,
        enterprise: true,
        maxCostUsd: 1,
      },
      {
        rootDir: env.root,
        store: env.store,
        dryRun: false,
        apiKey: "FAKE",
        fetch: async () => {
          requests++;
          throw Error("Network forbidden");
        },
      },
    ),
    /binding changed during planning/,
  );
  assert.equal(requests, 0);
  assert.deepEqual(snapshot().jobs, {});
});

test("concurrent dubbing creation has one binding owner", async (t) => {
  const env = setup(t);
  let posts = 0;
  let unblock!: () => void;
  const gate = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  const options = {
    rootDir: env.root,
    store: env.store,
    dryRun: false,
    apiKey: "FAKE",
    fetch: (async (_url, init) => {
      if (init?.method === "POST") {
        posts++;
        await gate;
        return json({ project_id: "p" });
      }
      return json({ status: "queued", revision: 0 });
    }) as typeof fetch,
  };
  const request = {
    version: 1,
    task: "create",
    projectId: "demo",
    source: env.source,
    output: "public/projects/demo/concurrent.wav",
    targetLanguage: "en",
    maxCostUsd: 1,
  };
  const first = executeDubbing(request, options);
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(executeDubbing(request, options), /live owner/);
  unblock();
  await first;
  assert.equal(posts, 1);
});

test("PVC training polls its requested model and does not publish a metadata-only voice", async (t) => {
  const env = setup(t);
  let posts = 0,
    ready = false;
  const request = {
    version: 1,
    task: "train",
    projectId: "demo",
    voiceId: "voice",
    model: "eleven_multilingual_v2",
    rights: { source: "Synthetic test fixture", consent: "Not human approval; fixture only" },
    output: "public/projects/demo/trained.json",
    maxCostUsd: 1,
  };
  const options = {
    rootDir: env.root,
    store: env.store,
    dryRun: false,
    apiKey: "FAKE",
    fetch: (async (_url, init) => {
      if (init?.method === "POST") {
        posts++;
        return json({ status: "ok" });
      }
      return json({
        voice_id: "voice",
        fine_tuning: { state: { eleven_multilingual_v2: ready ? "fine_tuned" : "queued" } },
        voice_verification: { requires_verification: false },
      });
    }) as typeof fetch,
  };
  assert.equal((await executeVoiceManagement(request, options)).metadata.state, "running");
  ready = true;
  assert.equal((await executeVoiceManagement(request, options)).metadata.state, "published");
  assert.equal(posts, 1);
  assert.equal(JSON.parse(readFileSync(path.join(env.project, "trained.json"), "utf8")).readiness, "ready");
});

test("Enterprise edits and regeneration require explicit entitlement and expected revisions", () => {
  const common = {
    version: 1,
    projectId: "demo",
    output: "public/projects/demo/ru.wav",
    binding: "binding.json",
    targetLanguage: "ru",
  };
  assert.equal(DubbingRequestSchema.safeParse({ ...common, task: "regenerate", expectedRevision: 1 }).success, false);
  assert.equal(
    DubbingRequestSchema.safeParse({
      ...common,
      task: "edit-translation",
      enterprise: true,
      segmentId: "s",
      text: "Привет",
    }).success,
    false,
  );
});

test("supplied dubbing segments reject ambiguous clocks, overlap and incomplete translation coverage", () => {
  const source = { sha256: "a".repeat(64), durationSec: 4 };
  const row = { text: "Hi", start_s: 0, end_s: 1, external_id: "s1" };
  assert.equal(dubbingTranscript({ segments: [row] }, source).segments.length, 1);
  assert.throws(
    () => dubbingTranscript({ segments: [row, { ...row, start_s: 0.5, external_id: "s2" }] }, source),
    /overlaps/,
  );
  assert.throws(() => dubbingTranscript({ segments: [{ ...row, end_s: 5 }] }, source), /timing/);
  assert.throws(
    () =>
      dubbingTranscript(
        {
          segments: [
            { ...row, translation: "Привет" },
            { ...row, start_s: 2, end_s: 3, external_id: "s2" },
          ],
        },
        source,
      ),
    /every/,
  );
  assert.deepEqual(dubbingTranslations({ s1: "Привет" }, [{ external_id: "s1" }]), { s1: "Привет" });
  assert.throws(() => dubbingTranslations({ s1: "Привет", unknown: "Да" }, [{ external_id: "s1" }]), /exactly/);
  const canonical = {
    version: 1,
    source: { file: "recording.wav", sha256: source.sha256, durationSec: 4 },
    engine: { provider: "local", model: "fixture", verbatim: false, diarized: false, timing: "estimated" },
    language: "en",
    speakers: [],
    words: [],
    sentences: [{ id: "s1", firstWordId: "w1", lastWordId: "w1", text: "Hi", startSec: 0, endSec: 1, speaker: null }],
  };
  assert.equal(dubbingTranscript(canonical, source).segments[0]!.external_id, "s1");
  assert.throws(() => dubbingTranscript(canonical, { ...source, sha256: "b".repeat(64) }), /bound/);
});

test("a cached source edit replays without rechecking or rolling back a newer observed revision", async (t) => {
  const env = setup(t),
    binding = path.join(env.project, "edit.dubbing.json");
  const state = {
    version: 1,
    projectId: "demo",
    operationId: "create-fixture",
    inputHash: "fixture",
    remoteProjectId: "remote",
    source: { file: "source.wav", sha256: hashFile(env.source), durationSec: 1 },
    prepaidLanguage: "ru",
    sourceRevision: 1,
    targets: {
      ru: {
        languageId: "ru",
        operationId: "create-fixture",
        output: "public/projects/demo/ru.wav",
        revision: 1,
        outputRevision: 1,
        status: "completed",
      },
    },
    liveVerified: false,
  };
  writeFileSync(binding, JSON.stringify(state));
  let patches = 0,
    reads = 0;
  const options = {
    rootDir: env.root,
    store: env.store,
    dryRun: false,
    apiKey: "FAKE",
    fetch: (async (_url, init) => {
      if (init?.method === "PATCH") {
        patches++;
        return json({ revision: 2 });
      }
      reads++;
      return json({ revision: 1 });
    }) as typeof fetch,
  };
  const request = {
    version: 1,
    task: "edit-source",
    projectId: "demo",
    output: "public/projects/demo/edited.wav",
    binding,
    targetLanguage: "ru",
    segmentId: "segment_A",
    text: "Corrected source",
    expectedRevision: 1,
    enterprise: true,
    maxCostUsd: 1,
  };
  const result = await executeDubbing(request, options);
  assert.equal(result.metadata.state, "edited");
  const edited = JSON.parse(readFileSync(binding, "utf8"));
  edited.sourceRevision = 3;
  writeFileSync(binding, JSON.stringify(edited));
  await executeDubbing({ ...request, operationId: result.metadata.operationId, maxCostUsd: 0.000001 }, options);
  assert.equal(patches, 1);
  assert.equal(reads, 1);
  assert.equal(JSON.parse(readFileSync(binding, "utf8")).sourceRevision, 3);
});
