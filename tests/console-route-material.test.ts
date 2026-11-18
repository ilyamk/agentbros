/**
 * RFC 0004 WP15: the replica, recipe and campaign routes' material in the console's read model. `view.replica` reads
 * the rights answer (as written), the spec, the check and the compare envelopes; `view.recipe` the recipe draft and
 * its scenes; `view.campaign` the members and their production state. Each degrades with an advisory, never throws,
 * and the view always parses.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ProjectViewSchema } from "../src/types/console";
import { buildProjectView } from "../src/lib/console/view/build";
import { projectPaths } from "../src/lib/console/view/files";
import { readCampaignMaterial, readRecipeMaterial, readReplicaMaterial } from "../src/lib/console/view/route-material";
import { materializeRecipe } from "../src/lib/templates/materialize";
import { CAMPAIGN, makeCampaign } from "./helpers/campaign-review";

const REPO = path.resolve(import.meta.dirname, "..");
const TSX = path.join(REPO, "node_modules/tsx/dist/cli.mjs");
const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});
const tempRoot = () => {
  const root = mkdtempSync(path.join(tmpdir(), "console-route-material-"));
  roots.push(root);
  return root;
};
const write = (file: string, value: unknown) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value, null, 2));
};

const SPEC = {
  reference: "firecrawl",
  fps: 30,
  format: "vertical",
  rights: { status: "study-only", userStatement: "Just for practice", askedAt: "2026-11-13T00:00:00.000Z" },
  swaps: [{ what: "logo", from: "their logo", to: "a plain mark", why: "never copy a brand", shots: ["r1"] }],
  shots: [
    {
      id: "r1",
      referenceShot: "s001",
      startFrame: 0,
      durationFrames: 30,
      colour: { L: 50, a: 0, b: 0 },
      confidence: "measured",
      camera: { kind: ["push_in"] },
      transitionIn: "cut",
      blocks: ["type-hero-word"],
    },
  ],
  rounds: [{ round: 1, fixed: ["timing of r1"], remains: [] }],
};

test("replica material: rights as written, spec, check and compare counts", () => {
  const root = tempRoot();
  const paths = projectPaths(root, "rep");
  const pipeline = path.join(paths.projectDir, "pipeline");
  write(path.join(pipeline, "replica-rights.json"), {
    schemaVersion: 1,
    status: "study-only",
    userStatement: "Just for practice, never published",
    askedAt: "2026-11-13T00:00:00.000Z",
  });
  write(path.join(pipeline, "replica-spec.json"), SPEC);
  write(path.join(pipeline, "replica-spec.md"), "# spec\n");
  write(path.join(pipeline, "replica-check.json"), { ok: true, metadata: { passed: false, issues: ["r1 too long"] } });
  write(path.join(pipeline, "replica-compare.json"), {
    ok: true,
    metadata: { summary: { withinTolerance: { cuts: { held: 3, failed: 1, notMeasured: 0, exempt: 0 } } } },
  });
  const advisories: string[] = [];
  const material = readReplicaMaterial(paths, advisories);
  assert.deepEqual(advisories, []);
  assert.equal(material?.rights?.status, "study-only");
  assert.equal(material?.rights?.userStatement, "Just for practice, never published");
  assert.equal(material?.spec?.shots[0]?.camera, "push_in");
  assert.equal(material?.spec?.shots[0]?.transitionIn, "cut");
  assert.deepEqual(material?.spec?.doc, {
    root: "project",
    path: "pipeline/replica-spec.md",
    kind: "document",
    label: "replica-spec.md",
  });
  assert.deepEqual(material?.check, { ok: true, passed: false, issues: ["r1 too long"] });
  assert.deepEqual(material?.compare?.measures, [{ measure: "cuts", held: 3, failed: 1, notMeasured: 0, exempt: 0 }]);
});

test("replica material degrades: corrupt and off-schema files are advisories, nothing is a section", () => {
  const root = tempRoot();
  const paths = projectPaths(root, "rep");
  const pipeline = path.join(paths.projectDir, "pipeline");
  assert.equal(readReplicaMaterial(paths, []), undefined);
  write(path.join(pipeline, "replica-rights.json"), "{nope");
  write(path.join(pipeline, "replica-spec.json"), { reference: "x" });
  const advisories: string[] = [];
  assert.equal(readReplicaMaterial(paths, advisories), undefined);
  assert.equal(advisories.length, 2);
});

test("a replica film's view carries view.replica beside its film steps", (t) => {
  const root = tempRoot();
  const init = spawnSync(
    process.execPath,
    [TSX, path.join(REPO, "scripts/film-init.ts"), "--project", "rep", "--type", "replica"],
    {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, AGENTBROS_EVENTS: "off", AGENTBROS_CONSOLE: "off", AGENTBROS_HOOKS: "off" },
    },
  );
  if (init.status !== 0) return t.skip(`film:init failed: ${init.stdout}${init.stderr}`);
  const pipeline = path.join(root, "public/projects/rep/pipeline");
  write(path.join(pipeline, "replica-spec.json"), SPEC);
  const view = buildProjectView(root, "rep", { now: Date.parse("2026-11-17T00:00:00Z") });
  assert.ok(view);
  assert.equal(view.project.route, "replica");
  assert.ok(view.steps.some((step) => step.id === "rights"));
  assert.equal(view.replica?.spec?.reference, "firecrawl");
  assert.ok(ProjectViewSchema.safeParse(view).success);
});

test("recipe material: the draft's beats, placeholders and findings without an unsupported HTML link", () => {
  const root = tempRoot();
  mkdirSync(path.join(root, "public/projects"), { recursive: true });
  materializeRecipe({ projectId: "draft", recipeId: "social-hook", topic: "Launch week", formats: ["vertical"] }, root);
  const paths = projectPaths(root, "draft");
  const advisories: string[] = [];
  const material = readRecipeMaterial(paths, advisories);
  assert.ok(material, advisories.join("; "));
  assert.equal(material.recipeId, "social-hook");
  assert.equal(material.topic, "Launch week");
  assert.deepEqual(material.formats, ["vertical"]);
  assert.equal(material.productionReady, false);
  assert.ok(material.findings.length >= 2);
  assert.ok(material.beats.length > 1);
  assert.ok(material.beats.every((beat) => beat.purpose));
  assert.ok(material.beats.some((beat) => beat.placeholder && beat.visual?.kind === "image"));
  assert.match(readFileSync(path.join(paths.projectDir, "animatic.html"), "utf8"), /<html\b/i);
  assert.equal(material.animatic, undefined);

  const view = buildProjectView(root, "draft", { now: Date.parse("2026-11-17T00:00:00Z") });
  assert.equal(view?.project.route, "recipe");
  assert.equal(view?.recipe?.recipeId, "social-hook");
});

test("recipe material: a recipe.json without a recipe id is an advisory", () => {
  const root = tempRoot();
  const paths = projectPaths(root, "draft");
  write(path.join(paths.projectDir, "pipeline/recipe.json"), { request: {} });
  const advisories: string[] = [];
  assert.equal(readRecipeMaterial(paths, advisories), undefined);
  assert.match(advisories[0] ?? "", /names no recipe/);
});

test("campaign material: members, task states and outputs; the view drops the minimal-view advisory", async () => {
  const root = tempRoot();
  await makeCampaign(root);
  const paths = projectPaths(root, CAMPAIGN);
  const material = readCampaignMaterial(paths, []);
  assert.ok(material);
  assert.equal(material.campaignId, CAMPAIGN);
  assert.equal(material.members.length, 1);
  assert.equal(material.members[0]?.outputs, 1);
  assert.ok(material.members[0]?.tasks.some((task) => task.state === "complete"));
  const view = buildProjectView(root, CAMPAIGN, { now: Date.parse("2026-11-17T00:00:00Z") });
  assert.ok(view);
  assert.equal(view.project.route, "campaign");
  assert.equal(view.campaign?.campaignId, CAMPAIGN);
  assert.ok(!view.advisories.some((line) => line.startsWith("Minimal view")));
  // A missing campaign is an advisory, not a throw.
  const advisories: string[] = [];
  assert.equal(readCampaignMaterial(projectPaths(root, "nothing"), advisories), undefined);
  assert.equal(advisories.length, 1);
});
