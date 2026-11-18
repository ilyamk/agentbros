import { USER_GRANT } from "./helpers/ceiling-grant";
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { canonicalRequestBody, generationRequestBody } from "../src/lib/jobs/request-body";
import { canonicalInputIdentity, paidInputIdentity, resolveOperationIdentity } from "../src/lib/jobs/identity";
import { generationInputHash, runGenerationStep, type JobProvider } from "../src/lib/jobs/runner";
import { synchronousPaidRequest } from "../src/lib/jobs/synchronous";
import { OperationStore } from "../src/lib/jobs/store";
import { executeVoiceManagement } from "../src/lib/elevenlabs/voices";
import { logicalJson, projectOutput, regularInput } from "../src/lib/elevenlabs/files";
import { VoiceManagementRequestSchema } from "../src/types/elevenlabs";

const quote = {
  currency: "USD" as const,
  lowUsd: 1,
  expectedUsd: 1,
  highUsd: 1,
  bounded: true as const,
  source: "fixture",
  asOf: "2026-11-16",
  confidence: "user-bound" as const,
};
const endpoint = "fixture/model",
  assetId = "output";
const input = { meta: { "\u00e9": 1, "e\u0301": 2, a: 3, Z: 4 } };
const reversed = { meta: { Z: 4, a: 3, "e\u0301": 2, "\u00e9": 1 } };
const id = (hash: string) => `fixture:${createHash("sha256").update(hash).digest("hex").slice(0, 40)}`;
function fixture(t: test.TestContext) {
  const directory = mkdtempSync(path.join(tmpdir(), "job-identity-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const store = new OperationStore("identity", { directory });
  store.configure({ ceilingUsd: 10, maxJobUsd: 2, repairReserveFraction: 0 }, USER_GRANT);
  return {
    store,
    directory,
    resolve: (value: Record<string, unknown>, operationId?: string) =>
      resolveOperationIdentity({ input: value, operationId, store, provider: "fixture", endpoint, assetId, id }),
  };
}
const operation = (operationId: string) => ({ operationId, provider: "fixture", endpoint, assetId, quote });

test("V2 preserves distinct Unicode keys and is independent of field order and locale", (t) => {
  assert.deepEqual(canonicalInputIdentity(input), canonicalInputIdentity(reversed));
  assert.notEqual(canonicalInputIdentity({ "\u00e9": 1 }).sha256, canonicalInputIdentity({ "e\u0301": 1 }).sha256);
  assert.equal(canonicalRequestBody({ b: [null, 1, true], a: "text" }), '{"a":"text","b":[null,1,true]}');
  assert.equal(generationRequestBody({ b: 2, a: 1 }), '{"a":1,"b":2}', "legacy serialisation remains available");
  const { directory } = fixture(t),
    script = path.join(directory, "locale.ts");
  writeFileSync(
    script,
    `import { canonicalInputIdentity } from ${JSON.stringify(path.resolve("src/lib/jobs/identity.ts"))}; console.log(JSON.stringify(canonicalInputIdentity(${JSON.stringify(input)})));`,
  );
  const results = ["en_US.UTF-8", "sv_SE.UTF-8"].map((locale) => {
    const child = spawnSync(process.execPath, [path.resolve("node_modules/tsx/dist/cli.mjs"), script], {
      encoding: "utf8",
      timeout: 20000,
      env: { AGENTBROS_NO_DOTENV: "1", PATH: process.env.PATH, LANG: locale, LC_ALL: locale },
    });
    assert.equal(child.status, 0, child.stderr);
    return JSON.parse(child.stdout);
  });
  assert.deepEqual(results[0], results[1]);
});

test("V2 rejects non-JSON structure before evaluating accessors", () => {
  let reads = 0;
  const getter = Object.defineProperty({}, "value", {
    enumerable: true,
    get() {
      reads++;
      return 1;
    },
  });
  const hidden = Object.defineProperty({}, "value", { value: 1 });
  const extra: unknown[] & { other?: number } = [];
  extra.other = 1;
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  for (const value of [
    getter,
    hidden,
    extra,
    cycle,
    { [Symbol("key")]: 1 },
    { items: Array(1) },
    { value: Infinity },
    { value: undefined },
    { value: new Date() },
  ])
    assert.throws(() => canonicalRequestBody(value));
  assert.equal(reads, 0);
});

test("new queued jobs resume with reordered Unicode keys and retain the original V1 hash", async (t) => {
  const { store, resolve } = fixture(t);
  let submits = 0;
  const provider: JobProvider = {
    submit: async () => ({ requestId: `remote-${++submits}` }),
    inspect: async () => ({ state: "queued" }),
  };
  const first = resolve(input),
    args = { store, operation: operation(first.operationId), input, provider };
  const before = await runGenerationStep(args);
  assert.equal(before.canonicalInput?.version, 2);
  const chosen = resolve(reversed);
  assert.equal(chosen.operationId, before.operationId);
  const after = await runGenerationStep({ ...args, input: reversed });
  assert.equal(after.inputHash, before.inputHash);
  assert.deepEqual(after.canonicalInput, before.canonicalInput);
  assert.equal(submits, 1);
  assert.equal(store.summary().reservedUsd, 1);
});

test("legacy queued jobs keep their IDs, quote and absent marker without another submit", async (t) => {
  const { store, resolve } = fixture(t),
    original = { prompt: "legacy" },
    operationId = id(generationInputHash(original));
  store.reserveOperation({ ...operation(operationId), inputHash: generationInputHash(original) });
  store.transitionJob(operationId, "submitting");
  store.transitionJob(operationId, "queued", { providerRequestId: "original" });
  const before = store.snapshot().jobs[operationId];
  assert.equal(resolve(original).operationId, operationId);
  const result = await runGenerationStep({
    store,
    operation: operation(operationId),
    input: original,
    provider: {
      submit: async () => {
        throw Error("must not submit");
      },
      inspect: async () => ({ state: "queued" }),
    },
  });
  assert.equal(result.inputHash, before.inputHash);
  assert.deepEqual(result.quote, before.quote);
  assert.equal(result.canonicalInput, undefined);
});

test("unverifiable legacy jobs and mixed default candidates refuse replacement before admission", (t) => {
  const { store, resolve } = fixture(t);
  const legacy = id(generationInputHash(input));
  store.reserveOperation({ ...operation(legacy), inputHash: generationInputHash(input) });
  store.transitionJob(legacy, "submitting");
  store.transitionJob(legacy, "unknown");
  const before = store.snapshot();
  assert.throws(() => resolve({ other: "input" }), /unmatched legacy/);
  assert.deepEqual(store.snapshot(), before);
  const newId = id(`v2:${canonicalInputIdentity(input).sha256}`);
  // A pre-existing mixed-version database is data, not permission to create a replacement.
  const mixed = structuredClone(before);
  mixed.jobs[newId] = { ...mixed.jobs[legacy]!, operationId: newId, canonicalInput: canonicalInputIdentity(input) };
  writeFileSync(store.file, JSON.stringify(mixed));
  assert.throws(() => resolve(input), /Both legacy and V2/);
  assert.equal(resolve(input, legacy).operationId, legacy);
});

test("unmatched legacy reservations block automatic replacement before any paid attempt", (t) => {
  const { store, resolve } = fixture(t),
    legacy = id(generationInputHash(input));
  store.reserveOperation({ ...operation(legacy), inputHash: generationInputHash(input) });
  const before = store.snapshot();
  assert.throws(() => resolve({ other: "input" }), /unmatched legacy/);
  assert.deepEqual(store.snapshot(), before);
  assert.equal(resolve(input, legacy).operationId, legacy);
});

test("frozen legacy raw input recovers across collation changes with byte-identical idempotency", async (t) => {
  const { store, resolve } = fixture(t),
    body = generationRequestBody(input),
    inputHash = generationInputHash(input),
    operationId = id(inputHash);
  store.reserveOperation({ ...operation(operationId), inputHash });
  store.persistSubmission(operationId, { requestBody: body });
  store.transitionJob(operationId, "submitting");
  store.transitionJob(operationId, "unknown");
  const originalCompare = String.prototype.localeCompare;
  t.mock.method(String.prototype, "localeCompare", function (this: string, other: string) {
    return -originalCompare.call(this, other);
  });
  assert.equal(resolve(reversed).operationId, operationId);
  let bytes: string | undefined;
  const result = await runGenerationStep({
    store,
    operation: operation(operationId),
    input: reversed,
    provider: {
      idempotentSubmit: true,
      submit: async (_endpoint, _input, context) => {
        assert.equal(context?.operationId, operationId);
        bytes = context?.body;
        return { requestId: "recovered" };
      },
      inspect: async () => ({ state: "queued" }),
    },
  });
  assert.equal(bytes, body);
  assert.equal(result.inputHash, inputHash);
  assert.equal(result.canonicalInput, undefined);
});

test("synchronous V2 cached responses replay under changed collation without a paid POST", async (t) => {
  const { store } = fixture(t);
  let calls = 0;
  const args = {
    store,
    operation: operation("sync"),
    identity: input,
    perform: async () => {
      calls++;
      return new Response("retained bytes");
    },
  };
  assert.equal(await (await synchronousPaidRequest(args)).text(), "retained bytes");
  const before = store.snapshot().jobs.sync!;
  const originalCompare = String.prototype.localeCompare;
  t.mock.method(String.prototype, "localeCompare", function (this: string, other: string) {
    return -originalCompare.call(this, other);
  });
  assert.equal(await (await synchronousPaidRequest({ ...args, identity: reversed })).text(), "retained bytes");
  assert.deepEqual(store.snapshot().jobs.sync?.canonicalInput, before.canonicalInput);
  assert.equal(calls, 1);
  assert.throws(() => paidInputIdentity({ changed: true }, before), /different inputs/);
});

test("tampered frozen request bytes are refused before an idempotent retry", async (t) => {
  const { store } = fixture(t),
    operationId = "tampered";
  store.reserveOperation({ ...operation(operationId), ...paidInputIdentity(input) });
  store.persistSubmission(operationId, { requestBody: generationRequestBody(input) });
  store.transitionJob(operationId, "submitting");
  store.transitionJob(operationId, "unknown");
  const snapshot = store.snapshot();
  snapshot.jobs[operationId]!.requestBody += " ";
  writeFileSync(store.file, JSON.stringify(snapshot));
  let calls = 0;
  await assert.rejects(
    runGenerationStep({
      store,
      operation: operation(operationId),
      input,
      provider: {
        idempotentSubmit: true,
        submit: async () => {
          calls++;
          return { requestId: "forbidden" };
        },
        inspect: async () => ({ state: "queued" }),
      },
    }),
    /body|bytes|hash/i,
  );
  assert.equal(calls, 0);
});

test("reserved quoted input retains collator-tied key order and still validates preparation", async (t) => {
  const { store } = fixture(t),
    operationId = "quoted",
    body = generationRequestBody(input);
  const args = {
    ...operation(operationId),
    provider: "higgsfield",
    preparedInputHash: createHash("sha256").update(body).digest("hex"),
    quotedRequestBody: body,
  };
  const reserved = store.reserveOperation({ ...args, ...paidInputIdentity(input) });
  assert.equal(reserved.requestBody, undefined);
  assert.equal(reserved.quotedRequestBody, body);
  let prepares = 0,
    submits = 0;
  const provider: JobProvider = {
    idempotentSubmit: true,
    prepareInput: async () => {
      prepares++;
      return { changed: true };
    },
    submit: async (_endpoint, _input, context) => {
      submits++;
      assert.equal(context?.body, body);
      return { requestId: "quoted" };
    },
    inspect: async () => ({ state: "queued" }),
  };
  await assert.rejects(
    runGenerationStep({ store, operation: args, input: reversed, provider }),
    /differs from the quoted body/,
  );
  assert.equal(submits, 0);
  assert.equal(store.snapshot().jobs[operationId]!.state, "reserved");
  provider.prepareInput = async () => {
    prepares++;
    return reversed;
  };
  const job = await runGenerationStep({ store, operation: args, input: reversed, provider });
  assert.equal(job.requestBody, body);
  assert.equal(prepares, 2);
  assert.equal(submits, 1);
});

test("legacy uncharged readiness refresh replays without a budget database or network", async (t) => {
  const { directory: root } = fixture(t),
    project = path.join(root, "public/projects/demo");
  mkdirSync(project, { recursive: true });
  writeFileSync(path.join(project, "project.json"), "{}");
  writeFileSync(path.join(project, "source.json"), JSON.stringify({ voiceId: "voice_A", task: "design" }));
  const request = VoiceManagementRequestSchema.parse({
    version: 1,
    task: "refresh",
    projectId: "demo",
    voiceId: "voice_A",
    sourceManifest: "public/projects/demo/source.json",
    model: "eleven_v3",
    output: "public/projects/demo/ready.json",
  });
  const target = projectOutput(root, "demo", request.output),
    prior = regularInput(root, request.sourceManifest!);
  const logical = logicalJson({
    ...request,
    operationId: undefined,
    maxCostUsd: undefined,
    output: target.relative,
    samples: [],
    dictionary: undefined,
    sourceManifest: prior.sha256,
  });
  const inputHash = generationInputHash({ endpoint: "/v1/voices/voice_A", request: logical });
  const operationId = `el:voice:${inputHash.slice(0, 40)}`;
  writeFileSync(
    target.file,
    JSON.stringify({ version: 1, task: "refresh", voiceId: "voice_A", inputHash, operationId }),
  );
  const result = await executeVoiceManagement(request, {
    rootDir: root,
    dryRun: true,
    fetch: async () => {
      throw Error("Network forbidden");
    },
  });
  assert.equal(result.metadata.replay, true);
});
