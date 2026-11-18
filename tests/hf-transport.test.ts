import { USER_GRANT } from "./helpers/ceiling-grant";
import "./helpers/fal-no-network";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createHiggsfieldClient,
  parseHiggsfieldKey,
  validHiggsfieldRequestUrl,
} from "../src/lib/providers/higgsfield/client";
import { prepareHiggsfieldInput, transcodeHiggsfieldUpload } from "../src/lib/providers/higgsfield/uploads";
import { createHiggsfieldJobProvider } from "../src/lib/jobs/higgsfield-provider";
import { createFalJobProvider } from "../src/lib/jobs/fal-provider";
import { OperationStore } from "../src/lib/jobs/store";
import { runGenerationStep, generationInputHash } from "../src/lib/jobs/runner";
import { CliErrorObject } from "../src/lib/cli";
import { higgsfieldKeyCheck } from "../src/lib/doctor";
import type { ProviderUpload } from "../src/lib/jobs/types";

const endpoint = "bytedance/seedance-2.5/reference-to-video";
const key = "offline-id:offline-secret";
const statusUrl = "https://api.higgsfield.ai/requests/req-1/status";
const cancelUrl = "https://api.higgsfield.ai/requests/req-1/cancel";
const quote = {
  currency: "USD" as const,
  lowUsd: 0,
  expectedUsd: 1,
  highUsd: 1,
  bounded: true as const,
  confidence: "user-bound" as const,
  source: "offline bound",
  asOf: "2026-11-15",
};
function storeFixture() {
  const directory = mkdtempSync(path.join(tmpdir(), "hf-transport-"));
  const store = new OperationStore("hf-test", { directory });
  store.configure({ ceilingUsd: 10, maxJobUsd: 2, repairReserveFraction: 0 }, USER_GRANT);
  return { directory, store, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}
const operation = (operationId = "hf:1") => ({
  operationId,
  provider: "higgsfield",
  endpoint,
  assetId: operationId,
  quote,
});

test("key parsing splits the first colon and preflight reveals only presence/format", () => {
  assert.deepEqual(parseHiggsfieldKey("id:secret:tail"), { id: "id", secret: "secret:tail" });
  for (const value of [undefined, "", "plain", ":secret", "id:", " :secret", "id:  ", "id:secret\n"]) {
    assert.throws(
      () => parseHiggsfieldKey(value),
      (error: unknown) =>
        error instanceof CliErrorObject &&
        error.code === "MISSING_API_KEY" &&
        error.message.includes("https://open.higgsfield.ai/api-keys"),
    );
  }
  assert.equal(higgsfieldKeyCheck(key).detail, "present and well-formed");
  assert.equal(higgsfieldKeyCheck("invalid").status, "warn");
  assert.equal(higgsfieldKeyCheck(undefined).detail, "not set");
  assert.ok(!JSON.stringify(higgsfieldKeyCheck(key)).includes(key));
});

for (const [status, code] of [
  [400, "VALIDATION"],
  [401, "MISSING_API_KEY"],
  [403, "INSUFFICIENT_BALANCE"],
  [404, "INVALID_INPUT"],
  [409, "INVALID_INPUT"],
  [422, "VALIDATION"],
  [423, "RATE_LIMIT"],
  [429, "RATE_LIMIT"],
  [500, "NETWORK"],
  [502, "NETWORK"],
  [503, "RATE_LIMIT"],
] as const) {
  test(`HTTP ${status} maps to ${code} without leaking credentials`, async () => {
    const client = createHiggsfieldClient({
      credentials: key,
      fetch: async () =>
        Response.json({ detail: { message: `problem ${key}` } }, { status, headers: { "Retry-After": "2" } }),
    });
    await assert.rejects(client.status("req-1"), (error: unknown) => {
      assert.ok(error instanceof CliErrorObject);
      assert.equal(error.code, code);
      assert.ok(!`${error.message}${JSON.stringify(error.details)}`.includes(key));
      if ([423, 429, 503].includes(status)) assert.equal(error.retryAfterMs, 2000);
      if ([400, 422].includes(status)) assert.ok(error.details?.detail);
      if ([423, 503].includes(status)) assert.match(error.message, /temporarily unavailable/);
      return true;
    });
  });
}

test("422 Idempotency-Key mismatch explicitly forbids automatic key replacement", async () => {
  const f = storeFixture();
  let submits = 0;
  const client = createHiggsfieldClient({
    credentials: key,
    fetch: async () => {
      submits++;
      return Response.json({ detail: "Idempotency-Key was already used with a different body" }, { status: 422 });
    },
  });
  try {
    await assert.rejects(
      client.submit(endpoint, {}, { idempotencyKey: "same" }),
      /new key must NOT be generated automatically/,
    );
    const options = {
      store: f.store,
      operation: operation(),
      input: {},
      provider: createHiggsfieldJobProvider(client),
    };
    const failed = await runGenerationStep(options);
    assert.equal(failed.state, "failed");
    assert.equal((await runGenerationStep(options)).state, "failed");
    assert.equal(submits, 2);
    assert.equal(f.store.summary().reservedUsd, 1);
  } finally {
    f.cleanup();
  }
});

test("request URLs refuse other hosts, credentials, paths, queries and fragments before fetch", async () => {
  let calls = 0;
  const client = createHiggsfieldClient({
    credentials: key,
    fetch: async () => {
      calls++;
      return Response.json({});
    },
  });
  for (const value of [
    "https://evil.test/requests/req-1/status",
    `${statusUrl}?x=1`,
    `${statusUrl}#x`,
    statusUrl.replace("https:", "http:"),
    statusUrl.replace("api.", "id:secret@api."),
    statusUrl.replace("/req-1/", "/req-2/"),
    `${statusUrl}/`,
    statusUrl.replace(".ai/", ".ai:444/"),
    statusUrl.replace("/status", "/cancel"),
  ]) {
    assert.equal(validHiggsfieldRequestUrl(value, "req-1", "status"), undefined);
    if (!value.includes("req-2")) await assert.rejects(async () => client.status(value), /Invalid Higgsfield/);
  }
  assert.equal(validHiggsfieldRequestUrl(statusUrl, "req-1", "status"), statusUrl);
  await client.status(statusUrl);
  await client.status("req-1");
  assert.equal(calls, 2);
});

test("free endpoints, cancellation, deletion and presigned PUT use exact routes and isolated auth", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const client = createHiggsfieldClient({
    credentials: key,
    fetch: async (url, init) => {
      calls.push({ url: String(url), init });
      return Response.json(
        String(url).endsWith("/generate-upload-url")
          ? {
              public_url: "https://cdn.higgsfield.ai/input",
              upload_url: "https://signed.example/upload?token=one",
              upload_headers: { "Content-Type": "image/png", "x-upload": "one" },
            }
          : {},
      );
    },
  });
  await client.submit(endpoint, { prompt: "test" }, { idempotencyKey: "operation-1" });
  await client.cancel(cancelUrl);
  await client.deleteRequest("req-1");
  await client.estimate(endpoint, { prompt: "test" });
  await client.usage({ start: "2026-11-01", end: "2026-11-15", timeframe: "day", model: endpoint, expand: true });
  await client.restylePresets();
  const upload = await client.createUpload("image/png");
  await client.putUpload(upload.upload_url, upload.upload_headers, Buffer.from("bytes"));
  assert.deepEqual(
    calls.map((call) => [new URL(call.url).pathname, call.init?.method]),
    [
      [`/${endpoint}`, "POST"],
      ["/requests/req-1/cancel", "POST"],
      ["/requests/req-1", "DELETE"],
      [`/estimate/${endpoint}`, "POST"],
      ["/models/usage", "GET"],
      ["/models/higgsfield/genjutsu/restyle/v1.0/presets", "GET"],
      ["/files/generate-upload-url", "POST"],
      ["/upload", "PUT"],
    ],
  );
  assert.equal(new Headers(calls[0]!.init?.headers).get("Idempotency-Key"), "operation-1");
  for (const call of calls) {
    assert.equal(call.init?.redirect, "manual");
    assert.ok(call.init?.signal);
  }
  assert.equal(new Headers(calls.at(-1)!.init?.headers).get("Authorization"), null);
  assert.deepEqual(calls.at(-1)!.init?.headers, upload.upload_headers);
  await assert.rejects(client.putUpload(upload.upload_url, { Authorization: key }, Buffer.from("x")), /Unsafe/);
});

test("network and timeout errors are sanitised and redirects are not followed", async () => {
  for (const [name, code] of [
    ["Error", "NETWORK"],
    ["TimeoutError", "TIMEOUT"],
  ] as const) {
    const client = createHiggsfieldClient({
      credentials: key,
      fetch: async () => {
        const error = new Error(key);
        error.name = name;
        throw error;
      },
    });
    await assert.rejects(
      client.status("req-1"),
      (error: unknown) => error instanceof CliErrorObject && error.code === code && !error.message.includes(key),
    );
  }
  const client = createHiggsfieldClient({
    credentials: key,
    fetch: async () => new Response(null, { status: 302, headers: { Location: "https://evil.test" } }),
  });
  await assert.rejects(
    client.status("req-1"),
    (error: unknown) => error instanceof CliErrorObject && error.code === "NETWORK",
  );
});

for (const [status, state] of [
  ["queued", "queued"],
  ["in_progress", "running"],
  ["completed", "result-ready"],
  ["failed", "failed"],
  ["nsfw", "failed"],
  ["canceled", "failed"],
] as const) {
  test(`status ${status} maps to ${state}${state === "failed" ? " with no charge" : ""}`, async () => {
    const f = storeFixture();
    const client = createHiggsfieldClient({
      credentials: key,
      fetch: async (url, init) =>
        Response.json(
          init?.method === "POST"
            ? { request_id: "req-1", status_url: statusUrl, cancel_url: cancelUrl }
            : {
                request_id: "req-1",
                status,
                video: { url: "https://cdn.higgsfield.ai/out.mp4" },
                expires_at: "2026-11-22",
              },
        ),
    });
    try {
      const job = await runGenerationStep({
        store: f.store,
        operation: operation(),
        input: {},
        provider: createHiggsfieldJobProvider(client),
      });
      assert.equal(job.state, state);
      assert.deepEqual(job.providerUrls, { status: statusUrl, cancel: cancelUrl });
      if (state === "failed") {
        assert.equal(f.store.summary().reservedUsd, 0);
        assert.equal(job.release?.reason, "confirmed-no-charge");
        const ledger = path.join(f.directory, "cost-ledger.jsonl");
        const row = JSON.parse(readFileSync(ledger, "utf8"));
        assert.equal(row.actualUsd, 0);
        assert.equal(row.provider, "higgsfield");
        if (status === "nsfw") assert.equal(job.error, "rejected by content moderation (nsfw)");
        await runGenerationStep({
          store: f.store,
          operation: operation(),
          input: {},
          provider: createHiggsfieldJobProvider(client),
        });
        assert.equal(readFileSync(ledger, "utf8").trim().split("\n").length, 1);
      } else if (status === "completed") assert.equal(job.result?.expires_at, "2026-11-22");
    } finally {
      f.cleanup();
    }
  });
}

test("lost submit response resubmits exactly the persisted key/body after restart, with uploads reused", async () => {
  const f = storeFixture();
  let uploads = 0;
  const submits: Array<{ key: string | null; body: string }> = [];
  const client = createHiggsfieldClient({
    credentials: key,
    fetch: async (url, init) => {
      if (String(url).includes("/generate-upload-url")) {
        uploads++;
        return Response.json({
          public_url: "https://cdn.higgsfield.ai/upload.png",
          upload_url: "https://signed.example/put",
          upload_headers: { "Content-Type": "image/png" },
        });
      }
      if (init?.method === "PUT") return new Response(null, { status: 200 });
      if (init?.method === "POST") {
        const saved = f.store.snapshot().jobs["hf:1"]!;
        assert.equal(saved.uploads?.length, 1);
        assert.equal(saved.requestBody, init.body);
        submits.push({ key: new Headers(init.headers).get("Idempotency-Key"), body: String(init.body) });
        if (submits.length === 1) throw new Error("lost response");
        return Response.json({ request_id: "req-1", status_url: statusUrl, cancel_url: cancelUrl });
      }
      return Response.json({ request_id: "req-1", status: "in_progress" });
    },
  });
  const input = { image_url: `data:image/png;base64,${Buffer.from("png").toString("base64")}`, prompt: "original" };
  const options = { store: f.store, operation: operation(), input, provider: createHiggsfieldJobProvider(client) };
  try {
    assert.equal((await runGenerationStep(options)).state, "unknown");
    const restartedStore = new OperationStore("hf-test", { directory: f.directory });
    assert.equal(
      (
        await runGenerationStep({
          ...options,
          store: restartedStore,
          input: { prompt: input.prompt, image_url: input.image_url },
        })
      ).state,
      "running",
    );
    assert.equal(uploads, 1);
    assert.equal(submits.length, 2);
    assert.deepEqual(submits[0], submits[1]);
    assert.equal(submits[0]!.key, "hf:1");
    assert.ok(!submits[0]!.body.includes("data:"));
    assert.equal(f.store.snapshot().jobs["hf:1"]!.paidAttempts, 1);
    await assert.rejects(
      runGenerationStep({ ...options, input: { prompt: "different" } }),
      /different|bound|identity/i,
    );
  } finally {
    f.cleanup();
  }
});

test("restart from submit intent recovers only idempotent providers, fal remains ambiguous", async () => {
  const f = storeFixture();
  try {
    f.store.reserveOperation({ ...operation(), inputHash: generationInputHash({ prompt: "test" }) });
    f.store.persistSubmission("hf:1", { requestBody: '{"prompt":"test"}' });
    f.store.transitionJob("hf:1", "submitting");
    let calls = 0;
    const provider = createHiggsfieldJobProvider(
      createHiggsfieldClient({
        credentials: key,
        fetch: async (_url, init) => {
          if (init?.method === "POST") {
            calls++;
            return Response.json({ request_id: "req-1" });
          }
          return Response.json({ request_id: "req-1", status: "queued" });
        },
      }),
    );
    assert.equal(
      (await runGenerationStep({ store: f.store, operation: operation(), input: { prompt: "test" }, provider })).state,
      "queued",
    );
    assert.equal(calls, 1);
    const fal = createFalJobProvider({
      submit: async () => {
        calls++;
        throw new Error("lost response");
      },
      status: async () => ({ status: "IN_QUEUE" }),
      result: async () => ({ data: {} }),
    });
    const options = {
      store: f.store,
      operation: { ...operation("fal:1"), provider: "fal.ai" },
      input: {},
      provider: fal,
    };
    assert.equal((await runGenerationStep(options)).state, "unknown");
    assert.equal((await runGenerationStep(options)).state, "unknown");
    assert.equal(calls, 2);
  } finally {
    f.cleanup();
  }
});

test("partial upload preparation survives interruption and transcodes unsupported types once", async () => {
  const f = storeFixture();
  let conversions = 0,
    uploads = 0;
  const one = `data:audio/mpeg;base64,${Buffer.from("mp3").toString("base64")}`,
    two = `data:image/png;base64,${Buffer.from("png").toString("base64")}`;
  const client = {
    createUpload: async () => {
      uploads++;
      if (uploads === 2) throw new Error("interrupted");
      return {
        public_url: `https://cdn.higgsfield.ai/input-${uploads}`,
        upload_url: "https://signed.example/put",
        upload_headers: {},
      };
    },
    putUpload: async () => {},
  };
  const transcode = () => {
    conversions++;
    return { contentType: "audio/wav", bytes: Buffer.from("wav") };
  };
  try {
    f.store.reserveOperation({ ...operation(), inputHash: generationInputHash({ refs: [one, two] }) });
    const persistUpload = (upload: ProviderUpload) => {
      f.store.persistSubmission("hf:1", { upload });
    };
    await assert.rejects(
      prepareHiggsfieldInput({ refs: [one, two] }, { client, uploads: [], persistUpload, transcode }),
      /interrupted/,
    );
    const input = await prepareHiggsfieldInput(
      { refs: [one, two] },
      { client, uploads: f.store.snapshot().jobs["hf:1"]!.uploads!, persistUpload, transcode },
    );
    assert.deepEqual(input, { refs: ["https://cdn.higgsfield.ai/input-1", "https://cdn.higgsfield.ai/input-3"] });
    assert.equal(conversions, 1);
    assert.equal(f.store.snapshot().jobs["hf:1"]!.uploads?.length, 2);
  } finally {
    f.cleanup();
  }
});

test("local ffmpeg converts a tiny WAV alias to accepted WAV", () => {
  const bytes = Buffer.alloc(44 + 1600);
  bytes.write("RIFF");
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(8000, 24);
  bytes.writeUInt32LE(16000, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36);
  bytes.writeUInt32LE(1600, 40);
  const result = transcodeHiggsfieldUpload({ contentType: "audio/x-wav", bytes });
  assert.equal(result.contentType, "audio/wav");
  assert.equal(result.bytes.subarray(0, 4).toString(), "RIFF");
});

test("invalid inline media, unresolved assets and unsafe upload results never submit", async () => {
  const uploads: ProviderUpload[] = [];
  for (const input of [{ image_url: "data:image/png;base64,?" }, { image_url: "asset://sha256/nope" }])
    await assert.rejects(
      prepareHiggsfieldInput(input, {
        client: {
          createUpload: async () => {
            throw new Error("must not upload");
          },
          putUpload: async () => {},
        },
        uploads,
        persistUpload: (upload) => uploads.push(upload),
      }),
      /Invalid|Resolve/,
    );
});

test("interrupted no-charge release resumes from durable refunded failure evidence", async () => {
  const f = storeFixture();
  let polls = 0;
  const client = createHiggsfieldClient({
    credentials: key,
    fetch: async (_url, init) => {
      if (init?.method === "POST") return Response.json({ request_id: "req-1" });
      polls++;
      return Response.json({ request_id: "req-1", status: "failed" });
    },
  });
  const provider = createHiggsfieldJobProvider(client);
  const confirm = f.store.confirmNoCharge.bind(f.store);
  f.store.confirmNoCharge = () => {
    throw new Error("interrupted before refund release");
  };
  const options = { store: f.store, operation: operation(), input: {}, provider };
  try {
    await assert.rejects(runGenerationStep(options), /interrupted/);
    assert.equal(f.store.snapshot().jobs["hf:1"]!.refundedFailure, true);
    assert.equal(f.store.summary().reservedUsd, 1);
    f.store.confirmNoCharge = confirm;
    await runGenerationStep(options);
    assert.equal(f.store.summary().reservedUsd, 0);
    assert.equal(polls, 1);
    assert.equal(JSON.parse(readFileSync(path.join(f.directory, "cost-ledger.jsonl"), "utf8")).actualUsd, 0);
  } finally {
    f.cleanup();
  }
});

test("successful failed-status responses redact echoed credentials before persistence", async () => {
  const f = storeFixture();
  const client = createHiggsfieldClient({
    credentials: key,
    fetch: async (_url, init) =>
      Response.json(
        init?.method === "POST"
          ? { request_id: "req-1" }
          : { request_id: "req-1", status: "failed", error: `rejected ${key}` },
      ),
  });
  try {
    const job = await runGenerationStep({
      store: f.store,
      operation: operation(),
      input: {},
      provider: createHiggsfieldJobProvider(client),
    });
    assert.equal(job.state, "failed");
    assert.ok(!JSON.stringify(job).includes(key));
    assert.ok(!JSON.stringify(job).includes("offline-secret"));
  } finally {
    f.cleanup();
  }
});
