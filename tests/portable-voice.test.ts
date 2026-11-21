import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { LocalResultReceiptSchema } from "../src/types/local-capabilities";
import { inspectCapabilities } from "../src/lib/local-capabilities";
import { assertNoDraftLocalAssets } from "../src/lib/apple/tasks";
import { verifyLocal } from "../src/lib/apple/verify";
import { fileHash } from "../src/lib/apple/runtime";
import { runPortableVoice } from "../src/lib/speech/portable-voice";

const repo = path.resolve(import.meta.dirname, "..");
const parse = (file: string) => JSON.parse(readFileSync(file, "utf8"));
function run(cwd: string, ...flags: string[]) {
  const child = spawnSync(
    process.execPath,
    [
      path.join(repo, "node_modules/tsx/dist/cli.mjs"),
      path.join(repo, "scripts/local-task.ts"),
      "--task",
      "speech.synthesise",
      "--engine",
      "portable",
      ...flags,
    ],
    { cwd, env: { ...process.env, AGENTBROS_NO_DOTENV: "1" }, encoding: "utf8", timeout: 60_000 },
  );
  assert.equal(child.status, 0, child.stdout + child.stderr);
  return JSON.parse(child.stdout);
}

test("portable voice preparation plan names both pinned model downloads", (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "voice-plan-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const result = run(dir, "--prepare", "--dry-run");
  assert.equal(result.metadata.apiCalls, 0);
  assert.equal(result.metadata.modelPins.length, 2);
  assert.ok(result.metadata.modelPins.every((model: { sha256: string }) => /^[a-f0-9]{64}$/.test(model.sha256)));
});

test("Linux and Windows capability discovery offer portable voice preparation", async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "voice-discovery-"));
  const previous = process.env.AGENTBROS_MODEL_CACHE;
  process.env.AGENTBROS_MODEL_CACHE = dir;
  t.after(() => {
    if (previous === undefined) delete process.env.AGENTBROS_MODEL_CACHE;
    else process.env.AGENTBROS_MODEL_CACHE = previous;
    rmSync(dir, { recursive: true, force: true });
  });
  for (const platform of ["linux", "win32"] as const) {
    const [capability] = await inspectCapabilities([{ task: "speech.synthesise", language: "ru" }], {
      platform,
      root: dir,
    });
    assert.equal(capability?.state, "needs_prepare");
    assert.deepEqual(capability.prepare, ["pnpm", "voiceover:local", "--engine", "portable", "--prepare"]);
  }
});

test(
  "portable voice makes EN and RU audio and word timings and reuses just the unchanged take",
  {
    skip: process.env.RUN_PORTABLE_VOICE_TESTS !== "1",
  },
  (t) => {
    const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "portable-voice-")));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const input = path.join(dir, "request.json");
    const output = path.join(dir, "takes.json");
    const write = (language: string, text: string[]) =>
      writeFileSync(
        input,
        JSON.stringify({
          version: 1,
          sourceLanguage: language,
          units: text.map((line, index) => ({ id: `take-${index}`, text: line })),
        }),
      );
    write("en", ["Hello world. Welcome to the studio.", "See you tomorrow."]);
    const first = run(dir, "--input", input, "--output", output);
    assert.deepEqual(first.metadata.unmatched, []);
    write("en", ["Hello world. Welcome to the studio.", "Have a good day."]);
    const second = run(dir, "--input", input, "--output", output, "--force");
    assert.ok(second.metadata.cacheHits >= 1);
    const languageOutput = path.join(dir, "ru.json");
    write("ru", ["Привет мир. Добро пожаловать в студию."]);
    const russian = run(dir, "--input", input, "--output", languageOutput);
    assert.deepEqual(russian.metadata.unmatched, []);
    const receipt = LocalResultReceiptSchema.parse(parse(languageOutput + ".receipt.json"));
    assert.equal(receipt.modelPins?.length, 2);
    const words = parse(receipt.outputs.find(({ file }) => file.endsWith(".words.json"))!.file);
    assert.equal(words.timing, "estimated");
    assert.equal(words.words[0].text, "Привет");
    assert.equal(readFileSync(parse(languageOutput).result.units[0].file).toString("ascii", 0, 4), "RIFF");
  },
);

test(
  "production receipts require qualification and then pass the delivery provenance gate",
  {
    skip: process.env.RUN_PORTABLE_VOICE_TESTS !== "1",
  },
  async (t) => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), "voice-qualification-")));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const common = {
      language: "en",
      voice: "supertonic:0",
      dryRun: false,
      force: false,
      qualificationRoot: root,
    } as const;
    const pin = (file: string) => ({ file, sha256: fileHash(file) });
    const cases = ["Hello world. Welcome to the studio.", "See you tomorrow.", "Have a good day."].map(
      (text, index) => {
        const input = path.join(root, `input-${index}.json`);
        const output = path.join(root, `draft-${index}.json`);
        writeFileSync(input, JSON.stringify({ version: 1, sourceLanguage: "en", units: [{ id: "intro", text }] }));
        assert.throws(
          () => runPortableVoice({ ...common, input, output, purpose: "production" }),
          /quality qualification/,
        );
        runPortableVoice({ ...common, input, output, purpose: "draft" });
        assert.throws(() => assertNoDraftLocalAssets([parse(output).result.units[0].file]), /preview-only/);
        // Self-derived labels exercise the plumbing only. This scratch qualification is discarded by the test.
        const reference = path.join(root, `reference-${index}.json`);
        writeFileSync(reference, JSON.stringify(parse(output).result));
        return { input: pin(input), reference: pin(reference), baseline: pin(output) };
      },
    );
    const benchmark = path.join(root, "benchmark.json");
    writeFileSync(
      benchmark,
      JSON.stringify({
        version: 1,
        task: "speech.synthesise",
        ...{ language: "en", voice: "supertonic:0" },
        licence: "test text",
        cases,
      }),
    );
    const verdict = await verifyLocal({
      task: "speech.synthesise",
      language: "en",
      voice: "supertonic:0",
      suite: "quality",
      benchmark,
      root,
    });
    assert.equal(verdict.metadata.passed, true);
    const output = path.join(root, "production.json");
    runPortableVoice({ ...common, input: cases[0]!.input.file, output, purpose: "production" });
    const receipt = LocalResultReceiptSchema.parse(parse(output + ".receipt.json"));
    assert.equal(receipt.purpose, "production");
    assert.doesNotThrow(() => assertNoDraftLocalAssets([parse(output).result.units[0].file]));
  },
);
