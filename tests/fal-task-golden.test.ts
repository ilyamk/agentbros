import "./helpers/fal-no-network";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { buildCatalogEntry, loadCatalog } from "../src/lib/models/fal-catalog";
import type { FalApiModel } from "../src/lib/providers/fal-openapi";
import { findFalEndpointResult } from "../src/lib/models/fal-find";
import { normaliseTaskTokens, parseFalTask } from "../src/lib/models/fal-task-map";
import { falFixtureManifest, useTempFalCatalog } from "./helpers/fal-temp-catalog";
import golden from "./fixtures/task-map/golden.json";

for (const row of golden)
  test(`task golden (${row.source}): ${row.phrase}`, () => {
    const parsed = parseFalTask(row.phrase);
    assert.equal(parsed.matched, row.matched);
    for (const field of ["concepts", "categories", "roles", "inputs"] as const) {
      for (const value of row[field] ?? [])
        assert.ok(
          (parsed[field] as string[]).includes(value),
          `Expected ${field} ${value}; got ${parsed[field].join(", ")}`,
        );
    }
    for (const concept of row.absentConcepts ?? [])
      assert.ok(!parsed.concepts.includes(concept), `Unexpected concept ${concept}`);
    if (row.source === "task-search-follow-up") assert.deepEqual(parsed.categories, row.categories);
    if (row.excludedHints !== undefined) assert.deepEqual(parsed.excludedHints, row.excludedHints);
    if (row.durationSec !== undefined) assert.equal(parsed.durationSec, row.durationSec);
    if (row.aspect !== undefined) assert.equal(parsed.aspect, row.aspect);
  });

test("normalisation covers case, ё, punctuation, plurals and common suffixes deterministically", () => {
  assert.deepEqual(normaliseTaskTokens("ДОРОЖКИ, дорожка! Ёлка"), ["дорожк", "елка"]);
  assert.deepEqual(normaliseTaskTokens("Models, model; edited EDIT"), ["model", "edit"]);
  assert.deepEqual(
    parseFalTask("ВИДЕО: человека заменить!").categories,
    parseFalTask("заменить человека в видео").categories,
  );
  assert.equal(parseFalTask("10,5 секунд 9 : 16 1080p").durationSec, 10.5);
  assert.equal(parseFalTask("10,5 секунд 9 : 16 1080p").aspect, "9:16");
  assert.equal(parseFalTask("10,5 секунд 9 : 16 1080p").resolution, "1080p");
  assert.ok(
    !parseFalTask("music stems").concepts.includes("music"),
    "noneOf excludes a conflicting music-generation concept",
  );
});

const entries = Object.entries(falFixtureManifest.endpoints).map(([endpoint, fixture]) => {
  const model = JSON.parse(
    readFileSync(path.join(import.meta.dirname, "fixtures/fal-catalog/schemas", `${fixture.sha256}.json`), "utf8"),
  ) as FalApiModel;
  return { endpoint, patch: buildCatalogEntry(model, { today: "2026-11-15", verifiedPins: {} }) };
});
useTempFalCatalog(entries);
const catalog = loadCatalog();
const probes: [string, string[]][] = [
  ["сгенерируй видео по тексту", ["text-to-video"]],
  ["make a video", ["text-to-video"]],
  ["отредактируй фото", ["image-to-image"]],
  ["убрать шум из аудио", ["audio-to-audio"]],
  ["говорящая голова", ["audio-to-video", "image-to-video", "text-to-video"]],
  ["примерка одежды", ["image-to-image"]],
  ["influencer photo", ["text-to-image"]],
];
for (const [task, categories] of probes)
  test(`fixture probe never crosses categories: ${task}`, () => {
    const result = findFalEndpointResult({ task }, { catalog, env: {} });
    assert.equal(result.match.via, "task-map");
    for (const row of result.candidates) assert.ok(categories.includes(row.category), row.endpoint);
    // Try-on and Soul are not in this fal fixture. A recognised task with no compatible
    // endpoint must stay empty rather than borrow an unrelated endpoint.
    if (!["примерка одежды", "influencer photo"].includes(task)) assert.ok(result.candidates.length);
  });
for (const [task, category] of [
  ["inpaint image", "image-to-image"],
  ["extend image", "image-to-image"],
  ["slow motion", "video-to-video"],
  ["отделить вокал", "audio-to-audio"],
  ["rigging", "3d-to-3d"],
])
  test(`fixture top category: ${task}`, () => {
    assert.equal(findFalEndpointResult({ task }, { catalog, env: {} }).candidates[0]?.category, category);
  });

test("atomic image-to-3D labels retain image input and text fallback semantics", () => {
  for (const task of ["image-to-3d", "image to 3d", "3d model from image"]) {
    assert.deepEqual(parseFalTask(task).inputs, ["image"]);
    const rows = findFalEndpointResult({ task }, { catalog, env: {} }).candidates;
    assert.ok(rows.length);
    assert.ok(rows.every((row) => row.category === "image-to-3d"));
  }
});

test("soundtracks requested for video stay in the music category", () => {
  for (const task of ["generate music for video", "лучшая музыка для видео"]) {
    const rows = findFalEndpointResult({ task }, { catalog, env: {} }).candidates;
    assert.ok(rows.length);
    assert.ok(rows.every((row) => row.category === "text-to-audio"));
  }
});

test("directional JSON labels constrain the source and top category", () => {
  for (const [task, category] of [
    ["text-to-json", "text-to-json"],
    ["image-to-json", "image-to-json"],
    ["extract data from text", "text-to-json"],
    ["извлечь данные из текста", "text-to-json"],
    ["extract data from image", "image-to-json"],
  ]) {
    assert.deepEqual(parseFalTask(task).categories, [category]);
    assert.equal(findFalEndpointResult({ task }, { catalog, env: {} }).candidates[0]?.category, category);
  }
  assert.deepEqual(parseFalTask("image-to-json").inputs, ["image"]);
});
