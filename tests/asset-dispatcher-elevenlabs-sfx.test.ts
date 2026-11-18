import { writeBudgetBrief } from "./helpers/ceiling-grant";
import "./helpers/fal-no-network";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { dispatchAsset, ELEVENLABS_SFX_ENDPOINT } from "../src/lib/asset-dispatcher";
import type { JobProvider } from "../src/lib/jobs/runner";
import { useTempFalCatalog } from "./helpers/fal-temp-catalog";

useTempFalCatalog([
  { endpoint: ELEVENLABS_SFX_ENDPOINT, patch: { tier: "verified", outputs: { kinds: ["audio"], fields: [] } } },
]);

const original = process.cwd();
const root = realpathSync(mkdtempSync(path.join(tmpdir(), "dispatch-elevenlabs-sfx-")));
process.chdir(root);
test.after(() => {
  process.chdir(original);
  rmSync(root, { recursive: true, force: true });
});

function setup(id: string, asset: Record<string, unknown>) {
  const dir = path.join(root, "public/projects", id);
  mkdirSync(path.join(dir, "pipeline"), { recursive: true });
  writeFileSync(path.join(dir, "project.json"), "{}");
  writeBudgetBrief(dir);
  const plan = path.join(dir, "pipeline/asset-plan.json");
  writeFileSync(
    plan,
    JSON.stringify({
      assets: [
        {
          id: "whoosh",
          kind: "sfx",
          source: "elevenlabs-sfx",
          targetPath: "sfx/whoosh.mp3",
          status: "pending",
          prompt: "Fast paper whoosh",
          ...asset,
        },
      ],
    }),
  );
  return { dir, plan };
}

function fakeProvider() {
  const calls = { submits: 0 };
  const provider: JobProvider = {
    submit: async () => {
      calls.submits++;
      return { requestId: "sfx-req-1" };
    },
    inspect: async () => ({
      state: "completed",
      result: {
        audio: { url: "https://v3.fal.media/files/whoosh.mp3", content_type: "audio/mpeg", file_name: "whoosh.mp3" },
      },
    }),
  };
  return { provider, calls };
}

function mp3(): Buffer {
  const wav = Buffer.alloc(44 + 16000 * 2);
  wav.write("RIFF");
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(16000, 24);
  wav.writeUInt32LE(32000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(wav.length - 44, 40);
  const encoded = spawnSync("ffmpeg", ["-v", "error", "-f", "wav", "-i", "pipe:0", "-f", "mp3", "pipe:1"], {
    input: wav,
  });
  assert.equal(encoded.status, 0, encoded.stderr.toString());
  return encoded.stdout;
}

test("elevenlabs-sfx routes through the durable sfx:generate job and publishes once", async () => {
  const { dir, plan } = setup("sfx-live", { metadata: { maxCostUsd: 1, duration: 2 } });
  const { provider, calls } = fakeProvider();
  const bytes = mp3();
  const sfx = { provider, fetch: (async () => new Response(new Uint8Array(bytes))) as typeof fetch };
  const first = await dispatchAsset({ projectId: "sfx-live", assetId: "whoosh" }, { sfx });
  assert.equal(first.ok, true, first.error ?? "");
  const asset = JSON.parse(readFileSync(plan, "utf8")).assets[0];
  assert.equal(asset.status, "done");
  assert.equal(asset.metadata.take.endpoint, ELEVENLABS_SFX_ENDPOINT);
  assert.match(asset.metadata.operationId, /^asset:/);
  assert.ok(existsSync(path.join(dir, "sfx/whoosh.mp3")));
  const again = await dispatchAsset({ projectId: "sfx-live", assetId: "whoosh", force: true }, { sfx });
  assert.equal(again.ok, true, again.error ?? "");
  assert.equal(calls.submits, 1, "resume by operation ID never resubmits");
});

for (const [label, metadata, env] of [
  ["metadata.dryRun", { dryRun: true }, undefined],
  ["AGENTBROS_NO_SPEND", {}, "1"],
] as const) {
  test(`elevenlabs-sfx ${label} plans offline: no submit, no writes, asset stays pending`, async () => {
    const id = `sfx-dry-${label.toLowerCase().replace(/[^a-z]/g, "")}`;
    const { dir, plan } = setup(id, { metadata });
    const { provider, calls } = fakeProvider();
    const previous = process.env.AGENTBROS_NO_SPEND;
    if (env) process.env.AGENTBROS_NO_SPEND = env;
    try {
      const result = await dispatchAsset(
        { projectId: id, assetId: "whoosh" },
        {
          sfx: {
            provider,
            fetch: (async () => {
              throw new Error("no download in dry-run");
            }) as typeof fetch,
          },
        },
      );
      assert.equal(result.ok, true, result.error ?? "");
      assert.equal(result.metadata.dryRun, true);
      assert.deepEqual(result.outputs, []);
    } finally {
      if (previous === undefined) delete process.env.AGENTBROS_NO_SPEND;
      else process.env.AGENTBROS_NO_SPEND = previous;
    }
    assert.equal(calls.submits, 0);
    assert.equal(JSON.parse(readFileSync(plan, "utf8")).assets[0].status, "pending");
    // The dispatcher pre-creates the target directory; nothing is written into it.
    assert.deepEqual(readdirSync(path.join(dir, "sfx")), []);
    assert.equal(existsSync(path.join(dir, "pipeline/model-requests")), false);
  });
}

test("elevenlabs-sfx without a prompt fails as caller input, not INTERNAL", async () => {
  const { plan } = setup("sfx-noprompt", { prompt: undefined });
  const result = await dispatchAsset({ projectId: "sfx-noprompt", assetId: "whoosh" });
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, "INVALID_INPUT");
  assert.equal(JSON.parse(readFileSync(plan, "utf8")).assets[0].status, "failed");
});
