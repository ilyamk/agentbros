import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { compilePack, type MediaFacts } from "../src/lib/references/compile";
import { packProfile } from "../src/lib/references/packs";
import { profileByFamily } from "../src/lib/references/profiles";
import { assignSlots } from "../src/lib/references/plan";
import { DerivativeSpecSchema, ReferencePackSpecSchema, ReferencesPlanSchema } from "../src/types/references";

/** examples/references (RFC 0003 WP11): every example validates, and every pack example compiles on its profile. */

const DIR = path.join(process.cwd(), "examples/references");
const read = (name: string): unknown => JSON.parse(readFileSync(path.join(DIR, name), "utf8"));
const MARKER = /@(Image|Video|Audio|Element)\d/;
const FACTS: Record<string, MediaFacts> = {
  image: { bytes: 400_000, contentType: "image/png", width: 1024, height: 1024 },
  video: { bytes: 4_000_000, contentType: "video/mp4", width: 720, height: 1280, durationSec: 5, fps: 30 },
  audio: { bytes: 300_000, contentType: "audio/wav", durationSec: 8 },
};

test("every examples/references file is covered and holds no hand-written marker", () => {
  const files = readdirSync(DIR).sort();
  assert.deepEqual(files, [
    "derivative-motion-trim.json",
    "pack-kling-o3.json",
    "pack-seedance-2.5.json",
    "references.json",
  ]);
  for (const file of files) assert.doesNotMatch(readFileSync(path.join(DIR, file), "utf8"), MARKER, file);
});

test("the references.json example validates and its shots fit their profiles' slots", () => {
  const plan = ReferencesPlanSchema.parse(read("references.json"));
  assert.equal(plan.shots.length, 2);
  for (const shot of plan.shots) {
    const profile = profileByFamily(shot.target.family);
    assert.ok(profile, shot.target.family);
    if (shot.target.endpoint) assert.ok(profile.endpoints.includes(shot.target.endpoint), shot.target.endpoint);
    const { findings } = assignSlots(
      profile,
      shot.requirements.map((item) => ({
        key: item.key,
        role: item.role,
        modality: item.modality,
        required: item.required,
        ...(item.source?.kind === "entity"
          ? { entityKey: `${item.source.entity.kind}/${item.source.entity.entityId}`, viewRole: item.source.viewRole }
          : {}),
      })),
      shot.shotId,
    );
    assert.deepEqual(
      findings.filter((item) => item.severity === "error"),
      [],
      shot.shotId,
    );
    for (const item of shot.requirements) assert.ok(item.status !== "ready" || item.source, item.key);
  }
});

test("the derivative example is a trim then a snap", () => {
  const spec = DerivativeSpecSchema.parse(read("derivative-motion-trim.json"));
  assert.deepEqual(
    spec.steps.map((step) => step.op),
    ["trim", "snap"],
  );
});

test("the pack examples validate, belong to their profiles and compile with a marker bijection", () => {
  for (const [file, family, markers] of [
    ["pack-seedance-2.5.json", "seedance-2.5", ["@Image1", "@Image2", "@Image3", "@Audio1"]],
    ["pack-kling-o3.json", "kling-o3", ["@Element1", "@Image1"]],
  ] as const) {
    const spec = ReferencePackSpecSchema.parse(read(file));
    const profile = packProfile(spec);
    assert.equal(profile.family, family);
    const modality = new Map(profile.slots.map((slot) => [slot.id, slot.modality]));
    const media = Object.fromEntries(
      spec.attachments.map((item) => [item.source.assetId, FACTS[modality.get(item.slot)!]!]),
    );
    const compiled = compilePack({ spec, profile, media });
    assert.deepEqual(Object.keys(compiled.markerMap).sort(), [...markers].sort(), file);
    for (const marker of markers) assert.ok(compiled.compiledPrompt.includes(marker), `${file}: ${marker}`);
  }
});
