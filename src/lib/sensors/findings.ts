import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import { CliErrorObject } from "../cli";

/** Counter name per finding code. A counter reads `null` when its check did not run. */
export const COUNTER_OF_CODE = {
  RUNTIME_ERROR: "runtimeErrors",
  CONSOLE_ERROR: "consoleErrors",
  TEXT_OFF_STAGE: "textOffStage",
  TEXT_OUTSIDE_REGION: "textOutsideRegion",
  TEXT_OUTSIDE_SAFE_ZONE: "textOutsideSafeZone",
  TEXT_OVERLAP: "textOverlap",
  FALLBACK_FONT: "fallbackFonts",
  NON_DETERMINISTIC: "nonDeterministic",
  LOOP_SEAM: "loopSeam",
  FADED_FINAL: "fadedFinal",
  DEAD_FRAME: "deadFrames",
  FLASH_RISK: "flashRisk",
  SIMULTANEOUS_ENTRY: "simultaneousEntry",
  TEXT_CENTRED_ALWAYS: "textCentredAlways",
  EMOJI_TEXT: "emojiText",
  SLOP_PALETTE: "slopPalette",
  RENDER_PIXEL_ASPECT: "renderFile",
  RENDER_DIMENSIONS: "renderFile",
  RENDER_CODEC: "renderFile",
  RENDER_DURATION: "renderFile",
} as const;
export type FindingCode = keyof typeof COUNTER_OF_CODE;
export type CounterName = (typeof COUNTER_OF_CODE)[FindingCode];
export const COUNTER_NAMES = [...new Set(Object.values(COUNTER_OF_CODE))] as CounterName[];

export type Occurrence = {
  code: FindingCode;
  frame: number;
  /** Occurrences with the same code and key merge into one finding. */
  key: string;
  message: string;
  fix: string;
  text?: string[];
  elements?: string[];
  /** The reason a block declared with `data-overflow`: the text crosses the stage or safe zone by design on this frame. */
  intended?: string;
};
export type Finding = {
  code: FindingCode;
  frame: number;
  lastFrame: number;
  occurrences: number;
  message: string;
  fix: string;
};

const AllowRuleSchema = z
  .object({
    code: z.enum(Object.keys(COUNTER_OF_CODE) as [FindingCode, ...FindingCode[]]),
    frames: z.union([z.number().int().nonnegative(), z.string().regex(/^\d+-\d+$/)]).optional(),
    text: z.string().min(1).optional(),
    element: z.string().min(1).optional(),
    reason: z.string().min(1),
  })
  .strict();
export type AllowRule = z.infer<typeof AllowRuleSchema>;
const AllowFileSchema = z.union([z.array(AllowRuleSchema), AllowRuleSchema.transform((rule) => [rule])]);

/** `--allow` takes inline JSON or a path to a JSON file. */
export function parseAllow(value: string | undefined): AllowRule[] {
  if (!value) return [];
  const inline = /^\s*[[{]/.test(value);
  if (!inline && !existsSync(value))
    throw new CliErrorObject({ code: "FILE_NOT_FOUND", message: `--allow is neither JSON nor a file: ${value}` });
  try {
    return AllowFileSchema.parse(JSON.parse(inline ? value : readFileSync(value, "utf8")));
  } catch (error) {
    throw new CliErrorObject({
      code: "INVALID_INPUT",
      message: `--allow must be a rule or a list of rules {code, reason, frames?, text?, element?}: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
}

function ruleMatches(rule: AllowRule, occurrence: Occurrence): boolean {
  if (rule.code !== occurrence.code) return false;
  if (rule.frames !== undefined) {
    const [first, last] =
      typeof rule.frames === "number" ? [rule.frames, rule.frames] : rule.frames.split("-").map(Number);
    if (occurrence.frame < first! || occurrence.frame > last!) return false;
  }
  if (rule.text !== undefined && !occurrence.text?.some((text) => text.includes(rule.text!))) return false;
  if (rule.element !== undefined && !occurrence.elements?.includes(rule.element)) return false;
  return true;
}

export function applyAllow(occurrences: Occurrence[], rules: AllowRule[]) {
  const matched = rules.map(() => 0);
  const kept = occurrences.filter((occurrence) => {
    let allowed = false;
    rules.forEach((rule, index) => {
      if (ruleMatches(rule, occurrence)) {
        matched[index]!++;
        allowed = true;
      }
    });
    return !allowed;
  });
  return {
    kept,
    allowed: rules.map((rule, index) => ({ ...rule, matched: matched[index]! })),
    unusedAllow: rules.filter((_, index) => matched[index] === 0),
  };
}

/** A block's declared overflow on a run of frames: reported, never counted. */
export type IntendedOverflow = {
  code: FindingCode;
  reason: string;
  text: string;
  frame: number;
  lastFrame: number;
  occurrences: number;
};

/**
 * Takes out off-stage and safe-zone occurrences inside an element marked `data-overflow="<reason>"`. A block sets the
 * attribute only on the frames its documented overflow lasts, so the same text resting there later is still a finding.
 */
export function splitIntended(occurrences: Occurrence[]): { kept: Occurrence[]; intended: IntendedOverflow[] } {
  const merged = new Map<string, IntendedOverflow>();
  const kept = occurrences.filter((occurrence) => {
    if (!occurrence.intended || (occurrence.code !== "TEXT_OFF_STAGE" && occurrence.code !== "TEXT_OUTSIDE_SAFE_ZONE"))
      return true;
    const text = occurrence.text?.[0] ?? occurrence.key;
    const id = `${occurrence.code}\0${occurrence.intended}\0${text}`;
    const found = merged.get(id);
    if (!found)
      merged.set(id, {
        code: occurrence.code,
        reason: occurrence.intended,
        text,
        frame: occurrence.frame,
        lastFrame: occurrence.frame,
        occurrences: 1,
      });
    else {
      found.frame = Math.min(found.frame, occurrence.frame);
      found.lastFrame = Math.max(found.lastFrame, occurrence.frame);
      found.occurrences++;
    }
    return false;
  });
  return { kept, intended: [...merged.values()].sort((a, b) => a.frame - b.frame) };
}

export function mergeOccurrences(occurrences: Occurrence[]): Finding[] {
  const merged = new Map<string, Finding>();
  for (const { code, frame, key, message, fix } of occurrences) {
    const id = `${code}\0${key}`;
    const found = merged.get(id);
    if (!found) merged.set(id, { code, frame, lastFrame: frame, occurrences: 1, message, fix });
    else {
      found.frame = Math.min(found.frame, frame);
      found.lastFrame = Math.max(found.lastFrame, frame);
      found.occurrences++;
    }
  }
  return [...merged.values()].sort((a, b) => a.frame - b.frame);
}

export function tally(
  occurrences: Occurrence[],
  skipped: Partial<Record<CounterName, string>>,
): Record<CounterName, number | null> {
  const counters = Object.fromEntries(COUNTER_NAMES.map((name) => [name, name in skipped ? null : 0])) as Record<
    CounterName,
    number | null
  >;
  for (const { code } of occurrences) {
    const name = COUNTER_OF_CODE[code];
    counters[name] = (counters[name] ?? 0) + 1;
  }
  return counters;
}

export function formatTable(frames: number, counters: Record<CounterName, number | null>): string {
  const width = Math.max(...COUNTER_NAMES.map((name) => name.length));
  return [
    `${"frames".padEnd(width)}  ${frames}`,
    ...COUNTER_NAMES.map((name) => `${name.padEnd(width)}  ${counters[name] ?? "skipped"}`),
  ].join("\n");
}

/** `--frames`: "a-b" or "a-b:step" for a range, or a bare step N for every Nth frame plus the first and last. */
export function selectFrames(spec: string | undefined, durationInFrames: number): number[] {
  const value = spec?.trim() ?? "5";
  const range = /^(\d+)-(\d+)(?::(\d+))?$/.exec(value);
  const last = durationInFrames - 1;
  if (range) {
    const [first, end, step] = [Number(range[1]), Number(range[2]), Number(range[3] ?? 1)];
    if (first > end || end > last || step < 1)
      throw new CliErrorObject({
        code: "INVALID_INPUT",
        message: `--frames ${value} must lie within 0-${last} with a positive step.`,
      });
    return Array.from({ length: Math.floor((end - first) / step) + 1 }, (_, index) => first + index * step);
  }
  if (!/^\d+$/.test(value) || Number(value) < 1)
    throw new CliErrorObject({
      code: "INVALID_INPUT",
      message: `--frames must be a range "a-b", "a-b:step" or a sample step such as 5; got "${value}".`,
    });
  const step = Number(value);
  const frames = Array.from({ length: Math.ceil(durationInFrames / step) }, (_, index) => index * step);
  return [...new Set([...frames, last])];
}
