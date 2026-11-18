import { GLYPH_ADVANCE, GLYPH_HEIGHT, GLYPH_WIDTH, glyphRows, normaliseLabel } from "./bitmap-font";

export type Colour = readonly [number, number, number];
export const BACKGROUND: Colour = [17, 17, 20];
export const TEXT: Colour = [240, 240, 240];
export const MUTED: Colour = [150, 150, 160];
export const CUT_MARK: Colour = [255, 64, 64];
export const SAMPLE_MARK: Colour = [64, 200, 255];

/** Minimal RGB24 pixel buffer: ffmpeg decodes into it and encodes out of it. */
export class RgbImage {
  readonly width: number;
  readonly height: number;
  readonly data: Buffer;

  constructor(width: number, height: number, data?: Buffer) {
    this.width = width;
    this.height = height;
    this.data = data ?? Buffer.alloc(width * height * 3);
  }

  static filled(width: number, height: number, colour: Colour): RgbImage {
    const image = new RgbImage(width, height);
    image.fillRect(0, 0, width, height, colour);
    return image;
  }

  fillRect(x: number, y: number, width: number, height: number, colour: Colour): void {
    const left = Math.max(0, Math.round(x));
    const right = Math.min(this.width, Math.round(x + width));
    const top = Math.max(0, Math.round(y));
    const bottom = Math.min(this.height, Math.round(y + height));
    for (let row = top; row < bottom; row++)
      for (let column = left; column < right; column++) {
        const offset = (row * this.width + column) * 3;
        this.data[offset] = colour[0];
        this.data[offset + 1] = colour[1];
        this.data[offset + 2] = colour[2];
      }
  }

  blit(source: RgbImage, x: number, y: number): void {
    const visible = Math.min(source.width, this.width - x);
    if (visible <= 0) return;
    for (let row = 0; row < source.height; row++) {
      const targetRow = y + row;
      if (targetRow < 0 || targetRow >= this.height) continue;
      const start = row * source.width * 3;
      source.data.copy(this.data, (targetRow * this.width + x) * 3, start, start + visible * 3);
    }
  }

  drawText(text: string, x: number, y: number, scale: number, colour: Colour = TEXT): void {
    let cursor = x;
    for (const character of normaliseLabel(text)) {
      const rows = glyphRows(character);
      for (let row = 0; row < GLYPH_HEIGHT; row++)
        for (let column = 0; column < GLYPH_WIDTH; column++)
          if (rows[row]! & (1 << (GLYPH_WIDTH - 1 - column)))
            this.fillRect(cursor + column * scale, y + row * scale, scale, scale, colour);
      cursor += GLYPH_ADVANCE * scale;
    }
  }
}

/** Amplified per-pixel absolute difference, plus the unamplified mean (0-255). */
export function differenceMap(current: RgbImage, previous: RgbImage, gain = 4): { image: RgbImage; mean: number } {
  const image = new RgbImage(current.width, current.height);
  let total = 0;
  for (let offset = 0; offset < current.data.length; offset++) {
    const delta = Math.abs(current.data[offset]! - previous.data[offset]!);
    total += delta;
    image.data[offset] = Math.min(255, delta * gain);
  }
  return { image, mean: total / current.data.length };
}
