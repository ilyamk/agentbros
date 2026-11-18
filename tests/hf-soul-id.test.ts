import { writeBudgetBrief } from "./helpers/ceiling-grant";
import "./helpers/fal-no-network";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHiggsfieldClient } from "../src/lib/providers/higgsfield/client";
import { createHiggsfieldTrainingProvider } from "../src/lib/jobs/higgsfield-training";
import { executeFalNonMedia } from "../src/lib/jobs/nonmedia";
import { buildFalOperation, validateFalOperationResult } from "../src/lib/providers/fal-operations";
import { quoteInputForPlan } from "../src/lib/providers/fal-quote-input";
import { OperationStore } from "../src/lib/jobs/store";
import { CliErrorObject } from "../src/lib/cli";

const endpoint = "v1/custom-references",
  id = "11111111-1111-4111-8111-111111111111";
const input = {
  name: "Authorised character",
  model_version: "v2",
  input_images: [{ type: "image_url", image_url: "https://example.com/portrait.jpg" }],
};
const request = { provider: "higgsfield" as const, endpoint, input };
const plan = buildFalOperation(request);
const options = {
  providerId: "higgsfield" as const,
  projectId: "demo",
  endpoint,
  model: endpoint,
  input,
  output: "training.json",
  kind: "training" as const,
  operationId: "soul:1",
  maxCostUsd: 1,
  quoteInput: quoteInputForPlan(plan, input),
  validateResult: (result: Record<string, unknown>) => {
    validateFalOperationResult(endpoint, result, "higgsfield");
  },
};
async function fixture(fn: () => Promise<void>) {
  const old = process.cwd(),
    root = mkdtempSync(path.join(tmpdir(), "hf-soul-"));
  process.chdir(root);
  mkdirSync("public/projects/demo", { recursive: true });
  writeFileSync("public/projects/demo/project.json", "{}");
  writeBudgetBrief("public/projects/demo");
  try {
    await fn();
  } finally {
    process.chdir(old);
    rmSync(root, { recursive: true, force: true });
  }
}

test("Soul ID plans as nonmedia training and enforces the documented input schema", () => {
  assert.equal(plan.category, "training");
  assert.equal(plan.transport, "training");
  assert.deepEqual(plan.outputKinds, ["json"]);
  assert.equal(plan.executable, true);
  for (const invalid of [
    { ...input, name: "x".repeat(101) },
    { ...input, model_version: "v3" },
    { ...input, input_images: [] },
    { ...input, input_images: Array(101).fill(input.input_images[0]) },
    { ...input, input_images: [{ type: "image_url" }] },
  ])
    assert.throws(() => buildFalOperation({ ...request, input: invalid }));
  for (const model_version of ["v1", "v2", "cinema"])
    assert.doesNotThrow(() =>
      buildFalOperation({
        ...request,
        input: { ...input, model_version, input_images: Array(100).fill(input.input_images[0]) },
      }),
    );
});

test("fake-fetch training submits once, polls the custom route and publishes an immutable ID manifest", () =>
  fixture(async () => {
    let submits = 0,
      polls = 0;
    const client = createHiggsfieldClient({
      credentials: "offline:secret",
      fetch: async (url, init) => {
        assert.equal((init?.headers as Record<string, string>).Authorization, "Key offline:secret");
        assert.equal((init?.headers as Record<string, string>)["Idempotency-Key"], undefined);
        if (init?.method === "POST") {
          submits++;
          assert.equal(String(url), "https://api.higgsfield.ai/v1/custom-references");
          assert.deepEqual(JSON.parse(String(init.body)), input);
          return Response.json({ id, status: "not_ready" });
        }
        assert.equal(String(url), `https://api.higgsfield.ai/v1/custom-references/${id}`);
        polls++;
        return Response.json({ id, status: polls === 1 ? "in_progress" : "completed" });
      },
    });
    const opts = { ...options, provider: createHiggsfieldTrainingProvider(client) };
    const first = await executeFalNonMedia(opts);
    assert.equal(first.metadata.state, "running");
    assert.deepEqual(first.outputs, []);
    assert.equal(first.metadata.customReferenceId, undefined);
    const completed = await executeFalNonMedia(opts);
    assert.equal(completed.metadata.state, "published");
    assert.equal(completed.metadata.customReferenceId, id);
    const manifest = JSON.parse(readFileSync(completed.outputs[0]!, "utf8"));
    assert.equal(manifest.kind, "training");
    assert.equal(manifest.customReferenceId, id);
    assert.deepEqual(manifest.artifacts, []);
    assert.equal(manifest.provenance.provider, "higgsfield");
    assert.equal(manifest.provenance.endpoint, endpoint);
    assert.equal(manifest.provenance.providerRequestId, id);
    assert.deepEqual((await executeFalNonMedia(opts)).outputs, completed.outputs);
    assert.equal(submits, 1);
    assert.equal(polls, 2);
    assert.equal(new OperationStore("demo").snapshot().jobs["soul:1"].provider, "higgsfield");
    writeFileSync(completed.outputs[0]!, "tampered");
    await assert.rejects(executeFalNonMedia(opts), /changed/);
    assert.equal(submits, 1);
  }));

for (const status of ["not_ready", "queued", "in_progress", "completed", "failed"] as const) {
  test(`Soul ID status ${status} maps without inventing refunds`, async () => {
    const provider = createHiggsfieldTrainingProvider(
      createHiggsfieldClient({
        credentials: "offline:secret",
        fetch: async () => Response.json({ id, status, fail_reason: "fixture" }),
      }),
    );
    const result = await provider.inspect(endpoint, id);
    assert.equal(result.state, status === "in_progress" ? "running" : status === "not_ready" ? "queued" : status);
    if (result.state === "failed") assert.equal(result.refunded, undefined);
  });
}

test("unknown training price needs a positive bound, dry-run stays offline", () =>
  fixture(async () => {
    let calls = 0;
    const provider = createHiggsfieldTrainingProvider(
      createHiggsfieldClient({
        credentials: "offline:secret",
        fetch: async () => {
          calls++;
          throw new Error("must not submit");
        },
      }),
    );
    assert.equal(
      (await executeFalNonMedia({ ...options, maxCostUsd: undefined, dryRun: true, provider })).metadata.executable,
      false,
    );
    await assert.rejects(executeFalNonMedia({ ...options, maxCostUsd: undefined, provider }), /Unknown price/);
    await assert.rejects(executeFalNonMedia({ ...options, maxCostUsd: 0, provider }), /positive/);
    assert.equal(calls, 0);
  }));

test("ambiguous Soul ID submit remains blocked across resumes and retains liability", () =>
  fixture(async () => {
    let calls = 0;
    const provider = createHiggsfieldTrainingProvider(
      createHiggsfieldClient({
        credentials: "offline:secret",
        fetch: async () => {
          calls++;
          throw new Error("lost response after acceptance");
        },
      }),
    );
    for (let i = 0; i < 2; i++) {
      const result = await executeFalNonMedia({ ...options, provider });
      assert.equal(result.metadata.state, "unknown");
      assert.deepEqual(result.outputs, []);
      assert.equal(result.metadata.nextAction, "reconcile-provider-request");
    }
    assert.equal(calls, 1);
    assert.equal(new OperationStore("demo").summary().reservedUsd, 1);
  }));

test("custom reference errors, route checks and ID mismatches fail safely", async () => {
  const client = createHiggsfieldClient({
    credentials: "offline:secret",
    fetch: async () => Response.json({ detail: "capacity" }, { status: 429, headers: { "Retry-After": "2" } }),
  });
  await assert.rejects(
    client.createCustomReference(input),
    (error: unknown) => error instanceof CliErrorObject && error.code === "RATE_LIMIT" && error.retryAfterMs === 2000,
  );
  assert.throws(() => client.customReference("../escape"), /Invalid/);
  const provider = createHiggsfieldTrainingProvider(
    createHiggsfieldClient({
      credentials: "offline:secret",
      fetch: async () => Response.json({ id: "other", status: "completed" }),
    }),
  );
  await assert.rejects(provider.inspect(endpoint, id), /different custom reference/);
  await assert.rejects(provider.submit("wrong/endpoint", input), /requires v1/);
});

test("generate:model dry-run routes Soul ID to nonmedia training without a key", () => {
  const root = mkdtempSync(path.join(tmpdir(), "hf-soul-cli-"));
  try {
    const file = path.join(root, "request.json");
    writeFileSync(file, JSON.stringify(request));
    const child = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "scripts/generate-model.ts",
        "--request",
        file,
        "--output",
        path.join(root, "result.json"),
        "--dry-run",
        "--max-cost-usd",
        "1",
      ],
      { encoding: "utf8", env: { ...process.env, HIGGSFIELD_API_KEY: "" } },
    );
    assert.equal(child.status, 0, child.stdout + child.stderr);
    const result = JSON.parse(child.stdout.trim());
    assert.equal(result.metadata.kind, "training");
    assert.equal(result.metadata.plan.transport, "training");
    assert.equal(result.metadata.executable, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Soul ID rejects local, imported and data image references before schema length obscures the cause", () => {
  for (const image_url of [
    "/tmp/portrait.jpg",
    "asset://sha256:abc",
    "data:image/png;base64,AA==",
    `data:image/png;base64,${"A".repeat(3000)}`,
  ])
    assert.throws(
      () => buildFalOperation({ ...request, input: { ...input, input_images: [{ type: "image_url", image_url }] } }),
      /requires public HTTP\(S\)/,
    );
});

test("confirmed HTTP 429 admission rejection surfaces Retry-After and permits the same operation to resume", () =>
  fixture(async () => {
    let calls = 0;
    const provider = createHiggsfieldTrainingProvider(
      createHiggsfieldClient({
        credentials: "offline:secret",
        fetch: async (_url, init) => {
          if (init?.method === "POST" && ++calls === 1)
            return Response.json(
              { detail: "training capacity reached" },
              { status: 429, headers: { "Retry-After": "0" } },
            );
          return Response.json({ id, status: "completed" });
        },
      }),
    );
    await assert.rejects(
      executeFalNonMedia({ ...options, provider }),
      (error: unknown) => error instanceof CliErrorObject && error.code === "RATE_LIMIT" && error.retryAfterMs === 0,
    );
    const store = new OperationStore("demo"),
      rejected = store.snapshot().jobs["soul:1"];
    assert.equal(rejected.state, "reserved");
    assert.equal(rejected.paidAttempts, 0);
    assert.equal(rejected.providerRequestId, undefined);
    assert.equal((await executeFalNonMedia({ ...options, provider })).metadata.state, "published");
    assert.equal(calls, 2);
    assert.equal(store.snapshot().jobs["soul:1"].paidAttempts, 1);
  }));
