import { strict as assert } from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import {
  BUNDLE_VERSION_FILE,
  bundleHash,
  bundleSourceFiles,
  distState,
  verifyConsoleBundle,
} from "../src/lib/console/bundle";

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "console-bundle-"));
after(() => fs.rmSync(temp, { recursive: true, force: true }));

const GOOD_HTML =
  '<!doctype html><html><head><meta name="csp-nonce" content="x"><script type="module" crossorigin src="./app.js"></script><link rel="stylesheet" crossorigin href="./style.css"></head><body><div id="root"></div></body></html>';

function bundle(name: string, files: Record<string, string>): string {
  const dir = path.join(temp, name, "dist");
  fs.mkdirSync(dir, { recursive: true });
  for (const [file, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, file), text);
  return dir;
}

const good = { "index.html": GOOD_HTML, "app.js": "const data={data:null};", "style.css": ".a{color:red}" };

describe("console bundle verifier", () => {
  it("accepts exactly index.html, app.js and style.css", () => {
    assert.deepEqual(verifyConsoleBundle(bundle("good", good)), []);
  });

  it("refuses extra or missing files", () => {
    const dir = bundle("extra", { ...good, "chunk-1.js": "" });
    fs.rmSync(path.join(dir, "style.css"));
    const problems = verifyConsoleBundle(dir).map((finding) => `${finding.file}: ${finding.problem}`);
    assert.ok(problems.includes("chunk-1.js: unexpected file"));
    assert.ok(problems.includes("style.css: missing"));
  });

  it("refuses inline script, inline style, data: URLs and remote fonts", () => {
    const dir = bundle("bad", {
      "index.html": GOOD_HTML.replace("</head>", "<script>alert(1)</script><style>a{}</style></head>"),
      "app.js": 'img.src="data:image/png;base64,AAAA"',
      "style.css": "@font-face{src:url(https://fonts.example/x.woff2)}",
    });
    const problems = verifyConsoleBundle(dir).map((finding) => `${finding.file}: ${finding.problem}`);
    for (const expected of [
      "index.html: inline <script>",
      "index.html: inline <style>",
      "app.js: data: URL",
      "style.css: remote @import or url()",
      "style.css: @font-face (system fonts only)",
    ])
      assert.ok(problems.includes(expected), `${expected} in ${problems.join("; ")}`);
  });
});

describe("console bundle sources and stamp", () => {
  it("hashes the console sources, not its tests, and changes with them", () => {
    const repo = path.join(temp, "repo");
    fs.mkdirSync(path.join(repo, "apps/console/e2e"), { recursive: true });
    fs.mkdirSync(path.join(repo, "src/types"), { recursive: true });
    fs.writeFileSync(path.join(repo, "apps/console/App.tsx"), "export {}");
    fs.writeFileSync(path.join(repo, "apps/console/App.test.tsx"), "test");
    fs.writeFileSync(path.join(repo, "apps/console/e2e/smoke.e2e.ts"), "e2e");
    fs.writeFileSync(path.join(repo, "src/types/console.ts"), "contract");
    assert.deepEqual(bundleSourceFiles(repo).sort(), ["apps/console/App.tsx", "src/types/console.ts"]);
    const before = bundleHash(repo);
    fs.writeFileSync(path.join(repo, "apps/console/App.test.tsx"), "changed test");
    assert.equal(bundleHash(repo), before);
    fs.writeFileSync(path.join(repo, "apps/console/App.tsx"), "export const x = 1");
    assert.notEqual(bundleHash(repo), before);
  });

  it("allows the version stamp beside the three files, and reads freshness from it", () => {
    const dir = bundle("stamped", good);
    fs.writeFileSync(path.join(dir, BUNDLE_VERSION_FILE), "abc\n");
    assert.deepEqual(verifyConsoleBundle(dir), []);
    assert.equal(distState(dir, "abc"), "fresh");
    assert.equal(distState(dir, "def"), "stale");
    fs.rmSync(path.join(dir, "app.js"));
    assert.equal(distState(dir, "abc"), "missing");
  });
});
