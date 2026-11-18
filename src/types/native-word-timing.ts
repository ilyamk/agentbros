import { z } from "zod";
export const NATIVE_WORD_METHOD = "native-word-segments-v1" as const;
export const NativeWordEvidenceSchema = z
  .object({
    version: z.literal(1),
    method: z.literal(NATIVE_WORD_METHOD),
    estimated: z.literal(true),
    reviewRequired: z.literal(true),
    status: z.enum(["available", "unavailable"]),
    reason: z.string().min(1).max(500).optional(),
    rawRows: z
      .array(
        z
          .object({
            text: z.string().max(10000),
            offsets: z
              .object({ from: z.number().int().safe().nonnegative(), to: z.number().int().safe().nonnegative() })
              .strict(),
          })
          .strict(),
      )
      .min(1)
      .max(30001),
  })
  .strict()
  .superRefine((v, c) => {
    if ((v.status === "unavailable") !== !!v.reason)
      c.addIssue({ code: "custom", message: "Native alignment status/reason mismatch" });
  });
export type NativeWordEvidence = z.infer<typeof NativeWordEvidenceSchema>;
/** Use only native boundaries. Empty engine rows remain evidence, never caption words. */
export function nativeWords(raw: unknown, durationSec: number) {
  const evidence = NativeWordEvidenceSchema.parse(raw);
  if (evidence.status !== "available") throw new Error("Native word alignment unavailable: " + evidence.reason);
  if (!Number.isFinite(durationSec) || durationSec <= 0) throw new Error("Native word source duration is unavailable");
  let previous = 0;
  const words: Array<{ id: string; text: string; startSec: number; endSec: number; rawRow: number }> = [];
  for (const [i, row] of evidence.rawRows.entries()) {
    const start = row.offsets.from / 1000,
      end = row.offsets.to / 1000,
      text = row.text.trim();
    if (end < start || start < previous || end > durationSec + 0.001)
      throw new Error("Native word rows overlap, reverse or exceed original clock");
    previous = end;
    if (!text) continue;
    if (end === start || /\s/u.test(text))
      throw new Error("Native word row is collapsed or contains ambiguous multiple words");
    words.push({ id: `native-word-${i}`, text, startSec: start, endSec: end, rawRow: i });
  }
  if (!words.length) throw new Error("Native word timing unavailable: no lexical rows");
  return { evidence, words };
}
export function validateNativeWordOutput(
  raw: unknown,
  durationSec: number,
  segments: Array<{ text: string; startSec: number; endSec: number }>,
) {
  const evidence = NativeWordEvidenceSchema.parse(raw);
  if (evidence.status === "unavailable") {
    // Word intervals cannot be repaired; preserve only truthful aggregate ASR text/bounds.
    let previous = 0;
    for (const row of evidence.rawRows) {
      if (
        row.offsets.to < row.offsets.from ||
        row.offsets.from < previous ||
        row.offsets.to / 1000 > durationSec + 0.001
      )
        throw new Error("Invalid unavailable native evidence clock");
      previous = row.offsets.to;
    }
    const lexical = evidence.rawRows.filter((r) => r.text.trim());
    if (!lexical.length) throw new Error("Native ASR contains no text");
    const expected = [
      {
        text: lexical.map((r) => r.text.trim()).join(" "),
        startSec: lexical[0].offsets.from / 1000,
        endSec: lexical.at(-1)!.offsets.to / 1000,
      },
    ];
    if (expected[0].endSec <= expected[0].startSec || JSON.stringify(expected) !== JSON.stringify(segments))
      throw new Error("Unavailable native ASR differs from retained raw evidence");
    return { evidence, words: [] };
  }
  const result = nativeWords(raw, durationSec);
  const expected = result.words.map(({ text, startSec, endSec }) => ({ text, startSec, endSec }));
  if (JSON.stringify(expected) !== JSON.stringify(segments))
    throw new Error("Native word rows are incomplete or differ from immutable ASR segments");
  return result;
}
