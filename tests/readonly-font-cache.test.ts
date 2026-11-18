import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  realpathSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  lstatSync,
  rmSync,
  renameSync,
  symlinkSync,
} from "node:fs";
import { importResource } from "../src/lib/font-resources/registry";
import { inspectSfnt } from "../src/lib/font-resources/sfnt";
import { FONT_ROLES, createFontManifest, type FontSelection } from "../src/lib/font-resources/manifest";
import { prepareRenderFontContext, readRenderFontContext } from "../src/lib/font-resources/render-context";
import { captureRenderIdentity } from "../src/lib/delivery/identity";
import { planProjectRender } from "../src/lib/render-plan";
const source = "/System/Library/Fonts/Supplemental/Arial.ttf";
const hash = (b: Buffer) => createHash("sha256").update(b).digest("hex");
function snapshot(root: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const file = path.join(dir, name),
        s = lstatSync(file);
      out[path.relative(root, file)] = {
        dev: s.dev,
        ino: s.ino,
        size: s.size,
        mtime: s.mtimeMs,
        ctime: s.ctimeMs,
        ...(s.isFile() ? { hash: hash(readFileSync(file)) } : {}),
      };
      if (s.isDirectory() && !s.isSymbolicLink()) walk(file);
    }
  };
  walk(root);
  return out;
}
function fixture(t: test.TestContext) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "readonly-font-data-"))),
    project = path.join(root, "public/projects/demo");
  mkdirSync(project, { recursive: true });
  writeFileSync(
    path.join(project, "project.json"),
    JSON.stringify({
      name: "Font DATA",
      productName: "Font",
      tagline: "",
      formats: ["square"],
      colors: {},
      musicVolume: 0,
      voiceoverEnabled: false,
      scenes: [{ id: "hook", text: "", headline: "Привет", visualType: "title", durationInFrames: 6 }],
    }),
  );
  const actual = inspectSfnt(readFileSync(source));
  const resource = importResource(
    "demo",
    source,
    {
      source: "Installed local font DATA only",
      licence: "No redistribution claim",
      licenceText: "Local diagnostic only",
      licenceEvidence: "System original",
      attribution: "Fixture",
      checkedAt: "2026-10-12T00:00:00Z",
      kind: "font",
      family: actual.family,
      weight: actual.weight,
      style: actual.style as "normal",
      subset: "latin-cyrillic",
      requiredText: "Привет Font",
    },
    root,
  );
  const selection: FontSelection = {
    family: actual.family,
    weights: [actual.weight],
    style: actual.style as "normal",
    subset: "latin-cyrillic",
    requiredText: "Привет Font",
  };
  const manifest = createFontManifest(
    "demo",
    Object.fromEntries(FONT_ROLES.map((role) => [role, selection])) as Record<
      (typeof FONT_ROLES)[number],
      FontSelection
    >,
    root,
  );
  const context = path.join(project, "context.json");
  writeFileSync(context, JSON.stringify(manifest));
  const props = planProjectRender("demo", "square", root).jobs[0]!.props;
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, project, context, props, resource };
}
const options = { skip: !existsSync(source) };
test(
  "existing cache yields identical controlled paths/manifest and identity without any filesystem writes",
  options,
  (t) => {
    const f = fixture(t),
      prepared = prepareRenderFontContext("demo", f.context, f.props, f.root);
    const identity = captureRenderIdentity("demo", "square", { rootDir: f.root, fontContext: f.context }),
      before = snapshot(f.root);
    assert.deepEqual(readRenderFontContext("demo", f.context, f.props, f.root), prepared);
    assert.deepEqual(
      captureRenderIdentity("demo", "square", { rootDir: f.root, fontContext: f.context, fontContextMode: "existing" }),
      identity,
    );
    assert.deepEqual(snapshot(f.root), before);
  },
);
test(
  "absent cache directory, missing cached JSON or module refuses without creating or reconstructing files",
  options,
  (t) => {
    for (const kind of ["directory", "context", "module"]) {
      const f = fixture(t),
        prepared = prepareRenderFontContext("demo", f.context, f.props, f.root);
      rmSync(
        kind === "directory"
          ? path.dirname(prepared.contextFile)
          : kind === "context"
            ? prepared.contextFile
            : prepared.modulePath,
        { recursive: kind === "directory" },
      );
      const before = snapshot(f.root);
      assert.throws(() => readRenderFontContext("demo", f.context, f.props, f.root));
      assert.deepEqual(snapshot(f.root), before);
    }
  },
);
test("changed content-addressed cache is refused and preserved rather than repaired", options, (t) => {
  for (const kind of ["context", "module"]) {
    const f = fixture(t),
      prepared = prepareRenderFontContext("demo", f.context, f.props, f.root);
    writeFileSync(kind === "context" ? prepared.contextFile : prepared.modulePath, "Changed DATA");
    const before = snapshot(f.root);
    assert.throws(() => readRenderFontContext("demo", f.context, f.props, f.root), /cache changed/);
    assert.deepEqual(snapshot(f.root), before);
  }
});
test(
  "cache parent, cache leaf and declarative context aliases refuse without following or writing them",
  options,
  (t) => {
    for (const kind of ["parent", "leaf", "input"]) {
      const f = fixture(t),
        prepared = prepareRenderFontContext("demo", f.context, f.props, f.root);
      const original =
          kind === "parent" ? path.dirname(prepared.modulePath) : kind === "leaf" ? prepared.modulePath : f.context,
        moved = original + "-owned";
      renameSync(original, moved);
      symlinkSync(moved, original);
      const before = snapshot(f.root);
      assert.throws(() => readRenderFontContext("demo", f.context, f.props, f.root), /alias/);
      assert.deepEqual(snapshot(f.root), before);
    }
  },
);
test("changed registered font or licence refuses and retains both cache and supplied originals", options, (t) => {
  for (const kind of ["font", "licence"]) {
    const f = fixture(t);
    prepareRenderFontContext("demo", f.context, f.props, f.root);
    const file = path.join(f.root, "public", kind === "font" ? f.resource.original : f.resource.licenceFile);
    writeFileSync(file, "Changed original DATA");
    const before = snapshot(f.root);
    assert.throws(() => readRenderFontContext("demo", f.context, f.props, f.root), /original\/licence changed/);
    assert.deepEqual(snapshot(f.root), before);
  }
});
test("new unsupported displayed glyph refuses without synthesizing a new font cache", options, (t) => {
  const f = fixture(t);
  prepareRenderFontContext("demo", f.context, f.props, f.root);
  const before = snapshot(f.root);
  const props = { ...f.props, scenes: f.props.scenes.map((scene) => ({ ...scene, headline: "\u{10ffff}" })) };
  assert.throws(() => readRenderFontContext("demo", f.context, props, f.root), /glyph|coverage/);
  assert.deepEqual(snapshot(f.root), before);
});
