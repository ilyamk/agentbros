import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, cpSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { execFileSync, spawnSync } from "node:child_process";
import { digest } from "../src/lib/jobs/model-artifacts";
const dir = path.resolve("tests/fixtures/hyperframes-engine");
const original = JSON.parse(readFileSync(path.join(dir, "provenance.json"), "utf8"));
const tree = JSON.parse(readFileSync(path.join(dir, "tree-provenance.json"), "utf8"));
const receipt = JSON.parse(readFileSync(path.join(dir, "instances-provenance.json"), "utf8"));
const expected = {
  "packages/core/src/compiler/compositionScoping.ts": 5,
  "packages/core/src/runtime/clipTree.ts": 1,
  "packages/core/src/runtime/compositionLoader.ts": 5,
  "packages/core/src/runtime/timeline.ts": 10,
};

test("instance source-only receipt binds unchanged original/tree inputs, 21 exact hooks, native build tool and new resolution/virtual metadata", () => {
  assert.equal(receipt.status, "source-build-only-not-product-enabled");
  assert.equal(receipt.profile, "static-local-instances-v1");
  assert.equal(receipt.engineSha256, "1d16cc8a6c63241052d1804f08b2b765ba075f258c3c09e692c024d395b41fa7");
  assert.equal(receipt.engineBytes, 518385);
  assert.equal(receipt.originalReceiptSha256, digest(readFileSync(path.join(dir, "provenance.json"))));
  assert.equal(receipt.predecessorReceiptSha256, digest(readFileSync(path.join(dir, "tree-provenance.json"))));
  assert.equal(receipt.sourceClosureSha256, original.sourceClosureSha256);
  assert.equal(receipt.predecessorRuntimeSha256, tree.engineSha256);
  assert.equal(receipt.patchToolSha256, digest(readFileSync(path.join(dir, "prepare-instances.cjs"))));
  assert.equal(tree.engineSha256, "88f3e5288737e752468d1bb11ca9afe43a31404fefe5f827b5cac37866e585eb");
  assert.equal(tree.patchToolSha256, digest(readFileSync(path.join(dir, "prepare-tree.cjs"))));
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(receipt.patches).map(([key, value]) => [
        key,
        (value as { replacements: unknown[] }).replacements.length,
      ]),
    ),
    expected,
  );
  assert.equal(Object.keys(receipt.loaded).length, 170);
  for (const [name, sha] of Object.entries(receipt.loaded)) assert.equal(sha, original.files[name]);
  assert.equal(Object.keys(receipt.resolutionManifests).length, 16);
  assert.deepEqual(Object.keys(receipt.virtualInputs), [
    "./lib/terminal-highlight",
    "fs",
    "path",
    "source-map-js",
    "url",
  ]);
  for (const entry of Object.values(receipt.virtualInputs))
    assert.deepEqual(entry, { bytes: 0, imports: [], mappingManifest: "dependencies/postcss/package.json" });
  assert.equal(receipt.esbuild.version, "0.28.2");
  assert.equal(receipt.esbuild.nativeVersion, "0.28.2");
  assert.match(receipt.esbuild.binarySha256, /^[a-f0-9]{64}$/);
  assert.match(receipt.esbuild.apiSha256, /^[a-f0-9]{64}$/);
  assert.equal(receipt.licences.hyperframes.sha256, digest(readFileSync("vendor/hyperframes/LICENSE")));
  for (const [name, pin] of Object.entries(original.packages) as [string, { notice: string; noticeSha256: string }][])
    assert.equal(receipt.licences[name].sha256, digest(readFileSync(path.join(dir, pin.notice))));
  assert.equal("packages/core/src/runtime/startResolver.ts" in receipt.patches, false);
  assert.equal("packages/core/src/runtime/media.ts" in receipt.patches, false);
  assert.equal("packages/core/src/runtime/init.ts" in receipt.patches, false);
});

test("source-exact C receipt has inactive-mode original identities, preserved labels and preauthor one-shot acquisition (source assertions only)", () => {
  const patches = receipt.patches;
  const ids = patches["packages/core/src/runtime/timeline.ts"].replacements;
  assert.equal(ids.filter((r: { text: string }) => r.text.includes("stableClipId")).length, 9);
  for (const edit of ids.filter((r: { text: string }) => r.text.includes("stableClipId")))
    assert.match(edit.text, /__avcClock.instanceMode === true \? stableClipId/);
  assert.ok(!ids.some((r: { original: string }) => r.original.includes("el.id,\n") && r.original.includes("label")));
  const clip = patches["packages/core/src/runtime/clipTree.ts"].replacements[0];
  assert.match(clip.text, /instanceClipId\(el\)/);
  assert.ok(clip.text.endsWith(clip.original));
  const scope = patches["packages/core/src/compiler/compositionScoping.ts"].replacements;
  const acquire = scope.find((r: { text: string }) => r.text.includes("__hfAcquire ="));
  assert.ok(
    acquire.text.indexOf("delete window.__avcPrivateInstanceAcquire") <
      acquire.text.indexOf("__hfAcquire(document.currentScript)"),
  );
  assert.match(acquire.text, /Missing private instance authority/);
  assert.ok(
    scope.some((r: { text: string }) =>
      r.text.includes("if (__hfInstanceAuthority) return __hfInstanceAuthority.registry"),
    ),
  );
  assert.ok(scope.some((r: { text: string }) => r.text.includes("Instance registry replacement unsupported")));
  assert.match(
    patches["packages/core/src/runtime/compositionLoader.ts"].replacements.find((r: { original: string }) =>
      r.original.includes("const response"),
    ).text,
    /instanceFetch\(host, src\)/,
  );
  assert.ok(
    !Object.values(patches).some((p: any) => p.replacements.some((r: any) => r.text.includes('.setAttribute("id"'))),
  );
});

test(
  "actual retained inputs reconstruct intermediate/final source hashes, two byte-identical instance builds and old tree; corruption refuses before output",
  { skip: process.env.RUN_HYPERFRAMES_INSTANCE_BUILD_TESTS !== "1", timeout: 60000 },
  () => {
    const source = process.env.HYPERFRAMES_INSTANCE_SOURCE!,
      deps = process.env.HYPERFRAMES_INSTANCE_DEPS!,
      esbuild = process.env.HYPERFRAMES_INSTANCE_ESBUILD!,
      typescript = process.env.HYPERFRAMES_INSTANCE_TYPESCRIPT!;
    assert.ok(
      source && deps && esbuild && typescript,
      "Explicit retained source/toolchain only, no installs/downloads",
    );
    const root = mkdtempSync(path.join(tmpdir(), "avc-instance-build-check-"));
    try {
      for (const [relative, patch] of Object.entries(receipt.patches) as [string, any][]) {
        let text = readFileSync(path.join(source, relative), "utf8");
        assert.equal(digest(text), patch.originalSha256);
        const previous = tree.patches[relative];
        if (previous) {
          for (const edit of [...previous.replacements].sort((a, b) => b.start - a.start)) {
            assert.equal(text.slice(edit.start, edit.end), edit.original);
            text = text.slice(0, edit.start) + edit.text + text.slice(edit.end);
          }
          text = 'import __avcClock from "avc-private-clock";\n' + text;
        }
        assert.equal(digest(text), patch.intermediateSha256);
        for (const edit of patch.replacements) {
          assert.equal(text.slice(edit.start, edit.end), edit.original);
          text = text.slice(0, edit.start) + edit.text + text.slice(edit.end);
        }
        if (patch.addedPrivateClockImport) text = 'import __avcClock from "avc-private-clock";\n' + text;
        assert.equal(digest(text), patch.outputSha256);
        if (relative.endsWith("/timeline.ts")) {
          assert.equal((text.match(/\n\s+el\.id,/g) || []).length, 2);
          assert.ok(text.includes("const id = (node as HTMLElement).id;"));
        }
      }
      const prepare = path.join(dir, "prepare-instances.cjs");
      for (const name of ["one", "two"]) {
        const output = path.join(root, name + ".js"),
          reply = JSON.parse(
            execFileSync(process.execPath, [prepare, source, deps, esbuild, output], {
              encoding: "utf8",
              timeout: 15000,
              maxBuffer: 1024 * 1024,
            }),
          );
        assert.equal(reply.sha256, receipt.engineSha256);
        assert.equal(digest(readFileSync(output)), receipt.engineSha256);
      }
      assert.deepEqual(readFileSync(path.join(root, "one.js")), readFileSync(path.join(root, "two.js")));
      const legacy = path.join(root, "old-tree.js");
      const reply = JSON.parse(
        execFileSync(
          process.execPath,
          [path.join(dir, "prepare-tree.cjs"), source, deps, esbuild, typescript, legacy],
          { encoding: "utf8", timeout: 15000, maxBuffer: 1024 * 1024 },
        ),
      );
      assert.equal(reply.sha256, tree.engineSha256);
      assert.equal(digest(readFileSync(legacy)), tree.engineSha256);
      assert.notEqual(receipt.engineSha256, tree.engineSha256);
      const broken = path.join(root, "broken-source");
      for (const name of Object.keys(original.files).filter((key) => key.startsWith("source/"))) {
        const relative = name.slice(7),
          target = path.join(broken, relative);
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, readFileSync(path.join(source, relative)));
      }
      const loader = path.join(broken, "packages/core/src/runtime/compositionLoader.ts");
      writeFileSync(loader, readFileSync(loader, "utf8") + "\n// invalid original input\n");
      const absent = path.join(root, "bad-source.js");
      const failed = spawnSync(process.execPath, [prepare, broken, deps, esbuild, absent], {
        encoding: "utf8",
        timeout: 15000,
        maxBuffer: 1024 * 1024,
      });
      assert.notEqual(failed.status, 0);
      assert.match(failed.stderr, /Original audit input mismatch.*compositionLoader/);
      assert.equal(existsSync(absent), false);
      const privateDir = path.join(root, "copy/tests/fixtures/hyperframes-engine");
      mkdirSync(privateDir, { recursive: true });
      for (const name of [
        "prepare-instances.cjs",
        "prepare-tree.cjs",
        "provenance.json",
        "tree-provenance.json",
        "instances-provenance.json",
      ])
        writeFileSync(path.join(privateDir, name), readFileSync(path.join(dir, name)));
      cpSync(path.join(dir, "notices"), path.join(privateDir, "notices"), { recursive: true });
      mkdirSync(path.join(root, "copy/vendor/hyperframes"), { recursive: true });
      writeFileSync(path.join(root, "copy/vendor/hyperframes/LICENSE"), readFileSync("vendor/hyperframes/LICENSE"));
      const corruptReceipt = JSON.parse(readFileSync(path.join(privateDir, "tree-provenance.json"), "utf8"));
      corruptReceipt.patches["packages/core/src/runtime/compositionLoader.ts"].replacements[0].text +=
        "\n// untrusted predecessor";
      writeFileSync(path.join(privateDir, "tree-provenance.json"), JSON.stringify(corruptReceipt));
      const corruptOutput = path.join(root, "bad-receipt.js");
      const rejected = spawnSync(
        process.execPath,
        [path.join(privateDir, "prepare-instances.cjs"), source, deps, esbuild, corruptOutput],
        { encoding: "utf8", timeout: 15000, maxBuffer: 1024 * 1024 },
      );
      assert.notEqual(rejected.status, 0);
      assert.match(rejected.stderr, /Immutable predecessor receipt mismatch/);
      assert.equal(existsSync(corruptOutput), false);
      writeFileSync(
        path.join(privateDir, "tree-provenance.json"),
        readFileSync(path.join(dir, "tree-provenance.json")),
      );
      writeFileSync(path.join(privateDir, "prepare-tree.cjs"), 'throw Error("malicious recipe");');
      const badRecipe = path.join(root, "bad-recipe.js");
      const refusal = spawnSync(
        process.execPath,
        [path.join(privateDir, "prepare-instances.cjs"), source, deps, esbuild, badRecipe],
        { encoding: "utf8", timeout: 15000, maxBuffer: 1024 * 1024 },
      );
      assert.notEqual(refusal.status, 0);
      assert.match(refusal.stderr, /Predecessor patch recipe mismatch/);
      assert.equal(existsSync(badRecipe), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
