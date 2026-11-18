import test from "node:test";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { NasaResources } from "../src/lib/resources/nasa";
import { ResourceService } from "../src/lib/resources/service";
import { resourceCatalogue, recommendResourceRoutes } from "../src/lib/resources/catalogues";
import { listResourceProviders } from "../src/lib/resources/registry";
import { confirmResourceLicence, evaluateResourceUsage, rightsFromLicence } from "../src/lib/resources/rights";
import type { ResourceCandidate } from "../src/types/resources";
const now = () => "2026-10-11T00:00:00.000Z";
const preview = "https://images-assets.nasa.gov/image/moon/moon~thumb.jpg";
function result(kind = "image", href = preview) {
  return {
    collection: {
      items: [
        {
          data: [{ nasa_id: "moon", media_type: kind, title: "Moon", center: "JSC", keywords: ["science"] }],
          links: [{ href, rel: "preview" }],
        },
      ],
    },
  };
}
function fixtureFetch(responses: unknown[], calls: { url: string; init?: RequestInit }[] = []) {
  return (async (url, init) => {
    calls.push({ url: String(url), init });
    const value = responses.shift();
    if (value instanceof Response) return value;
    return new Response(JSON.stringify(value));
  }) as typeof fetch;
}

test("NASA injected metadata search sets explicit pagination, keeps unknown rights and distinct preview", async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const service = new ResourceService({ fetch: fixtureFetch([result()], calls), now });
  const [item] = await service.search("nasa", { query: "moon & earth", kind: "image", page: 2, limit: 3 });
  const url = new URL(calls[0].url);
  assert.equal(url.searchParams.get("q"), "moon & earth");
  assert.equal(url.searchParams.get("page"), "2");
  assert.equal(url.searchParams.get("page_size"), "3");
  assert.equal(calls[0].init?.redirect, "error");
  assert.ok(calls[0].init?.signal);
  assert.equal(item.downloadUrl, undefined);
  assert.equal(item.acquisition, "manual");
  assert.equal(item.rights.verifiedAtSource, false);
  assert.equal(item.rights.commercialAllowed, "unknown");
  assert.equal(evaluateResourceUsage(item, { commercial: true }).allowed, false);
});
test("NASA manifest exposes a unique explicit original only and never promotes previews", async () => {
  const client = new NasaResources({
    fetch: fixtureFetch([
      result(),
      {
        collection: { items: [{ href: preview }, { href: "https://images-assets.nasa.gov/image/moon/moon~orig.jpg" }] },
      },
    ]),
    now,
  });
  const [found] = await client.search({ query: "moon", kind: "image" });
  const inspected = await client.inspect(found);
  assert.match(inspected.originalDownloadUrl!, /~orig.jpg$/);
  assert.equal(inspected.downloadUrl, undefined);
  assert.equal(inspected.rights.verifiedAtSource, false);
  const ambiguous = new NasaResources({
    fetch: fixtureFetch([
      {
        collection: {
          items: [
            { href: "https://images-assets.nasa.gov/image/moon/moon~orig.jpg" },
            { href: "https://images-assets.nasa.gov/image/moon/moon~orig.tif" },
          ],
        },
      },
    ]),
    now,
  });
  assert.equal((await ambiguous.inspect(found)).originalDownloadUrl, undefined);
  for (const [kind, extension] of [
    ["video", "mp4"],
    ["audio", "mp3"],
  ] as const) {
    const previewUrl = `https://images-assets.nasa.gov/${kind}/moon/moon~preview.${extension}`;
    const original = `https://images-assets.nasa.gov/${kind}/moon/moon~orig.${extension}`;
    const mediaClient = new NasaResources({
      fetch: fixtureFetch([
        result(kind, previewUrl),
        { collection: { items: [{ href: previewUrl }, { href: original }] } },
      ]),
      now,
    });
    const [media] = await mediaClient.search({ query: "moon", kind });
    assert.equal(media.kind, kind);
    assert.equal((await mediaClient.inspect(media)).originalDownloadUrl, original);
  }
  const missing = new NasaResources({
    fetch: fixtureFetch([
      {
        collection: {
          items: [{ href: preview }, { href: "https://images-assets.nasa.gov/image/moon/metadata~orig.json" }],
        },
      },
    ]),
    now,
  });
  assert.equal((await missing.inspect(found)).originalDownloadUrl, undefined);
});
test("NASA rejects malformed schema, media mismatch, untrusted asset URLs and pagination before requests", async () => {
  for (const raw of [
    {},
    result("video"),
    result("image", "https://evil.example/image/moon/x.jpg"),
    result("image", "https://images-assets.nasa.gov/image/another/x.jpg"),
    result("image", "https://images-assets.nasa.gov/image/moon/x.jpg?token=y"),
  ]) {
    const client = new NasaResources({ fetch: fixtureFetch([raw]), now });
    await assert.rejects(() => client.search({ query: "moon", kind: "image" }));
  }
  const calls: { url: string; init?: RequestInit }[] = [];
  const client = new NasaResources({ fetch: fixtureFetch([], calls), now });
  for (const input of [
    { query: "", kind: "image" as const },
    { query: "x", kind: "image" as const, page: 1.5 },
    { query: "x", kind: "image" as const, limit: 51 },
    { query: "x", kind: "image" as const, page: Number.MAX_SAFE_INTEGER },
  ])
    await assert.rejects(() => client.search(input));
  assert.equal(calls.length, 0);
});
test("NASA byte bounds, streamed oversize and redirects fail closed", async () => {
  for (const response of [
    new Response("{}", { headers: { "content-length": "101" } }),
    new Response("x".repeat(101)),
    new Response("{}", { status: 302, headers: { location: "https://evil.example" } }),
  ]) {
    const client = new NasaResources({ fetch: fixtureFetch([response]), maxMetadataBytes: 100, now });
    await assert.rejects(() => client.search({ query: "x", kind: "image" }));
  }
  assert.throws(() => new NasaResources({ maxMetadataBytes: 0 }), /byte bound/);
});
test("NASA original source binding and manifest URLs are checked before use", async () => {
  const client = new NasaResources({
    fetch: fixtureFetch([result(), { collection: { items: [{ href: "https://evil.example/a~orig.jpg" }] } }]),
    now,
  });
  const [found] = await client.search({ query: "x", kind: "image" });
  await assert.rejects(() => client.inspect({ ...found, sourceUrl: "https://evil.example" }), /source page/);
  await assert.rejects(() => client.inspect(found), /Untrusted/);
});
test("NASA generic CC0 confirmation cannot clear advertising or endorsement; confirmation preserves placements", async () => {
  const client = new NasaResources({ fetch: fixtureFetch([result()]), now });
  const [found] = await client.search({ query: "x", kind: "image" });
  const confirmed = confirmResourceLicence(found, { sourceUrl: found.sourceUrl, licence: "CC0", checkedAsOf: now() });
  assert.equal(confirmed.rights.attributionRequired, true);
  assert.match(confirmed.rights.attributionText, /NASA source:/);
  assert.ok(confirmed.rights.attributionText.includes(found.sourceUrl));
  const missingCredit = {
    ...confirmed,
    rights: { ...confirmed.rights, attributionRequired: false as const, attributionText: "" },
  };
  assert.equal(evaluateResourceUsage(missingCredit, {}).allowed, false);
  for (const usage of [{ advertising: true }, { endorsement: true }, { standaloneResale: true }])
    assert.equal(evaluateResourceUsage(confirmed, usage).allowed, false);
  const native = {
    ...confirmed,
    provider: "tiktok-cml" as const,
    rights: { ...confirmed.rights, allowedPlacements: ["tiktok"] },
  };
  const reconfirmed = confirmResourceLicence(native, { sourceUrl: native.sourceUrl, licence: "CC0" });
  assert.deepEqual(reconfirmed.rights.allowedPlacements, ["tiktok"]);
  assert.equal(evaluateResourceUsage(reconfirmed, { placements: ["youtube"] }).allowed, false);
});
test("manual catalogues and recommendations honestly expose task-specific routes without requests", () => {
  for (const provider of ["kenney", "ambientcg", "rive"]) {
    const route = resourceCatalogue(provider, "icons");
    assert.equal(route.searchImplemented, false);
    assert.equal(route.acquisition, "local-file-import");
    assert.equal(route.query, "icons");
    const registry = listResourceProviders().find((item) => item.id === provider)!;
    assert.equal(registry.search, false);
    assert.equal(registry.acquire, false);
    assert.equal(registry.verification.live, false);
  }
  assert.ok(recommendResourceRoutes("educational-archive").api.some((item) => item.provider === "nasa"));
  assert.ok(recommendResourceRoutes("sound-effects").manual.some((item) => item.id === "kenney"));
  assert.ok(recommendResourceRoutes("motion-design").manual.some((item) => item.id === "rive"));
  assert.throws(() => resourceCatalogue("imaginary"));
  assert.throws(() => recommendResourceRoutes("imaginary"));
});
test("manual original Kenney source imports exact bytes with receipt; unconfirmed originals are blocked", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "catalogue-import-"));
  try {
    const project = path.join(root, "public/projects/demo");
    mkdirSync(project, { recursive: true });
    writeFileSync(path.join(project, "project.json"), "{}");
    const source = path.join(root, "original.png");
    const bytes = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=",
      "base64",
    );
    writeFileSync(source, bytes);
    const sourceUrl = "https://kenney.nl/assets/ui-pack";
    const selected: ResourceCandidate = {
      id: "kenney:ui",
      provider: "kenney",
      kind: "image",
      title: "UI icon",
      author: "Kenney",
      sourceUrl,
      acquisition: "manual",
      media: {},
      tags: [],
      cost: { status: "free" },
      rights: rightsFromLicence({
        licence: "CC0",
        title: "UI icon",
        author: "Kenney",
        sourceUrl,
        verifiedAtSource: false,
        checkedAsOf: now(),
      }),
    };
    const service = new ResourceService({
      fetch: (async () => {
        throw new Error("No real API allowed");
      }) as typeof fetch,
      now,
    });
    await assert.rejects(
      () =>
        service.acquire(selected, {
          rootDir: root,
          projectId: "demo",
          sourceFile: source,
          usage: { commercial: true },
        }),
      /blocked/,
    );
    const confirmed = confirmResourceLicence(selected, {
      sourceUrl,
      licence: "CC0",
      licenceUrl: "https://creativecommons.org/publicdomain/zero/1.0/",
      checkedAsOf: now(),
    });
    const imported = await service.acquire(confirmed, {
      rootDir: root,
      projectId: "demo",
      sourceFile: source,
      usage: { commercial: true },
    });
    assert.deepEqual(readFileSync(path.join(root, "public", imported.asset.files.original)), bytes);
    const receipt = JSON.parse(readFileSync(imported.resourceReceipt, "utf8"));
    assert.equal(receipt.mode, "original");
    assert.equal(receipt.resource.provider, "kenney");
    assert.equal(receipt.resource.rights.verifiedAtSource, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resource route CLI emits one JSON line and malformed tasks produce structured failure without network", () => {
  const invoke = (args: string[]) =>
    spawnSync(process.execPath, ["--import", "tsx", "scripts/resources.ts", ...args], {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 30_000,
    });
  for (const args of [
    ["--action", "route", "--task", "sound-effects"],
    ["--action", "catalog", "--provider", "ambientcg", "--query", "wood"],
    ["--action", "providers"],
  ]) {
    const result = invoke(args);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim().split("\n").length, 1);
    assert.equal(JSON.parse(result.stdout).ok, true);
  }
  const invalid = invoke(["--action", "route", "--task", "invented"]);
  assert.notEqual(invalid.status, 0);
  assert.equal(JSON.parse(invalid.stdout).ok, false);
});
