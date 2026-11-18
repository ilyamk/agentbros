import { z } from "zod";
const TimedText = z
  .array(
    z
      .object({
        text: z.string().min(1).max(20000),
        startSec: z.number().finite().nonnegative(),
        endSec: z.number().finite().positive(),
      })
      .strict()
      .refine((row) => row.endSec > row.startSec),
  )
  .min(1)
  .max(1000);
const tokens = (text: string) =>
  text
    .toLocaleLowerCase()
    .normalize("NFKC")
    .match(/[\p{L}\p{N}]+/gu) ?? [];
/** Candidate-quality measurements against supplied references, never an authenticity approval. */
export function evaluateLocalAsr(referenceInput: unknown, hypothesisInput: unknown) {
  const reference = TimedText.parse(referenceInput),
    hypothesis = TimedText.parse(hypothesisInput),
    expected = tokens(reference.map((row) => row.text).join(" ")),
    actual = tokens(hypothesis.map((row) => row.text).join(" "));
  if (!expected.length || expected.length > 5000 || actual.length > 5000 || expected.length * actual.length > 4000000)
    throw new Error("ASR evaluation requires bounded nonempty reference words");
  let previous = Array.from(
    {
      length: actual.length + 1,
    },
    (_, i) => i,
  );
  for (let i = 1; i <= expected.length; i++) {
    const current = [i];
    for (let j = 1; j <= actual.length; j++)
      current[j] = Math.min(
        previous[j]! + 1,
        current[j - 1]! + 1,
        previous[j - 1]! + (expected[i - 1] === actual[j - 1] ? 0 : 1),
      );
    previous = current;
  }
  const matched = reference.flatMap((row, i) => {
    const candidate = hypothesis[i];
    return candidate && JSON.stringify(tokens(row.text)) === JSON.stringify(tokens(candidate.text))
      ? [Math.max(Math.abs(row.startSec - candidate.startSec), Math.abs(row.endSec - candidate.endSec))]
      : [];
  });
  return {
    wordErrorRate: previous[actual.length]! / expected.length,
    referenceWords: expected.length,
    hypothesisWords: actual.length,
    matchedOrdinalSpans: matched.length,
    maxMatchedBoundaryErrorSec: matched.length ? Math.max(...matched) : null,
    reviewRequired: true as const,
  };
}
export function evaluateLocalRetrieval(input: unknown) {
  const rows = z
    .array(
      z
        .object({
          expectedSegmentIds: z.array(z.string().min(1)).min(1),
          rankedSegmentIds: z.array(z.string().min(1)).max(100),
        })
        .strict(),
    )
    .min(1)
    .max(1000)
    .parse(input);
  if (rows.some((row) => new Set(row.rankedSegmentIds).size !== row.rankedSegmentIds.length))
    throw new Error("Duplicate ranked retrieval evidence");
  const ranks = rows.map((row) => row.rankedSegmentIds.findIndex((id) => row.expectedSegmentIds.includes(id)) + 1);
  return {
    queries: rows.length,
    hitAtOne: ranks.filter((rank) => rank === 1).length / rows.length,
    hitWithinProvidedRanking: ranks.filter((rank) => rank > 0).length / rows.length,
    meanReciprocalRank: ranks.reduce((sum, rank) => sum + (rank ? 1 / rank : 0), 0) / rows.length,
    reviewRequired: true as const,
  };
}
