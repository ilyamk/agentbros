import { mkdirSync, writeFileSync, symlinkSync, existsSync, rmSync, copyFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { bundle } from "@remotion/bundler";
import { enableTailwind } from "@remotion/tailwind-v4";
import { ensureBrowser, openBrowser, selectComposition, renderMedia, makeCancelSignal } from "@remotion/renderer";
import { TranscriptSchema } from "../../types/transcript";
import { ScriptSchema, StoryboardSchema } from "../../types/pipeline";
import { DeliveryRequestSchema } from "../../types/delivery";
import { planProjectRender } from "../render-plan";
import { captureRenderIdentity } from "../delivery/identity";
import { captureBespokeIdentity } from "../delivery/bespoke";
import { captureDeliverySnapshot, checkDelivery } from "../delivery/service";
import { publishRenderReceipt } from "../delivery/render-receipt";
import { requireCommand, syntheticVideo } from "./workflow-completion";
import { fixtureJson } from "./workflow-fixtures";
import { observedHandoff } from "./workflow-assertions";
import { contained, fail } from "./io";
import type { WorkflowObserver } from "./workflow-observer";

type DraftResult = Pick<ReturnType<typeof checkDelivery>, "productionReady" | "manifest" | "blockers">;
export function assertRenderedDraft(
  result: DraftResult,
  expected: { path: string; sha256: string; sourceSnapshotHash: string; propsHash: string; frames: number },
) {
  if (result.productionReady || result.manifest.state === "production-ready")
    fail("Offline draft bypassed production review");
  const output = result.manifest.outputs.find((row) => row.path === expected.path);
  if (
    !output ||
    output.sha256 !== expected.sha256 ||
    output.sourceSnapshotHash !== expected.sourceSnapshotHash ||
    output.propsHash !== expected.propsHash ||
    output.width !== 1920 ||
    output.height !== 1080 ||
    output.fps !== 30 ||
    Math.abs(output.durationSec - expected.frames / 30) > 0.05
  )
    fail("Rendered draft has invalid measured output or source binding");
  const structural = result.blockers.filter((f) =>
    /RENDER|OUTPUT|SOURCE_CHANGED|SNAPSHOT|RESOLUTION|FPS_|DURATION|TRUE_PEAK|LOUDNESS|SPEECH_|CAPTION|VIDEO_STREAM|AUDIO_STREAM|AUDIO_MISSING|MEDIA_INCOMPLETE|PARTIAL/.test(
      f.code,
    ),
  );
  if (structural.length)
    fail("Rendered draft has structural delivery blockers: " + structural.map((f) => f.code).join(", "));
}

/** Actual local rendering with the production timeline/library; no agent or model is launched. */
export async function renderWorkflowChain(
  observer: WorkflowObserver,
  recording: boolean,
): Promise<{ outcome?: string; skip?: string }> {
  const id = recording ? "local-recording" : "local-generated";
  const project = `public/projects/${id}`,
    output = recording ? `out/${id}/landscape.mp4` : `out/${id}/film.mp4`;
  let props: Record<string, unknown> = {},
    frames = 9,
    compositionId = "LocalFilm";
  if (recording) {
    await observer.operation("fixture:recording", [], ["source.mp4"], () => syntheticVideo(observer, "source.mp4"), {
      authority: "fixture",
      kind: "preparation",
    });
    const transcript = await requireCommand(observer, "transcribe", [
      "--input",
      "source.mp4",
      "--from-raw",
      "material/scribe.json",
      "--output",
      "recording-transcript.json",
    ]);
    await observer.operation(
      "@recording/request",
      ["recording-transcript.json", "source.mp4"],
      ["recording-request.json"],
      () => {
        const words = TranscriptSchema.parse(JSON.parse(observer.read("recording-transcript.json").toString()));
        fixtureJson(observer, "recording-request.json", {
          version: 1,
          workflow: "recording-edit",
          projectId: id,
          name: "Offline recording fixture",
          profile: "recording-only",
          formats: ["landscape"],
          source: {
            file: "source.mp4",
            sha256: observer.pin("source.mp4").sha256,
            version: "synthetic-1",
            fps: { num: 30, den: 1 },
          },
          transcript: {
            version: "frozen-synthetic",
            language: "en",
            words: words.words.map((w) => ({
              id: w.id,
              text: w.text,
              startFrame: Math.round(w.startSec * 30),
              endFrame: Math.round(w.endSec * 30),
            })),
          },
          keepSpans: [{ id: "all", startFrame: 0, endFrame: 90, reason: "Retain the complete synthetic source" }],
          cuts: [],
          protectedSpans: [],
          revision: 1,
        });
      },
    );
    observedHandoff(
      observer.events,
      observer.events.at(-1)!,
      transcript.event.outputs.find((p) => p.path === "recording-transcript.json")!.path,
    );
    const plan = await requireCommand(observer, "video:workflow", [
      "--scenario",
      "recording-edit",
      "--request",
      "recording-request.json",
      "--action",
      "plan",
    ]);
    const refused = await observer.execute("video:workflow", [
      "--scenario",
      "recording-edit",
      "--request",
      "recording-request.json",
      "--action",
      "create",
    ]);
    if (refused.event.passed || !/review|approv/i.test(refused.envelope.message ?? ""))
      fail("Unreviewed recording was not refused");
    await observer.operation(
      "fixture:review-declaration",
      ["recording-request.json"],
      ["recording-reviewed.json"],
      () => {
        const request = JSON.parse(observer.read("recording-request.json").toString());
        fixtureJson(observer, "recording-reviewed.json", {
          ...request,
          review: {
            reviewer: "explicit-offline-fixture",
            reviewedAt: "2026-11-16T00:00:00Z",
            meaningPreserved: true,
            approvedEditHash: plan.envelope.metadata?.editHash,
          },
        });
      },
      { authority: "fixture", kind: "preparation" },
    );
    const created = await requireCommand(observer, "video:workflow", [
      "--scenario",
      "recording-edit",
      "--request",
      "recording-reviewed.json",
      "--action",
      "create",
    ]);
    observedHandoff(observer.events, created.event, "recording-reviewed.json");
    const captions = await requireCommand(
      observer,
      "captions:export",
      ["--project", id, "--timeline", "--output", `out/${id}/captions.srt`],
      [`${project}/pipeline/timeline-edit.json`],
    );
    observedHandoff(observer.events, captions.event, `${project}/pipeline/timeline-edit.json`);
    const text = observer.read(`out/${id}/captions.srt`).toString();
    if (!["camera", "product."].every((word) => text.includes(word))) fail("Subtitle export lost source words");
    const job = planProjectRender(id, "landscape", observer.workspace, { timeline: true }).jobs[0]!;
    props = job.props as unknown as Record<string, unknown>;
    frames = job.durationInFrames;
    compositionId = job.compositionId;
  } else {
    await requireCommand(observer, "playbook", ["--match", "a motion graphics explainer"]);
    await requireCommand(observer, "film:init", [
      "--project",
      id,
      "--type",
      "motion-graphics",
      "--playbook",
      "motion-design",
    ]);
    await requireCommand(observer, "film:brief", ["--project", id, "--step", "intake"]);
    await observer.operation(
      "fixture:authored-film",
      [],
      [
        `${project}/pipeline/brief.json`,
        `${project}/pipeline/script.json`,
        `${project}/pipeline/motion-plan.json`,
        `${project}/pipeline/build.json`,
      ],
      () => {
        // These inputs are supplied fixture artefacts, not model-produced creative work or approvals.
        writeFileSync(
          contained(observer.workspace, `${project}/pipeline/brief.json`),
          JSON.stringify({ renderMode: "bespoke", format: "landscape" }),
        );
        fixtureJson(
          observer,
          `${project}/pipeline/script.json`,
          ScriptSchema.parse({
            narratorVoice: "rachel",
            voiceoverEnabled: false,
            language: "en",
            beats: [{ id: "one", kind: "hook", text: "", durationSec: 0.3 }],
          }),
        );
        fixtureJson(observer, `${project}/pipeline/motion-plan.json`, {
          fps: 30,
          shots: [{ id: "one", startFrame: 0, durationFrames: 9 }],
        });
        fixtureJson(observer, `${project}/pipeline/build.json`, {
          composition: compositionId,
          entry: "entry.tsx",
          localAssets: [],
        });
      },
      { authority: "fixture", kind: "preparation" },
    );
    const storyboard = await observer.operation(
      "@storyboard/from-supplied-script",
      [`${project}/pipeline/script.json`],
      [`${project}/pipeline/storyboard.json`],
      () => {
        const script = ScriptSchema.parse(JSON.parse(observer.read(`${project}/pipeline/script.json`).toString()));
        fixtureJson(
          observer,
          `${project}/pipeline/storyboard.json`,
          StoryboardSchema.parse({
            scenes: script.beats.map((beat) => ({
              id: beat.id,
              beatId: beat.id,
              voiceoverText: beat.text,
              durationSec: beat.durationSec,
              musicIntensity: "none",
              transitionToNext: "cut",
            })),
          }),
        );
      },
    );
    observedHandoff(observer.events, storyboard.event, `${project}/pipeline/script.json`);
    const plan = await observer.operation(
      "@motion-plan/storyboard",
      [`${project}/pipeline/storyboard.json`, `${project}/pipeline/motion-plan.json`],
      [],
      () => {
        const board = StoryboardSchema.parse(
          JSON.parse(observer.read(`${project}/pipeline/storyboard.json`).toString()),
        );
        const motion = JSON.parse(observer.read(`${project}/pipeline/motion-plan.json`).toString()) as {
          fps: number;
          shots: { id: string; durationFrames: number }[];
        };
        if (
          motion.shots.length !== board.scenes.length ||
          motion.shots.some(
            (shot, i) =>
              shot.id !== board.scenes[i]!.id ||
              shot.durationFrames !== Math.round(board.scenes[i]!.durationSec * motion.fps),
          )
        )
          fail("Motion plan lost the storyboard identity or duration");
      },
    );
    observedHandoff(observer.events, plan.event, `${project}/pipeline/storyboard.json`);
  }
  let browserPath: string;
  try {
    const installed = await ensureBrowser({
      browserExecutable: process.env.AGENTBROS_WORKFLOW_BROWSER,
      logLevel: "error",
      onBrowserDownload: () => {
        throw new Error("No installed Chromium; download forbidden");
      },
    });
    if (!("path" in installed)) return { skip: "No installed Chromium; download forbidden" };
    browserPath = installed.path;
  } catch (error) {
    return { skip: error instanceof Error ? error.message : "Installed browser unavailable" };
  }
  const source = recording
    ? `import {TimelineComposition as Video} from ${JSON.stringify(path.join(observer.codeRoot, "src/components/TimelineComposition"))};`
    : `import {MaterialFill} from ${JSON.stringify(path.join(observer.codeRoot, "src/motion/library/backgrounds/MaterialFill"))};const Video=()=> <MaterialFill material="brushed" fill="ground" base="#777777" ground="#222222" seed={4} angle={15} period={30} cell={0.1} depth={2} at={0} fadeFrames={0} tile={{from:0.1,to:0.5,frames:9,radius:0.1}}/>;`;
  const entry = `import React from 'react';import {registerRoot,Composition} from 'remotion';${source}registerRoot(()=> <Composition id=${JSON.stringify(compositionId)} component={Video} width={1920} height={1080} fps={30} durationInFrames={${frames}} defaultProps={${JSON.stringify(props)}}/>);`;
  await observer.operation(
    "fixture:render-entry",
    [],
    ["entry.tsx"],
    () => writeFileSync(contained(observer.workspace, "entry.tsx"), entry, { flag: "wx" }),
    { authority: "fixture", kind: "preparation" },
  );
  const identity = () =>
    recording
      ? captureRenderIdentity(id, "landscape", { rootDir: observer.workspace, timeline: true })
      : captureBespokeIdentity(id, "landscape", { rootDir: observer.workspace });
  const before = identity();
  const request = DeliveryRequestSchema.parse({
    version: 1,
    projectId: id,
    mode: "draft",
    formats: ["landscape"],
    variants: ["captioned"],
    placements: ["youtube"],
    timeline: recording,
    approvalMode: "manual",
    loudness: { targetLufs: -21, toleranceLu: 3, maxTruePeakDb: -1, audioRequired: recording },
  });
  const snapshot = await observer.operation(
    "@delivery/snapshot",
    before.sources.map((p) => p.path),
    [],
    () => captureDeliverySnapshot(request, { rootDir: observer.workspace }),
  );
  await observer.operation(
    "@render/production-components",
    [...before.sources.map((p) => p.path), "entry.tsx"],
    [output, output + ".receipt.json"],
    async () => {
      if (!existsSync(path.join(observer.workspace, "node_modules")))
        symlinkSync(path.join(observer.codeRoot, "node_modules"), path.join(observer.workspace, "node_modules"), "dir");
      const outDir = path.join(observer.workspace, ".cache/render-bundle");
      let browser: Awaited<ReturnType<typeof openBrowser>> | undefined;
      const cancellation = makeCancelSignal(),
        abort = () => cancellation.cancel();
      const timer = setTimeout(abort, Math.max(1, observer.remainingMs));
      observer.signal?.addEventListener("abort", abort, { once: true });
      try {
        const serveUrl = await bundle({
          entryPoint: contained(observer.workspace, "entry.tsx"),
          publicDir: path.join(observer.workspace, "public"),
          outDir,
          webpackOverride: (config) => {
            const c = enableTailwind(config);
            return {
              ...c,
              resolve: {
                ...c.resolve,
                alias: {
                  ...c.resolve?.alias,
                  [path.join(observer.codeRoot, "src/lib/fonts")]: path.join(
                    observer.codeRoot,
                    "tests/fixtures/offline-fonts.ts",
                  ),
                },
              },
            };
          },
        });
        browser = await openBrowser("chrome", { browserExecutable: browserPath, logLevel: "error" });
        const composition = await selectComposition({
          serveUrl,
          id: compositionId,
          inputProps: props,
          puppeteerInstance: browser,
          timeoutInMilliseconds: 30000,
        });
        mkdirSync(path.dirname(contained(observer.workspace, output)), { recursive: true });
        await renderMedia({
          serveUrl,
          composition,
          inputProps: props,
          outputLocation: contained(observer.workspace, output),
          codec: "h264",
          concurrency: 2,
          puppeteerInstance: browser,
          cancelSignal: cancellation.cancelSignal,
          timeoutInMilliseconds: 30000,
          logLevel: "error",
        });
        const decoded = spawnSync(
          "ffmpeg",
          ["-v", "error", "-nostdin", "-i", contained(observer.workspace, output), "-f", "null", "-"],
          { encoding: "utf8", timeout: 30000 },
        );
        if (decoded.status !== 0) fail("Rendered video could not be decoded");
        publishRenderReceipt(contained(observer.workspace, output), before, identity(), observer.workspace);
      } finally {
        clearTimeout(timer);
        observer.signal?.removeEventListener("abort", abort);
        await browser?.close({ silent: true });
        rmSync(outDir, { recursive: true, force: true });
      }
    },
  );
  const expected = {
    path: output,
    sha256: observer.pin(output).sha256,
    sourceSnapshotHash: before.sourceSnapshotHash,
    propsHash: before.propsHash,
    frames,
  };
  const consumed = await observer.operation(
    "@delivery/check",
    [output, output + ".receipt.json"],
    ["delivery-check.json"],
    () => {
      const result = checkDelivery(request, snapshot.value.snapshot, { rootDir: observer.workspace });
      copyFileSync(result.report, contained(observer.workspace, "delivery-check.json"));
      assertRenderedDraft(result, expected);
      return result;
    },
  );
  observedHandoff(observer.events, consumed.event, output);
  await observer.operation(
    "@delivery/production-review-refusal",
    [output, output + ".receipt.json"],
    ["production-review-check.json"],
    () => {
      const unreviewed = checkDelivery({ ...request, mode: "production" }, snapshot.value.snapshot, {
        rootDir: observer.workspace,
      });
      copyFileSync(unreviewed.report, contained(observer.workspace, "production-review-check.json"));
      assertRenderedDraft(unreviewed, expected);
      if (
        !["CREATIVE_APPROVAL_REQUIRED", "VISUAL_REVIEW_REQUIRED", ...(recording ? ["RIGHTS_UNCONFIRMED"] : [])].every(
          (code) => unreviewed.blockers.some((f) => f.code === code),
        ) ||
        existsSync(path.join(observer.workspace, "out", id, "releases"))
      )
        fail("Production review/rights gates were bypassed");
    },
    { kind: "validation" },
  );
  await observer.operation(
    "@delivery/corrupt-receipt-refusal",
    [],
    ["corrupt-receipt-check.json"],
    () => {
      const file = output + ".receipt.json",
        original = observer.read(file);
      try {
        writeFileSync(
          contained(observer.workspace, file),
          JSON.stringify({ ...JSON.parse(original.toString()), outputSha256: "0".repeat(64) }),
        );
        const corrupt = checkDelivery(request, snapshot.value.snapshot, { rootDir: observer.workspace });
        copyFileSync(corrupt.report, contained(observer.workspace, "corrupt-receipt-check.json"));
        if (!corrupt.blockers.some((f) => f.code === "RENDER_BINDING_MISSING"))
          fail("Corrupt renderer receipt was not refused");
      } finally {
        writeFileSync(contained(observer.workspace, file), original);
      }
    },
    { kind: "validation" },
  );
  await observer.operation(
    "@delivery/stale-source-refusal",
    [],
    [],
    () => {
      const file = contained(
        observer.workspace,
        `${project}/${recording ? "project.json" : "pipeline/motion-plan.json"}`,
      );
      writeFileSync(
        file,
        JSON.stringify(
          recording
            ? { ...JSON.parse(observer.read(`${project}/project.json`).toString()), name: "Changed source" }
            : { fps: 30, shots: [{ id: "one", startFrame: 0, durationFrames: 12 }] },
        ),
      );
      const stale = checkDelivery(request, snapshot.value.snapshot, { rootDir: observer.workspace });
      if (stale.productionReady || !stale.blockers.some((f) => /SOURCE|SNAPSHOT|RENDER|STALE/.test(f.code)))
        fail("Changed source did not invalidate delivery evidence");
    },
    { kind: "validation" },
  );
  return { outcome: "draft-refused" };
}
