import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  LocalResultReceiptSchema,
  LocalTextRequestSchema,
  type NativeProbe,
  type LocalTaskRequest,
} from "../../types/local-capabilities";
import {
  AppleAssistanceResultSchema,
  AppleAudioResultSchema,
  AppleTranslationResultSchema,
  AppleVisionResultSchema,
} from "../../types/apple-results";
import { AssetRegistrySchema } from "../../types/assets";
import { ShortsPreparedSchema } from "../../types/shorts";
import { inspectCapabilities, resolveLocalTask, writeLocalPolicy } from "../local-capabilities";
import { localSuggestions } from "../local-capabilities/suggestions";
import { publishResult } from "../apple/tasks";
import { assertImportedLocalAssets } from "../apple/provenance";
import { fileHash, NativeUnavailable, objectHash } from "../apple/runtime";
import { inspectAsset } from "../assets/inspect";
import { runHarness } from "./run";
import { buildCaptionPages, wordsFromTranscript } from "../captions/pages";
import { frameCrop } from "../photo/crop";
import { OperationStore, BudgetError } from "../budget";
import { contained, digest, fail } from "./io";
import { observedHandoff, sameIds, transcriptForSource, voiceResultForRequest } from "./workflow-assertions";
import type { WorkflowObserver } from "./workflow-observer";
import { CAMPAIGN_WORKFLOW_SCENARIOS, contractCampaign } from "./workflow-campaign";

export function fixtureJson(observer: WorkflowObserver, name: string, value: unknown): void {
  const file = contained(observer.workspace, name);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
}
export function expectRefusal(fn: () => unknown, pattern: RegExp): void {
  try {
    fn();
  } catch (error) {
    if (error instanceof Error && pattern.test(error.message)) return;
    throw error;
  }
  fail("Required refusal did not occur");
}
export const FIXTURE_PROBE: NativeProbe = {
  operations: [
    "speech.transcribe",
    "speech.synthesise",
    "text.analyse",
    "text.translate",
    "text.assist",
    "vision.faces",
    "vision.saliency",
    "audio.events",
  ],
  languages: ["en-US", "es-ES"],
  installedLanguages: ["en-US"],
  voices: [{ id: "fixture-voice", name: "Fixture", language: "en-US" }],
  details: { schemes: { en: ["Lemma", "NameType"] } },
};
export const fixtureProbe = async () => ({
  probe: FIXTURE_PROBE,
  identity: digest("explicitly simulated runtime; not an installed Apple model"),
});

export async function stageWorkflowMaterial(observer: WorkflowObserver) {
  await observer.operation(
    "fixture:material",
    [],
    [
      "input.wav",
      "public/projects/workflow-e2e/project.json",
      ...observer.scenario.material.map((p) => "material/" + path.basename(p.path)),
    ],
    () => {
      for (const pin of observer.scenario.material) {
        const name = "material/" + path.basename(pin.path),
          target = contained(observer.workspace, name);
        mkdirSync(path.dirname(target), { recursive: true });
        copyFileSync(contained(observer.codeRoot, pin.path), target);
        if (observer.pin(name).sha256 !== pin.sha256) fail("Material changed while staging");
      }
      fixtureJson(observer, "public/projects/workflow-e2e/project.json", {});
      const file = path.join(observer.workspace, "input.wav");
      const result = spawnSync(
        "ffmpeg",
        ["-v", "error", "-nostdin", "-f", "lavfi", "-i", "sine=frequency=440:duration=3", "-c:a", "pcm_s16le", file],
        { encoding: "utf8", timeout: 15000 },
      );
      if (result.status !== 0) fail("Synthetic fixture preparation needs FFmpeg");
    },
    { kind: "preparation", authority: "fixture" },
  );
}

export async function consumeRecording(
  observer: WorkflowObserver,
  source = "input.wav",
  requireAgentConsumer = false,
  observedChildren: readonly string[] = [],
) {
  const consumers = observer.events.filter(
    (e) => e.passed && e.command === "shorts:prepare" && (!observer.scenario.requiresLeaf || e.actor === "root"),
  );
  const candidates = observer.events
    .filter((e) => e.passed && ["transcribe", "speech:local"].includes(e.command))
    .reverse();
  let producer: (typeof candidates)[number] | undefined,
    transcriptPin: (typeof candidates)[number]["outputs"][number] | undefined;
  for (const event of candidates) {
    const pin = event.outputs.find((pin) => {
      if (
        requireAgentConsumer &&
        !consumers.some((c) => {
          if (!c.inputs.some((p) => p.path === pin.path && p.sha256 === pin.sha256)) return false;
          try {
            return observedHandoff(observer.events, c, pin.path).id === event.id;
          } catch {
            return false;
          }
        })
      )
        return false;
      try {
        const raw = JSON.parse(observer.read(pin.path).toString()) as { engine?: unknown; words?: unknown };
        return observer.pin(pin.path).sha256 === pin.sha256 && !!raw.engine && Array.isArray(raw.words);
      } catch {
        return false;
      }
    });
    if (pin) {
      producer = event;
      transcriptPin = pin;
      break;
    }
  }
  if (!producer || !transcriptPin)
    fail("No observed transcript producer-to-consumer edge; evaluator replay cannot complete the agent task");
  if (
    observer.scenario.requiresLeaf &&
    (producer.actor === "root" ||
      observer.actors.get(producer.actor) !== "root" ||
      (requireAgentConsumer && !observedChildren.includes(producer.actor)))
  )
    fail("The consumed transcript was not produced by an independently observed leaf");
  const file = transcriptPin.path,
    sourcePin = observer.pin(source);
  const original = observer.events
    .find((e) => e.kind === "preparation" && e.command === "fixture:material")
    ?.outputs.find((p) => p.path === sourcePin.path);
  if (original && original.sha256 !== sourcePin.sha256) fail("Task source media changed after preparation");
  const result = await observer.operation("@captions/pages", [file, source], ["caption-pages.json"], () => {
    const duration = inspectAsset(path.resolve(observer.workspace, source)).media.durationSec;
    if (!duration) fail("Recording duration is unavailable");
    const transcript = transcriptForSource(JSON.parse(observer.read(file).toString()), sourcePin.sha256, duration);
    if (transcript.source.durationSec === null || Math.abs(transcript.source.durationSec - duration) > 0.05)
      fail("Transcript duration differs from actual source media");
    const words = wordsFromTranscript(transcript),
      pages = buildCaptionPages(words);
    if (!pages.length || pages.flatMap((p) => p.words).length !== words.length)
      fail("Caption consumer lost transcript words");
    fixtureJson(observer, "caption-pages.json", {
      version: 1,
      source: observer.pin(file),
      sourceWordIds: transcript.words.filter((w) => w.kind !== "event" && w.endSec > w.startSec).map((w) => w.id),
      timing: transcript.engine.timing,
      pages,
    });
    return transcript;
  });
  observedHandoff(observer.events, result.event, file);
  const shorts = observer.events.filter(
    (e) =>
      e.passed &&
      e.command === "shorts:prepare" &&
      e.inputs.some((p) => p.path === file && p.sha256 === transcriptPin.sha256),
  );
  for (const event of shorts) {
    observedHandoff(observer.events, event, file);
    const prepared = event.outputs.find((p) => p.path.endsWith("/prepared.json"));
    if (!prepared) fail("Shorts consumer did not publish its preparation contract");
    const raw = ShortsPreparedSchema.parse(JSON.parse(observer.read(prepared.path).toString()));
    if (raw.transcript.sha256 !== transcriptPin.sha256 || raw.transcript.sourceSha256 !== sourcePin.sha256)
      fail("Shorts consumer lost transcript/source ownership");
    if (
      observer.pin(path.posix.join(path.posix.dirname(prepared.path), raw.transcript.file)).sha256 !==
      transcriptPin.sha256
    )
      fail("Shorts consumer copied different transcript bytes");
  }
  return "handoff";
}

export async function consumeVoice(observer: WorkflowObserver) {
  const event = observer.events.filter((e) => e.passed && e.command === "asset:import").at(-1);
  if (!event) fail("No observed voice import consumer");
  const audio = event.inputs.find((p) => /\.(?:mp3|wav|aiff)$/u.test(p.path));
  if (!audio) fail("Voice import did not read an observed audio input");
  const producer = observedHandoff(observer.events, event, audio.path);
  const registryPin = event.outputs.find((p) => p.path.endsWith("/asset-registry.json"));
  if (!registryPin) fail("Voice import did not publish its asset registry");
  const result = await observer.operation("@delivery/local-draft-boundary", [registryPin.path], [], () => {
    const registry = AssetRegistrySchema.parse(JSON.parse(observer.read(registryPin.path).toString()));
    const asset = registry.assets.find((a) => a.hash === audio.sha256);
    if (!asset?.localResult || asset.localResult.receipt.purpose !== "draft")
      fail("Import lost native draft provenance");
    const receiptHash = asset.localResult.receiptHash;
    if (!producer.outputs.some((pin) => pin.path.endsWith("receipt.json") && pin.sha256 === receiptHash))
      fail("Imported receipt differs from the observed native producer");
    const expectedPin = observer.events
      .find((e) => e.command === "fixture:material")
      ?.outputs.find((p) => p.path === "material/voice.json");
    if (!expectedPin || observer.pin(expectedPin.path).sha256 !== expectedPin.sha256) fail("Frozen voice task changed");
    const expected = LocalTextRequestSchema.parse(JSON.parse(observer.read(expectedPin.path).toString()));
    for (const pin of asset.localResult.receipt.inputs)
      if (observer.pin(pin.file).sha256 !== pin.sha256) fail("Voice source changed before handoff");
    const source = asset.localResult.receipt.inputs[0];
    if (!source) fail("Voice receipt has no input");
    const actual = LocalTextRequestSchema.parse(JSON.parse(observer.read(observer.pin(source.file).path).toString()));
    if (objectHash(actual) !== objectHash(expected)) fail("Voice request differs from the requested script units");
    const resultFile = producer.outputs.find((pin) => {
      try {
        return (
          JSON.parse(observer.read(pin.path).toString()).task === "speech.synthesise" &&
          Array.isArray(JSON.parse(observer.read(pin.path).toString()).result?.units)
        );
      } catch {
        return false;
      }
    });
    if (!resultFile) fail("Observed voice result is absent");
    if (observer.pin(resultFile.path).sha256 !== resultFile.sha256)
      fail("Observed voice result changed before consumption");
    const result = JSON.parse(observer.read(resultFile.path).toString()) as { result: unknown };
    voiceResultForRequest(result.result, expected);
    const file = path.join(observer.workspace, "public", asset.files.original);
    if (fileHash(file) !== audio.sha256 || asset.localResult.sourceOutputHash !== audio.sha256)
      fail("Imported voice differs from observed output");
    expectRefusal(
      () => assertImportedLocalAssets([file], path.join(observer.workspace, registryPin.path), observer.workspace),
      /draft/iu,
    );
  });
  observedHandoff(observer.events, result.event, registryPin.path);
  return "draft-refused";
}

async function fixtureVoice(observer: WorkflowObserver, importVoice = true) {
  const output = "voice.json",
    audio = output + ".assets/fixture/voice.wav";
  await observer.operation(
    "fixture:system-voice",
    ["material/voice.json", "input.wav"],
    [output, audio, output + ".receipt.json", path.posix.dirname(audio) + "/receipt.json"],
    () => {
      const request = LocalTextRequestSchema.parse(JSON.parse(observer.read("material/voice.json").toString()));
      const fullAudio = path.join(observer.workspace, audio),
        fullOutput = path.join(observer.workspace, output);
      mkdirSync(path.dirname(fullAudio), { recursive: true });
      copyFileSync(path.join(observer.workspace, "input.wav"), fullAudio);
      const artifact = {
        version: 1,
        task: "speech.synthesise",
        operationId: digest("fixture"),
        purpose: "draft",
        source: {
          file: path.join(observer.workspace, "material/voice.json"),
          sha256: observer.pin("material/voice.json").sha256,
        },
        result: {
          language: request.sourceLanguage,
          units: request.units.map((u) => ({ id: u.id, file: fullAudio, sourceTextHash: digest(u.text) })),
          reviewRequired: true,
        },
      };
      const bytes = JSON.stringify(artifact) + "\n";
      const receipt = LocalResultReceiptSchema.parse({
        version: 1,
        task: "speech.synthesise",
        backend: "fixture-tts",
        operationId: digest("fixture"),
        createdAt: new Date().toISOString(),
        identity: digest("fixture identity"),
        systemModelsHashPinned: false,
        requestHash: objectHash(request),
        inputs: [{ file: artifact.source.file, sha256: artifact.source.sha256 }],
        outputs: [
          { file: fullOutput, sha256: digest(bytes) },
          { file: fullAudio, sha256: fileHash(fullAudio) },
        ],
        purpose: "draft",
        checks: ["fixture-only"],
        warnings: ["Synthetic tone, not speech or installed-model acceptance."],
      });
      writeFileSync(path.join(path.dirname(fullAudio), "receipt.json"), JSON.stringify(receipt) + "\n", { flag: "wx" });
      publishResult(fullOutput, bytes, fullOutput + ".receipt.json", receipt);
    },
    { authority: "fixture", kind: "command" },
  );
  if (!importVoice) return audio;
  const imported = await observer.execute("asset:import", ["--project", "workflow-e2e", "--input", audio]);
  if (!imported.event.passed) fail("Fixture voice import failed");
  return consumeVoice(observer);
}

export async function contractWorkflow(observer: WorkflowObserver): Promise<string> {
  if (CAMPAIGN_WORKFLOW_SCENARIOS.includes(observer.scenario.id)) return contractCampaign(observer);
  const root = path.join(observer.workspace, ".cache/models");
  const options = { root, platform: "darwin" as const, probe: fixtureProbe };
  const id = observer.scenario.id;
  if (["recording-shorts", "leaf-handoff"].includes(id)) {
    const actor = id === "leaf-handoff" ? "leaf-1" : "root";
    if (actor !== "root") {
      observer.actors.set(actor, "root");
      observer.record({
        actor: "root",
        kind: "delegation",
        authority: "fixture",
        command: "fixture:leaf",
        argv: [],
        startedAt: new Date().toISOString(),
        elapsedMs: 0,
        exitCode: 0,
        inputs: [],
        outputs: [],
        passed: true,
        detail: "Explicit fixture actor; no real model delegation claimed.",
      });
    }
    const result = await observer.execute(
      "transcribe",
      ["--input", "input.wav", "--from-raw", "material/scribe.json", "--output", "transcript.json", "--language", "en"],
      { actor },
    );
    if (!result.event.passed) fail("Transcript reconstruction failed");
    const consumer = await observer.execute("shorts:prepare", [
      "--transcript",
      "transcript.json",
      "--output-dir",
      "shorts",
      "--min-sec",
      "1",
      "--max-sec",
      "3",
      "--hard-max-sec",
      "4",
    ]);
    if (!consumer.event.passed) fail("Shorts preparation failed");
    return consumeRecording(observer);
  }
  if (id === "voice-draft") return fixtureVoice(observer);
  if (id === "unsupported-language") {
    await observer.operation(
      "@capabilities/unsupported-language",
      [],
      [],
      async () => {
        const result = await resolveLocalTask({ task: "speech.transcribe", language: "ru" }, options);
        if (result.ready.length || result.preparation || !result.alternative)
          fail("Unsupported language was advertised or prepared");
      },
      { kind: "discovery", authority: "fixture" },
    );
    return "alternative";
  }
  if (id === "preparation-policy") {
    await observer.operation(
      "@capabilities/download-policy",
      [],
      [],
      async () => {
        for (const downloads of ["task", "ask", "never"] as const) {
          writeLocalPolicy({ version: 1, mode: "autonomous", downloads }, root);
          const result = await resolveLocalTask({ task: "speech.transcribe", language: "es" }, options);
          if (
            result.ready.length ||
            (downloads === "task" && !result.preparation) ||
            (downloads !== "task" && (result.preparation || !result.userAction))
          )
            fail("Download authority was lost");
        }
      },
      { kind: "validation", authority: "fixture" },
    );
    return "alternative";
  }
  if (id === "disabled-resource") {
    await observer.operation(
      "@capabilities/user-setting",
      [],
      [],
      async () => {
        const result = await resolveLocalTask(
          { task: "text.assist", language: "en" },
          {
            ...options,
            probe: async () => {
              throw new NativeUnavailable({
                state: "needs_user_action",
                code: "DISABLED",
                message: "Setting disabled",
                userAction: "Enable Apple Intelligence in Settings",
              });
            },
          },
        );
        if (result.ready.length || !result.userAction || result.preparation)
          fail("User-only setting was converted to executable preparation");
      },
      { kind: "validation", authority: "fixture" },
    );
    return "user-action";
  }
  if (id === "missing-language") {
    const result = await observer.operation(
      "@next/missing-language",
      [],
      [],
      async () => {
        const hints = await localSuggestions(
          "workflow-e2e",
          { next: { summary: { currentStage: "localisation" } } },
          observer.workspace,
          options,
        );
        if (
          !hints.localTools?.requirements?.includes("language") ||
          !hints.localTools.requirements.includes("targetLanguage") ||
          hints.localTools.ready.length
        )
          fail("Missing task parameters produced executable hints");
      },
      { kind: "discovery", authority: "fixture" },
    );
    if (!result.event.passed) fail("Discovery validation failed");
    return "user-action";
  }
  if (id === "bounded-recovery") {
    const result = await observer.operation(
      "fixture:producer",
      [],
      ["recovery.json"],
      () => fixtureJson(observer, "recovery.json", { id: "source-1", value: 1 }),
      { kind: "command", authority: "fixture" },
    );
    await observer.operation(
      "@handoff/corruption-refusal",
      ["recovery.json"],
      [],
      () => {
        const counterfeit = {
          ...result.event,
          id: "counterfeit",
          kind: "consumption" as const,
          inputs: [{ ...observer.pin("recovery.json"), sha256: digest("changed") }],
        };
        expectRefusal(() => observedHandoff([result.event, counterfeit], counterfeit, "recovery.json"), /producer/iu);
      },
      { authority: "fixture", kind: "validation" },
    );
    const source = await observer.execute("transcribe", [
      "--input",
      "input.wav",
      "--from-raw",
      "material/scribe.json",
      "--output",
      "retry-transcript.json",
      "--language",
      "en",
    ]);
    if (!source.event.passed) fail("Initial retry fixture failed");
    const original = observer.pin("retry-transcript.json");
    const retry = await observer.execute("transcribe", [
      "--input",
      "input.wav",
      "--from-raw",
      "material/scribe.json",
      "--output",
      "retry-transcript.json",
      "--language",
      "en",
    ]);
    if (retry.event.passed || observer.pin(original.path).sha256 !== original.sha256)
      fail("Retry overwrote a valid take");
    const audio = await fixtureVoice(observer, false),
      receiptFile = path.posix.dirname(audio) + "/receipt.json";
    const receiptBytes = observer.read(receiptFile),
      receipt = LocalResultReceiptSchema.parse(JSON.parse(receiptBytes.toString()));
    receipt.outputs = receipt.outputs.map((pin) =>
      pin.file.endsWith(".wav") ? { ...pin, sha256: digest("corrupted receipt") } : pin,
    );
    writeFileSync(path.join(observer.workspace, receiptFile), JSON.stringify(receipt) + "\n");
    const corrupt = await observer.execute("asset:import", ["--project", "workflow-e2e", "--input", audio], {
      inputs: [receiptFile],
    });
    if (
      corrupt.event.passed ||
      existsSync(path.join(observer.workspace, "public/projects/workflow-e2e/pipeline/asset-registry.json"))
    )
      fail("Corrupt receipt was imported or published");
    writeFileSync(path.join(observer.workspace, receiptFile), receiptBytes);
    const recovered = await observer.execute("asset:import", ["--project", "workflow-e2e", "--input", audio], {
      inputs: [receiptFile],
    });
    if (!recovered.event.passed) fail("Recovery after restoring the original receipt failed");
    await consumeVoice(observer);
    await observer.operation(
      "@harness/timeout-and-drain",
      [],
      [],
      async () => {
        const script = path.join(observer.workspace, "slow-fixture.cjs");
        writeFileSync(script, "setInterval(()=>{},10000);", { flag: "wx" });
        const result = await runHarness(
          process.execPath,
          [script],
          observer.workspace,
          "",
          { wallTimeSec: 1, tokens: 100, maxFileBytes: 4096, maxBundleBytes: 4096, maxTranscriptBytes: 4096 },
          "codex",
          false,
          { OPENAI_API_KEY: undefined, ANTHROPIC_API_KEY: undefined },
          observer.signal,
        );
        if (result.status !== "timeout" || result.exitCode === 0)
          fail("Owned fixture process did not stop at the timeout");
      },
      { authority: "fixture", kind: "validation" },
    );
    return "bounded-recovery";
  }
  if (id === "playbook-intake") {
    const result = await observer.execute("playbook", ["--match", "explain a scientific idea with a worked example"]);
    if (!result.event.passed || !result.envelope.metadata) fail("Playbook discovery failed");
    const candidates = result.envelope.metadata.candidates as { id: string }[] | undefined;
    if (!candidates?.some((c) => c.id === "explainer")) fail("Requested educational route is absent from discovery");
    const init = await observer.execute("film:init", ["--project", "workflow-education", "--playbook", "explainer"]);
    if (!init.event.passed) fail("Selected playbook did not initialise its owning route");
    const binding = init.event.outputs.find((p) => p.path.endsWith("/playbook.json"));
    if (!binding) fail("Route initialisation lost playbook binding");
    const next = await observer.execute("next", ["--project", "workflow-education"], { inputs: [binding.path] });
    if (!next.event.passed || next.envelope.metadata?.route !== "film" || !next.envelope.metadata.next)
      fail("Downstream route consumer lost the chosen film route");
    observedHandoff(observer.events, next.event, binding.path);
    return "handoff";
  }
  if (id === "budget-boundary") {
    await observer.operation(
      "@budget/zero-spend",
      [],
      [],
      () => {
        const store = new OperationStore("workflow-e2e", { directory: path.join(observer.workspace, ".cache/budget") });
        store.configure({ ceilingUsd: 0, maxJobUsd: 0 });
        const input = {
          operationId: "fixture-operation",
          provider: "fixture",
          endpoint: "fixture",
          assetId: "fixture",
          inputHash: digest("fixture"),
          quote: {
            currency: "USD" as const,
            lowUsd: 1,
            expectedUsd: 1,
            highUsd: 1,
            bounded: true as const,
            source: "fixture",
            asOf: "2026-11-15",
            confidence: "conservative-bound" as const,
          },
        };
        const refused = (code: BudgetError["code"], fn: () => unknown) => {
          try {
            fn();
          } catch (error) {
            if (error instanceof BudgetError && error.code === code) return;
            throw error;
          }
          fail("Budget boundary did not refuse " + code);
        };
        refused("BUDGET_EXCEEDED", () => store.reserveOperation(input));
        refused("UNKNOWN_PRICE", () =>
          store.reserveOperation({ ...input, quote: { ...input.quote, highUsd: Number.NaN } }),
        );
        if (Object.keys(store.snapshot().jobs).length) fail("Refused admission wrote a job");
        const free = { ...input, quote: { ...input.quote, lowUsd: 0, expectedUsd: 0, highUsd: 0 } };
        const first = store.reserveOperation(free),
          second = store.reserveOperation(free);
        if (first.operationId !== second.operationId || Object.keys(store.snapshot().jobs).length !== 1)
          fail("Retry duplicated operation ownership");
        store.admitSubmission(first.operationId);
        store.transitionJob(first.operationId, "submitting");
        store.transitionJob(first.operationId, "unknown", {
          error: "Fixture acknowledgement loss; no provider was contacted",
        });
        refused("INVALID_TRANSITION", () => store.transitionJob(first.operationId, "submitting"));
        refused("CONFLICT", () => store.reserveOperation({ ...free, inputHash: digest("changed input") }));
      },
      { authority: "fixture", kind: "validation" },
    );
    return "bounded-recovery";
  }
  if (Object.hasOwn(advisoryTasks, id)) return advisoryFixture(observer);
  fail("No independent oracle is registered for this scenario");
}

const advisoryTasks: Record<string, { task: LocalTaskRequest; alias: string; input: string }> = {
  "translation-cues": {
    task: { task: "text.translate", language: "en", targetLanguage: "es" },
    alias: "text:translate",
    input: "material/translation.json",
  },
  "vision-crop": { task: { task: "vision.saliency" }, alias: "media:vision", input: "pattern.png" },
  "audio-markers": { task: { task: "audio.events" }, alias: "audio:events", input: "input.wav" },
  "foundation-draft": {
    task: { task: "text.assist", language: "en" },
    alias: "text:assist",
    input: "material/voice.json",
  },
};
async function advisoryFixture(observer: WorkflowObserver) {
  const result =
    observer.scenario.id === "translation-cues"
      ? { units: [{ id: "cue-1", text: "Agent Bros tiene 3 pasos." }], sourceLanguage: "en", targetLanguage: "es" }
      : observer.scenario.id === "vision-crop"
        ? {
            frames: [
              { id: "frame-0", width: 160, height: 120, saliency: [{ x: 0.2, y: 0.2, w: 0.2, h: 0.4, score: 0.8 }] },
            ],
            coordinates: "normalised-top-left",
            advisory: true,
          }
        : observer.scenario.id === "audio-markers"
          ? {
              events: [{ label: "tone", score: 0.7, startSec: 0, endSec: 1 }],
              windowSec: 1,
              overlap: 0,
              labels: ["tone"],
              advisory: true,
            }
          : { items: [{ sourceId: "scene-1", text: "Hold on the product.", tags: ["product"] }], advisory: true };
  await observer.operation(
    "fixture:advisory-producer",
    [],
    ["advisory.json"],
    () => fixtureJson(observer, "advisory.json", { result }),
    { authority: "fixture", kind: "command" },
  );
  return consumeAdvisory(observer, "advisory.json");
}
export async function consumeAdvisory(observer: WorkflowObserver, file: string) {
  const id = observer.scenario.id;
  if (!Object.hasOwn(advisoryTasks, id)) fail("Unknown advisory consumer oracle");
  const consumed = await observer.operation("@review/advisory-candidate", [file], ["review-candidate.json"], () => {
    const raw = JSON.parse(observer.read(file).toString()) as { result: unknown };
    let candidate: unknown;
    if (id === "translation-cues") {
      const enriched = raw.result as {
        units: { id: string; text: string; startMs?: number; endMs?: number }[];
        sourceLanguage: string;
        targetLanguage: string;
        wordTiming?: unknown;
      };
      const translated = AppleTranslationResultSchema.parse({
          units: enriched.units.map((u) => ({ id: u.id, text: u.text })),
          sourceLanguage: enriched.sourceLanguage,
          targetLanguage: enriched.targetLanguage,
        }),
        source = LocalTextRequestSchema.parse(JSON.parse(observer.read("material/translation.json").toString()));
      if (enriched.wordTiming !== undefined && enriched.wordTiming !== null) fail("Translation invented word timings");
      if (
        enriched.units.some(
          (u, i) =>
            (u.startMs !== undefined && u.startMs !== source.units[i]?.startMs) ||
            (u.endMs !== undefined && u.endMs !== source.units[i]?.endMs),
        )
      )
        fail("Translation changed source cue intervals");
      sameIds(
        translated.units.map((u) => u.id),
        source.units.map((u) => u.id),
      );
      if (
        translated.sourceLanguage !== source.sourceLanguage ||
        translated.targetLanguage !== source.targetLanguage ||
        !translated.units[0]?.text.includes("Agent Bros") ||
        !translated.units[0].text.includes("3")
      )
        fail("Translation lost language, numbers or protected terms");
      candidate = {
        units: source.units.map((u, i) => ({ ...u, text: translated.units[i]!.text })),
        wordTiming: null,
        approved: false,
      };
    } else if (id === "vision-crop") {
      const vision = AppleVisionResultSchema.parse(raw.result);
      candidate = vision.frames.map((f) => ({
        sourceId: f.id,
        crop: frameCrop(f.saliency?.[0] ?? { x: 0, y: 0, w: 1, h: 1 }, f.width / f.height, 9 / 16, "cover"),
      }));
    } else if (id === "audio-markers") {
      const audio = AppleAudioResultSchema.parse(raw.result);
      if (audio.events.some((e) => !audio.labels.includes(e.label) || e.endSec > 3 + audio.windowSec))
        fail("Event taxonomy/source clock mismatch");
      candidate = { advisory: true, markers: audio.events, approved: false };
    } else {
      const enriched = raw.result as { items: unknown; advisory: unknown; reviewRequired?: boolean };
      if (enriched.reviewRequired !== undefined && enriched.reviewRequired !== true) fail("Assistance bypassed review");
      const assistance = AppleAssistanceResultSchema.parse({ items: enriched.items, advisory: enriched.advisory }),
        source = LocalTextRequestSchema.parse(JSON.parse(observer.read("material/voice.json").toString()));
      sameIds(
        assistance.items.map((i) => i.sourceId),
        source.units.map((u) => u.id),
      );
      candidate = { items: assistance.items, factualApproval: false, humanApproval: false };
    }
    fixtureJson(observer, "review-candidate.json", candidate);
  });
  observedHandoff(observer.events, consumed.event, file);
  return "handoff";
}

export async function nativeWorkflow(observer: WorkflowObserver) {
  const id = observer.scenario.id;
  if (["recording-shorts", "voice-draft"].includes(id)) {
    const [ready] = await inspectCapabilities([{ task: "speech.synthesise", language: "en" }], { refresh: true });
    if (ready?.state !== "ready") return { skip: ready?.reason ?? "Installed English voice unavailable" };
    const voice = await observer.execute(
      "voiceover:local",
      ["--input", "material/voice.json", "--output", "voice.json"],
      { authority: "installed-native" },
    );
    if (!voice.event.passed) fail("Installed TTS command failed");
    const audio = voice.event.outputs.find((p) => p.path.endsWith(".mp3"));
    if (!audio) fail("System TTS produced no audio");
    if (id === "voice-draft") {
      const imported = await observer.execute("asset:import", ["--project", "workflow-e2e", "--input", audio.path]);
      if (!imported.event.passed) fail("Native voice import failed");
      return { outcome: await consumeVoice(observer) };
    }
    const [speech] = await inspectCapabilities([{ task: "speech.transcribe", language: "en" }], { refresh: true });
    if (speech?.state !== "ready") return { skip: speech?.reason ?? "Installed English ASR unavailable" };
    const transcript = await observer.execute(
      "speech:local",
      ["--engine", "apple", "--input", audio.path, "--output", "transcript.json", "--no-vad", "--language", "en"],
      { authority: "installed-native" },
    );
    if (!transcript.event.passed) fail("Installed Apple ASR command failed");
    const shorts = await observer.execute("shorts:prepare", [
      "--transcript",
      "transcript.json",
      "--output-dir",
      "shorts",
      "--min-sec",
      "1",
      "--max-sec",
      "20",
      "--hard-max-sec",
      "30",
    ]);
    if (!shorts.event.passed) fail("Native transcript handoff failed");
    return { outcome: await consumeRecording(observer, audio.path, true) };
  }
  const spec = advisoryTasks[id];
  if (!spec) return { skip: "This scenario exercises contracts or real delegation, not installed-model execution." };
  const [ready] = await inspectCapabilities([spec.task], { refresh: true });
  if (ready?.state !== "ready") return { skip: ready?.reason ?? "Installed task resource unavailable" };
  if (id === "vision-crop") {
    const ffmpeg = spawnSync(
      "ffmpeg",
      [
        "-v",
        "error",
        "-nostdin",
        "-f",
        "lavfi",
        "-i",
        "testsrc2=size=160x120:rate=1",
        "-frames:v",
        "1",
        path.join(observer.workspace, "pattern.png"),
      ],
      { timeout: 15000, encoding: "utf8" },
    );
    if (ffmpeg.status !== 0) fail("Vision fixture preparation failed");
  }
  const result = await observer.execute(
    spec.alias,
    [
      "--input",
      spec.input,
      "--output",
      "advisory.json",
      ...(spec.task.language ? ["--language", spec.task.language] : []),
      ...(spec.task.targetLanguage ? ["--target-language", spec.task.targetLanguage] : []),
      ...(id === "vision-crop" ? ["--features", "saliency"] : []),
    ],
    { authority: "installed-native" },
  );
  if (!result.event.passed) fail("Installed native task command failed");
  return { outcome: await consumeAdvisory(observer, "advisory.json") };
}
