import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import test from "node:test";
import { spawnSync } from "node:child_process";
import path from "node:path";
import {
  acquireRemoteMedia,
  pageMediaCandidates,
  readRemoteMedia,
  resolveRemoteMedia,
  verifyRemoteMedia,
  type RemoteMediaIo,
} from "../src/lib/assets/remote-media";
import { bindRemoteMediaRequest } from "../src/lib/assets/remote-request";
import { resolveImportedReferences } from "../src/lib/assets/provider-references";
import { RemoteMediaReceiptSchema } from "../src/types/remote-media";
import { genjutsuFixture } from "./helpers/genjutsu-preparation";
import { remoteIo } from "./helpers/remote-media";

const url = "https://cdn.example.com/original.mp4";

test("static page resolution handles OG, relative source and JSON-LD without guessing private APIs", async () => {
  const html =
    '<meta content="/source.mp4?a=1&amp;b=2" property="og:video"><source type="video/mp4" src="/source.mp4?a=1&amp;b=2"><script type="application/ld+json">{"@type":"VideoObject","contentUrl":"https://cdn.example.com/second.mp4"}</script><meta property="og:video" content="http://127.0.0.1/private">';
  const found = pageMediaCandidates(html, "https://higgsfield.ai/card/1");
  assert.deepEqual(found, ["https://higgsfield.ai/source.mp4?a=1&b=2", "https://cdn.example.com/second.mp4"]);
  const resolved = await resolveRemoteMedia("https://higgsfield.ai/card/1", "video", remoteIo(html, "text/html"));
  assert.equal(resolved.direct, false);
  assert.deepEqual(resolved.candidates, found);
  assert.deepEqual(
    (
      await resolveRemoteMedia(
        "https://higgsfield.ai/genjutsu-create",
        "video",
        remoteIo("<div>Login</div>", "text/html"),
      )
    ).candidates,
    [],
  );
  assert.equal((await resolveRemoteMedia(url, "video", remoteIo("unused"))).direct, true);
});

test("source URLs reject private hosts, schemes, credentials and fragments before network", async () => {
  let requests = 0;
  const io: RemoteMediaIo = {
    request: async () => {
      requests++;
      throw Error("unexpected");
    },
  };
  for (const value of [
    "file:///etc/hosts",
    "http://localhost/x",
    "http://192.168.1.2/x",
    "https://user:pass@example.com/x",
    `${url}#fragment`,
  ])
    await assert.rejects(resolveRemoteMedia(value, "video", io));
  assert.equal(requests, 0);
  await assert.rejects(resolveRemoteMedia(url, "video", remoteIo("", "video/mp4", 403)), /HTTP 403/);
  await assert.rejects(resolveRemoteMedia(url, "video", remoteIo("{}", "application/json")), /neither/);
});

test("acquisition imports measured bytes and unknown rights; pinned URL is preserved with canonical metadata", async (t) => {
  const f = genjutsuFixture(t),
    io = remoteIo(readFileSync(f.video));
  const data = await acquireRemoteMedia(
    { projectId: "demo", rootDir: f.rootDir, id: "remote-one", url, kind: "video" },
    io,
  );
  assert.equal(data.asset.id, f.source.id);
  assert.equal(readRemoteMedia("demo", data.binding, f.rootDir).receipt.sha256, f.source.hash);
  await verifyRemoteMedia("demo", [data.binding], f.rootDir, io);
  const reused = await acquireRemoteMedia(
    { projectId: "demo", rootDir: f.rootDir, id: "remote-one", url },
    {
      request: async () => {
        throw Error("Cached acquisition must not refetch.");
      },
    },
  );
  assert.equal(reused.reused, true);
  assert.deepEqual(reused.binding, data.binding);
  const input = {
    provider: "higgsfield" as const,
    endpoint: "higgsfield/genjutsu/motion-transfer/v1.0",
    input: { video_url: url, image_urls: [`asset://sha256/${f.reference.hash}`] },
    context: { remoteMedia: [data.binding] },
  };
  const resolved = resolveImportedReferences(input, "demo", f.rootDir);
  assert.equal(resolved.request.input.video_url, url);
  assert.equal(resolved.request.context?.media[url].durationSec, f.source.media.durationSec);
  assert.deepEqual(new Set(resolved.referenceAssetIds), new Set([f.source.id, f.reference.id]));
  assert.equal(resolved.request.context?.media[url].contentType, "video/mp4");
  assert.throws(
    () =>
      resolveImportedReferences(
        {
          ...input,
          endpoint: "v1/custom-references",
          input: { name: "Hero", input_images: [{ type: "image_url", image_url: url }] },
        },
        "demo",
        f.rootDir,
      ),
    /cannot be attached/,
  );
  await assert.rejects(verifyRemoteMedia("demo", [data.binding], f.rootDir, remoteIo("changed")), /changed/);
  const registryFile = path.join(f.project, "pipeline/asset-registry.json"),
    originalRegistry = readFileSync(registryFile, "utf8");
  const changedRegistry = JSON.parse(originalRegistry);
  changedRegistry.assets.find((row: { id: string }) => row.id === data.asset.id).media.durationSec = 1;
  writeFileSync(registryFile, JSON.stringify(changedRegistry));
  assert.throws(() => readRemoteMedia("demo", data.binding, f.rootDir), /measurements/);
  writeFileSync(registryFile, originalRegistry);
  assert.throws(
    () =>
      resolveImportedReferences(
        { ...input, input: { ...input.input, video_url: "https://cdn.example.com/other.mp4" } },
        "demo",
        f.rootDir,
      ),
    /Every remote binding/,
  );
  writeFileSync(data.file, "{}");
  assert.throws(() => readRemoteMedia("demo", data.binding, f.rootDir));
});

test("acquisition refuses ambiguous/unavailable originals, incorrect kind, oversize and expired URL receipts", async (t) => {
  const f = genjutsuFixture(t);
  const args = { projectId: "demo", rootDir: f.rootDir, id: "remote-one", url };
  await assert.rejects(acquireRemoteMedia(args, remoteIo("<div>private</div>", "text/html")), /0 media candidates/);
  await assert.rejects(acquireRemoteMedia({ ...args, mediaUrl: url }, remoteIo("", "video/mp4", 403)), /HTTP 403/);
  await assert.rejects(
    acquireRemoteMedia({ ...args, kind: "video" }, remoteIo(readFileSync(f.image), "image/png")),
    /kind/,
  );
  await assert.rejects(acquireRemoteMedia({ ...args, maxBytes: 8 }, remoteIo(readFileSync(f.video))), /size limit/);
  await assert.rejects(
    acquireRemoteMedia({ ...args, expiresAt: "2020-01-01T00:00:00Z" }, remoteIo(readFileSync(f.video))),
    /expired/,
  );
  const data = await acquireRemoteMedia(
    { ...args, expiresAt: new Date(Date.now() + 30_000).toISOString() },
    remoteIo(readFileSync(f.video)),
  );
  await assert.rejects(
    verifyRemoteMedia("demo", [data.binding], f.rootDir, remoteIo(readFileSync(f.video))),
    /expires too soon/,
  );
  assert.equal(
    RemoteMediaReceiptSchema.safeParse({ ...data.receipt, assetId: `sha256:${"0".repeat(64)}` }).success,
    false,
  );
});

test("binding supports ordered arrays and nested training references and rejects invented/prototype fields", async (t) => {
  const f = genjutsuFixture(t),
    imageUrl = "https://cdn.example.com/character.png";
  const data = await acquireRemoteMedia(
    { projectId: "demo", rootDir: f.rootDir, id: "remote-image", url: imageUrl, kind: "image" },
    remoteIo(readFileSync(f.image), "image/png"),
  );
  const args = {
    provider: "higgsfield",
    endpoint: "higgsfield/ads-studio/v1.0",
    input: { prompt: "An advert", image_urls: [] },
  };
  const bound = bindRemoteMediaRequest(args, "demo", data.binding, "/image_urls/0", f.rootDir);
  assert.deepEqual(bound.input.image_urls, [imageUrl]);
  const training = bindRemoteMediaRequest(
    {
      provider: "higgsfield",
      endpoint: "v1/custom-references",
      input: { name: "Hero", input_images: [{ type: "image_url", image_url: "https://example.com/placeholder.png" }] },
    },
    "demo",
    data.binding,
    "/input_images/0/image_url",
    f.rootDir,
  );
  assert.equal((training.input.input_images as Array<{ image_url: string }>)[0].image_url, imageUrl);
  for (const pointer of ["/fake_url", "/__proto__/image_url", "/image_urls/999"])
    assert.throws(() => bindRemoteMediaRequest(args, "demo", data.binding, pointer, f.rootDir));
});

test("CLI binds verified URLs, quotes offline and emits one validation envelope before unsafe network access", async (t) => {
  const f = genjutsuFixture(t),
    imageUrl = "https://cdn.example.com/character.png";
  const data = await acquireRemoteMedia(
    { projectId: "demo", rootDir: f.rootDir, id: "remote-image", url: imageUrl, kind: "image" },
    remoteIo(readFileSync(f.image), "image/png"),
  );
  const repo = path.resolve(import.meta.dirname, "..");
  const cli = (script: string, args: string[]) => {
    const child = spawnSync(
      process.execPath,
      [path.join(repo, "node_modules/tsx/dist/cli.mjs"), path.join(repo, "scripts", script), ...args],
      {
        cwd: f.rootDir,
        env: { AGENTBROS_NO_DOTENV: "1", PATH: process.env.PATH, HOME: process.env.HOME },
        encoding: "utf8",
        timeout: 30_000,
      },
    );
    const lines = child.stdout.trim().split("\n");
    assert.equal(lines.length, 1, child.stderr);
    return { status: child.status, json: JSON.parse(lines[0]) };
  };
  const request = path.join(f.rootDir, "request.json"),
    out = path.join(f.rootDir, "bound.json");
  writeFileSync(
    request,
    JSON.stringify({
      provider: "higgsfield",
      endpoint: "higgsfield/ads-studio/v1.0",
      input: { prompt: "A fixture advert", image_urls: [] },
    }),
  );
  const bound = cli("hf-media.ts", [
    "--action",
    "bind",
    "--project",
    "demo",
    "--id",
    data.binding.id,
    "--sha256",
    data.binding.sha256,
    "--request",
    request,
    "--field",
    "/image_urls/0",
    "--out",
    out,
  ]);
  assert.equal(bound.status, 0, JSON.stringify(bound.json));
  const quoted = cli("hf-quote.ts", ["--request", out, "--project", "demo"]);
  assert.equal(quoted.status, 0, JSON.stringify(quoted.json));
  assert.equal(quoted.json.metadata.quoteInput.providerInput.image_urls[0], imageUrl);
  assert.equal(quoted.json.metadata.quoteInput.providerContext.media[imageUrl].width, f.reference.media.width);
  const unsafe = cli("hf-media.ts", ["--action", "resolve", "--url", "http://127.0.0.1/source.mp4"]);
  assert.equal(unsafe.status, 1);
  assert.equal(unsafe.json.error, "VALIDATION");
});
