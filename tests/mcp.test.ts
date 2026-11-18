import "./helpers/fal-no-network";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  symlinkSync,
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { COMMANDS } from "../src/mcp/catalog";
import { invokeCommand, prepareCommand, scopedPath, summarizeInlineMedia } from "../src/mcp/bridge";
import { brollFixture } from "./helpers/semantic-broll";
import { AssetRecordSchema } from "../src/types/assets";
import { LocalEditorChannel } from "../src/lib/realtime/channel";
import { RealtimeEditorStore } from "../src/lib/realtime/editor";
const repo = path.resolve(import.meta.dirname, "..");
function fixture() {
  const dir = mkdtempSync(path.join(tmpdir(), "mcp trusted root "));
  mkdirSync(path.join(dir, "public/projects/test"), { recursive: true });
  writeFileSync(
    path.join(dir, "public/projects/test/project.json"),
    JSON.stringify({
      name: "Test",
      formats: ["vertical"],
      productName: "Test",
      tagline: "",
      colors: { accent: "#ffffff", background: "#000000", text: "#ffffff" },
      voice: "rachel",
      musicPrompt: "",
      musicVolume: 0.1,
      scenes: [{ id: "hook", visualType: "title", text: "Local fixture", durationInFrames: 90 }],
    }),
  );
  return dir;
}
function body(value: unknown): Record<string, any> {
  const result = value as { structuredContent?: Record<string, unknown>; content?: { type: string; text?: string }[] };
  return result.structuredContent ?? JSON.parse(result.content!.find((row) => row.type === "text")!.text!);
}
test("real SDK stdio handshake, strict tool catalog, status/help and default no-spend calls", async () => {
  const dir = fixture();
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key, value]) =>
        value !== undefined &&
        !["FAL_KEY", "FAL_REALTIME_TOKEN", "ELEVENLABS_API_KEY", "PEXELS_API_KEY", "FREESOUND_API_KEY"].includes(key),
    ),
  ) as Record<string, string>;
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      path.join(repo, "node_modules/tsx/dist/cli.mjs"),
      path.join(repo, "src/mcp/stdio.ts"),
      "--root",
      dir,
      "--timeout-ms",
      "7200000",
    ],
    cwd: dir,
    env,
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  const client = new Client({ name: "local-offline-test", version: "1.0.0" });
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    assert.ok(listed.tools.some((tool) => tool.name === "avc_pipeline_status"));
    assert.ok(listed.tools.some((tool) => tool.name === "avc_generate_model"));
    assert.ok(listed.tools.some((tool) => tool.name === "avc_fal_find"));
    assert.ok(listed.tools.some((tool) => tool.name === "avc_fal_scaffold"));
    assert.ok(listed.tools.some((tool) => tool.name === "avc_fal_doctor"));
    const capability = body(await client.callTool({ name: "avc_capabilities", arguments: {} }));
    assert.equal(capability.allowPaid, false);
    assert.equal(capability.authority, "trusted-local-project-cli");
    assert.deepEqual(
      capability.cliOnly.find((row: any) => row.command === "film:approve"),
      { command: "film:approve", reason: "approval is the user's, CLI only" },
    );
    const catalog = body(await client.callTool({ name: "avc_models", arguments: {} }));
    assert.ok(catalog.models.length > 0);
    assert.ok(catalog.models.every((model: any) => model.verification.live === false));
    assert.ok(catalog.models.some((model: any) => model.verification.schema === true));
    assert.equal(catalog.returned, 50);
    assert.equal(catalog.truncated, true);
    const filtered = body(
      await client.callTool({
        name: "avc_models",
        arguments: { category: "image-to-video", tier: "verified", search: "kling", limit: 2 },
      }),
    );
    assert.equal(filtered.models.length, 2);
    assert.ok(
      filtered.models.every(
        (model: any) =>
          model.category === "image-to-video" && model.tier === "verified" && model.endpoint.includes("kling"),
      ),
    );
    const find = body(await client.callTool({ name: "avc_fal_find", arguments: { task: "оживить фото", limit: 2 } }));
    assert.equal(find.ok, true);
    assert.equal(find.metadata.candidates.length, 2);
    assert.equal(find.metadata.bridge.allowPaid, false);
    const scaffold = body(
      await client.callTool({
        name: "avc_fal_scaffold",
        arguments: {
          endpoint: "openai/gpt-image-2.5/flare/text-to-image",
          "set-json": JSON.stringify(["prompt=Offline coast"]),
        },
      }),
    );
    assert.equal(scaffold.ok, true);
    assert.equal(scaffold.metadata.valid, true);
    assert.equal(scaffold.outputs.length, 0);
    const doctor = body(
      await client.callTool({ name: "avc_fal_doctor", arguments: { project: "test", "only-project": true } }),
    );
    assert.equal(doctor.ok, true);
    assert.deepEqual(doctor.metadata.findings, []);
    assert.equal(doctor.metadata.bridge.allowPaid, false);
    const modern = body(await client.callTool({ name: "avc_models", arguments: { family: "kling-v3" } }));
    assert.equal(modern.models.length, 12);
    assert.ok(modern.models.every((model: any) => model.requestRouting.family === "kling-v3"));
    const legacy = body(await client.callTool({ name: "avc_models", arguments: { family: "kling-3" } }));
    assert.deepEqual(
      legacy.models.map((row: any) => row.id),
      modern.models.map((row: any) => row.id),
    );
    const flux = body(await client.callTool({ name: "avc_models", arguments: { family: "flux-2", limit: 100 } }));
    assert.equal(flux.models.length, 57);
    const voice = body(await client.callTool({ name: "avc_models", arguments: { family: "kling-voice" } }));
    assert.equal(voice.models.length, 1);
    assert.equal(voice.models[0].requestRouting.operation, "create-voice");
    assert.deepEqual(voice.models[0].pricing, { kind: "fixed", usdPerUnit: 0.007 });
    assert.equal(voice.models[0].capabilities.pricingEvidence.observedAsOf, "2026-10-12");
    assert.equal(
      voice.models[0].capabilities.pricingEvidence.source,
      "https://fal.ai/models/fal-ai/kling-video/create-voice",
    );
    assert.equal(voice.models[0].verification.live, false);
    const workflows = body(await client.callTool({ name: "avc_video_workflow", arguments: { action: "list" } }));
    assert.equal(workflows.ok, true);
    assert.equal(workflows.metadata.workflows.length, 4);
    assert.equal(workflows.metadata.apiCalls, 0);
    assert.equal(workflows.metadata.apiSpendUsd, 0);
    const rubric = body(await client.callTool({ name: "avc_craft_evaluation", arguments: { action: "rubric" } }));
    assert.equal(rubric.ok, true);
    assert.equal(Object.keys(rubric.metadata.rubrics).length, 4);
    assert.equal(rubric.metadata.apiCalls, 0);
    assert.equal(rubric.metadata.apiSpendUsd, 0);
    const resources = body(
      await client.callTool({ name: "avc_resources", arguments: { action: "route", task: "educational-archive" } }),
    );
    assert.equal(resources.ok, true);
    assert.equal(resources.metadata.automaticAcquisition, false);
    assert.ok(resources.metadata.api.some((route: any) => route.provider === "nasa"));
    const manual = body(
      await client.callTool({
        name: "avc_resources",
        arguments: { action: "catalog", provider: "kenney", query: "icons" },
      }),
    );
    assert.equal(manual.ok, true);
    assert.equal(manual.metadata.searchImplemented, false);
    const harness = body(
      await client.callTool({ name: "avc_harness_assets", arguments: { action: "capabilities", project: "test" } }),
    );
    assert.equal(harness.ok, true);
    assert.equal(harness.metadata.status, "unavailable");
    assert.deepEqual(harness.metadata.availableTools, []);
    const editor = body(
      await client.callTool({
        name: "avc_realtime_editor",
        arguments: { action: "create", project: "test", editor: "offline", ceiling: 1 },
      }),
    );
    assert.equal(editor.ok, true);
    assert.equal(editor.metadata.offline, true);
    assert.equal(editor.metadata.editor.committedUsd, 0);
    assert.equal(editor.metadata.providerAck, false);
    const help = body(await client.callTool({ name: "avc_help", arguments: { command: "generate_image" } }));
    assert.equal(help.ok, true);
    assert.equal(help.metadata.help, true);
    const status = body(await client.callTool({ name: "avc_pipeline_status", arguments: { project: "test" } }));
    assert.equal(typeof status.ok, "boolean");
    assert.ok(status.metadata.findings);
    const planned = body(
      await client.callTool({
        name: "avc_generate_image",
        arguments: {
          project: "test",
          prompt: "Fixture; $(touch HACKED)",
          output: "public/projects/test/assets/image with spaces.png",
          "dry-run": false,
        },
      }),
    );
    assert.equal(planned.ok, true);
    assert.equal(planned.metadata.dryRun, true);
    assert.equal(planned.metadata.bridge.enforcedDryRun, true);
    assert.equal(existsSync(path.join(dir, "HACKED")), false);
    assert.equal(existsSync(path.join(dir, "public/projects/test/pipeline/operations.json")), false);
    const streamRequest = {
      family: "flux-2",
      variant: "dev",
      operation: "text-to-image",
      transport: "stream",
      input: { prompt: "Offline streaming fixture" },
    };
    writeFileSync(path.join(dir, "stream.json"), JSON.stringify(streamRequest));
    const stream = body(
      await client.callTool({
        name: "avc_generate_stream",
        arguments: {
          project: "test",
          request: "stream.json",
          output: "public/projects/test/assets/stream.png",
          execute: true,
          "dry-run": false,
        },
      }),
    );
    assert.equal(stream.ok, true);
    assert.equal(stream.metadata.dryRun, true);
    assert.equal(stream.metadata.bridge.enforcedDryRun, true);
    const routed = body(
      await client.callTool({
        name: "avc_generate_model",
        arguments: { project: "test", request: "stream.json", output: "public/projects/test/assets/stream.png" },
      }),
    );
    assert.equal(routed.ok, true);
    assert.equal(routed.metadata.plan.transport, "stream");
    const realtimeRequest = {
      version: 1,
      projectId: "test",
      sessionId: "offline",
      revisionId: "frame",
      operation: {
        family: "flux-2",
        variant: "klein",
        operation: "realtime",
        transport: "realtime",
        input: { image_url: "data:image/png;base64,YQ==", seed: 35 },
      },
      quote: {
        currency: "USD",
        lowUsd: 0,
        expectedUsd: 0.2,
        highUsd: 0.5,
        bounded: true,
        confidence: "user-bound",
        source: "Offline test only",
        asOf: "2026-10-11",
      },
      limits: { maxFrames: 1, maxInputBytes: 1024, maxResponseBytes: 1024, maxControls: 2, timeoutMs: 1000 },
    };
    writeFileSync(path.join(dir, "realtime.json"), JSON.stringify(realtimeRequest));
    const realtime = body(
      await client.callTool({
        name: "avc_generate_realtime",
        arguments: { project: "test", request: "realtime.json", execute: true, "dry-run": false },
      }),
    );
    assert.equal(realtime.ok, true);
    assert.equal(realtime.metadata.dryRun, true);
    assert.equal(realtime.metadata.providerAck, false);
    assert.equal(realtime.metadata.bridge.enforcedDryRun, true);
    writeFileSync(path.join(dir, "realtime.json"), JSON.stringify({ ...realtimeRequest, projectId: "another" }));
    const wrongScope = body(
      await client.callTool({
        name: "avc_generate_realtime",
        arguments: { project: "test", request: "realtime.json" },
      }),
    );
    assert.equal(wrongScope.ok, false);
    assert.match(wrongScope.message, /scoped.*project/);
    assert.equal(existsSync(path.join(dir, ".cache/realtime")), false);
    assert.equal(existsSync(path.join(dir, "public/projects/test/pipeline/operations.json")), false);
    assert.ok(listed.tools.some((tool) => tool.name === "avc_capture_html"));
    assert.ok(listed.tools.some((tool) => tool.name === "avc_resolve_handoff"));
    const blocked = body(
      await client.callTool({ name: "avc_asset_fetch", arguments: { project: "test", "asset-id": "anything" } }),
    );
    assert.equal(blocked.ok, false);
    assert.match(blocked.message, /disabled/);
    const escaping = body(
      await client.callTool({
        name: "avc_generate_image",
        arguments: { project: "test", prompt: "Fixture", output: "../escape.png" },
      }),
    );
    assert.equal(escaping.ok, false);
    const danglingTarget = path.join(path.dirname(dir), `${path.basename(dir)}-outside.png`);
    symlinkSync(danglingTarget, path.join(dir, "dangling.png"));
    const dangling = body(
      await client.callTool({
        name: "avc_generate_image",
        arguments: { project: "test", prompt: "Fixture", output: "dangling.png" },
      }),
    );
    assert.equal(dangling.ok, false);
    assert.equal(existsSync(danglingTarget), false);
    const arbitrary = await client.callTool({
      name: "avc_generate_image",
      arguments: { project: "test", prompt: "Fixture", output: "x.png", command: "sh" },
    });
    assert.ok((arbitrary as { isError?: boolean }).isError);
    await assert.rejects(client.callTool({ name: "exec_shell", arguments: { command: "touch HACKED" } }), /not found/);
    assert.ok(stderr.includes("Usage:") || stderr.includes("--prompt"));
  } finally {
    await client.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test("safe path and paid-policy preparation reject traversal/symlinks and preserve literal argv", () => {
  const dir = fixture(),
    outside = mkdtempSync(path.join(tmpdir(), "mcp outside "));
  try {
    symlinkSync(outside, path.join(dir, "escape"));
    assert.throws(() => scopedPath(dir, "escape/result.png"), /escapes/);
    assert.throws(() => scopedPath(dir, "../outside"));
    const definition = COMMANDS.find((command) => command.name === "generate_image")!;
    const options = { root: dir, codeRoot: repo, allowPaid: false, projectScope: "test" };
    const plan = prepareCommand(
      definition,
      { project: "test", prompt: "; touch file", output: "path with spaces.png", "dry-run": false },
      options,
    );
    assert.ok(plan.argv.includes("--prompt=; touch file"));
    assert.ok(plan.argv.includes("--dry-run=true"));
    assert.throws(() => prepareCommand(definition, { project: "another", prompt: "x", output: "x" }, options), /scope/);
    assert.throws(
      () =>
        prepareCommand(
          COMMANDS.find((command) => command.name === "asset_fetch")!,
          { project: "test", "asset-id": "x" },
          options,
        ),
      /disabled/,
    );
    assert.ok(
      prepareCommand(
        definition,
        { project: "test", prompt: "x", output: "x", "dry-run": false },
        { ...options, allowPaid: true },
      ).argv.includes("--dry-run=false"),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});
test("refs_derive exposes plan and show only and scopes its spec", () => {
  const dir = fixture(),
    outside = mkdtempSync(path.join(tmpdir(), "mcp refs outside "));
  try {
    symlinkSync(outside, path.join(dir, "escape"));
    const definition = COMMANDS.find((command) => command.name === "refs_derive")!;
    assert.equal(definition.readOnly, true);
    assert.equal(definition.paid, "dry-run");
    const options = { root: dir, codeRoot: repo, allowPaid: false, projectScope: "test" };
    const plan = prepareCommand(definition, { project: "test", action: "plan", spec: "spec.json" }, options);
    assert.ok(plan.argv.includes("--action=plan"));
    assert.ok(plan.argv.includes("--dry-run=true"));
    assert.throws(() => prepareCommand(definition, { project: "test", action: "run", spec: "spec.json" }, options));
    assert.throws(() => prepareCommand(definition, { project: "test", action: "plan", spec: "../spec.json" }, options));
    assert.throws(() =>
      prepareCommand(definition, { project: "test", action: "plan", spec: "escape/spec.json" }, options),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});
test("refs_pack MCP tool exposes prepare, check, board, request and result-board only", () => {
  const definition = COMMANDS.find((command) => command.name === "refs_pack")!;
  assert.equal(definition.paid, "local");
  assert.deepEqual(definition.paths, ["spec", "result"]);
  const dir = mkdtempSync(path.join(tmpdir(), "mcp refs pack "));
  try {
    mkdirSync(path.join(dir, "public/projects/test"), { recursive: true });
    writeFileSync(path.join(dir, "public/projects/test/project.json"), "{}");
    const options = { root: dir, codeRoot: repo, allowPaid: false, projectScope: "test" };
    for (const action of ["prepare", "check", "board", "request", "result-board"])
      assert.ok(
        prepareCommand(definition, { project: "test", action, id: "p1", spec: "spec.json" }, options).argv.includes(
          `--action=${action}`,
        ),
      );
    for (const action of ["rights", "approve", "review-result", "list"])
      assert.throws(() => prepareCommand(definition, { project: "test", action, id: "p1" }, options));
    assert.throws(() =>
      prepareCommand(definition, { project: "test", action: "prepare", spec: "../spec.json" }, options),
    );
    assert.throws(() =>
      prepareCommand(definition, { project: "test", action: "result-board", id: "p1", result: "/etc/passwd" }, options),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("trusted launcher rejects timeouts beyond its bounded longform allowance", () => {
  for (const value of ["7200001", "0", "1000.5", "NaN"]) {
    const child = spawnSync(
      process.execPath,
      [
        path.join(repo, "node_modules/tsx/dist/cli.mjs"),
        path.join(repo, "src/mcp/stdio.ts"),
        "--root",
        repo,
        "--timeout-ms",
        value,
      ],
      { encoding: "utf8", timeout: 30000 },
    );
    assert.equal(child.status, 1, child.stderr);
    assert.match(child.stderr, /between 1000 and 7200000/);
    assert.equal(child.stdout, "");
  }
});
test("MCP refuses dangling output links before spawning a command", async (t) => {
  const dir = fixture(),
    outside = mkdtempSync(path.join(tmpdir(), "mcp dangling outside "));
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });
  const output = path.join(outside, "missing.json");
  symlinkSync(output, path.join(dir, "output.json"));
  symlinkSync(path.join(outside, "missing-directory"), path.join(dir, "directory"));
  const options = { root: dir, codeRoot: dir, allowPaid: false, stderr: () => {} };
  mkdirSync(path.join(dir, "scripts"));
  symlinkSync(path.join(repo, "node_modules"), path.join(dir, "node_modules"));
  writeFileSync(
    path.join(dir, "scripts/fixture.ts"),
    `import {writeFileSync} from 'node:fs';writeFileSync('output.json','escaped');console.log(JSON.stringify({ok:true,elapsedMs:0}));`,
  );
  const definition = { ...COMMANDS.find((command) => command.name === "generate_image")!, script: "fixture.ts" };
  for (const value of ["output.json", "directory/new.json"]) {
    assert.throws(() => scopedPath(dir, value));
    assert.throws(() => prepareCommand(definition, { project: "test", prompt: "fixture", output: value }, options));
  }
  await assert.rejects(
    invokeCommand(definition, { project: "test", prompt: "fixture", output: "output.json" }, options),
  );
  assert.equal(existsSync(output), false);
  assert.equal(existsSync(path.join(outside, "missing-directory")), false);
});
test("MCP canonical scope accepts an absolute workspace alias and new output directories", (t) => {
  const dir = fixture(),
    aliases = mkdtempSync(path.join(tmpdir(), "mcp aliases "));
  t.after(() => {
    rmSync(aliases, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  });
  const alias = path.join(aliases, "workspace");
  symlinkSync(dir, alias);
  const expected = path.join(realpathSync(dir), "new/output.json");
  assert.equal(scopedPath(realpathSync(dir), path.join(alias, "new/output.json")), expected);
  assert.equal(scopedPath(alias, path.join(dir, "new/output.json")), expected);
});
test("subprocess stdout/timeout bounds and exact-one-envelope contract are enforced", async () => {
  const dir = fixture();
  mkdirSync(path.join(dir, "scripts"));
  symlinkSync(path.join(repo, "node_modules"), path.join(dir, "node_modules"));
  const base = COMMANDS.find((command) => command.name === "pipeline_status")!,
    definition = { ...base, script: "fixture.ts", schema: base.schema };
  const options = { root: dir, codeRoot: dir, allowPaid: false, timeoutMs: 200, maxStdoutBytes: 100, stderr: () => {} };
  try {
    writeFileSync(
      path.join(dir, "scripts/fixture.ts"),
      'console.log(JSON.stringify({ok:true,elapsedMs:0}));console.log("extra");',
    );
    await assert.rejects(
      invokeCommand(definition, { project: "test" }, { ...options, timeoutMs: 10000 }),
      /exactly one/,
    );
    writeFileSync(path.join(dir, "scripts/fixture.ts"), 'process.stdout.write("x".repeat(10000));');
    await assert.rejects(invokeCommand(definition, { project: "test" }, { ...options, timeoutMs: 10000 }), /limit/);
    writeFileSync(path.join(dir, "scripts/fixture.ts"), "setInterval(()=>{},1000);");
    await assert.rejects(invokeCommand(definition, { project: "test" }, options), /timed out/);
    writeFileSync(
      path.join(dir, "scripts/fixture.ts"),
      'console.log(JSON.stringify({ok:false,error:"VALIDATION",elapsedMs:0}));',
    );
    await assert.rejects(
      invokeCommand(definition, { project: "test" }, { ...options, timeoutMs: 10000 }),
      /exit status/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("inline media response summaries retain exact checksum/size without mutating the request", () => {
  const bytes = Buffer.alloc(1024 * 1024, 42),
    uri = `data:image/png;base64,${bytes.toString("base64")}`;
  const input = { plan: { input: { image_urls: [uri] } }, url: "https://v3.fal.media/result.png" };
  const summarized = summarizeInlineMedia(input) as {
    plan: { input: { image_urls: { mime: string; bytes: number; sha256: string; omittedFromWire: boolean }[] } };
    url: string;
  };
  assert.equal(summarized.plan.input.image_urls[0]!.bytes, bytes.length);
  assert.equal(summarized.plan.input.image_urls[0]!.mime, "image/png");
  assert.equal(summarized.plan.input.image_urls[0]!.sha256, createHash("sha256").update(bytes).digest("hex"));
  assert.equal(summarized.plan.input.image_urls[0]!.omittedFromWire, true);
  assert.equal(input.plan.input.image_urls[0], uri);
  assert.equal(summarized.url, input.url);
  assert.ok(JSON.stringify(summarized).length < 1000);
});
for (const mode of ["cancellation", "timeout", "success"] as const)
  test(
    `MCP ${mode} reaps a worker that ignores SIGTERM after its leader exits`,
    { skip: process.platform === "win32" },
    async (t) => {
      const dir = fixture();
      t.after(() => rmSync(dir, { recursive: true, force: true }));
      mkdirSync(path.join(dir, "scripts"));
      symlinkSync(path.join(repo, "node_modules"), path.join(dir, "node_modules"));
      const pidFile = path.join(dir, "worker.pid");
      let pid: number | undefined;
      t.after(() => {
        if (pid) {
          try {
            process.kill(pid, "SIGKILL");
          } catch {
            /* Already reaped. */
          }
        }
      });
      writeFileSync(
        path.join(dir, "worker.mjs"),
        `import {writeFileSync} from 'node:fs';process.on('SIGTERM',()=>{});writeFileSync('worker.pid',String(process.pid));setInterval(()=>{},1000);`,
      );
      writeFileSync(
        path.join(dir, "scripts/fixture.ts"),
        `import {spawn} from 'node:child_process';import {existsSync} from 'node:fs';spawn(process.execPath,['worker.mjs'],{stdio:'ignore'});${mode === "success" ? `setInterval(()=>{if(existsSync('worker.pid')){console.log(JSON.stringify({ok:true,elapsedMs:0}));process.exit(0);}},20);` : "setInterval(()=>{},1000);"}`,
      );
      const definition = { ...COMMANDS.find((command) => command.name === "pipeline_status")!, script: "fixture.ts" };
      const controller = new AbortController();
      const result = invokeCommand(
        definition,
        { project: "test" },
        { root: dir, codeRoot: dir, allowPaid: false, timeoutMs: mode === "timeout" ? 5000 : 20000, stderr: () => {} },
        controller.signal,
      );
      const outcome =
        mode === "success"
          ? result.then((envelope) => assert.equal(envelope.ok, true))
          : assert.rejects(result, mode === "timeout" ? /timed out/ : /cancelled/);
      try {
        const deadline = Date.now() + 15000;
        while (!existsSync(pidFile) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
        assert.ok(existsSync(pidFile), "worker started");
        pid = Number(readFileSync(pidFile, "utf8"));
      } finally {
        if (mode === "cancellation") controller.abort();
      }
      await outcome;
      const deadline = Date.now() + 3000;
      const alive = () => {
        const status = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" });
        assert.ifError(status.error);
        return status.status === 0 && !status.stdout.trim().startsWith("Z");
      };
      while (alive() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(alive(), false, "owned worker terminated");
    },
  );

test("nested HTML/Resolve paths stay inside the trusted launcher boundary", async () => {
  const dir = fixture(),
    outside = mkdtempSync(path.join(tmpdir(), "mcp nested outside "));
  const options = { root: dir, codeRoot: repo, allowPaid: false, stderr: () => {} };
  try {
    writeFileSync(
      path.join(dir, "html.json"),
      JSON.stringify({
        htmlFile: path.join(outside, "scene.html"),
        assetRoot: outside,
        width: 32,
        height: 32,
        frames: [0],
      }),
    );
    const html = await invokeCommand(
      COMMANDS.find((command) => command.name === "capture_html")!,
      { request: "html.json", output: "public/projects/test/captures" },
      options,
    );
    assert.equal(html.ok, false);
    assert.match(html.message!, /outside|escapes/);
    mkdirSync(path.join(dir, "handoff"));
    writeFileSync(
      path.join(dir, "handoff/handoff.json"),
      JSON.stringify({ expected: { projectId: "test" }, originals: [{ path: path.join(outside, "clip.mp4") }] }),
    );
    const resolve = await invokeCommand(
      COMMANDS.find((command) => command.name === "resolve_handoff")!,
      { directory: "handoff", project: "test" },
      options,
    );
    assert.equal(resolve.ok, false);
    assert.match(resolve.message!, /outside|escapes/);
    const prepared = prepareCommand(
      COMMANDS.find((command) => command.name === "capture_html")!,
      { request: "html.json", output: "public/projects/test/captures" },
      options,
    );
    assert.equal(prepared.flags["scope-root"], scopedPath(dir, "."));
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("craft evaluation uses a launcher-only nested path boundary and excludes executable worker configuration", async () => {
  const dir = fixture(),
    outside = mkdtempSync(path.join(tmpdir(), "mcp craft outside "));
  const options = { root: dir, codeRoot: repo, allowPaid: false, stderr: () => {} };
  const definition = COMMANDS.find((command) => command.name === "craft_evaluation")!;
  try {
    assert.equal(definition.readOnly, true);
    assert.equal(
      prepareCommand(definition, { action: "evaluate", request: "evaluation.json" }, options).flags["scope-root"],
      scopedPath(dir, "."),
    );
    assert.throws(() => prepareCommand(definition, { request: "evaluation.json", "scope-root": outside }, options));
    assert.throws(() => prepareCommand(definition, { request: "../outside/evaluation.json" }, options), /escapes/);
    assert.throws(
      () => prepareCommand(definition, { action: "rubric" }, { ...options, projectScope: "test" }),
      /scoped project/,
    );
    assert.equal(
      COMMANDS.some((command) => command.script === "media-local.ts"),
      false,
      "Trusted arbitrary worker launchers are intentionally outside the MCP catalog",
    );
    const localPin = { id: "local", path: "missing.json", sha256: "a".repeat(64) };
    writeFileSync(
      path.join(dir, "evaluation.json"),
      JSON.stringify({
        version: 1,
        id: "pilot",
        scenario: "education",
        material: "synthetic-fixture",
        inputs: [{ ...localPin, id: "external", path: path.join(outside, "asset.png") }],
        baseline: {
          id: "baseline",
          request: localPin,
          skills: [localPin],
          configuration: localPin,
          decisions: localPin,
        },
      }),
    );
    const result = await invokeCommand(definition, { request: "evaluation.json" }, options);
    assert.equal(result.ok, false);
    assert.equal(result.error, "VALIDATION");
    assert.match(result.message!, /escapes|outside/);
    assert.equal(existsSync(path.join(outside, "asset.png")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});
test("harness handoff validates nested project identity and launcher-only scope before writes", async () => {
  const dir = fixture(),
    options = { root: dir, codeRoot: repo, allowPaid: false, projectScope: "test", stderr: () => {} };
  const definition = COMMANDS.find((command) => command.name === "harness_assets")!;
  try {
    writeFileSync(path.join(dir, "request.json"), JSON.stringify({ projectId: "another" }));
    const plan = prepareCommand(
      definition,
      { action: "request", project: "test", request: "request.json", capabilities: "caps.json" },
      options,
    );
    assert.equal(plan.flags["scope-root"], scopedPath(dir, "."));
    const result = await invokeCommand(
      definition,
      { action: "request", project: "test", request: "request.json", capabilities: "caps.json" },
      options,
    );
    assert.equal(result.ok, false);
    assert.match(result.message!, /project scope/);
    assert.equal(existsSync(path.join(dir, "public/projects/test/pipeline/harness")), false);
    assert.throws(() =>
      prepareCommand(definition, { action: "capabilities", project: "test", "scope-root": "/" }, options),
    );
    assert.throws(() => prepareCommand(definition, { action: "capabilities", project: "another" }, options), /scope/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("B-roll MCP uses fixed project-scoped offline planning and reviewed dry-run without executable configuration", async () => {
  const f = brollFixture();
  try {
    const definition = COMMANDS.find((command) => command.name === "media_broll")!;
    const options = { root: f.root, codeRoot: repo, allowPaid: false, projectScope: "pilot", stderr: () => {} };
    const request = path.join(f.project, "pipeline/broll-request.json");
    writeFileSync(request, JSON.stringify(f.request));
    const prepared = prepareCommand(definition, { project: "pilot", request }, options);
    assert.equal(prepared.flags["scope-root"], f.root);
    assert.throws(() => prepareCommand(definition, { project: "pilot", request, "scope-root": "/" }, options));
    assert.throws(() =>
      prepareCommand(definition, { project: "pilot", request, executable: process.execPath }, options),
    );
    assert.throws(() => prepareCommand(definition, { project: "foreign", request }, options), /scope/);
    const planned = await invokeCommand(definition, { project: "pilot", request }, options);
    const plannedMetadata = planned.metadata as Record<string, unknown>;
    assert.equal(planned.ok, true);
    assert.equal(plannedMetadata.productionApproved, false);
    assert.deepEqual(planned.outputs, []);
    const plan = Object.fromEntries(Object.entries(plannedMetadata).filter(([key]) => key !== "bridge"));
    const planFile = path.join(f.project, "pipeline/broll-plan.json"),
      reviewFile = path.join(f.project, "pipeline/broll-review.json");
    writeFileSync(planFile, JSON.stringify(plan));
    writeFileSync(
      reviewFile,
      JSON.stringify({
        planHash: plan.planHash,
        assetHash: plan.assetHash,
        reviewedBy: "synthetic-test-only",
        evidence: "Fixture declaration only",
      }),
    );
    const before = readFileSync(f.store.file);
    const checked = await invokeCommand(
      definition,
      { project: "pilot", action: "apply", plan: planFile, review: reviewFile, "dry-run": true },
      options,
    );
    const checkedMetadata = checked.metadata as Record<string, unknown>;
    assert.equal(checked.ok, true);
    assert.equal(checkedMetadata.dryRun, true);
    assert.equal(checkedMetadata.providerSpendUsd, 0);
    assert.deepEqual(readFileSync(f.store.file), before);
  } finally {
    f.cleanup();
  }
});

test("blender_live scopes its .blend path, keeps overwrite, ui and executable on the CLI and takes no code", () => {
  const dir = fixture(),
    outside = mkdtempSync(path.join(tmpdir(), "mcp outside "));
  try {
    const definition = COMMANDS.find((command) => command.name === "blender_live")!;
    const options = { root: dir, codeRoot: repo, allowPaid: false };
    assert.equal(definition.paid, "local");
    assert.deepEqual(definition.paths, ["blend"]);
    assert.equal(definition.readOnly, false, "the mixed live tool includes mutations; arsenal itself is read-only");
    for (const [action, params] of [
      ["append-asset", { id: "fixture:material", target: "Hero" }],
      ["apply-recipe", { id: "dust-burst", params: { seed: 42 } }],
      ["enable-extension", { id: "fixture_extension" }],
      ["arsenal", { kind: "materials", limit: 4, filter: "wood" }],
    ] as const)
      assert.ok(
        prepareCommand(definition, { action, params: JSON.stringify(params) }, options).argv.includes(
          `--action=${action}`,
        ),
      );
    for (const [action, params] of [
      ["append-asset", { id: "fixture:material", target: "../../x" }],
      ["append-asset", { id: "fixture:material", path: "/tmp/x" }],
      ["apply-recipe", { id: "../x", params: {} }],
      ["enable-extension", { id: "../../x" }],
      ["arsenal", { limit: 101 }],
      ["arsenal", { download: true }],
    ] as const)
      assert.throws(() => prepareCommand(definition, { action, params: JSON.stringify(params) }, options));
    assert.throws(() => prepareCommand(definition, { action: "append-asset", params: "not json" }, options));
    assert.ok(
      prepareCommand(definition, { action: "start", extensions: "approved" }, options).argv.includes(
        "--extensions=approved",
      ),
    );
    assert.throws(() => prepareCommand(definition, { action: "start", extensions: "../profile" }, options));

    const blend = "public/projects/test/assets/blender/a.blend";
    assert.ok(
      prepareCommand(definition, { action: "start", project: "test", blend }, options).argv.includes(
        `--blend=${scopedPath(dir, blend)}`,
      ),
    );
    assert.throws(
      () => prepareCommand(definition, { action: "start", blend: "../outside/a.blend" }, options),
      /escapes/,
    );
    symlinkSync(outside, path.join(dir, "escape"));
    assert.throws(() => prepareCommand(definition, { action: "start", blend: "escape/a.blend" }, options), /escapes/);
    for (const flag of ["overwrite", "ui", "executable", "script", "python"])
      assert.throws(
        () =>
          prepareCommand(
            definition,
            {
              action: "save",
              [flag]: typeof flag === "string" && ["executable", "script", "python"].includes(flag) ? "/bin/sh" : true,
            },
            options,
          ),
        Error,
        flag,
      );
    assert.throws(() => prepareCommand(definition, { action: "exec" }, options));
    assert.throws(() => prepareCommand(definition, { action: "inspect", session: "../x" }, options));
    assert.throws(
      () => prepareCommand(definition, { action: "inspect", project: "other" }, { ...options, projectScope: "test" }),
      /scope/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("realtime derive MCP scopes the small patch and creates only an independent local draft", async () => {
  const dir = fixture(),
    options = { root: dir, codeRoot: repo, allowPaid: false, projectScope: "test", stderr: () => {} },
    definition = COMMANDS.find((command) => command.name === "realtime_editor")!;
  try {
    const store = new RealtimeEditorStore(dir, "test", "draft");
    store.create(2);
    const quote = {
      currency: "USD" as const,
      lowUsd: 0,
      expectedUsd: 0.2,
      highUsd: 0.5,
      bounded: true as const,
      confidence: "user-bound" as const,
      providerEnforced: false,
      source: "Explicit offline test bound",
      asOf: "2026-10-12",
    };
    const operation = {
      family: "flux-2" as const,
      variant: "klein",
      operation: "realtime",
      transport: "realtime" as const,
      input: { image_url: "data:image/png;base64,YQ==", seed: 35 },
    };
    store.add(0, {
      version: 1,
      projectId: "test",
      sessionId: "first-session",
      revisionId: "first",
      operation,
      quote,
      limits: { maxFrames: 1, maxInputBytes: 1024, maxResponseBytes: 1024, maxControls: 2, timeoutMs: 1000 },
    });
    const patch = "public/projects/test/patch.json";
    writeFileSync(
      path.join(dir, patch),
      JSON.stringify({
        sourceRevision: "first",
        revisionId: "second",
        sessionId: "second-session",
        input: { prompt: "New local direction" },
        quote,
      }),
    );
    const args = { project: "test", editor: "draft", action: "derive", expected: 1, patch };
    assert.equal(prepareCommand(definition, args, options).flags.patch, scopedPath(dir, patch));
    assert.throws(() => prepareCommand(definition, { ...args, patch: "../outside.json" }, options), /escapes/);
    assert.throws(() => prepareCommand(definition, { ...args, project: "another" }, options), /scope/);
    const result = await invokeCommand(definition, args, options);
    assert.equal(result.ok, true, result.message ?? "MCP derive failed");
    const state = store.read();
    assert.equal(state.sequence, 2);
    assert.equal(state.revisions[1].status, "draft");
    assert.equal(state.committedUsd, 0);
    assert.equal(state.queued, undefined);
    assert.equal(state.inFlight, undefined);
    assert.equal(state.selected, undefined);
    assert.equal(store.request("second").operation.input.image_url, operation.input.image_url);
    assert.equal(existsSync(path.join(dir, "public/projects/test/pipeline/financial-state.json")), false);
    assert.equal(existsSync(path.join(dir, ".cache/realtime")), false);
    const conflict = await invokeCommand(definition, args, options);
    assert.equal(conflict.ok, false);
    assert.match(conflict.message!, /conflict/);
    assert.equal(store.read().sequence, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("registered still MCP real bridge keeps project-relative selectors and creates only a fresh pinned offline draft", async (t) => {
  const dir = realpathSync(fixture()),
    project = path.join(dir, "public/projects/test");
  const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    ),
    sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex"),
    hash = sha(png),
    original = path.join(project, "assets/imported", hash + ".png");
  mkdirSync(path.dirname(original), { recursive: true });
  writeFileSync(original, png);
  mkdirSync(path.join(project, "pipeline"), { recursive: true });
  const asset = AssetRecordSchema.parse({
      schemaVersion: 1,
      id: "sha256:" + hash,
      hash,
      revision: 1,
      createdAt: "2026-10-12T00:00:00Z",
      kind: "image",
      files: { original: "projects/test/assets/imported/" + hash + ".png", bytes: png.length, mime: "image/png" },
      media: { width: 1, height: 1, codec: "png", hasAudio: false },
      provenance: { origin: "manual", tool: "Fixed encoded DATA; no import/probe/decode" },
      rights: { licence: "unknown" },
      entityLinks: [],
      status: "candidate",
    }),
    registry = path.join(project, "pipeline/asset-registry.json");
  writeFileSync(registry, JSON.stringify({ schemaVersion: 1, revision: 1, assets: [asset] }));
  const draft = {
      assetId: asset.id,
      assetSha256: hash,
      registrySha256: sha(readFileSync(registry)),
      revisionId: "supplied-png",
      sessionId: "supplied-session",
      input: { prompt: "Fresh supplied direction", seed: 0 },
      highUsd: 0.5,
      limits: { maxFrames: 1, maxInputBytes: 4194304, maxResponseBytes: 1048576, maxControls: 4, timeoutMs: 2000 },
    },
    selector = "pipeline/still-selector.json";
  writeFileSync(path.join(project, selector), JSON.stringify(draft));
  const options = {
      root: dir,
      codeRoot: repo,
      allowPaid: false,
      projectScope: "test",
      timeoutMs: 5000,
      stderr: () => {},
    },
    definition = COMMANDS.find((c) => c.name === "realtime_editor")!;
  const args = { project: "test", editor: "supplied", action: "add-asset", expected: 0, "asset-draft": selector };
  assert.equal(prepareCommand(definition, args, options).flags["asset-draft"], selector);
  assert.ok(prepareCommand(definition, args, options).argv.includes("--asset-draft=" + selector));
  assert.equal(definition.paths.includes("asset-draft"), false);
  const env = Object.fromEntries(
      ["PATH", "HOME", "TMPDIR"].filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]!]),
    ),
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        path.join(repo, "node_modules/tsx/dist/cli.mjs"),
        path.join(repo, "src/mcp/stdio.ts"),
        "--root",
        dir,
        "--project",
        "test",
        "--timeout-ms",
        "10000",
      ],
      cwd: dir,
      env,
      stderr: "pipe",
    }),
    client = new Client({ name: "registered-still-offline-test", version: "1.0.0" });
  let channel: LocalEditorChannel | undefined;
  try {
    await client.connect(transport);
    const call = async (values: Record<string, unknown>) =>
      body(await client.callTool({ name: "avc_realtime_editor", arguments: values }));
    const created = await call({ project: "test", editor: "supplied", action: "create", ceiling: 1 });
    assert.equal(created.ok, true);
    const store = new RealtimeEditorStore(dir, "test", "supplied");
    const base = readFileSync(path.join(store.directory, "000.json")),
      source = readFileSync(original),
      registryBytes = readFileSync(registry);
    const added = await call(args);
    assert.equal(added.ok, true, added.message);
    assert.equal(added.metadata.editor.sequence, 1);
    assert.equal(added.metadata.editor.sourceInput.physicalDecodeVerified, false);
    assert.equal(added.metadata.providerAck, false);
    assert.equal(added.metadata.bridge.allowPaid, false);
    const state = store.read();
    assert.equal(state.sequence, 1);
    assert.equal(state.revisions[0].status, "draft");
    assert.equal(state.committedUsd, 0);
    assert.equal(state.providerAck, false);
    assert.equal(state.queued, undefined);
    assert.equal(state.inFlight, undefined);
    const request = store.request("supplied-png");
    assert.deepEqual(Buffer.from(String(request.operation.input.image_url).split(",")[1], "base64"), png);
    assert.equal(request.quote.highUsd, 0.5);
    assert.equal(request.quote.providerEnforced, false);
    const snapshots = Object.fromEntries(
      readdirSync(store.directory).map((file) => [file, sha(readFileSync(path.join(store.directory, file)))]),
    );
    for (const [expected, controls] of [
      [0, { ...draft, revisionId: "new", sessionId: "new-session" }],
      [1, draft],
      [1, { ...draft, revisionId: "new", sessionId: draft.sessionId }],
    ] as const) {
      writeFileSync(path.join(project, selector), JSON.stringify(controls));
      const refused = await call({ ...args, expected });
      assert.equal(refused.ok, false);
      assert.match(refused.message, /sequence|conflict|unique|already|session/i);
    }
    writeFileSync(
      path.join(project, selector),
      JSON.stringify({ ...draft, revisionId: "new", sessionId: "new-session" }),
    );
    for (const value of [
      path.join(project, selector),
      "../foreign/still.json",
      "../../test/project.json",
      "public/projects/test/" + selector,
      "pipeline\\still-selector.json",
    ]) {
      const refused = await call({ ...args, expected: 1, "asset-draft": value });
      assert.equal(refused.ok, false, "Selector must refuse " + value);
    }
    const alias = path.join(project, "pipeline/selector-alias.json");
    symlinkSync(path.join(project, selector), alias);
    assert.equal((await call({ ...args, expected: 1, "asset-draft": "pipeline/selector-alias.json" })).ok, false);
    const foreign = await client.callTool({ name: "avc_realtime_editor", arguments: { ...args, project: "foreign" } });
    assert.ok((foreign as { isError?: boolean }).isError || body(foreign).ok === false);
    channel = new LocalEditorChannel(dir, "test", "supplied", "prior-session");
    assert.equal((await call({ ...args, expected: 1 })).ok, false);
    const pending = channel.accept(
      Buffer.from(
        JSON.stringify({
          version: 1,
          localSessionId: "prior-session",
          editorId: "supplied",
          messageId: "lost",
          expectedSequence: 1,
          action: "queue",
          revisionId: "absent",
        }),
      ),
    );
    channel.close();
    await pending;
    const unknown = await call({ ...args, expected: 1 });
    assert.equal(unknown.ok, false);
    assert.match(unknown.message, /history|lease|inspection|reconciliation/i);
    assert.deepEqual(
      Object.fromEntries(
        readdirSync(store.directory).map((file) => [file, sha(readFileSync(path.join(store.directory, file)))]),
      ),
      snapshots,
    );
    assert.deepEqual(readFileSync(path.join(store.directory, "000.json")), base);
    assert.deepEqual(readFileSync(original), source);
    assert.deepEqual(readFileSync(registry), registryBytes);
    assert.equal(store.read().sequence, 1);
    assert.equal(store.read().committedUsd, 0);
    assert.equal(store.read().providerAck, false);
    for (const file of ["pipeline/operations.json", "pipeline/financial-state.json", "pipeline/asset-ledger.json"])
      assert.equal(existsSync(path.join(project, file)), false);
    assert.equal(existsSync(path.join(dir, ".cache/realtime")), false);
    t.diagnostic(
      JSON.stringify({
        scenario: "registered-still-MCP",
        metadata: {
          sequence: store.read().sequence,
          committedUsd: store.read().committedUsd,
          providerAck: store.read().providerAck,
          queued: store.read().queued ?? null,
          inFlight: store.read().inFlight ?? null,
        },
        source: {
          bytes: png.length,
          sha256: hash,
          registrySha256: sha(readFileSync(registry)),
          physicalDecodeVerified: added.metadata.editor.sourceInput.physicalDecodeVerified,
        },
        requestSha256: state.revisions[0].request.sha256,
        relativeSelectorPreserved: true,
        immutableSnapshots: snapshots,
        refusals: [
          "staleCAS",
          "reusedRevision",
          "reusedSession",
          "absolute",
          "traversal",
          "workspaceRelative",
          "backslash",
          "selectorSymlink",
          "foreignProject",
          "activeLease",
          "unknownPredecessor",
        ],
        apiSpendUsd: 0,
        providerExecution: false,
      }),
    );
  } finally {
    channel?.close();
    await client.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test("footage editing tools scope every path, including listed multicam inputs and project-relative chapters", () => {
  const dir = fixture(),
    options = { root: dir, codeRoot: repo, allowPaid: false, stderr: () => {} };
  const find = (name: string) => COMMANDS.find((command) => command.name === name)!;
  try {
    for (const name of [
      "recut_plan",
      "shorts_prepare",
      "shorts_rank",
      "shorts_calibrate",
      "shorts_request",
      "multicam_sync",
      "multicam_angles",
      "reframe_track",
    ]) {
      const definition = find(name);
      assert.ok(existsSync(path.join(repo, "scripts", definition.script)), name);
      assert.equal(definition.paid, "local", name);
      assert.equal(definition.readOnly, false, name);
    }
    assert.equal(
      COMMANDS.some((command) => command.script === "speech-local.ts"),
      false,
      "speech:local stays a trusted CLI",
    );
    const sync = prepareCommand(
      find("multicam_sync"),
      { inputs: ["wide.mp4", "close.mp4"], output: "sync.json" },
      options,
    );
    assert.equal(sync.flags.inputs, [scopedPath(dir, "wide.mp4"), scopedPath(dir, "close.mp4")].join(","));
    assert.ok(sync.argv.includes(`--inputs=${sync.flags.inputs}`));
    assert.throws(
      () =>
        prepareCommand(find("multicam_sync"), { inputs: ["wide.mp4", "../outside.mp4"], output: "sync.json" }, options),
      /outside|escapes/,
    );
    assert.throws(
      () => prepareCommand(find("multicam_sync"), { inputs: ["a,b.mp4", "close.mp4"], output: "sync.json" }, options),
      /comma/,
    );
    assert.throws(() => prepareCommand(find("multicam_sync"), { inputs: ["wide.mp4"], output: "sync.json" }, options));
    assert.throws(
      () =>
        prepareCommand(
          find("recut_plan"),
          { transcript: "t.json", source: "talk.mp4", "project-id": "recut", "speech-mask": "../mask.json" },
          options,
        ),
      /outside|escapes/,
    );
    assert.throws(() => prepareCommand(find("recut_plan"), { transcript: "t.json", "project-id": "../x" }, options));
    assert.equal(
      prepareCommand(
        find("recut_plan"),
        { transcript: "t.json", source: "talk.mp4", "project-id": "recut", fillers: false },
        options,
      ).argv.includes("--fillers=false"),
      true,
    );
    assert.throws(
      () => prepareCommand(find("recut_plan"), { transcript: "t.json", "project-id": "recut" }, options),
      "source is required so the transcript path is never probed",
    );
    assert.throws(
      () =>
        prepareCommand(
          find("recut_plan"),
          { transcript: "t.json", source: "/etc/hosts", "project-id": "recut" },
          options,
        ),
      /outside|escapes/,
    );
    const reframe = prepareCommand(
      find("reframe_track"),
      {
        input: "wide.mp4",
        output: "crop.json",
        "command-output": "edit.json",
        "clip-id": "all",
        timeline: "public/projects/test/pipeline/timeline-edit.json",
        "recording-edit": "public/projects/test/pipeline/recording-edit.json",
      },
      options,
    );
    assert.equal(reframe.flags.timeline, scopedPath(dir, "public/projects/test/pipeline/timeline-edit.json"));
    assert.equal(reframe.flags["recording-edit"], scopedPath(dir, "public/projects/test/pipeline/recording-edit.json"));
    for (const field of ["timeline", "recording-edit"])
      assert.throws(
        () =>
          prepareCommand(
            find("reframe_track"),
            { input: "wide.mp4", output: "crop.json", [field]: "../x.json" },
            options,
          ),
        /outside|escapes/,
      );
    assert.throws(
      () => prepareCommand(find("reframe_track"), { input: "wide.mp4", output: "/tmp/crop.json" }, options),
      /outside|escapes/,
    );
    for (const chapters of ["../chapters.json", "/etc/chapters.json", "pipeline/../../x.json"])
      assert.throws(
        () =>
          prepareCommand(
            find("shorts_rank"),
            { prepared: "shorts", candidates: "c.json", project: "test", chapters },
            options,
          ),
        chapters,
      );
    assert.equal(
      prepareCommand(
        find("shorts_rank"),
        { prepared: "shorts", candidates: "c.json", project: "test", chapters: "pipeline/chapters.json" },
        options,
      ).flags.chapters,
      "pipeline/chapters.json",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("film chain tools scope every path and leave approvals and doc regeneration to the CLI", () => {
  const dir = fixture(),
    options = { root: dir, codeRoot: repo, allowPaid: false, stderr: () => {} };
  const find = (name: string) => COMMANDS.find((command) => command.name === name);
  try {
    for (const name of [
      "film_init",
      "film_done",
      "film_route",
      "film_stills",
      "film_render",
      "creative_stimuli",
      "commands",
    ])
      assert.ok(find(name) && existsSync(path.join(repo, "scripts", find(name)!.script)), name);
    for (const name of ["film_approve", "film_rights"]) assert.equal(find(name), undefined, name);
    for (const name of ["film_init", "project_create"]) {
      const { flags } = prepareCommand(find(name)!, { project: "test", title: "  Обзор камеры  " }, options);
      assert.equal(flags.title, "Обзор камеры");
      assert.throws(() => prepareCommand(find(name)!, { project: "test", title: " " }, options));
    }
    assert.equal(
      prepareCommand(find("film_init")!, { project: "test", product: "brief.md" }, options).flags.product,
      scopedPath(dir, "brief.md"),
    );
    assert.throws(
      () => prepareCommand(find("film_init")!, { project: "test", product: "../brief.md" }, options),
      /outside|escapes/,
    );
    for (const field of ["output", "audio", "decision", "receipt", "measure", "cue-sheet"])
      assert.throws(
        () => prepareCommand(find("film_render")!, { composition: "Film", [field]: "../x" }, options),
        /outside|escapes/,
        field,
      );
    assert.throws(
      () => prepareCommand(find("film_stills")!, { composition: "Film", output: "/tmp/stills" }, options),
      /outside|escapes/,
    );
    assert.throws(() => prepareCommand(find("film_route")!, { "write-doc": true }, options));
    assert.throws(() => prepareCommand(find("film_done")!, { project: "test", step: "brief", answer: "yes" }, options));
    assert.throws(
      () =>
        prepareCommand(find("film_done")!, { project: "other", step: "brief" }, { ...options, projectScope: "test" }),
      /scope/,
    );
    assert.throws(() => prepareCommand(find("commands")!, { "write-doc": true }, options));
    assert.equal(
      prepareCommand(find("playbook")!, { use: "footage-edit", project: "test" }, options).flags.use,
      "footage-edit",
    );
    assert.equal(prepareCommand(find("playbook")!, { uses: "captions" }, options).flags.uses, "captions");
    for (const flag of ["write-doc", "check", "by", "force"])
      assert.throws(() => prepareCommand(find("playbook")!, { [flag]: flag === "by" ? "user" : true }, options), flag);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fal doctor is read-only, project-scoped and refuses catalogue path overrides", async () => {
  const dir = fixture(),
    options = { root: dir, codeRoot: repo, allowPaid: false, projectScope: "test" };
  try {
    const doctor = COMMANDS.find((command) => command.name === "fal_doctor")!;
    assert.equal(doctor.readOnly, true);
    assert.equal(doctor.paid, "local");
    assert.deepEqual(doctor.paths, []);
    const plan = prepareCommand(doctor, { project: "test", "only-project": true }, options);
    assert.equal(plan.enforcedDryRun, false);
    assert.deepEqual(plan.argv, ["--project=test", "--only-project=true", "--scope-root=" + realpathSync(dir)]);
    const result = await invokeCommand(doctor, { project: "test", "only-project": true }, options);
    assert.equal(result.ok, true);
    assert.deepEqual(result.outputs, []);
    assert.deepEqual((result.metadata as Record<string, unknown>).findings, []);
    assert.equal(result.metadata.bridge.allowPaid, false);
    assert.throws(() => prepareCommand(doctor, { project: "other" }, options), /scope/);
    assert.throws(() => prepareCommand(doctor, {}, options), /scoped project/);
    for (const flag of ["catalog", "out", "scope-root"])
      assert.throws(() => prepareCommand(doctor, { project: "test", [flag]: "../escape" }, options));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fal doctor refuses project JSON symlinks escaping the trusted workspace", async () => {
  const dir = fixture(),
    outside = mkdtempSync(path.join(tmpdir(), "mcp doctor external ")),
    options = { root: dir, codeRoot: repo, allowPaid: false, projectScope: "test" };
  try {
    const doctor = COMMANDS.find((command) => command.name === "fal_doctor")!,
      pipeline = path.join(dir, "public/projects/test/pipeline");
    mkdirSync(pipeline);
    const external = path.join(outside, "external.json");
    writeFileSync(
      external,
      JSON.stringify({ jobs: { external: { endpoint: "outside/private-endpoint" } }, assets: [] }),
    );
    for (const name of ["operations.json", "asset-plan.json"]) {
      const file = path.join(pipeline, name);
      symlinkSync(external, file);
      const result = await invokeCommand(doctor, { project: "test", "only-project": true }, options);
      assert.equal(result.ok, false);
      assert.match(result.message!, /outside|escapes/);
      assert.equal(JSON.stringify(result.metadata).includes("outside/private-endpoint"), false);
      rmSync(file);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("fal scaffold output is scoped and local; JSON assignments remain literal", () => {
  const dir = fixture(),
    options = { root: dir, codeRoot: repo, allowPaid: false };
  try {
    const scaffold = COMMANDS.find((command) => command.name === "fal_scaffold")!;
    assert.throws(
      () => prepareCommand(scaffold, { endpoint: "fal-ai/flux/schnell", out: "../escape.json" }, options),
      /escapes/,
    );
    const patches = JSON.stringify(["prompt=Literal, $(touch HACKED)", "image_size.width=1080"]);
    const plan = prepareCommand(
      scaffold,
      { endpoint: "fal-ai/flux/schnell", out: "request.json", "set-json": patches },
      options,
    );
    assert.ok(plan.argv.includes(`--set-json=${patches}`));
    assert.equal(plan.enforcedDryRun, false);
    assert.throws(() => prepareCommand(scaffold, { endpoint: "fal-ai/flux/schnell", force: true }, options));
    assert.throws(() =>
      prepareCommand(
        COMMANDS.find((command) => command.name === "fal_find")!,
        { limit: 101 },
        options,
      ),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fal batch and quote scope paths, enforce dry-run spend, and keep provider estimates CLI-only", () => {
  const dir = fixture();
  const options = { root: dir, codeRoot: repo, allowPaid: false, projectScope: "test" };
  try {
    const batch = COMMANDS.find((command) => command.name === "fal_batch")!,
      quote = COMMANDS.find((command) => command.name === "fal_quote")!,
      budget = COMMANDS.find((command) => command.name === "budget")!;
    const planned = prepareCommand(batch, { project: "test", spec: "batch.json" }, options);
    assert.equal(planned.enforcedDryRun, true);
    assert.equal(planned.flags["dry-run"], true);
    assert.equal(planned.flags.spec, scopedPath(dir, "batch.json"));
    assert.equal(planned.flags["scope-root"], realpathSync(dir));
    assert.equal(quote.readOnly, true);
    assert.equal(quote.paid, "local");
    for (const [definition, field] of [
      [batch, "spec"],
      [quote, "request"],
      [quote, "spec"],
      [budget, "forecast"],
    ] as const) {
      assert.throws(
        () => prepareCommand(definition, { project: "test", [field]: "../escape.json" }, options),
        /outside|escapes/,
      );
      assert.equal(
        prepareCommand(definition, { project: "test", [field]: "input.json" }, options).flags[field],
        scopedPath(dir, "input.json"),
      );
    }
    assert.throws(() =>
      prepareCommand(quote, { project: "test", request: "request.json", "provider-estimate": true }, options),
    );
    assert.throws(() => prepareCommand(batch, { project: "other", spec: "batch.json" }, options), /scope/);
    assert.throws(() => prepareCommand(batch, { project: "test", spec: "batch.json", "scope-root": "/" }, options));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("SFX generation scopes video/output paths and defaults to no-spend", () => {
  const dir = fixture(),
    options = { root: dir, codeRoot: repo, allowPaid: false, projectScope: "test" };
  try {
    const definition = COMMANDS.find((command) => command.name === "sfx_generate")!;
    const args = {
      project: "test",
      endpoint: "mirelo-ai/sfx2.0/video-to-audio",
      video: "reference.mp4",
      output: "public/projects/test/assets/foley.wav",
      "dry-run": false,
    };
    const plan = prepareCommand(definition, args, options);
    assert.ok(plan.argv.includes("--dry-run=true"));
    assert.equal(plan.flags.video, path.join(realpathSync(dir), "reference.mp4"));
    assert.equal(plan.flags.output, path.join(realpathSync(dir), "public/projects/test/assets/foley.wav"));
    for (const field of ["video", "output"])
      assert.throws(() => prepareCommand(definition, { ...args, [field]: "../outside" }, options), /escapes/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("provider-aware find/scaffold and models comparison are local strict MCP tools", () => {
  const dir = fixture();
  try {
    const options = { root: dir, codeRoot: repo, allowPaid: false };
    for (const [name, args] of [
      ["fal_find", { provider: "higgsfield", task: "character swap", limit: 1 }],
      ["fal_scaffold", { provider: "higgsfield", endpoint: "higgsfield-ai/soul/v2/standard" }],
      ["models_compare", { endpoint: "missing/endpoint", resolution: "720p", duration: 5 }],
    ] as const) {
      const command = COMMANDS.find((row) => row.name === name)!;
      assert.equal(command.paid, "local");
      const prepared = prepareCommand(command, args, options);
      if ("provider" in args) assert.ok(prepared.argv.includes("--provider=higgsfield"));
      assert.ok(prepared.script.endsWith(command.script));
      assert.equal(prepared.enforcedDryRun, false);
    }
    assert.equal(
      COMMANDS.some((row) => row.name === "models_refresh"),
      false,
    );
    assert.throws(() =>
      prepareCommand(
        COMMANDS.find((row) => row.name === "models_compare")!,
        { provider: "any" },
        options,
      ),
    );
    const profiles = COMMANDS.find((row) => row.name === "refs_profiles")!;
    assert.equal(profiles.paid, "local");
    assert.equal(profiles.readOnly, true);
    assert.deepEqual(profiles.paths, []);
    assert.ok(
      prepareCommand(profiles, { action: "for", endpoint: "google/nano-banana-2.1/edit" }, options).argv.includes(
        "--endpoint=google/nano-banana-2.1/edit",
      ),
    );
    assert.throws(() => prepareCommand(profiles, { action: "check", file: "x.json" }, options));
    const capabilities = COMMANDS.find((row) => row.name === "models_capabilities")!;
    assert.equal(capabilities.paid, "local");
    assert.equal(capabilities.readOnly, true);
    assert.deepEqual(capabilities.paths, []);
    const search = prepareCommand(
      capabilities,
      { capability: "end-frame,generate-audio", field: "^last_(image|frame)", "input-audio-sec": 12, "max-usd": 1 },
      options,
    );
    assert.ok(search.argv.includes("--capability=end-frame,generate-audio"));
    assert.ok(search.argv.includes("--field=^last_(image|frame)"));
    assert.ok(search.argv.includes("--input-audio-sec=12"));
    assert.throws(() => prepareCommand(capabilities, { list: true, "write-doc": true }, options));
    const find = COMMANDS.find((row) => row.name === "fal_find")!;
    assert.ok(
      prepareCommand(find, { "any-capability": "loop,keyframes", "input-video-sec": 20 }, options).argv.includes(
        "--any-capability=loop,keyframes",
      ),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("media fetching scopes batch input/output, project and spend without exposing worker or secrets", () => {
  const dir = fixture(),
    options = { root: dir, codeRoot: repo, allowPaid: false, projectScope: "test" };
  try {
    const definition = COMMANDS.find((command) => command.name === "media_fetch")!;
    const planned = prepareCommand(definition, { project: "test", url: "https://youtu.be/example" }, options);
    assert.equal(planned.enforcedDryRun, true);
    assert.equal(planned.flags["scope-root"], realpathSync(dir));
    for (const field of ["input", "output-dir"])
      assert.throws(
        () => prepareCommand(definition, { project: "test", [field]: "../escape" }, options),
        /outside|escapes/,
      );
    assert.throws(
      () => prepareCommand(definition, { "output-dir": "out/inbox", url: "https://youtu.be/example" }, options),
      /project|scope/,
    );
    for (const field of ["worker", "RAPIDAPI_KEY", "scope-root"])
      assert.throws(() => prepareCommand(definition, { project: "test", [field]: "arbitrary" }, options));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("task-slot discovery is local read-only and refuses maintenance flags", () => {
  const dir = fixture();
  try {
    for (const name of ["models_pick", "models_slots"]) {
      const definition = COMMANDS.find((command) => command.name === name)!;
      assert.equal(definition.paid, "local");
      assert.equal(definition.readOnly, true);
      assert.deepEqual(definition.paths, []);
      const options = { root: dir, codeRoot: repo, projectScope: "test", allowPaid: false };
      assert.throws(() => prepareCommand(definition, { project: "other" }, options));
      assert.throws(() => prepareCommand(definition, { project: "test", "write-doc": true }, options));
      assert.throws(() => prepareCommand(definition, { project: "test", retire: "example/model" }, options));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("film_show is local and read-only, scopes its artefact path and passes fields; film_brief takes print", () => {
  const dir = fixture();
  try {
    const options = { root: dir, codeRoot: repo, allowPaid: false };
    const show = COMMANDS.find((command) => command.name === "film_show")!;
    assert.equal(show.paid, "local");
    assert.equal(show.readOnly, true);
    assert.deepEqual(show.paths, ["artefact"]);
    const artefact = "public/projects/test/pipeline/brief.json";
    const argv = prepareCommand(show, { project: "test", artefact, fields: "a.b,c", depth: 2 }, options).argv;
    assert.ok(argv.includes(`--artefact=${scopedPath(dir, artefact)}`), argv.join(" "));
    assert.ok(argv.includes("--fields=a.b,c"), argv.join(" "));
    assert.throws(() => prepareCommand(show, { project: "test", artefact: "../outside.json" }, options), /escapes/);
    assert.throws(() => prepareCommand(show, { project: "test", depth: 9 }, options));
    const brief = COMMANDS.find((command) => command.name === "film_brief")!;
    assert.ok(
      prepareCommand(brief, { project: "test", step: "intake", print: true }, options).argv.includes("--print=true"),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
