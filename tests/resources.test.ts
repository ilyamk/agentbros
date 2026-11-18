import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ResourceService } from "../src/lib/resources/service";
import {
  rightsFromLicence,
  normalizeLicence,
  evaluateResourceUsage,
  confirmResourceLicence,
  resourceLicenceReport,
} from "../src/lib/resources/rights";
import { listResourceProviders } from "../src/lib/resources/registry";
import type { ResourceCandidate } from "../src/types/resources";
const time = "2026-10-11T00:00:00.000Z";
const sourceUrl = "https://example.com/original";
function candidate(licence: string, verifiedAtSource = true): ResourceCandidate {
  return {
    id: "fixture:1",
    provider: "openverse",
    kind: "image",
    title: "Example",
    author: "Artist",
    sourceUrl,
    acquisition: "original-source",
    media: {},
    tags: [],
    cost: { status: "free" },
    rights: rightsFromLicence({
      licence,
      title: "Example",
      author: "Artist",
      sourceUrl,
      verifiedAtSource,
      checkedAsOf: time,
    }),
  };
}
function mockFetch(responses: unknown[], calls: { url: string; headers?: HeadersInit }[]) {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), headers: init?.headers });
    const response = responses.shift();
    if (response instanceof Response) return response;
    return new Response(JSON.stringify(response), { headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

test("licence classifier rejects NC/ND and requires attribution/ShareAlike/source confirmation", () => {
  assert.equal(normalizeLicence("http://creativecommons.org/publicdomain/zero/1.0/").code, "CC0");
  assert.equal(evaluateResourceUsage(candidate("CC BY 4.0"), { commercial: true }).allowed, true);
  assert.equal(evaluateResourceUsage(candidate("CC BY-NC 4.0"), { commercial: true }).allowed, false);
  assert.equal(evaluateResourceUsage(candidate("CC BY-ND 4.0"), { commercial: true, modified: true }).allowed, false);
  assert.equal(evaluateResourceUsage(candidate("CC BY-SA 4.0"), { commercial: true }).allowed, false);
  assert.equal(
    evaluateResourceUsage(candidate("CC BY-SA 4.0"), { commercial: true, acceptShareAlike: true }).allowed,
    true,
  );
  assert.equal(evaluateResourceUsage(candidate("unknown"), {}).allowed, false);
  const selected = candidate("CC BY 4.0", false);
  assert.equal(evaluateResourceUsage(selected, { commercial: true }).allowed, false);
  assert.throws(
    () => confirmResourceLicence(selected, { sourceUrl: "https://example.com/wrong", licence: "CC0" }),
    /original/,
  );
  const confirmed = confirmResourceLicence(selected, { sourceUrl, licence: "CC BY 4.0", checkedAsOf: time });
  assert.equal(evaluateResourceUsage(confirmed, { commercial: true }).allowed, true);
  const report = resourceLicenceReport([confirmed], { commercial: true });
  assert.ok(report.allowed);
  assert.match(report.markdown, /Artist/);
  assert.match(report.markdown, /CC BY/);
});
test("Pexels restrictions and platform-only music never imply cross-platform rights", () => {
  assert.equal(evaluateResourceUsage(candidate("Pexels"), { commercial: true, endorsement: true }).allowed, false);
  const track = {
    ...candidate("CC0"),
    provider: "tiktok-cml" as const,
    rights: { ...candidate("CC0").rights, allowedPlacements: ["tiktok"] },
  };
  assert.equal(evaluateResourceUsage(track, { commercial: true, placements: ["youtube"] }).allowed, false);
  const manual = listResourceProviders().filter((provider) =>
    ["mixkit", "epidemic-sound", "tiktok-cml"].includes(provider.id),
  );
  assert.ok(manual.every((provider) => !provider.search && !provider.acquire && provider.route === "manual"));
});
test("Openverse metadata remains unverified and search fields/routes are correct", async () => {
  const calls: { url: string; headers?: HeadersInit }[] = [];
  const item = {
    id: "abc",
    title: "Photo",
    creator: "Artist",
    foreign_landing_url: sourceUrl,
    url: "https://example.com/file.png",
    thumbnail: "https://example.com/preview.png",
    license: "by",
    license_version: "4.0",
    license_url: "https://creativecommons.org/licenses/by/4.0/",
    width: 100,
    height: 80,
    tags: [{ name: "education" }],
  };
  const service = new ResourceService({ fetch: mockFetch([{ results: [item] }, item], calls), now: () => time });
  const [found] = await service.search("openverse", { query: "education", kind: "image", commercial: true });
  assert.equal(found.rights.verifiedAtSource, false);
  assert.equal(found.rights.commercialAllowed, true);
  assert.equal(found.sourceUrl, sourceUrl);
  assert.match(calls[0].url, /license_type=commercial/);
  const inspected = await service.inspect(found);
  assert.equal(inspected.id, found.id);
  assert.match(calls[1].url, /v1\/images\/abc\//);
  await assert.rejects(() => service.search("openverse", { query: "x", kind: "video" }), /not video/);
});
test("Wikimedia licence and HTML author normalize to attributable file evidence", async () => {
  const calls: { url: string; headers?: HeadersInit }[] = [];
  const page = {
    pageid: 42,
    title: "File:Diagram.png",
    imageinfo: [
      {
        url: "https://upload.wikimedia.org/file.png",
        descriptionurl: sourceUrl,
        width: 100,
        height: 80,
        mime: "image/png",
        extmetadata: {
          Artist: { value: '<a href="https://example.com/artist">Artist</a>' },
          LicenseShortName: { value: "CC BY-SA 4.0" },
          LicenseUrl: { value: "https://creativecommons.org/licenses/by-sa/4.0/" },
        },
      },
    ],
  };
  const service = new ResourceService({
    fetch: mockFetch([{ query: { pages: { "42": page } } }], calls),
    now: () => time,
  });
  const [found] = await service.search("wikimedia", { query: "diagram", kind: "image" });
  assert.equal(found.author, "Artist");
  assert.equal(found.rights.shareAlike, true);
  assert.equal(found.rights.verifiedAtSource, true);
  assert.match(calls[0].url, /iiprop=url%7Csize%7Cmime%7Cextmetadata/);
  assert.ok(new Headers(calls[0].headers).get("User-Agent"));
});
test("Pexels video selects highest resolution and preserves creator/source licence", async () => {
  const calls: { url: string; headers?: HeadersInit }[] = [];
  const item = {
    id: 1,
    width: 1920,
    height: 1080,
    duration: 10,
    url: sourceUrl,
    image: "https://example.com/preview.jpg",
    user: { name: "Creator" },
    video_files: [
      { width: 640, height: 360, link: "https://example.com/sd.mp4" },
      { width: 1920, height: 1080, link: "https://example.com/hd.mp4" },
    ],
  };
  const service = new ResourceService({
    fetch: mockFetch([{ videos: [item] }], calls),
    credentials: { pexels: "fixture-key" },
    now: () => time,
  });
  const [found] = await service.search("pexels", { query: "b-roll", kind: "video" });
  assert.equal(found.downloadUrl, "https://example.com/hd.mp4");
  assert.match(found.rights.attributionText, /Creator/);
  assert.equal(new Headers(calls[0].headers).get("Authorization"), "fixture-key");
});
test("Freesound original acquisition requires OAuth; previews and originals remain distinct", async () => {
  const calls: { url: string; headers?: HeadersInit }[] = [];
  const item = {
    id: 7,
    name: "click",
    username: "Foley",
    duration: 1,
    url: sourceUrl,
    license: "https://creativecommons.org/publicdomain/zero/1.0/",
    previews: { "preview-hq-mp3": "https://example.com/preview.mp3" },
  };
  const service = new ResourceService({
    fetch: mockFetch([{ results: [item] }], calls),
    credentials: { freesound: "fixture" },
    now: () => time,
  });
  const [found] = await service.search("freesound", { query: "click", kind: "audio", commercial: true });
  assert.equal(found.acquisition, "oauth-original");
  assert.equal(found.previewUrl, "https://example.com/preview.mp3");
  assert.match(found.originalDownloadUrl!, /sounds\/7\/download/);
  await assert.rejects(() => service.acquire(found, { projectId: "fixture", usage: { commercial: true } }), /OAuth/);
});
test("selected resource imports immutable local media and writes full rights receipt", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "resource-import-"));
  try {
    const project = path.join(root, "public/projects/demo");
    mkdirSync(project, { recursive: true });
    writeFileSync(path.join(project, "project.json"), "{}");
    const file = path.join(root, "source.png");
    writeFileSync(
      file,
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=",
        "base64",
      ),
    );
    const service = new ResourceService({
      fetch: (async () => {
        throw new Error("No network allowed");
      }) as typeof fetch,
      now: () => time,
    });
    const imported = await service.acquire(candidate("CC BY 4.0"), {
      projectId: "demo",
      rootDir: root,
      sourceFile: file,
      usage: { commercial: true },
    });
    assert.equal(imported.asset.provenance.origin, "stock");
    assert.match(imported.asset.rights.attribution!, /Artist/);
    const receipt = JSON.parse(readFileSync(imported.resourceReceipt, "utf8"));
    assert.equal(receipt.assetId, imported.asset.id);
    assert.equal(receipt.resource.rights.verifiedAtSource, true);
    await assert.rejects(
      () => service.acquire(candidate("unknown"), { projectId: "demo", rootDir: root, sourceFile: file, usage: {} }),
      /blocked/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
