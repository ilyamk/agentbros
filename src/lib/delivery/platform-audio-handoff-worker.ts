import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { DeliveryRequestSchema, DeliverySnapshotSchema } from "../../types/delivery";
import { readPlatformAudioJson, readPlatformAudioPin } from "./platform-audio-input";
import { checkDelivery, assertReadonlyNativeFontIdentities } from "./service";
import { captureSubtitleSelection } from "./subtitle-tracks";
import { readWorkflowEvidence } from "../workflows/local-evidence";
import { parseTimelineEditDocument } from "../timeline-ir/store";
import { captionCues, subtitleText } from "../captions/delivery";
import { nativePacket, type CheckedNativeDelivery } from "./platform-audio-packet";
import { HandoffJobSchema } from "./platform-audio-handoff-supervisor";
import { assertProjectId } from "../render-plan";
import { platformAudioMessage } from "./platform-audio-plan";
import { PlatformAudioPacketSchema } from "../../types/platform-audio-packet";
export function readHandoffWorkerInputs(root: string, input: unknown) {
  const job = HandoffJobSchema.parse(input);
  const requestFile = path.resolve(root, job.request),
    snapshotFile = path.resolve(root, job.snapshot);
  const requestRead = readPlatformAudioJson(requestFile, root, 1024 * 1024),
    request = DeliveryRequestSchema.parse(requestRead.value);
  assertProjectId(request.projectId);
  if (!request.platformAudioPlacement || !request.timeline || request.audioMaster)
    throw Error("Explicit supported music-free native timeline required");
  if (job.project && job.project !== request.projectId) throw Error("Scoped project differs from supplied request");
  const project = path.join(root, "public/projects", request.projectId),
    snapshotRead = readPlatformAudioJson(snapshotFile, project, 16 * 1024 * 1024),
    snapshot = DeliverySnapshotSchema.parse(snapshotRead.value);
  const forbidden = (file: string) => file.split(/[\\/]/).some((p) => /^\.env(?:\.|$)/.test(p));
  const evidence = [
    ...request.platformAudioPlacement.entries.flatMap((e) => [
      ...Object.values(e.evidence),
      e.selectionReview.evidence,
      e.marksReview.evidence,
    ]),
    ...request.platformAudioPlacement.sourceReviews.map((e) => e.evidence),
    ...request.platformAudioPlacement.outputReviews.map((e) => e.evidence),
  ];
  if (
    snapshot.identities.flatMap((i) => i.sources).some((s) => forbidden(s.path)) ||
    snapshot.platformAudioSelection?.sources.some((s) => forbidden(s.path)) ||
    evidence.some((e) => forbidden(e.file))
  )
    throw Error("Environment files are not handoff evidence");
  const inputPins = () => {
    if (
      readPlatformAudioPin(requestFile, root, 1024 * 1024).sha256 !== requestRead.sha256 ||
      readPlatformAudioPin(snapshotFile, project, 16 * 1024 * 1024).sha256 !== snapshotRead.sha256
    )
      throw Error("Handoff request/snapshot changed");
  };
  const recovered = job.recover
    ? PlatformAudioPacketSchema.parse(
        readPlatformAudioJson(
          path.join(root, "out", request.projectId, "handoffs", job.recover, "handoff.json"),
          path.join(root, "out", request.projectId),
          1024 * 1024,
        ).value,
      )
    : undefined;
  if (recovered && (recovered.id !== job.recover || recovered.projectId !== request.projectId))
    throw Error("Recovery marker identity mismatch");
  if (recovered) {
    inputPins();
    assertReadonlyNativeFontIdentities(root, request, snapshot);
    inputPins();
  }
  return { request, snapshot, project, inputPins, recovered };
}
/** Shared fixed-worker checker; no caller gate override or execution adapter. */
export function checkNativeHandoff(
  root: string,
  inputs: ReturnType<typeof readHandoffWorkerInputs>,
): CheckedNativeDelivery {
  const { request, snapshot, project, inputPins, recovered } = inputs;
  inputPins();
  const result = checkDelivery(request, snapshot, {
    rootDir: root,
    ...(recovered ? { persistReport: false as const } : {}),
  });
  if (
    result.blockers.length ||
    result.productionReady ||
    result.manifest.platformAudioPlacement?.localStatus !== "ready-for-manual-placement"
  )
    throw Error("Existing delivery gates refuse native packet");
  const selected = captureSubtitleSelection(root, request, snapshot.identities);
  let subtitles: { name: string; content: string }[] = selected?.files ?? [];
  if (request.subtitles.length) {
    const read = readWorkflowEvidence(path.join(project, "pipeline/timeline-edit.json"), project, 8 * 1024 * 1024),
      ir = parseTimelineEditDocument(JSON.parse(read.text)).timeline,
      cues = captionCues(ir);
    if (!cues.length) throw Error("Requested subtitles have no aligned cues");
    subtitles = request.subtitles.map((format) => ({
      name: "captions." + format,
      content: subtitleText(cues, format),
    }));
  }
  inputPins();
  return {
    manifest: result.manifest,
    report: recovered ? path.join(root, recovered.checkReport.file) : result.report,
    subtitles,
  };
}
const nonce = process.argv[2];
let used = false;
async function start(raw: unknown) {
  if (used) throw Error("Worker may execute only once");
  used = true;
  const message = z
      .object({
        type: z.literal("start"),
        nonce: z.literal(nonce),
        parentPid: z.number().int().positive(),
        job: HandoffJobSchema,
      })
      .strict()
      .parse(raw),
    root = process.cwd();
  const inputs = readHandoffWorkerInputs(root, message.job),
    { request, inputPins: checkPins } = inputs;
  const inputPins = () => {
    if (process.ppid !== message.parentPid) throw Error("Owning parent no longer live");
    checkPins();
  };
  inputPins();
  const check = (): CheckedNativeDelivery => {
    inputPins();
    const checked = checkNativeHandoff(root, inputs);
    inputPins();
    return checked;
  };
  const result = nativePacket(root, request, check, message.job.recover);
  inputPins();
  return { ok: true, ...result };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!nonce || !/^[a-f0-9]{48}$/.test(nonce) || !process.send)
    throw Error("Private authenticated worker entrypoint required");
  const disconnect = () => {
    try {
      if (process.connected) process.disconnect?.();
    } catch {
      process.exitCode = 1;
    }
  };
  process.on("error", () => {
    process.exitCode = 1;
    disconnect();
  });
  process.stdout.on("error", () => {
    process.exitCode = 1;
    disconnect();
  });
  process.once("message", (raw) => {
    void start(raw)
      .then(
        (result) => {
          process.stdout.write(JSON.stringify(result) + "\n");
          process.exitCode = 0;
        },
        (error) => {
          process.stdout.write(
            JSON.stringify({
              ok: false,
              state: "draft-needs-review",
              productionReady: false,
              status: "pending-manual",
              publication: "unknown",
              error: "VALIDATION",
              message: platformAudioMessage(error),
            }) + "\n",
          );
          process.exitCode = 1;
        },
      )
      .finally(disconnect);
  });
  process.send({ type: "ready", nonce, pid: process.pid }, (error) => {
    if (error) {
      process.exitCode = 1;
      disconnect();
    }
  });
}
