import { z } from "zod";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { WorkflowQualitySchema } from "../../types/workflow-quality";
import { TranscriptSchema } from "../../types/transcript";
import {
  AppleAssistanceResultSchema,
  AppleAudioResultSchema,
  AppleTextResultSchema,
  AppleTranslationResultSchema,
  AppleVisionResultSchema,
} from "../../types/apple-results";
import { LocalResultReceiptSchema, LocalTextRequestSchema } from "../../types/local-capabilities";
import { speechMetrics } from "../apple/verify";
import { boundedFile } from "../apple/runtime";
import { contained, digest, fail } from "./io";

type Box = { x: number; y: number; w: number; h: number };
export function boxIou(a: Box, b: Box) {
  const intersection =
    Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) *
    Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  const union = a.w * a.h + b.w * b.h - intersection;
  return union > 0 ? Math.min(1, Math.max(0, intersection / union)) : 0;
}
const fraction = (n: number, total: number) => (total ? n / total : 1);
function ids(actual: string[], expected: string[]) {
  return (
    actual.length === expected.length &&
    new Set(actual).size === actual.length &&
    actual.every((id, i) => id === expected[i])
  );
}
function unwrap(value: unknown): unknown {
  return value && typeof value === "object" && "result" in value ? value.result : value;
}

export function workflowQualityMetrics(
  task: z.infer<typeof WorkflowQualitySchema>["task"],
  candidate: unknown,
  reference: unknown,
  input: unknown,
): Record<string, number> {
  const actual = unwrap(candidate),
    expected = unwrap(reference);
  if (task === "speech.transcribe")
    return speechMetrics(TranscriptSchema.parse(actual), TranscriptSchema.parse(expected));
  if (task === "text.translate") {
    const source = LocalTextRequestSchema.parse(input),
      a = AppleTranslationResultSchema.parse(actual),
      r = AppleTranslationResultSchema.parse(expected);
    if (!r.units.length) fail("Translation quality references need substantive units");
    const order = ids(
      a.units.map((u) => u.id),
      source.units.map((u) => u.id),
    );
    const retained = source.units.every((u, i) =>
      [...source.protectedTerms.filter((t) => u.text.includes(t)), ...(u.text.match(/\d+(?:[.,]\d+)*/gu) ?? [])].every(
        (t) => a.units[i]?.text.includes(t),
      ),
    );
    return {
      ids: Number(order),
      languages: Number(a.sourceLanguage === source.sourceLanguage && a.targetLanguage === source.targetLanguage),
      constraints: Number(retained),
      exactReference: fraction(
        r.units.filter((u) => a.units.some((v) => v.id === u.id && v.text.normalize("NFC") === u.text.normalize("NFC")))
          .length,
        r.units.length,
      ),
    };
  }
  if (task === "vision") {
    const a = AppleVisionResultSchema.parse(actual),
      r = AppleVisionResultSchema.parse(expected);
    const overlap: number[] = [];
    for (const frame of r.frames)
      for (const key of ["faces", "people", "saliency"] as const) {
        const boxes = a.frames.find((f) => f.id === frame.id)?.[key] ?? [],
          used = new Set<number>();
        for (const box of frame[key] ?? []) {
          const best = boxes
            .map((b, i) => ({ i, score: used.has(i) ? 0 : boxIou(b, box) }))
            .sort((x, y) => y.score - x.score)[0];
          if (best && best.score > 0) used.add(best.i);
          overlap.push(best?.score ?? 0);
        }
      }
    if (!overlap.length) fail("Vision quality references need labelled regions");
    const matched = overlap.filter((v) => v >= 0.5).length,
      detections = a.frames.reduce(
        (n, f) => n + (f.faces?.length ?? 0) + (f.people?.length ?? 0) + (f.saliency?.length ?? 0),
        0,
      );
    return {
      frameIds: Number(
        ids(
          a.frames.map((f) => f.id),
          r.frames.map((f) => f.id),
        ),
      ),
      meanIou: overlap.reduce((n, v) => n + v, 0) / overlap.length,
      precision: fraction(matched, detections),
      recall: matched / overlap.length,
      falseDetections: detections - matched,
    };
  }
  if (task === "audio.events") {
    const a = AppleAudioResultSchema.parse(actual),
      r = AppleAudioResultSchema.parse(expected),
      used = new Set<number>();
    let matched = 0;
    for (const event of a.events) {
      const match = r.events.findIndex(
        (ref, i) =>
          !used.has(i) &&
          event.label === ref.label &&
          boxIou(
            { x: event.startSec, y: 0, w: event.endSec - event.startSec, h: 1 },
            { x: ref.startSec, y: 0, w: ref.endSec - ref.startSec, h: 1 },
          ) >= 0.5,
      );
      if (match >= 0) {
        used.add(match);
        matched++;
      }
    }
    return {
      precision: fraction(matched, a.events.length),
      recall: fraction(matched, r.events.length),
      taxonomy: Number(a.events.every((e) => a.labels.includes(e.label))),
    };
  }
  if (task === "text.assist") {
    const a = AppleAssistanceResultSchema.parse(actual),
      source = LocalTextRequestSchema.parse(input),
      r = AppleAssistanceResultSchema.parse(expected);
    if (
      !ids(
        r.items.map((i) => i.sourceId),
        source.units.map((i) => i.id),
      ) ||
      r.items.some((i) => !i.text.trim())
    )
      fail("Assistance reference is not bound to the source");
    return {
      sourceIds: Number(
        ids(
          a.items.map((i) => i.sourceId),
          source.units.map((i) => i.id),
        ),
      ),
      nonempty: Number(a.items.every((i) => i.text.trim().length > 0)),
      advisory: Number(a.advisory),
    };
  }
  if (task === "text.analyse") {
    const a = AppleTextResultSchema.parse(actual),
      text = z.string().parse(input),
      r = AppleTextResultSchema.parse(expected);
    if (!r.items.some((i) => i.text.trim())) fail("Text quality references need substantive observations");
    return {
      spans: Number(
        a.items.every(
          (i) =>
            i.startUtf16 + i.lengthUtf16 <= text.length &&
            !!i.text.trim() &&
            text.slice(i.startUtf16, i.startUtf16 + i.lengthUtf16) === i.text,
        ),
      ),
      nonempty: Number(a.items.some((i) => !!i.text.trim())),
    };
  }
  const audio = z
    .object({
      decoded: z.literal(true),
      durationSec: z.number().finite().positive(),
      peakDb: z.number().finite(),
      rmsDb: z.number().finite(),
      voice: z.string().min(1),
    })
    .strict();
  const a = audio.parse(actual),
    r = audio.parse(expected);
  return {
    decoded: 1,
    audible: Number(a.rmsDb > -80),
    unclipped: Number(a.peakDb < 0),
    voice: Number(a.voice === r.voice),
    durationErrorSec: Math.abs(a.durationSec - r.durationSec),
  };
}

/** Scores recorded data only. It never launches inference or writes qualifications. */
export function scoreWorkflowQuality(manifest: string, materialRoot: string, candidateRoot: string) {
  const corpusBytes = boundedFile(contained(materialRoot, manifest), 1024 * 1024),
    corpus = WorkflowQualitySchema.parse(JSON.parse(corpusBytes.toString()));
  const pins = new Map<string, string>(),
    candidatePins = new Map<string, string>();
  const readCandidate = (name: string, maximum = 4 * 1024 * 1024) => {
    const bytes = boundedFile(contained(candidateRoot, name), maximum);
    candidatePins.set(name, digest(bytes));
    return bytes;
  };
  const pinned = (pin: { path: string; sha256: string; bytes: number }) => {
    const data = boundedFile(contained(materialRoot, pin.path), 4 * 1024 * 1024);
    if (data.length !== pin.bytes || digest(data) !== pin.sha256) fail("Quality corpus pin changed: " + pin.path);
    pins.set(pin.path, pin.sha256);
    try {
      return JSON.parse(data.toString()) as unknown;
    } catch {
      return data.toString("utf8");
    }
  };
  if (corpus.annotations.kind === "independently-reviewed") pinned(corpus.annotations.evidence);
  const cases = corpus.cases.map((row) => {
    const input = pinned(row.input),
      reference = pinned(row.reference),
      bytes = readCandidate(row.candidate);
    let candidate: unknown = JSON.parse(bytes.toString());
    if (corpus.task === "speech.synthesise") {
      const envelope = z
        .object({
          task: z.literal("speech.synthesise"),
          operationId: z.string(),
          source: z.object({ sha256: z.string() }),
          result: z.object({
            voice: z.string(),
            units: z.array(z.object({ id: z.string(), file: z.string(), sourceTextHash: z.string() })).min(1),
          }),
        })
        .parse(candidate);
      const receipt = LocalResultReceiptSchema.parse(
        JSON.parse(readCandidate(row.candidate + ".receipt.json").toString()),
      );
      if (
        receipt.task !== envelope.task ||
        receipt.operationId !== envelope.operationId ||
        envelope.source.sha256 !== row.input.sha256 ||
        !receipt.inputs.some((pin) => pin.sha256 === row.input.sha256)
      )
        fail("TTS receipt/input identity differs");
      const output = receipt.outputs.find(
        (pin) => path.resolve(candidateRoot, pin.file) === path.resolve(candidateRoot, row.candidate),
      );
      if (output?.sha256 !== digest(bytes)) fail("TTS result hash differs");
      const request = LocalTextRequestSchema.parse(input);
      if (
        !ids(
          envelope.result.units.map((u) => u.id),
          request.units.map((u) => u.id),
        )
      )
        fail("TTS source IDs differ");
      let count = 0,
        square = 0,
        peak = 0;
      for (const [i, unit] of envelope.result.units.entries()) {
        const relative = path.relative(candidateRoot, path.resolve(candidateRoot, unit.file)).split(path.sep).join("/"),
          file = contained(candidateRoot, relative);
        const audio = readCandidate(relative, 32 * 1024 * 1024);
        if (
          unit.sourceTextHash !== digest(request.units[i]!.text) ||
          !receipt.outputs.some((pin) => path.resolve(candidateRoot, pin.file) === file && pin.sha256 === digest(audio))
        )
          fail("TTS audio/source hash differs");
        const decoded = spawnSync(
          "ffmpeg",
          ["-v", "error", "-nostdin", "-i", file, "-ac", "1", "-ar", "16000", "-f", "f32le", "pipe:1"],
          { timeout: 30000, maxBuffer: 4 * 1024 * 1024 },
        );
        if (decoded.status !== 0 || !decoded.stdout.length || decoded.stdout.length % 4)
          fail("TTS audio failed bounded decoding");
        for (let offset = 0; offset < decoded.stdout.length; offset += 4) {
          const sample = decoded.stdout.readFloatLE(offset);
          if (!Number.isFinite(sample)) fail("TTS PCM contains invalid samples");
          count++;
          square += sample * sample;
          peak = Math.max(peak, Math.abs(sample));
        }
        if (digest(boundedFile(file, 32 * 1024 * 1024)) !== digest(audio)) fail("TTS audio changed during scoring");
      }
      candidate = {
        decoded: true,
        voice: envelope.result.voice,
        durationSec: count / 16000,
        rmsDb: 20 * Math.log10(Math.max(1e-8, Math.sqrt(square / count))),
        peakDb: 20 * Math.log10(Math.max(1e-8, peak)),
      };
    }
    const metrics = workflowQualityMetrics(corpus.task, candidate, reference, input);
    const baseline = row.baseline
      ? workflowQualityMetrics(corpus.task, pinned(row.baseline), reference, input)
      : undefined;
    const passed = Object.entries(row.thresholds).every(([name, bound]) => {
      const value = metrics[name];
      if (value === undefined) fail("Unknown metric in quality threshold: " + name);
      return (
        (bound.min === undefined || (value >= bound.min && (!baseline || value >= baseline[name]!))) &&
        (bound.max === undefined || (value <= bound.max && (!baseline || value <= baseline[name]!)))
      );
    });
    if (digest(boundedFile(contained(candidateRoot, row.candidate), 4 * 1024 * 1024)) !== digest(bytes))
      fail("Quality candidate changed during scoring");
    return { id: row.id, passed, metrics, baseline, candidateSha256: digest(bytes) };
  });
  for (const [name, hash] of pins)
    if (digest(boundedFile(contained(materialRoot, name), 4 * 1024 * 1024)) !== hash)
      fail("Quality corpus changed during scoring");
  for (const [name, hash] of candidatePins)
    if (digest(boundedFile(contained(candidateRoot, name), 32 * 1024 * 1024)) !== hash)
      fail("Quality candidate changed during scoring");
  if (digest(boundedFile(contained(materialRoot, manifest))) !== digest(corpusBytes))
    fail("Quality manifest changed during scoring");
  return {
    outputs: [],
    metadata: {
      corpusSha256: digest(corpusBytes),
      annotationKind: corpus.annotations.kind,
      cases,
      passed: cases.every((c) => c.passed),
      productionQualified: false,
      limitations: [
        "Recorded corpus conformance does not authenticate annotations or qualify production.",
        ...(corpus.annotations.kind === "synthetic" ? ["Synthetic references establish metric behaviour only."] : []),
      ],
    },
  };
}
