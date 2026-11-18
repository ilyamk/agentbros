import test from "node:test";
import assert from "node:assert/strict";
import { readResourceResponse, resourceJson } from "../src/lib/resources/http";
import { ResourceService } from "../src/lib/resources/service";
import { PolyHavenResources } from "../src/lib/resources/poly-haven";
import { rightsFromLicence } from "../src/lib/resources/rights";
import type { ResourceCandidate } from "../src/types/resources";

const url = "https://example.test/original";
const fetchResponse = (response: Response) => (async () => response) as typeof fetch;
const options = { maxBytes: 16, timeoutMs: 2000 };
test("invalid resource byte/deadline/URL bounds refuse before any fetch", async () => {
  let calls = 0;
  const request = (async () => {
    calls++;
    throw Error("Must not fetch");
  }) as typeof fetch;
  for (const maxBytes of [0, -1, NaN, Infinity, 1.5, 512 * 1024 * 1024 + 1])
    await assert.rejects(readResourceResponse(request, url, { ...options, maxBytes }), /byte bound/);
  for (const timeoutMs of [0, -1, NaN, Infinity, 1.5, 60001])
    await assert.rejects(readResourceResponse(request, url, { ...options, timeoutMs }), /deadline/);
  for (const address of ["file:///tmp/example", "https://user:password@example.test/file"])
    await assert.rejects(readResourceResponse(request, address, options), /HTTP/);
  assert.equal(calls, 0);
});
test("exact streamed bytes preserved; explicit redirect policy and signal carry only selected headers", async () => {
  const expected = Buffer.from([0, 255, 2, 128]);
  const response = new Response(
    new ReadableStream({
      start(c) {
        c.enqueue(expected.subarray(0, 2));
        c.enqueue(expected.subarray(2));
        c.close();
      },
    }),
  );
  let observed: RequestInit | undefined;
  const result = await readResourceResponse(
    (async (_url, init) => {
      observed = init;
      return response;
    }) as typeof fetch,
    url,
    { ...options, maxBytes: 4, headers: { Authorization: "FAKE_TEST_ONLY" } },
  );
  assert.deepEqual(result, expected);
  assert.equal(observed?.redirect, "error");
  assert.equal(observed?.method, "GET");
  assert.deepEqual(observed?.headers, { Authorization: "FAKE_TEST_ONLY" });
  assert.equal(observed?.signal?.aborted, false);
  assert.equal(response.body?.locked, false);
});
test("oversized or malformed declared size cancels body without consuming it", async () => {
  for (const length of ["17", "9007199254740992", "-1", "oops"]) {
    let cancelled = false;
    const response = new Response(
      new ReadableStream({
        cancel() {
          cancelled = true;
        },
      }),
      { headers: { "content-length": length } },
    );
    await assert.rejects(readResourceResponse(fetchResponse(response), url, options), /size limit/);
    assert.equal(cancelled, true);
    assert.equal(response.body?.locked, false);
  }
});
test("chunked overflow aborts, releases owned reader and does not await stuck cancel", async () => {
  let cancelled = false,
    signal: AbortSignal | null | undefined;
  const response = new Response(
    new ReadableStream({
      start(c) {
        c.enqueue(new Uint8Array(17));
      },
      cancel() {
        cancelled = true;
        return new Promise(() => {});
      },
    }),
  );
  await assert.rejects(
    readResourceResponse(
      (async (_url, init) => {
        signal = init?.signal;
        return response;
      }) as typeof fetch,
      url,
      options,
    ),
    /size limit/,
  );
  assert.equal(cancelled, true);
  assert.equal(signal?.aborted, true);
  assert.equal(response.body?.locked, false);
});
test("request ignoring abort and its late rejection do not extend the deadline", { timeout: 5000 }, async () => {
  let rejectLate!: (error: Error) => void, signal: AbortSignal | null | undefined;
  const request = (async (_url, init) => {
    signal = init?.signal;
    return new Promise<Response>((_, reject) => {
      rejectLate = reject;
    });
  }) as typeof fetch;
  await assert.rejects(readResourceResponse(request, url, { ...options, timeoutMs: 20 }), /deadline exceeded/);
  assert.equal(signal?.aborted, true);
  rejectLate(Error("Controlled late transport failure"));
  await new Promise((resolve) => setImmediate(resolve));
});
test(
  "late response after request timeout is cancelled without reading or keeping its body",
  { timeout: 5000 },
  async () => {
    let finish!: (response: Response) => void,
      cancelled = false;
    const request = (() =>
      new Promise<Response>((resolve) => {
        finish = resolve;
      })) as typeof fetch;
    await assert.rejects(readResourceResponse(request, url, { ...options, timeoutMs: 20 }), /deadline exceeded/);
    finish(
      new Response(
        new ReadableStream({
          cancel() {
            cancelled = true;
            return new Promise(() => {});
          },
        }),
      ),
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(cancelled, true);
  },
);
test("body ignoring abort with nonresolving cancellation still ends and releases lock", { timeout: 5000 }, async () => {
  let cancelled = false;
  const response = new Response(
    new ReadableStream({
      pull() {
        return new Promise(() => {});
      },
      cancel() {
        cancelled = true;
        return new Promise(() => {});
      },
    }),
  );
  await assert.rejects(
    readResourceResponse(fetchResponse(response), url, { ...options, timeoutMs: 20 }),
    /deadline exceeded/,
  );
  assert.equal(cancelled, true);
  assert.equal(response.body?.locked, false);
});
test("redirected, non-success and missing-body responses refuse and cancel available body", async () => {
  const redirected = new Response("{}");
  Object.defineProperty(redirected, "redirected", { value: true });
  for (const response of [
    redirected,
    new Response("{}", { status: 302 }),
    new Response("{}", { status: 403 }),
    new Response(null),
  ])
    await assert.rejects(readResourceResponse(fetchResponse(response), url, options), /request failed/);
});
test("metadata rejects malformed UTF-8 and JSON; valid Unicode roundtrips", () => {
  assert.throws(() => resourceJson(Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x7d])));
  assert.throws(() => resourceJson(Buffer.from("{bad json}")));
  assert.deepEqual(resourceJson(Buffer.from('{"title":"☀"}')), { title: "☀" });
});
test("general metadata uses bounded reader rather than response.json and rejects nonobject payload", async () => {
  const response = new Response('{"results":[]}');
  response.json = async () => {
    throw Error("Unbounded JSON route must not be used");
  };
  assert.deepEqual(
    await new ResourceService({ fetch: fetchResponse(response) }).search("openverse", {
      query: "example",
      kind: "image",
    }),
    [],
  );
  for (const data of ["null", "[]", '"x"'])
    await assert.rejects(
      new ResourceService({ fetch: fetchResponse(new Response(data)) }).search("openverse", {
        query: "example",
        kind: "image",
      }),
    );
  await assert.rejects(
    new ResourceService({ fetch: fetchResponse(new Response("x".repeat(4 * 1024 * 1024 + 1))) }).search("openverse", {
      query: "example",
      kind: "image",
    }),
    /size limit/,
  );
});
test("remote acquisition and Poly Haven bounds refuse before requests or imports", async () => {
  let calls = 0;
  const request = (async () => {
    calls++;
    throw Error("Must not fetch");
  }) as typeof fetch;
  const selected: ResourceCandidate = {
    id: "fixture:one",
    provider: "openverse",
    kind: "image",
    title: "Diagnostic",
    author: "",
    sourceUrl: url,
    downloadUrl: url,
    acquisition: "original-source",
    media: {},
    tags: [],
    cost: { status: "free" },
    rights: rightsFromLicence({
      licence: "CC0",
      title: "Diagnostic",
      author: "",
      sourceUrl: url,
      verifiedAtSource: true,
      checkedAsOf: "2026-10-12T00:00:00Z",
    }),
  };
  for (const maxBytes of [0, NaN, Infinity, 1.5, 512 * 1024 * 1024 + 1]) {
    await assert.rejects(
      new ResourceService({ fetch: request }).acquire(selected, { projectId: "unused", usage: {}, maxBytes }),
      /byte bound/,
    );
    await assert.rejects(
      new PolyHavenResources({ fetch: request }).acquire("diagnostic", ["file"], { projectId: "unused", maxBytes }),
      /byte bound/,
    );
  }
  assert.equal(calls, 0);
});
test("zero-size chunk flood is bounded independently of admitted bytes", async () => {
  let cancelled = false;
  const response = new Response(
    new ReadableStream({
      pull(c) {
        c.enqueue(new Uint8Array(0));
      },
      cancel() {
        cancelled = true;
      },
    }),
  );
  await assert.rejects(
    readResourceResponse(fetchResponse(response), url, { ...options, timeoutMs: 60_000 }),
    /chunk count/,
  );
  assert.equal(cancelled, true);
  assert.equal(response.body?.locked, false);
});
