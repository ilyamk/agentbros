import type { MeasuredText } from "./page-measure";

export type ReadabilityFinding = {
  code: "LOW_CONTRAST" | "TEXT_TOO_SMALL_ON_PHONE" | "TEXT_VISIBLE_TOO_BRIEFLY";
  frame: number;
  lastFrame: number;
  text: string;
  measured: number;
  minimum: number;
  fix: string;
};

const linear = Array.from({ length: 256 }, (_, channel) => {
  const value = channel / 255;
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
});
const luminance = (pixels: Buffer, offset: number) =>
  0.2126 * linear[pixels[offset]!] + 0.7152 * linear[pixels[offset + 1]!] + 0.0722 * linear[pixels[offset + 2]!]!;

function glyphContrast(text: MeasuredText, stage: { width: number; height: number }, frame: Buffer, backdrop: Buffer) {
  const ratios: number[] = [];
  for (const line of text.lines) {
    const left = Math.max(0, Math.floor(line.x));
    const right = Math.min(stage.width, Math.ceil(line.x + line.width));
    const top = Math.max(0, Math.floor(line.y));
    const bottom = Math.min(stage.height, Math.ceil(line.y + line.height));
    const step = Math.max(1, Math.floor(Math.sqrt(((right - left) * (bottom - top)) / 4000)));
    for (let y = top; y < bottom; y += step)
      for (let x = left; x < right; x += step) {
        const offset = (y * stage.width + x) * 3;
        if (
          Math.max(
            Math.abs(frame[offset]! - backdrop[offset]!),
            Math.abs(frame[offset + 1]! - backdrop[offset + 1]!),
            Math.abs(frame[offset + 2]! - backdrop[offset + 2]!),
          ) < 3
        )
          continue;
        const foreground = luminance(frame, offset) + 0.05;
        const background = luminance(backdrop, offset) + 0.05;
        ratios.push(Math.max(foreground, background) / Math.min(foreground, background));
      }
  }
  // Prefer the interior of the glyphs to anti-aliased edges. Fewer changed pixels are inconclusive.
  return ratios.length >= 8 ? ratios.sort((a, b) => a - b)[Math.floor(ratios.length * 0.8)] : undefined;
}

export const readableText = (text: MeasuredText) =>
  text.opacity >= 0.6 && text.fontSize && /\p{L}/u.test(text.text) && text.lines.some((line) => line.height >= 3);

type Sample = { frame: number; text: MeasuredText; contrast?: number; phonePx: number };

export class ReadabilityCheck {
  private readonly blocks = new Map<string, Sample[][]>();
  private previousFrame: number | undefined;
  private contrastSamples = 0;

  constructor(private readonly stage: { width: number; height: number; fps: number; durationInFrames: number }) {}

  add(frame: number, texts: MeasuredText[], pixels: Buffer, backdrop?: Buffer) {
    const present = new Map<string, Sample>();
    for (const text of texts) {
      if (!readableText(text)) continue;
      const key = text.block + "\0" + text.label;
      const contrast = backdrop && !text.clipPath ? glyphContrast(text, this.stage, pixels, backdrop) : undefined;
      if (contrast !== undefined) this.contrastSamples++;
      const phonePx =
        (Math.min(text.fontSize!, Math.max(...text.lines.map((line) => line.height)) * 1.35) * 390) / this.stage.width;
      const current = present.get(key);
      if (!current || phonePx < current.phonePx) present.set(key, { frame, text, contrast, phonePx });
    }
    for (const [key, sample] of present) {
      const runs = this.blocks.get(key) ?? [];
      const run = runs.at(-1);
      if (run && run.at(-1)?.frame === this.previousFrame) run.push(sample);
      else runs.push([sample]);
      this.blocks.set(key, runs);
    }
    this.previousFrame = frame;
  }

  report(selected: number[]) {
    const findings: ReadabilityFinding[] = [];
    const frameIndexes = new Map(selected.map((frame, index) => [frame, index]));
    const add = (
      code: ReadabilityFinding["code"],
      first: Sample,
      last: Sample,
      measured: number,
      minimum: number,
      fix: string,
    ) =>
      findings.push({
        code,
        frame: first.frame,
        lastFrame: last.frame,
        text: first.text.text.slice(0, 180),
        measured: Math.round(measured * 100) / 100,
        minimum: Math.round(minimum * 100) / 100,
        fix,
      });
    const phoneMinimum = this.stage.height > this.stage.width ? 9 : 7;
    for (const runs of this.blocks.values())
      for (const run of runs) {
        const first = run[0]!;
        const last = run.at(-1)!;
        const mostOpaque = Math.max(...run.map((sample) => sample.text.opacity));
        const settled = run.filter((sample) => sample.text.opacity >= mostOpaque - 0.03);
        const smallest = settled.reduce((a, b) => (a.phonePx < b.phonePx ? a : b));
        if (smallest.phonePx < phoneMinimum)
          add(
            "TEXT_TOO_SMALL_ON_PHONE",
            smallest,
            smallest,
            smallest.phonePx,
            phoneMinimum,
            "Enlarge the visible lettering at phone-feed width.",
          );
        const measured = settled
          .filter((sample) => sample.contrast !== undefined)
          .sort((a, b) => a.contrast! - b.contrast!)[0];
        if (measured) {
          const fontSize = measured.text.fontSize!;
          const minimum = fontSize >= 24 || (fontSize >= 18.67 && Number(measured.text.weight) >= 700) ? 3 : 4.5;
          if (measured.contrast! < minimum)
            add(
              "LOW_CONTRAST",
              measured,
              measured,
              measured.contrast!,
              minimum,
              "Increase foreground contrast or add a solid backing behind this text.",
            );
        }
        const index = frameIndexes.get(first.frame)!;
        const endIndex = frameIndexes.get(last.frame)!;
        const before = selected[index - 1] ?? (first.frame === 0 ? -1 : undefined);
        const after =
          selected[endIndex + 1] ??
          (last.frame === this.stage.durationInFrames - 1 ? this.stage.durationInFrames : undefined);
        // Even the largest possible interval between the samples was insufficient.
        const duration = before === undefined || after === undefined ? Infinity : (after - before - 1) / this.stage.fps;
        const text = first.text.text.trim();
        const minimum = Math.max(1, 0.3 + Math.max(Array.from(text).length / 17, text.split(/\s+/).length / 3));
        if (text.length >= 8 && duration < minimum)
          add(
            "TEXT_VISIBLE_TOO_BRIEFLY",
            first,
            last,
            duration,
            minimum,
            "Hold the text longer or shorten the words on screen.",
          );
      }
    findings.sort((a, b) => a.frame - b.frame || a.code.localeCompare(b.code));
    return {
      findings: findings.slice(0, 40),
      omitted: Math.max(0, findings.length - 40),
      contrastSamples: this.contrastSamples,
    };
  }
}
