import { before, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { z } from "zod";
import { buildCatalogue, CATALOGUE_PATH, type Catalogue } from "../src/lib/library/catalogue";
import { captureTiming } from "../src/motion/library/scenes/scene-plan";
import { loadLibrary } from "../src/lib/library/load";
import { sourceFile } from "../src/lib/library/paths";
import type { LibraryItem, LibraryStyle } from "../src/motion/library/types";

// Every test here needs the live registry, which takes seconds to load (three.js and the component graph).
const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FORMATS = new Set(["vertical", "square", "landscape"]);
let items: LibraryItem[] = [];
let styles: LibraryStyle[] = [];

before(
  async () => {
    ({ items, styles } = await loadLibrary());
  },
  { timeout: 120000 },
);

test("item ids are unique and kebab-case", () => {
  const ids = items.map((item) => item.id);
  assert.equal(
    new Set(ids).size,
    ids.length,
    `duplicate ids: ${ids.filter((id, index) => ids.indexOf(id) !== index).join(", ")}`,
  );
  for (const id of ids) assert.match(id, KEBAB, id);
});

test("every schema accepts its defaultProps and converts to JSON schema", () => {
  for (const item of items) {
    const parsed = item.schema.safeParse(item.defaultProps);
    assert.ok(parsed.success, `${item.id}: ${parsed.success ? "" : parsed.error.message}`);
    assert.doesNotThrow(() => z.toJSONSchema(item.schema, { unrepresentable: "any" }), item.id);
  }
});

test('film-finish previews its named looks: preset is a prop, "none" by default', () => {
  const item = items.find((entry) => entry.id === "film-finish")!;
  assert.equal((item.defaultProps as { preset?: string }).preset, "none");
  for (const preset of ["clean", "filmic", "tactile"])
    assert.ok(item.schema.safeParse({ ...item.defaultProps, preset }).success, preset);
  assert.equal(item.schema.safeParse({ ...item.defaultProps, preset: "glossy" }).success, false);
});

test("every item has text to choose by, formats and a duration", () => {
  for (const item of items) {
    assert.ok(item.title.trim() && item.description.trim(), item.id);
    assert.ok(item.tags.length > 0, `${item.id}: tags`);
    assert.ok(item.formats.length > 0, `${item.id}: formats`);
    for (const format of item.formats) assert.ok(FORMATS.has(format), `${item.id}: ${format}`);
    assert.ok(Number.isInteger(item.durationInFrames) && item.durationInFrames > 0, `${item.id}: durationInFrames`);
  }
});

test("importPath exists inside the directory of the item category", () => {
  const categories = new Set(
    readdirSync("src/motion/library", { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name),
  );
  for (const item of items) {
    assert.ok(categories.has(item.category), `${item.id}: no directory for ${item.category}`);
    assert.ok(item.importPath.startsWith(`src/motion/library/${item.category}/`), `${item.id}: ${item.importPath}`);
    const file = sourceFile(item.importPath);
    assert.ok(file && existsSync(file), `${item.id}: ${item.importPath} not found`);
  }
});

test("style ids are unique and kebab-case", () => {
  const ids = styles.map((style) => style.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ids) assert.match(id, KEBAB, id);
});

/** Ids whose entries differ, appear or disappear between the committed and the rebuilt catalogue. */
const changedIds = (committed: { id: string }[], built: { id: string }[]): string[] => {
  const before = new Map(committed.map((entry) => [entry.id, JSON.stringify(entry)]));
  const after = new Map(built.map((entry) => [entry.id, JSON.stringify(entry)]));
  return [...new Set([...before.keys(), ...after.keys()])].filter((id) => before.get(id) !== after.get(id));
};

test("docs/library/catalogue.json is fresh: rebuilt from the registry it matches byte for byte", () => {
  const committedText = existsSync(CATALOGUE_PATH) ? readFileSync(CATALOGUE_PATH, "utf8") : undefined;
  assert.ok(committedText, `${CATALOGUE_PATH} is missing. Run \`pnpm library:catalogue\` and commit it.`);
  const built = buildCatalogue(items, styles);
  if (`${JSON.stringify(built, null, 1)}\n` === committedText) return;
  const committed = JSON.parse(committedText) as Catalogue;
  const blocks = changedIds(committed.items, built.items);
  const looks = changedIds(committed.styles, built.styles);
  const what =
    [blocks.length ? `blocks ${blocks.join(", ")}` : "", looks.length ? `styles ${looks.join(", ")}` : ""]
      .filter(Boolean)
      .join("; ") || "order or formatting only";
  assert.fail(`${CATALOGUE_PATH} is stale (${what}). Run \`pnpm library:catalogue\` and commit the file.`);
});

test("every item declares cues inside its duration", () => {
  const kinds = new Set(["land", "hit", "cut", "reveal", "click", "type", "exit", "peak", "stop"]);
  for (const item of items) {
    assert.equal(typeof item.cues, "function", `${item.id}: cues`);
    for (const cue of item.cues!(item.defaultProps)) {
      assert.ok(kinds.has(cue.kind), `${item.id}: cue kind ${cue.kind}`);
      assert.ok(
        Number.isFinite(cue.frame) && cue.frame >= 0 && cue.frame <= item.durationInFrames,
        `${item.id}: cue frame ${cue.frame}`,
      );
    }
  }
});

test("a captured filter has a click cue at the state change in either format", () => {
  const demo = items.find(({ id }) => id === "scene-feature-demo")!;
  const plate = {
    before: "before.png",
    after: "after.png",
    width: 960,
    height: 600,
    target: { x: 0.3, y: 0.4 },
    result: { x: 0.5, y: 0.6 },
  };
  const capture = {
    landscape: plate,
    beforeValue: "12",
    afterValue: "02",
    beforeLabel: "blocks",
    afterLabel: "matches",
    title: "Library",
    accent: "#5538cc",
  };
  const parsed = demo.schema.parse({ ...demo.defaultProps, capture });
  assert.deepEqual(demo.formats, ["landscape", "vertical"]);
  assert.deepEqual(
    demo.cues?.(parsed)?.map(({ kind, frame }) => [kind, frame]),
    [["click", 99]],
  );
  assert.equal(
    demo.schema.safeParse({ ...parsed, capture: { ...capture, landscape: { ...plate, target: { x: 2, y: 0 } } } })
      .success,
    false,
  );
  assert.equal(demo.durationForProps?.({ ...parsed, dashboardFrames: 40, actionFrames: 60 }), 91);
  const reel = items.find(({ id }) => id === "library-reel")!;
  assert.equal(reel.durationForProps?.(reel.defaultProps), reel.durationInFrames);
  assert.equal(reel.durationForProps?.({ ...reel.defaultProps, capture }), 463);
  assert.ok(reel.schema.safeParse({ ...reel.defaultProps, capture }).success);
  const performed = {
    ...reel.defaultProps,
    capture: { ...capture, performance: { blocks: ["ground-swap-cut", "caused-morph"] } },
  };
  assert.ok(reel.schema.safeParse(performed).success);
  assert.equal(reel.durationForProps?.(performed), 324);
  assert.deepEqual(
    reel
      .cues?.(performed)
      ?.filter((cue) => cue.kind === "click")
      .map((cue) => cue.frame),
    [88],
  );
  assert.equal(
    reel.schema.safeParse({
      ...performed,
      capture: { ...capture, performance: { blocks: ["light-burn", "caused-morph"] } },
    }).success,
    false,
  );
});

test("even the shortest capture preserves a reading hold after the final camera stop", () => {
  for (const length of [91, 231, 241])
    for (const carries of [false, true]) {
      const { click, landing, reframeDelay, reframeDuration } = captureTiming(length, carries);
      assert.ok(landing > click);
      assert.ok(length - landing - reframeDelay - reframeDuration >= Math.ceil(length * 0.16));
    }
});
