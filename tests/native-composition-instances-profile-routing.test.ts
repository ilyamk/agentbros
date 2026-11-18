import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import cp from "node:child_process";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { HtmlCaptureSchema, captureHtml } from "../src/lib/backends/html";
import {
  assertCompositionProfile,
  isInstanceExecutionProfile,
  resolveInstancesPin,
  assertInstanceRuntime,
} from "../src/lib/backends/native-composition-instances-profile";
import { HYPERFRAMES_INSTANCES_PIN } from "../src/lib/backends/native-composition-instances-prelude";
import { HYPERFRAMES_PLAYER_PIN } from "../src/lib/backends/hyperframes-player";
import { digest } from "../src/lib/jobs/model-artifacts";
import { COMMANDS } from "../src/mcp/catalog";
import { prepareCommand } from "../src/mcp/bridge";
const base = {
  protocol: "hyperframes-player",
  htmlFile: "root.html",
  assetRoot: ".",
  assets: ["runtime.js", "gsap.js"],
  width: 64,
  height: 64,
  fps: 8,
  frames: [0],
  playerRuntime: {
    runtimeAsset: "runtime.js",
    gsapAsset: "gsap.js",
    mediaProfile: "native-local-media-v1",
    compositionProfile: "static-local-instances-v2",
  },
};
test("explicit shared request schema/dispatcher maps v1 and v2 with no latest/default migration or cross-runtime fallback", () => {
  assert.equal(HtmlCaptureSchema.parse(base).playerRuntime?.compositionProfile, "static-local-instances-v2");
  assert.equal(assertCompositionProfile(undefined), undefined);
  assert.equal(assertCompositionProfile("static-local-tree-v1"), "static-local-tree-v1");
  for (const invalid of [null, "latest", "static-local-instances-v3"])
    assert.throws(() => assertCompositionProfile(invalid), /Unknown/);
  assert.equal(resolveInstancesPin("static-local-instances-v1"), HYPERFRAMES_INSTANCES_PIN);
  const v2 = resolveInstancesPin("static-local-instances-v2");
  assert.equal(v2.engineBytes, 518857);
  assert.notEqual(v2.runtimeSha256, HYPERFRAMES_INSTANCES_PIN.runtimeSha256);
  assert.deepEqual(assertInstanceRuntime("static-local-instances-v2", v2.runtimeSha256), v2);
  for (const value of [undefined, "static-local-instances-v3", "latest"]) {
    assert.equal(isInstanceExecutionProfile(value), false);
    assert.throws(() => resolveInstancesPin(value as any));
  }
  assert.throws(
    () => assertInstanceRuntime("static-local-instances-v2", HYPERFRAMES_INSTANCES_PIN.runtimeSha256),
    /selected/,
  );
  assert.throws(() => assertInstanceRuntime("static-local-instances-v1", v2.runtimeSha256), /selected/);
  const noNative = { ...base, playerRuntime: { ...base.playerRuntime, mediaProfile: undefined } };
  assert.throws(() => HtmlCaptureSchema.parse(noNative));
  assert.throws(() => HtmlCaptureSchema.parse({ ...base, protocol: "avc-frame" }));
  assert.throws(() => HtmlCaptureSchema.parse({ ...base, playerRuntime: { ...base.playerRuntime, extra: true } }));
  assert.equal(
    HtmlCaptureSchema.parse({ htmlFile: "root", assetRoot: ".", width: 64, height: 64, frames: [0] }).playerRuntime,
    undefined,
  );
});
test("existing CLI/MCP fixed request route consumes same schema, with no new executable/model/provider authority", () => {
  const command = COMMANDS.find((c) => c.name === "capture_html")!;
  assert.ok(command);
  assert.equal(command.script, "capture-html.ts");
  const parsed = command.schema.parse({ request: "local.json", output: "local-output" });
  assert.equal(parsed.request, "local.json");
  const root = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), "c24-mcp-")));
  try {
    const request = path.join(root, "request.json");
    fs.writeFileSync(request, JSON.stringify(base));
    const plan = prepareCommand(
      command,
      { request, output: path.join(root, "output") },
      { root, codeRoot: process.cwd(), allowPaid: false },
    );
    assert.equal(plan.script, path.resolve("scripts/capture-html.ts"));
    assert.equal(plan.flags["scope-root"], root);
    assert.equal(
      HtmlCaptureSchema.parse(JSON.parse(fs.readFileSync(String(plan.flags.request), "utf8"))).playerRuntime
        ?.compositionProfile,
      "static-local-instances-v2",
    );
    assert.throws(() =>
      prepareCommand(
        command,
        { request, output: path.join(root, "output"), executable: "arbitrary" },
        { root, codeRoot: process.cwd(), allowPaid: false },
      ),
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  assert.match(fs.readFileSync("scripts/capture-html.ts", "utf8"), /captureHtml\(\s*input,/);
  assert.match(
    fs.readFileSync("scripts/workers/html-capture.ts", "utf8"),
    /verifyInstanceExecutionProfile\(instanceProfile\)/,
  );
  assert.match(fs.readFileSync("scripts/workers/html-capture.ts", "utf8"), /if\(instanceProfile\)\{/);
});
function fixture(t: any) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), "c24-routing-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "root.html"), "ROOT");
  return {
    root,
    input: {
      ...base,
      assets: [...base.assets],
      playerRuntime: { ...base.playerRuntime },
      htmlFile: path.join(root, "root.html"),
      assetRoot: root,
    },
    output: path.join(root, "output"),
  };
}
test("real parent snapshot rejects v1/v2 mismatch before any worker/publication (opaque script bytes, no execution)", async (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.root, "runtime.js"), "WRONG");
  fs.writeFileSync(path.join(f.root, "gsap.js"), "WRONG");
  let calls = 0;
  const spawn = cp.spawn;
  cp.spawn = ((..._args: any[]) => {
    calls++;
    throw Error("No worker permitted");
  }) as any;
  syncBuiltinESMExports();
  try {
    await assert.rejects(captureHtml(f.input, f.output), /runtime snapshot/);
    assert.equal(calls, 0);
    assert.equal(fs.existsSync(f.output), false);
  } finally {
    cp.spawn = spawn;
    syncBuiltinESMExports();
  }
});
async function fakeCapture(
  t: any,
  mode:
    | "valid"
    | "wrong-worker"
    | "missing-worker"
    | "late-package"
    | "outside-frame"
    | "replaced-stage"
    | "symlink-stage"
    | "aggregate-overflow"
    | "aggregate-exact"
    | "growth-after-metadata"
    | "publication-mutation"
    | "publication-alias"
    | "publication-fifo"
    | "cache-mutation"
    | "cache-alias"
    | "cache-fifo"
    | "cache-unicode"
    | "cache-invalid-utf8",
  profile: "static-local-instances-v1" | "static-local-instances-v2" = "static-local-instances-v2",
) {
  const f = fixture(t),
    runtime =
      process.env[
        profile === "static-local-instances-v2"
          ? "AGENTBROS_NATIVE_INSTANCES_V2_RUNTIME"
          : "AGENTBROS_NATIVE_INSTANCES_V1_RUNTIME"
      ],
    gsap = process.env.AGENTBROS_NATIVE_GSAP_RUNTIME;
  assert.ok(
    runtime && gsap,
    "Explicit versioned runtime and GSAP inputs are required for native profile integration tests",
  );
  assert.equal(digest(fs.readFileSync(runtime)), resolveInstancesPin(profile).runtimeSha256);
  assert.equal(digest(fs.readFileSync(gsap)), HYPERFRAMES_PLAYER_PIN.gsapSha256);
  fs.copyFileSync(runtime, path.join(f.root, "runtime.js"));
  fs.copyFileSync(gsap, path.join(f.root, "gsap.js"));
  const unicodeCache = mode === "cache-unicode" || mode === "cache-invalid-utf8";
  if (unicodeCache) {
    const name = "gsap\uFFFD.js";
    fs.renameSync(path.join(f.root, "gsap.js"), path.join(f.root, name));
    f.input.assets = ["runtime.js", name];
    f.input.playerRuntime.gsapAsset = name;
  }
  f.input.playerRuntime.compositionProfile = profile;
  const retained: string[] = [];
  t.after(() => {
    for (const dir of retained) fs.rmSync(dir, { recursive: true, force: true });
  });
  const spawn = cp.spawn,
    read = fs.readSync,
    open = fs.openSync,
    stat = fs.statSync,
    mkdir = fs.mkdirSync,
    readFile = fs.readFileSync,
    files = new Map<number, string>();
  let activated = false,
    calls = 0,
    poison = false,
    stage = "",
    secondReads = 0,
    grew = false,
    publicationTriggered = false,
    validatedPublicationSha = "",
    reopens = 0;
  const publicationMutation = mode.startsWith("publication-"),
    cacheMutation = mode.startsWith("cache-");
  const aggregate = mode === "aggregate-overflow" || mode === "aggregate-exact";
  if (aggregate) f.input.frames = [0, 1];
  fs.readFileSync = ((name: any, ...args: any[]) => {
    if (publicationTriggered && String(name) === path.join(stage, "frame-0.png")) {
      reopens++;
      throw Error("Validated frame was reopened at publication");
    }
    return (readFile as any)(name, ...args);
  }) as any;
  fs.mkdirSync = ((name: any, ...args: any[]) => {
    if (publicationMutation && !publicationTriggered && activated && String(name) === f.output) {
      const file = path.join(stage, "frame-0.png"),
        original = (readFile as any)(file);
      assert.equal(original.length, 24);
      validatedPublicationSha = digest(original);
      if (mode === "publication-mutation") {
        const changed = Buffer.from(original);
        changed[8] = 1;
        fs.writeFileSync(file, changed);
        assert.notEqual(digest(changed), validatedPublicationSha);
      } else {
        fs.unlinkSync(file);
        if (mode === "publication-alias") {
          const outside = path.join(f.root, "late-source");
          fs.writeFileSync(outside, "OUTSIDE");
          fs.symlinkSync(outside, file);
        } else assert.equal(cp.spawnSync("mkfifo", [file], { timeout: 1000 }).status, 0);
      }
      publicationTriggered = true;
    }
    return (mkdir as any)(name, ...args);
  }) as any;
  fs.statSync = ((name: any, ...args: any[]) => {
    const value = (stat as any)(name, ...args);
    if (mode === "growth-after-metadata" && !grew && String(name).endsWith("frame-0.png")) {
      grew = true;
      assert.equal(value.size, 24);
      fs.truncateSync(name, value.size + 16);
    }
    return value;
  }) as any;
  fs.openSync = ((name: any, ...args: any[]) => {
    const fd = (open as any)(name, ...args);
    files.set(fd, String(name));
    return fd;
  }) as any;
  fs.readSync = ((...args: any[]) => {
    const n = (read as any)(...args);
    if (files.get(args[0])?.endsWith("frame-1.png")) secondReads++;
    if (n && poison && files.get(args[0])?.endsWith("instances-script-host-product-v1.json")) args[1][0] = 0;
    return n;
  }) as any;
  cp.spawn = ((_node: any, args: any[], options: any) => {
    calls++;
    assert.deepEqual(Object.keys(options.env).sort(), ["HOME", "PATH", "TMPDIR"]);
    const request = JSON.parse(fs.readFileSync(args.at(-1), "utf8"));
    assert.equal(request.playerRuntime.compositionProfile, profile);
    activated = true;
    stage = request.directory;
    const child: any = new EventEmitter();
    child.stderr = new EventEmitter();
    child.send = () => true;
    child.kill = () => {
      throw Error("Fake must not be signalled");
    };
    queueMicrotask(() => {
      const png = Buffer.alloc(24);
      Buffer.from("89504e470d0a1a0a", "hex").copy(png);
      png.writeUInt32BE(64, 16);
      png.writeUInt32BE(64, 20);
      fs.writeFileSync(path.join(request.directory, "frame-0.png"), png);
      if (aggregate) {
        fs.truncateSync(path.join(stage, "frame-0.png"), 32 * 1024 * 1024);
        fs.writeFileSync(path.join(stage, "frame-1.png"), png);
        const assetBytes = Object.values(request.assetMap).reduce(
          (sum: number, p: any) => sum + fs.statSync(p.path).size,
          0,
        );
        fs.truncateSync(
          path.join(stage, "frame-1.png"),
          mode === "aggregate-overflow" ? 32 * 1024 * 1024 : 64 * 1024 * 1024 - assetBytes - 32 * 1024 * 1024,
        );
      }
      fs.writeFileSync(
        path.join(request.directory, "worker.json"),
        JSON.stringify({
          protocol: request.protocol,
          nativeInstancesPin:
            mode === "missing-worker"
              ? undefined
              : resolveInstancesPin(
                  mode === "wrong-worker"
                    ? profile === "static-local-instances-v1"
                      ? "static-local-instances-v2"
                      : "static-local-instances-v1"
                    : profile,
                ),
          staticCompositionInstances: { profile: "static-local-instances-v1", fake: true },
          media: [],
        }),
      );
      if (mode === "outside-frame") {
        const outside = path.join(f.root, "outside.png");
        fs.renameSync(path.join(stage, "frame-0.png"), outside);
        fs.symlinkSync(outside, path.join(stage, "frame-0.png"));
      }
      if (mode === "replaced-stage" || mode === "symlink-stage") {
        const original = stage + ".original";
        fs.renameSync(stage, original);
        retained.push(original, stage);
        if (mode === "replaced-stage") {
          fs.mkdirSync(stage);
          fs.writeFileSync(path.join(stage, "foreign.txt"), "FOREIGN");
        } else {
          const target = path.join(f.root, "foreign-stage");
          fs.mkdirSync(target);
          fs.writeFileSync(path.join(target, "foreign.txt"), "FOREIGN");
          fs.symlinkSync(target, stage);
        }
      }
      poison = mode === "late-package";
      child.emit("close", 0);
    });
    return child;
  }) as any;
  syncBuiltinESMExports();
  try {
    if (mode === "valid" || mode === "aggregate-exact" || publicationMutation || cacheMutation) {
      const result = await captureHtml(f.input, f.output);
      const manifest = JSON.parse(fs.readFileSync(result.manifest, "utf8"));
      assert.equal(
        manifest.nativeInstancesPin.activation,
        profile === "static-local-instances-v2" ? "instances-c24-v1" : "instances-c23-v1",
      );
      assert.equal(manifest.nativeInstancesPin.profile, profile);
      if (profile === "static-local-instances-v2")
        assert.equal(manifest.nativeInstancesPin.genuineRuntimeAccepted, false);
      else assert.deepEqual(manifest.nativeInstancesPin, HYPERFRAMES_INSTANCES_PIN);
      assert.equal(manifest.provenance.assets["runtime.js"].sha256, resolveInstancesPin(profile).runtimeSha256);
      for (const key of [
        "instanceScriptHostProduct",
        "instanceScriptHostDescriptor",
        "instanceScriptHostRecipe",
        "instanceScriptHostContract",
        "instanceScriptHostReceipt",
        "instanceProfile",
      ])
        assert.match(manifest.provenance.implementation.sources[key], /^[a-f0-9]{64}$/);
      assert.equal(
        manifest.staticCompositionInstances.fake,
        true,
        "Explicit synthetic worker; no physical PNG/browser acceptance",
      );
      assert.equal(JSON.stringify(manifest.frames).includes("Buffer"), false);
      if (publicationMutation) {
        assert.equal(publicationTriggered, true);
        assert.equal(reopens, 0);
        assert.equal(result.frames[0].sha256, validatedPublicationSha);
        assert.equal(digest(fs.readFileSync(result.frames[0].path)), validatedPublicationSha);
        assert.equal(manifest.frames[0].sha256, validatedPublicationSha);
      }
      if (unicodeCache) {
        const original = fs.readFileSync(result.manifest);
        assert.ok(
          original.includes(Buffer.from("gsap\uFFFD.js", "utf8")),
          "Admitted Unicode source name reaches actual manifest",
        );
        if (mode === "cache-unicode") {
          const cached = await captureHtml(f.input, f.output);
          assert.equal(cached.manifest, result.manifest);
          assert.deepEqual(fs.readFileSync(cached.manifest), original);
          assert.equal(digest(fs.readFileSync(cached.frames[0].path)), result.frames[0].sha256);
        } else {
          const at = original.indexOf(Buffer.from("\uFFFD", "utf8"));
          assert.ok(at >= 0);
          const malformed = Buffer.concat([original.subarray(0, at), Buffer.from([0xff]), original.subarray(at + 3)]);
          assert.equal(malformed.length, original.length - 2);
          assert.equal(
            malformed.toString("utf8"),
            original.toString("utf8"),
            "Decoded text equality must not imply byte identity",
          );
          assert.notEqual(digest(malformed), digest(original));
          fs.writeFileSync(result.manifest, malformed);
          await assert.rejects(captureHtml(f.input, f.output), /Immutable HTML capture conflict/);
          assert.deepEqual(fs.readFileSync(result.manifest), malformed, "Cache conflict must preserve existing bytes");
          assert.equal(digest(fs.readFileSync(result.frames[0].path)), result.frames[0].sha256);
        }
      } else if (cacheMutation) {
        const target = result.frames[0].path,
          original = fs.readFileSync(target);
        if (mode === "cache-mutation") {
          const altered = Buffer.from(original);
          altered[8] = 1;
          fs.writeFileSync(target, altered);
          await assert.rejects(captureHtml(f.input, f.output), /Immutable HTML capture conflict/);
          assert.deepEqual(fs.readFileSync(target), altered);
        } else {
          fs.unlinkSync(target);
          if (mode === "cache-alias") {
            const external = path.join(f.root, "cached-external");
            fs.writeFileSync(external, original);
            fs.symlinkSync(external, target);
            await assert.rejects(captureHtml(f.input, f.output), /symlink/);
            assert.equal(fs.lstatSync(target).isSymbolicLink(), true);
            assert.deepEqual(fs.readFileSync(external), original);
          } else {
            assert.equal(cp.spawnSync("mkfifo", [target], { timeout: 1000 }).status, 0);
            await assert.rejects(captureHtml(f.input, f.output), /regular/);
            assert.equal(fs.lstatSync(target).isFIFO(), true);
          }
        }
      }
      if (mode === "aggregate-exact") {
        assert.equal(result.frames.length, 2);
        const allBytes =
          result.frames.reduce((sum, p) => sum + fs.statSync(p.path).size, 0) +
          Object.keys(manifest.provenance.assets).reduce(
            (sum: number, name: string) => sum + fs.statSync(path.join(f.root, name)).size,
            0,
          );
        assert.equal(allBytes, 64 * 1024 * 1024);
        assert.ok(secondReads > 0);
      }
    } else {
      const expected =
        mode === "aggregate-overflow"
          ? /snapshot exceeds limits/
          : mode === "outside-frame"
            ? /symlink/
            : mode === "replaced-stage" || mode === "symlink-stage"
              ? /staging directory identity/
              : mode === "wrong-worker" || mode === "missing-worker"
                ? /worker execution authority/
                : mode === "growth-after-metadata"
                  ? /generated frame size changed after admission/
                  : /HTML implementation changed during capture/;
      await assert.rejects(captureHtml(f.input, f.output), expected);
      assert.equal(fs.existsSync(f.output), false);
      if (mode === "aggregate-overflow")
        assert.equal(secondReads, 0, "Offending second frame was rejected before consumed FD read");
      if (mode === "replaced-stage" || mode === "symlink-stage") {
        assert.equal(fs.readFileSync(path.join(stage, "foreign.txt"), "utf8"), "FOREIGN");
        if (mode === "symlink-stage") assert.equal(fs.lstatSync(stage).isSymbolicLink(), true);
      }
    }
    assert.equal(activated, true);
    assert.equal(calls, cacheMutation ? 2 : 1);
    if (mode === "growth-after-metadata") assert.equal(grew, true);
  } finally {
    cp.spawn = spawn;
    fs.openSync = open;
    fs.readSync = read;
    fs.statSync = stat;
    fs.mkdirSync = mkdir;
    fs.readFileSync = readFile;
    syncBuiltinESMExports();
  }
}
const integrationTest = (name: string, run: (t: TestContext) => Promise<void>) =>
  test(name, { skip: process.env.RUN_NATIVE_PROFILE_TESTS !== "1" }, run);
integrationTest(
  "same parent publication carries selected v2 source/runtime/activation/fingerprint via explicitly fake worker, no real PNG acceptance",
  async (t) => fakeCapture(t, "valid"),
);
integrationTest("same parent rejects counterfeit worker execution identity before output publication", async (t) =>
  fakeCapture(t, "wrong-worker"),
);
integrationTest(
  "late consumed package corruption after fake worker success refuses before publication without source mutation",
  async (t) => fakeCapture(t, "late-package"),
);

integrationTest(
  "existing v1 same parent now reads generated frames from captured staging with original C23 PIN unchanged (fake worker only)",
  async (t) => fakeCapture(t, "valid", "static-local-instances-v1"),
);
integrationTest("generated frame alias to outside captured staging refuses without output", async (t) =>
  fakeCapture(t, "outside-frame"),
);
integrationTest(
  "same-path replaced staging refuses before metadata read/publication and does not remove foreign replacement",
  async (t) => fakeCapture(t, "replaced-stage"),
);
integrationTest(
  "symlink replaced staging refuses before metadata read/publication and preserves foreign target and alias",
  async (t) => fakeCapture(t, "symlink-stage"),
);

integrationTest(
  "combined assets+two individually bounded fake frame files refuse aggregate overflow before reading second frame",
  async (t) => fakeCapture(t, "aggregate-overflow"),
);
integrationTest(
  "exact combined64MiB assets+frames remain admitted by actual parent (opaque sparse PNGheader fixture, no decode)",
  async (t) => fakeCapture(t, "aggregate-exact"),
);

integrationTest(
  "v1 counterfeit v2 worker authority refuses before publication without changing old C23 selector",
  async (t) => fakeCapture(t, "wrong-worker", "static-local-instances-v1"),
);
integrationTest("v1 missing new private worker identity refuses before publication", async (t) =>
  fakeCapture(t, "missing-worker", "static-local-instances-v1"),
);
integrationTest("v2 missing new private worker identity refuses before publication", async (t) =>
  fakeCapture(t, "missing-worker"),
);

integrationTest(
  "same parent refuses actual frame growth between admitted metadata and bounded FD read before publication",
  async (t) => fakeCapture(t, "growth-after-metadata"),
);

for (const profile of ["static-local-instances-v1", "static-local-instances-v2"] as const) {
  integrationTest(
    profile + " accepts exact existing-cache manifest bytes with legitimate U+FFFD asset filename",
    async (t) => fakeCapture(t, "cache-unicode", profile),
  );
  integrationTest(
    profile + " refuses malformed UTF8 cache bytes even when decoded manifest text is equal, preserving target",
    async (t) => fakeCapture(t, "cache-invalid-utf8", profile),
  );
  integrationTest(
    profile + " publishes exact validated24B bytes despite same-owned stage mutation at publication boundary",
    async (t) => fakeCapture(t, "publication-mutation", profile),
  );
  integrationTest(profile + " never reopens late stage alias while publishing validated snapshot bytes", async (t) =>
    fakeCapture(t, "publication-alias", profile),
  );
  integrationTest(profile + " never reopens late stage FIFO while publishing validated snapshot bytes", async (t) =>
    fakeCapture(t, "publication-fifo", profile),
  );
  integrationTest(
    profile + " refuses immutable existing-cache frame mutation and preserves changed target bytes",
    async (t) => fakeCapture(t, "cache-mutation", profile),
  );
  integrationTest(
    profile + " bounded cache recheck refuses late alias without following or changing external target",
    async (t) => fakeCapture(t, "cache-alias", profile),
  );
  integrationTest(profile + " bounded cache recheck refuses FIFO without blocking or removing it", async (t) =>
    fakeCapture(t, "cache-fifo", profile),
  );
}
