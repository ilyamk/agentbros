import { copyFileSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { LocalResultReceiptSchema, LocalTextRequestSchema, type LocalTask } from "../../types/local-capabilities";
import { AssetRegistrySchema } from "../../types/assets";
import { ProjectConfigSchema } from "../../types/video";
import { TranslationSchema } from "../../types/campaigns";
import { TimelineEditStore } from "../timeline-ir/store";
import { assertLocalizationReady } from "../campaigns/localization";
import { inspectCapabilities } from "../local-capabilities";
import { publishResult } from "../apple/tasks";
import { observedHandoff } from "./workflow-assertions";
import { fixtureJson, expectRefusal } from "./workflow-fixtures";
import { digest, contained, fail } from "./io";
import type { WorkflowObserver } from "./workflow-observer";
import { renderWorkflowChain } from "./workflow-render-chain";
import { OperationStore } from "../jobs/store";
import { runGenerationStep, type JobProvider } from "../jobs/runner";

const briefTasks: Record<string, { task: LocalTask; alias: string; input: string }> = {
  "text-brief": { task: "text.analyse", alias: "text:analyse", input: "notes.txt" },
  "assistance-brief": { task: "text.assist", alias: "text:assist", input: "voice.json" },
  "image-brief": { task: "image.describe", alias: "image:describe", input: "frame.png" },
  "events-brief": { task: "audio.events", alias: "audio:events", input: "tone.wav" },
};
export function completionKey(observer: WorkflowObserver) {
  return observer.scenario.oracle ?? observer.scenario.id;
}
export async function requireCommand(observer: WorkflowObserver, alias: string, argv: string[], inputs?: string[]) {
  const result = await observer.execute(alias, argv, { inputs });
  if (!result.event.passed) fail(alias + ": " + (result.envelope.message ?? result.event.stderr ?? "Command failed"));
  return result;
}
export function syntheticVideo(observer: WorkflowObserver, name: string) {
  const run = spawnSync(
    "ffmpeg",
    [
      "-v",
      "error",
      "-nostdin",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=320x180:rate=30:duration=3",
      "-i",
      path.join(observer.workspace, "input.wav"),
      "-shortest",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      contained(observer.workspace, name),
    ],
    { encoding: "utf8", timeout: 30000 },
  );
  if (run.status !== 0) fail("Synthetic video preparation failed: " + run.stderr.slice(-300));
}
export async function nativeFixtureResult(
  observer: WorkflowObserver,
  task: LocalTask,
  input: string,
  output: string,
  result: unknown,
) {
  const absolute = contained(observer.workspace, output),
    source = observer.pin(input),
    operationId = digest(JSON.stringify({ task, source, result }));
  const bytes =
    JSON.stringify({
      version: 1,
      task,
      operationId,
      purpose: "draft",
      source: { file: contained(observer.workspace, input), sha256: source.sha256 },
      result,
    }) + "\n";
  await observer.operation(
    "fixture:native-result",
    [input],
    [output, output + ".receipt.json"],
    () => {
      const receipt = LocalResultReceiptSchema.parse({
        version: 1,
        task,
        backend: "explicit-offline-fixture",
        operationId,
        createdAt: new Date().toISOString(),
        identity: digest("fixture runtime"),
        systemModelsHashPinned: false,
        requestHash: operationId,
        inputs: [{ file: contained(observer.workspace, input), sha256: source.sha256 }],
        outputs: [{ file: absolute, sha256: digest(bytes) }],
        purpose: "draft",
        checks: ["synthetic-contract-only"],
        warnings: ["Not installed-model execution or quality acceptance."],
      });
      publishResult(absolute, bytes, absolute + ".receipt.json", receipt);
    },
    { authority: "fixture", kind: "command" },
  );
}
async function briefWorkflow(observer: WorkflowObserver, native: boolean) {
  const spec = briefTasks[completionKey(observer)]!;
  if (native) {
    const [state] = await inspectCapabilities([{ task: spec.task, language: "en" }], { refresh: true });
    if (state?.state !== "ready") return { skip: state?.reason ?? "Native resource unavailable" };
  }
  await requireCommand(observer, "film:init", ["--project", "local-film", "--type", "motion-graphics"]);
  const base = "public/projects/local-film/pipeline/local-inputs",
    input = base + "/" + spec.input;
  await observer.operation(
    "fixture:owned-source",
    [],
    [input],
    () => {
      mkdirSync(path.dirname(contained(observer.workspace, input)), { recursive: true });
      if (spec.input === "frame.png") {
        const run = spawnSync(
          "ffmpeg",
          [
            "-v",
            "error",
            "-nostdin",
            "-f",
            "lavfi",
            "-i",
            "color=c=red:size=160x120",
            "-frames:v",
            "1",
            contained(observer.workspace, input),
          ],
          { encoding: "utf8", timeout: 15000 },
        );
        if (run.status !== 0) fail("Image preparation failed");
      } else
        copyFileSync(
          contained(observer.workspace, spec.input === "tone.wav" ? "input.wav" : "material/" + spec.input),
          contained(observer.workspace, input),
        );
    },
    { authority: "fixture", kind: "preparation" },
  );
  const output = base + "/candidate.json";
  if (native) await requireCommand(observer, spec.alias, ["--input", input, "--output", output, "--language", "en"]);
  else {
    const result =
      spec.task === "text.analyse"
        ? {
            language: "en",
            hypotheses: { en: 1 },
            items: [{ operation: "tokens", text: "Alice", value: "Alice", startUtf16: 0, lengthUtf16: 5 }],
          }
        : spec.task === "audio.events"
          ? {
              events: [{ label: "tone", score: 0.8, startSec: 0, endSec: 1 }],
              windowSec: 1,
              overlap: 0,
              labels: ["tone"],
              advisory: true,
            }
          : {
              items: [
                {
                  sourceId: spec.task === "image.describe" ? "image" : "scene-1",
                  text: "A source-bound draft suggestion.",
                  tags: ["draft"],
                },
              ],
              advisory: true,
              reviewRequired: true,
            };
    await nativeFixtureResult(observer, spec.task, input, output, result);
  }
  const consumer = await requireCommand(observer, "film:brief", [
    "--project",
    "local-film",
    "--step",
    "intake",
    "--local-evidence",
    output,
  ]);
  observedHandoff(observer.events, consumer.event, output);
  // Briefs go by reference: the subagent reads the saved file that metadata.brief and metadata.dispatch name.
  const saved = consumer.event.outputs.find((pin) => pin.path.endsWith(".md"));
  const prompt = saved ? observer.read(saved.path).toString() : undefined;
  if (
    typeof prompt !== "string" ||
    !prompt.includes(observer.pin(output).sha256) ||
    !prompt.includes("Untrusted advisory data")
  )
    fail("Saved owner prompt lost the evidence binding");
  const metadata = consumer.envelope.metadata as { brief?: unknown; dispatch?: unknown } | undefined;
  if (
    !saved ||
    metadata?.brief !== saved.path ||
    typeof metadata.dispatch !== "string" ||
    !metadata.dispatch.includes(saved.path)
  )
    fail("The dispatch line does not name the saved prompt");
  return { outcome: "handoff" };
}
async function translationWorkflow(observer: WorkflowObserver, native: boolean) {
  if (native) {
    const [state] = await inspectCapabilities([{ task: "text.translate", language: "en", targetLanguage: "es" }], {
      refresh: true,
    });
    if (state?.state !== "ready") return { skip: state?.reason ?? "Installed language pair unavailable" };
  }
  const input = "material/translation.json",
    request = LocalTextRequestSchema.parse(JSON.parse(observer.read(input).toString()));
  if (native) await requireCommand(observer, "text:translate", ["--input", input, "--output", "translated.json"]);
  else
    await nativeFixtureResult(observer, "text.translate", input, "translated.json", {
      ...request,
      units: request.units.map((unit) => ({ ...unit, text: "Agent Bros tiene 3 pasos." })),
      wordTiming: null,
      reviewRequired: true,
    });
  const sourceProject = "public/projects/local-source/project.json";
  await observer.operation(
    "fixture:localisation-source",
    [],
    [sourceProject],
    () =>
      fixtureJson(
        observer,
        sourceProject,
        ProjectConfigSchema.parse({
          name: "Local source",
          productName: "Agent Bros",
          colors: {},
          formats: ["landscape"],
          voice: "rachel",
          scenes: request.units.map((unit) => ({
            id: unit.id,
            text: unit.text,
            headline: unit.text,
            durationInFrames: 150,
            visualType: "title",
          })),
        }),
      ),
    { authority: "fixture", kind: "preparation" },
  );
  await observer.operation(
    "@localisation/request",
    ["translated.json", input, sourceProject],
    ["translation-request.json"],
    () => {
      const translated = JSON.parse(observer.read("translated.json").toString()).result as {
        units: { id: string; text: string }[];
      };
      if (
        translated.units.length !== request.units.length ||
        translated.units.some(
          (u, i) => u.id !== request.units[i]!.id || !u.text.includes("Agent Bros") || !u.text.includes("3"),
        )
      )
        fail("Localisation lost source IDs or protected content");
      fixtureJson(
        observer,
        "translation-request.json",
        TranslationSchema.parse({
          version: 1,
          sourceProjectId: "local-source",
          projectId: "local-es",
          sourceLanguage: "en",
          targetLanguage: "es",
          voice: "rachel",
          source: "Local candidate " + observer.pin("translated.json").sha256,
          wordsPerSecond: 3,
          scenes: translated.units.map((unit) => ({ id: unit.id, text: unit.text, headline: unit.text, labels: {} })),
        }),
      );
    },
  );
  const created = await requireCommand(observer, "campaign", [
    "--action",
    "localize-create",
    "--manifest",
    "translation-request.json",
  ]);
  observedHandoff(observer.events, created.event, "translation-request.json");
  await observer.operation(
    "@localisation/review-boundary",
    created.event.outputs.map((p) => p.path),
    [],
    () =>
      expectRefusal(
        () => assertLocalizationReady(contained(observer.workspace, "public/projects/local-es")),
        /review|alignment/,
      ),
  );
  return { outcome: "handoff" };
}
async function visionWorkflow(observer: WorkflowObserver, native: boolean) {
  if (native) {
    const [state] = await inspectCapabilities([{ task: "vision.faces" }], { refresh: true });
    if (state?.state !== "ready") return { skip: state?.reason ?? "Vision unavailable" };
  }
  await observer.operation(
    "fixture:video-source",
    [],
    ["camera.mp4", "public/projects/crop/project.json"],
    () => {
      syntheticVideo(observer, "camera.mp4");
      mkdirSync(path.join(observer.workspace, "public/projects/crop/assets"), { recursive: true });
      copyFileSync(
        path.join(observer.workspace, "camera.mp4"),
        path.join(observer.workspace, "public/projects/crop/assets/camera.mp4"),
      );
      fixtureJson(
        observer,
        "public/projects/crop/project.json",
        ProjectConfigSchema.parse({
          name: "Crop fixture",
          productName: "Fixture",
          formats: ["landscape"],
          colors: {},
          scenes: [
            {
              id: "camera",
              text: "",
              headline: "",
              visualType: "video",
              imageUrl: "projects/crop/assets/camera.mp4",
              durationInFrames: 90,
            },
          ],
        }),
      );
    },
    { authority: "fixture", kind: "preparation" },
  );
  const imported = await requireCommand(observer, "asset:import", ["--project", "crop", "--input", "camera.mp4"]);
  const registryFile = imported.event.outputs.find((p) => p.path.endsWith("/asset-registry.json"))!;
  const asset = AssetRegistrySchema.parse(JSON.parse(observer.read(registryFile.path).toString())).assets.find(
    (a) => a.hash === observer.pin("camera.mp4").sha256,
  )!;
  const timelineFile = "public/projects/crop/pipeline/timeline-edit.json";
  await observer.operation(
    "fixture:plain-video-timeline",
    [registryFile.path],
    [timelineFile],
    () => {
      new TimelineEditStore(contained(observer.workspace, timelineFile)).initialize({
        version: 1,
        projectId: "crop",
        timebase: { num: 30, den: 1 },
        tracks: [
          {
            id: "visual",
            kind: "visual",
            clips: [
              {
                id: "camera",
                assetId: asset.id,
                start: { num: 0, den: 1 },
                source: { start: { num: 0, den: 1 }, end: { num: 90, den: 1 }, timebase: { num: 30, den: 1 } },
                rate: { num: 1, den: 1 },
                transition: { kind: "cut" },
                captions: [],
              },
            ],
          },
        ],
      });
    },
    { authority: "fixture", kind: "preparation" },
  );
  const state = new TimelineEditStore(contained(observer.workspace, timelineFile)).read();
  const track = state.timeline.tracks.find((t) => t.kind === "visual")!,
    clip = track.clips[0]!;
  if (!native)
    await observer.operation(
      "fixture:detections",
      ["camera.mp4"],
      ["detections.json"],
      () =>
        fixtureJson(observer, "detections.json", {
          width: 320,
          height: 180,
          fps: 30,
          frameCount: 90,
          samples: [0, 30, 60].map((frame) => ({
            frame,
            faces: [{ x: 0.3, y: 0.2, w: 0.2, h: 0.4, score: 0.9 }],
            people: [],
          })),
        }),
      { authority: "fixture", kind: "command" },
    );
  const crop = await requireCommand(observer, "reframe:track", [
    "--input",
    "camera.mp4",
    "--output",
    "crop.json",
    ...(native ? ["--detector", "vision"] : ["--detections", "detections.json"]),
    "--command-output",
    "crop-command.json",
    "--track-id",
    track.id,
    "--clip-id",
    clip.id,
  ]);
  const applied = await requireCommand(observer, "timeline:edit", [
    "--project",
    "crop",
    "--revision",
    String(state.revision),
    "--command-file",
    "crop-command.json",
  ]);
  observedHandoff(observer.events, applied.event, "crop-command.json");
  const changed = new TimelineEditStore(contained(observer.workspace, applied.event.outputs[0]!.path)).read();
  if (
    changed.revision !== state.revision + 1 ||
    !JSON.stringify(changed.timeline).includes("keyframes") ||
    !crop.event.outputs.some((p) => p.path === "crop-command.json")
  )
    fail("Timeline did not consume the crop path");
  return { outcome: "handoff" };
}
async function execute(observer: WorkflowObserver, native: boolean): Promise<{ outcome?: string; skip?: string }> {
  const key = completionKey(observer);
  if (Object.hasOwn(briefTasks, key)) return briefWorkflow(observer, native);
  if (key === "translation-localisation") return translationWorkflow(observer, native);
  if (key === "vision-timeline") return visionWorkflow(observer, native);
  if (key === "recording-delivery" || key === "film-delivery")
    return renderWorkflowChain(observer, key === "recording-delivery");
  fail("Unregistered completion oracle");
}
export const completionWorkflow = (observer: WorkflowObserver) => execute(observer, false);
export const completionNative = (observer: WorkflowObserver) => execute(observer, true);

export async function providerRecovery(observer: WorkflowObserver) {
  await observer.operation(
    "@jobs/offline-resume",
    [],
    ["provider-counts.json", "fixture-result.json"],
    async () => {
      const directory = contained(observer.workspace, ".cache/fixture-jobs");
      const store = new OperationStore("fixture-jobs", { directory });
      store.configure({ ceilingUsd: 0, maxJobUsd: 0, repairReserveFraction: 0 });
      const quote = {
        lowUsd: 0,
        expectedUsd: 0,
        highUsd: 0,
        bounded: true as const,
        currency: "USD" as const,
        source: "offline-simulator",
        asOf: "2026-11-16",
        confidence: "user-bound" as const,
      };
      let submissions = 0,
        publications = 0;
      const provider: JobProvider = {
        submit: async () => {
          submissions++;
          return { requestId: "fixture-request" };
        },
        inspect: async () => ({ state: "completed", result: { fixture: true } }),
      };
      const operation = {
        operationId: "offline-result",
        assetId: "fixture",
        provider: "fixture",
        endpoint: "no-network",
        quote,
      };
      const publish = async () => {
        if (++publications === 1) throw new Error("Simulated interrupted publication");
        fixtureJson(observer, "fixture-result.json", { version: 1, fixture: true });
        return { file: "fixture-result.json", sha256: observer.pin("fixture-result.json").sha256 };
      };
      const args = { store, provider, operation, input: { fixture: "immutable" }, publish };
      if ((await runGenerationStep(args)).state !== "failed") fail("Interrupted publication was not retained");
      const resumed = await runGenerationStep({ ...args, store: new OperationStore("fixture-jobs", { directory }) });
      if (resumed.state !== "published" || submissions !== 1 || publications !== 2)
        fail("Recovery duplicated submission or lost the stored result");
      let ambiguousSubmissions = 0;
      const ambiguous: JobProvider = {
        submit: async () => {
          ambiguousSubmissions++;
          throw new Error("Simulated lost acknowledgement");
        },
        inspect: async () => ({ state: "running" }),
      };
      const pending = { ...args, operation: { ...operation, operationId: "ambiguous-result" }, provider: ambiguous };
      if (
        (await runGenerationStep(pending)).state !== "unknown" ||
        (await runGenerationStep({ ...pending, store: new OperationStore("fixture-jobs", { directory }) })).state !==
          "unknown" ||
        ambiguousSubmissions !== 1
      )
        fail("Ambiguous submission was repeated");
      fixtureJson(observer, "provider-counts.json", {
        provider: "in-process-offline-fixture",
        submissions,
        publications,
        ambiguousSubmissions,
        externalRequests: 0,
        actualSpendUsd: 0,
      });
    },
    { authority: "fixture", kind: "validation" },
  );
}
