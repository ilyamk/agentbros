import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCaptionPages,
  pageAt,
  pageText,
  wordsFromAlignment,
  wordsFromTranscript,
  type CaptionPage,
  type CaptionWord,
} from "../src/lib/captions/pages";
import {
  CAPTION_SAFE_ZONE,
  captionBox,
  centredSafeBox,
  checkCaptionBackground,
  checkCaptionPages,
  FRAME_SIZE,
  type CaptionFormat,
} from "../src/lib/captions/readability";
import { resolveCaptionStyle, shiftWords, timelineCaptionWords } from "../src/lib/captions/profiles";
import { applyEdit } from "../src/lib/timeline-ir/commands";
import { TranscriptSchema, type Transcript } from "../src/types/transcript";
import type { TimelineIR } from "../src/types/timeline";
import { emphasisCues, keywordOf } from "../src/motion/library/captions/layout";
import { presetLayout, presetLimits } from "../src/motion/library/captions/plan";
import { CAPTION_PRESET_IDS, CAPTION_PRESETS, captionStyleSchema } from "../src/motion/library/captions/style";
import { SAMPLE_EN, SAMPLE_RU, timedWords } from "../src/motion/library/captions/sample";

const transcript: Transcript = TranscriptSchema.parse({
  version: 1,
  source: { file: "take.mp4", sha256: "a".repeat(64), durationSec: 6 },
  engine: { provider: "local", model: "fixture", verbatim: true, diarized: false, timing: "native" },
  language: "ru",
  speakers: [],
  words: [
    {
      id: "w0",
      text: "Привет,",
      kind: "word",
      startSec: 0.1,
      endSec: 0.5,
      speaker: null,
      channel: null,
      confidence: 0.9,
    },
    {
      id: "w1",
      text: "(смех)",
      kind: "event",
      startSec: 0.5,
      endSec: 0.9,
      speaker: null,
      channel: null,
      confidence: null,
    },
    {
      id: "w2",
      text: "эээ",
      kind: "filler",
      startSec: 0.9,
      endSec: 1.2,
      speaker: null,
      channel: null,
      confidence: 0.6,
    },
    {
      id: "w3",
      text: "это",
      kind: "word",
      startSec: 1.25,
      endSec: 1.45,
      speaker: null,
      channel: null,
      confidence: 0.9,
    },
    {
      id: "w4",
      text: "новый",
      kind: "word",
      startSec: 1.5,
      endSec: 1.8,
      speaker: null,
      channel: null,
      confidence: 0.9,
    },
    {
      id: "w5",
      text: "монтаж.",
      kind: "word",
      startSec: 1.85,
      endSec: 2.4,
      speaker: null,
      channel: null,
      confidence: 0.9,
    },
    {
      id: "w6",
      text: "Смотрите",
      kind: "word",
      startSec: 3.4,
      endSec: 3.9,
      speaker: null,
      channel: null,
      confidence: 0.9,
    },
    {
      id: "w7",
      text: "сами.",
      kind: "word",
      startSec: 3.95,
      endSec: 4.5,
      speaker: null,
      channel: null,
      confidence: 0.9,
    },
  ],
  sentences: [],
});

const defaults = { maxWords: 3, maxCharsPerLine: 16, maxLines: 2, minPageSec: 0.8 };

test("transcript words: events are dropped, fillers that survived the edit stay", () => {
  const words = wordsFromTranscript(transcript);
  assert.deepEqual(
    words.map((word) => word.text),
    ["Привет,", "эээ", "это", "новый", "монтаж.", "Смотрите", "сами."],
  );
  assert.equal(words[1]!.kind, "filler");
});

test("pages: at most maxWords, two lines, a sentence end and a long pause break the page", () => {
  const pages = buildCaptionPages(wordsFromTranscript(transcript), defaults);
  for (const page of pages) {
    assert.ok(page.words.length <= defaults.maxWords + 1, pageText(page).join(" / "));
    assert.ok(page.lines.length <= 2);
  }
  const texts = pages.map((page) => pageText(page).join(" "));
  assert.ok(
    texts.some((text) => text.endsWith("монтаж.")),
    texts.join(" | "),
  );
  assert.ok(
    texts.every((text) => !text.includes("монтаж. Смотрите")),
    "a sentence end and a 1 s pause start a new page",
  );
  assert.equal(texts.at(-1), "Смотрите сами.");
  for (let index = 1; index < pages.length; index++)
    assert.ok(pages[index]!.start >= pages[index - 1]!.end - 1e-9, "pages never overlap");
});

test("pages: a page that cannot stay up 0.8 s merges with its neighbour", () => {
  const words = timedWords(
    [
      ["One", 0.15],
      ["two", 0.15],
      ["three", 0.15],
      ["four.", 0.2],
    ],
    0,
  );
  const pages = buildCaptionPages(words, { ...defaults, maxWords: 3 });
  assert.equal(pages.length, 1);
  assert.equal(pageText(pages[0]!).join(" "), "One two three four.");
  assert.ok(pages[0]!.end - pages[0]!.start >= 0.8);
});

test("pages: a lone long word gets its own line budget and the page builder never loops", () => {
  const words: CaptionWord[] = [
    { text: "Достопримечательность", start: 0, end: 1 },
    { text: "рядом", start: 1, end: 1.4 },
  ];
  const pages = buildCaptionPages(words, defaults);
  assert.equal(pages.flatMap((page) => page.words).length, 2);
});

test("existing words.json files become caption words with emphasis kept", () => {
  const words = wordsFromAlignment([
    { text: "Hello", start: 0, end: 0.4, emphasis: true },
    { text: " ", start: 0.4, end: 0.5 },
    { text: "there", start: 0.5, end: 0.5 },
  ]);
  assert.deepEqual(words, [{ text: "Hello", start: 0, end: 0.4, emphasis: true }]);
});

test("the active word is a pure function of time and holds through gaps inside a page", () => {
  const pages = buildCaptionPages(SAMPLE_EN, defaults);
  const first = pages[0]!;
  const between = (first.words[0]!.end + first.words[1]!.start) / 2;
  assert.equal(pageAt(pages, between)?.activeIndex, 0);
  assert.equal(pageAt(pages, first.words[1]!.start)?.activeIndex, 1);
  assert.equal(pageAt(pages, first.start - 0.01), null);
  assert.deepEqual(pageAt(pages, 1.234), pageAt(pages, 1.234));
  assert.deepEqual(buildCaptionPages(SAMPLE_EN, defaults), pages);
});

test("readability check flags lines, words, short pages, reading speed and the safe zone", () => {
  const page = (words: CaptionWord[], start: number, end: number, lines: number[][]): CaptionPage => ({
    words,
    start,
    end,
    lines,
  });
  const w = (text: string): CaptionWord => ({ text, start: 0, end: 0.1 });
  const findings = checkCaptionPages(
    [
      page([w("a"), w("b"), w("c")], 0, 1, [[0], [1], [2]]),
      page([w("one"), w("two"), w("three"), w("four"), w("five")], 1, 2, [[0, 1, 2, 3, 4]]),
      page([w("short")], 2, 2.3, [[0]]),
      page([w("Extraordinarily"), w("verbose")], 3, 3.8, [[0, 1]]),
    ],
    { format: "vertical", box: { left: 90, top: 1300, right: 990, bottom: 1600 }, limits: { maxCharsPerLine: 16 } },
  );
  const codes = findings.map((finding) => `${finding.code}@${finding.pageIndex}`);
  for (const code of [
    "OUTSIDE_SAFE_ZONE@null",
    "TOO_MANY_LINES@0",
    "TOO_MANY_WORDS@1",
    "LINE_TOO_LONG@1",
    "PAGE_TOO_SHORT@2",
    "READING_SPEED@3",
  ])
    assert.ok(codes.includes(code), `${code} in ${codes.join(", ")}`);
  assert.deepEqual(
    checkCaptionPages(buildCaptionPages(SAMPLE_EN, defaults), {
      format: "vertical",
      box: captionBox("vertical", "lower", 90),
    }),
    [],
  );
});

test("safe zones: vertical keeps clear of the platform interface (top 220, bottom 400, right 140 px); square and landscape title-safe", () => {
  assert.deepEqual(CAPTION_SAFE_ZONE.vertical, { left: 140, top: 220, right: 940, bottom: 1520 });
  assert.deepEqual(CAPTION_SAFE_ZONE.square, { left: 108, top: 108, right: 972, bottom: 972 });
  assert.deepEqual(CAPTION_SAFE_ZONE.landscape, { left: 160, top: 54, right: 1760, bottom: 994 });
  const box = centredSafeBox("vertical");
  assert.equal((box.left + box.right) / 2, 540);
  for (const format of ["vertical", "square", "landscape"] as CaptionFormat[]) {
    const zone = CAPTION_SAFE_ZONE[format];
    assert.ok(zone.right <= FRAME_SIZE[format].width && zone.bottom <= FRAME_SIZE[format].height);
    for (const position of ["lower", "middle", "upper"] as const) {
      const placed = captionBox(format, position, 100);
      assert.deepEqual(checkCaptionPages([], { format, box: placed }), [], `${format} ${position}`);
    }
  }
});

test("every caption preset lays its default pages inside the safe zone with no readability errors, in every format", () => {
  for (const id of CAPTION_PRESET_IDS)
    for (const [words, language] of [
      [SAMPLE_EN, "en"],
      [SAMPLE_RU, "ru"],
    ] as const)
      for (const format of ["vertical", "square", "landscape"] as CaptionFormat[]) {
        const { width, height } = FRAME_SIZE[format];
        const p = captionStyleSchema.parse({ ...CAPTION_PRESETS[id], words, language });
        const layout = presetLayout(p, width, height);
        const errors = checkCaptionPages(layout.pages, { format, box: layout.box, limits: presetLimits(p, layout) });
        assert.deepEqual(
          errors.filter(
            (finding) =>
              finding.severity === "error" || finding.code === "LINE_TOO_LONG" || finding.code === "TOO_MANY_WORDS",
          ),
          [],
          `${id} ${format}`,
        );
      }
});

test("keyword matching ignores case and punctuation and keeps the emoji; cues land on spoken keywords", () => {
  assert.deepEqual(keywordOf({ text: "Fix.", start: 0, end: 1 }, [{ word: "fix", emoji: "🔧" }], "en"), {
    emoji: "🔧",
  });
  assert.equal(keywordOf({ text: "fixed", start: 0, end: 1 }, [{ word: "fix" }], "en"), null);
  const p = {
    words: SAMPLE_EN,
    startOffsetSec: 0.5,
    maxWords: 3,
    minPageSec: 0.8,
    position: "lower" as const,
    placement: "safe-zone" as const,
    textScale: 1,
    language: "en",
    textColor: "#fff",
    accent: "#f00",
    keywords: [],
  };
  const cues = emphasisCues(p, (word) => word.emphasis === true, "pop", "hero");
  assert.deepEqual(
    cues.map((cue) => cue.frame),
    SAMPLE_EN.filter((word) => word.emphasis).map((word) => Math.round((word.start - 0.5) * 30)),
  );
});

const timeline = (captionStyle?: unknown): TimelineIR =>
  ({
    version: 1,
    projectId: "x",
    timebase: { num: 30, den: 1 },
    tracks: [
      {
        id: "voice",
        kind: "voiceover",
        clips: [
          {
            id: "a",
            assetId: "voice.wav",
            start: { num: 0, den: 1 },
            source: { start: { num: 0, den: 1 }, end: { num: 90, den: 1 }, timebase: { num: 30, den: 1 } },
            rate: { num: 1, den: 1 },
            transition: { kind: "cut" },
            captions: [
              { id: "c0", text: "Hello", start: { num: 3, den: 1 }, end: { num: 15, den: 1 }, emphasis: true },
              { id: "c1", text: "[music]", start: { num: 15, den: 1 }, end: { num: 30, den: 1 }, kind: "event" },
            ],
          },
        ],
      },
    ],
    ...(captionStyle ? { captionStyle } : {}),
  }) as TimelineIR;

test("profile selection: karaoke by default, the timeline's captionStyle, a render option over both", () => {
  assert.deepEqual(resolveCaptionStyle({ timeline: timeline() }), { profile: "karaoke" });
  assert.deepEqual(
    resolveCaptionStyle({ timeline: timeline({ profile: "bold-upper", options: { accent: "#00FF00" } }) }),
    { profile: "bold-upper", options: { accent: "#00FF00" } },
  );
  assert.equal(
    resolveCaptionStyle({ timeline: timeline({ profile: "bold-upper" }), captionStyle: { profile: "phrase" } }).profile,
    "phrase",
  );
  assert.throws(() => resolveCaptionStyle({ captionStyle: { profile: "bilingual" } }), /sourceLanguage/);
  assert.throws(() => resolveCaptionStyle({ captionStyle: { profile: "neon" } }));
});

test("caption-style edit command sets and clears the timeline's profile, reversibly", () => {
  const before = timeline();
  const styled = applyEdit(before, {
    type: "caption-style",
    style: { profile: "boxed-word", options: { accent: "#7B5CFF" } },
  });
  assert.equal(styled.captionStyle?.profile, "boxed-word");
  assert.equal(before.captionStyle, undefined);
  const cleared = applyEdit(styled, { type: "caption-style", style: null });
  assert.equal(cleared.captionStyle, undefined);
  assert.throws(() =>
    applyEdit(before, {
      type: "caption-style",
      style: { profile: "bilingual", sourceLanguage: "en", translationLanguage: "EN" },
    }),
  );
});

test("timeline captions: output seconds, events and zero-length remnants dropped, shifted onto the clip clock", () => {
  const zeroLength = { id: "c2", text: "world", start: { num: 30, den: 1 }, end: { num: 30, den: 1 } };
  const words = timelineCaptionWords([...timeline().tracks[0]!.clips[0]!.captions, zeroLength], { num: 30, den: 1 });
  assert.deepEqual(words, [{ text: "Hello", start: 0.1, end: 0.5, emphasis: true }]);
  assert.deepEqual(
    shiftWords(
      [
        { start: 5, end: 5.5 },
        { start: 3.5, end: 4.25 },
        { start: 3, end: 4 },
      ],
      4,
    ),
    [
      { start: 1, end: 1.5 },
      { start: 0, end: 0.25 },
    ],
  );
});

test("pages break at every speaker change and never merge a short reply across a sentence end", () => {
  const words: CaptionWord[] = [
    { text: "going", start: 0, end: 0.3, speaker: "a" },
    { text: "to", start: 0.32, end: 0.4, speaker: "a" },
    { text: "be", start: 0.42, end: 0.5, speaker: "a" },
    { text: "worse.", start: 0.52, end: 0.9, speaker: "a" },
    { text: "Yeah.", start: 0.95, end: 1.2, speaker: "b" },
    { text: "regard", start: 2, end: 2.3, speaker: "b" },
    { text: "Yeah,", start: 2.35, end: 2.6, speaker: "a" },
    { text: "that's", start: 2.62, end: 2.9, speaker: "a" },
    { text: "exactly", start: 2.92, end: 3.4, speaker: "a" },
  ];
  const texts = buildCaptionPages(words, defaults).map((page) => pageText(page).join(" "));
  for (const text of texts) {
    assert.ok(!/worse\. Yeah/.test(text), texts.join(" | "));
    assert.ok(!/regard Yeah/.test(text), texts.join(" | "));
  }
  assert.ok(texts.includes("Yeah."), texts.join(" | "));
  const unlabelled = buildCaptionPages(
    words.map(({ speaker: _speaker, ...word }) => word),
    defaults,
  ).map((page) => pageText(page).join(" "));
  assert.ok(
    unlabelled.every((text) => !/worse\. Yeah/.test(text)),
    "a sentence end alone is a hard break too",
  );
  assert.equal(
    wordsFromTranscript({
      words: [
        { id: "w", text: "Hi", kind: "word", startSec: 0, endSec: 0.3, speaker: "s1", channel: null, confidence: null },
      ],
    })[0]!.speaker,
    "s1",
  );
});

test("background check: each treatment is measured against the footage under it, both its dark and bright ends", () => {
  const width = 100,
    height = 100;
  const fill = (r: number, g: number, b: number) => {
    const rgb = new Uint8Array(width * height * 3);
    for (let i = 0; i < rgb.length; i += 3) [rgb[i], rgb[i + 1], rgb[i + 2]] = [r, g, b];
    return { rgb, width, height };
  };
  const white = fill(255, 255, 255),
    dark = fill(20, 20, 20),
    shirt = fill(214, 222, 60);
  const box = { left: 10, top: 60, right: 90, bottom: 90 };
  const check = (
    still: typeof white,
    text: string,
    backing: Parameters<typeof checkCaptionBackground>[2]["pairs"][number]["backing"],
  ) => checkCaptionBackground(still, box, { pairs: [{ label: "text", text, backing }] })?.code ?? null;
  // No treatment: white text fails on a white shirt; dark text fails on dark footage.
  assert.equal(check(white, "#FFFFFF", { kind: "none" }), "LOW_CONTRAST");
  assert.equal(check(dark, "#111111", { kind: "none" }), "LOW_CONTRAST");
  // A thick outline rings every glyph: white on black reads on a white shirt; a hairline does not.
  assert.equal(check(white, "#FFFFFF", { kind: "outline", colour: "#000000", width: 0.1 }), null);
  assert.equal(check(white, "#FFFFFF", { kind: "outline", colour: "#000000", width: 0.02 }), "LOW_CONTRAST");
  // A hard shadow covers one edge only: yellow on a yellow shirt still fails; a box rescues it.
  assert.equal(check(shirt, "#FFE234", { kind: "shadow", colour: "#000000", blur: 0, opacity: 1 }), "LOW_CONTRAST");
  assert.equal(check(shirt, "#FFE234", { kind: "box", fill: "#000000" }), null);
  // A box is measured against its own fill, and a translucent box against the footage through it.
  assert.equal(check(dark, "#111111", { kind: "box", fill: "#FFFFFF" }), null);
  assert.equal(check(white, "#FFFFFF", { kind: "box", fill: "#FFFFFF" }), "LOW_CONTRAST");
  assert.equal(check(white, "#FFFFFF", { kind: "box", fill: "#00000022" }), "LOW_CONTRAST");
  // Every pair is checked: an accent that fails is named even when the main text passes.
  const finding = checkCaptionBackground(shirt, box, {
    pairs: [
      { label: "text", text: "#FFFFFF", backing: { kind: "outline", colour: "#000000", width: 0.1 } },
      { label: "accent", text: "#FFE234", backing: { kind: "shadow", colour: "#000000", blur: 0, opacity: 1 } },
    ],
  });
  assert.match(finding?.message ?? "", /^accent #FFE234 on shadow/);
});
