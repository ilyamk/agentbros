import { writeBudgetBrief } from "./helpers/ceiling-grant";
import "./helpers/fal-no-network";
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { importAsset } from "../src/lib/assets/registry";
import {
  approvePack,
  jobSubmitted,
  preparePack,
  readPackOutputs,
  referencePackEnforcement,
  referencePackGate,
} from "../src/lib/references/packs";
import { packDigest } from "../src/lib/references/pack-status";
import { referencesReadyFailures } from "../src/lib/references/plan";
import { executeFalOperation } from "../src/lib/jobs/execution";
import { OperationStore } from "../src/lib/jobs/store";
import type { JobProvider } from "../src/lib/jobs/runner";
import { prepareModernAssetDispatch } from "../src/lib/providers/modern-asset";
import { DONE_CHECKS, baseTokens, openFilmProject } from "../src/lib/film/state";
import { prepareModel } from "../src/lib/model-preparation/prepare";
import { preparationAsPack, preparationPackId } from "../src/lib/model-preparation/as-pack";
import { preparationFile } from "../src/lib/model-preparation/storage";
import { AssetSpecSchema } from "../src/types/pipeline";
import { ReferencePackReceiptSchema } from "../src/types/references";
import { genjutsuFixture } from "./helpers/genjutsu-preparation";

/** Regression tests for the independent review of RFC 0003 (reference packs). Offline; media fixtures need ffmpeg. */

const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0 && spawnSync("ffprobe", ["-version"]).status === 0;
const media = { skip: hasFfmpeg ? false : "needs ffmpeg and ffprobe" } as const;
const SEEDANCE = "bytedance/seedance-2.5/reference-to-video";
const sha = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");

function code(fn: () => unknown, expected: string, pattern?: RegExp) {
  let caught: (Error & { code?: string }) | undefined;
  try {
    fn();
  } catch (error) {
    caught = error as Error & { code?: string };
  }
  assert.ok(caught, `expected ${expected}`);
  assert.equal(caught.code, expected, caught.message);
  if (pattern) assert.match(caught.message, pattern);
}

// --- Film chain: material-sourced and references-ready (findings 1, 2, 7) ---

/** A film project with synthetic (receipt-only) packs: enough for the cheap pack state, not for checkPack. */
function film(t: TestContext) {
  const rootDir = mkdtempSync(path.join(tmpdir(), "reference-review-film-"));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const id = "legacy";
  const projectDir = path.join(rootDir, "public/projects", id);
  mkdirSync(path.join(projectDir, "pipeline"), { recursive: true });
  writeFileSync(path.join(projectDir, "project.json"), "{}");
  const write = (relative: string, value: unknown) => {
    const file = path.join(projectDir, relative);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`);
    return file;
  };
  const materialRelative = `public/projects/${id}/pipeline/material.json`;
  const material = (items: unknown[]) =>
    write("pipeline/material.json", { schemaVersion: 1, filmType: "ai-video", items });
  const check = (name: "material-sourced" | "references-ready") => {
    const project = openFilmProject(projectDir, { rootDir });
    const advisories: string[] = [];
    const failures = DONE_CHECKS[name]({ project, tokens: baseTokens(project), silence: false, advisories });
    return { failures, advisories };
  };
  const approveMaterial = () =>
    write("pipeline/approvals/material.json", {
      schemaVersion: 1,
      step: "material",
      events: [
        {
          answer: "Yes, make them.",
          at: "2026-11-17T10:00:00.000Z",
          artefacts: { [materialRelative]: sha(readFileSync(path.join(rootDir, materialRelative))) },
        },
      ],
    });
  const pack = (packId: string, approve: boolean, profileSha256 = "a".repeat(64)) => {
    const receipt = ReferencePackReceiptSchema.parse({
      schemaVersion: 1,
      projectId: id,
      id: packId,
      createdAt: "2026-11-17T10:00:00.000Z",
      spec: {
        schemaVersion: 1,
        id: packId,
        shotId: "s1",
        endpoint: "google/nano-banana-2.1/edit",
        profileFamily: "nano-banana-2.1",
        attachments: [
          {
            requirementKey: "hero",
            source: { assetId: `sha256:${"1".repeat(64)}` },
            slot: "images",
            order: 1,
            roleSentence: "Mara",
          },
        ],
        prompt: { action: "Mara looks up." },
        audioPolicy: "mute",
      },
      // A stale profile digest: the full checkPack would fail as after a profile refresh.
      profileSha256,
      endpoint: "google/nano-banana-2.1/edit",
      schemaSha256: "b".repeat(64),
      requestSha256: "c".repeat(64),
      attachments: [],
      compiledPrompt: "Mara looks up.",
      markerMap: {},
      warnings: [],
      reviewFiles: [{ path: "board.html", sha256: "d".repeat(64) }],
    });
    write(`pipeline/reference-packs/${packId}/receipt.json`, receipt);
    const packSha256 = packDigest(receipt);
    if (approve)
      write(`pipeline/reference-packs/${packId}/approval.json`, {
        schemaVersion: 1,
        packSha256,
        rightsSha256: "e".repeat(64),
        userStatement: "Yes, use these.",
        approvedAt: "2026-11-17T10:05:00.000Z",
        review: {
          packSha256,
          reviewer: "user",
          evidence: "board seen",
          markersVerified: true,
          promptReviewed: true,
          attachments: [{ sha256: "1".repeat(64), requirementKey: "hero", suitable: true, evidence: "front view" }],
        },
      });
    return packSha256;
  };
  return { rootDir, id, projectDir, write, material, check, approveMaterial, pack };
}

const generated = {
  id: "hero",
  shots: ["s1"],
  what: "Mara looks up",
  kind: "generated-image",
  route: "generated",
  status: "pending",
  provenance: "nano",
  licence: "generated",
  maxCostUsd: 0.2,
};

test("references-ready: a film sealed before reference packs is grandfathered; a fresh film still fails", (t) => {
  const f = film(t);
  f.material([generated]);
  // Fresh film: no references.json and no seal → fails as before.
  assert.match(f.check("references-ready").failures.join(" "), /hero is generated and has no shot/);
  // The material step was sealed before the feature: advisories, not failures; material.json is not touched.
  const before = readFileSync(path.join(f.projectDir, "pipeline/material.json"), "utf8");
  f.write("pipeline/chain/material.json", {
    schemaVersion: 1,
    step: "material",
    inputs: {},
    outputs: {},
    at: "2026-10-01T10:00:00.000Z",
  });
  const sealed = f.check("references-ready");
  assert.deepEqual(sealed.failures, []);
  assert.match(sealed.advisories.join(" "), /advisory \(made before reference packs\): hero is generated/);
  assert.equal(readFileSync(path.join(f.projectDir, "pipeline/material.json"), "utf8"), before);
  // Once the film opts in (a references.json exists), the check is no longer grandfathered.
  f.write("pipeline/references.json", { schemaVersion: 1, shots: [] });
  assert.match(f.check("references-ready").failures.join(" "), /hero is generated and has no shot/);
});

test("references-ready: an approved (not sealed) legacy material is grandfathered too", (t) => {
  const f = film(t);
  f.material([generated]);
  f.approveMaterial();
  const approved = f.check("references-ready");
  assert.deepEqual(approved.failures, []);
  assert.equal(approved.advisories.length, 1);
});

test("references-ready: acquired items are moot; route generated counts whatever the kind (audio aside)", (t) => {
  const f = film(t);
  f.write("assets/hero.png", "made");
  // Already made: no references needed, even for a fresh film.
  f.material([{ ...generated, status: "acquired", path: `public/projects/${f.id}/assets/hero.png`, costUsd: 0.1 }]);
  assert.deepEqual(f.check("references-ready").failures, []);
  // A model-made "image" or "footage" is a generated visual; generated audio is not.
  const items = [
    { ...generated, kind: "image" },
    { ...generated, id: "clip", kind: "footage" },
    { ...generated, id: "sfx", kind: "audio" },
  ];
  const failures = referencesReadyFailures(f.id, items, f.rootDir);
  assert.match(failures.join(" "), /hero is generated and has no shot/);
  assert.match(failures.join(" "), /clip is generated and has no shot/);
  assert.doesNotMatch(failures.join(" "), /sfx/);
});

test("material-sourced: an acquired item is checked against its pack revision and outputs, not a full re-check", (t) => {
  const f = film(t);
  const packSha256 = f.pack("pack-s1", true);
  const file = f.write("assets/hero.png", "made bytes");
  const item = {
    ...generated,
    status: "acquired",
    path: `public/projects/${f.id}/assets/hero.png`,
    costUsd: 0.1,
    referencePack: { id: "pack-s1", sha256: packSha256 },
  };
  f.material([item]);
  // Not in outputs.json: refused.
  assert.match(f.check("material-sourced").failures.join(" "), /hero: .*hero\.png is not among pack pack-s1's outputs/);
  f.write("pipeline/reference-packs/pack-s1/outputs.json", {
    schemaVersion: 1,
    packSha256,
    outputs: [
      {
        operationId: "op",
        outputSha256: sha(readFileSync(file)),
        assetId: "a",
        path: item.path,
        at: "2026-11-17T10:10:00.000Z",
      },
    ],
  });
  // The synthetic pack would fail checkPack (stale profile digest); an acquired item does not reopen.
  assert.deepEqual(f.check("material-sourced").failures, []);
  // A broken outputs.json is one issue line, not a crash of the whole check.
  const outputsFile = path.join(f.projectDir, "pipeline/reference-packs/pack-s1/outputs.json");
  const good = readFileSync(outputsFile, "utf8");
  writeFileSync(outputsFile, "{ truncated");
  assert.match(f.check("material-sourced").failures.join(" "), /^hero: /);
  writeFileSync(outputsFile, good);
  // Another revision or a missing approval still fails.
  f.material([{ ...item, referencePack: { id: "pack-s1", sha256: "f".repeat(64) } }]);
  assert.match(f.check("material-sourced").failures.join(" "), /another revision/);
  rmSync(path.join(f.projectDir, "pipeline/reference-packs/pack-s1/approval.json"));
  f.material([item]);
  assert.match(f.check("material-sourced").failures.join(" "), /pack pack-s1 is not approved/);
  // Not made yet, after the material approval: the full check runs (and fails on the stale synthetic pack).
  f.pack("pack-s1", true);
  f.material([{ ...item, status: "pending", path: undefined, costUsd: null }]);
  f.approveMaterial();
  assert.ok(f.check("material-sourced").failures.some((line) => line.startsWith("hero: ")));
});

// --- Admission (findings 3, 8 and env parsing) ---

test("enforce: a fake modelPreparation on a fal endpoint exempts nothing; env parsing is case-insensitive", () => {
  const raw = {
    provider: "fal",
    endpoint: SEEDANCE,
    input: { prompt: "Mara walks.", image_urls: ["https://fal.media/a.png"] },
    context: { modelPreparation: { id: "fake", sha256: "b".repeat(64) } },
  };
  const gate = (env: Record<string, string>) =>
    referencePackGate({
      projectId: "demo",
      raw,
      provider: "fal",
      endpoint: SEEDANCE,
      input: raw.input,
      resuming: false,
      dryRun: false,
      env,
    });
  code(() => gate({ AGENTBROS_REFERENCE_PACKS: "enforce" }), "VALIDATION", /without a reference pack/);
  code(() => gate({ AGENTBROS_REFERENCE_PACKS: "  ENFORCE " }), "VALIDATION", /without a reference pack/);
  assert.equal(referencePackEnforcement({ AGENTBROS_REFERENCE_PACKS: " Off" }), "off");
  assert.equal(referencePackEnforcement({ AGENTBROS_REFERENCE_PACKS: "WARN" }), "warn");
  assert.equal(referencePackEnforcement({ AGENTBROS_REFERENCE_PACKS: "  " }), "warn");
  code(() => referencePackEnforcement({ AGENTBROS_REFERENCE_PACKS: "strict" }), "INVALID_INPUT");
});

test("a job resumes past the gate only once it may have reached the provider", () => {
  assert.equal(jobSubmitted(undefined), false);
  assert.equal(jobSubmitted({ state: "reserved" }), false);
  assert.equal(jobSubmitted({ state: "planned" }), false);
  assert.equal(jobSubmitted({ state: "queued", providerRequestId: "r1" }), true);
  assert.equal(jobSubmitted({ state: "reserved", release: { confirmationId: "c" } }), true);
  assert.equal(jobSubmitted({ state: "published", receipt: { receiptId: "x" } }), true);
  assert.equal(jobSubmitted({ state: "submitting" }), true);
  assert.equal(jobSubmitted({ state: "unknown" }), true);
});

// --- Pack fixtures with real media ---

function packFixture(t: TestContext) {
  const rootDir = mkdtempSync(path.join(tmpdir(), "reference-review-pack-"));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const project = path.join(rootDir, "public/projects/demo");
  mkdirSync(path.join(project, "pipeline"), { recursive: true });
  writeFileSync(path.join(project, "project.json"), "{}");
  const png = (file: string, colour: string, size: string) => {
    const run = spawnSync(
      "ffmpeg",
      ["-v", "error", "-nostdin", "-y", "-f", "lavfi", "-i", `color=c=${colour}:s=${size}`, "-frames:v", "1", file],
      { encoding: "utf8" },
    );
    assert.equal(run.status, 0, run.stderr);
  };
  mkdirSync(path.join(rootDir, "src"));
  png(path.join(rootDir, "src/face.png"), "0x336699", "512x512");
  const face = importAsset({
    rootDir,
    projectId: "demo",
    sourceFile: path.join(rootDir, "src/face.png"),
    provenance: { origin: "provider", tool: "offline-fixture", referenceAssetIds: [] },
  }).asset;
  const spec = (id: string) => ({
    schemaVersion: 1,
    id,
    shotId: "s01",
    endpoint: SEEDANCE,
    profileFamily: "seedance-2.5",
    attachments: [
      {
        requirementKey: "hero-identity",
        source: { assetId: face.id },
        slot: "images",
        order: 1,
        roleSentence: "the face and hair of Mara",
      },
    ],
    prompt: { action: "Mara walks through the market." },
    params: {},
    audioPolicy: "native",
  });
  const prepare = (id: string) => preparePack("demo", spec(id), rootDir);
  const approve = (pack: ReturnType<typeof prepare>) =>
    approvePack(
      "demo",
      pack.spec.id,
      "Yes, use it.",
      {
        packSha256: pack.packSha256,
        reviewer: "fixture reviewer",
        evidence: "Inspected board.html and the attachment at full size.",
        markersVerified: true,
        promptReviewed: true,
        attachments: pack.receipt.attachments.map((a) => ({
          sha256: a.media.sha256,
          requirementKey: a.requirementKey,
          suitable: true,
          evidence: "Shows what its role sentence asks for.",
        })),
      },
      rootDir,
    );
  return { rootDir, project, prepare, approve, png, face };
}

test("finding 4: every fal paid submission applies the no-pack rule (legacy generate-video path)", media, async (t) => {
  const f = packFixture(t);
  const previous = process.cwd();
  const env = process.env.AGENTBROS_REFERENCE_PACKS;
  process.chdir(f.rootDir);
  t.after(() => {
    process.chdir(previous);
    if (env === undefined) delete process.env.AGENTBROS_REFERENCE_PACKS;
    else process.env.AGENTBROS_REFERENCE_PACKS = env;
  });
  writeBudgetBrief(f.project);
  let submits = 0;
  const provider: JobProvider = {
    submit: async () => ({ requestId: `request-${++submits}` }),
    inspect: async () => ({ state: "running" }),
  };
  // As generate-video calls it: endpoint, input with reference URLs, no request context.
  const options = {
    projectId: "demo",
    endpoint: SEEDANCE,
    model: "fal:seedance-2.5",
    input: { prompt: "Mara walks.", image_urls: ["https://fal.media/files/a.png"], duration: "5" },
    output: "public/projects/demo/assets/videos/shot.mp4",
    mediaKind: "video" as const,
    maxCostUsd: 5,
    operationId: "legacy:1",
    provider,
  };
  process.env.AGENTBROS_REFERENCE_PACKS = "enforce";
  await assert.rejects(executeFalOperation(options), (error: Error & { code?: string }) => {
    assert.equal(error.code, "VALIDATION");
    assert.match(error.message, /without a reference pack/);
    return true;
  });
  await assert.rejects(executeFalOperation({ ...options, dryRun: true }), /without a reference pack/);
  assert.equal(submits, 0);
  assert.equal(existsSync(new OperationStore("demo").file), false, "nothing reserved");
  // Off: the same request is not refused by the rule.
  process.env.AGENTBROS_REFERENCE_PACKS = "off";
  const dry = await executeFalOperation({ ...options, dryRun: true });
  assert.equal(dry.metadata.dryRun, true);
});

test(
  "finding 5: a pack deleted after submit does not strand the job; the output publishes with a warning",
  media,
  async (t) => {
    const f = packFixture(t);
    const pack = f.prepare("stills");
    f.approve(pack);
    const request = JSON.parse(readFileSync(path.join(pack.directory, "request.json"), "utf8")) as {
      provider: "fal";
      endpoint: string;
      input: Record<string, unknown>;
      context: { referencePack: { id: string; sha256: string } };
    };
    const previous = process.cwd();
    process.chdir(f.rootDir);
    t.after(() => process.chdir(previous));
    writeBudgetBrief(f.project);
    f.png(path.join(f.rootDir, "result.png"), "0x22aa44", "320x240");
    const bytes = readFileSync(path.join(f.rootDir, "result.png"));
    const url = "https://v3.fal.media/files/synthetic/result.png";
    let submits = 0;
    let done = false;
    const provider: JobProvider = {
      submit: async () => ({ requestId: `request-${++submits}` }),
      inspect: async () =>
        done ? { state: "completed", result: { images: [{ url, content_type: "image/png" }] } } : { state: "running" },
    };
    const binding = { id: "stills", sha256: pack.packSha256 };
    const options = {
      projectId: "demo",
      endpoint: "fixture/pack",
      model: "fixture/pack",
      input: { prompt: "pack" },
      output: "public/projects/demo/assets/images/shot.png",
      mediaKind: "image" as const,
      maxCostUsd: 0.5,
      operationId: "pack:resume",
      referencePack: binding,
      provider,
      fetch: (async () => new Response(new Uint8Array(bytes))) as typeof fetch,
    };
    const first = await executeFalOperation(options);
    assert.notEqual(first.metadata.state, "published");
    assert.equal(submits, 1);
    const job = new OperationStore("demo").snapshot().jobs["pack:resume"];
    assert.equal(jobSubmitted(job), true);

    // The pack is deleted (or re-prepared) after submit.
    rmSync(pack.directory, { recursive: true, force: true });
    const gateOf = (resuming: boolean) =>
      referencePackGate({
        projectId: "demo",
        raw: request,
        provider: "fal",
        endpoint: request.endpoint,
        input: request.input,
        resuming,
        dryRun: false,
        env: {},
      });
    // A new job is refused; the submitted one resumes with its original binding and a warning.
    code(() => gateOf(false), "STAGE_INCOMPLETE");
    const resumed = gateOf(jobSubmitted(job));
    assert.equal(resumed.executable, true);
    assert.deepEqual({ id: resumed.referencePack!.id, sha256: resumed.referencePack!.sha256 }, binding);
    assert.match(resumed.warnings.join(" "), /changed since this job was submitted/);

    done = true;
    const published = await executeFalOperation(options);
    assert.equal(published.metadata.state, "published", JSON.stringify(published.metadata));
    assert.equal(submits, 1);
    assert.ok(existsSync(path.join(f.rootDir, options.output)));
    assert.match((published.metadata.warnings as string[]).join(" "), /not recorded in pack stills's outputs\.json/);

    // Re-prepared after submit (a new revision: the receipt's createdAt differs): the gate warns, the job publishes,
    // and the output is not recorded against the new revision.
    const second = {
      ...options,
      operationId: "pack:reprepare",
      output: "public/projects/demo/assets/images/shot-2.png",
    };
    done = false;
    const pending = await executeFalOperation(second);
    assert.notEqual(pending.metadata.state, "published");
    const secondJob = new OperationStore("demo").snapshot().jobs["pack:reprepare"];
    rmSync(path.join(f.project, "pipeline/reference-packs/stills"), { recursive: true, force: true });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const reprepared = f.prepare("stills");
    f.approve(reprepared);
    assert.notEqual(reprepared.packSha256, pack.packSha256);
    const warned = gateOf(jobSubmitted(secondJob));
    assert.equal(warned.referencePack!.sha256, pack.packSha256);
    assert.match(warned.warnings.join(" "), /changed since this job was submitted/);
    done = true;
    const republished = await executeFalOperation(second);
    assert.equal(republished.metadata.state, "published", JSON.stringify(republished.metadata));
    assert.equal(submits, 2);
    assert.match((republished.metadata.warnings as string[]).join(" "), /is now revision/);
    assert.equal(readPackOutputs("demo", "stills", f.rootDir), undefined);
  },
);

test("finding 6: metadata.referencePack without the request's context.referencePack is refused", media, (t) => {
  const f = packFixture(t);
  const previous = process.cwd();
  process.chdir(f.rootDir);
  t.after(() => process.chdir(previous));
  const asset = AssetSpecSchema.parse({
    id: "shot",
    kind: "ai-video",
    source: "fal-model",
    targetPath: "assets/videos/shot.mp4",
    status: "pending",
    metadata: {
      operationRequest: {
        provider: "fal",
        endpoint: SEEDANCE,
        input: { prompt: "Mara walks.", image_urls: [`asset://sha256/${f.face.hash}`] },
      },
      referencePack: { id: "stills", sha256: "a".repeat(64) },
    },
  });
  code(
    () => prepareModernAssetDispatch(asset, "demo", path.resolve("public/projects/demo/assets/videos/shot.mp4")),
    "VALIDATION",
    /has no context\.referencePack/,
  );
});

test("finding 8: a reserved job (no provider request) does not bypass the pack approval", media, (t) => {
  const f = packFixture(t);
  const pack = f.prepare("stills");
  const request = JSON.parse(readFileSync(path.join(pack.directory, "request.json"), "utf8")) as {
    endpoint: string;
    input: Record<string, unknown>;
  };
  code(
    () =>
      referencePackGate({
        projectId: "demo",
        raw: request,
        provider: "fal",
        endpoint: request.endpoint,
        input: request.input,
        resuming: jobSubmitted({ state: "reserved" }),
        dryRun: false,
        rootDir: f.rootDir,
        env: {},
      }),
    "STAGE_INCOMPLETE",
    /not approved/,
  );
});

test("as-pack verifies parity before writing: a mismatch leaves no pack", media, (t) => {
  const f = genjutsuFixture(t);
  const data = prepareModel("demo", f.spec("object-swap"), f.rootDir);
  const file = preparationFile("demo", data.receipt.id, "request.json", f.rootDir);
  const stored = JSON.parse(readFileSync(file, "utf8")) as { input: Record<string, unknown> };
  chmodSync(file, 0o644);
  writeFileSync(file, JSON.stringify({ ...stored, input: { ...stored.input, prompt: "Something else." } }));
  code(() => preparationAsPack("demo", data.receipt.id, f.rootDir), "VALIDATION", /does not compile/);
  const directory = path.join(
    f.rootDir,
    "public/projects/demo/pipeline/reference-packs",
    preparationPackId(data.receipt.id),
  );
  assert.equal(existsSync(path.join(directory, "receipt.json")), false);
  assert.equal(existsSync(path.join(directory, "spec.json")), false);
  assert.equal(readPackOutputs("demo", preparationPackId(data.receipt.id), f.rootDir), undefined);
});
