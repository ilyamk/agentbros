import test from "node:test";
import assert from "node:assert/strict";
import {
  closeSync,
  existsSync,
  ftruncateSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { readWorkflowRequest } from "../src/lib/workflows/dispatch";
import { productAdFixture } from "./workflow-product-ad-fixtures";
import { captureDeliverySnapshot } from "../src/lib/delivery/service";
import { reviewClaims } from "../src/lib/delivery/reviews";
import { DeliveryRequestSchema } from "../src/types/delivery";
import { COMMANDS } from "../src/mcp/catalog";
import { invokeCommand, prepareCommand } from "../src/mcp/bridge";

const repo = path.resolve(import.meta.dirname, "..");
function fixture(t: test.TestContext) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "workflow request ")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
test("workflow request bounds sparse files before allocation, rejects symlink and scoped originals outside root", (t) => {
  const root = fixture(t),
    outside = fixture(t),
    request = path.join(root, "request.json");
  writeFileSync(request, '{"topic":"Тест","source":"local original"}');
  assert.deepEqual(readWorkflowRequest(request, root), { topic: "Тест", source: "local original" });
  symlinkSync(request, path.join(root, "alias.json"));
  assert.throws(() => readWorkflowRequest(path.join(root, "alias.json")), /ELOOP|symbolic/i);
  writeFileSync(path.join(outside, "request.json"), "{}");
  assert.throws(() => readWorkflowRequest(path.join(outside, "request.json"), root), /escapes/i);
  const fd = openSync(path.join(root, "large.json"), "wx");
  try {
    ftruncateSync(fd, 512 * 1024 * 1024);
  } finally {
    closeSync(fd);
  }
  assert.throws(() => readWorkflowRequest(path.join(root, "large.json")), /8 MiB/);
  writeFileSync(path.join(root, "empty.json"), "");
  assert.throws(() => readWorkflowRequest(path.join(root, "empty.json")), /regular JSON/);
});
test("workflow CLI discovery emits one envelope and invalid caller input leaves no project", (t) => {
  const root = fixture(t);
  const runner = path.join(repo, "node_modules/tsx/dist/cli.mjs");
  const command = (args: string[]) =>
    spawnSync(process.execPath, [runner, path.join(repo, "scripts/video-workflow.ts"), ...args], {
      cwd: root,
      encoding: "utf8",
    });
  const listed = command(["--action=list"]);
  assert.equal(listed.status, 0, listed.stderr);
  assert.equal(listed.stdout.trim().split("\n").length, 1);
  const envelope = JSON.parse(listed.stdout);
  assert.equal(envelope.ok, true);
  assert.equal(envelope.metadata.workflows.length, 4);
  assert.equal(envelope.metadata.apiCalls, 0);
  assert.equal(envelope.metadata.apiSpendUsd, 0);
  const missing = command(["--scenario=product-ad", "--action=create"]);
  assert.equal(missing.status, 1);
  assert.equal(JSON.parse(missing.stdout).error, "VALIDATION");
  writeFileSync(path.join(root, "invalid.json"), "{broken");
  const invalid = command(["--scenario=education", "--request=invalid.json", "--action=create", "--dry-run"]);
  assert.equal(invalid.status, 1);
  assert.equal(JSON.parse(invalid.stdout).error, "VALIDATION");
  assert.equal(existsSync(path.join(root, "public")), false);
});
test("MCP workflow launcher owns nested path boundary and rejects manifest creation in single-project authority", (t) => {
  const root = fixture(t);
  mkdirSync(path.join(root, "public/projects/demo"), { recursive: true });
  writeFileSync(path.join(root, "request.json"), "{}");
  const definition = COMMANDS.find((command) => command.name === "video_workflow")!;
  const options = { root, codeRoot: repo, allowPaid: false };
  const plan = prepareCommand(
    definition,
    { scenario: "shorts-series", request: "request.json", action: "create", "dry-run": true },
    options,
  );
  assert.equal(plan.flags["scope-root"], root);
  assert.equal(plan.flags.request, path.join(root, "request.json"));
  assert.ok(plan.argv.includes("--dry-run=true"));
  assert.throws(
    () => prepareCommand(definition, { action: "list" }, { ...options, projectScope: "demo" }),
    /single-project scope/,
  );
  assert.throws(() => prepareCommand(definition, { request: "request.json", "scope-root": "/" }, options));
  assert.throws(() => prepareCommand(definition, { scenario: "shell", action: "create" }, options));
});

test("actual workflow CLI dry-run and MCP create produce a snapshot with mandatory source-bound factual review", async (t) => {
  const root = fixture(t),
    input = productAdFixture(root),
    requestFile = path.join(root, "advertisement.json");
  writeFileSync(requestFile, JSON.stringify(input));
  const cli = spawnSync(
    process.execPath,
    [
      path.join(repo, "node_modules/tsx/dist/cli.mjs"),
      path.join(repo, "scripts/video-workflow.ts"),
      "--scenario=product-ad",
      "--request=advertisement.json",
      "--action=create",
      "--dry-run",
    ],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(cli.status, 0, cli.stderr);
  const planned = JSON.parse(cli.stdout);
  assert.equal(planned.metadata.action, "plan");
  assert.deepEqual(planned.outputs, []);
  assert.equal(existsSync(path.join(root, "public")), false);
  const created = await invokeCommand(
    COMMANDS.find((command) => command.name === "video_workflow")!,
    { scenario: "product-ad", request: "advertisement.json", action: "create" },
    { root, codeRoot: repo, allowPaid: false, stderr: () => {} },
  );
  assert.equal(created.ok, true, created.message ?? "Workflow creation failed");
  assert.equal((created.metadata as Record<string, unknown>).apiSpendUsd, 0);
  const request = DeliveryRequestSchema.parse({
    version: 1,
    projectId: input.projectId,
    mode: "draft",
    formats: ["vertical", "square", "landscape"],
    variants: ["clean", "captioned"],
    timeline: true,
    placements: ["local-test"],
    commercial: false,
    loudness: { targetLufs: -16, toleranceLu: 5, maxTruePeakDb: -1, audioRequired: true },
  });
  const { snapshot } = captureDeliverySnapshot(request, { rootDir: root });
  assert.equal(snapshot.identities.length, 6);
  assert.ok(snapshot.identities.every((identity) => identity.durationInFrames === 150));
  assert.ok(snapshot.identities.every((identity) => identity.sources.some((source) => source.role === "asset")));
  assert.ok(
    snapshot.identities.every((identity) => !identity.sources.some((source) => source.path.endsWith("/music/bg.mp3"))),
  );
  const findings: Parameters<typeof reviewClaims>[3] = [];
  reviewClaims(root, request, snapshot, findings);
  assert.ok(findings.some((finding) => finding.code === "CLAIMS_REVIEW_REQUIRED"));
  const authored = JSON.parse(
    await (
      await import("node:fs/promises")
    ).readFile(path.join(root, "public/projects", input.projectId, "pipeline/product-ad-evidence.json"), "utf8"),
  );
  const reviewed = DeliveryRequestSchema.parse({
    ...request,
    declaredClaims: authored.delivery.declaredClaims,
    claimsReview: {
      reviewedBy: "SYNTHETIC TEST ONLY",
      reviewedAt: "2026-10-11T00:00:00Z",
      evidence: "Local fixture source review; no production consent",
      storyHash: snapshot.identities[0].storyHash,
      claims: authored.delivery.declaredClaims.map((claim: { id: string }) => ({
        id: claim.id,
        sourceUrl: "https://example.invalid/synthetic-evidence",
        supported: true,
        note: "Synthetic indicator behavior only",
      })),
    },
  });
  const checked: Parameters<typeof reviewClaims>[3] = [];
  reviewClaims(root, reviewed, snapshot, checked);
  assert.ok(!checked.some((finding) => finding.severity === "error"), JSON.stringify(checked));
});
