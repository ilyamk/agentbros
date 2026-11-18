import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { FONT_ROLES, fontRoleModuleSource } from "../src/lib/font-resources/manifest";
import {
  CREATIVE_FINDING_CODES,
  FONT_TOKEN_FACES,
  decodeFinalPair,
  missingGlyphs,
  normaliseCopy,
  parseUnicodeRanges,
  runCreativeChecks,
  type CreativeFinding,
} from "../src/lib/pipeline/creative-checks";

const fixtures = path.resolve(import.meta.dirname, "fixtures/creative-checks");
type Json = Record<string, any>;

function copy(t: TestContext, name: "good" | "legacy") {
  const root = mkdtempSync(path.join(tmpdir(), "creative-checks-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  cpSync(path.join(fixtures, name), root, { recursive: true });
  const pipeline = path.join(root, "project", "pipeline");
  return {
    root,
    pipeline,
    edit(file: string, change: (json: Json) => void) {
      const target = path.join(pipeline, file);
      const json = JSON.parse(readFileSync(target, "utf8")) as Json;
      change(json);
      writeFileSync(target, JSON.stringify(json));
    },
    run: (options: { renderFile?: string } = {}) =>
      runCreativeChecks(path.join(root, "project"), {
        rootDir: root,
        libraryRoot: path.join(root, "library"),
        ...options,
      }),
  };
}

const codes = (findings: CreativeFinding[]) => findings.map((finding) => finding.code);
const only = (findings: CreativeFinding[], code: string) => findings.filter((finding) => finding.code === code);

test("the good project raises nothing", (t) => {
  assert.deepEqual(copy(t, "good").run(), []);
});

test("the legacy project raises nothing, though it has every fault and an old motion-plan.json", (t) => {
  const project = copy(t, "legacy");
  assert.deepEqual(project.run(), []);
  assert.deepEqual(runCreativeChecks(path.join(project.root, "absent")), []);
});

test("a legacy project's own brief with an unknown renderMode stays legacy", (t) => {
  const project = copy(t, "legacy");
  project.edit("brief.json", (brief) => (brief["renderMode"] = "template"));
  assert.deepEqual(project.run(), []);
});

test("CONCEPT_MISSING: absent or invalid once the script stage is done", (t) => {
  const absent = copy(t, "good");
  rmSync(path.join(absent.pipeline, "concept.json"));
  assert.deepEqual(codes(absent.run()), ["CONCEPT_MISSING"]);
  absent.edit("pipeline-state.json", (state) => (state["stages"].script.status = "running"));
  assert.deepEqual(codes(absent.run()), []);

  const invalid = copy(t, "good");
  invalid.edit("concept.json", (concept) => (concept["selectedId"] = "nobody"));
  assert.ok(codes(invalid.run()).includes("CONCEPT_MISSING"));
});

test("CONCEPT_MISSING: without bespoke, an invalid concept.json fires and an absent one does not", (t) => {
  const project = copy(t, "legacy");
  writeFileSync(path.join(project.pipeline, "concept.json"), "{}");
  assert.deepEqual(codes(project.run()), ["CONCEPT_MISSING"]);
  rmSync(path.join(project.pipeline, "concept.json"));
  assert.deepEqual(codes(project.run()), []);
});

test("MOTION_PLAN_MISSING: absent, old-shape in a bespoke project, and invalid new-format without bespoke", (t) => {
  const absent = copy(t, "good");
  rmSync(path.join(absent.pipeline, "motion-plan.json"));
  assert.ok(codes(absent.run()).includes("MOTION_PLAN_MISSING"));

  const oldShape = copy(t, "good");
  oldShape.edit("motion-plan.json", (plan) => delete plan["schemaVersion"]);
  assert.ok(codes(oldShape.run()).includes("MOTION_PLAN_MISSING"));

  const versioned = copy(t, "legacy");
  versioned.edit("motion-plan.json", (plan) => (plan["schemaVersion"] = 1));
  assert.deepEqual(codes(versioned.run()), ["MOTION_PLAN_MISSING"]);
  versioned.edit("pipeline-state.json", (state) => (state["stages"].storyboard.status = "pending"));
  assert.deepEqual(codes(versioned.run()), []);
});

test("PRODUCT_MATERIAL_MISSING: no sources, or no shot with real material", (t) => {
  const noSources = copy(t, "good");
  noSources.edit("concept.json", (concept) => (concept["productTruth"].sources = []));
  assert.deepEqual(codes(noSources.run()), ["PRODUCT_MATERIAL_MISSING"]);

  const noShot = copy(t, "good");
  noShot.edit("motion-plan.json", (plan) => (plan["shots"][1].route = "remotion"));
  assert.deepEqual(codes(noShot.run()), ["PRODUCT_MATERIAL_MISSING"]);
  noShot.edit("motion-plan.json", (plan) => (plan["shots"][1].techniqueIds = ["real-interface-playback"]));
  assert.deepEqual(codes(noShot.run()), []);
  noShot.edit("motion-plan.json", (plan) => {
    plan["shots"][1].techniqueIds = [];
    plan["shots"][1].subject = "the app, from assets/app-recording.mp4";
  });
  assert.deepEqual(codes(noShot.run()), []);
});

test("PRODUCT_MATERIAL_MISSING: stays quiet when the brief says there is no product", (t) => {
  const project = copy(t, "good");
  project.edit("concept.json", (concept) => (concept["productTruth"].sources = []));
  project.edit("motion-plan.json", (plan) => (plan["shots"][1].route = "remotion"));
  project.edit("brief.json", (brief) => (brief["productName"] = "none"));
  assert.deepEqual(codes(project.run()), []);
});

test("FONT_GLYPHS_MISSING: Cyrillic in a Latin-only font", (t) => {
  const project = copy(t, "good");
  project.edit("design.json", (design) => (design["fonts"] = ["condensed", "primary"]));
  const findings = project.run();
  assert.deepEqual(codes(findings), ["FONT_GLYPHS_MISSING", "FONT_GLYPHS_MISSING"]);
  const error = findings.find((finding) => finding.severity === "error")!;
  assert.match(error.message, /Bebas Neue/);
  assert.match(error.message, /primary/);
  assert.equal(findings.find((finding) => finding.severity === "warning")!.message.includes("does not record"), true);
});

test("FONT_GLYPHS_MISSING: Latin copy in a Latin font is fine, and a plan line only one font can set warns", (t) => {
  const latin = copy(t, "good");
  latin.edit("design.json", (design) => (design["fonts"] = ["display"]));
  latin.edit("storyboard.json", (board) => {
    board["scenes"][0].headline = "LESS NOISE / MORE CLARITY";
    delete board["scenes"][0].subtext;
    board["scenes"][1].headline = "START WITH YASNO";
  });
  latin.edit("brief.json", (brief) => {
    brief["tagline"] = "Less noise. More clarity.";
    brief["callToAction"] = "Start with Yasno";
    brief["productName"] = "Yasno";
  });
  latin.edit("script.json", (script) => (script["signOff"] = "Start with Yasno"));
  latin.edit(
    "motion-plan.json",
    (plan) => (plan["onScreenCopy"] = [{ shotId: "cta", text: "Start with Yasno", required: true }]),
  );
  assert.deepEqual(latin.run(), []);

  const mixed = copy(t, "good");
  mixed.edit("design.json", (design) => (design["fonts"] = ["primary", "display"]));
  mixed.edit("storyboard.json", (board) => {
    board["scenes"][0].subtext = "Latin only";
    board["scenes"][0].onScreenText = ["Больше ясности"];
  });
  assert.deepEqual(
    only(mixed.run(), "FONT_GLYPHS_MISSING").map((finding) => finding.severity),
    ["warning"],
  );
});

test("glyph data comes from the subsets each loader asks for", () => {
  assert.deepEqual(missingGlyphs("Hi Я", "display"), ["Я"]);
  assert.deepEqual(missingGlyphs("Hi Я", "condensed"), ["Я"]);
  assert.deepEqual(missingGlyphs("Hi Я", "rounded"), ["Я"]);
  for (const token of [
    "primary",
    "serif",
    "narrow",
    "geometric",
    "cyrillic-condensed",
    "cyrillic-wide",
    "cyrillic-grotesk",
    "cyrillic-rounded",
  ])
    assert.deepEqual(missingGlyphs("Hi Я Ё", token), [], token);
  assert.deepEqual(missingGlyphs("Ç ", "display"), []);
  assert.deepEqual(
    missingGlyphs("Ā", "display"),
    ["Ā"],
    "latin-ext exists for Space Grotesk but fonts.ts does not load it",
  );
  assert.deepEqual(missingGlyphs("go 🚀", "display"), []);
  assert.deepEqual(parseUnicodeRanges("U+0400-045F, U+4??, nonsense"), [
    [0x400, 0x45f],
    [0x400, 0x4ff],
  ]);
});

test("the token table matches the subsets the font loaders ask for", () => {
  const source = readFileSync("src/lib/fonts.ts", "utf8");
  const cyrillicSource = readFileSync("src/lib/fonts-cyrillic.ts", "utf8");
  assert.match(cyrillicSource, /CYRILLIC_FONT_SUBSETS: \("latin" \| "cyrillic"\)\[\] = \["latin", "cyrillic"\]/);
  for (const [token, face] of Object.entries(FONT_TOKEN_FACES)) {
    if (token.startsWith("cyrillic-")) {
      assert.match(cyrillicSource, new RegExp(`fontFamily: ${face.exportName} \\}`), token);
      assert.deepEqual(face.subsets, ["latin", "cyrillic"], token);
      continue;
    }
    const declared = new RegExp(`fontFamily: ${face.exportName} \\} = [^;]*?subsets: \\[([^\\]]*)\\]`).exec(source);
    assert.ok(declared, token);
    assert.deepEqual(
      [...declared[1]!.matchAll(/"([^"]+)"/g)].map((match) => match[1]),
      face.subsets,
      token,
    );
  }
});

test("SCRIPT_TEXT_LOST: a lost call to action, tagline or sign-off", (t) => {
  const cta = copy(t, "good");
  cta.edit("brief.json", (brief) => (brief["callToAction"] = "Попробуй бесплатно"));
  assert.deepEqual(codes(cta.run()), ["SCRIPT_TEXT_LOST"]);

  const tagline = copy(t, "good");
  tagline.edit("brief.json", (brief) => (brief["tagline"] = "Меньше переключений. Больше ясности."));
  assert.deepEqual(codes(tagline.run()), ["SCRIPT_TEXT_LOST"]);

  const signOff = copy(t, "good");
  signOff.edit("script.json", (script) => (script["signOff"] = "До встречи"));
  assert.deepEqual(codes(signOff.run()), ["SCRIPT_TEXT_LOST"]);
  signOff.edit("pipeline-state.json", (state) => (state["stages"].storyboard.status = "running"));
  assert.deepEqual(codes(signOff.run()), []);

  const sameLine = copy(t, "good");
  sameLine.edit("brief.json", (brief) => (brief["callToAction"] = "До встречи"));
  sameLine.edit("script.json", (script) => (script["signOff"] = "До встречи!"));
  assert.deepEqual(codes(sameLine.run()), ["SCRIPT_TEXT_LOST"], "one line lost is one finding");
});

test("SCRIPT_TEXT_LOST: case, punctuation, ё and line splits do not count as loss, part of a word does", (t) => {
  assert.equal(normaliseCopy("  Меньше ШУМА. / Ёмко — «да»!  "), "меньше шума емко да");
  const project = copy(t, "good");
  project.edit("brief.json", (brief) => (brief["callToAction"] = "начни, с ясно!"));
  assert.deepEqual(codes(project.run()), []);
  project.edit("brief.json", (brief) => (brief["callToAction"] = "Начни с Яс"));
  assert.deepEqual(codes(project.run()), ["SCRIPT_TEXT_LOST"]);
});

test("SCRIPT_TEXT_LOST: required copy on no real shot, or missing from the storyboard", (t) => {
  const orphan = copy(t, "good");
  orphan.edit("motion-plan.json", (plan) => (plan["onScreenCopy"][2].shotId = "gone"));
  assert.ok(
    only(orphan.run(), "SCRIPT_TEXT_LOST").some(
      (finding) => finding.severity === "error" && finding.message.includes('"gone"'),
    ),
  );

  const drift = copy(t, "good");
  drift.edit("motion-plan.json", (plan) =>
    plan["onScreenCopy"].push({ shotId: "cta", text: "Только в плане", required: true }),
  );
  assert.deepEqual(
    drift.run().map((finding) => [finding.code, finding.severity]),
    [["SCRIPT_TEXT_LOST", "warning"]],
  );
});

const fade = (json: Json, luma = 20) => (json["extraction"].frames.at(-1).meanLuma = luma);

test("FINAL_FRAME_FADED: fires from evidence, respects the fade intent and an intentional dark frame", (t) => {
  const project = copy(t, "good");
  project.edit("qa-evidence/vertical-1/evidence.json", fade);
  assert.deepEqual(codes(project.run()), ["FINAL_FRAME_FADED"]);
  project.edit("motion-plan.json", (plan) => (plan["finalFrameIntent"] = "fade"));
  assert.deepEqual(codes(project.run()), []);
  project.edit("motion-plan.json", (plan) => (plan["finalFrameIntent"] = "hold"));
  project.edit(
    "qa-evidence/vertical-1/evidence.json",
    (json) => (json["extraction"].frames.at(-1).intentionalDark = true),
  );
  assert.deepEqual(codes(project.run()), []);
});

test("FINAL_FRAME_FADED: ignores stale evidence and evidence too sparse to compare", (t) => {
  const stale = copy(t, "good");
  stale.edit("qa-evidence/vertical-1/evidence.json", (json) => {
    fade(json);
    json["sourceHash"] = "0".repeat(64);
  });
  assert.deepEqual(codes(stale.run()), []);

  const sparse = copy(t, "good");
  sparse.edit("qa-evidence/vertical-1/evidence.json", (json) => {
    fade(json);
    json["extraction"].frames.splice(1, 1);
  });
  assert.deepEqual(codes(sparse.run()), []);
});

const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;

test("FINAL_FRAME_FADED: decodes the final frames when no evidence covers the render", { skip: !hasFfmpeg }, (t) => {
  const project = copy(t, "good");
  rmSync(path.join(project.pipeline, "qa-evidence"), { recursive: true });
  const make = (name: string, filter: string) => {
    const file = path.join(project.root, name);
    const made = spawnSync("ffmpeg", [
      "-v",
      "error",
      "-nostdin",
      "-f",
      "lavfi",
      "-i",
      "color=c=white:s=64x64:r=30:d=2",
      "-vf",
      filter,
      "-pix_fmt",
      "yuv420p",
      file,
    ]);
    assert.equal(made.status, 0, made.stderr?.toString());
    return file;
  };
  const faded = make("faded.mp4", "fade=t=out:st=1.6:d=0.4");
  const held = make("held.mp4", "format=yuv420p");
  const pair = decodeFinalPair(faded)!;
  assert.equal(pair.last.frame, 59);
  assert.equal(pair.before.frame, 44);
  assert.ok(pair.before.meanLuma > pair.last.meanLuma);
  const finals = (renderFile: string) => only(project.run({ renderFile }), "FINAL_FRAME_FADED");
  assert.equal(finals(faded).length, 1);
  assert.equal(finals(held).length, 0);
  project.edit("motion-plan.json", (plan) => (plan["finalFrameIntent"] = "fade"));
  assert.equal(finals(faded).length, 0);
});

test("VISUAL_REVIEW_MISSING and REVIEW_STALE wrap the receipts, with refs inside the project", (t) => {
  const missing = copy(t, "good");
  rmSync(path.join(missing.pipeline, "reviews"), { recursive: true });
  const findings = missing.run();
  assert.deepEqual(codes(findings), ["VISUAL_REVIEW_MISSING"]);
  assert.ok(findings[0]!.ref!.file.startsWith(missing.pipeline));

  const stale = copy(t, "good");
  stale.edit("reviews/final.json", (review) => (review["renderSha256"] = "0".repeat(64)));
  assert.deepEqual(codes(stale.run()), ["REVIEW_STALE"]);

  const notRendered = copy(t, "good");
  rmSync(path.join(notRendered.pipeline, "reviews"), { recursive: true });
  notRendered.edit("pipeline-state.json", (state) => (state["stages"].render.status = "pending"));
  assert.deepEqual(codes(notRendered.run()), []);
});

test("the recorded render hash counts when the file is not on this machine", (t) => {
  const project = copy(t, "good");
  rmSync(path.join(project.root, "render.bin"));
  assert.deepEqual(project.run(), []);
  project.edit("reviews/final.json", (review) => (review["renderSha256"] = "0".repeat(64)));
  assert.deepEqual(codes(project.run()), ["REVIEW_STALE"]);
});

test("BLUEPRINT_INVALID: absent or invalid blueprint", (t) => {
  const absent = copy(t, "good");
  absent.edit("motion-plan.json", (plan) => (plan["blueprintReferenceId"] = "no-such-ref"));
  assert.deepEqual(codes(absent.run()), ["BLUEPRINT_INVALID"]);

  const invalid = copy(t, "good");
  writeFileSync(path.join(invalid.root, "library/good-ref/blueprint.json"), JSON.stringify({ schemaVersion: 1 }));
  assert.deepEqual(codes(invalid.run()), ["BLUEPRINT_INVALID"]);

  const broken = copy(t, "good");
  writeFileSync(path.join(broken.root, "library/good-ref/blueprint.json"), "not json");
  assert.deepEqual(codes(broken.run()), ["BLUEPRINT_INVALID"]);
});

test("findings carry an instruction, except the wrapped review ones, which word their own", (t) => {
  const project = copy(t, "good");
  project.edit("concept.json", (concept) => (concept["productTruth"].sources = []));
  project.edit("design.json", (design) => (design["fonts"] = ["display"]));
  project.edit("brief.json", (brief) => (brief["callToAction"] = "Другой призыв"));
  project.edit("qa-evidence/vertical-1/evidence.json", fade);
  project.edit("motion-plan.json", (plan) => (plan["blueprintReferenceId"] = "no-such-ref"));
  const findings = project.run();
  assert.deepEqual([...new Set(codes(findings))].sort(), [
    "BLUEPRINT_INVALID",
    "FINAL_FRAME_FADED",
    "FONT_GLYPHS_MISSING",
    "PRODUCT_MATERIAL_MISSING",
    "SCRIPT_TEXT_LOST",
  ]);
  for (const finding of findings) {
    assert.ok(CREATIVE_FINDING_CODES.includes(finding.code));
    assert.match(finding.message, /Fix: /, finding.code);
  }
});

test("the legacy fixture is quiet because of the gate: as a bespoke project it has real faults", (t) => {
  const project = copy(t, "legacy");
  project.edit("brief.json", (brief) => (brief["renderMode"] = "bespoke"));
  assert.deepEqual([...new Set(codes(project.run()))].sort(), [
    "CONCEPT_MISSING",
    "FINAL_FRAME_FADED",
    "FONT_GLYPHS_MISSING",
    "MOTION_PLAN_MISSING",
    "SCRIPT_TEXT_LOST",
    "VISUAL_REVIEW_MISSING",
  ]);
});

test("optional Cyrillic roles leave an old font context's generated module unchanged", () => {
  const old = {
    version: 1 as const,
    faces: [],
    roles: Object.fromEntries(FONT_ROLES.slice(0, 8).map((role) => [role, "Family"])),
  };
  const source = fontRoleModuleSource(old, "browser");
  assert.equal(source.match(/^export const /gm)?.length, 8);
  assert.doesNotMatch(source, /cyrillic/);
  assert.ok(FONT_ROLES.includes("cyrillicGroteskFont"));
});

const fixtureFont = "/System/Library/Fonts/Supplemental/Arial.ttf";

test(
  "an eight-role font context still validates; a new role is checked only when present",
  { skip: !existsSync(fixtureFont) },
  async (t) => {
    const { importResource } = await import("../src/lib/font-resources/registry");
    const { inspectSfnt } = await import("../src/lib/font-resources/sfnt");
    const { createFontManifest, planFontRoleContext } = await import("../src/lib/font-resources/manifest");
    const root = mkdtempSync(path.join(tmpdir(), "creative-fonts-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const project = path.join(root, "public/projects/fonts");
    cpSync(path.join(fixtures, "legacy/project"), project, { recursive: true });
    writeFileSync(path.join(project, "project.json"), "{}");
    const actual = inspectSfnt(readFileSync(fixtureFont));
    importResource(
      "fonts",
      fixtureFont,
      {
        source: "local system test fixture only",
        licence: "not a redistribution permission",
        licenceEvidence: "local fixture",
        licenceText: "Fixture only",
        attribution: "fixture",
        checkedAt: new Date().toISOString(),
        kind: "font",
        family: actual.family,
        style: actual.style as "normal",
        weight: actual.weight,
        subset: "local",
        requiredText: "Привет",
      },
      root,
    );
    const selection = {
      family: actual.family,
      style: "normal" as const,
      weights: [actual.weight],
      subset: "local",
      requiredText: "Привет",
    };
    const roles = Object.fromEntries(FONT_ROLES.slice(0, 8).map((role) => [role, selection])) as Parameters<
      typeof createFontManifest
    >[1];
    const manifest = createFontManifest("fonts", roles, root);
    assert.equal(Object.keys(manifest.roles).length, 8);
    assert.doesNotThrow(() => planFontRoleContext("fonts", manifest, { rootDir: root }));
    assert.throws(
      () =>
        planFontRoleContext(
          "fonts",
          { ...manifest, roles: { ...manifest.roles, cyrillicWideFont: "Absent Family" } },
          { rootDir: root },
        ),
      /Missing actual role family/,
    );
    assert.doesNotThrow(() =>
      planFontRoleContext(
        "fonts",
        { ...manifest, roles: { ...manifest.roles, cyrillicWideFont: actual.family } },
        { rootDir: root },
      ),
    );
  },
);
