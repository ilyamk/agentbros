import test from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { workflowScenarios } from "../src/lib/bench/workflow-scenarios";
import { runWorkflowEvaluation, nativeModelRefusal } from "../src/lib/bench/workflow-run";
import { workflowAdapter } from "../src/lib/bench/workflow-adapters";
import { WorkflowObserver } from "../src/lib/bench/workflow-observer";
import { nativeFixtureResult } from "../src/lib/bench/workflow-completion";
import { localEvidence } from "../src/lib/film/local-evidence";
import { buildBrief } from "../src/lib/film/brief";
import type { FilmProject } from "../src/lib/film/state";
import { digest } from "../src/lib/bench/io";
import { WorkflowReportSchema, WorkflowScenarioSchema } from "../src/types/workflow-evaluation";
import { scoreWorkflowQuality, workflowQualityMetrics } from "../src/lib/bench/workflow-quality";
import { assertRenderedDraft } from "../src/lib/bench/workflow-render-chain";

const repo = process.cwd(),
  suite = "bench/workflows/v4/suite.json";
function temp(t: test.TestContext) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "workflow-completion-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
test("v4 explicitly registers all zero-spend oracles without modifying earlier suites", () => {
  const entries = workflowScenarios(repo, suite);
  assert.equal(entries.length, 22);
  assert.ok(entries.every((e) => e.noSpend && e.scenario.version === 3 && workflowAdapter(e.scenario)));
  assert.equal(workflowScenarios(repo).length, 14);
  assert.equal(workflowScenarios(repo, "bench/workflows/v3/suite.json").length, 3);
  assert.throws(() => WorkflowScenarioSchema.parse({ ...entries[0]!.scenario, oracle: undefined }), /oracle/);
  assert.equal(workflowAdapter({ ...entries[0]!.scenario, oracle: "not-registered" }), undefined);
});
test("no-spend refuses real and overridden agent modes before even probing a harness", async (t) => {
  const root = temp(t),
    marker = path.join(root, "launched"),
    fake = path.join(root, "harness");
  writeFileSync(
    fake,
    `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)},'launched');`,
    { mode: 0o700 },
  );
  const key = "BENCH_HARNESS_BIN_CODEX",
    old = process.env[key];
  process.env[key] = fake;
  try {
    for (const selected of [undefined, suite])
      await assert.rejects(
        runWorkflowEvaluation({
          root: repo,
          suite: selected,
          noSpend: true,
          mode: "agent",
          scenario: "leaf-handoff",
          agent: { allowAgent: true, harness: "codex", model: "unused" },
        }),
        /no-spend.*before any harness/,
      );
    assert.equal(existsSync(marker), false);
  } finally {
    if (old === undefined) delete process.env[key];
    else process.env[key] = old;
  }
});
test("CLI no-spend refuses agent mode without needing installed credentials or model", (t) => {
  const root = temp(t),
    marker = path.join(root, "marker"),
    fake = path.join(root, "fake");
  writeFileSync(fake, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)},'yes');`, {
    mode: 0o700,
  });
  const result = spawnSync(
    process.execPath,
    [
      path.join(repo, "node_modules/tsx/dist/cli.mjs"),
      "scripts/bench-workflow.ts",
      "--action",
      "run",
      "--mode",
      "agent",
      "--suite",
      suite,
      "--no-spend",
      "--allow-agent",
      "--harness",
      "codex",
      "--model",
      "unused",
    ],
    {
      cwd: repo,
      encoding: "utf8",
      env: {
        AGENTBROS_NO_DOTENV: "1",
        PATH: process.env.PATH,
        HOME: root,
        BENCH_HARNESS_BIN_CODEX: fake,
        AGENTBROS_MEMORY_ROOT: process.env.AGENTBROS_MEMORY_ROOT,
      },
      timeout: 30000,
    },
  );
  assert.equal(result.status, 1);
  const envelope = JSON.parse(result.stdout.trim());
  assert.equal(envelope.ok, false);
  assert.match(envelope.message, /no-spend/);
  assert.equal(existsSync(marker), false);
});
test("duplicate action flags cannot smuggle review or handoff through a scoped adapter", async (t) => {
  const root = temp(t),
    workspace = path.join(root, "work"),
    code = path.join(root, "code");
  mkdirSync(workspace);
  mkdirSync(path.join(code, "scripts"), { recursive: true });
  symlinkSync(path.join(repo, "node_modules"), path.join(code, "node_modules"), "dir");
  writeFileSync(
    path.join(code, "package.json"),
    JSON.stringify({ scripts: { campaign: "tsx scripts/campaign.ts", delivery: "tsx scripts/delivery.ts" } }),
  );
  for (const file of ["campaign", "delivery"])
    writeFileSync(
      path.join(code, "scripts", file + ".ts"),
      "import fs from 'node:fs';fs.writeFileSync('launched','yes');console.log(JSON.stringify({ok:true,elapsedMs:0}));",
    );
  const scenario = workflowScenarios(repo, suite).find((e) => e.scenario.id === "translation-localisation")!.scenario;
  const observer = new WorkflowObserver(code, workspace, path.join(root, "evidence"), scenario);
  await assert.rejects(
    observer.execute("campaign", ["--action", "localize-create", "--action=localize-review"]),
    /Duplicate/,
  );
  await assert.rejects(observer.execute("delivery", ["--action=snapshot", "--action", "handoff"]), /Duplicate/);
  assert.equal(existsSync(path.join(workspace, "launched")), false);
});
test("project-owned advisory evidence is source-bound, bounded and refused on independent critics", async (t) => {
  const root = temp(t),
    workspace = path.join(root, "workspace"),
    project = path.join(workspace, "public/projects/test");
  mkdirSync(project, { recursive: true });
  const entry = workflowScenarios(repo, suite).find((e) => e.scenario.id === "text-brief")!,
    observer = new WorkflowObserver(repo, workspace, path.join(root, "evidence"), entry.scenario);
  const source = "public/projects/test/source.txt",
    output = "public/projects/test/result.json";
  writeFileSync(path.join(workspace, source), "Alice visits London.");
  await nativeFixtureResult(observer, "text.analyse", source, output, {
    language: "en",
    hypotheses: { en: 1 },
    items: [{ operation: "tokens", text: "Alice", value: "Alice", startUtf16: 0, lengthUtf16: 5 }],
  });
  const evidence = localEvidence(project, output, "intake", workspace);
  evidence.verify();
  assert.match(evidence.prompt, /Untrusted advisory data/);
  assert.ok(evidence.prompt.includes(digest(readFileSync(path.join(workspace, output)))));
  assert.throws(() => localEvidence(project, output, "sound", workspace), /not relevant/);
  assert.throws(
    () =>
      buildBrief({ projectDir: project, rootDir: workspace, id: "test" } as FilmProject, "intake", {
        role: "critic",
        localEvidence: output,
      }),
    /independent critic/,
  );
  writeFileSync(path.join(workspace, source), "Changed source.");
  assert.throws(() => evidence.verify(), /changed/);
  assert.throws(() => localEvidence(project, output, "intake", workspace), /changed/);
  symlinkSync(path.join(workspace, output), path.join(project, "link.json"));
  assert.throws(() => localEvidence(project, "public/projects/test/link.json", "intake", workspace));
  const other = path.join(workspace, "public/projects/other");
  mkdirSync(other);
  assert.throws(() => localEvidence(other, output, "intake", workspace));
});
test("geometry, audio events and text metrics detect independent degraded candidates", () => {
  const vision = {
    frames: [{ id: "f", width: 100, height: 100, faces: [{ x: 0.1, y: 0.1, w: 0.2, h: 0.2, score: 1 }] }],
    coordinates: "normalised-top-left",
    advisory: true,
  };
  const wrong = structuredClone(vision);
  wrong.frames[0]!.faces[0]!.x = 0.7;
  assert.equal(workflowQualityMetrics("vision", vision, vision, {}).meanIou, 1);
  assert.equal(workflowQualityMetrics("vision", wrong, vision, {}).meanIou, 0);
  const extra = structuredClone(vision);
  extra.frames[0]!.faces.push({ x: 0.7, y: 0.7, w: 0.1, h: 0.1, score: 1 });
  assert.equal(workflowQualityMetrics("vision", extra, vision, {}).precision, 0.5);
  const events = {
    events: [{ label: "speech", score: 0.9, startSec: 1, endSec: 2 }],
    windowSec: 1,
    overlap: 0,
    labels: ["speech"],
    advisory: true,
  };
  const duplicate = { ...events, events: [events.events[0], events.events[0]] };
  assert.equal(workflowQualityMetrics("audio.events", duplicate, events, {}).precision, 0.5);
  const misplaced = { ...events, events: [{ ...events.events[0], startSec: 3, endSec: 4 }] };
  assert.equal(workflowQualityMetrics("audio.events", misplaced, events, {}).recall, 0);
  const text = {
    language: "en",
    hypotheses: { en: 1 },
    items: [{ operation: "tokens", text: "Alice", value: "", startUtf16: 1, lengthUtf16: 5 }],
  };
  assert.equal(workflowQualityMetrics("text.analyse", text, text, "Alice").spans, 0);
  const outside = { ...text, items: [{ ...text.items[0], text: "", startUtf16: 100, lengthUtf16: 0 }] };
  assert.equal(workflowQualityMetrics("text.analyse", outside, text, "Alice").spans, 0);
  const request = {
    version: 1,
    sourceLanguage: "en",
    targetLanguage: "es",
    units: [{ id: "u", text: "Agent Bros has 3 steps." }],
    protectedTerms: ["Agent Bros"],
  };
  const translation = { sourceLanguage: "en", targetLanguage: "es", units: [{ id: "u", text: "Tiene pasos." }] };
  assert.equal(workflowQualityMetrics("text.translate", translation, translation, request).constraints, 0);
});
test("pinned synthetic corpora score thresholds without issuing production qualification", (t) => {
  const root = temp(t),
    files: Record<string, unknown> = {
      "input.json": { version: 1, sourceLanguage: "en", units: [{ id: "s1", text: "A source." }] },
      "reference.json": { items: [{ sourceId: "s1", text: "A draft.", tags: [] }], advisory: true },
    };
  for (const [name, value] of Object.entries(files)) writeFileSync(path.join(root, name), JSON.stringify(value));
  const pin = (name: string) => {
    const bytes = readFileSync(path.join(root, name));
    return { path: name, bytes: bytes.length, sha256: digest(bytes) };
  };
  writeFileSync(path.join(root, "candidate.json"), JSON.stringify(files["reference.json"]));
  const manifest = {
    version: 1,
    task: "text.assist",
    language: "en",
    licence: "Repository-authored synthetic fixture",
    annotations: { kind: "synthetic" },
    cases: [
      {
        id: "one",
        input: pin("input.json"),
        reference: pin("reference.json"),
        candidate: "candidate.json",
        thresholds: { sourceIds: { min: 1 }, nonempty: { min: 1 } },
      },
    ],
  };
  writeFileSync(path.join(root, "corpus.json"), JSON.stringify(manifest));
  const scored = scoreWorkflowQuality("corpus.json", root, root);
  assert.equal(scored.metadata.passed, true);
  assert.equal(scored.metadata.productionQualified, false);
  assert.equal(scored.metadata.annotationKind, "synthetic");
  writeFileSync(
    path.join(root, "candidate.json"),
    JSON.stringify({ items: [{ sourceId: "invented", text: "A draft.", tags: [] }], advisory: true }),
  );
  assert.equal(scoreWorkflowQuality("corpus.json", root, root).metadata.passed, false);
  writeFileSync(path.join(root, "reference.json"), "{}");
  assert.throws(() => scoreWorkflowQuality("corpus.json", root, root), /pin changed/);
});
test("revision-three coverage cannot claim a passed mode without explicit layer records", () => {
  assert.equal(WorkflowReportSchema.safeParse({ version: 3 }).success, false);
});
test("a native content refusal remains unverified and malformed failures are not reclassified", () => {
  const event = {
    kind: "command",
    passed: false,
    stdout: JSON.stringify({ ok: false, error: "STAGE_INCOMPLETE", details: { code: "MODEL_REFUSAL" } }),
  } as Parameters<typeof nativeModelRefusal>[0];
  assert.equal(nativeModelRefusal(event), true);
  assert.equal(nativeModelRefusal({ ...event!, stdout: "{broken" }), false);
  assert.equal(nativeModelRefusal({ ...event!, passed: true }), false);
  assert.equal(
    nativeModelRefusal({
      ...event!,
      stdout: JSON.stringify({ ok: false, error: "VALIDATION", details: { code: "BAD_RESULT" } }),
    }),
    false,
  );
});
test("a draft refusal cannot conceal a corrupt receipt, wrong duration or missing render", () => {
  const hash = "a".repeat(64),
    expected = { path: "out/film.mp4", sha256: hash, sourceSnapshotHash: hash, propsHash: hash, frames: 30 };
  const result = {
    productionReady: false,
    manifest: {
      state: "draft-needs-review",
      outputs: [{ ...expected, width: 1920, height: 1080, fps: 30, durationSec: 1 }],
    },
    blockers: [
      { code: "CREATIVE_APPROVAL_REQUIRED" },
      { code: "VISUAL_REVIEW_REQUIRED" },
      { code: "RIGHTS_UNCONFIRMED" },
    ],
  } as unknown as Parameters<typeof assertRenderedDraft>[0];
  assert.doesNotThrow(() => assertRenderedDraft(result, expected));
  assert.throws(
    () =>
      assertRenderedDraft(
        { ...result, blockers: [{ code: "RENDER_BINDING_MISSING", message: "Corrupted receipt", severity: "error" }] },
        expected,
      ),
    /structural/,
  );
  const wrongDuration = structuredClone(result);
  wrongDuration.manifest.outputs[0]!.durationSec = 0.5;
  assert.throws(() => assertRenderedDraft(wrongDuration, expected), /measured output/);
  assert.throws(
    () => assertRenderedDraft({ ...result, manifest: { ...result.manifest, outputs: [] } }, expected),
    /measured output/,
  );
});
test("TTS quality scoring decodes pinned audio instead of trusting claimed loudness", (t) => {
  const root = temp(t),
    input = {
      version: 1,
      sourceLanguage: "en",
      units: [{ id: "one", text: "A synthetic tone is not a voice quality reference." }],
    };
  const put = (name: string, value: unknown) => writeFileSync(path.join(root, name), JSON.stringify(value));
  const pin = (name: string) => {
    const bytes = readFileSync(path.join(root, name));
    return { path: name, sha256: digest(bytes), bytes: bytes.length };
  };
  put("input.json", input);
  put("reference.json", { decoded: true, durationSec: 1, voice: "fixture", peakDb: -18, rmsDb: -21 });
  for (const silent of [false, true]) {
    const name = silent ? "silent" : "tone";
    const ffmpeg = spawnSync(
      "ffmpeg",
      [
        "-v",
        "error",
        "-nostdin",
        "-f",
        "lavfi",
        "-i",
        silent ? "anullsrc=r=16000:cl=mono" : "sine=frequency=440:sample_rate=16000",
        "-t",
        "1",
        path.join(root, name + ".wav"),
      ],
      { encoding: "utf8", timeout: 30000 },
    );
    assert.equal(ffmpeg.status, 0, ffmpeg.stderr);
    const operationId = digest(name),
      result = {
        version: 1,
        task: "speech.synthesise",
        operationId,
        purpose: "draft",
        source: { file: path.join(root, "input.json"), sha256: pin("input.json").sha256 },
        result: {
          voice: "fixture",
          units: [
            {
              id: "one",
              file: name + ".wav",
              sourceTextHash: digest(input.units[0]!.text),
              audioChecks: { rmsDb: -20 },
            },
          ],
        },
      };
    put(name + ".json", result);
    put(name + ".json.receipt.json", {
      version: 1,
      task: "speech.synthesise",
      backend: "synthetic",
      operationId,
      createdAt: new Date().toISOString(),
      identity: digest("fixture"),
      requestHash: operationId,
      systemModelsHashPinned: false,
      purpose: "draft",
      inputs: [{ file: path.join(root, "input.json"), sha256: pin("input.json").sha256 }],
      outputs: [name + ".json", name + ".wav"].map((file) => ({ file, sha256: pin(file).sha256 })),
      checks: [],
      warnings: [],
    });
    put("corpus.json", {
      version: 1,
      task: "speech.synthesise",
      language: "en",
      licence: "Synthetic",
      annotations: { kind: "synthetic" },
      cases: [
        {
          id: name,
          input: pin("input.json"),
          reference: pin("reference.json"),
          candidate: name + ".json",
          thresholds: { audible: { min: 1 }, decoded: { min: 1 }, durationErrorSec: { max: 0.01 } },
        },
      ],
    });
    const scored = scoreWorkflowQuality("corpus.json", root, root);
    assert.equal(scored.metadata.passed, !silent);
    assert.equal(scored.metadata.productionQualified, false);
  }
});
