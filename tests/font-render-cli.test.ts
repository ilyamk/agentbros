import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { spawnSync, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { importResource } from "../src/lib/font-resources/registry";
import { inspectSfnt } from "../src/lib/font-resources/sfnt";
import { FONT_ROLES, createFontManifest, type FontSelection } from "../src/lib/font-resources/manifest";
import { prepareRenderFontContext, displayedFontText } from "../src/lib/font-resources/render-context";
import { projectToVideoProps } from "../src/lib/project-props";
import { ProjectConfigSchema } from "../src/types/video";
const source = "/System/Library/Fonts/Supplemental/Arial.ttf";
function fixture(t: test.TestContext) {
  const id = "font-cli-" + randomUUID(),
    directory = path.resolve("public/projects", id);
  mkdirSync(directory, { recursive: true });
  const output = path.resolve("out", id);
  t.after(() => {
    rmSync(directory, { recursive: true, force: true });
    rmSync(output, { recursive: true, force: true });
  });
  const project = ProjectConfigSchema.parse({
    name: "Local font test",
    productName: "Fixture",
    formats: ["square"],
    colors: {},
    musicVolume: 0,
    scenes: [
      {
        id: "hook",
        text: "",
        headline: "Привет мир",
        visualType: "title",
        durationInFrames: 6,
      },
    ],
  });
  writeFileSync(path.join(directory, "project.json"), JSON.stringify(project));
  const actual = inspectSfnt(readFileSync(source));
  importResource(id, source, {
    source: "local system fixture only",
    licence: "no redistribution claim",
    licenceText: "Temporary test fixture only",
    licenceEvidence: "Local system installation",
    attribution: "System fixture",
    checkedAt: "2026-10-11T00:00:00Z",
    kind: "font",
    family: actual.family,
    weight: actual.weight,
    style: actual.style as "normal",
    subset: "latin-cyrillic",
    requiredText: "Привет мир",
  });
  const selection: FontSelection = {
    family: actual.family,
    weights: [actual.weight],
    style: "normal",
    subset: "latin-cyrillic",
    requiredText: "Привет мир",
  };
  const manifest = createFontManifest(
    id,
    Object.fromEntries(FONT_ROLES.map((role) => [role, selection])) as Record<
      (typeof FONT_ROLES)[number],
      FontSelection
    >,
  );
  const context = path.join(directory, "context.json");
  writeFileSync(context, JSON.stringify(manifest));
  return { id, directory, output, project, context };
}
function cli(args: string[]) {
  const result = spawnSync("pnpm", ["exec", "tsx", "scripts/render-project.ts", ...args], {
    encoding: "utf8",
    timeout: 120000,
    maxBuffer: 8_000_000,
  });
  const lines = result.stdout.trim().split("\n");
  assert.equal(lines.length, 1, result.stdout);
  return {
    status: result.status,
    envelope: JSON.parse(lines[0]),
    stderr: result.stderr,
  };
}
test(
  "font render context is stable controlled code, validates actual display glyphs and CLI dry-run",
  { skip: !existsSync(source) },
  (t) => {
    const f = fixture(t),
      props = projectToVideoProps(f.project, f.id, "square", false);
    const first = prepareRenderFontContext(f.id, f.context, props),
      second = prepareRenderFontContext(f.id, f.context, props);
    assert.equal(first.modulePath, second.modulePath);
    assert.equal(first.contextFile, second.contextFile);
    const frozenAgain = prepareRenderFontContext(f.id, first.contextFile, props);
    assert.equal(first.contextFile, frozenAgain.contextFile);
    assert.equal(first.modulePath, frozenAgain.modulePath);
    assert.ok(first.modulePath.includes(".cache/font-contexts"));
    assert.ok(displayedFontText(props).includes("Привет мир"));
    assert.throws(
      () =>
        prepareRenderFontContext(f.id, f.context, {
          ...props,
          scenes: [{ ...props.scenes[0], headline: "\u{10ffff}" }],
        }),
      /coverage/,
    );
    const captionDir = path.join(f.directory, "voiceover");
    mkdirSync(captionDir);
    const captionFile = path.join(captionDir, "hook.words.json");
    writeFileSync(captionFile, JSON.stringify([{ text: "\u{10ffff}", start: 0, end: 0.1, loss: 0 }]));
    assert.throws(() => prepareRenderFontContext(f.id, f.context, props), /coverage/);
    rmSync(captionFile);
    const dry = cli(["--project", f.id, "--font-context", f.context, "--dry-run"]);
    assert.equal(dry.status, 0, dry.stderr);
    assert.equal(dry.envelope.ok, true);
    assert.deepEqual(dry.envelope.outputs, []);
    assert.equal(dry.envelope.metadata.fontContexts.length, 1);
    assert.equal(existsSync(path.join(f.directory, "pipeline/operations.json")), false);
    const invalid = path.join(f.directory, "bad-context.json");
    writeFileSync(invalid, JSON.stringify({ module: "untrusted.js" }));
    const refused = cli(["--project", f.id, "--font-context", invalid, "--dry-run"]);
    assert.notEqual(refused.status, 0);
    assert.equal(refused.envelope.ok, false);
  },
);
test(
  "actual production render CLI applies local original and publishes font-bound receipt",
  {
    skip: process.env.RUN_RENDER_TESTS !== "1" || !existsSync(source),
    timeout: 120000,
  },
  (t) => {
    const f = fixture(t);
    const result = cli(["--project", f.id, "--font-context", f.context, "--format", "square"]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.envelope.ok, true);
    const output = result.envelope.outputs[0];
    assert.ok(existsSync(output));
    const probe = JSON.parse(
      execFileSync("ffprobe", ["-v", "error", "-show_format", "-of", "json", output], { encoding: "utf8" }),
    );
    assert.ok(Math.abs(Number(probe.format.duration) - 0.2) < 0.04);
    const receipt = JSON.parse(readFileSync(result.envelope.metadata.receipts[0], "utf8"));
    assert.ok(
      JSON.stringify(receipt).includes(".cache/font-contexts"),
      "font sources must be part of renderer identity",
    );
  },
);
