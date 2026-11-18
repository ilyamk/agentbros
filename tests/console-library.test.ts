/**
 * RFC 0004 WP15, US21: the motion library on the console server. `GET /api/library` serves the trimmed catalogue
 * (no props schemas, defaults or exports) behind the session; `GET /library/preview/<id>` serves a block's still only
 * through its catalogue entry, confined to `docs/library/previews/`, and accepts the cookie like media.
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { LibraryResponseSchema } from "../src/types/console";
import { consoleCookieName, mediaReadValue } from "../src/lib/console/http/auth";
import { previewFile, trimCatalogue } from "../src/lib/console/library";
import type { ConsoleServer } from "../src/lib/console/server";
import { makeRoot, raw, removeRoot, startTestServer } from "./helpers/console-server";

const REPO = path.resolve(import.meta.dirname, "..");
let root: string;
let server: ConsoleServer;
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);

function catalogue() {
  return {
    version: 1,
    items: [
      {
        id: "type-hero",
        category: "typography",
        title: "Hero word",
        description: "A word fills the frame.",
        tags: ["hero", "big type"],
        formats: ["vertical", "landscape", "bogus"],
        durationInFrames: 90,
        importPath: "src/motion/library/typography/HeroWord",
        exports: ["HeroWord"],
        propsSchema: { type: "object" },
        defaultProps: { text: "80%" },
        inspiredBy: ["firecrawl 4.00 s: '80%' on a hard cut"],
        preview: { image: "docs/library/previews/type-hero.jpg" },
      },
      {
        id: "escape",
        category: "effects",
        title: "Escaping preview",
        description: "",
        importPath: "src/motion/library/effects/Escape",
        preview: { image: "docs/library/previews/../../../.env" },
      },
      { id: "no-title", category: "effects", importPath: "x" },
    ],
  };
}

before(async () => {
  root = makeRoot();
  mkdirSync(path.join(root, "docs/library/previews"), { recursive: true });
  writeFileSync(path.join(root, "docs/library/catalogue.json"), JSON.stringify(catalogue()));
  writeFileSync(path.join(root, "docs/library/previews/type-hero.jpg"), JPEG);
  writeFileSync(path.join(root, ".env"), "FAL_KEY=" + "sk-" + "library-secret-000000\n");
  server = await startTestServer(root);
});
after(async () => {
  await server.close();
  removeRoot(root);
});

const auth = () => ({ "x-console-token": server.token });

test("trimCatalogue keeps what a person browses and drops props, defaults, exports and unsafe previews", () => {
  const { response, previews } = trimCatalogue(root, catalogue());
  assert.equal(response.items.length, 2);
  const hero = response.items[0]!;
  assert.deepEqual(hero.formats, ["vertical", "landscape"]);
  assert.equal(hero.preview, true);
  assert.equal("propsSchema" in hero || "defaultProps" in hero || "exports" in hero, false);
  assert.deepEqual(hero.inspiredBy, ["firecrawl 4.00 s: '80%' on a hard cut"]);
  assert.equal(response.items[1]!.preview, false);
  assert.equal(previews.size, 1);
  assert.deepEqual(response.categories, [
    { id: "typography", count: 1 },
    { id: "effects", count: 1 },
  ]);
  assert.equal(previewFile(root, "docs/library/previews/sub/x.jpg"), undefined);
  assert.equal(previewFile(root, "/etc/passwd"), undefined);
});

test("the repository's own catalogue parses and every preview it names exists", () => {
  const { response, previews } = trimCatalogue(
    REPO,
    JSON.parse(readFileSync(path.join(REPO, "docs/library/catalogue.json"), "utf8")),
  );
  assert.ok(response.items.length > 50);
  assert.ok(LibraryResponseSchema.safeParse(response).success);
  assert.ok(response.items.some((item) => item.inspiredBy.length));
  for (const file of previews.values()) assert.ok(readFileSync(file).length > 0, file);
});

test("GET /api/library needs the session and returns the trimmed catalogue", async () => {
  assert.equal((await raw(server.port, { path: "/api/library" })).status, 403);
  const res = await raw(server.port, { path: "/api/library", headers: auth() });
  assert.equal(res.status, 200);
  const body = LibraryResponseSchema.parse(res.json());
  assert.equal(body.items[0]!.id, "type-hero");
  assert.doesNotMatch(res.text, /propsSchema|defaultProps|sk-library-secret/);
  assert.equal((await raw(server.port, { path: "/api/library?x=1", headers: auth() })).status, 400);
});

test("previews: by block id only, with the cookie, confined, no symlink", async () => {
  const cookie = `${consoleCookieName(server.token)}=${mediaReadValue(server.token)}`;
  assert.equal((await raw(server.port, { path: "/library/preview/type-hero" })).status, 403);
  // The media cookie reads previews, never the JSON catalogue; the raw token in the cookie is no longer accepted.
  assert.equal((await raw(server.port, { path: "/api/library", headers: { Cookie: cookie } })).status, 403);
  const stale = `${consoleCookieName(server.token)}=${server.token}`;
  assert.equal(
    (await raw(server.port, { path: "/library/preview/type-hero", headers: { Cookie: stale } })).status,
    403,
  );
  const ok = await raw(server.port, { path: "/library/preview/type-hero", headers: { Cookie: cookie } });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers["content-type"], "image/jpeg");
  assert.deepEqual(ok.body, JPEG);
  for (const target of ["/library/preview/escape", "/library/preview/unknown", "/library/preview/..%2F.env"]) {
    const res = await raw(server.port, { path: target, headers: auth() });
    assert.ok(res.status === 404 || res.status === 400, `${target} → ${res.status}`);
    assert.doesNotMatch(res.text, /sk-library-secret/);
  }
  // A preview that became a symlink is refused.
  const file = path.join(root, "docs/library/previews/type-hero.jpg");
  const { rmSync } = await import("node:fs");
  rmSync(file);
  symlinkSync(path.join(root, ".env"), file);
  const linked = await raw(server.port, { path: "/library/preview/type-hero", headers: auth() });
  assert.equal(linked.status, 403);
  assert.doesNotMatch(linked.text, /sk-library-secret/);
});

test("previews: a symlinked previews folder (a parent, not the file) is refused", async () => {
  const other = makeRoot();
  const outside = makeRoot();
  try {
    mkdirSync(path.join(other, "docs/library"), { recursive: true });
    writeFileSync(path.join(other, "docs/library/catalogue.json"), JSON.stringify(catalogue()));
    mkdirSync(path.join(outside, "previews"), { recursive: true });
    writeFileSync(path.join(outside, "previews/type-hero.jpg"), JPEG);
    symlinkSync(path.join(outside, "previews"), path.join(other, "docs/library/previews"));
    const linked = await startTestServer(other);
    try {
      const res = await raw(linked.port, {
        path: "/library/preview/type-hero",
        headers: { "x-console-token": linked.token },
      });
      assert.equal(res.status, 403);
    } finally {
      await linked.close();
    }
  } finally {
    removeRoot(other);
    removeRoot(outside);
  }
});

test("no catalogue: 404 LIBRARY_NOT_FOUND", async () => {
  const empty = makeRoot();
  const other = await startTestServer(empty);
  try {
    const res = await raw(other.port, { path: "/api/library", headers: { "x-console-token": other.token } });
    assert.equal(res.status, 404);
    assert.equal(res.json().error, "LIBRARY_NOT_FOUND");
  } finally {
    await other.close();
    removeRoot(empty);
  }
});
