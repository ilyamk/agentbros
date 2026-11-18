import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { loadProviderCatalog } from "../src/lib/models/fal-catalog";
import allowlist from "../src/lib/models/model-instructions-allowlist.json";

const root = path.resolve(import.meta.dirname, "..");
const concreteModel =
  /gpt[- ]image[- ]\d|nano[- ]banana|flux[. -]?[23]|seedance|kling|genjutsu|\bsoul\b|hailuo|elevenlabs v\d|veo[ -]?\d|sora[ -]?\d|wan[ -]?\d|(?:runway|gen|ideogram|recraft|seedream|hunyuan|meshy|qwen)[ ._-]*v?\d+|(?:fal-ai|openai|google|bytedance|higgsfield(?:-ai)?|meshy|nvidia|topaz|resemble-ai|elevenlabs)\/[a-z0-9][\w./-]+/i;
function walk(dir: string): string[] {
  return readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? walk(`${dir}/${entry.name}`) : [`${dir}/${entry.name}`],
  );
}
const endpoints = [
  ...new Set(
    ["fal", "higgsfield"].flatMap((provider) => [...loadProviderCatalog(provider as "fal" | "higgsfield").keys()]),
  ),
];
const escapedEndpoints = endpoints.map((endpoint) => endpoint.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
const endpointPattern = new RegExp(`(?<![\\w./-])(?:${escapedEndpoints.join("|")})(?![\\w./-])`, "i");
const intended = (file: string): string => readFileSync(path.join(root, file), "utf8");

function violations(file: string, content: string): string[] {
  let fence: { marker: string; length: number } | undefined;
  return content.split(/\r?\n/).flatMap((line, index) => {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) {
      if (!fence) fence = { marker: marker[0]!, length: marker.length };
      else if (marker[0] === fence.marker && marker.length >= fence.length) fence = undefined;
      return [];
    }
    if (fence || !(concreteModel.test(line) || endpointPattern.test(line)) || /legacy|example|prompting/i.test(line))
      return [];
    if (allowlist.entries.some((row) => row.file === file && row.line === line && row.reason.trim())) return [];
    return [`${file}:${index + 1}: use a slot or use case and \`pnpm models:pick\`: ${line}`];
  });
}

test("agent-facing instructions select slots and use cases, with narrow factual exceptions", () => {
  const files = [
    ...walk(".agents/agents").filter((file) => /^\.agents\/agents\/[^/]+\.md$/.test(file)),
    ...walk(".agents/skills").filter((file) => file.endsWith("/SKILL.md")),
    ...walk("playbooks").filter((file) => /^playbooks\/[^/]+\/(AGENTS\.md|playbook\.json)$/.test(file)),
    "docs/production-model-routing.md",
  ];
  assert.deepEqual(
    files.flatMap((file) => violations(file, intended(file))),
    [],
  );
  for (const row of allowlist.entries) {
    assert.ok(row.reason.trim(), row.file);
    assert.ok(
      files.includes(row.file) && intended(row.file).split(/\r?\n/).includes(row.line),
      `Stale model instruction exception: ${row.file}`,
    );
  }
});

test("guard catches recommendations and permits only documented contexts", () => {
  assert.match(
    violations("new.md", "Choose GPT Image 2.6 for every hero.")[0]!,
    /use a slot or use case and `pnpm models:pick`/,
  );
  assert.equal(violations("new.md", "Choose fal-ai/new-model/v9.").length, 1);
  for (const line of ["Choose minimax/music-3", "Use veed/avatars/audio-to-video", "Prefer Runway Gen-4"])
    assert.equal(violations("new.md", line).length, 1, line);
  for (const text of [
    "Legacy: Seedance 2.5",
    "Example: Kling 3",
    "Prompting syntax: GPT Image 2.6",
    '```json\n{"endpoint":"openai/gpt-image-2.6/flare/edit"}\n```',
    "~~~text\nKling 3\n~~~",
  ])
    assert.deepEqual(violations("new.md", text), []);
  assert.equal(violations("new.md", "```\nexample\n```\nChoose Kling 3").length, 1);
  assert.equal(violations("new.md", "Use `pnpm models:pick --slot image.product`").length, 0);
});
