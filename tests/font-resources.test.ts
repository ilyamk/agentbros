import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { inspectSfnt } from "../src/lib/font-resources/sfnt";
import { importResource, readResources, acquireResource } from "../src/lib/font-resources/registry";
import { validateIconSvg, providerIconMetadata } from "../src/lib/font-resources/icons";
import { createFontManifest, FONT_ROLES, generateFontRoleModule } from "../src/lib/font-resources/manifest";
const fixtureFont = "/System/Library/Fonts/Supplemental/Arial.ttf";
const metadata = {
  source: "local system test fixture only",
  licence: "not a redistribution permission",
  licenceEvidence: "test fixture owner-supplied only",
  licenceText: "Temporary local test; no font is distributed by this repository.",
  attribution: "Local system font fixture",
  checkedAt: "2026-10-11T00:00:00Z",
};
function setup(t: test.TestContext) {
  const root = mkdtempSync(path.join(os.tmpdir(), "fonts-local-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, "public/projects/fonts");
  mkdirSync(project, { recursive: true });
  writeFileSync(path.join(project, "project.json"), "{}");
  return { root, project };
}
test("actual font metadata and Cyrillic cmap verified; no fallback claims", { skip: !existsSync(fixtureFont) }, (t) => {
  const { root } = setup(t),
    actual = inspectSfnt(readFileSync(fixtureFont));
  assert.deepEqual(actual.missing("Привет мир English"), []);
  assert.ok(actual.missing("\u{10ffff}").length);
  const input = {
    ...metadata,
    kind: "font" as const,
    family: actual.family,
    style: actual.style as "normal",
    weight: actual.weight,
    subset: "latin-cyrillic",
    requiredText: "Привет мир",
  };
  const record = importResource("fonts", fixtureFont, input, root);
  assert.throws(() => importResource("fonts", fixtureFont, { ...input, family: "Pretend Inter" }, root), /differs/);
  assert.throws(() => importResource("fonts", fixtureFont, { ...input, requiredText: "\u{10ffff}" }, root), /coverage/);
  const selector = {
    family: actual.family,
    style: "normal" as const,
    weights: [actual.weight],
    subset: "latin-cyrillic",
    requiredText: "Привет мир",
  };
  const roles = Object.fromEntries(FONT_ROLES.map((role) => [role, selector])) as Record<
    (typeof FONT_ROLES)[number],
    typeof selector
  >;
  const manifest = createFontManifest("fonts", roles, root);
  assert.equal(manifest.roles.primaryFont, actual.family);
  const context = path.join(root, "context.json");
  writeFileSync(context, JSON.stringify(manifest));
  const built = generateFontRoleModule("fonts", context, path.join(root, "roles.ts"), {
    rootDir: root,
    requiredText: "Кириллица",
  });
  assert.ok(built.captureFiles.includes(path.join(root, "public", record.original)));
  assert.throws(
    () =>
      generateFontRoleModule("fonts", context, path.join(root, "missing.ts"), {
        rootDir: root,
        requiredText: "\u{10ffff}",
      }),
    /coverage/,
  );
  writeFileSync(context, JSON.stringify({ ...manifest, module: "arbitrary.js" }));
  assert.throws(
    () =>
      generateFontRoleModule("fonts", context, path.join(root, "unsafe.ts"), {
        rootDir: root,
      }),
    /Invalid declarative/,
  );
  assert.throws(
    () => createFontManifest("fonts", { ...roles, displayFont: { ...selector, weights: [900] } }, root),
    /Missing exact/,
  );
  assert.equal(readResources("fonts", root).revision, 1);
  writeFileSync(path.join(root, "public", record.original), "changed");
  assert.throws(() => readResources("fonts", root), /changed/);
});
test("mock acquisition uses GET only, refuses HTTP and failures", async () => {
  let calls = 0;
  const fetcher = (async (_url: unknown, options: RequestInit) => {
    calls++;
    assert.equal(options.method, "GET");
    assert.equal(options.redirect, "error");
    return new Response(new Uint8Array([1, 2, 3]));
  }) as typeof fetch;
  assert.deepEqual([...(await acquireResource("https://fixture.invalid/font.ttf", fetcher))], [1, 2, 3]);
  assert.equal(calls, 1);
  await assert.rejects(acquireResource("http://fixture.invalid/font.ttf", fetcher));
  assert.equal(calls, 1);
  await assert.rejects(
    acquireResource(
      "https://fixture.invalid/missing",
      (async () => new Response(null, { status: 404 })) as typeof fetch,
    ),
  );
});
test("passive SVG icons preserved with collection-specific evidence; active content rejected", (t) => {
  const { root } = setup(t),
    file = path.join(root, "icon.svg"),
    svg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M0 0L24 24" fill="none" stroke="currentColor" /></svg>';
  writeFileSync(file, svg);
  assert.equal(validateIconSvg(svg), svg);
  const record = importResource(
    "fonts",
    file,
    {
      ...metadata,
      kind: "svg-icon",
      provider: "manual",
      collection: "supplied",
      name: "line",
    },
    root,
  );
  assert.equal(record.kind, "svg-icon");
  for (const unsafe of [
    '<svg onload="alert(1)"></svg>',
    "<svg><script>1</script></svg>",
    "<svg><foreignObject /></svg>",
    '<svg><path fill="url(https://evil.test/x)" /></svg>',
    "<!DOCTYPE svg><svg />",
    '<svg><image href="data:x" /></svg>',
  ])
    assert.throws(() => validateIconSvg(unsafe));
  assert.throws(() =>
    providerIconMetadata("lucide", "lucide", "arrow", {
      licence: "MIT",
      licenceEvidence: "https://example.com",
    }),
  );
  assert.equal(
    providerIconMetadata("lucide", "lucide", "arrow", {
      licence: "ISC",
      licenceEvidence: "https://lucide.dev/license",
    }).licence,
    "ISC",
  );
});

test("Iconify adapter uses public GET metadata and per-collection licence, no blanket permission", async () => {
  const { acquireIconifyIcon } = await import("../src/lib/font-resources/iconify");
  const urls: string[] = [];
  const fetcher = (async (url: string, options: RequestInit) => {
    urls.push(url);
    assert.equal(options.method, "GET");
    return new Response(
      url.includes("collection?")
        ? JSON.stringify({
            prefix: "lucide",
            info: {
              license: {
                title: "ISC",
                spdx: "ISC",
                url: "https://lucide.dev/license",
              },
              author: { name: "Lucide contributors" },
            },
          })
        : '<svg viewBox="0 0 24 24"><path d="M0 0L24 24" /></svg>',
    );
  }) as typeof fetch;
  const result = await acquireIconifyIcon("lucide", "arrow-up", fetcher);
  assert.equal(result.metadata.licence, "ISC");
  assert.equal(urls.length, 2);
  await assert.rejects(acquireIconifyIcon("../evil", "arrow", fetcher));
  assert.equal(urls.length, 2);
});
