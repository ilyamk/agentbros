import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";
import { SpeechReplacementSchema, type SpeechReplacementRequest } from "../../types/speech-replacement";
import type { SpeechReplacementEdit } from "../../types/timeline";
import { TranscriptSchema } from "../../types/transcript";
import { inspectAsset } from "../assets/inspect";
import { importAsset, readAssetRegistry } from "../assets/registry";
import { assertPathWithin } from "../cli";
import { requireUserWords } from "../cli/user-words";
import { canonicalInputIdentity } from "../jobs/identity";
import { immutableWrite } from "../jobs/model-artifacts";
import { runPreparationFfmpeg } from "../model-preparation/prepare";
import { TimelineEditStore } from "../timeline-ir/store";
import { clipDuration, outputToSource, sourceToOutput } from "../timeline-ir/compiler";
import { add, compare, div, fraction, mul, numeric } from "../timeline-ir/rational";
import { sameSpokenWords, validateDirectedText } from "./direction";
import { projectOutput, regularInput, verifyVoiceRef } from "./files";
import { executeStudioAudio, operationQuote, speechAlignmentPath, type StudioExecution } from "./operations";

const sampleRate = 48_000;
const seconds = (value: number) => fraction(Math.round(value * 1_000_000), 1_000_000);
const clock = (time: number) => Math.round(time * sampleRate);
const readJson = (file: string): unknown => JSON.parse(readFileSync(file, "utf8"));
const wordSchema = z.object({ text: z.string(), start: z.number().nonnegative(), end: z.number().positive() });
const takeSchema = z.object({
  sha256: z.string(),
  assetId: z.string(),
  alignmentSha256: z.string().optional(),
  operationId: z.string(),
});

function pin(root: string, value: { file: string; sha256: string }, maxBytes?: number) {
  const actual = regularInput(root, value.file, root, maxBytes);
  if (actual.sha256 !== value.sha256) throw Error("Pinned speech input changed");
  return actual;
}

function transcript(root: string, source: { file: string; sha256: string }, sha256: string) {
  const report = TranscriptSchema.parse(readJson(pin(root, source, 32 * 1024 * 1024).file));
  if (report.source.sha256 !== sha256 || report.engine.timing !== "native")
    throw Error("Speech replacement needs native word times from these exact bytes");
  return report.words.filter((word) => word.kind !== "event");
}

function renderAudio(file: string, output: string, filter: string) {
  runPreparationFfmpeg([
    "-i",
    file,
    "-map",
    "0:a:0",
    "-vn",
    "-af",
    `aresample=${sampleRate},${filter}`,
    "-c:a",
    "pcm_s16le",
    "-ar",
    String(sampleRate),
    "-map_metadata",
    "-1",
    output,
  ]);
}

function conformance(duration: number, words: z.infer<typeof wordSchema>[]) {
  const samples = clock(duration);
  const fade = Math.floor(Math.min(0.005, words[0]!.start, duration - words.at(-1)!.end) * sampleRate);
  const filters = [`apad=whole_len=${samples}`, `atrim=end_sample=${samples}`, "asetpts=PTS-STARTPTS"];
  if (fade > 0) filters.push(`afade=t=in:ss=0:ns=${fade}`, `afade=t=out:ss=${samples - fade}:ns=${fade}`);
  return filters.join(",");
}

function writeReviewPreview(options: {
  audio: string;
  output: string;
  original: string;
  start: number;
  end: number;
  duration: number;
  filter: string;
}) {
  const { audio, output, original, start, end, duration, filter } = options;
  const channels = `aresample=${sampleRate},aformat=channel_layouts=stereo`;
  const handles = [
    [Math.max(0, start - 0.3), start],
    [end, Math.min(duration, end + 0.3)],
  ];
  const pieces = handles.map(([from, to], index) =>
    clock(to!) > clock(from!)
      ? `[0:a:0]${channels},atrim=start_sample=${clock(from!)}:end_sample=${clock(to!)},asetpts=PTS-STARTPTS[h${index}];`
      : "",
  );
  const sequence = `${pieces[0] ? "[h0]" : ""}[replacement]${pieces[1] ? "[h1]" : ""}`;
  const graph = `${pieces.join("")}[1:a:0]${channels},${filter}[replacement];${sequence}concat=n=${1 + pieces.filter(Boolean).length}:v=0:a=1[preview]`;
  const dir = mkdtempSync(path.join(tmpdir(), "speech-preview-"));
  try {
    const temporary = path.join(dir, "preview.wav");
    runPreparationFfmpeg([
      "-i",
      original,
      "-i",
      audio,
      "-filter_complex",
      graph,
      "-map",
      "[preview]",
      "-c:a",
      "pcm_s16le",
      temporary,
    ]);
    immutableWrite(output, readFileSync(temporary));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function inputPlan(request: SpeechReplacementRequest, root: string, editStore: TimelineEditStore, id: string) {
  const document = editStore.read();
  if (document.revision !== request.revision) throw Error("Timeline revision changed; make a fresh replacement plan");
  const ir = document.timeline;
  if (ir.projectId !== request.projectId) throw Error("Timeline project differs from replacement request");
  const track = ir.tracks.find((row) => row.id === request.trackId);
  const clip = track?.clips.find((row) => row.id === request.clipId);
  if (!clip || !track || !["presenter", "voiceover"].includes(track.kind))
    throw Error("Select a presenter or voiceover clip");
  const presenter = track.kind === "presenter";
  const legacy = ir.legacyProject?.talkingHead as { audioSource?: string } | undefined;
  if (presenter && legacy?.audioSource !== "embedded")
    throw Error("Select the separate voiceover track for this presenter");
  const registry = readAssetRegistry(request.projectId, root).assets;
  const original = registry.find((row) => row.id === clip.assetId);
  const resolve = (source: string) => {
    const destination = path.resolve(root, "public", source);
    assertPathWithin(path.resolve(root, "public"), destination);
    return destination;
  };
  const media = pin(root, { file: resolve(original?.files.original ?? clip.assetId), sha256: request.sourceSha256 });
  if (original && original.hash !== media.sha256) throw Error("Source registry checksum changed");
  const metadata = inspectAsset(media.file).media;
  if (!metadata.hasAudio) throw Error("The selected source does not contain audio");
  const sourceWords = transcript(root, request.sourceTranscript, media.sha256);
  const { range } = request;
  const fps = numeric(ir.timebase);
  let start: number, end: number;
  if ("startFrame" in range) {
    start = range.startFrame;
    end = range.endFrame;
  } else {
    const first = sourceWords.findIndex((word) => word.id === range.firstWordId);
    const last = sourceWords.findIndex((word) => word.id === range.lastWordId);
    if (first < 0 || last < first) throw Error("Select an ordered source word range");
    const toOutput = (time: number) =>
      numeric(sourceToOutput(clip, mul(seconds(time), clip.source.timebase), ir.timebase));
    start = Math.floor(toOutput(sourceWords[first]!.startSec) + 1e-7);
    end = Math.ceil(toOutput(sourceWords[last]!.endSec) - 1e-7);
  }
  if (end <= start || start < numeric(clip.start) || end > numeric(add(clip.start, clipDuration(clip, ir.timebase))))
    throw Error("Speech window must fit inside one timeline clip");
  if (numeric(clip.rate) !== 1) throw Error("Conform retimed source speech before replacement");
  const toSource = (frame: number) =>
    numeric(div(outputToSource(clip, fraction(frame), ir.timebase), clip.source.timebase));
  const fromSec = toSource(start),
    toSec = toSource(end);
  if (toSec > (metadata.durationSec ?? 0) + 0.001 || toSec - fromSec > 300)
    throw Error("Speech window exceeds source duration or five minutes");
  const words = sourceWords.filter((word) => word.startSec < toSec - 1e-7 && word.endSec > fromSec + 1e-7);
  if (!words.length || words.some((word) => word.startSec < fromSec - 1e-6 || word.endSec > toSec + 1e-6))
    throw Error("The window is empty or cuts through an original word");
  if (
    new Set(words.map((word) => word.speaker)).size > 1 ||
    words.some((word, index) => index > 0 && word.startSec < words[index - 1]!.endSec - 0.02)
  )
    throw Error("Choose a window with one isolated speaker");
  if ("firstWordId" in range && (words[0]!.id !== range.firstWordId || words.at(-1)!.id !== range.lastWordId))
    throw Error("Frame rounding includes another word; use reviewed frame boundaries");
  const sameWords = sameSpokenWords(words.map((word) => word.text).join(" "), request.approvedText);
  if (request.method === "voice-change" && !request.performance && !sameWords)
    throw Error("Voice Change preserves words; supply a recording of the new line or choose TTS");
  if (request.picture.mode === "unchanged-lips" && !sameWords)
    throw Error("Different words require a cutaway or a lip-synced picture");
  if (presenter && request.picture.mode === "offscreen")
    throw Error("An embedded presenter must use unchanged lips, a cutaway or a lip-synced picture");
  const duration = (end - start) / fps;
  let pictureAssetId: string | undefined;
  if ("assetId" in request.picture) {
    const pictureId = request.picture.assetId;
    const picture = registry.find((entry) => entry.id === pictureId);
    if (!presenter || !picture || picture.kind !== "video" || picture.media.durationSec! + 0.001 < duration)
      throw Error("Supply an imported presenter-length replacement video");
    pin(root, { file: resolve(picture.files.original), sha256: picture.hash });
    pictureAssetId = picture.id;
  }
  const edit: SpeechReplacementEdit = {
    type: "speech-replacement",
    trackId: request.trackId,
    clipId: request.clipId,
    start: fraction(start),
    end: fraction(end),
    replacementId: id,
    assetId: `sha256:${"0".repeat(64)}`,
    captions: [{ id: "placeholder", text: request.approvedText, start: fraction(0), end: fraction(end - start) }],
    ...(request.captionTrackId ? { captionTrackId: request.captionTrackId } : {}),
    ...(pictureAssetId ? { pictureAssetId } : {}),
  };
  editStore.dryRun(edit, request.revision);
  return {
    media,
    words,
    fromSec,
    toSec,
    fps,
    timebase: ir.timebase,
    duration,
    sourceDuration: metadata.durationSec!,
    edit,
  };
}

type Options = StudioExecution & {
  action?: "plan" | "prepare" | "status" | "apply";
  alignment?: string;
  preview?: boolean;
  reviewSha256?: string;
  answer?: string;
};

export async function runSpeechReplacement(input: unknown, options: Options = {}) {
  const request = SpeechReplacementSchema.parse(input);
  const root = path.resolve(options.rootDir ?? process.cwd());
  const { projectId } = request;
  const project = projectOutput(root, projectId, `public/projects/${projectId}/pipeline/timeline-edit.json`);
  const store = new TimelineEditStore(project.file);
  const { maxCostUsd, ...reviewedInput } = request;
  const planHash = canonicalInputIdentity(reviewedInput).sha256;
  const id = `speech-${planHash.slice(0, 24)}`;
  const base = projectOutput(root, projectId, path.join(project.project, "voiceover", "replacements", id)).file;
  const audio = request.method === "existing" ? pin(root, request.performance).file : `${base}.mp3`;
  const action = options.action ?? "plan";
  const history = store.read();
  if (action === "status") {
    const applied = history.undo.find(
      ({ command }) => command.type === "speech-replacement" && command.replacementId === id,
    )?.command;
    if (applied?.type === "speech-replacement") {
      const { timeline } = history;
      const clip = timeline.tracks
        .filter((track) => track.kind === "voiceover")
        .flatMap((track) => track.clips)
        .find((candidate) => candidate.id === id);
      const unchanged =
        clip &&
        clip.assetId === applied.assetId &&
        compare(clip.start, applied.start) === 0 &&
        compare(add(clip.start, clipDuration(clip, timeline.timebase)), applied.end) === 0 &&
        JSON.stringify(clip.captions) === JSON.stringify(applied.captions);
      const view = applied.pictureAssetId
        ? timeline.tracks
            .find((track) => track.id === applied.trackId)
            ?.clips.find((candidate) => candidate.id === `${id}-picture`)
        : undefined;
      const pictureMatches =
        !applied.pictureAssetId ||
        (view?.assetId === applied.pictureAssetId &&
          view.payload?.speechMuted === true &&
          compare(view.start, applied.start) === 0);
      return {
        outputs: [project.file],
        metadata: {
          state: unchanged && pictureMatches ? "applied" : "superseded",
          revision: history.revision,
          planHash,
        },
      };
    }
    if (history.revision !== request.revision)
      return { outputs: [project.file], metadata: { state: "stale", revision: history.revision, planHash } };
  }
  const plan = inputPlan(request, root, store, id);
  if (request.method !== "existing") {
    verifyVoiceRef(root, request.voiceRef, root, request.method);
    if (request.voiceRef.manifest && !request.voiceRef.selection)
      throw Error("Select a listening-approved clone for the replacement model and language");
  }
  const performance =
    request.method === "voice-change" && request.performance ? pin(root, request.performance) : undefined;
  const spoken = request.method === "tts" ? (request.directedText ?? request.approvedText) : undefined;
  if (spoken) validateDirectedText(request.approvedText, spoken);
  const chargeDuration = performance ? inspectAsset(performance.file).media.durationSec! : plan.toSec - plan.fromSec;
  if (request.method === "voice-change" && (!(chargeDuration > 0) || chargeDuration > 300))
    throw Error("Voice Change requires a valid performance of at most five minutes");
  const quote =
    request.method === "existing"
      ? null
      : operationQuote(
          `elevenlabs:${request.voiceRef.model}`,
          maxCostUsd,
          spoken ? spoken.length / 1000 : chargeDuration / 60,
        );
  const takeFile = `${audio}.take.json`;
  const overview = {
    planHash,
    revision: request.revision,
    window: { start: plan.edit.start, end: plan.edit.end, durationSec: plan.duration },
    quote,
    executable: request.method === "existing" || Boolean(quote),
  };
  if (action === "plan") return { outputs: [], metadata: { state: "planned", ...overview } };
  if (action === "prepare" && request.method !== "existing") {
    if (options.dryRun !== false) throw Error("Prepare requires an explicit --dry-run=false");
    if (!quote) throw Error("Supply an authorised maxCostUsd before preparing the replacement");
    const tempRoot = path.join(root, ".cache", "speech-replacement");
    assertPathWithin(root, tempRoot);
    mkdirSync(tempRoot, { recursive: true, mode: 0o700 });
    const directory = mkdtempSync(path.join(tempRoot, "source-"));
    try {
      const sliced = path.join(directory, "line.wav");
      if (request.method === "voice-change" && !performance)
        renderAudio(
          plan.media.file,
          sliced,
          `atrim=start_sample=${clock(plan.fromSec)}:end_sample=${clock(plan.toSec)},asetpts=PTS-STARTPTS`,
        );
      pin(root, plan.media);
      if (performance) pin(root, performance);
      const result = await executeStudioAudio(
        {
          version: 1,
          projectId,
          output: audio,
          voiceRef: request.voiceRef,
          model: request.voiceRef.model,
          language: request.language,
          operationId: id,
          maxCostUsd,
          ...(request.method === "tts"
            ? { task: "tts", text: spoken, approvedText: request.approvedText, lineId: id }
            : {
                task: "voice-change",
                source: performance?.file ?? sliced,
                removeBackgroundNoise: request.removeBackgroundNoise,
              }),
        },
        { ...options, rootDir: root },
      );
      return { ...result, metadata: { ...result.metadata, ...overview } };
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
  const take = request.method !== "existing" && existsSync(takeFile) ? takeSchema.parse(readJson(takeFile)) : undefined;
  if (request.method !== "existing" && !take) {
    if (action === "apply") throw Error("Prepare the replacement before applying");
    return { outputs: [], metadata: { state: "pending-preparation", ...overview } };
  }
  const replacement = regularInput(root, audio);
  if (take && (take.sha256 !== replacement.sha256 || take.operationId !== id))
    throw Error("Replacement take does not match this plan");
  let words: z.infer<typeof wordSchema>[];
  let alignmentHash: string;
  if (options.alignment) {
    const alignment = regularInput(root, options.alignment, root, 32 * 1024 * 1024);
    alignmentHash = alignment.sha256;
    words = transcript(root, alignment, replacement.sha256).map((word) => ({
      text: word.text,
      start: word.startSec,
      end: word.endSec,
    }));
  } else if (take?.alignmentSha256) {
    const alignment = pin(root, { file: speechAlignmentPath(audio), sha256: take.alignmentSha256 }, 32 * 1024 * 1024);
    alignmentHash = alignment.sha256;
    const sidecar = z.object({ sourceSha256: z.string(), words: z.array(wordSchema) }).parse(readJson(alignment.file));
    if (sidecar.sourceSha256 !== replacement.sha256) throw Error("Replacement word clock belongs to a different take");
    words = sidecar.words;
  } else {
    if (action === "apply") throw Error("Align the replacement audio first and pass --alignment");
    return { outputs: [audio], metadata: { state: "pending-alignment", ...overview } };
  }
  if (!words.length || !sameSpokenWords(request.approvedText, words.map((word) => word.text).join(" ")))
    throw Error("The replacement does not match the approved words");
  const durationSec = inspectAsset(audio).media.durationSec ?? 0;
  if (
    words.some(
      (word, index) =>
        word.end <= word.start ||
        word.end > Math.min(durationSec + 0.001, plan.duration) ||
        (index > 0 && word.start < words[index - 1]!.end - 0.02),
    )
  )
    throw Error("Replacement word timing does not fit the window; prepare another take");
  if (request.picture.mode === "unchanged-lips") {
    const tolerance = 1 / plan.fps;
    if (
      words.length !== plan.words.length ||
      words.some((word, index) => {
        const original = plan.words[index]!;
        return (
          Math.max(
            Math.abs(word.start + plan.fromSec - original.startSec),
            Math.abs(word.end + plan.fromSec - original.endSec),
          ) > tolerance
        );
      })
    )
      throw Error("Word clocks drift more than one frame; use a cutaway or lip-sync");
  }
  const reviewSha256 = canonicalInputIdentity({ planHash, take: replacement.sha256, alignment: alignmentHash }).sha256;
  const filter = conformance(plan.duration, words);
  if (action !== "apply") {
    const outputs = [audio];
    if (options.preview) {
      const output = projectOutput(root, projectId, `${base}.${reviewSha256.slice(0, 12)}.preview.wav`).file;
      writeReviewPreview({
        audio,
        output,
        original: plan.media.file,
        start: plan.fromSec,
        end: plan.toSec,
        duration: plan.sourceDuration,
        filter,
      });
      outputs.push(output);
    }
    return { outputs, metadata: { state: "ready-for-review", ...overview, reviewSha256 } };
  }
  if (options.reviewSha256 !== reviewSha256) throw Error("Review must bind the current take and alignment hash");
  const answer = requireUserWords(options.answer, "--answer");
  const tmp = mkdtempSync(path.join(tmpdir(), "speech-replacement-"));
  try {
    const conformed = path.join(tmp, "speech.wav");
    renderAudio(audio, conformed, filter);
    pin(root, replacement);
    pin(root, plan.media);
    const parent =
      take?.assetId ??
      importAsset({
        rootDir: root,
        projectId,
        sourceFile: replacement.file,
        provenance: { origin: "manual" },
      }).asset.id;
    const outputHash = regularInput(tmp, conformed, tmp).sha256;
    const asset = importAsset({
      rootDir: root,
      projectId,
      sourceFile: conformed,
      provenance: {
        origin: "manual",
        tool: "speech:replace",
        referenceAssetIds: parent === `sha256:${outputHash}` ? [] : [parent],
      },
    }).asset;
    const edit: SpeechReplacementEdit = {
      ...plan.edit,
      assetId: asset.id,
      captions: words.map((word, index) => ({
        id: `${id}-${index + 1}`,
        text: word.text,
        start: mul(seconds(word.start), plan.timebase),
        end: mul(seconds(word.end), plan.timebase),
      })),
    };
    const selection = `${base}.selection.json`;
    immutableWrite(
      selection,
      JSON.stringify(
        {
          version: 1,
          planHash,
          reviewSha256,
          answer,
          edit,
          sourceSha256: plan.media.sha256,
          takeSha256: replacement.sha256,
          alignmentSha256: alignmentHash,
        },
        null,
        2,
      ) + "\n",
    );
    const result = store.apply(edit, request.revision);
    return { outputs: [project.file, selection], metadata: { state: "applied", planHash, revision: result.revision } };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
