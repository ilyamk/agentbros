/** RFC 0003 AC18: the reference-preparation skill has a reference per craft topic, and every model-specific number cites its source, tier and date. */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const skill = path.join(root, ".agents/skills/reference-preparation");
const TOPICS = [
  "characters",
  "locations",
  "products",
  "style",
  "motion-video",
  "control-signals",
  "previs-3d",
  "audio",
  "markers",
  "failure-modes",
];

/** A stated quantity: a bound, a range, or a number with a unit or a counted thing. Version names (2.5, O3) are not. */
const N = String.raw`(?<![\w.-])\d+(?:[.,]\d+)?`;
const QUANTITY = new RegExp(
  String.raw`(?:≤|≥|up to|at most|at least|multiples? of|from)\s*\d|${N}\s*(?:–|to)\s*\d|${N}\s*-?\s*(?:s|sec|seconds?|ms|px|pixels?|MB|MiB|kbps|fps|frames?|images?|videos?|audio|clips?|people|characters?|elements?|references?|inputs?|views?|min|minutes?|%|°|dB|LUFS|bit)(?![\w])`,
  "i",
);
const SOURCE = /\]\((?:https?:\/\/|\.\.?\/)[^)\s]+\)/;
const TIER = /\[(?:O|P|3P|Obs|U)\]/;
const DATE = /\b\d{4}-\d{2}-\d{2}\b/;

/** Bullets with their continuation lines, table rows and paragraphs, outside fenced code and headings. */
function claimUnits(markdown: string): string[] {
  const units: string[] = [];
  let current: string[] = [];
  const flush = () => {
    if (current.length) units.push(current.join(" "));
    current = [];
  };
  let fenced = false;
  for (const line of markdown.split("\n")) {
    if (/^\s*```/.test(line)) {
      fenced = !fenced;
      flush();
      continue;
    }
    if (fenced || line.startsWith("#") || line.startsWith("---") || !line.trim()) {
      flush();
      continue;
    }
    if (/^\s*(?:[-*]|\d+\.)\s/.test(line) || line.startsWith("|")) flush();
    current.push(line.trim());
    if (line.startsWith("|")) flush();
  }
  flush();
  return units;
}

/** What remains after code spans, link targets, dates, RFC section numbers and list markers are removed. */
function quantityText(unit: string): string {
  return unit
    .replace(/`[^`]*`/g, "")
    .replace(/\]\([^)]*\)/g, "]")
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, "")
    .replace(/RFC \d{4}( §[\d.]+)?/g, "")
    .replace(/^\s*(?:[-*]|\d+\.)\s/, "");
}

const needsSource = (unit: string) => QUANTITY.test(quantityText(unit));
const cited = (unit: string) => SOURCE.test(unit) && TIER.test(unit) && DATE.test(unit);

test("the skill names itself and has one reference file per craft topic", () => {
  const text = readFileSync(path.join(skill, "SKILL.md"), "utf8");
  assert.match(text, /^---\nname: reference-preparation\ndescription: .+\n---\n/);
  for (const topic of TOPICS) {
    assert.ok(existsSync(path.join(skill, "references", `${topic}.md`)), topic);
    assert.ok(text.includes(`(references/${topic}.md)`), `SKILL.md links ${topic}`);
  }
});

test("every model-specific number in the skill cites a source link, a tier and a date in the same bullet", () => {
  const files = ["SKILL.md", ...readdirSync(path.join(skill, "references")).map((f) => `references/${f}`)];
  const uncited = files.flatMap((file) =>
    claimUnits(readFileSync(path.join(skill, file), "utf8"))
      .filter((unit) => needsSource(unit) && !cited(unit))
      .map((unit) => `${file}: ${unit.slice(0, 160)}`),
  );
  assert.deepEqual(uncited, []);
});

test("the citation check catches an uncited limit and accepts a cited one", () => {
  const [bare, sourced, version] = claimUnits(
    [
      "- Motion clips of 3–30 s.",
      "- Motion clips of 3–30 s — [O] [guide](https://example.com/guide), checked 2026-11-17.",
      "- Seedance 2.5 and Kling O3 take references by role.",
    ].join("\n"),
  );
  assert.ok(needsSource(bare!) && !cited(bare!));
  assert.ok(needsSource(sourced!) && cited(sourced!));
  assert.ok(!needsSource(version!));
  assert.ok(!needsSource("| kling-o3-video and Gen-4 References |"));
  assert.ok(needsSource("- Wan sizes are multiples of 16."));
  assert.ok(!needsSource("- Never type `@Image1`; see RFC 0003 §3.9, checked 2026-11-17."));
});

test("the skill shows a marker only in the rule that forbids typing one", () => {
  const lines = readFileSync(path.join(skill, "SKILL.md"), "utf8").split("\n");
  const shown = lines.filter((line) => /@(?:Image|Video|Audio|Element)\d/.test(line));
  assert.ok(shown.length > 0);
  for (const line of shown) assert.match(line, /Never hand-write markers/);
});
