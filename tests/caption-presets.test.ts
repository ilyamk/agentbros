import assert from "node:assert/strict";
import test from "node:test";
import { pageTiers, wordImportance } from "../src/lib/captions/emphasis";
import { buildCaptionPages, pageText, type CaptionWord } from "../src/lib/captions/pages";
import { resolveCaptionStyle } from "../src/lib/captions/profiles";
import { CaptionProfileIdSchema } from "../src/types/caption-style";
import { FACE_IDS, type FaceId } from "../src/motion/library/captions/faces";
import {
  captionSizeFindings,
  chooseLevel,
  contrastPairs,
  entryAt,
  pageRoles,
  planBounds,
  planCaptionFrame,
  presetLayout,
  typedCount,
  type Measure,
} from "../src/motion/library/captions/plan";
import { choosePosition, legibilityRanges, positionRanges } from "../src/motion/library/captions/legibility";
import {
  CAPTION_SAFE_ZONE,
  checkCaptionPlacement,
  checkCaptionSizes,
  FRAME_SIZE,
  MIN_CAP_HEIGHT,
  PLATFORM_UI_BANDS,
  type CaptionFormat,
} from "../src/lib/captions/readability";
import { SAMPLE_EN, timedWords } from "../src/motion/library/captions/sample";
import {
  CAPTION_PRESET_IDS,
  CAPTION_PRESETS,
  captionStyleSchema,
  escalate,
  LEGACY_CAPTION_PROFILES,
  legibilityLevel,
  resolveCaptionProps,
  type CaptionStyleProps,
} from "../src/motion/library/captions/style";

// Widths proportional to characters: enough for the planner, which only needs consistent numbers.
const fakeMeasure: Measure = {
  width: (text: string, face: FaceId) => text.length * (face === "extra-condensed" ? 0.4 : 0.6),
  ascent: () => 0.95,
  descent: () => 0.25,
};

const props = (id: (typeof CAPTION_PRESET_IDS)[number], extra: Partial<CaptionStyleProps> = {}): CaptionStyleProps =>
  captionStyleSchema.parse({ ...CAPTION_PRESETS[id], words: SAMPLE_EN, ...extra });

test("the schema accepts every preset and every legacy profile, from the timeline and as block props", () => {
  assert.ok(CAPTION_PRESET_IDS.length >= 8 && CAPTION_PRESET_IDS.length <= 12);
  for (const id of [...CAPTION_PRESET_IDS, ...Object.keys(LEGACY_CAPTION_PROFILES)]) {
    assert.equal(CaptionProfileIdSchema.parse(id), id);
    assert.equal(resolveCaptionStyle({ captionStyle: { profile: id } }).profile, id);
    captionStyleSchema.parse({ ...resolveCaptionProps(id as never), words: SAMPLE_EN });
  }
  for (const preset of Object.values(CAPTION_PRESETS)) assert.ok((FACE_IDS as readonly string[]).includes(preset.face));
});

test("legacy profiles keep working: old options parse, the scrim is dropped, matching options still apply", () => {
  const old = resolveCaptionProps("bold-upper", {
    accent: "#00FF00",
    backing: 0.72,
    shadow: 1,
    font: "condensed",
    maxWords: 2,
  });
  const parsed = captionStyleSchema.parse({ ...old, words: SAMPLE_EN });
  assert.equal(parsed.accent, "#00FF00");
  assert.equal(parsed.face, "extra-condensed");
  assert.equal(parsed.maxWords, 2);
  assert.equal(parsed.backing.kind, "outline");
  const boxed = captionStyleSchema.parse({
    ...resolveCaptionProps("boxed-word", { boxText: "#111111", radius: 0.3, backing: 0 }),
    words: SAMPLE_EN,
  });
  assert.equal(boxed.active.box, true);
  assert.equal(boxed.active.boxText, "#111111");
  const keyword = captionStyleSchema.parse({
    ...resolveCaptionProps("keyword-emphasis", { keywords: [{ word: "fix", emoji: "🔧" }], keywordScale: 1.3 }),
    words: SAMPLE_EN,
  });
  assert.equal(keyword.emphasis.scale, 1.3);
  assert.equal(keyword.emphasis.source, "marked");
  captionStyleSchema.parse({
    ...resolveCaptionProps("word-highlight", { upcomingOpacity: 0.4, stroke: 0.1 }),
    words: SAMPLE_EN,
  });
});

test("nested options merge one level deep; a backing of another kind replaces the preset's", () => {
  const thicker = captionStyleSchema.parse({
    ...resolveCaptionProps("outline-pop", { backing: { width: 0.14 } }),
    words: [],
  });
  assert.deepEqual(thicker.backing, { kind: "outline", colour: "#000000", width: 0.14, depth: 0.05 });
  const boxed = captionStyleSchema.parse({
    ...resolveCaptionProps("outline-pop", { backing: { kind: "box", fill: "#000000" } }),
    words: [],
  });
  assert.deepEqual(boxed.backing, { kind: "box", fill: "#000000", scope: "line", padX: 0.28, padY: 0.08, radius: 0.2 });
  assert.throws(() =>
    captionStyleSchema.parse({ ...resolveCaptionProps("outline-pop", { backing: { kind: "scrim" } }), words: [] }),
  );
});

test("paging honours 1..6 words a page, with 1 a hard single-word mode, and still breaks at sentence ends", () => {
  const words = timedWords(
    [
      ["One", 0.15],
      ["two", 0.15],
      ["three", 0.15],
      ["four.", 0.2],
      ["Five", 0.2],
      ["six", 0.2],
      ["seven", 0.2],
      ["eight", 0.2],
    ],
    0,
  );
  for (let maxWords = 1; maxWords <= 6; maxWords++) {
    const pages = buildCaptionPages(words, { maxWords, maxCharsPerLine: 40, minPageSec: maxWords === 1 ? 0.2 : 0.8 });
    for (const page of pages)
      assert.ok(
        page.words.length <= (maxWords >= 3 ? maxWords + 1 : maxWords),
        `${maxWords}: ${pageText(page).join(" ")}`,
      );
    assert.ok(
      pages.every((page) => !pageText(page).join(" ").includes("four. Five")),
      `${maxWords}: a sentence end breaks the page`,
    );
    if (maxWords === 1) assert.equal(pages.length, words.length);
  }
  const strict = buildCaptionPages(words, { maxWords: 3, maxCharsPerLine: 40, strictWords: true });
  assert.ok(strict.every((page) => page.words.length <= 3));
  const single = presetLayout(props("single-punch"), 1080, 1920);
  assert.ok(single.pages.every((page) => page.words.length === 1));
  const stack = presetLayout(props("chunky-stack"), 1080, 1920);
  assert.ok(
    stack.pages.every((page) => page.words.length <= 3),
    "stacked pages never exceed their line count",
  );
});

test("emphasis heuristic: marked and listed first, then numbers, then the longest content word; connective words small", () => {
  const w = (text: string, emphasis?: boolean): CaptionWord => ({
    text,
    start: 0,
    end: 1,
    ...(emphasis ? { emphasis } : {}),
  });
  assert.ok(wordImportance(w("the"), "en") === 0 && wordImportance(w("и"), "ru") === 0);
  assert.ok(wordImportance(w("40.3"), "en") > wordImportance(w("temperature"), "en"));
  assert.ok(wordImportance(w("quit", true), "en") > wordImportance(w("40.3"), "en"));
  assert.deepEqual(pageTiers([w("the"), w("highest"), w("temperature")], "en", { source: "auto" }), [
    "small",
    "base",
    "key",
  ]);
  assert.deepEqual(pageTiers([w("the"), w("highest"), w("temperature")], "en", { source: "marked" }), [
    "small",
    "base",
    "base",
  ]);
  assert.deepEqual(pageTiers([w("the"), w("highest"), w("fix")], "en", { source: "marked", keywords: ["Fix"] }), [
    "small",
    "base",
    "key",
  ]);
  assert.deepEqual(
    pageTiers([w("Now,"), w("last"), w("year,")], "en", { source: "auto" }),
    ["base", "base", "base"],
    "no short word is forced into the key role",
  );
  const mixed = props("editorial-mix");
  assert.deepEqual(pageRoles(mixed, [w("temperature"), w("of"), w("40.3")]), ["serif", "small", "key"]);
});

test("every preset plans each frame deterministically and keeps its words inside the frame", () => {
  for (const id of CAPTION_PRESET_IDS)
    for (const [width, height] of [
      [1080, 1920],
      [1080, 1080],
      [1920, 1080],
    ] as const) {
      const p = props(id);
      const layout = presetLayout(p, width, height);
      let drawn = 0;
      for (let frame = 0; frame < 120; frame += 3) {
        const a = planCaptionFrame(p, layout, fakeMeasure, frame, 30, height);
        assert.deepEqual(planCaptionFrame(p, layout, fakeMeasure, frame, 30, height), a, `${id} frame ${frame}`);
        if (!a) continue;
        drawn++;
        for (const word of a.words) {
          assert.ok(
            Number.isFinite(word.left + word.top + word.width + word.height + word.scale + word.opacity),
            `${id} ${frame}`,
          );
          assert.ok(
            word.left >= 0 && word.left + word.width <= width && word.top >= 0 && word.top + word.height <= height,
            `${id} ${width}x${height} frame ${frame}: ${JSON.stringify(word)}`,
          );
        }
      }
      assert.ok(drawn > 10, `${id} draws captions`);
    }
});

test("entries are short, settle to rest, and are pure functions of the frame", () => {
  for (const entry of ["pop", "rise", "fade", "blur", "bounce", "slam", "none"] as const) {
    assert.equal(entryAt(entry, 9, 10, 30).opacity, 0, `${entry} is hidden before it arrives`);
    const settled = entryAt(entry, 10 + 12, 10, 30);
    assert.ok(
      Math.abs(settled.opacity - 1) < 1e-6 &&
        Math.abs(settled.scale - 1) < 0.01 &&
        Math.abs(settled.riseEm) < 0.02 &&
        settled.blurEm < 0.01,
      `${entry} settles within 12 frames`,
    );
    assert.ok(entryAt(entry, 10 + 4, 10, 30).opacity > 0.6, `${entry} is visible within 4 frames`);
  }
  const pop = [0, 1, 2, 3, 4, 5, 6].map((f) => entryAt("pop", 10 + f, 10, 30).scale);
  assert.ok(Math.max(...pop) > 1, "pop overshoots");
  const word = { text: "temperature", start: 1, end: 1.5 };
  assert.equal(typedCount(word, word.text, 0.99), 0);
  assert.equal(typedCount(word, word.text, 1 + 11 * 0.045), word.text.length);
});

test("single-word mode shows exactly one word; active box and cursor appear where their presets ask", () => {
  const single = props("single-punch");
  const layout = presetLayout(single, 1080, 1920);
  for (let frame = 0; frame < 120; frame += 5) {
    const plan = planCaptionFrame(single, layout, fakeMeasure, frame, 30, 1920);
    if (plan) assert.equal(plan.words.length, 1);
  }
  const box = props("word-box");
  const boxPlan = planCaptionFrame(box, presetLayout(box, 1080, 1920), fakeMeasure, 20, 30, 1920);
  assert.ok(boxPlan?.activeBox, "word-box draws the sliding accent box");
  const typer = props("typewriter");
  const typed = planCaptionFrame(typer, presetLayout(typer, 1080, 1920), fakeMeasure, 10, 30, 1920);
  assert.ok(typed?.cursor && typed.boxes.length > 0, "typewriter draws a cursor on a growing box");
});

test("contrast pairs cover every colour a preset draws", () => {
  const box = contrastPairs(props("word-box"));
  assert.deepEqual(
    box.map((pair) => pair.label),
    ["text", "active word"],
  );
  assert.deepEqual(
    contrastPairs(props("editorial-mix")).map((pair) => pair.label),
    ["text", "accent", "serif accent"],
  );
  assert.equal(contrastPairs(props("line-box"))[0]!.backing.kind, "box");
});

const flatStill = (r: number, g: number, b: number) => {
  const rgb = new Uint8Array(1080 * 1920 * 3);
  for (let i = 0; i < rgb.length; i += 3) [rgb[i], rgb[i + 1], rgb[i + 2]] = [r, g, b];
  return { rgb, width: 1080, height: 1920 };
};

test("legibility ladder: rungs apply in order, change only colours and backing, and the level lands on its page", () => {
  for (const id of CAPTION_PRESET_IDS) {
    const p = props(id);
    const top = escalate(p, 3);
    const { backing: _a, textColor: _b, accent: _c, accent2: _d, ...rest } = top;
    const { backing: _e, textColor: _f, accent: _g, accent2: _h, ...same } = p;
    assert.deepEqual(rest, same, id);
  }
  // Pages are keyed by their start in caption seconds, the clock of the words, whatever the clip's offset.
  const offset = 12;
  const words = SAMPLE_EN.map((word) => ({ ...word, start: word.start + offset, end: word.end + offset }));
  const base = captionStyleSchema.parse({ ...CAPTION_PRESETS["italic-shadow"], words, startOffsetSec: offset });
  const layout = presetLayout(base, 1080, 1920);
  const second = layout.pages[1]!;
  const p = { ...base, legibility: [{ from: second.start, to: second.end, level: 1 }] };
  assert.equal(legibilityLevel(p, layout.pages[0]!.start), 0);
  assert.equal(legibilityLevel(p, second.start), 1);
  const frameOf = (sec: number) => Math.round((sec - offset) * 30) + 1;
  assert.equal(
    planCaptionFrame(p, layout, fakeMeasure, frameOf(layout.pages[0]!.start), 30, 1920)!.backing.kind,
    "shadow",
  );
  const escalated = planCaptionFrame(p, layout, fakeMeasure, frameOf(second.start), 30, 1920)!;
  assert.equal(escalated.level, 1);
  assert.equal(escalated.backing.kind, "outline");
  assert.deepEqual(presetLayout(p, 1080, 1920).pages, layout.pages);
});

test("chooseLevel escalates only when the footage defeats the treatment, and reports a top rung that still fails", () => {
  const p = props("italic-shadow");
  const layout = presetLayout(p, 1080, 1920);
  const plan = planCaptionFrame(p, layout, fakeMeasure, Math.round((layout.pages[0]!.end - 0.05) * 30), 30, 1920)!;
  const box = planBounds(plan);
  assert.deepEqual(chooseLevel(p, flatStill(20, 20, 24), box), { level: 0, finding: null });
  const yellow = chooseLevel(p, flatStill(240, 200, 40), box);
  assert.equal(yellow.level, 1);
  assert.equal(yellow.finding, null);
  const bare = { ...p, fallbacks: [] };
  const stuck = chooseLevel(bare, flatStill(240, 200, 40), box);
  assert.equal(stuck.level, 0);
  assert.equal(stuck.finding?.code, "LOW_CONTRAST");
  // Every preset's top rung reads on white, on black and on saturated yellow.
  for (const id of CAPTION_PRESET_IDS) {
    const q = props(id);
    for (const still of [flatStill(255, 255, 255), flatStill(0, 0, 0), flatStill(250, 220, 30)])
      assert.equal(chooseLevel(q, still, box).finding, null, id);
  }
});

test("minimum readable size: every preset clears the cap-height floor at 1080x1920 as laid out, and small type is flagged", () => {
  for (const id of CAPTION_PRESET_IDS) {
    const p = props(id);
    const findings = captionSizeFindings(p, presetLayout(p, 1080, 1920), fakeMeasure, 30, 1920);
    assert.deepEqual(findings, [], `${id}: ${findings.map((f) => f.message).join("; ")}`);
  }
  const tiny = checkCaptionSizes(
    [
      {
        pageIndex: 3,
        words: [
          { text: "so", fontSize: 50, capHeightEm: 0.7, small: false },
          { text: "of", fontSize: 56, capHeightEm: 0.7, small: true },
        ],
      },
    ],
    1920,
  );
  assert.equal(tiny.length, 1);
  assert.equal(tiny[0]!.code, "TEXT_TOO_SMALL");
  assert.match(tiny[0]!.message, /"so"/);
  assert.doesNotMatch(tiny[0]!.message, /"of"/);
  assert.equal(Math.round(MIN_CAP_HEIGHT.base * 1920), 58);
});

test("legibility ranges merge consecutive pages at one level and stop at a level-0 page", () => {
  const ranges = legibilityRanges([
    { start: 0.1234, end: 1, level: 1 },
    { start: 1.2, end: 2, level: 1 },
    { start: 2.1, end: 3, level: 0 },
    { start: 3.1, end: 4, level: 1 },
  ]);
  assert.deepEqual(ranges, [
    { from: 0.123, to: 2, level: 1 },
    { from: 3.1, to: 4, level: 1 },
  ]);
});

const pagePlan = (p: CaptionStyleProps, format: CaptionFormat, pageIndex = 0) => {
  const { width, height } = FRAME_SIZE[format];
  const layout = presetLayout(p, width, height);
  const page = layout.pages[pageIndex]!;
  const local = Math.ceil((page.words.at(-1)!.start - p.startOffsetSec) * 30);
  return { layout, local, width, height, plan: planCaptionFrame(p, layout, fakeMeasure, local, 30, height)! };
};

test("placement zones: every preset sits in its format's zone, lower pages in the lower-middle, none under the platform interface", () => {
  for (const id of CAPTION_PRESET_IDS)
    for (const format of ["vertical", "square", "landscape"] as CaptionFormat[]) {
      const p = props(id);
      const { plan, height } = pagePlan(p, format);
      const box = planBounds(plan);
      const zone = CAPTION_SAFE_ZONE[format];
      assert.ok(
        box.top >= zone.top - 1 &&
          box.bottom <= zone.bottom + 1 &&
          box.left >= zone.left - 1 &&
          box.right <= zone.right + 1,
        `${id} ${format} ${JSON.stringify(box)}`,
      );
      assert.deepEqual(checkCaptionPlacement(box, { format }), [], `${id} ${format}`);
      if (p.position === "lower")
        assert.ok(
          box.bottom > height * (format === "vertical" ? 0.74 : 0.85),
          `${id} ${format}: lower page bottom at ${Math.round(box.bottom)}`,
        );
    }
  const under = checkCaptionPlacement({ left: 200, right: 880, top: 1450, bottom: 1600 }, { format: "vertical" });
  assert.deepEqual(
    under.map((finding) => finding.code),
    ["CAPTION_IN_UI_ZONE"],
  );
  assert.match(under[0]!.message, /caption, username and music/);
  assert.equal(
    checkCaptionPlacement({ left: 900, right: 1000, top: 800, bottom: 900 }, { format: "vertical" })[0]!.code,
    "CAPTION_IN_UI_ZONE",
  );
  assert.equal(PLATFORM_UI_BANDS.vertical.length, 3);
  assert.deepEqual(
    checkCaptionPlacement({ left: 200, right: 880, top: 1700, bottom: 1800 }, { format: "landscape" }),
    [],
  );
});

test("placement decision: keeps the preset's position when clear, moves off a face, deterministic; recorded positions draw; an explicit position wins", () => {
  const p = props("outline-pop");
  const { layout, local, plan } = pagePlan(p, "vertical");
  const blank = flatStill(40, 40, 40);
  assert.equal(choosePosition(p, layout, local, 30, 1920, { faces: [], still: blank }).position, "lower");
  // A face low in the frame, where the lower page would sit: the page moves up, to the next free position.
  const lowFace = { left: 300, right: 780, top: 1150, bottom: 1500 };
  const moved = choosePosition(p, layout, local, 30, 1920, { faces: [lowFace], still: blank });
  assert.notEqual(moved.position, "lower");
  assert.deepEqual(choosePosition(p, layout, local, 30, 1920, { faces: [lowFace], still: blank }), moved);
  assert.equal(moved.findings.filter((f) => f.code === "CAPTION_OVER_FACE").length, 0);
  // No position is free: the least bad one comes back with its CAPTION_OVER_FACE warning.
  const everywhere = choosePosition(p, layout, local, 30, 1920, {
    faces: [{ left: 0, right: 1080, top: 0, bottom: 1920 }],
    still: blank,
  });
  assert.equal(everywhere.position, "lower");
  assert.equal(everywhere.findings[0]!.code, "CAPTION_OVER_FACE");
  // A middle preset over a talking head drops below the chin.
  const punch = props("single-punch");
  const punchPlan = pagePlan(punch, "vertical");
  assert.equal(
    choosePosition(punch, punchPlan.layout, punchPlan.local, 30, 1920, {
      faces: [{ left: 380, right: 700, top: 500, bottom: 980 }],
      still: blank,
    }).position,
    "lower",
  );
  // Recorded positions move the page; an explicit position in the options drops them.
  const second = layout.pages[1]!;
  const placed = {
    ...p,
    positions: positionRanges([{ start: second.start, end: second.end, position: "upper" }], "lower"),
  };
  const at = (q: CaptionStyleProps, page: typeof second) =>
    planCaptionFrame(q, layout, fakeMeasure, Math.ceil((page.words.at(-1)!.start - q.startOffsetSec) * 30), 30, 1920)!;
  assert.equal(at(placed, layout.pages[0]!).position, "lower");
  assert.equal(at(placed, second).position, "upper");
  assert.ok(planBounds(at(placed, second)).top < planBounds(plan).top);
  const override = captionStyleSchema.parse({
    ...resolveCaptionProps("outline-pop", { positions: placed.positions, position: "middle" }),
    words: SAMPLE_EN,
  });
  assert.deepEqual(override.positions, []);
  assert.equal(override.position, "middle");
});
