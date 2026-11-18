import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ReferenceProfilesFileSchema, type ReferenceProfilesFile } from "../src/types/reference-profiles";
import {
  REFERENCE_PROFILES_FILE,
  checkReferenceProfiles,
  listProfiles,
  profileByFamily,
  profileForEndpoint,
  type ProfileFindingKind,
} from "../src/lib/references/profiles";
import { SEEDANCE_25_REFERENCE_LIMITS } from "../src/lib/providers/fal-guards/seedance";
import { KLING_ELEMENT_LIMITS } from "../src/lib/providers/fal-guards/kling";
import { NANO_EDIT_LIMITS } from "../src/lib/providers/fal-guards/nano";

const repo = path.resolve(import.meta.dirname, "..");
const raw = (): ReferenceProfilesFile => JSON.parse(readFileSync(REFERENCE_PROFILES_FILE, "utf8"));

test("the shipped profiles validate and carry dated evidence on every slot and dialect (AC1)", () => {
  const file = ReferenceProfilesFileSchema.parse(raw());
  for (const profile of file.profiles) {
    assert.ok(profile.dialect.evidence.checkedAt >= "2026-11-17", profile.family);
    for (const slot of profile.slots) assert.ok(slot.evidence.tier && slot.evidence.checkedAt, slot.id);
  }
});

test("AC1 families are present", () => {
  const families = new Set(listProfiles().map((profile) => profile.family));
  for (const family of [
    "seedance-2.0",
    "seedance-2.5",
    "kling-o1",
    "kling-o3",
    "kling-v3-motion-control",
    "nano-banana-2.1",
    "flux-2",
    "genjutsu-object-swap",
    "genjutsu-motion-transfer",
    "genjutsu-restyle",
    "gemini-omni",
  ])
    assert.ok(families.has(family), family);
  for (const mode of ["object-swap", "motion-transfer", "restyle"]) {
    const profile = profileByFamily(`genjutsu-${mode}`)!;
    assert.equal(profile.provider, "higgsfield");
    assert.equal(profile.promptTemplate, "genjutsu-legacy");
    assert.equal(profile.dialect.kind, "at-indexed");
    assert.equal(profile.dialect.templates?.image, "@Image{n}");
    assert.equal(profile.dialect.templates?.video, "@Video{n}");
    assert.equal(profile.dialect.evidence.tier, "observed");
  }
  assert.equal(profileByFamily("seedance-2.5")!.policies.realFaces, "rejected");
});

test("profile limits use the guards' constants", () => {
  const seedance = profileByFamily("seedance-2.5")!;
  const slot = (id: string) => seedance.slots.find((item) => item.id === id)!;
  assert.equal(slot("images").max, SEEDANCE_25_REFERENCE_LIMITS.images);
  assert.equal(slot("videos").max, SEEDANCE_25_REFERENCE_LIMITS.videos);
  assert.equal(slot("audio").max, SEEDANCE_25_REFERENCE_LIMITS.audio);
  assert.equal(seedance.totals.max, SEEDANCE_25_REFERENCE_LIMITS.total);
  const refs = profileByFamily("kling-o3")!.slots.find(
    (item) => item.pointer === "/elements/{n}/reference_image_urls",
  )!;
  assert.deepEqual(
    [refs.min, refs.max],
    [KLING_ELEMENT_LIMITS.referenceImagesMin, KLING_ELEMENT_LIMITS.referenceImagesMax],
  );
  assert.equal(profileByFamily("nano-banana-2.1")!.slots[0]!.max, NANO_EDIT_LIMITS.images);
});

test("profileForEndpoint resolves by provider and exact endpoint", () => {
  assert.equal(profileForEndpoint("bytedance/seedance-2.5/reference-to-video")?.family, "seedance-2.5");
  assert.equal(profileForEndpoint("bytedance/seedance-2.0/mini/reference-to-video")?.family, "seedance-2.0");
  assert.equal(profileForEndpoint("fal-ai/kling-video/o3/4k/reference-to-video")?.family, "kling-o3");
  assert.equal(profileForEndpoint("fal-ai/kling-video/v3/pro/motion-control")?.family, "kling-v3-motion-control");
  assert.equal(profileForEndpoint("google/nano-banana-2.1/edit")?.family, "nano-banana-2.1");
  assert.equal(profileForEndpoint("higgsfield/genjutsu/restyle/v1.0", "higgsfield")?.family, "genjutsu-restyle");
  // The same id at another provider is a different schema: no profile.
  assert.equal(profileForEndpoint("bytedance/seedance-2.5/reference-to-video", "higgsfield"), undefined);
  assert.equal(profileForEndpoint("higgsfield/genjutsu/restyle/v1.0"), undefined);
  assert.equal(profileForEndpoint("bytedance/seedance-2.5/image-to-video"), undefined);
});

test("the shipped profiles agree with the catalogue, the schemas and the guards (AC2)", () => {
  const result = checkReferenceProfiles();
  assert.equal(result.ok, true, JSON.stringify(result.findings.filter((finding) => finding.severity === "error")));
  assert.equal(result.errors, 0);
});

function seeded(mutate: (file: ReferenceProfilesFile) => void) {
  const dir = mkdtempSync(path.join(tmpdir(), "ref-profiles-"));
  try {
    const file = raw();
    mutate(file);
    const target = path.join(dir, "reference-profiles.json");
    writeFileSync(target, JSON.stringify(file));
    return checkReferenceProfiles({ file: target });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const kinds = (result: ReturnType<typeof checkReferenceProfiles>): ProfileFindingKind[] =>
  result.findings.filter((finding) => finding.severity === "error").map((finding) => finding.kind);
const family = (file: ReferenceProfilesFile, name: string) => file.profiles.find((profile) => profile.family === name)!;

test("AC2: a profile endpoint missing from the catalogue fails", () => {
  const result = seeded((file) =>
    family(file, "seedance-2.5").endpoints.push("bytedance/seedance-9.9/reference-to-video"),
  );
  assert.equal(result.ok, false);
  assert.deepEqual(kinds(result), ["endpoint-missing"]);
});

test("AC2: a slot pointer absent from the endpoint schema fails", () => {
  const result = seeded((file) => {
    family(file, "kling-o3").slots.find((slot) => slot.id === "element-references")!.pointer =
      "/elements/{n}/side_image_urls";
  });
  assert.equal(result.ok, false);
  assert.deepEqual([...new Set(kinds(result))], ["pointer-missing"]);
  const genjutsu = seeded((file) => {
    family(file, "genjutsu-restyle").slots.find((slot) => slot.id === "images")!.pointer = "/reference_urls";
  });
  assert.deepEqual(kinds(genjutsu), ["pointer-missing"]);
});

test("AC2: a limit disagreeing with its guard fails", () => {
  const result = seeded((file) => {
    family(file, "seedance-2.5").slots.find((slot) => slot.id === "images")!.max = 31;
  });
  assert.equal(result.ok, false);
  assert.deepEqual([...new Set(kinds(result))], ["guard-disagreement"]);
  const kling = seeded((file) => {
    family(file, "kling-v3-motion-control").slots.find((slot) => slot.id === "face-references")!.max = 4;
  });
  assert.deepEqual([...new Set(kinds(kling))], ["guard-disagreement"]);
  const totals = seeded((file) => {
    family(file, "kling-o3-video").totals = { withVideoMaxImages: 5 };
  });
  assert.equal(new Set(kinds(totals)).size, 1);
  assert.equal(kinds(totals)[0], "guard-disagreement");
  const genjutsu = seeded((file) => {
    family(file, "genjutsu-object-swap").slots.find((slot) => slot.id === "source")!.durationSec = { min: 3, max: 30 };
  });
  assert.deepEqual(kinds(genjutsu), ["guard-disagreement"]);
});

test("marker numbering: groups that share a marker form fail; indexed slots in a marker-less dialect warn", () => {
  const collision = seeded((file) => {
    family(file, "seedance-2.5").slots.find((slot) => slot.id === "images")!.markerGroup = "identity";
    family(file, "seedance-2.5").dialect.templates!.video = "@Image{n}";
  });
  assert.deepEqual(kinds(collision), ["marker-collision"]);
  const grouped = seeded((file) => {
    family(file, "seedance-2.5").dialect.templates!.video = "@Image{n}";
    for (const slot of family(file, "seedance-2.5").slots) if (slot.modality !== "audio") slot.markerGroup = "visual";
  });
  assert.deepEqual(kinds(grouped), []);
  const unused = seeded((file) => {
    const profile = family(file, "flux-2");
    profile.dialect.kind = "parameter";
    profile.slots[0]!.marker = "indexed";
  });
  assert.deepEqual(kinds(unused), []);
  assert.ok(unused.findings.some((finding) => finding.kind === "marker-unused" && finding.severity === "warning"));
  // The shipped positional slots are marker-less, so they never collide.
  assert.equal(profileByFamily("kling-o3")!.slots.find((slot) => slot.id === "start")!.marker, "none");
});

test("a count above the schema's maxItems, a duplicate endpoint and an invalid file fail", () => {
  const over = seeded((file) => {
    family(file, "seedance-2.0").slots.find((slot) => slot.id === "images")!.max = 12;
  });
  assert.deepEqual([...new Set(kinds(over))], ["limit-exceeds-schema"]);
  const duplicate = seeded((file) =>
    family(file, "kling-o1").endpoints.push("fal-ai/kling-video/o3/pro/reference-to-video"),
  );
  assert.ok(kinds(duplicate).includes("endpoint-duplicate"));
  const invalid = seeded((file) => {
    (file.profiles[0] as unknown as Record<string, unknown>).family = "";
  });
  assert.deepEqual([...new Set(kinds(invalid))], ["schema-invalid"]);
});

function cli(args: string[], extraEnv: Record<string, string> = {}) {
  const child = spawnSync(
    process.execPath,
    [
      "--import",
      path.join(repo, "node_modules/tsx/dist/loader.mjs"),
      path.join(repo, "scripts/refs-profiles.ts"),
      ...args,
    ],
    {
      cwd: repo,
      encoding: "utf8",
      env: {
        AGENTBROS_NO_DOTENV: "1",
        PATH: process.env.PATH,
        AGENTBROS_MEMORY_ROOT: process.env.AGENTBROS_MEMORY_ROOT,
        ...extraEnv,
      },
    },
  );
  assert.equal(child.error, undefined);
  const lines = child.stdout.trim().split("\n");
  assert.equal(lines.length, 1, child.stdout);
  return { status: child.status, envelope: JSON.parse(lines[0]!) };
}

test("refs:profiles emits one JSON line per action", () => {
  const check = cli(["--action", "check"]);
  assert.equal(check.status, 0);
  assert.equal(check.envelope.ok, true);
  assert.equal(check.envelope.metadata.errors, 0);
  const list = cli(["--action", "list"]);
  assert.ok(list.envelope.metadata.profiles.some((row: { family: string }) => row.family === "kling-o3"));
  const forEndpoint = cli([
    "--action",
    "for",
    "--endpoint",
    "higgsfield/genjutsu/object-swap/v1.0",
    "--provider",
    "higgsfield",
  ]);
  assert.equal(forEndpoint.envelope.metadata.profile.family, "genjutsu-object-swap");
  const missing = cli(["--action", "show", "--family", "nope"]);
  assert.equal(missing.status, 1);
  assert.equal(missing.envelope.error, "INVALID_INPUT");
});

test("refs:profiles --action check fails in one JSON line with the findings (AC2)", () => {
  const empty = mkdtempSync(path.join(tmpdir(), "ref-profiles-catalog-"));
  try {
    const failed = cli(["--action", "check"], { AGENTBROS_FAL_CATALOG_DIR: empty });
    assert.equal(failed.status, 1);
    assert.equal(failed.envelope.ok, false);
    assert.equal(failed.envelope.error, "VALIDATION");
    const findings = failed.envelope.details.findings as { kind: string; provider?: string }[];
    assert.ok(findings.some((finding) => finding.kind === "endpoint-missing"));
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});
