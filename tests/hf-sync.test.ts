import "./helpers/fal-no-network";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import {
  loadProviderCatalog,
  readHiggsfieldSchemaDoc,
  resetProviderCatalogCache,
  resolveProviderSnapshot,
  writeCatalog,
} from "../src/lib/models/fal-catalog";
import { HF_CATALOG_URL, HF_DOCS_BASE, runHiggsfieldSync, type HiggsfieldSyncOptions } from "../src/lib/models/hf-sync";
import { FalCatalogFileSchema } from "../src/types/fal-catalog";

const fixtures = path.resolve("tests/fixtures/higgsfield"),
  now = () => new Date("2026-11-15T12:00:00Z");
function setup(t: TestContext): HiggsfieldSyncOptions & { root: string } {
  const root = mkdtempSync(path.join(tmpdir(), "hf-sync-"));
  t.after(() => {
    resetProviderCatalogCache();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    outDir: path.join(root, "catalog"),
    schemaDir: path.join(root, "schemas"),
    checkpointDir: path.join(root, "checkpoints"),
    reportFile: path.join(root, "drift.md"),
    now,
  };
}
function fixturePage(value: string): string {
  const url = new URL(value);
  const file =
    url.hostname === "dash.higgsfield.ai"
      ? "catalog-models.json"
      : path.join("docs", url.pathname.replace(/^\/docs\//, "").replaceAll("/", "_"));
  return readFileSync(path.join(fixtures, file), "utf8");
}
const fakeFetch = (handler: (url: string, init?: RequestInit) => Response | Promise<Response>): typeof fetch =>
  (async (input, init) => handler(String(input), init)) as typeof fetch;

test("catalogue outage preserves existing catalogue-only endpoints until a complete enumeration removes them", async (t) => {
  const options = setup(t);
  await runHiggsfieldSync({ ...options, fromFixtures: fixtures });
  const before = [...loadProviderCatalog("higgsfield", options.outDir).values()].filter((entry) => !entry.docsUrl);
  assert.equal(before.length, 4);
  const result = await runHiggsfieldSync({
    ...options,
    fetchImpl: fakeFetch((url) =>
      url === HF_CATALOG_URL ? new Response("unavailable", { status: 404 }) : new Response(fixturePage(url)),
    ),
  });
  assert.equal(result.entries, 88);
  assert.deepEqual(result.drift.gone, []);
  const after = loadProviderCatalog("higgsfield", options.outDir);
  for (const entry of before) assert.deepEqual(after.get(entry.endpoint), entry);
  const complete = await runHiggsfieldSync({
    ...options,
    fetchImpl: fakeFetch((url) =>
      url === HF_CATALOG_URL ? Response.json({ results: [] }) : new Response(fixturePage(url)),
    ),
  });
  assert.deepEqual(complete.drift.gone.sort(), before.map((entry) => entry.endpoint).sort());
});

test("offline sync publishes 88 validated entries, 79 hash schemas, workflow tags and drift", async (t) => {
  const options = setup(t);
  const result = await runHiggsfieldSync({
    ...options,
    fromFixtures: fixtures,
    fetchImpl: fakeFetch(() => {
      throw new Error("Offline must not fetch.");
    }),
  });
  assert.equal(result.workflows, 84);
  assert.equal(result.entries, 88);
  assert.equal(result.schemas, 79);
  assert.deepEqual(result.counts, {
    "image-to-video": 34,
    "text-to-video": 21,
    "image-to-image": 1,
    "text-to-image": 16,
    "video-to-video": 15,
    training: 1,
  });
  assert.deepEqual(result.familiesWithoutDocs, [
    "genjutsu-light",
    "higgsfield/ai-influencer",
    "kling4",
    "kling4-flash",
  ]);
  assert.equal(result.drift.added.length, 88);
  for (const file of readdirSync(options.outDir!)) {
    const index = FalCatalogFileSchema.parse(JSON.parse(readFileSync(path.join(options.outDir!, file), "utf8")));
    assert.equal(index.provider, "higgsfield");
    for (const entry of index.entries)
      if (entry.schema) assert.ok(readHiggsfieldSchemaDoc(entry.schema.sha256, options.schemaDir));
  }
  const entries = loadProviderCatalog("higgsfield", options.outDir);
  assert.ok(entries.get("marketing-studio/image")?.tags.includes("product-shots"));
  assert.ok(!entries.has("product-shots"));
  assert.ok(![...entries.keys()].some((id) => id.startsWith("higgsfiled/")));
  assert.ok(readFileSync(options.reportFile!, "utf8").includes("## Newly released"));
  assert.equal(existsSync(options.checkpointDir!), false);
});

test("repeat sync is stable, invalidates reader caches and removes only unreferenced schema hashes", async (t) => {
  const options = setup(t);
  await runHiggsfieldSync({ ...options, fromFixtures: fixtures });
  loadProviderCatalog("higgsfield", options.outDir);
  writeFileSync(path.join(options.schemaDir!, `${"0".repeat(64)}.json`), "{}");
  writeFileSync(path.join(options.schemaDir!, "keep.txt"), "keep");
  const result = await runHiggsfieldSync({ ...options, fromFixtures: fixtures });
  assert.deepEqual(result.drift.added, []);
  assert.deepEqual(result.drift.gone, []);
  assert.deepEqual(result.drift.schemaChanged, []);
  assert.deepEqual(result.drift.newlyReleased, []);
  assert.equal(existsSync(path.join(options.schemaDir!, `${"0".repeat(64)}.json`)), false);
  assert.equal(existsSync(path.join(options.schemaDir!, "keep.txt")), true);
});

test("dry-run computes the complete index without catalogue, schema, report or checkpoint writes", async (t) => {
  const options = setup(t);
  const result = await runHiggsfieldSync({
    ...options,
    dryRun: true,
    fetchImpl: fakeFetch((url) => new Response(fixturePage(url))),
  });
  assert.equal(result.entries, 88);
  assert.deepEqual(result.written, []);
  assert.deepEqual(readdirSync(options.root), []);
});

test("catalogue failure is soft, warns and indexes all docs; successful requests remain anonymous GETs", async (t) => {
  const options = setup(t),
    warnings: string[] = [];
  const result = await runHiggsfieldSync({
    ...options,
    log: (message) => warnings.push(message),
    fetchImpl: fakeFetch((url, init) => {
      assert.equal(init?.method, "GET");
      assert.equal(init?.credentials, "omit");
      assert.equal(init?.redirect, "error");
      const headers = new Headers(init?.headers);
      assert.equal(headers.has("authorization"), false);
      assert.equal(headers.has("cookie"), false);
      assert.equal([...headers.keys()].length, 1);
      assert.ok(headers.get("user-agent"));
      return new Response(url === HF_CATALOG_URL ? "unavailable" : fixturePage(url), {
        status: url === HF_CATALOG_URL ? 404 : 200,
      });
    }),
  });
  assert.equal(result.entries, 84);
  assert.equal(result.warnings.length, 1);
  assert.deepEqual(warnings, result.warnings);
  assert.deepEqual(result.familiesWithoutDocs, []);
});

test("documentation failures are fatal and leave the published index untouched", async (t) => {
  const options = setup(t);
  await runHiggsfieldSync({ ...options, fromFixtures: fixtures });
  const before = readFileSync(path.join(options.outDir!, "image-to-video.json"), "utf8");
  await assert.rejects(
    runHiggsfieldSync({ ...options, fetchImpl: fakeFetch(() => new Response("missing", { status: 404 })) }),
    /404/,
  );
  assert.equal(readFileSync(path.join(options.outDir!, "image-to-video.json"), "utf8"), before);
});

test("resume reuses every successful checkpoint after a halfway network failure", async (t) => {
  const options = setup(t),
    counts = new Map<string, number>();
  let broken = true;
  const target = `${HF_DOCS_BASE}seedance-2-5/reference-to-video.md`;
  const fetchImpl = fakeFetch((url) => {
    counts.set(url, (counts.get(url) ?? 0) + 1);
    if (url === target && broken) throw new TypeError("Disconnected");
    return new Response(fixturePage(url));
  });
  await assert.rejects(runHiggsfieldSync({ ...options, fetchImpl, maxRetries: 0 }), /retries exhausted/);
  assert.equal(existsSync(options.outDir!), false);
  const fetched = [...counts.keys()].filter((url) => url !== target);
  assert.ok(fetched.length > 40);
  broken = false;
  const result = await runHiggsfieldSync({ ...options, fetchImpl, resume: true });
  assert.equal(result.entries, 88);
  for (const url of fetched) assert.equal(counts.get(url), 1, url);
  assert.equal(counts.get(target), 2);
});

test("retries transient network errors and 5xx with capped backoff, honours 429 Retry-After", async (t) => {
  const options = setup(t),
    waits: number[] = [];
  let attempts = 0;
  const result = await runHiggsfieldSync({
    ...options,
    maxRetries: 4,
    sleep: async (ms) => {
      waits.push(ms);
    },
    fetchImpl: fakeFetch((url) => {
      if (url === `${HF_DOCS_BASE}video-generation.md`) {
        attempts++;
        if (attempts === 1) throw new TypeError("Connection reset");
        if (attempts === 2) return new Response("bad gateway", { status: 502 });
        if (attempts === 3) return new Response("slow down", { status: 429, headers: { "Retry-After": "3" } });
        if (attempts === 4) return new Response("temporarily unavailable", { status: 503 });
      }
      return new Response(fixturePage(url));
    }),
  });
  assert.equal(result.entries, 88);
  assert.deepEqual(waits, [1000, 2000, 3000, 8000]);
  assert.equal(attempts, 5);
});

test("HTTP date Retry-After is honoured and excessive waits return RATE_LIMIT", async (t) => {
  const options = setup(t),
    waits: number[] = [];
  let first = true;
  await runHiggsfieldSync({
    ...options,
    dryRun: true,
    sleep: async (ms) => {
      waits.push(ms);
    },
    fetchImpl: fakeFetch((url) => {
      if (first) {
        first = false;
        return new Response("wait", { status: 429, headers: { "Retry-After": "Sun, 15 Nov 2026 12:00:05 GMT" } });
      }
      return new Response(fixturePage(url));
    }),
  });
  assert.deepEqual(waits, [5000]);
  await assert.rejects(
    runHiggsfieldSync({
      ...options,
      fetchImpl: fakeFetch(() => new Response("wait", { status: 429, headers: { "Retry-After": "120" } })),
    }),
    { code: "RATE_LIMIT", retryAfterMs: 120000 },
  );
});

test("catalogue pagination follows only the allowed public catalogue URL", async (t) => {
  const options = setup(t),
    pages: string[] = [];
  const rows = JSON.parse(fixturePage(HF_CATALOG_URL)).results as unknown[];
  const next = `${HF_CATALOG_URL}&page=2`;
  const result = await runHiggsfieldSync({
    ...options,
    fetchImpl: fakeFetch((url) => {
      if (url.startsWith("https://dash.higgsfield.ai/")) {
        pages.push(url);
        return Response.json({
          results: url === next ? rows.slice(10) : rows.slice(0, 10),
          next: url === next ? null : next,
        });
      }
      return new Response(fixturePage(url));
    }),
  });
  assert.deepEqual(pages, [HF_CATALOG_URL, next]);
  assert.equal(result.entries, 88);
  const rejected = await runHiggsfieldSync({
    ...options,
    dryRun: true,
    fetchImpl: fakeFetch((url) =>
      url === HF_CATALOG_URL
        ? Response.json({ results: rows, next: "https://api.higgsfield.ai/private" })
        : new Response(fixturePage(url)),
    ),
  });
  assert.equal(rejected.entries, 88);
  assert.equal(rejected.warnings.length, 1);
});

test("schema drift removes stale files, reports changed schemas and retains gone entries", async (t) => {
  const options = setup(t);
  await runHiggsfieldSync({ ...options, fromFixtures: fixtures });
  const previous = [...loadProviderCatalog("higgsfield", options.outDir).values()];
  const exemplar = previous[0]!;
  writeCatalog(
    [...previous, { ...exemplar, endpoint: "example/gone", schema: null, docsUrl: undefined }],
    options.outDir!,
    { provider: "higgsfield" },
  );
  const result = await runHiggsfieldSync({
    ...options,
    fetchImpl: fakeFetch((url) => new Response(fixturePage(url).replace('"maxLength": 10000', '"maxLength": 9999'))),
  });
  assert.ok(result.drift.schemaChanged.length);
  assert.deepEqual(result.drift.gone, ["example/gone"]);
  assert.equal(loadProviderCatalog("higgsfield", options.outDir).get("example/gone")?.status, "gone");
  for (const row of result.drift.schemaChanged) {
    assert.ok(existsSync(path.join(options.schemaDir!, `${row.to}.json`)));
    if (
      ![...loadProviderCatalog("higgsfield", options.outDir).values()].some(
        (entry) => entry.schema?.sha256 === row.from,
      )
    )
      assert.equal(existsSync(path.join(options.schemaDir!, `${row.from}.json`)), false);
  }
});

test("hash-sharing endpoints still resolve their own provider identity", async (t) => {
  const options = setup(t);
  await runHiggsfieldSync({ ...options, fromFixtures: fixtures });
  for (const entry of loadProviderCatalog("higgsfield", options.outDir).values())
    if (entry.schema) {
      const snapshot = resolveProviderSnapshot("higgsfield", entry.endpoint, {
        dir: options.outDir,
        schemaDir: options.schemaDir,
      })!;
      assert.equal(snapshot.endpoint, entry.endpoint);
      assert.equal(snapshot.schemaSource, entry.docsUrl);
    }
});

test("CLI offline dry-run emits exactly one JSON line and no provider access", (t) => {
  const options = setup(t);
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--import",
      "./tests/helpers/fal-no-network.ts",
      "scripts/hf-sync.ts",
      "--from-fixtures",
      fixtures,
      "--dry-run",
    ],
    {
      cwd: path.resolve("."),
      encoding: "utf8",
      env: {
        AGENTBROS_NO_DOTENV: "1",
        PATH: process.env.PATH,
        AGENTBROS_MEMORY_ROOT: process.env.AGENTBROS_MEMORY_ROOT,
        AGENTBROS_HF_CATALOG_DIR: options.outDir,
        AGENTBROS_HF_SCHEMA_DIR: options.schemaDir,
      },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim().split("\n").length, 1);
  const line = JSON.parse(result.stdout);
  assert.equal(line.ok, true);
  assert.equal(line.metadata.entries, 88);
  assert.equal(existsSync(options.outDir!), false);
});
