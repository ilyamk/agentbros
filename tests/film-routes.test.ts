import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { FILM_CHAIN } from "../src/lib/film/chain";
import {
  DEFAULT_FILM_TYPE,
  FILM_ROUTES,
  FILM_TYPES,
  resolveRoute,
  routeDocs,
  routeProblems,
  stepEnabled,
  toolsFor,
} from "../src/lib/film/routes";
import { BriefSchema } from "../src/types/pipeline";

const REPO = path.resolve(import.meta.dirname, "..");
const TSX = path.join(REPO, "node_modules/tsx/dist/cli.mjs");

function cli(root: string, script: string, ...args: string[]) {
  const result = spawnSync(process.execPath, [TSX, path.join(REPO, script), ...args], { cwd: root, encoding: "utf8" });
  const lines = result.stdout.trim().split("\n");
  assert.equal(lines.length, 1, `one JSON line: ${result.stdout} ${result.stderr}`);
  return {
    status: result.status,
    json: JSON.parse(lines[0]!) as { ok: boolean; error?: string; metadata: Record<string, any> },
  };
}

function workspace(t: test.TestContext) {
  const root = mkdtempSync(path.join(tmpdir(), "film-routes-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test("every type has a route whose steps resolve to known agents, artefacts and tools", () => {
  assert.deepEqual(Object.keys(FILM_ROUTES).sort(), [...FILM_TYPES].sort());
  assert.deepEqual(routeProblems(REPO), []);
  for (const type of FILM_TYPES) {
    const route = resolveRoute(type);
    assert.equal(route.type, type);
    assert.ok(route.steps.length >= (type === "replica" ? 11 : 15), type);
    assert.ok(route.qa.length && route.reference, type);
    for (const step of route.steps)
      assert.ok(
        FILM_CHAIN.some((chain) => chain.id === step.id && chain.owner === step.agent),
        `${type} ${step.id}`,
      );
    assert.equal(
      route.steps.some((step) => step.id === "material"),
      FILM_ROUTES[type].material !== undefined,
      type,
    );
  }
});

test("an old brief without a type validates and routes as motion-graphics; a hybrid joins material and tools", () => {
  const old = BriefSchema.parse({
    topic: "t",
    audience: "a",
    tone: "x",
    format: "vertical",
    durationSec: 20,
    productName: "p",
    renderMode: "bespoke",
  });
  assert.equal(old.filmType, undefined);
  const route = resolveRoute(old.filmType);
  assert.equal(route.type, DEFAULT_FILM_TYPE);
  assert.equal(route.defaulted, true);
  assert.deepEqual(route.skipped, ["narration", "material"]);
  assert.throws(() => BriefSchema.parse({ ...old, filmType: "vlog" }));

  assert.equal(stepEnabled("material", "motion-graphics"), false);
  assert.equal(stepEnabled("material", "motion-graphics", "footage"), true);
  const hybrid = resolveRoute("motion-graphics", "footage");
  assert.equal(hybrid.secondary, "footage");
  assert.ok(hybrid.material);
  const build = toolsFor("build", "motion-graphics", "footage").map((tool) => tool.id);
  assert.ok(build.includes("blender-plate") && build.includes("editorial-storytelling"));
  assert.equal(build.filter((id) => id === "sfx:cues").length, 1, "shared tools appear once");
  assert.equal(resolveRoute("collage", "collage").secondary, undefined);
});

test("each type's material route names its tools", () => {
  const ids = (type: (typeof FILM_TYPES)[number]) => toolsFor("material", type).map((tool) => tool.id);
  assert.ok(ids("ui-demo").includes("capture:app"));
  assert.ok(ids("footage").includes("resources") && !ids("footage").includes("fetch:stock"));
  assert.ok(ids("ai-video").includes("generate:model") && ids("ai-video").includes("model-and-asset-production"));
  assert.ok(ids("talking-head").includes("recording-guide"));
  assert.ok(ids("collage").includes("rmbg") && ids("collage").includes("generate:image"));
  assert.ok(toolsFor("build", "explainer").some((tool) => tool.kind === "category" && tool.id === "data"));
  assert.ok(toolsFor("build", "motion-graphics").some((tool) => tool.id === "kinetic"));
});

test("docs/film-types.md and every docs/film-types/<type>.md are generated", () => {
  const docs = routeDocs();
  assert.equal(Object.keys(docs).length, FILM_TYPES.length + 1);
  for (const [doc, text] of Object.entries(docs))
    assert.equal(readFileSync(path.join(REPO, doc), "utf8"), text, `${doc}: run pnpm film:route --write-doc`);
  assert.deepEqual(
    readdirSync(path.join(REPO, "docs/film-types")).sort(),
    FILM_TYPES.map((type) => `${type}.md`).sort(),
    "no stale type pages",
  );
});

test("film:init --type writes the type, refuses an unknown one, and points supplied footage to footage:next", (t) => {
  const root = workspace(t);
  const typed = cli(root, "scripts/film-init.ts", "--project", "demo", "--type", "ui-demo");
  assert.equal(typed.status, 0, JSON.stringify(typed.json));
  assert.equal(typed.json.metadata["filmType"], "ui-demo");
  assert.ok(typed.json.metadata["steps"].includes("material"));
  assert.equal(
    JSON.parse(readFileSync(path.join(root, "public/projects/demo/pipeline/brief.json"), "utf8")).filmType,
    "ui-demo",
  );

  assert.equal(cli(root, "scripts/film-init.ts", "--project", "bad", "--type", "vlog").json.error, "INVALID_INPUT");

  const untyped = cli(root, "scripts/film-init.ts", "--project", "plain");
  assert.equal(untyped.json.metadata["typeChosen"], false);
  assert.ok(untyped.json.metadata["warnings"].some((line: string) => line.includes("`talking-head`")));

  const footage = cli(root, "scripts/film-init.ts", "--project", "cut", "--type", "footage");
  assert.equal(footage.json.metadata["workflow"].command, "pnpm footage:next --project <id>");
  assert.equal(footage.json.metadata["workflow"].agent, "footage-editor");
  writeFileSync(path.join(root, "take.mov"), "x");
  const supplied = cli(root, "scripts/film-init.ts", "--project", "takes", "--product", "take.mov");
  assert.ok(
    supplied.json.metadata["warnings"].some(
      (line: string) => /footage-editor/.test(line) && /footage:next/.test(line) && /take\.mov/.test(line),
    ),
  );
});

test("film:route prints a route by type or from a project's brief, and every route without either", (t) => {
  const root = workspace(t);
  const collage = cli(root, "scripts/film-route.ts", "--type", "collage");
  assert.equal(collage.status, 0);
  const material = collage.json.metadata["route"].steps.find((step: { id: string }) => step.id === "material");
  assert.equal(material.agent, "asset-planner");
  assert.ok(material.tools.some((tool: { id: string }) => tool.id === "rmbg"));
  assert.ok(material.outputs.some((output: { path: string }) => output.path.endsWith("material.json")));

  assert.equal(
    cli(root, "scripts/film-init.ts", "--project", "talk", "--type", "talking-head", "--secondary", "explainer").status,
    0,
  );
  const fromProject = cli(root, "scripts/film-route.ts", "--project", "talk");
  assert.equal(fromProject.json.metadata["route"].type, "talking-head");
  assert.equal(fromProject.json.metadata["route"].secondary, "explainer");

  const all = cli(root, "scripts/film-route.ts");
  assert.equal(all.json.metadata["routes"].length, FILM_TYPES.length);
  assert.equal(cli(root, "scripts/film-route.ts", "--type", "vlog").json.error, "INVALID_INPUT");
});
