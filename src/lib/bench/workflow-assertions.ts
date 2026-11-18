import { TranscriptSchema, type Transcript } from "../../types/transcript";
import { z } from "zod";
import { LocalTextRequestSchema } from "../../types/local-capabilities";
import { languageEquivalent } from "../local-capabilities";
import type { WorkflowEvent } from "../../types/workflow-evaluation";
import { digest, fail } from "./io";

/** Causality is local to an artefact, not a fixed global ordering of tool calls. */
export function observedHandoff(
  events: readonly WorkflowEvent[],
  consumer: WorkflowEvent,
  file: string,
): WorkflowEvent {
  const input = consumer.inputs.find((pin) => pin.path === file);
  if (!consumer.passed || !input) fail("Consumer did not validate the declared input");
  const at = events.findIndex((e) => e.id === consumer.id);
  const producer = events
    .slice(0, at)
    .reverse()
    .find(
      (e) =>
        e.passed &&
        e.outputs.some((pin) => pin.path === file && pin.sha256 === input.sha256 && pin.bytes === input.bytes),
    );
  if (!producer) fail("No observed producer of the exact consumed bytes");
  return producer;
}
export function transcriptForSource(raw: unknown, sha256: string, durationSec?: number): Transcript {
  const transcript = TranscriptSchema.parse(raw);
  if (transcript.source.sha256 !== sha256 || !transcript.words.length)
    fail("Transcript is empty or belongs to another source");
  if (
    transcript.words.some(
      (word, index) =>
        word.endSec <= word.startSec ||
        (durationSec !== undefined && word.endSec > durationSec + 0.05) ||
        (index > 0 && word.startSec < transcript.words[index - 1]!.startSec),
    )
  )
    fail("Transcript source clock is invalid");
  if (new Set(transcript.words.map((w) => w.id)).size !== transcript.words.length)
    fail("Transcript word IDs are duplicated");
  const ids = new Set(transcript.words.map((w) => w.id));
  if (transcript.sentences.some((s) => !ids.has(s.firstWordId) || !ids.has(s.lastWordId)))
    fail("Sentence has an invented word ID");
  return transcript;
}
export function sameIds(actual: readonly string[], expected: readonly string[]): void {
  if (actual.length !== expected.length || actual.some((id, i) => id !== expected[i]))
    fail("Source identifiers or their order changed across the handoff");
}
export function voiceResultForRequest(value: unknown, request: z.infer<typeof LocalTextRequestSchema>) {
  const result = z
    .object({
      language: z.string().min(2),
      units: z
        .array(z.object({ id: z.string(), sourceTextHash: z.string().regex(/^[a-f0-9]{64}$/u) }).passthrough())
        .min(1),
    })
    .passthrough()
    .parse(value);
  if (!languageEquivalent(request.sourceLanguage, result.language))
    fail("Voice result language differs from the requested language");
  sameIds(
    result.units.map((u) => u.id),
    request.units.map((u) => u.id),
  );
  if (result.units.some((unit, i) => unit.sourceTextHash !== digest(request.units[i]!.text)))
    fail("Voice text hash differs from the requested unit");
  return result;
}
