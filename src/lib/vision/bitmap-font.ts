/**
 * Built-in 5x7 bitmap font for sheet labels. Stock ffmpeg builds often lack
 * drawtext, so labels are drawn into pixel buffers without a font dependency.
 * Each glyph is seven rows of two hex digits; bit 4 is the leftmost pixel.
 * Text is drawn in capitals. Latin and Cyrillic are covered; other scripts draw a hollow box.
 */
const GLYPHS: Record<string, string> = {
  A: "0E11111F111111",
  B: "1E11111E11111E",
  C: "0E11101010110E",
  D: "1E11111111111E",
  E: "1F10101E10101F",
  F: "1F10101E101010",
  G: "0E11101711110F",
  H: "1111111F111111",
  I: "0E04040404040E",
  J: "0702020202120C",
  K: "11121418141211",
  L: "1010101010101F",
  M: "111B1515111111",
  N: "11191513111111",
  O: "0E11111111110E",
  P: "1E11111E101010",
  Q: "0E11111115120D",
  R: "1E11111E141211",
  S: "0F10100E01011E",
  T: "1F040404040404",
  U: "1111111111110E",
  V: "11111111110A04",
  W: "11111115151B11",
  X: "11110A040A1111",
  Y: "11110A04040404",
  Z: "1F01020408101F",
  "0": "0E11131519110E",
  "1": "040C040404040E",
  "2": "0E11010204081F",
  "3": "1F02040201110E",
  "4": "02060A121F0202",
  "5": "1F101E0101110E",
  "6": "0608101E11110E",
  "7": "1F010204080808",
  "8": "0E11110E11110E",
  "9": "0E11110F01020C",
  " ": "00000000000000",
  ".": "00000000000C0C",
  ",": "000000000C0408",
  ":": "000C0C000C0C00",
  ";": "000C0C000C0408",
  "!": "04040404040004",
  "?": "0E110102040004",
  "-": "0000001F000000",
  "+": "0004041F040400",
  "=": "00001F001F0000",
  "/": "01010204081010",
  "(": "02040808080402",
  ")": "08040202020408",
  "[": "0E08080808080E",
  "]": "0E02020202020E",
  "'": "04040800000000",
  '"': "0A0A0000000000",
  "%": "18190204081303",
  "&": "0C12140815120D",
  _: "0000000000001F",
  "#": "0A0A1F0A1F0A0A",
  "*": "0004150E150400",
  "<": "02040810080402",
  ">": "08040201020408",
  Б: "1F10101E11111E",
  Г: "1F101010101010",
  Д: "060A0A0A0A1F11",
  Ж: "1515150E151515",
  З: "0E11010601110E",
  И: "11111315191111",
  Й: "0A041113151911",
  Л: "07090909090911",
  П: "1F111111111111",
  У: "1111110F01110E",
  Ф: "040E1515150E04",
  Ц: "12121212121F01",
  Ч: "1111110F010101",
  Ш: "1111151515151F",
  Щ: "15151515151F01",
  Ъ: "1808080E09090E",
  Ы: "1111111D13131D",
  Ь: "1010101E11111E",
  Э: "0E11010701110E",
  Ю: "1215151D151512",
  Я: "0F11110F050911",
  Ё: "0A001F101E101F",
};
const SAME_AS_LATIN: Record<string, string> = {
  А: "A",
  В: "B",
  Е: "E",
  К: "K",
  М: "M",
  Н: "H",
  О: "O",
  Р: "P",
  С: "C",
  Т: "T",
  Х: "X",
};
const FOLDED: Record<string, string> = { "—": "-", "–": "-", "«": '"', "»": '"', "“": '"', "”": '"', "’": "'" };
const MISSING = "1F11111111111F";

export const GLYPH_WIDTH = 5;
export const GLYPH_HEIGHT = 7;
/** Horizontal advance in unscaled pixels, including the gap between letters. */
export const GLYPH_ADVANCE = 6;

export function hasGlyph(character: string): boolean {
  return character in GLYPHS || character in SAME_AS_LATIN || character in FOLDED;
}

export function normaliseLabel(text: string): string {
  return text.normalize("NFC").toUpperCase().replaceAll("…", "...").replace(/\s+/g, " ");
}

/** Glyph rows as five-bit numbers. */
export function glyphRows(character: string): number[] {
  const key = FOLDED[character] ?? SAME_AS_LATIN[character] ?? character;
  const hex = GLYPHS[key] ?? MISSING;
  return Array.from({ length: GLYPH_HEIGHT }, (_, row) => Number.parseInt(hex.slice(row * 2, row * 2 + 2), 16));
}

export function textWidth(text: string, scale: number): number {
  return [...normaliseLabel(text)].length * GLYPH_ADVANCE * scale;
}
