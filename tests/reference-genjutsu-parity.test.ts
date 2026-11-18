import "./helpers/fal-no-network";
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { genjutsuPrompt, prepareModel } from "../src/lib/model-preparation/prepare";
import { preparationAsPack, preparationPackId } from "../src/lib/model-preparation/as-pack";
import { genjutsuEndpoint } from "../src/lib/model-preparation/profiles";
import { preparationFile } from "../src/lib/model-preparation/storage";
import { compilePack, packSpecFromPreparation } from "../src/lib/references/compile";
import { profileForEndpoint } from "../src/lib/references/profiles";
import { checkPack, listPacks } from "../src/lib/references/packs";
import { CliErrorObject } from "../src/lib/cli";
import type { ModelPreparationSpec } from "../src/types/model-preparation";
import { genjutsuFixture } from "./helpers/genjutsu-preparation";

/** RFC 0003 AC15 (WP9): model:prepare compiles through the pack compiler with the real genjutsu-* profiles. Offline. */

const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0 && spawnSync("ffprobe", ["-version"]).status === 0;
const media = { skip: hasFfmpeg ? false : "needs ffmpeg and ffprobe" } as const;

type Fixture = ReturnType<typeof genjutsuFixture>;
const cases: Record<string, (f: Fixture) => ModelPreparationSpec> = {
  "object-swap with otherSubjects": (f) => f.spec("object-swap", "swap-other"),
  "object-swap without markers": (f) => ({ ...f.spec("object-swap", "swap-plain"), useMarkers: false }),
  "motion-transfer with an additional prompt, no other subjects": (f) => {
    const spec = f.spec("motion-transfer", "transfer-extra");
    return {
      ...spec,
      target: { ...spec.target, otherSubjects: [] },
      additionalPrompt: "Keep the lantern flame warm and steady.",
      resolution: "1080p",
    };
  },
  "restyle without references": (f) => ({ ...f.spec("restyle", "restyle-bare"), references: [] }),
  "restyle with a reference, no markers, additional prompt": (f) => ({
    ...f.spec("restyle", "restyle-plain"),
    useMarkers: false,
    additionalPrompt: "Grain like 16 mm film.",
  }),
};

for (const [name, make] of Object.entries(cases))
  test(`genjutsu parity through model:prepare: ${name}`, media, (t) => {
    const f = genjutsuFixture(t);
    const spec = make(f);
    const data = prepareModel("demo", spec, f.rootDir);
    const stored = JSON.parse(readFileSync(preparationFile("demo", spec.id, "request.json", f.rootDir), "utf8")) as {
      input: Record<string, unknown>;
    };
    assert.equal(JSON.stringify(stored.input), JSON.stringify(data.request.input));
    const profile = profileForEndpoint(genjutsuEndpoint(spec.mode), "higgsfield");
    assert.ok(profile, "a genjutsu-* profile per mode");
    assert.equal(profile.family, `genjutsu-${spec.mode}`);
    const { receipt } = data;
    const pack = packSpecFromPreparation(receipt.spec, profile, {
      sourceAssetId: receipt.preparedSource.assetId,
      referenceAssetIds: receipt.references.map((ref) => ref.media.assetId),
    });
    const compiled = compilePack({
      ...pack,
      media: {
        [receipt.preparedSource.assetId]: receipt.preparedSource,
        ...Object.fromEntries(receipt.references.map((ref) => [ref.media.assetId, ref.media])),
      },
    });
    // Same input (values and field order) and byte-identical prompt to the legacy oracle and the stored request.
    assert.equal(JSON.stringify(compiled.input), JSON.stringify(stored.input));
    assert.equal(compiled.compiledPrompt, stored.input.prompt);
    assert.equal(compiled.compiledPrompt, genjutsuPrompt(spec));
    if (spec.useMarkers)
      assert.deepEqual(compiled.markerMap, {
        "@Video1": receipt.preparedSource.assetId,
        ...Object.fromEntries(receipt.references.map((ref, i) => [`@Image${i + 1}`, ref.media.assetId])),
      });
    else {
      assert.doesNotMatch(compiled.compiledPrompt, /@Video|@Image/);
      assert.match(compiled.compiledPrompt, /the attached source video/);
    }
  });

function code(fn: () => unknown, expected: string, message: RegExp) {
  assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof CliErrorObject, String(error));
    assert.equal(error.code, expected);
    assert.match(error.message, message);
    return true;
  });
}

test("as-pack: a prepared Genjutsu input becomes an equivalent, reviewable reference pack", media, (t) => {
  const f = genjutsuFixture(t);
  const data = prepareModel("demo", f.spec("object-swap"), f.rootDir);
  const { pack, preparation } = preparationAsPack("demo", data.receipt.id, f.rootDir);
  assert.equal(pack.receipt.id, preparationPackId(data.receipt.id));
  assert.equal(pack.receipt.id, "genjutsu-object-swap-v1");
  assert.deepEqual(preparation, { id: data.receipt.id, sha256: data.sha256 });
  assert.equal(pack.reused, false);
  assert.equal(JSON.stringify(pack.request.input), JSON.stringify(data.request.input));
  assert.equal(pack.receipt.compiledPrompt, data.request.input.prompt);
  assert.deepEqual(pack.receipt.markerMap, {
    "@Video1": data.receipt.preparedSource.assetId,
    "@Image1": data.receipt.references[0]!.media.assetId,
  });
  // Review-only: no approval or rights are copied from the preparation.
  assert.equal(pack.approval, undefined);
  assert.equal(pack.rights, undefined);
  const checked = checkPack("demo", pack.receipt.id, f.rootDir);
  assert.equal(checked.approvalStatus.approved, false);
  assert.deepEqual(
    listPacks("demo", f.rootDir).map((row) => [row.id, row.status]),
    [["genjutsu-object-swap-v1", "prepared"]],
  );
  assert.equal(preparationAsPack("demo", data.receipt.id, f.rootDir).pack.reused, true);

  // Restyle without references keeps image_urls: [].
  const restyle = prepareModel("demo", { ...f.spec("restyle"), references: [] }, f.rootDir);
  const restylePack = preparationAsPack("demo", restyle.receipt.id, f.rootDir).pack;
  assert.deepEqual(restylePack.request.input.image_urls, []);
  assert.equal(JSON.stringify(restylePack.request.input), JSON.stringify(restyle.request.input));
});

test("as-pack refuses preparations without a pack equivalent", media, (t) => {
  const f = genjutsuFixture(t);
  const plain = prepareModel("demo", { ...f.spec("object-swap", "plain"), useMarkers: false }, f.rootDir);
  code(() => preparationAsPack("demo", plain.receipt.id, f.rootDir), "INVALID_INPUT", /useMarkers false/);
  const longId = `l${"o".repeat(75)}ng`;
  const long = prepareModel("demo", f.spec("object-swap", longId), f.rootDir);
  code(() => preparationAsPack("demo", long.receipt.id, f.rootDir), "INVALID_INPUT", /longer than 80/);
  code(() => preparationAsPack("demo", "absent", f.rootDir), "STAGE_INCOMPLETE", /Prepare absent/);
});
