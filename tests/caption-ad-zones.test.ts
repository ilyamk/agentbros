import assert from "node:assert/strict";
import test from "node:test";
import {
  AD_PLATFORMS,
  AD_UI_BANDS,
  CAPTION_AD_SAFE_ZONE,
  CAPTION_SAFE_ZONE,
  CAPTION_UI_ZONES,
  captionBox,
  captionSafeZone,
  centredSafeBox,
  checkCaptionPages,
  checkCaptionPlacement,
  PLATFORM_UI_BANDS,
  resolveUiZone,
  uiBands,
  uiZoneOf,
  withUiZone,
  type Box,
} from "../src/lib/captions/readability";
import { choosePosition } from "../src/motion/library/captions/legibility";
import { planBounds, planCaptionFrame, presetLayout, type Measure } from "../src/motion/library/captions/plan";
import { SAMPLE_EN } from "../src/motion/library/captions/sample";
import {
  CAPTION_PRESET_IDS,
  CAPTION_PRESETS,
  captionStyleSchema,
  resolveCaptionProps,
  type CaptionStyleProps,
} from "../src/motion/library/captions/style";

const overlaps = (a: Box, b: Box) =>
  Math.min(a.right, b.right) > Math.max(a.left, b.left) && Math.min(a.bottom, b.bottom) > Math.max(a.top, b.top);
const inside = (a: Box, zone: Box) =>
  a.left >= zone.left && a.top >= zone.top && a.right <= zone.right && a.bottom <= zone.bottom;
const fakeMeasure: Measure = { width: (text: string) => text.length * 0.6, ascent: () => 0.95, descent: () => 0.25 };
const props = (id: (typeof CAPTION_PRESET_IDS)[number], extra: Partial<CaptionStyleProps> = {}): CaptionStyleProps =>
  captionStyleSchema.parse({ ...CAPTION_PRESETS[id], words: SAMPLE_EN, ...extra });
const blank = (() => {
  const rgb = new Uint8Array(1080 * 1920 * 3).fill(40);
  return { rgb, width: 1080, height: 1920 };
})();

test("ad bands carry each platform's published template on 1080×1920", () => {
  const edge = (platform: (typeof AD_PLATFORMS)[number], label: RegExp) =>
    AD_UI_BANDS[platform].find((band) => label.test(band.label))!.box;
  // TikTok in-feed template, 720×1280 × 1.5: top 160 → 240, bottom 440 → 660, sides 80 → 120, action column 120+80 wide from 720 up.
  assert.equal(edge("tiktok", /top/).bottom, 240);
  assert.equal(edge("tiktok", /caption/).top, 1920 - 660);
  assert.deepEqual(edge("tiktok", /action/), { left: 780, top: 840, right: 1080, bottom: 1920 });
  // Meta Reels ads: 14% top, 35% bottom, 6% each side.
  assert.equal(edge("reels", /top/).bottom, Math.round(1920 * 0.14));
  assert.equal(edge("reels", /bottom/).top, 1920 - Math.round(1920 * 0.35));
  assert.equal(edge("reels", /left/).right, Math.round(1080 * 0.06));
  // Google's vertical overlay: clear area x 48–888, y 288–1248.
  assert.deepEqual(
    [
      edge("shorts", /top/).bottom,
      edge("shorts", /bottom/).top,
      edge("shorts", /left/).right,
      edge("shorts", /right/).left,
    ],
    [288, 1248, 48, 888],
  );
});

test("organic placement is unchanged", () => {
  assert.equal(uiBands(), PLATFORM_UI_BANDS.vertical);
  assert.equal(uiBands("organic"), PLATFORM_UI_BANDS.vertical);
  for (const format of ["vertical", "square", "landscape"] as const)
    assert.deepEqual(captionSafeZone(format), CAPTION_SAFE_ZONE[format]);
  assert.deepEqual(captionBox("vertical", "lower", 100), captionBox("vertical", "lower", 100, 2, 24, "organic"));
});

test("every ad zone is centred, clear of its bands, inside the organic zone; `ad` fits every platform", () => {
  for (const zone of CAPTION_UI_ZONES.filter((z) => z !== "organic")) {
    const box = CAPTION_AD_SAFE_ZONE[zone];
    assert.equal(box.left + box.right, 1080, `${zone} is centred`);
    assert.ok(inside(box, CAPTION_SAFE_ZONE.vertical), `${zone} is inside the organic zone`);
    for (const band of uiBands(zone)) assert.ok(!overlaps(box, band.box), `${zone} touches ${band.label}`);
    assert.deepEqual(centredSafeBox("vertical", zone), box);
    // Square and landscape have no feed interface to clear: title-safe stays.
    assert.deepEqual(captionSafeZone("landscape", zone), CAPTION_SAFE_ZONE.landscape);
  }
  for (const platform of AD_PLATFORMS)
    assert.ok(inside(CAPTION_AD_SAFE_ZONE.ad, CAPTION_AD_SAFE_ZONE[`ad-${platform}`]), platform);
  assert.equal(
    uiBands("ad").length,
    PLATFORM_UI_BANDS.vertical.length + AD_PLATFORMS.reduce((n, p) => n + AD_UI_BANDS[p].length, 0),
  );
});

test("CAPTION_IN_UI_ZONE follows the chosen interface", () => {
  const low = { left: 300, right: 700, top: 1300, bottom: 1400 };
  assert.deepEqual(checkCaptionPlacement(low, { format: "vertical" }), []);
  const ad = checkCaptionPlacement(low, { format: "vertical", ui: "ad" });
  assert.ok(ad.length > 0 && ad.every((f) => f.code === "CAPTION_IN_UI_ZONE"));
  assert.match(ad.map((f) => f.message).join(" "), /TikTok ad caption/);
  // Wide enough to reach TikTok's action column, high enough to clear every bottom band.
  const wide = { left: 250, right: 830, top: 1000, bottom: 1150 };
  assert.deepEqual(checkCaptionPlacement(wide, { format: "vertical", ui: "ad-reels" }), []);
  assert.match(
    checkCaptionPlacement(wide, { format: "vertical", ui: "ad-tiktok" })[0]!.message,
    /TikTok ad action buttons/,
  );
  assert.deepEqual(checkCaptionPlacement(low, { format: "landscape", ui: "ad" }), []);
  assert.equal(
    checkCaptionPages([], { format: "vertical", box: captionBox("vertical", "lower", 90), ui: "ad" })[0]!.code,
    "OUTSIDE_SAFE_ZONE",
  );
  assert.deepEqual(
    checkCaptionPages([], { format: "vertical", box: captionBox("vertical", "lower", 90, 2, 24, "ad"), ui: "ad" }),
    [],
  );
});

test("an ad layout keeps a lower page lower, raised into the ad zone, and narrower for TikTok", () => {
  const organic = props("outline-pop");
  const ad = props("outline-pop", { uiZone: "ad" });
  const organicLayout = presetLayout(organic, 1080, 1920);
  const adLayout = presetLayout(ad, 1080, 1920);
  assert.equal(adLayout.uiZone, "ad");
  assert.equal(organicLayout.uiZone, "organic");
  assert.equal(adLayout.boxes.lower.bottom, CAPTION_AD_SAFE_ZONE.ad.bottom);
  assert.ok(adLayout.boxes.lower.bottom < organicLayout.boxes.lower.bottom);
  assert.equal(adLayout.boxes.lower.right - adLayout.boxes.lower.left, 480);
  assert.ok(adLayout.maxCharsPerLine <= organicLayout.maxCharsPerLine);
  const page = adLayout.pages[0]!;
  const local = Math.ceil((page.words.at(-1)!.start - ad.startOffsetSec) * 30);
  const chosen = choosePosition(ad, adLayout, local, 30, 1920, { faces: [], still: blank });
  assert.equal(chosen.position, "lower");
  assert.deepEqual(chosen.findings, []);
  assert.ok(chosen.candidates.every((candidate) => !candidate.ui));
  const drawn = planBounds(planCaptionFrame(ad, adLayout, fakeMeasure, local, 30, 1920)!);
  for (const band of uiBands("ad")) assert.ok(!overlaps(drawn, band.box), band.label);
  // The same page laid out for organic posts and judged against the ad interface is flagged.
  const organicPage = organicLayout.pages[0]!;
  const organicLocal = Math.ceil((organicPage.words.at(-1)!.start - organic.startOffsetSec) * 30);
  assert.ok(
    checkCaptionPlacement(planBounds(planCaptionFrame(organic, organicLayout, fakeMeasure, organicLocal, 30, 1920)!), {
      format: "vertical",
      ui: "ad",
    }).length > 0,
  );
});

test("the zone survives the timeline's caption-style options", () => {
  const p = captionStyleSchema.parse({
    ...resolveCaptionProps("outline-pop", { uiZone: "ad-tiktok" }),
    words: SAMPLE_EN,
  });
  assert.equal(p.uiZone, "ad-tiktok");
  assert.equal(
    captionStyleSchema.parse({ ...resolveCaptionProps("outline-pop", {}), words: SAMPLE_EN }).uiZone,
    undefined,
  );
  assert.throws(() =>
    captionStyleSchema.parse({ ...resolveCaptionProps("outline-pop", { uiZone: "ad-x" }), words: SAMPLE_EN }),
  );
});

test("captions:place resolves the zone from flags, then the recorded style, then organic", () => {
  assert.equal(uiZoneOf("organic"), "organic");
  assert.equal(uiZoneOf("ad"), "ad");
  assert.equal(uiZoneOf("ad", "reels"), "ad-reels");
  assert.equal(resolveUiZone(undefined, undefined), "organic");
  assert.equal(resolveUiZone(undefined, undefined, "ad-shorts"), "ad-shorts");
  assert.equal(resolveUiZone(undefined, undefined, "nonsense"), "organic");
  assert.equal(resolveUiZone("organic", undefined, "ad"), "organic");
  assert.equal(resolveUiZone("ad", undefined, "ad-tiktok"), "ad");
  assert.equal(resolveUiZone(undefined, "tiktok"), "ad-tiktok");
  assert.throws(() => resolveUiZone("organic", "tiktok"), /--placement ad only/);
  assert.deepEqual(withUiZone({ position: "middle", uiZone: "ad" }, "organic"), { position: "middle" });
  assert.deepEqual(withUiZone(undefined, "ad-reels"), { uiZone: "ad-reels" });
});
