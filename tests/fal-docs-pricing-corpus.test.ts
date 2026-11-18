import "./helpers/fal-no-network";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  checkFalPricingExample,
  estimateFalUnitPrice,
  parseFalPricingSection,
} from "../src/lib/models/fal-docs-pricing";
import type { FalUnitSemantics } from "../src/types/fal-unit-semantics";

const corpus = JSON.parse(readFileSync("tests/fixtures/fal-docs-pricing/live-2026-11-16.json", "utf8")) as {
  endpoint: string;
  quote: string;
  api?: { unit: string; unitPrice: number };
}[];
const parse = (endpoint: string) => {
  const source = corpus.find((row) => row.endpoint === endpoint)!;
  assert.ok(source, endpoint);
  return parseFalPricingSection(`## Pricing\n${source.quote}`, endpoint, "2026-11-16", { apiUnit: source.api?.unit })!;
};
const synthetic = (text: string) => parseFalPricingSection(`## Pricing\n${text}`, "test/tariff", "2026-11-16")!;
const usd = (row: FalUnitSemantics, input: Parameters<typeof estimateFalUnitPrice>[2], rate = row.unitPrice!) => {
  const result = estimateFalUnitPrice(row, rate, input);
  assert.ok("usd" in result, JSON.stringify(result));
  return result.usd;
};

test("live 2026-11-16 corpus: all structured totals agree; genuinely ambiguous coverage is bounded", () => {
  assert.equal(corpus.length, 1207);
  let ambiguous = 0,
    repeated = 0,
    examples = 0;
  for (const source of corpus) {
    const row = parse(source.endpoint);
    if (row.meaning === "ambiguous") {
      if (row.reason === "Page repeats the API unit") repeated++;
      else ambiguous++;
      continue;
    }
    assert.equal(checkFalPricingExample(row), undefined, source.endpoint);
    if (row.example) examples++;
    // Rates must occur literally in the page, or be the explicitly stated resolution multiplier.
    const literalRates = [...source.quote.replaceAll("**", "").matchAll(/\$(\d+(?:\.\d+)?)/g)].map((m) => Number(m[1]));
    const multiplier = /cost will be ([\d.]+)x/i.exec(source.quote);
    for (const rate of [
      row.unitPrice,
      ...(row.tiers?.map((t) => t.usdPerUnit) ?? []),
      ...(row.clips?.map((c) => c.usd) ?? []),
    ].filter((rate): rate is number => rate !== undefined)) {
      assert.ok(
        literalRates.some(
          (value) =>
            Math.abs(value - rate) < 1e-9 || (multiplier && Math.abs(value * Number(multiplier[1]) - rate) < 1e-9),
        ),
        `${source.endpoint}: unsubstantiated rate ${rate}`,
      );
    }
  }
  assert.equal(repeated, 535);
  assert.ok(examples >= 60, `checked ${examples} explicit examples`);
  // Measured offline result: fewer than 440 genuinely unclear quotes, down from 1,207 undifferentiated records.
  assert.ok(ambiguous < 440, `${ambiguous} genuinely ambiguous quotes`);
});

test("real-page goldens cover every requested tariff family", () => {
  const cases: [string, Parameters<typeof estimateFalUnitPrice>[2], number][] = [
    ["fal-ai/ltx-2.3-22b/audio-to-video", { durationSec: 121 / 24, width: 1280, height: 720 }, 112 * 0.001605],
    ["fal-ai/creatify/aurora", { durationSec: 10, resolution: "720p" }, 1.4],
    ["fal-ai/vidu/q3/image-to-video", { durationSec: 10, resolution: "1080p" }, 1.54],
    ["fal-ai/pixverse/c1/image-to-video", { durationSec: 5, resolution: "720p", generateAudio: true }, 0.325],
    ["fal-ai/kling-video/o3/pro/image-to-video", { durationSec: 5, generateAudio: true }, 0.7],
    ["fal-ai/kling-video/v3/pro/image-to-video", { durationSec: 5, generateAudio: true, voiceControl: true }, 0.98],
    ["google/gemini-omni-flash/v1.1/edit", { durationSec: 10, resolution: "1080p" }, 1.5],
    ["alibaba/happy-horse/image-to-video", { durationSec: 10, resolution: "1080p" }, 2.8],
    ["creatify/boreal", { durationSec: 10, resolution: "2K" }, 1.2],
    ["fal-ai/ltx-2.3/image-to-video", { durationSec: 10, resolution: "2160p" }, 3.2],
    ["fal-ai/heygen/avatar3/digital-twin", { durationSec: 10 }, 0.34],
    ["fal-ai/ace-step", { durationSec: 10 }, 0.002],
    ["fal-ai/kling-video/v2.5-turbo/pro/image-to-video", { durationSec: 7 }, 0.49],
    ["fal-ai/pixverse/extend", { durationSec: 5, resolution: "720p" }, 0.2],
    ["bytedance/seedance-2.5/image-to-video", { durationSec: 10, resolution: "720p" }, 4.73],
    ["heygen/heygen-video/image-to-video", { durationSec: 10, resolution: "1080p" }, 0.6],
    ["minimax/h3-max-turbo/image-to-video", { durationSec: 10, resolution: "1080p" }, 0.8],
    ["sonilo/v1.1/text-to-music", { durationSec: 10, samples: 2 }, 0.05],
  ];
  for (const [endpoint, input, expected] of cases) {
    const row = parse(endpoint);
    assert.notEqual(row.meaning, "ambiguous", endpoint);
    const actual = usd(row, input);
    assert.ok(Math.abs(actual - expected) < 1e-9, `${endpoint}: ${actual} != ${expected}`);
  }
  assert.match(parse("heygen/heygen-video/image-to-video").reason!, /regular tariff/);
  const megapixels = parse("fal-ai/ltx-2.3-22b/audio-to-video");
  assert.equal(megapixels.meaning, "video-megapixel");
  assert.equal(megapixels.roundUp, true);
  assert.equal(checkFalPricingExample(megapixels), undefined);
});

test("examples validate both audio totals, resolution lists, ranges, dimensions in either order and rounded totals", () => {
  const grid = parse("fal-ai/pixverse/c1/image-to-video");
  assert.match(checkFalPricingExample(grid, grid.example!.text.replace("0.325", "0.425"))!, /Example total/);
  assert.match(checkFalPricingExample(grid, grid.example!.text.replace("0.250", "0.450"))!, /Example total/);
  assert.equal(checkFalPricingExample(parse("creatify/boreal")), undefined);
  const range = synthetic("$0.05 per second of generated video. For example, a 5-10 second video costs $0.25-$0.50.");
  assert.equal(range.meaning, "generated-second");
});

test("unrepresented extras, modes, input charges and minima stay ambiguous", () => {
  for (const text of [
    "For 5s video your request will cost $0.35. For every additional second you will be charged $0.07. Plus $2 per request.",
    "$0.03 per megapixel. LoRAs accrue an extra 50% charge.",
    "Video costs $0.063 per second at 720p, billed on the output duration plus the greater of the input video duration and the output duration.",
    "Video costs $0.094 per second at 720p, billed on the input plus output length (minimum 2x the output).",
    "Your request will be charged at $0.01 per second of the input video, with a minimum charge for 60 seconds.",
    "Your request will cost $0.15 per image. For $1.00, you can generate 6 standard images. 4K outputs will be charged at double the standard rate.",
  ])
    assert.equal(synthetic(text).meaning, "ambiguous");
  for (const endpoint of [
    "google/gemini-omni-flash/v1.2/reference-to-video",
    "pixverse/music-video/vibemv",
    "blackforestlabs/flux-video-upscale",
  ])
    assert.equal(parse(endpoint).meaning, "ambiguous", endpoint);
  const text = corpus.find((r) => r.endpoint === "blackforestlabs/flux-video-upscale")!.quote;
  const precise = parseFalPricingSection(`## Pricing\n${text}`, "test/upscale", "2026-11-16", {
    defaultMode: "precise",
  })!;
  assert.ok(Math.abs(usd(precise, { durationSec: 10, resolution: "1080p" }) - 0.84) < 1e-9);
});
