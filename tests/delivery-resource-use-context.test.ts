import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, realpathSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { DeliveryRequestSchema, type RenderIdentity } from "../src/types/delivery";
import { AssetRecordSchema } from "../src/types/assets";
import { ResourceCandidateSchema } from "../src/types/resources";
import { hashFile } from "../src/lib/assets/registry";
import { rightsFromLicence } from "../src/lib/resources/rights";
import { ResourceService } from "../src/lib/resources/service";
import { deliveryUseContext } from "../src/lib/delivery/use-context";
import { reviewRights, type Finding } from "../src/lib/delivery/reviews";
import { captureDeliverySnapshot, checkDelivery } from "../src/lib/delivery/service";
import { runProductAdWorkflow } from "../src/lib/workflows/product-ad";
import { productAdFixture } from "./workflow-product-ad-fixtures";

const now = "2026-10-12T00:00:00Z";
const hash = "0".repeat(64);
const baseRequest = {
  version: 1 as const,
  projectId: "demo",
  formats: ["landscape" as const],
  variants: ["captioned" as const],
  placements: ["youtube"],
  approvalMode: "manual" as const,
  loudness: { targetLufs: -16, toleranceLu: 1, maxTruePeakDb: -1, audioRequired: true },
};
function fixture(t: test.TestContext) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "delivery-use-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, "public/projects/demo");
  mkdirSync(path.join(project, "pipeline"), { recursive: true });
  writeFileSync(
    path.join(project, "project.json"),
    JSON.stringify({
      name: "Usage fixture",
      formats: ["landscape"],
      productName: "Local",
      colors: {},
      voiceoverEnabled: false,
      musicVolume: 0,
      scenes: [{ id: "hook", text: "Hello", visualType: "title", headline: "Hello", durationInFrames: 30 }],
    }),
  );
  const request = DeliveryRequestSchema.parse(baseRequest);
  // Structural identity fixture only; no rendered output or human approval is asserted.
  const identity: RenderIdentity = {
    version: 1,
    projectId: "demo",
    format: "landscape",
    captions: "on",
    compositionId: "demo-landscape",
    durationInFrames: 30,
    propsHash: hash,
    sourceSnapshotHash: hash,
    storyHash: hash,
    editRevision: null,
    sources: [],
  };
  return { root, project, request, identity };
}
function marker(f: ReturnType<typeof fixture>, workflow: "product-ad" | "education" = "product-ad") {
  const file = path.join(f.project, "pipeline/workflow-render.json");
  writeFileSync(file, JSON.stringify({ version: 1, projectId: "demo", workflow, timelineRequired: true }));
  f.identity.sources.push({
    path: "public/projects/demo/pipeline/workflow-render.json",
    sha256: hashFile(file),
    role: "creative",
  });
  return file;
}
function asset(f: ReturnType<typeof fixture>, licence = "Pexels") {
  const directory = path.join(f.project, "assets/imported");
  mkdirSync(directory, { recursive: true });
  const file = path.join(directory, "temp.png");
  writeFileSync(file, "Local exact-byte rights fixture, not an image render");
  const sha256 = hashFile(file),
    original = `projects/demo/assets/imported/${sha256}.png`;
  writeFileSync(path.join(f.root, "public", original), readFileSync(file));
  rmSync(file);
  const record = AssetRecordSchema.parse({
    schemaVersion: 1,
    id: `sha256:${sha256}`,
    hash: sha256,
    revision: 1,
    createdAt: now,
    status: "candidate",
    kind: "image",
    files: { original, bytes: readFileSync(path.join(f.root, "public", original)).length, mime: "image/png" },
    media: { width: 1, height: 1, codec: "png", hasAudio: false },
    provenance: { origin: "manual" },
    rights: {
      licence,
      commercialAllowed: true,
      attributionRequired: true,
      attribution: "Local creator/source credit",
      sourceUrl: "https://example.invalid/original",
      checkedAsOf: now,
    },
  });
  writeFileSync(
    path.join(f.project, "pipeline/asset-registry.json"),
    JSON.stringify({ schemaVersion: 1, revision: 1, assets: [record] }),
  );
  f.identity.sources.push({ path: `public/${original}`, sha256, role: "asset" });
  return { sha256, original };
}
function resource(f: ReturnType<typeof fixture>, media: ReturnType<typeof asset>, provider: "nasa" | "pexels") {
  const sourceUrl = "https://example.invalid/original";
  const rights = rightsFromLicence({
    licence: provider === "nasa" ? "CC0" : "Pexels",
    title: "Local fixture",
    author: "Local author",
    sourceUrl,
    checkedAsOf: now,
    verifiedAtSource: true,
  });
  if (provider === "nasa") rights.attributionText = `NASA source: ${sourceUrl}`;
  const candidate = ResourceCandidateSchema.parse({
    id: "fixture",
    provider,
    kind: "image",
    title: "Local fixture",
    sourceUrl,
    author: "Local author",
    acquisition: "manual",
    media: {},
    rights,
    cost: { status: "unknown" },
  });
  mkdirSync(path.join(f.project, "pipeline/resources"), { recursive: true });
  writeFileSync(
    path.join(f.project, "pipeline/resources/fixture.json"),
    JSON.stringify({ file: media.original, resource: candidate }),
  );
}
function human(sha256: string) {
  return {
    reviewedBy: "Named local test declaration",
    reviewedAt: now,
    evidence: "Synthetic current-byte rights declaration; no real permission claimed",
    sha256,
    licence: "separate-declared-permission",
    sourceUrl: "manual:fixture",
    commercialAllowed: true,
    modifiedAllowed: true,
    placements: ["youtube"],
    attribution: "Declared credit",
  };
}
function rights(f: ReturnType<typeof fixture>) {
  const findings: Finding[] = [];
  const records = reviewRights(f.root, f.request, [f.identity], findings);
  return { findings, records };
}

test("legacy omitted usage defaults false; strict request/review flags reject invented fields and strings", () => {
  const parsed = DeliveryRequestSchema.parse(baseRequest);
  assert.deepEqual(parsed.usage, { advertising: false, endorsement: false, standaloneResale: false });
  for (const usage of [{ advertising: "true" }, { musicPermission: true }])
    assert.equal(DeliveryRequestSchema.safeParse({ ...baseRequest, usage }).success, false);
  assert.equal(
    DeliveryRequestSchema.safeParse({
      ...baseRequest,
      rightsReviews: [{ ...human(hash), usage: { impliedPermission: true } }],
    }).success,
    false,
  );
});
test("requested vs effective context is stable, placement/commercial/use bound and visible without assets", (t) => {
  const f = fixture(t),
    first = deliveryUseContext(f.root, f.request, [f.identity]);
  assert.equal(first.derivation, null);
  assert.deepEqual(first.requestedUsage, first.effectiveUsage);
  assert.equal(deliveryUseContext(f.root, f.request, [f.identity]).contextSha256, first.contextSha256);
  for (const update of [{ commercial: false }, { placements: ["tiktok"] }, { usage: { endorsement: true } }]) {
    const changed = DeliveryRequestSchema.parse({ ...f.request, ...update });
    assert.notEqual(deliveryUseContext(f.root, changed, [f.identity]).contextSha256, first.contextSha256);
  }
});
test("pinned product-ad advertising cannot be downgraded by omission/false; education does not imply advertising", (t) => {
  const f = fixture(t);
  marker(f);
  const use = deliveryUseContext(f.root, f.request, [f.identity]);
  assert.equal(use.requestedUsage.advertising, false);
  assert.equal(use.effectiveUsage.advertising, true);
  assert.equal(use.derivation!.sha256, f.identity.sources[0]!.sha256);
  f.identity.sources = [];
  marker(f, "education");
  assert.equal(deliveryUseContext(f.root, f.request, [f.identity]).effectiveUsage.advertising, false);
});
for (const failure of [
  "changed",
  "missing",
  "unpinned",
  "one-unpinned",
  "duplicate",
  "wrong-project",
  "malformed",
  "alias",
  "oversized",
] as const)
  test(`workflow context refuses ${failure} marker evidence`, (t) => {
    const f = fixture(t),
      file = marker(f);
    let identities = [f.identity];
    if (failure === "changed") writeFileSync(file, readFileSync(file, "utf8") + " ");
    if (failure === "missing") rmSync(file);
    if (failure === "unpinned") f.identity.sources = [];
    if (failure === "one-unpinned") identities = [f.identity, { ...f.identity, format: "square", sources: [] }];
    if (failure === "duplicate") f.identity.sources.push({ ...f.identity.sources[0]! });
    if (failure === "wrong-project" || failure === "malformed") {
      writeFileSync(
        file,
        JSON.stringify({
          version: 1,
          workflow: "product-ad",
          projectId: failure === "wrong-project" ? "other" : "demo",
          timelineRequired: true,
          ...(failure === "malformed" ? { forged: true } : {}),
        }),
      );
      f.identity.sources[0]!.sha256 = hashFile(file);
    }
    if (failure === "alias") {
      const other = path.join(f.project, "pipeline/alias.json");
      writeFileSync(other, readFileSync(file));
      rmSync(file);
      symlinkSync(other, file);
    }
    if (failure === "oversized") {
      writeFileSync(file, " ".repeat(4097));
      f.identity.sources[0]!.sha256 = hashFile(file);
    }
    assert.throws(() => deliveryUseContext(f.root, f.request, identities));
  });
for (const provider of ["nasa", "pexels"] as const)
  test(`${provider} special use reaches existing resource blockers; generic override insufficient`, (t) => {
    const f = fixture(t),
      media = asset(f);
    resource(f, media, provider);
    f.request.usage[provider === "nasa" ? "advertising" : "endorsement"] = true;
    assert.equal(rights(f).records[0]!.allowed, false);
    f.request.rightsReviews = [human(media.sha256)];
    assert.equal(rights(f).records[0]!.allowed, false);
    f.request.rightsReviews[0]!.usage = { ...f.request.usage };
    const result = rights(f);
    assert.equal(result.records[0]!.allowed, true);
    assert.ok(result.findings.some((item) => item.code === "HUMAN_DECLARED_RIGHTS"));
    assert.deepEqual(result.records[0]!.useContext, deliveryUseContext(f.root, f.request, [f.identity]));
  });
for (const specialUse of ["endorsement", "standaloneResale"] as const)
  test(`receipt-free imported Pexels keeps ${specialUse} restriction`, (t) => {
    const f = fixture(t);
    asset(f);
    assert.equal(rights(f).records[0]!.allowed, true);
    f.request.usage[specialUse] = true;
    const result = rights(f);
    assert.equal(result.records[0]!.allowed, false);
    assert.match(result.findings[0]!.message, /Pexels.*without an original resource receipt/);
  });
test("all special uses need explicit true coverage; stale hash/placement/permission remain blockers", (t) => {
  const f = fixture(t),
    media = asset(f, "unknown");
  f.request.usage = { advertising: true, endorsement: true, standaloneResale: true };
  const review = { ...human(media.sha256), usage: { ...f.request.usage } };
  f.request.rightsReviews = [review];
  assert.equal(rights(f).records[0]!.allowed, true);
  for (const key of ["advertising", "endorsement", "standaloneResale"] as const) {
    review.usage[key] = false;
    assert.equal(rights(f).records[0]!.allowed, false);
    review.usage[key] = true;
  }
  review.sha256 = hash;
  assert.equal(rights(f).records[0]!.allowed, false);
  review.sha256 = media.sha256;
  review.placements = ["tiktok"];
  assert.equal(rights(f).records[0]!.allowed, false);
  review.placements = ["youtube"];
  review.commercialAllowed = false;
  assert.equal(rights(f).records[0]!.allowed, false);
});
test("ordinary legacy generic human review remains accepted as a declaration", (t) => {
  const f = fixture(t),
    media = asset(f, "unknown");
  f.request.rightsReviews = [human(media.sha256)];
  assert.equal(rights(f).records[0]!.allowed, true);
});
test("genuine local NASA stock import retains all use restrictions and source credit when receipt is removed", async (t) => {
  const f = fixture(t),
    source = path.join(f.root, "original.png");
  const bytes = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=",
    "base64",
  );
  writeFileSync(source, bytes);
  const sourceUrl = "https://example.invalid/original-source";
  const candidate = ResourceCandidateSchema.parse({
    id: "declared-nasa-fixture",
    provider: "nasa",
    kind: "image",
    title: "Synthetic fixture",
    sourceUrl,
    author: "NASA fixture credit",
    acquisition: "manual",
    media: {},
    rights: {
      ...rightsFromLicence({
        licence: "CC0",
        title: "Fixture",
        author: "NASA fixture credit",
        sourceUrl,
        verifiedAtSource: true,
        checkedAsOf: now,
      }),
      attributionRequired: true,
      attributionText: `NASA source: ${sourceUrl}`,
    },
    cost: { status: "unknown" },
  });
  const service = new ResourceService({
    fetch: async () => {
      throw new Error("No network authorized");
    },
  });
  const imported = await service.acquire(candidate, {
    projectId: "demo",
    rootDir: f.root,
    sourceFile: source,
    usage: { commercial: true, placements: ["youtube"] },
  });
  assert.equal(imported.asset.provenance.origin, "stock");
  assert.equal(imported.asset.provenance.tool, "nasa:original:declared-nasa-fixture");
  f.identity.sources.push({
    path: `public/${imported.asset.files.original}`,
    sha256: imported.asset.hash,
    role: "asset",
  });
  assert.equal(rights(f).records[0]!.allowed, true);
  rmSync(imported.resourceReceipt);
  assert.equal(rights(f).records[0]!.allowed, true);
  for (const key of ["advertising", "endorsement", "standaloneResale"] as const) {
    f.request.usage[key] = true;
    assert.equal(rights(f).records[0]!.allowed, false);
    f.request.rightsReviews = [human(imported.asset.hash)];
    assert.equal(rights(f).records[0]!.allowed, false);
    f.request.rightsReviews[0]!.usage = { ...f.request.usage };
    assert.equal(rights(f).records[0]!.allowed, true);
    f.request.rightsReviews = [];
    f.request.usage[key] = false;
  }
  const registryFile = path.join(f.project, "pipeline/asset-registry.json"),
    registry = JSON.parse(readFileSync(registryFile, "utf8"));
  for (const attribution of [
    "",
    "NASA credit without original page",
    `Original page without NASA credit: ${sourceUrl}`.replace("NASA", "agency"),
  ]) {
    registry.assets[0].rights.attribution = attribution;
    writeFileSync(registryFile, JSON.stringify(registry));
    assert.equal(rights(f).records[0]!.allowed, false);
  }
  registry.assets[0].rights.attribution = candidate.rights.attributionText;
  registry.assets[0].provenance.tool = "nasa:missing-mode";
  writeFileSync(registryFile, JSON.stringify(registry));
  assert.equal(rights(f).records[0]!.allowed, false);
  assert.deepEqual(readFileSync(source), bytes);
  assert.deepEqual(readFileSync(path.join(f.root, "public", imported.asset.files.original)), bytes);
});
test("pinned product-ad defaults reach NASA advertising blocker", (t) => {
  const f = fixture(t),
    media = asset(f);
  marker(f);
  resource(f, media, "nasa");
  const result = rights(f);
  assert.equal(result.records[0]!.allowed, false);
  assert.match(result.findings[0]!.message, /NASA catalogue route/);
  f.request.rightsReviews = [human(media.sha256)];
  assert.equal(rights(f).records[0]!.allowed, false);
});
test("callers cannot supply an alternate usage hash to bypass a pinned advertising context", (t) => {
  const f = fixture(t);
  marker(f);
  assert.throws(() => reviewRights(f.root, f.request, [f.identity], [], hash), /changed before rights review/);
});
test("real local product-ad create emits advertising metadata and default delivery uses exact captured marker", (t) => {
  const f = fixture(t),
    request = productAdFixture(f.root);
  const result = runProductAdWorkflow(request, { action: "create", rootDir: f.root });
  assert.deepEqual((result.metadata.delivery as { usage: unknown }).usage, {
    advertising: true,
    endorsement: false,
    standaloneResale: false,
  });
  const delivery = DeliveryRequestSchema.parse({ ...baseRequest, projectId: request.projectId, timeline: true });
  const captured = captureDeliverySnapshot(delivery, { rootDir: f.root });
  const use = deliveryUseContext(f.root, delivery, captured.snapshot.identities);
  assert.equal(use.effectiveUsage.advertising, true);
  assert.equal(use.requestedUsage.advertising, false);
  for (const media of request.media) assert.equal(hashFile(media.path), media.sha256);
});
test("delivery refuses workflow marker changed after its initial exact-use review", (t) => {
  const f = fixture(t),
    authored = productAdFixture(f.root);
  runProductAdWorkflow(authored, { action: "create", rootDir: f.root });
  const request = DeliveryRequestSchema.parse({ ...baseRequest, projectId: authored.projectId, timeline: true });
  const captured = captureDeliverySnapshot(request, { rootDir: f.root });
  const file = path.join(f.root, "public/projects", authored.projectId, "pipeline/workflow-render.json");
  const before = readFileSync(file),
    originalRealpath = fs.realpathSync;
  let calls = 0,
    changed = false;
  const mock = t.mock.method(fs, "realpathSync", (input: fs.PathLike) => {
    if (String(input) === file && ++calls === 3) {
      writeFileSync(file, before.toString("utf8") + " ");
      changed = true;
    }
    return originalRealpath(input);
  });
  syncBuiltinESMExports();
  try {
    const result = checkDelivery(request, captured.snapshot, { rootDir: f.root });
    assert.equal(changed, true);
    assert.equal(result.productionReady, false);
    assert.ok(
      result.blockers.some((finding) => finding.code === "RIGHTS_USE_CHANGED"),
      JSON.stringify(result.blockers),
    );
    assert.equal(
      (result.manifest.reviewEvidence.resourceUse as { derivation: { sha256: string } }).derivation.sha256,
      captured.snapshot.identities[0]!.sources.find((source) => source.path.endsWith("/workflow-render.json"))!.sha256,
    );
  } finally {
    mock.mock.restore();
    syncBuiltinESMExports();
    writeFileSync(file, before);
  }
  for (const media of authored.media) assert.equal(hashFile(media.path), media.sha256);
});
test("local delivery manifest persists use context even without assets, and CLI emits one blocked JSON line", (t) => {
  const f = fixture(t);
  f.request.usage.standaloneResale = true;
  const captured = captureDeliverySnapshot(f.request, { rootDir: f.root });
  const result = checkDelivery(f.request, captured.snapshot, { rootDir: f.root });
  assert.equal(result.productionReady, false);
  assert.equal(result.manifest.apiCalls, 0);
  assert.deepEqual(
    result.manifest.reviewEvidence.resourceUse,
    deliveryUseContext(f.root, f.request, captured.snapshot.identities),
  );
  const file = path.join(f.root, "request.json");
  writeFileSync(file, JSON.stringify(f.request));
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR };
  const cli = spawnSync(
    process.execPath,
    [
      path.resolve("node_modules/tsx/dist/cli.mjs"),
      path.resolve("scripts/delivery.ts"),
      "--request",
      file,
      "--snapshot",
      captured.file,
    ],
    { cwd: f.root, env, encoding: "utf8", timeout: 30000 },
  );
  assert.equal(cli.status, 1, cli.stderr);
  assert.equal(cli.stdout.trim().split("\n").length, 1);
  const envelope = JSON.parse(cli.stdout);
  assert.equal(envelope.error, "VALIDATION");
  const manifest = JSON.parse(readFileSync(envelope.outputs[0], "utf8"));
  assert.equal(manifest.reviewEvidence.resourceUse.effectiveUsage.standaloneResale, true);
  assert.equal(manifest.apiCalls, 0);
});
test("actual delivery CLI rejects receipt-free Pexels endorsement despite a generic current-byte review", (t) => {
  const f = fixture(t),
    media = asset(f);
  const configFile = path.join(f.project, "project.json"),
    config = JSON.parse(readFileSync(configFile, "utf8"));
  config.scenes[0].imageUrl = media.original;
  writeFileSync(configFile, JSON.stringify(config));
  f.request.usage.endorsement = true;
  f.request.rightsReviews = [human(media.sha256)];
  const captured = captureDeliverySnapshot(f.request, { rootDir: f.root });
  const file = path.join(f.root, "request.json");
  writeFileSync(file, JSON.stringify(f.request));
  const cli = spawnSync(
    process.execPath,
    [
      path.resolve("node_modules/tsx/dist/cli.mjs"),
      path.resolve("scripts/delivery.ts"),
      "--request",
      file,
      "--snapshot",
      captured.file,
    ],
    {
      cwd: f.root,
      env: { AGENTBROS_NO_DOTENV: "1", PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR },
      encoding: "utf8",
      timeout: 30000,
    },
  );
  assert.equal(cli.status, 1, cli.stderr);
  assert.equal(cli.stdout.trim().split("\n").length, 1);
  const envelope = JSON.parse(cli.stdout);
  assert.equal(envelope.error, "VALIDATION");
  assert.ok(
    envelope.metadata.blockers.some(
      (finding: Finding) => finding.code === "RIGHTS_UNCONFIRMED" && /Pexels/.test(finding.message),
    ),
  );
  const manifest = JSON.parse(readFileSync(envelope.outputs[0], "utf8"));
  assert.equal(manifest.rights[0].allowed, false);
  assert.equal(manifest.rights[0].useContext.effectiveUsage.endorsement, true);
  assert.equal(manifest.rights[0].useContext.contextSha256, manifest.reviewEvidence.resourceUse.contextSha256);
  assert.equal(manifest.apiCalls, 0);
});
