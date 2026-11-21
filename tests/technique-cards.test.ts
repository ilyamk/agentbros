import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { TechniqueCardSchema, type TechniqueCard } from "../src/types/creative";

const directory = "design-reference/techniques";
const compositions = new Set(
  ["Root.tsx", "DreiDemoCompositions.tsx"].flatMap((file) =>
    [...readFileSync(path.join("src/motion/lab", file), "utf8").matchAll(/<Composition id="([^"]+)"/g)].map(
      (match) => match[1]!,
    ),
  ),
);

/** Frontmatter is flat `key: value`. A value containing a colon is JSON-quoted and `sources` is a JSON array, both of which are valid YAML. */
function frontmatter(content: string): Record<string, unknown> {
  const block = /^---\n([\s\S]*?)\n---\n/.exec(content);
  assert.ok(block, "frontmatter block");
  const fields: Record<string, unknown> = {};
  for (const line of block[1]!.split("\n")) {
    const colon = line.indexOf(":");
    assert.ok(colon > 0, line);
    const value = line.slice(colon + 1).trim();
    fields[line.slice(0, colon)] = /^["[]/.test(value) ? (JSON.parse(value) as unknown) : value;
  }
  return fields;
}

const cards: { file: string; content: string; card: TechniqueCard }[] = readdirSync(directory)
  .filter((name) => name.endsWith(".md"))
  .map((file) => {
    const content = readFileSync(path.join(directory, file), "utf8");
    return { file, content, card: TechniqueCardSchema.parse(frontmatter(content)) };
  });

test("the lab composition list is readable", () => {
  assert.ok(compositions.has("PosterStackL"));
});

test("every card validates and is named after its id", () => {
  assert.ok(cards.length >= 15);
  for (const { file, card } of cards) assert.equal(file, `${card.id}.md`);
});

test("every demo is a registered lab composition or an existing file", () => {
  for (const { file, card } of cards)
    if (card.demo) assert.ok(compositions.has(card.demo) || existsSync(card.demo), `${file}: ${card.demo}`);
});

test("demonstrated means a lab composition exists", () => {
  for (const { file, card } of cards)
    if (card.status === "demonstrated") assert.ok(card.demo && compositions.has(card.demo), file);
});

test("confirmed means two or more references link a technique with spans to the card", () => {
  const confirmed = cards.filter(({ card }) => card.status === "confirmed");
  assert.ok(confirmed.length >= 2);
  for (const { file, card } of confirmed) {
    const references = card.sources.filter((source) =>
      /^design-reference\/library\/[^/]+\/techniques\.json$/.test(source),
    );
    assert.ok(references.length >= 2, `${file}: cites ${references.length} reference(s)`);
    for (const source of references) {
      const { techniques } = JSON.parse(readFileSync(source, "utf8")) as {
        techniques: { techniqueCardId?: string; spans?: unknown[] }[];
      };
      assert.ok(
        techniques.some((technique) => technique.techniqueCardId === card.id && (technique.spans?.length ?? 0) > 0),
        `${file}: no technique with spans in ${source} links to ${card.id}`,
      );
    }
  }
});

test("a Remotion card's primitives are exported from src/motion", () => {
  const source = readdirSync("src/motion")
    .filter((name) => /\.tsx?$/.test(name))
    .map((name) => readFileSync(path.join("src/motion", name), "utf8"))
    .join("\n");
  for (const { file, card } of cards) {
    if (card.route !== "remotion") continue;
    for (const name of card.primitive?.split(", ") ?? [])
      assert.match(source, new RegExp(`export (const|function) ${name}\\b`), `${file}: ${name}`);
  }
});

test("every source and primitive file exists", () => {
  for (const { file, card } of cards) {
    for (const source of card.sources) assert.ok(existsSync(source), `${file}: ${source}`);
    if (card.primitive?.includes("/")) assert.ok(existsSync(card.primitive), `${file}: ${card.primitive}`);
  }
});

test("every card has the required body sections", () => {
  for (const { file, content } of cards)
    for (const section of ["What it does.", "When it fits.", "When it does not.", "Timing.", "Read.", "Pitfalls."])
      assert.ok(content.includes(`**${section}**`), `${file}: ${section}`);
});

test("the Hyperframes and Blender routes each have a card citing their skill", () => {
  const cited = (route: string, skill: string) =>
    cards.some(({ card }) => card.route === route && card.sources.includes(skill));
  assert.ok(cited("hyperframes", ".agents/skills/engine-selection/SKILL.md"));
  assert.ok(cited("blender", ".agents/skills/blender-3d/SKILL.md"));
});
