import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { MediaFetchOptionsSchema } from "../src/types/media-fetch";
import { publicAddress, publicUrl } from "../src/lib/media-fetch/http";
import { platformFor, routes, doctor, PROVIDERS } from "../src/lib/media-fetch/catalogue";
import {
  requestInput,
  normalise,
  selectVariants,
  rapidCredits,
  inspectRun,
  submit,
} from "../src/lib/media-fetch/providers";
import { retryRead } from "../src/lib/media-fetch/retry";
import { MediaFetchError } from "../src/lib/media-fetch/errors";
import { createJob, runJob } from "../src/lib/media-fetch/runner";
import { scopedPath, readJob, publicReport } from "../src/lib/media-fetch/storage";
import { quotaReservation } from "../src/lib/media-fetch/budget";
import { dashTracks, hlsSegments } from "../src/lib/media-fetch/segments";
const options = (overrides: Record<string, unknown> = {}) =>
  MediaFetchOptionsSchema.parse({ urls: ["https://example.com/video"], outputDir: "out/inbox", ...overrides });

test("rejects non-public IPv4/IPv6 and permits global addresses", () => {
  for (const ip of [
    "127.0.0.1",
    "10.0.0.1",
    "169.254.169.254",
    "100.100.100.200",
    "0.0.0.0",
    "192.168.1.1",
    "::1",
    "::ffff:8.8.8.8",
    "fec0::1",
    "fc00::1",
    "fe80::1",
    "2001:db8::1",
  ])
    assert.equal(publicAddress(ip), false, ip);
  for (const ip of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"]) assert.equal(publicAddress(ip), true, ip);
  for (const url of [
    "file:///etc/passwd",
    "https://user:pass@example.com",
    "http://127.1",
    "http://[::1]",
    "https://example.com:8443",
  ])
    assert.throws(() => publicUrl(url));
});
test("routes all documented domains with hostname boundaries and available secrets", () => {
  assert.equal(platformFor("https://www.youtube.com/watch?v=x"), "youtube");
  assert.equal(platformFor("https://youtube.com.evil.example/x"), "unknown");
  const env = { RAPIDAPI_KEY: "fake", APIFY_TOKEN: "fake" };
  assert.deepEqual(routes("https://x.com/user/status/1", options(), env), [
    "rapidapi",
    "apify-easyapi",
    "apify-wilcode",
  ]);
  assert.deepEqual(routes("https://reddit.com/r/video", options(), env), ["apify-easyapi"]);
  assert.deepEqual(routes("https://spotify.com/track/1", options(), env), ["apify-easyapi"]);
  assert.deepEqual(routes("https://instagram.com/p/x", options(), {}), []);
  for (const p of PROVIDERS["apify-easyapi"].platforms)
    assert.ok(routes(`https://${p}.com/item`, options(), env).includes("apify-easyapi"));
  assert.ok(doctor({}).every((x) => !x.configured));
});
test("RapidAPI tariff and YouTube quality mapping use current provider contract", () => {
  assert.equal(rapidCredits("https://instagram.com/reel/x"), 2);
  assert.equal(rapidCredits("https://instagram.com/stories/x"), 5);
  assert.equal(rapidCredits("https://youtu.be/x"), 15);
  assert.deepEqual(requestInput("rapidapi", "https://youtu.be/x", options({ height: 1000 })), {
    url: "https://youtu.be/x",
    format: "720p",
  });
  assert.equal(requestInput("rapidapi", "https://youtu.be/x", options({ kind: "audio" })).format, "mp3");
});
test("normalises albums, MP3 and EasyAPI alternatives without downloading soundtrack twice", () => {
  const album = normalise("rapidapi", {
    ok: true,
    type: "album",
    items: [
      { type: "image", download_url: "https://cdn.example/a.jpg" },
      { type: "video", download_url: "https://cdn.example/b.mp4" },
    ],
  });
  assert.equal(selectVariants(album, options()).length, 2);
  const audio = normalise(
    "rapidapi",
    { ok: true, video_id: "x", download_url: "https://cdn.example/a.mp3" },
    options({ kind: "audio" }),
  );
  assert.equal(selectVariants(audio, options({ kind: "audio" }))[0].kind, "audio");
  const media = normalise("apify-easyapi", [
    {
      medias: [
        { type: "video", url: "https://cdn.example/hd.mp4", quality: "hd_no_watermark" },
        { type: "video", url: "https://cdn.example/sd.mp4", quality: "no_watermark" },
        { type: "audio", url: "https://cdn.example/a.mp3" },
        { type: "image", url: "https://cdn.example/a.jpg" },
        { type: "image", url: "https://cdn.example/b.jpg" },
      ],
    },
  ]);
  assert.equal(selectVariants(media, options()).length, 3);
  assert.equal(selectVariants(media, options({ kind: "all" })).length, 4);
  assert.throws(() => selectVariants(album, options({ kind: "audio" })), /No media/);
});
test("Apify polls same run and paginates dataset without submitting a new run", async () => {
  const calls: string[] = [];
  const result = await inspectRun("Run123", async (url) => {
    calls.push(url);
    return url.includes("actor-runs")
      ? { data: { status: "SUCCEEDED", defaultDatasetId: "Data123", usageTotalUsd: 0.1 } }
      : url.includes("offset=0&")
        ? Array.from({ length: 100 }, () => ({ x: 1 }))
        : [{ x: 2 }];
  });
  assert.equal(result.state, "completed");
  assert.equal((result.result as unknown[]).length, 101);
  assert.equal(calls.length, 3);
  await assert.rejects(
    () => submit("rapidapi", { url: "https://instagram.com/p/x" }, 100, async () => ({ ok: false })),
    /rejected/,
  );
});
test("safe retry backoff is bounded; ambiguous transport is never retried", async () => {
  let attempts = 0;
  const waits: number[] = [];
  assert.equal(
    await retryRead(
      async () => {
        if (attempts++ < 2) throw new MediaFetchError("RATE_LIMIT", "wait", "wait", true, 50);
        return 1;
      },
      async (ms) => {
        waits.push(ms);
      },
    ),
    1,
  );
  assert.deepEqual(waits, [50, 50]);
  attempts = 0;
  await assert.rejects(() =>
    retryRead(async () => {
      attempts++;
      throw new Error("ambiguous");
    }),
  );
  assert.equal(attempts, 1);
});
test("HLS/DASH localisation plans are bounded and reject encryption/dynamic content", () => {
  assert.deepEqual(hlsSegments("#EXTM3U\n#EXTINF:1\na.ts\n#EXT-X-ENDLIST", "https://cdn.example/a/list.m3u8"), [
    "https://cdn.example/a/a.ts",
  ]);
  assert.throws(() => hlsSegments("#EXTM3U\n#EXT-X-KEY:METHOD=AES-128\na.ts", "https://cdn.example/a"));
  const mpd =
    '<MPD type="static" mediaPresentationDuration="PT4S"><Period><AdaptationSet mimeType="video/mp4"><SegmentTemplate duration="2" timescale="1" initialization="init-$RepresentationID$.mp4" media="s-$Number$.m4s"/><Representation id="v1" height="720" bandwidth="100"/></AdaptationSet></Period></MPD>';
  assert.deepEqual(dashTracks(mpd, "https://cdn.example/a.mpd")[0].segments, [
    "https://cdn.example/init-v1.mp4",
    "https://cdn.example/s-1.m4s",
    "https://cdn.example/s-2.m4s",
  ]);
  assert.throws(() => dashTracks(mpd.replace("static", "dynamic"), "https://cdn.example/a.mpd"));
});
test("batch of 20 sources persists individual errors without secrets or lost results", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "media-fetch-"));
  const old = process.cwd(),
    rapid = process.env.RAPIDAPI_KEY,
    apify = process.env.APIFY_TOKEN;
  try {
    process.chdir(root);
    delete process.env.RAPIDAPI_KEY;
    delete process.env.APIFY_TOKEN;
    const job = createJob(options({ urls: Array.from({ length: 20 }, (_, i) => `https://example.com/${i}`) }), root);
    await runJob(job, root);
    assert.equal(job.items.length, 20);
    assert.ok(job.items.every((x) => x.issue?.code === "CREDENTIALS_REQUIRED"));
    assert.equal(readJob(job.directory).state, "failed");
    assert.ok(!JSON.stringify(publicReport(job)).includes("https://example.com"));
    assert.throws(() => scopedPath(root, "/etc/passwd"));
  } finally {
    process.chdir(old);
    if (rapid !== undefined) process.env.RAPIDAPI_KEY = rapid;
    if (apify !== undefined) process.env.APIFY_TOKEN = apify;
    rmSync(root, { recursive: true, force: true });
  }
});
test("shared RapidAPI quota reserves credits once and stops at the authorised remainder", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "media-quota-"));
  try {
    mkdirSync(path.join(root, ".cache/media-fetch"), { recursive: true });
    writeFileSync(
      path.join(root, ".cache/media-fetch/rapidapi-quota.json"),
      JSON.stringify({
        schemaVersion: 1,
        authorised: true,
        periodStart: "2020-01-01T00:00:00Z",
        periodEnd: "2100-01-01T00:00:00Z",
        remainingCredits: 2,
        reservations: {},
      }),
    );
    assert.equal(quotaReservation(root, "one", "https://instagram.com/p/1"), true);
    assert.equal(quotaReservation(root, "one", "https://instagram.com/p/1"), true);
    assert.equal(quotaReservation(root, "two", "https://instagram.com/p/2"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("paid synchronous acquisitions persist proof and complete OperationStore lifecycle; resume is idempotent", async () => {
  const { OperationStore } = await import("../src/lib/jobs/store");
  const root = mkdtempSync(path.join(os.tmpdir(), "media-paid-")),
    old = process.cwd(),
    key = process.env.RAPIDAPI_KEY;
  try {
    process.chdir(root);
    process.env.RAPIDAPI_KEY = "test-only";
    let calls = 0;
    const job = createJob(
      options({ urls: ["https://instagram.com/p/one"], maxCostUsd: 0.1, maxTotalCostUsd: 0.2 }),
      root,
    );
    const services = {
      submit: async () => {
        calls++;
        return { result: { ok: true, type: "video", download_url: "https://cdn.example/a.mp4" } };
      },
      publish: async () => {},
    };
    await runJob(job, root, services);
    assert.equal(job.state, "completed");
    assert.equal(calls, 1);
    const store = new OperationStore(`media-${job.id}`, { directory: path.join(job.directory, "budget") });
    const operation = store.snapshot().jobs[job.items[0].operationId!];
    assert.equal(operation.state, "published");
    assert.equal(operation.providerRequestId, undefined);
    assert.ok(operation.result?.acquisitionProof);
    await runJob(readJob(job.directory), root, services);
    assert.equal(calls, 1);
  } finally {
    process.chdir(old);
    if (key === undefined) delete process.env.RAPIDAPI_KEY;
    else process.env.RAPIDAPI_KEY = key;
    rmSync(root, { recursive: true, force: true });
  }
});
test("lost submit response and Apify 5xx remain unknown; resume does not issue another call", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "media-unknown-")),
    old = process.cwd(),
    key = process.env.RAPIDAPI_KEY;
  try {
    process.chdir(root);
    process.env.RAPIDAPI_KEY = "test-only";
    let calls = 0;
    const job = createJob(
      options({ urls: ["https://instagram.com/p/one"], maxCostUsd: 0.1, maxTotalCostUsd: 0.2 }),
      root,
    );
    const services = {
      submit: async () => {
        calls++;
        throw new Error("response lost");
      },
    };
    await runJob(job, root, services);
    assert.equal(job.items[0].state, "unknown");
    await runJob(readJob(job.directory), root, services);
    assert.equal(calls, 1);
  } finally {
    process.chdir(old);
    if (key === undefined) delete process.env.RAPIDAPI_KEY;
    else process.env.RAPIDAPI_KEY = key;
    rmSync(root, { recursive: true, force: true });
  }
});
test("batch reservation derives liability from durable operations after a crash window", async () => {
  const { admit, operationStore } = await import("../src/lib/media-fetch/budget");
  const root = mkdtempSync(path.join(os.tmpdir(), "media-batch-bound-")),
    old = process.cwd();
  try {
    process.chdir(root);
    const job = createJob(
      options({
        urls: ["https://instagram.com/p/one", "https://instagram.com/p/two"],
        maxCostUsd: 0.1,
        maxTotalCostUsd: 0.1,
      }),
      root,
    );
    const first = job.items[0];
    first.resolvedUrl = first.url;
    first.operationId = `media-${job.id}-0-0`;
    admit(root, job, first, "rapidapi", { url: first.url });
    job.committedUsd = 0;
    const second = job.items[1];
    second.resolvedUrl = second.url;
    second.operationId = `media-${job.id}-1-0`;
    assert.throws(() => admit(root, job, second, "rapidapi", { url: second.url }), /bound exhausted/);
    assert.equal(Object.keys(operationStore(job).snapshot().jobs).length, 1);
  } finally {
    process.chdir(old);
    rmSync(root, { recursive: true, force: true });
  }
});
test("stale worker lock is recovered by a new worker", async () => {
  const { lock } = await import("../src/lib/media-fetch/storage");
  const root = mkdtempSync(path.join(os.tmpdir(), "media-stale-"));
  try {
    const file = path.join(root, "worker.lock");
    writeFileSync(file, JSON.stringify({ pid: 2147483647 }));
    const release = lock(file);
    assert.throws(() => lock(file), /Another acquisition/);
    release();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("concurrent identical originals publish one reusable audio derivative", async () => {
  const { spawnSync } = await import("node:child_process");
  const { hashFile } = await import("../src/lib/assets/registry");
  const { inspectAsset } = await import("../src/lib/assets/inspect");
  const { publish } = await import("../src/lib/media-fetch/publish");
  const root = mkdtempSync(path.join(os.tmpdir(), "media-edit-resume-")),
    old = process.cwd();
  try {
    process.chdir(root);
    const source = path.join(root, "source.wav");
    const generated = spawnSync("ffmpeg", [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=0.1",
      source,
    ]);
    assert.equal(generated.status, 0);
    const job = createJob(
        options({
          audioFormat: "mp3",
          kind: "audio",
          urls: ["https://example.com/first", "https://example.com/second"],
        }),
        root,
      ),
      item = job.items[0];
    const inspected = inspectAsset(source);
    item.files.push({
      sourceKey: "0:0",
      path: source,
      hash: hashFile(source),
      bytes: readFileSync(source).length,
      kind: "audio",
      media: inspected.media,
    });
    job.items[1].files.push({ ...item.files[0], sourceKey: "1:0" });
    await Promise.all(
      job.items.map((entry) =>
        publish(job, entry, [{ url: "https://cdn.example/never-download.wav", kind: "audio", group: "0" }], root),
      ),
    );
    assert.equal(item.files.length, 2);
    assert.equal(job.items[1].files.length, 2);
    assert.equal(item.files[1].path, job.items[1].files[1].path);
    assert.equal(readdirSync(path.join(job.directory, "files")).filter((name) => name.includes("-edit.")).length, 1);
    assert.equal(item.files[1].derivedFrom, item.files[0].hash);
    await publish(job, item, [{ url: "https://cdn.example/never-download.wav", kind: "audio", group: "0" }], root);
    assert.equal(item.files.length, 2);
  } finally {
    process.chdir(old);
    rmSync(root, { recursive: true, force: true });
  }
});

test("Apify submit 5xx is ambiguous and does not trigger Wilcode fallback", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "media-apify-unknown-")),
    old = process.cwd(),
    token = process.env.APIFY_TOKEN;
  try {
    process.chdir(root);
    process.env.APIFY_TOKEN = "test-only";
    mkdirSync(path.join(root, ".cache/media-fetch"), { recursive: true });
    writeFileSync(
      path.join(root, ".cache/media-fetch/pricing.json"),
      JSON.stringify([
        { provider: "apify-easyapi", asOf: new Date().toISOString(), actorStartUsd: 0.09, resultUsd: 0.00299 },
      ]),
    );
    let calls = 0;
    const job = createJob(
      options({ urls: ["https://reddit.com/r/video"], maxCostUsd: 0.2, maxTotalCostUsd: 0.4 }),
      root,
    );
    const services = {
      submit: async () => {
        calls++;
        throw new MediaFetchError("PROVIDER_UNAVAILABLE", "HTTP 500", "inspect", true);
      },
    };
    await runJob(job, root, services);
    assert.equal(job.items[0].state, "unknown");
    await runJob(readJob(job.directory), root, services);
    assert.equal(calls, 1);
  } finally {
    process.chdir(old);
    if (token === undefined) delete process.env.APIFY_TOKEN;
    else process.env.APIFY_TOKEN = token;
    rmSync(root, { recursive: true, force: true });
  }
});
test("cached synchronous response recovers crash between response persistence and item save", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "media-response-recover-")),
    old = process.cwd(),
    key = process.env.RAPIDAPI_KEY;
  const { admit } = await import("../src/lib/media-fetch/budget");
  try {
    process.chdir(root);
    process.env.RAPIDAPI_KEY = "test-only";
    const job = createJob(
        options({ urls: ["https://instagram.com/p/one"], maxCostUsd: 0.1, maxTotalCostUsd: 0.2 }),
        root,
      ),
      item = job.items[0];
    item.resolvedUrl = item.url;
    item.candidates = ["rapidapi"];
    item.provider = "rapidapi";
    item.operationId = `media-${job.id}-0-0`;
    const admission = admit(root, job, item, "rapidapi", { url: item.url });
    admission.store!.transitionJob(item.operationId, "submitting");
    item.state = "submitting";
    writeFileSync(
      path.join(job.directory, "0-0.private.json"),
      JSON.stringify({ ok: true, type: "video", download_url: "https://cdn.example/a.mp4" }),
    );
    let calls = 0;
    await runJob(job, root, {
      submit: async () => {
        calls++;
        throw Error("must not submit");
      },
      publish: async () => {},
    });
    assert.equal(job.state, "completed");
    assert.equal(calls, 0);
  } finally {
    process.chdir(old);
    if (key === undefined) delete process.env.RAPIDAPI_KEY;
    else process.env.RAPIDAPI_KEY = key;
    rmSync(root, { recursive: true, force: true });
  }
});
test("height conversion makes a real bounded MP4 while preserving original", async () => {
  const { spawnSync } = await import("node:child_process");
  const { hashFile } = await import("../src/lib/assets/registry");
  const { inspectAsset } = await import("../src/lib/assets/inspect");
  const { publish } = await import("../src/lib/media-fetch/publish");
  const root = mkdtempSync(path.join(os.tmpdir(), "media-height-")),
    old = process.cwd();
  try {
    process.chdir(root);
    const source = path.join(root, "source.mp4");
    assert.equal(
      spawnSync("ffmpeg", [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "color=c=blue:s=320x240:d=0.1",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        source,
      ]).status,
      0,
    );
    const job = createJob(options({ height: 144, preset: "edit" }), root),
      item = job.items[0];
    assert.equal(
      selectVariants([{ url: "https://cdn.example/unused.mp4", kind: "video", group: "0", height: 240 }], job.options)
        .length,
      1,
    );
    item.files.push({
      sourceKey: "0:0",
      path: source,
      hash: hashFile(source),
      bytes: readFileSync(source).length,
      kind: "video",
      media: inspectAsset(source).media,
    });
    await publish(job, item, [{ url: "https://cdn.example/unused.mp4", kind: "video", group: "0" }], root);
    assert.equal(item.files.length, 2);
    assert.equal(item.files[1].media.height, 144);
  } finally {
    process.chdir(old);
    rmSync(root, { recursive: true, force: true });
  }
});

test("20 parallel successful sources retain ordering and a partial failure preserves 19 successes", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "media-parallel-")),
    old = process.cwd(),
    key = process.env.RAPIDAPI_KEY;
  try {
    process.chdir(root);
    process.env.RAPIDAPI_KEY = "test-only";
    let active = 0,
      maxActive = 0;
    const job = createJob(
      options({
        urls: Array.from({ length: 20 }, (_, i) => `https://instagram.com/p/${i}`),
        provider: "rapidapi",
        maxCostUsd: 0.01,
        maxTotalCostUsd: 0.21,
      }),
      root,
    );
    await runJob(job, root, {
      submit: async (_provider, input) => {
        active++;
        maxActive = Math.max(active, maxActive);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active--;
        if (String(input.url).endsWith("/7")) throw new MediaFetchError("SOURCE_UNAVAILABLE", "Deleted source.");
        return { result: { ok: true, type: "video", download_url: "https://cdn.example/a.mp4" } };
      },
      publish: async () => {},
    });
    assert.equal(job.state, "partial");
    assert.equal(job.items.filter((x) => x.state === "completed").length, 19);
    assert.equal(job.items[7].issue?.code, "SOURCE_UNAVAILABLE");
    assert.ok(maxActive > 1 && maxActive <= 4);
    assert.equal(job.items[19].url, "https://instagram.com/p/19");
  } finally {
    process.chdir(old);
    if (key === undefined) delete process.env.RAPIDAPI_KEY;
    else process.env.RAPIDAPI_KEY = key;
    rmSync(root, { recursive: true, force: true });
  }
});
test("body-stream aborts become actionable safe-read transport errors", async () => {
  const { Readable } = await import("node:stream");
  const { readResponse } = await import("../src/lib/media-fetch/http");
  const body = new Readable({
    read() {
      this.destroy(Object.assign(new Error("connection lost"), { code: "ECONNRESET" }));
    },
  });
  await assert.rejects(
    () => readResponse(body as unknown as import("node:http").IncomingMessage),
    (error: unknown) => error instanceof MediaFetchError && error.code === "NETWORK" && error.retryable,
  );
});
