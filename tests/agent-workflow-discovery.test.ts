import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  localStage,
  localSuggestions,
  localToolPrompt,
  STAGE_LOCAL_TASKS,
} from "../src/lib/local-capabilities/suggestions";
import { fixtureProbe } from "../src/lib/bench/workflow-fixtures";
import { inspectCapabilities } from "../src/lib/local-capabilities";
import { NativeUnavailable } from "../src/lib/apple/runtime";
import { AvailabilitySchema } from "../src/types/local-capabilities";

function project(t: test.TestContext, config: unknown = { language: "en", targetLanguage: "es" }) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "avc-workflow-discovery-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, "public/projects/probe");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "project.json"), JSON.stringify(config));
  return {
    root,
    dir,
    options: {
      root: path.join(root, "models"),
      platform: "darwin" as const,
      probe: fixtureProbe,
      legacyProbe: async () => ({ available: false, reason: "Optional legacy fixture absent" }),
    },
  };
}
test("six discovery entry-point answer shapes select task affordances without prescribing a route", async (t) => {
  const { root, options } = project(t);
  const answers = [
    "script",
    { step: "script" },
    { stage: "script" },
    { next: { step: "script" } },
    { summary: { currentStage: "script" } },
    { summary: { nextAction: "Run script stage" } },
  ];
  for (const answer of answers) {
    assert.equal(localStage(answer), "script");
    const hints = await localSuggestions("probe", answer, root, options);
    assert.deepEqual(
      hints.localTools?.ready.map((r) => r.task),
      ["text.analyse", "text.assist"],
    );
  }
  assert.equal(localStage({ next: { step: "human" } }), undefined);
  assert.ok(Object.hasOwn(STAGE_LOCAL_TASKS, "localisation"));
});
test("translation, sound-event and image-description hints are task-specific and retain input guidance", async (t) => {
  const { root, options } = project(t);
  const translation = await localSuggestions("probe", "localisation", root, options);
  assert.deepEqual(translation.localTools?.ready[0]?.argv, [
    "pnpm",
    "text:translate",
    "--language",
    "en",
    "--target-language",
    "es",
  ]);
  assert.ok(translation.localTools?.ready[0]?.input.includes("--input"));
  assert.equal(
    (await localSuggestions("probe", "audio-events", root, options)).localTools?.ready[0]?.task,
    "audio.events",
  );
  const image = await localSuggestions("probe", "image-description", root, options);
  assert.equal(image.localTools?.ready.length, 0);
  assert.equal(image.localTools?.alternatives?.[0]?.task, "image.describe");
});
test("missing language asks for parameters and unsupported tools have no runnable argv", async (t) => {
  const { root, options } = project(t, {});
  const hints = await localSuggestions("probe", { next: { stage: "localisation" } }, root, options);
  assert.deepEqual(hints.localTools?.requirements, ["language", "targetLanguage"]);
  assert.deepEqual(hints.localTools?.ready, []);
  const unsupported = await localSuggestions("probe", "reframe", root, { ...options, platform: "linux" });
  assert.deepEqual(unsupported.localTools?.ready, []);
  assert.ok(!JSON.stringify(unsupported).includes("media:vision"));
  assert.match(localToolPrompt(hints), /not mandatory/);
});
test("optional hints tolerate non-object JSON in each project metadata file", async (t) => {
  const { root, dir, options } = project(t, { language: "en" });
  for (const file of ["project.json", "pipeline/brief.json", "pipeline/footage-goals.json"]) {
    const target = path.join(dir, file);
    mkdirSync(path.dirname(target), { recursive: true });
    for (const value of [null, [], 3, "text"]) {
      writeFileSync(target, JSON.stringify(value));
      const hints = await localSuggestions("probe", "script", root, options);
      assert.ok(hints.localTools);
      assert.deepEqual(await localSuggestions("probe", "human", root, options), {});
    }
    writeFileSync(target, "{}");
  }
});
test("footage hints use the resolved source and effective unsaved goals", async (t) => {
  const { root, dir, options } = project(t, { language: "ru", targetLanguage: "es" });
  const redirected = await localSuggestions(
    "probe-recut",
    { step: "localisation", state: { project: "probe", goals: { language: "en" } } },
    root,
    options,
  );
  assert.ok(redirected.localTools?.ready.some((row) => row.task === "text.translate"));
  assert.ok(redirected.localTools?.ready.every((row) => row.argv.includes("en")));
  assert.equal(redirected.localTools?.requirements, undefined);
  writeFileSync(path.join(dir, "project.json"), "{}");
  const scribe = await localSuggestions(
    "probe",
    { step: "1-transcript", state: { project: "probe", goals: { language: "ru", transcriber: "scribe" } } },
    root,
    options,
  );
  assert.deepEqual(scribe, {});
});
test("each capability state has a contract; only ready advertises execution", async (t) => {
  const { options } = project(t);
  for (const state of AvailabilitySchema.options) {
    const [result] = await inspectCapabilities([{ task: "text.assist", language: "en" }], {
      ...options,
      probe:
        state === "ready"
          ? fixtureProbe
          : async () => {
              throw new NativeUnavailable({ state, code: "FIXTURE", message: "Explicit fixture state" });
            },
    });
    assert.equal(result?.state, state);
    assert.equal(!!result?.command, state === "ready");
  }
});
