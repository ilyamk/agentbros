import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PolyHavenResources } from "../src/lib/resources/poly-haven";
import { listResourceProviders } from "../src/lib/resources/registry";
const info = { name: "Sunset Studio", type: 0, tags: ["sunset", "studio"], authors: { Artist: "Photography" } };
const url = "https://dl.polyhaven.org/file/ph-assets/HDRIs/hdr/1k/sunset.hdr";
const data = Buffer.from("#?RADIANCE\noriginal HDRI bytes");
const md5 = createHash("md5").update(data).digest("hex");
const files = { hdri: { "1k": { hdr: { url, size: data.length, md5 } } } };
function mock(responses: unknown[], calls: { url: string; init?: RequestInit }[]) {
  return (async (value: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(value), init });
    const response = responses.shift();
    return response instanceof Response
      ? response
      : new Response(JSON.stringify(response), { headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}
test("Poly Haven metadata search is public GET, preserves CC0 rights and distinct required API credit", async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const service = new PolyHavenResources({
    fetch: mock([{ sunset_studio: info, object: { ...info, name: "Object", type: 2, tags: [] } }], calls),
    now: () => "2026-10-11T00:00:00.000Z",
  });
  const [resource] = await service.search({ query: "sunset", kind: "hdri" });
  assert.equal(resource!.kind, "hdri");
  assert.equal(resource!.provenance.assetLicence, "CC0");
  assert.equal(resource!.provenance.apiCredit, "Powered by Poly Haven");
  assert.equal(calls[0]!.url, "https://api.polyhaven.com/assets");
  assert.equal(calls[0]!.init!.method, "GET");
  assert.ok(new Headers(calls[0]!.init!.headers).get("User-Agent"));
  assert.equal(listResourceProviders().find((p) => p.id === "poly-haven")!.search, true);
});
test("inspect flattens exact file selectors and rejects malicious IDs/hosts", async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const service = new PolyHavenResources({ fetch: mock([info, files], calls) });
  const resource = await service.inspect("sunset_studio");
  assert.deepEqual(resource.files![0]!.selector, ["hdri", "1k", "hdr"]);
  assert.equal(resource.files![0]!.md5, md5);
  assert.equal(calls[0]!.url, "https://api.polyhaven.com/info/sunset_studio");
  assert.equal(calls[1]!.url, "https://api.polyhaven.com/files/sunset_studio");
  await assert.rejects(() => service.inspect("../escape"), /Invalid/);
  await assert.rejects(() => service.inspect("Mixed/../Case_01"), /Invalid/);
  const malicious = new PolyHavenResources({
    fetch: mock([info, { file: { ...files.hdri["1k"].hdr, url: "https://evil.invalid/file.hdr" } }], []),
  });
  await assert.rejects(() => malicious.inspect("sunset_studio"), /Untrusted/);
});
test("acquisition verifies exact original size/MD5 and retains SHA256/licence/provenance receipt", async () => {
  const old = process.cwd(),
    root = mkdtempSync(path.join(tmpdir(), "poly-haven-"));
  process.chdir(root);
  mkdirSync("public/projects/demo", { recursive: true });
  writeFileSync("public/projects/demo/project.json", "{}");
  try {
    const calls: { url: string; init?: RequestInit }[] = [];
    const service = new PolyHavenResources({
      fetch: mock([info, files, new Response(data), info, files, new Response(data)], calls),
    });
    const result = await service.acquire("sunset_studio", ["hdri", "1k", "hdr"], { projectId: "demo" });
    assert.deepEqual(readFileSync(result.outputs[0]!), data);
    const receipt = JSON.parse(readFileSync(result.outputs[1]!, "utf8"));
    assert.equal(receipt.md5, md5);
    assert.equal(receipt.provenance.assetLicence, "CC0");
    assert.match(receipt.execution, /no automatic/);
    const repeated = await service.acquire("sunset_studio", ["hdri", "1k", "hdr"], { projectId: "demo" });
    assert.deepEqual(repeated.outputs, result.outputs);
    assert.equal(calls[2]!.init!.redirect, "error");
    assert.equal(new Headers(calls[2]!.init!.headers).has("Authorization"), false);
  } finally {
    process.chdir(old);
    rmSync(root, { recursive: true, force: true });
  }
});
test("wrong byte hashes, missing selector, excessive declared size fail before publication", async () => {
  const wrong = new PolyHavenResources({ fetch: mock([info, files, new Response("corrupt")], []) });
  await assert.rejects(
    () => wrong.acquire("sunset_studio", ["hdri", "1k", "hdr"], { projectId: "demo" }),
    /size\/hash/,
  );
  const missing = new PolyHavenResources({ fetch: mock([info, files], []) });
  await assert.rejects(() => missing.acquire("sunset_studio", ["wrong"], { projectId: "demo" }), /unavailable/);
  const calls: { url: string; init?: RequestInit }[] = [];
  const oversized = new PolyHavenResources({ fetch: mock([info, files], calls) });
  await assert.rejects(
    () => oversized.acquire("sunset_studio", ["hdri", "1k", "hdr"], { projectId: "demo", maxBytes: 1 }),
    /limit/,
  );
  assert.equal(calls.length, 2);
});
