import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { execFileSync, spawnSync } from "node:child_process";
import { HYPERFRAMES_TREE_PIN } from "../src/lib/backends/native-composition-tree-prelude";
import { digest } from "../src/lib/jobs/model-artifacts";
const dir = path.resolve("tests/fixtures/hyperframes-engine");
const original = JSON.parse(readFileSync(path.join(dir, "provenance.json"), "utf8")),
  visual = JSON.parse(readFileSync(path.join(dir, "patched-provenance.json"), "utf8")),
  tree = JSON.parse(readFileSync(path.join(dir, "tree-provenance.json"), "utf8"));

test("tree feasibility receipt binds exact original source closure, independent loader patch, build tool and preserved native media adaptations", () => {
  assert.equal(tree.engineSha256, HYPERFRAMES_TREE_PIN.runtimeSha256);
  assert.notEqual(
    tree.engineSha256,
    JSON.parse(readFileSync(path.join(dir, "tree-provenance-993a.json"), "utf8")).engineSha256,
  );
  assert.equal(tree.profile, "static-local-tree-v1");
  assert.equal(tree.originalEngineSha256, original.engineSha256);
  assert.equal(tree.visualEngineSha256, visual.engineSha256);
  assert.equal(tree.originalReceiptSha256, digest(readFileSync(path.join(dir, "provenance.json"))));
  assert.equal(tree.visualReceiptSha256, digest(readFileSync(path.join(dir, "patched-provenance.json"))));
  assert.equal(tree.sourceClosureSha256, original.sourceClosureSha256);
  assert.equal(tree.patchToolSha256, digest(readFileSync(path.join(dir, "prepare-tree.cjs"))));
  assert.equal(tree.predecessorReceiptSha256, digest(readFileSync(path.join(dir, "tree-provenance-993a.json"))));
  assert.equal(
    JSON.parse(readFileSync(path.join(dir, "tree-provenance-993a.json"), "utf8")).engineSha256,
    "993a3716d03b64484df1dd50f407b6d0973ec358b2d6b46337249f815c8c8e53",
  );
  assert.equal(
    tree.patches["packages/core/src/runtime/init.ts"].replacements.filter((r: any) => r.text.includes("treeNormalize("))
      .length,
    2,
  );
  const loader = tree.patches["packages/core/src/runtime/compositionLoader.ts"];
  assert.equal(loader.originalSha256, original.files["source/packages/core/src/runtime/compositionLoader.ts"]);
  assert.equal(
    loader.replacements.filter((r: any) => r.text.includes("mountedHosts") || r.text.includes("treeGuard")).length,
    5,
  );
  const replacements = Object.values(tree.patches).flatMap((p: any) => p.replacements);
  assert.equal(replacements.filter((r: any) => r.text.includes("mediaResolver")).length, 1);
  assert.equal(replacements.filter((r: any) => r.text === "Promise.resolve(false)").length, 1);
  assert.ok(!("packages/core/src/runtime/startResolver.ts" in tree.patches));
  assert.deepEqual(
    tree.patches["packages/core/src/runtime/media.ts"],
    JSON.parse(readFileSync(path.join(dir, "media-provenance.json"), "utf8")).patches[
      "packages/core/src/runtime/media.ts"
    ],
  );
  assert.notEqual(tree.engineSha256, visual.engineSha256);
  assert.notEqual(
    tree.engineSha256,
    JSON.parse(readFileSync(path.join(dir, "media-provenance.json"), "utf8")).engineSha256,
  );
});

test(
  "actual retained original inputs rebuild exact staged tree artifact twice; corrupt original source refuses before output",
  { skip: process.env.RUN_HYPERFRAMES_TREE_BUILD_TESTS !== "1", timeout: 45000 },
  () => {
    const source = process.env.HYPERFRAMES_TREE_SOURCE!,
      deps = process.env.HYPERFRAMES_TREE_DEPS!,
      esbuild = process.env.HYPERFRAMES_TREE_ESBUILD!,
      typescript = process.env.HYPERFRAMES_TREE_TYPESCRIPT!;
    assert.ok(
      source && deps && esbuild && typescript,
      "Explicit retained source/toolchain required, no installs/downloads",
    );
    const root = mkdtempSync(path.join(tmpdir(), "avc-tree-build-check-"));
    try {
      const prepare = path.join(dir, "prepare-tree.cjs");
      for (const name of ["one", "two"]) {
        const output = path.join(root, name + ".js"),
          reply = JSON.parse(
            execFileSync(process.execPath, [prepare, source, deps, esbuild, typescript, output], {
              encoding: "utf8",
              timeout: 15000,
              maxBuffer: 1024 * 1024,
            }),
          );
        assert.equal(reply.sha256, tree.engineSha256);
        assert.equal(digest(readFileSync(output)), tree.engineSha256);
      }
      assert.deepEqual(readFileSync(path.join(root, "one.js")), readFileSync(path.join(root, "two.js")));
      const broken = path.join(root, "broken");
      for (const key of Object.keys(original.files).filter((key) => key.startsWith("source/"))) {
        const relative = key.slice(7),
          target = path.join(broken, relative);
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, readFileSync(path.join(source, relative)));
      }
      const loader = path.join(broken, "packages/core/src/runtime/compositionLoader.ts");
      writeFileSync(loader, readFileSync(loader, "utf8") + "\n// invalid original input\n");
      const output = path.join(root, "must-not-exist.js"),
        failed = spawnSync(process.execPath, [prepare, broken, deps, esbuild, typescript, output], {
          encoding: "utf8",
          timeout: 15000,
          maxBuffer: 1024 * 1024,
        });
      assert.notEqual(failed.status, 0);
      assert.match(failed.stderr, /Original audit input mismatch.*compositionLoader/);
      assert.equal(existsSync(output), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
