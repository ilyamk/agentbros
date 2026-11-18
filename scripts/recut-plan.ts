/**
 * Transcript (+ optional VAD speech mask) and source video to a proposed, unapproved
 * recording-edit request (version 3) and a markdown plan a person reviews cut by cut.
 *
 * Usage:
 *   pnpm recut:plan --transcript public/projects/x/pipeline/transcript.json --project-id x-recut
 *   pnpm recut:plan --transcript t.json --speech-mask speech-mask.json --project-id x-recut --reject C3,C7 --force
 *
 * Approval (studio console only, RFC 0004 A15): `--project <source> --approve <edit hash> --answer=<the user's words>`
 * writes the request's `review` for the plan's current edit hash; it runs only with the console's grant for exactly
 * this argv (src/lib/footage/approve.ts), so an agent never approves a plan.
 */
import path from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { CliErrorObject, parseArgs, runScript, emitProgress } from "../src/lib/cli";
import { hashFile } from "../src/lib/assets/registry";
import { TranscriptSchema } from "../src/types/transcript";
import { SpeechMaskSchema } from "../src/types/speech-mask";
import {
  DEFAULT_RECUT_OPTIONS,
  likelyUnmarkedFillers,
  maskFromVad,
  planRecut,
  renderRecutMarkdown,
  type RecutSource,
} from "../src/lib/workflows/recut-plan";
import { probeRecordingTiming } from "../src/lib/workflows/recording-timing";
import { runRecordingEditWorkflow } from "../src/lib/workflows/recording-edit";
import { noteMetric } from "../src/lib/memory/capture";
import { approveEditHash } from "../src/lib/footage/approve";
import { GRANT_AT_ENV, GRANT_ENV } from "../src/lib/console/grant";

// runScript's pause check removes the console grant from process.env so children never inherit it; --approve reads
// it for this process only, so it is taken before runScript starts.
const grantEnv: NodeJS.ProcessEnv = { [GRANT_ENV]: process.env[GRANT_ENV], [GRANT_AT_ENV]: process.env[GRANT_AT_ENV] };

const d = DEFAULT_RECUT_OPTIONS;
/** `START:END` in source seconds, or null when the flag is absent. */
function parseSpan(value: unknown): { startSec: number; endSec: number } | null {
  if (value === undefined) return null;
  const match = /^\s*(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)\s*$/.exec(String(value));
  if (!match || Number(match[2]) <= Number(match[1]))
    throw new CliErrorObject({
      code: "INVALID_INPUT",
      message: `--room-tone-span takes START:END in source seconds with END after START, e.g. 12.4:12.9 (got ${String(value)})`,
    });
  return { startSec: Number(match[1]), endSec: Number(match[2]) };
}
/** `--approve`: the user's approval of the edit hash, given in the studio console (src/lib/footage/approve.ts). */
function approveMode() {
  const args = parseArgs([
    { name: "project", required: true, description: "Source project of the recording (the console's decision)" },
    { name: "approve", required: true, description: "The plan's edit hash the user approves (studio console only)" },
    { name: "answer", required: true, description: "The user's own words, verbatim" },
    { name: "decision", required: true, description: "The console decision id (its intent must be on disk)" },
  ] as const);
  const result = approveEditHash({
    rootDir: process.cwd(),
    project: String(args.project),
    editHash: String(args.approve),
    decision: String(args.decision),
    answer: String(args.answer),
    argv: process.argv.slice(2),
    env: grantEnv,
  });
  return {
    outputs: result.unchanged ? [] : [result.request],
    metadata: {
      approvedEditHash: result.approvedEditHash,
      reviewer: result.reviewer,
      reviewedAt: result.reviewedAt,
      unchanged: result.unchanged,
      nextAction: "pnpm footage:next --project <source> creates the recut from the approved plan",
      apiCalls: 0,
      apiSpendUsd: 0,
    },
  };
}

const approving = process.argv.slice(2).some((token) => token === "--approve" || token.startsWith("--approve="));

void runScript(async () => {
  if (approving) return approveMode();
  const args = parseArgs([
    { name: "transcript", required: true, description: "TranscriptSchema JSON (transcribe or speech:local)" },
    { name: "project-id", required: true, description: "New project ID the reviewed recut will be created as" },
    { name: "source", description: "Source video; default transcript.source.file" },
    {
      name: "speech-mask",
      description:
        "speech:local VAD file (SpeechMaskSchema, pipeline/speech-mask.json); its source sha256 must match the transcript",
    },
    { name: "name", description: 'Project name; default "Recut of <file>"' },
    { name: "formats", description: "Comma list of vertical,square,landscape; default from the source aspect" },
    { name: "output", description: "Request JSON path; default recut-request.json next to the transcript" },
    { name: "plan", description: "Markdown plan path; default recut-plan.md next to the request" },
    { name: "pre-pad-ms", type: "number", default: d.prePadMs, description: "Silence kept before a phrase (80–150)" },
    { name: "post-pad-ms", type: "number", default: d.postPadMs, description: "Silence kept after a phrase (150–250)" },
    {
      name: "long-pause-ms",
      type: "number",
      default: d.longPauseMs,
      description: "Pauses longer than this are shortened",
    },
    {
      name: "mid-pause-ms",
      type: "number",
      default: d.midPauseMs,
      description: "Shortened pause inside a sentence (250–400)",
    },
    {
      name: "sentence-pause-ms",
      type: "number",
      default: d.sentencePauseMs,
      description: "Shortened pause between sentences (250–400)",
    },
    { name: "fillers", type: "boolean", default: true, description: "Propose filler removals (--no-fillers to skip)" },
    {
      name: "retakes",
      type: "boolean",
      default: true,
      description: "Propose false-start and retake removals (--no-retakes to skip)",
    },
    {
      name: "crossfade-ms",
      type: "number",
      default: d.crossfadeMs,
      description: "Equal-power crossfade at each join (5–50)",
    },
    {
      name: "snap-search-ms",
      type: "number",
      default: d.snapSearchMs,
      description: "Search range for the quietest join point (0–33)",
    },
    {
      name: "room-tone",
      type: "boolean",
      default: false,
      description: "Lay the quietest 300ms of the source under each join",
    },
    { name: "room-tone-gain-db", type: "number", default: d.roomToneGainDb, description: "Room tone level" },
    {
      name: "room-tone-span",
      description:
        "START:END source seconds of a chosen room-tone span (e.g. a reviewed sfx:find-segment --kind texture candidate); implies --room-tone, checked for speech and words",
    },
    {
      name: "punch-in",
      type: "number",
      description: "Scale alternate spans (1.0–1.2, typically 1.12) to soften jump cuts",
    },
    { name: "reject", description: "Comma list of cut ids from an earlier plan to leave out" },
    { name: "force", type: "boolean", default: false, description: "Overwrite existing request and plan files" },
  ] as const);
  const fail = (message: string): never => {
    throw new CliErrorObject({ code: "VALIDATION", message });
  };
  const transcriptFile = path.resolve(String(args.transcript));
  if (!existsSync(transcriptFile))
    throw new CliErrorObject({ code: "FILE_NOT_FOUND", message: `Transcript missing: ${transcriptFile}` });
  const parsed = TranscriptSchema.safeParse(JSON.parse(readFileSync(transcriptFile, "utf8")));
  if (!parsed.success) fail(`Invalid transcript: ${parsed.error?.issues[0]?.message}`);
  const transcript = parsed.data!;
  const sourceFile = path.resolve(args.source ? String(args.source) : transcript.source.file);
  if (!existsSync(sourceFile))
    throw new CliErrorObject({ code: "FILE_NOT_FOUND", message: `Source video missing: ${sourceFile}` });
  const sha256 = hashFile(sourceFile);
  if (sha256 !== transcript.source.sha256)
    fail("Source video checksum differs from transcript.source.sha256; transcribe this file first");
  const maskParsed = args["speech-mask"]
    ? SpeechMaskSchema.safeParse(JSON.parse(readFileSync(path.resolve(String(args["speech-mask"])), "utf8")))
    : null;
  if (maskParsed && !maskParsed.success) fail(`Invalid speech mask: ${maskParsed.error.issues[0]?.message}`);
  const mask = maskParsed?.data ? maskFromVad(maskParsed.data) : null;
  const output = path.resolve(
    args.output ? String(args.output) : path.join(path.dirname(transcriptFile), "recut-request.json"),
  );
  const planFile = path.resolve(args.plan ? String(args.plan) : path.join(path.dirname(output), "recut-plan.md"));
  if (!args.force)
    for (const file of [output, planFile]) if (existsSync(file)) fail(`Refusing to overwrite ${file}; pass --force`);

  emitProgress("Probing source frames");
  const probe = JSON.parse(
    execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_streams", "-of", "json", sourceFile], {
      encoding: "utf8",
      timeout: 30000,
    }),
  ).streams[0];
  if (!probe) fail("Source has no video stream");
  const [num, den] = String(probe.r_frame_rate).split("/").map(Number);
  const relative = path.relative(process.cwd(), sourceFile);
  const file = relative.startsWith("..") || path.isAbsolute(relative) ? sourceFile : relative;
  const base = { file, sha256, version: `sha256:${sha256.slice(0, 12)}` };
  let source: RecutSource;
  const frameTimes = () =>
    JSON.parse(
      execFileSync(
        "ffprobe",
        [
          "-v",
          "error",
          "-select_streams",
          "v:0",
          "-show_frames",
          "-show_entries",
          "frame=best_effort_timestamp_time",
          "-of",
          "json",
          sourceFile,
        ],
        { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 120000 },
      ),
    ).frames as { best_effort_timestamp_time: string }[];
  const cfr30 =
    probe.r_frame_rate === "30/1" &&
    probe.avg_frame_rate === "30/1" &&
    (() => {
      const f = frameTimes();
      return f.every((x, i) => Math.abs(Number(x.best_effort_timestamp_time) - i / 30) <= 0.00002) ? f.length : 0;
    })();
  if (cfr30) source = { ...base, fps: { num: 30, den: 1 }, boundaries: null, frameCount: cfr30 };
  else {
    let timing: ReturnType<typeof probeRecordingTiming>;
    try {
      timing = probeRecordingTiming(sourceFile, {
        ...base,
        fps: { num, den },
        normalization: {
          targetFps: { num: 30, den: 1 },
          video: "timestamp-near",
          keepRounding: "outward",
          boundaryRounding: "nearest",
          audio: "preserve-clock",
        },
      });
    } catch (error) {
      return fail(`Source cannot be recut as it is: ${error instanceof Error ? error.message : String(error)}`);
    }
    source = { ...base, fps: { num, den }, boundaries: timing.seconds, frameCount: timing.frames };
  }

  emitProgress("Measuring audio levels");
  const rate = 16000;
  const pcm = execFileSync(
    "ffmpeg",
    ["-v", "error", "-i", sourceFile, "-map", "0:a:0", "-vn", "-ac", "1", "-ar", String(rate), "-f", "s16le", "-"],
    { maxBuffer: 1024 * 1024 * 1024, timeout: 300000 },
  );
  const samples = new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.length / 2));
  const prefix = new Float64Array(samples.length + 1);
  for (let i = 0; i < samples.length; i++) prefix[i + 1] = prefix[i] + (samples[i] / 32768) ** 2;
  const levelDb = (start: number, end: number) => {
    const a = Math.max(0, Math.min(samples.length, Math.round(start * rate))),
      b = Math.max(a + 1, Math.min(samples.length, Math.round(end * rate)));
    return (
      10 * Math.log10((prefix[Math.min(b, samples.length)] - prefix[Math.min(a, samples.length)]) / (b - a) + 1e-12)
    );
  };

  const formats = args.formats
    ? String(args.formats)
        .split(",")
        .map((f) => f.trim())
    : [probe.height > probe.width ? "vertical" : probe.height === probe.width ? "square" : "landscape"];
  if (!formats.every((f) => ["vertical", "square", "landscape"].includes(f)))
    fail("Formats must be vertical, square or landscape");
  let plan;
  try {
    plan = planRecut({
      transcript,
      source,
      mask,
      levelDb,
      projectId: String(args["project-id"]),
      name: args.name ? String(args.name) : `Recut of ${path.basename(sourceFile)}`,
      formats: formats as ("vertical" | "square" | "landscape")[],
      options: {
        prePadMs: Number(args["pre-pad-ms"]),
        postPadMs: Number(args["post-pad-ms"]),
        longPauseMs: Number(args["long-pause-ms"]),
        midPauseMs: Number(args["mid-pause-ms"]),
        sentencePauseMs: Number(args["sentence-pause-ms"]),
        fillers: args.fillers !== false,
        retakes: args.retakes !== false,
        crossfadeMs: Number(args["crossfade-ms"]),
        snapSearchMs: Number(args["snap-search-ms"]),
        roomTone: args["room-tone"] === true || args["room-tone-span"] !== undefined,
        roomToneSpan: parseSpan(args["room-tone-span"]),
        roomToneGainDb: Number(args["room-tone-gain-db"]),
        punchIn: args["punch-in"] === undefined ? null : Number(args["punch-in"]),
        reject: args.reject
          ? String(args.reject)
              .split(",")
              .map((id) => id.trim())
              .filter(Boolean)
          : [],
      },
    });
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }

  emitProgress("Validating the proposal with the recording-edit plan");
  let checked;
  try {
    checked = await runRecordingEditWorkflow(plan!.request, { action: "plan" });
  } catch (error) {
    fail(
      `Proposed request does not pass recording-edit plan: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const joins = (checked!.metadata.joins as { joins: Parameters<typeof renderRecutMarkdown>[1]["joins"] } | undefined)
    ?.joins;
  writeFileSync(output, JSON.stringify(plan!.request, null, 2) + "\n");
  const shown = (file: string) => {
    const r = path.relative(process.cwd(), file);
    return r.startsWith("..") || path.isAbsolute(r) ? file : r;
  };
  const rejectedIds = args.reject
    ? [
        ...new Set(
          String(args.reject)
            .split(",")
            .map((id) => id.trim())
            .filter(Boolean),
        ),
      ].sort()
    : [];
  const memoryWarning = rejectedIds.length
    ? noteMetric(
        {
          project: String(args["project-id"]),
          step: "4-approve",
          event: "rejected",
          value: rejectedIds.length,
          detail: `recut:plan --reject ${rejectedIds.join(",")}`,
        },
        undefined,
        { once: true },
      )
    : undefined;
  if (memoryWarning) emitProgress(memoryWarning);
  writeFileSync(
    planFile,
    renderRecutMarkdown(plan!, {
      transcriptFile: shown(transcriptFile),
      requestFile: shown(output),
      editHash: String(checked!.metadata.editHash),
      unmarkedFillers: likelyUnmarkedFillers(transcript),
      joins,
    }),
  );
  return {
    outputs: [output, planFile],
    metadata: {
      editHash: checked!.metadata.editHash,
      reviewStatus: "needs-review",
      durationInFrames: checked!.metadata.durationInFrames,
      summary: plan!.summary,
      cuts: plan!.cuts.map((c) => ({ id: c.id, kind: c.kind, startFrame: c.startFrame, endFrame: c.endFrame })),
      rejected: plan!.rejected.length,
      protectedSpans: plan!.protectedSpans.length,
      nextAction:
        "review the markdown plan and whole source; add review.approvedEditHash, then pnpm video:workflow --scenario recording-edit --action create --request <file>",
      apiCalls: 0,
      apiSpendUsd: 0,
      ...(memoryWarning ? { memoryWarning } : {}),
    },
  };
});
