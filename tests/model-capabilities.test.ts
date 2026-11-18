import "./helpers/fal-no-network";
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { CATALOG_DIR, HF_CATALOG_DIR, loadCatalog, loadProviderCatalog } from "../src/lib/models/fal-catalog";
import {
  CAPABILITY_IDS,
  capabilityProfile,
  checkInputSeconds,
  secondsFromDescription,
} from "../src/lib/models/capabilities";
import { capabilityVocabulary, searchCapabilities } from "../src/lib/models/capability-search";
import { checkModelConstraints } from "../src/lib/models/model-constraints";
import { findFalEndpointResult } from "../src/lib/models/fal-find";
import { FalFindResultSchema, MODEL_CAPABILITY_IDS, type FalCatalogEntry as Entry } from "../src/types/fal-catalog";

// Fal input-length limits come only from the local schema cache (read at call time): keep it empty and portable.
process.env.AGENTBROS_FAL_SCHEMA_CACHE = mkdtempSync(path.join(tmpdir(), "capabilities-cache-"));

const repo = path.resolve(import.meta.dirname, "..");
const fal = loadCatalog(CATALOG_DIR);
const hf = loadProviderCatalog("higgsfield", HF_CATALOG_DIR);
const real = (catalog: ReadonlyMap<string, Entry>, endpoint: string): Entry => {
  const found = catalog.get(endpoint);
  assert.ok(found, `tracked catalogue lacks ${endpoint}`);
  return found;
};
type Constraints = Parameters<typeof checkModelConstraints>[1];
const check = (entry: Entry, extra: Partial<Constraints>) =>
  checkModelConstraints(entry, { categories: [], inputs: [], outputs: [], ...extra });

test("every capability in the vocabulary is held by at least one active tracked model", () => {
  assert.deepEqual([...CAPABILITY_IDS], [...MODEL_CAPABILITY_IDS]);
  const rows = capabilityVocabulary({ fal, higgsfield: hf });
  assert.equal(rows.length, MODEL_CAPABILITY_IDS.length);
  for (const row of rows) {
    assert.ok(row.models.fal + row.models.higgsfield > 0, `${row.id} has no model`);
    assert.ok(row.description.length > 5 && row.fields.length > 0, row.id);
  }
});

test("real catalogue entries resolve to the expected capabilities", () => {
  const draft = capabilityProfile(
    real(fal, "blackforestlabs/flux-3/first-last-frame-to-video/draft"),
    {},
    {
      price: () => ({
        kind: "unknown",
        label: "x",
        usd: null,
        unitPrice: null,
        unit: null,
        asOf: null,
        evidenceKind: "none",
        basis: null,
      }),
    },
  );
  assert.equal(draft.fields["end-frame"], "end_image_url");
  assert.equal(draft.fields["start-frame"], "start_image_url");

  const kling = capabilityProfile(real(fal, "fal-ai/kling-video/v3/pro/image-to-video"), { durationSec: 5 });
  for (const id of ["start-frame", "end-frame", "generate-audio", "multi-shot", "elements", "negative-prompt"] as const)
    assert.ok(kling.capabilities.includes(id), id);
  assert.deepEqual(kling.limits.durationSec, {
    field: "duration",
    enum: [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
    default: 5,
  });
  assert.deepEqual(kling.inputs, ["image"]);
  assert.deepEqual(kling.outputs, ["video"]);
  assert.ok(["bounded", "estimated", "unknown"].includes(kling.price.status));
  assert.deepEqual(kling.price.scenario, { durationSec: 5 });

  const hfKling = capabilityProfile(real(hf, "kling-video/v3.0/pro/image-to-video"), {});
  assert.equal(hfKling.provider, "higgsfield");
  assert.equal(hfKling.fields["end-frame"], "last_image_url");
  assert.equal(hfKling.fields["start-frame"], "image_url");
  assert.equal(hfKling.fields["generate-audio"], "sound");
  assert.deepEqual(hfKling.limits.durationSec, { field: "duration", min: 3, max: 15, default: 5 });
});

test("a model lacking a capability is rejected; --any-capability and --field fall back", () => {
  const t2v = real(fal, "blackforestlabs/flux-3/image-to-video/draft");
  assert.deepEqual(check(t2v, { capabilities: ["end-frame"] }).rejectedBecause, ["missing capability: end-frame"]);
  const kling = real(fal, "fal-ai/kling-video/v3/pro/image-to-video");
  const both = check(kling, { capabilities: ["end-frame", "generate-audio"] });
  assert.deepEqual(both.rejectedBecause, []);
  assert.deepEqual(both.matchedCapabilities, [
    { capability: "end-frame", field: "end_image_url" },
    { capability: "generate-audio", field: "generate_audio" },
  ]);
  assert.deepEqual(check(kling, { capabilities: ["end-frame", "lyrics"] }).rejectedBecause, [
    "missing capability: lyrics",
  ]);
  const any = check(kling, { anyCapabilities: ["lyrics", "multi-shot"] });
  assert.deepEqual(any.rejectedBecause, []);
  assert.deepEqual(any.matchedCapabilities, [{ capability: "multi-shot", field: "multi_prompt" }]);
  assert.deepEqual(check(kling, { anyCapabilities: ["lyrics", "loop"] }).rejectedBecause, [
    "missing any capability of: lyrics, loop",
  ]);
  const hfKling = real(hf, "kling-video/v3.0/pro/image-to-video");
  assert.deepEqual(check(hfKling, { field: "^LAST_image" }).rejectedBecause, []);
  assert.deepEqual(check(kling, { field: "^last_image" }).rejectedBecause, ["no input field matches /^last_image/"]);
});

test("input media seconds: stated Higgsfield limits reject, unknown limits warn", () => {
  assert.deepEqual(secondsFromDescription("Source video, 4–30 seconds."), { min: 4, max: 30 });
  assert.deepEqual(secondsFromDescription("Up to 5 files, 30s total. WAV or MP3."), { max: 30 });
  assert.deepEqual(secondsFromDescription("Up to 5 clips, 30s total, each 1-30s."), { min: 1, max: 30 });
  assert.equal(secondsFromDescription("Write your prompt here"), undefined);

  const wan = real(hf, "alibaba/wan-3.0/reference-to-video");
  const profile = capabilityProfile(wan, {});
  assert.deepEqual(
    profile.limits.inputAudioSec && typeof profile.limits.inputAudioSec === "object"
      ? profile.limits.inputAudioSec.max
      : null,
    30,
  );
  const over = checkInputSeconds(wan, { inputAudioSec: 40 });
  assert.deepEqual(over.rejectedBecause, ["input audio 40 s above stated max 30 s (audio_urls)"]);
  assert.deepEqual(checkInputSeconds(wan, { inputAudioSec: 20 }).rejectedBecause, []);
  assert.deepEqual(check(wan, { inputVideoSec: 40 }).rejectedBecause, [
    "input video 40 s above stated max 30 s (video_urls)",
  ]);

  const lipsync = [...fal.values()].find(
    (entry) =>
      entry.status === "active" &&
      entry.category === "video-to-video" &&
      entry.inputs.some((field) => field.media === "audio"),
  )!;
  const unknown = check(lipsync, { inputAudioSec: 40 });
  assert.deepEqual(
    unknown.rejectedBecause.filter((reason) => reason.startsWith("input audio")),
    [],
  );
  assert.ok(
    unknown.warnings.some((warning) => warning.startsWith("input audio length limit unknown")),
    lipsync.endpoint,
  );
  // No audio input: the flag does not apply.
  assert.deepEqual(checkInputSeconds(real(fal, "fal-ai/kling-video/v3/pro/image-to-video"), { inputAudioSec: 40 }), {
    rejectedBecause: [],
    warnings: [],
    reasons: [],
  });
});

test("a capability-only query without a task searches both catalogues", () => {
  const found = findFalEndpointResult(
    { provider: "any", anyCapabilities: ["loop", "keyframes"] },
    {
      catalog: new Map(
        [...fal.values(), ...hf.values()].map((entry) => [`${entry.provider ?? "fal"}:${entry.endpoint}`, entry]),
      ),
    },
  );
  assert.equal(found.match.via, "explicit");
  assert.ok(found.candidates.length > 0);
  for (const candidate of found.candidates)
    assert.ok(
      candidate.matchedCapabilities?.some((item) => ["loop", "keyframes"].includes(item.capability)),
      candidate.endpoint,
    );

  const table = searchCapabilities(
    { provider: "any", capabilities: ["end-frame"], limit: 100 },
    {},
    { catalogs: { fal, higgsfield: hf } },
  );
  assert.ok(
    table.rows.some((row) => row.provider === "higgsfield" && row.endpoint === "kling-video/v3.0/pro/image-to-video"),
  );
  assert.ok(
    table.rows.some((row) => row.provider === "fal" && row.endpoint === "fal-ai/kling-video/v3/pro/image-to-video"),
  );
  for (const row of table.rows) assert.equal(row.matched[0]?.capability, "end-frame");
});

function cli(args: string[]) {
  const child = spawnSync(
    process.execPath,
    [
      "--import",
      path.join(repo, "node_modules/tsx/dist/loader.mjs"),
      path.join(repo, "scripts/models-capabilities.ts"),
      ...args,
    ],
    {
      cwd: repo,
      encoding: "utf8",
      env: {
        AGENTBROS_NO_DOTENV: "1",
        PATH: process.env.PATH,
        AGENTBROS_FAL_SCHEMA_CACHE: process.env.AGENTBROS_FAL_SCHEMA_CACHE,
        AGENTBROS_MEMORY_ROOT: process.env.AGENTBROS_MEMORY_ROOT,
      },
    },
  );
  assert.equal(child.error, undefined);
  assert.equal(child.stdout.trim().split("\n").length, 1, child.stderr + child.stdout);
  const envelope = JSON.parse(child.stdout);
  assert.equal(typeof envelope.elapsedMs, "number");
  assert.equal(envelope.ok, child.status === 0, child.stderr + child.stdout);
  return envelope;
}

test("models:capabilities CLI: --list, --endpoint, search and invalid input, one JSON line each", () => {
  const list = cli(["--list"]);
  assert.equal(list.ok, true);
  assert.equal(list.metadata.capabilities.length, MODEL_CAPABILITY_IDS.length);
  const endFrame = list.metadata.capabilities.find((row: { id: string }) => row.id === "end-frame");
  assert.ok(endFrame.models.fal > 0 && endFrame.models.higgsfield > 0);

  const profile = cli([
    "--endpoint",
    "kling-video/v3.0/pro/image-to-video",
    "--provider",
    "higgsfield",
    "--duration",
    "5",
  ]);
  assert.equal(profile.ok, true);
  assert.equal(profile.metadata.profiles.length, 1);
  assert.equal(profile.metadata.profiles[0].fields["end-frame"], "last_image_url");

  const search = cli(["--capability", "end-frame,generate-audio", "--duration", "5", "--max-usd", "1"]);
  assert.equal(search.ok, true);
  assert.ok(search.metadata.rows.length > 0);
  for (const row of search.metadata.rows) {
    assert.deepEqual(
      row.matched.map((item: { capability: string }) => item.capability),
      ["end-frame", "generate-audio"],
    );
    assert.equal(row.price.status, "bounded");
    assert.ok(row.price.usd <= 1, row.endpoint);
  }

  assert.equal(cli([]).error, "INVALID_INPUT");
  assert.equal(cli(["--list", "--capability", "seed"]).error, "INVALID_INPUT");
  assert.equal(cli(["--endpoint", "nobody/none"]).error, "INVALID_INPUT");
  assert.equal(cli(["--capability", "teleport"]).ok, false);
  assert.equal(cli(["--field", "("]).ok, false);
});

test("the finder prices only rows that pass every other check unless --explain asks for rejected rows", () => {
  const ids = ["fal-ai/kling-video/v3/pro/image-to-video", "blackforestlabs/flux-3/image-to-video/draft"];
  const catalog = new Map(ids.map((id) => [id, real(fal, id)]));
  const priced: string[] = [];
  const price = (entry: Entry) => {
    priced.push(entry.endpoint);
    return {
      kind: "exact" as const,
      label: "$0.5",
      usd: 0.5,
      unitPrice: 0.1,
      unit: "second",
      asOf: "2026-11-17",
      evidenceKind: "test",
      basis: "second",
    };
  };
  const query = { provider: "fal" as const, capabilities: ["end-frame" as const] };
  const quiet = findFalEndpointResult(query, { catalog, env: {}, price });
  FalFindResultSchema.parse(quiet);
  assert.deepEqual(
    quiet.candidates.map((row) => row.endpoint),
    [ids[0]],
  );
  assert.deepEqual(priced, [ids[0]]);
  priced.length = 0;
  findFalEndpointResult({ ...query, explain: true }, { catalog, env: {}, price });
  assert.deepEqual(priced.sort(), [...ids].sort());
});
