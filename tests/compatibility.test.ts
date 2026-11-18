import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { ProjectConfigSchema } from "../src/types/video.js";
import { CharacterBibleSchema, PipelineStateSchema } from "../src/types/pipeline.js";

const baseline = JSON.parse(readFileSync(path.resolve("tests/fixtures/legacy-projects.json"), "utf8")) as Record<
  string,
  {
    name: string;
    formats: string[];
    productName: string;
    voice: string;
    scenes: Record<string, unknown>[];
  }
>;

test("all legacy projects retain narrative, source ranges and requested formats", () => {
  for (const [id, expected] of Object.entries(baseline)) {
    const project = ProjectConfigSchema.parse(
      JSON.parse(readFileSync(`tests/fixtures/legacy/${id}/project.json`, "utf8")),
    );
    assert.equal(project.name, expected.name, id);
    assert.deepEqual(project.formats, expected.formats, id);
    assert.equal(project.productName, expected.productName, id);
    assert.equal(project.voice, expected.voice, id);
    assert.equal(project.scenes.length, expected.scenes.length, id);
    expected.scenes.forEach((scene, index) => {
      const parsed = project.scenes[index] as Record<string, unknown>;
      for (const [key, value] of Object.entries(scene))
        assert.deepEqual(parsed[key], value, `${id}/${scene.id}/${key}`);
    });
  }
});

test("native presenter persona survives schema validation for downstream generation", () => {
  const result = CharacterBibleSchema.parse({
    characters: [
      {
        id: "presenter",
        name: "Lecturer",
        role: "presenter",
        description: "calm lecturer",
        presenterPersona: "lecturer — calm, slightly contrarian",
      },
    ],
  });
  assert.equal(result.characters[0].presenterPersona, "lecturer — calm, slightly contrarian");
});

test("existing persisted pipeline states load without manual migration", () => {
  for (const entry of readdirSync("tests/fixtures/legacy", { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const id = entry.name;
    let raw: string;
    try {
      raw = readFileSync(`tests/fixtures/legacy/${id}/pipeline/pipeline-state.json`, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    const state = PipelineStateSchema.parse(JSON.parse(raw));
    assert.equal(state.projectId, id);
    assert.ok(state.history.length >= 0);
  }
});

test("all three output formats and talking-head crop overrides are accepted together", () => {
  const raw = JSON.parse(readFileSync("tests/fixtures/legacy/talking-head-demo/project.json", "utf8"));
  raw.formats = ["vertical", "square", "landscape"];
  raw.talkingHead.presenterCrop = { vertical: "50% 30%", square: "50% 30%", landscape: "50% 50%" };
  const parsed = ProjectConfigSchema.parse(raw);
  assert.deepEqual(parsed.formats, raw.formats);
  assert.deepEqual(parsed.talkingHead?.presenterCrop, raw.talkingHead.presenterCrop);
});
