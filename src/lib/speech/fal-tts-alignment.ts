type FalWordTiming = { text: string; start: number; end: number };

/** Accept explicit provider word times only. Missing or ambiguous character timing requires forced alignment. */
export function normaliseFalTtsAlignment(result: Record<string, unknown>): { words: FalWordTiming[] } | null {
  const rows = result.words ?? result.timestamps;
  if (!Array.isArray(rows) || !rows.length) return null;
  const words: FalWordTiming[] = [];
  for (const value of rows) {
    if (!value || typeof value !== "object") return null;
    const row = value as Record<string, unknown>;
    const text = row.word ?? (Array.isArray(result.words) || row.type === "word" ? row.text : undefined);
    const start = row.start,
      end = row.end;
    if (
      typeof text !== "string" ||
      !text.trim() ||
      typeof start !== "number" ||
      typeof end !== "number" ||
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      start < 0 ||
      end < start ||
      start < (words.at(-1)?.start ?? 0)
    )
      return null;
    words.push({ text, start, end });
  }
  return { words };
}
