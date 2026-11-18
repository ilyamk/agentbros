import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { OpenverseClient, freesoundSourceId, openverseLicence, openverseParams } from "../src/lib/resources/openverse";
import { ResourceService } from "../src/lib/resources/service";
import { confirmResourceLicence } from "../src/lib/resources/rights";
import { ResourceHttpError } from "../src/lib/resources/http";

const json = (value: unknown, status = 200, headers = {}) => new Response(JSON.stringify(value), { status, headers });
test("Openverse filters form an intersection and reject incompatible media before fetching", () => {
  const params = openverseParams({
    query: "wood",
    kind: "audio",
    modified: true,
    commercial: true,
    openverse: { category: "sound_effect", length: "shortest", licences: ["cc0", "by"], source: "freesound" },
  });
  assert.equal(params.get("license_type"), "commercial,modification");
  assert.equal(params.get("license"), "cc0,by");
  assert.equal(params.get("length"), "shortest");
  for (const search of [
    { kind: "audio", openverse: { aspectRatio: "wide" } },
    { kind: "image", openverse: { length: "short" } },
    { kind: "video" },
  ])
    assert.throws(() => openverseParams({ query: "x", ...search } as Parameters<typeof openverseParams>[0]));
  assert.equal(openverseLicence({ license: "cc0", license_version: "1.0" }), "CC0 1.0");
  assert.equal(openverseLicence({ license: "pdm" }), "PDM");
  assert.equal(freesoundSourceId("https://freesound.org/people/artist/sounds/7/"), "7");
  assert.equal(freesoundSourceId("https://freesound.org.evil.test/people/artist/sounds/7/"), undefined);
});

test("public metadata coalesces concurrent requests and expires without persisting tokens", async (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "openverse-cache-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let now = 1000,
    calls = 0;
  const request = (async (_url, init) => {
    calls++;
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer FAKE_TEST_ONLY");
    await new Promise((resolve) => setImmediate(resolve));
    return json({ results: [{ id: calls }] });
  }) as typeof fetch;
  const client = new OpenverseClient({
    fetch: request,
    credentials: { accessToken: "FAKE_TEST_ONLY" },
    cacheDir: directory,
    now: () => now,
  });
  const [one, two] = await Promise.all([client.json("audio/?q=wood"), client.json("audio/?q=wood")]);
  assert.deepEqual(one, two);
  assert.equal(calls, 1);
  one.results.length = 0;
  assert.equal((await client.json("audio/?q=wood")).results.length, 1);
  assert.equal(calls, 1);
  const files = readdirSync(directory);
  assert.equal(files.length, 1);
  assert.ok(!readFileSync(path.join(directory, files[0]!), "utf8").includes("FAKE_TEST_ONLY"));
  await client.json("audio/?q=wood", { fresh: true });
  assert.equal(calls, 2);
  now += 15 * 60_000;
  await client.json("audio/?q=wood");
  assert.equal(calls, 3);
});

test("OAuth refreshes once on 401 and never falls back to anonymous", async () => {
  let tokens = 0,
    reads = 0;
  const request = (async (url, init) => {
    if (String(url).includes("auth_tokens")) {
      tokens++;
      assert.equal(init?.method, "POST");
      return json({ access_token: `FAKE_${tokens}`, expires_in: 3600 });
    }
    reads++;
    assert.equal(new Headers(init?.headers).get("authorization"), `Bearer FAKE_${tokens}`);
    return reads === 1 ? json({}, 401) : json({ results: [] });
  }) as typeof fetch;
  const client = new OpenverseClient({ fetch: request, credentials: { clientId: "FAKE", clientSecret: "FAKE" } });
  await client.json("images/?q=test");
  assert.equal(tokens, 2);
  assert.equal(reads, 2);
  let calls = 0;
  const refused = new OpenverseClient({
    credentials: { accessToken: "FAKE" },
    fetch: (async () => {
      calls++;
      return json({}, 401);
    }) as typeof fetch,
  });
  await assert.rejects(
    refused.json("images/?q=test"),
    (error) => error instanceof ResourceHttpError && error.status === 401,
  );
  assert.equal(calls, 1);
});

test("429 preserves Retry-After without retry; 5xx retries once and malformed responses do not", async () => {
  for (const status of [429, 404]) {
    let calls = 0;
    const client = new OpenverseClient({
      fetch: (async () => {
        calls++;
        return json({}, status, { "Retry-After": "12" });
      }) as typeof fetch,
    });
    await assert.rejects(
      client.json("audio/?q=test"),
      (error) => error instanceof ResourceHttpError && error.status === status && error.retryAfterMs === 12000,
    );
    assert.equal(calls, 1);
  }
  let calls = 0;
  const transient = new OpenverseClient({
    sleep: async () => {},
    fetch: (async () => (++calls === 1 ? json({}, 503) : json({ results: [] }))) as typeof fetch,
  });
  await transient.json("audio/?q=test");
  assert.equal(calls, 2);
  calls = 0;
  const invalid = new OpenverseClient({
    fetch: (async () => {
      calls++;
      return new Response("{");
    }) as typeof fetch,
  });
  await assert.rejects(invalid.json("audio/?q=test"));
  assert.equal(calls, 1);
});

test("audio discovery keeps its thumbnail separate and cannot acquire a preview as original", async () => {
  const item = {
    id: "abc",
    source: "freesound",
    provider: "freesound",
    title: "Wood",
    creator: "Artist",
    foreign_landing_url: "https://freesound.org/people/artist/sounds/7/",
    url: "https://cdn.freesound.org/preview.mp3",
    thumbnail: "https://cdn.freesound.org/cover.png",
    license: "cc0",
    license_version: "1.0",
  };
  const calls: string[] = [];
  const request = (async (url) => {
    calls.push(String(url));
    return json(
      String(url).includes("api.openverse")
        ? String(url).includes("/abc/")
          ? item
          : { results: [item] }
        : {
            id: 7,
            name: "Wood",
            url: item.foreign_landing_url,
            license: "https://creativecommons.org/publicdomain/zero/1.0/",
          },
    );
  }) as typeof fetch;
  const service = new ResourceService({ fetch: request, credentials: { freesound: "FAKE" } });
  const [candidate] = await service.search("openverse", { query: "wood", kind: "audio" });
  assert.equal(candidate.previewUrl, item.url);
  assert.equal(candidate.thumbnailUrl, item.thumbnail);
  assert.equal(candidate.downloadUrl, undefined);
  assert.equal(candidate.upstream?.fileRole, "preview");
  assert.equal(candidate.rights.verifiedAtSource, false);
  const confirmed = confirmResourceLicence(candidate, { sourceUrl: item.foreign_landing_url, licence: "CC0" });
  await assert.rejects(service.acquire(confirmed, { projectId: "unused", usage: { commercial: true } }), /OAuth/);
  assert.ok(calls.some((url) => url.includes("/sounds/7/")));
  assert.ok(!calls.includes(item.url));
  const legacy = { ...confirmed, downloadUrl: item.url, acquisition: "original-source" as const };
  delete legacy.upstream;
  await assert.rejects(service.acquire(legacy, { projectId: "unused", usage: {} }), /OAuth/);
  assert.ok(!calls.includes(item.url));
});

test("Jamendo previews cannot bypass commercial policy and changed attribution reopens confirmation", async () => {
  const item = {
    id: "j",
    source: "jamendo",
    title: "Track",
    creator: "Artist",
    foreign_landing_url: "https://www.jamendo.com/track/1",
    url: "https://preview.example/track.mp3",
    license: "by",
    license_version: "4.0",
  };
  const urls: string[] = [];
  const service = new ResourceService({
    fetch: (async (url) => {
      urls.push(String(url));
      return json(String(url).includes("/j/") ? item : { results: [item] });
    }) as typeof fetch,
  });
  const [found] = await service.search("openverse", { query: "track", kind: "audio" });
  const confirmed = confirmResourceLicence(found, { sourceUrl: item.foreign_landing_url, licence: "CC BY 4.0" });
  await assert.rejects(
    service.acquire(confirmed, { projectId: "unused", mode: "preview", usage: { commercial: true } }),
    /Jamendo/,
  );
  assert.ok(!urls.includes(item.url));
  item.creator = "Corrected Artist";
  await assert.rejects(service.acquire(confirmed, { projectId: "unused", mode: "preview", usage: {} }), /attribution/);
});

test("memory cache evicts by bytes, not only by entry count", async () => {
  let calls = 0;
  const value = { results: [], payload: "x".repeat(3 * 1024 * 1024) };
  const client = new OpenverseClient({
    fetch: (async () => {
      calls++;
      return json(value);
    }) as typeof fetch,
  });
  for (let index = 0; index < 12; index++) await client.json(`images/?q=${index}`);
  await client.json("images/?q=11");
  assert.equal(calls, 12);
  await client.json("images/?q=0");
  assert.equal(calls, 13);
});
