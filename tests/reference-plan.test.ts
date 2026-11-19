import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { importAsset } from "../src/lib/assets/registry";
import { approveEntityVersion, saveEntityVersion } from "../src/lib/entities/service";
import {
  checkReferencesPlan,
  draftShotReferences,
  mergeShot,
  planStatus,
  readReferencesPlan,
  referencesReadyFailures,
  writeReferencesPlan,
  type PlanFindingCode,
} from "../src/lib/references/plan";
import { packDigest, packStatus } from "../src/lib/references/pack-status";
import { DONE_CHECKS, baseTokens, openFilmProject } from "../src/lib/film/state";
import { stepById } from "../src/lib/film/chain";
import {
  ReferencePackReceiptSchema,
  ReferencesPlanSchema,
  type ReferenceRequirement,
  type ShotReferences,
} from "../src/types/references";
import type { EntityCardInput } from "../src/types/entities";
import { hasFfmpeg } from "./helpers/reference-derive";

const REPO = process.cwd();
const TSX = path.join(REPO, "node_modules/tsx/dist/cli.mjs");
const media = { skip: hasFfmpeg ? false : "needs ffmpeg and ffprobe" } as const;
const ID = "refs";
const actor = { id: "director", kind: "human" as const, authorizationEvidence: "The user approved the cards in chat." };

function ffmpeg(...args: string[]) {
  const result = spawnSync("ffmpeg", ["-v", "error", "-nostdin", "-y", ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}

/** Project "refs": approved cards mara (4 views, voice sample), ivo (2 views), market (plate), lena (real face), draftie (unapproved). */
function fixture(t: TestContext) {
  const rootDir = mkdtempSync(path.join(tmpdir(), "reference-plan-"));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const project = path.join(rootDir, "public/projects", ID);
  mkdirSync(path.join(project, "pipeline"), { recursive: true });
  writeFileSync(path.join(project, "project.json"), "{}");
  const src = path.join(rootDir, "src-media");
  mkdirSync(src);
  const imported = (file: string) =>
    importAsset({ rootDir, projectId: ID, sourceFile: file, provenance: { origin: "manual" } }).asset;
  const image = (name: string, colour: string, size: string) => {
    const file = path.join(src, `${name}.png`);
    ffmpeg("-f", "lavfi", "-i", `color=c=${colour}:s=${size}`, "-frames:v", "1", file);
    return imported(file);
  };
  const video = (name: string, size: string, rate: number, seconds: number) => {
    const file = path.join(src, `${name}.mp4`);
    ffmpeg(
      "-f",
      "lavfi",
      "-i",
      `testsrc=s=${size}:r=${rate}:d=${seconds}`,
      "-pix_fmt",
      "yuv420p",
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      file,
    );
    return imported(file);
  };
  const audio = (name: string, seconds: number, frequency: number) => {
    const file = path.join(src, `${name}.wav`);
    ffmpeg("-f", "lavfi", "-i", `sine=f=${frequency}:d=${seconds}`, file);
    return imported(file);
  };
  const a = {
    maraFront: image("mara-front", "red", "512x512"),
    maraThree: image("mara-3q", "orange", "512x512"),
    maraProfile: image("mara-profile", "yellow", "512x512"),
    maraFace: image("mara-face", "pink", "512x512"),
    ivoFront: image("ivo-front", "blue", "512x512"),
    ivoThree: image("ivo-3q", "navy", "512x512"),
    lenaFront: image("lena-front", "green", "512x512"),
    lenaThree: image("lena-3q", "olive", "512x512"),
    plate: image("market", "gray", "1024x576"),
    firstFrame: image("first", "white", "1280x720"),
    tiny: image("tiny", "black", "200x200"),
    voice: audio("voice", 3, 440),
    music: audio("music", 4, 220),
    motion: video("motion", "480x360", 24, 5),
    long: video("long", "360x360", 10, 35),
  };
  const character = (id: string, name: string, refs: [string, string][], extra: Partial<EntityCardInput> = {}) =>
    ({
      id,
      kind: "character",
      name,
      description: `${name}, a character`,
      appearance: { physical: "short dark hair" },
      persona: { role: "lead" },
      createdBy: "agent",
      references: refs.map(([assetId, role]) => ({ assetId, role })),
      likenessConsent: { status: "not-applicable" },
      ...extra,
    }) as EntityCardInput;
  const cards: EntityCardInput[] = [
    character(
      "mara",
      "Mara",
      [
        [a.maraFront.id, "front"],
        [a.maraThree.id, "three-quarter-left"],
        [a.maraProfile.id, "profile-left"],
        [a.maraFace.id, "face-closeup"],
      ],
      {
        fixedSentence: "Mara wears a rust-red raincoat and a silver ear cuff.",
        voice: { description: "low, calm", consent: { status: "not-applicable" }, sampleAssetIds: [a.voice.id] },
      } as Partial<EntityCardInput>,
    ),
    character("ivo", "Ivo", [
      [a.ivoFront.id, "front"],
      [a.ivoThree.id, "three-quarter-right"],
    ]),
    character(
      "lena",
      "Lena",
      [
        [a.lenaFront.id, "front"],
        [a.lenaThree.id, "three-quarter-left"],
      ],
      { likenessConsent: { status: "documented", evidence: "signed release 2026-11-01", scope: "this film" } },
    ),
    {
      id: "market",
      kind: "location",
      name: "Night market",
      description: "a covered night market",
      geography: "city",
      layout: "two rows of stalls",
      lighting: "warm practicals",
      createdBy: "agent",
      references: [{ assetId: a.plate.id, role: "plate-wide" }],
    } as EntityCardInput,
  ];
  for (const card of cards) {
    saveEntityVersion(ID, card, { rootDir });
    approveEntityVersion(ID, card.kind, card.id, 1, actor, { rootDir, expectedRevision: 1 });
  }
  saveEntityVersion(ID, character("draftie", "Draftie", [[a.tiny.id, "front"]]), { rootDir });
  const write = (relative: string, value: unknown) => {
    const file = path.join(project, relative);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
  };
  return { rootDir, project, a, write };
}
type Fixture = ReturnType<typeof fixture>;

const errorsOf = (findings: { severity: string; code: string }[]) =>
  findings.filter((item) => item.severity === "error").map((item) => item.code);
const req = (shot: ShotReferences, key: string) => shot.requirements.find((item) => item.key === key)!;
const draft = (f: Fixture, args: Partial<Parameters<typeof draftShotReferences>[0]>) =>
  draftShotReferences({
    projectId: ID,
    shotId: "s1",
    materialItemId: "item-s1",
    intent: "reference-to-video",
    rootDir: f.rootDir,
    ...args,
  });
const entity = (entityId: string, kind: "character" | "location" = "character") => ({ kind, entityId });

// --- AC5: draft ---

test("AC5 keyframe-image: identity views and the location plate, ready from approved cards", media, (t) => {
  const f = fixture(t);
  const result = draft(f, {
    intent: "keyframe-image",
    family: "nano-banana-2.1",
    entities: [entity("mara"), entity("market", "location")],
  });
  ReferencesPlanSchema.parse(mergeShot(undefined, result.shot));
  assert.deepEqual(errorsOf(result.findings), []);
  const front = req(result.shot, "mara-front");
  assert.equal(front.status, "ready");
  assert.equal(front.required, true);
  assert.equal(front.role, "identity");
  assert.match(
    front.roleSentence,
    /Mara.*rust-red raincoat/,
    "the card's fixedSentence travels with the role sentence",
  );
  assert.deepEqual(front.source, {
    kind: "entity",
    entity: { entityId: "mara", kind: "character", revision: 1 },
    viewRole: "front",
  });
  assert.equal(req(result.shot, "market-plate-wide").role, "location");
  // Distinct angles only: one three-quarter, one profile, the close-up.
  const views = result.shot.requirements.filter((item) => item.key.startsWith("mara-")).map((item) => item.key);
  assert.deepEqual(views.sort(), ["mara-face-closeup", "mara-front", "mara-profile-left", "mara-three-quarter-left"]);
  assert.ok(result.shot.requirements.every((item) => item.status === "ready"));
});

test(
  "AC5 image-to-video on kling-o3: first frame in the start slot, optional last frame, identity element",
  media,
  (t) => {
    const f = fixture(t);
    const result = draft(f, {
      intent: "image-to-video",
      family: "kling-o3",
      entities: [entity("mara")],
      assets: [{ role: "first-frame", assetId: f.a.firstFrame.id }],
    });
    assert.deepEqual(errorsOf(result.findings), []);
    const first = req(result.shot, "first-frame");
    assert.equal(first.role, "first-frame");
    assert.equal(first.status, "ready");
    const last = req(result.shot, "last-frame");
    assert.equal(last.required, false);
    assert.equal(last.status, "missing");
    assert.equal(req(result.shot, "mara-front").status, "ready");

    // A frame below the slot's 300 px short edge is planned with a scale derivative, never ready.
    const small = draft(f, {
      intent: "image-to-video",
      family: "kling-o3",
      assets: [{ role: "first-frame", assetId: f.a.tiny.id }],
    });
    const planned = req(small.shot, "first-frame");
    assert.equal(planned.status, "planned");
    assert.deepEqual(planned.prepare, [{ op: "scale", width: 300, height: 300, fit: "exact" }]);
    assert.match(planned.notes ?? "", /refs:derive/);
  },
);

test("AC5 Seedance 2.5 reference-to-video: two characters, one location, one audio", media, (t) => {
  const f = fixture(t);
  const result = draft(f, {
    intent: "reference-to-video",
    endpoint: "bytedance/seedance-2.5/reference-to-video",
    entities: [entity("mara"), entity("ivo"), entity("market", "location")],
  });
  assert.equal(result.profile, "seedance-2.5");
  assert.deepEqual(errorsOf(result.findings), []);
  const keys = result.shot.requirements.map((item) => item.key);
  for (const key of ["mara-front", "ivo-front", "market-plate-wide", "mara-voice"]) assert.ok(keys.includes(key), key);
  const audio = result.shot.requirements.filter((item) => item.modality === "audio");
  assert.equal(audio.length, 1);
  assert.equal(audio[0]!.role, "voice");
  assert.deepEqual(audio[0]!.source, { kind: "asset", assetId: f.a.voice.id });
  assert.equal(audio[0]!.status, "ready");
  // Round-robin: Ivo's second angle is not crowded out by Mara's extra views.
  assert.ok(keys.includes("ivo-three-quarter-right"));
  assert.equal(result.shot.target.endpoint, "bytedance/seedance-2.5/reference-to-video");
});

test(
  "AC5 Kling motion-control: motion video, character image, face element; an over-long clip plans a trim",
  media,
  (t) => {
    const f = fixture(t);
    const result = draft(f, {
      intent: "motion-transfer",
      family: "kling-v3-motion-control",
      entities: [entity("mara")],
      assets: [{ role: "motion", assetId: f.a.motion.id }],
    });
    assert.deepEqual(errorsOf(result.findings), []);
    const motion = req(result.shot, "motion");
    assert.equal(motion.role, "motion", "the motion slot takes motion|performance, not source-video");
    assert.equal(motion.status, "ready");
    assert.equal(req(result.shot, "mara-front").status, "ready");
    assert.equal(result.shot.requirements.filter((item) => item.role === "identity").length, 4);

    const long = draft(f, {
      intent: "motion-transfer",
      family: "kling-v3-motion-control",
      entities: [entity("mara")],
      assets: [{ role: "motion", assetId: f.a.long.id }],
    });
    const trimmed = req(long.shot, "motion");
    assert.equal(trimmed.status, "planned");
    assert.deepEqual(trimmed.prepare, [{ op: "trim", startSec: 0, durationSec: 30 }]);
  },
);

test(
  "AC5 control-to-video: no profile takes pose or depth, so a pose-plus-image Kling shot carries the control as motion",
  media,
  (t) => {
    const f = fixture(t);
    const result = draft(f, {
      intent: "control-to-video",
      family: "kling-v3-motion-control",
      entities: [entity("mara")],
      assets: [{ role: "motion", assetId: f.a.motion.id }],
    });
    const control = req(result.shot, "control");
    assert.equal(control.role, "motion");
    assert.deepEqual(control.prepare, [{ op: "pose-video", engine: "local" }]);
    assert.equal(control.status, "planned");
    assert.ok(result.notes.some((note) => /pose-video derivative/.test(note)));
    assert.equal(req(result.shot, "mara-front").status, "ready");
    assert.deepEqual(errorsOf(result.findings), []);
  },
);

test("draft drops optional views first and never exceeds a slot", media, (t) => {
  const f = fixture(t);
  // flux-2 takes at most 4 images: three fronts plus the plate are required, so every extra angle is dropped.
  const result = draft(f, {
    intent: "keyframe-image",
    family: "flux-2",
    entities: [entity("mara"), entity("ivo"), entity("lena"), entity("market", "location")],
  });
  assert.equal(result.shot.requirements.length, 4);
  assert.ok(result.shot.requirements.every((item) => item.required));
  assert.ok(result.dropped.some((item) => item.key === "mara-three-quarter-left"));
  assert.deepEqual(errorsOf(result.findings), []);
  // An unapproved card waits for approval; an unknown card is missing with the create command.
  const pending = draft(f, {
    intent: "keyframe-image",
    family: "nano-banana-2.1",
    entities: [entity("draftie"), entity("ghost")],
  });
  assert.equal(req(pending.shot, "draftie-front").status, "pending-approval");
  assert.match(
    req(pending.shot, "draftie-front").notes ?? "",
    /entity:card .*--action approve --kind character --id draftie --revision 1/,
  );
  assert.equal(req(pending.shot, "ghost-identity").status, "missing");
  assert.match(req(pending.shot, "ghost-identity").notes ?? "", /entity:card .*--action create/);
});

// --- AC6: check ---

/** Raw requirement JSON: check takes unvalidated input. */
const requirement = (
  over: Record<string, unknown> & Pick<ReferenceRequirement, "key" | "role" | "modality">,
): Record<string, unknown> => ({
  required: true,
  prepare: [],
  roleSentence: "what the model takes",
  status: "missing",
  ...over,
});
const shotOf = (over: Record<string, unknown> & { requirements: unknown[] }): Record<string, unknown> => ({
  shotId: "s1",
  materialItemId: "item-s1",
  intent: "reference-to-video",
  target: { family: "seedance-2.5" },
  chaining: "none",
  ...over,
});
const codes = (f: Fixture, shots: unknown[]) =>
  errorsOf(checkReferencesPlan(ID, { schemaVersion: 1, shots }, f.rootDir).findings);
const entitySource = (entityId: string, viewRole: string) => ({
  kind: "entity",
  entity: { entityId, kind: "character", revision: 1 },
  viewRole,
});

test("AC6 check rejects each invariant with its own finding code", media, (t) => {
  const f = fixture(t);
  const has = (list: string[], code: PlanFindingCode) =>
    assert.ok(list.includes(code), `${code} in ${list.join(", ")}`);
  const videos = (n: number) =>
    Array.from({ length: n }, (_, i) => requirement({ key: `v${i}`, role: "motion", modality: "video" }));

  // Over-limit per modality: seedance-2.0 takes three videos.
  const modality = checkReferencesPlan(
    ID,
    { schemaVersion: 1, shots: [shotOf({ target: { family: "seedance-2.0" }, requirements: videos(4) })] },
    f.rootDir,
  );
  assert.ok(modality.findings.some((item) => item.code === "over-limit" && item.modality === "video"));
  // Over-limit in total: kling-o3-video allows four images with a video, elements counting once.
  const total = checkReferencesPlan(
    ID,
    {
      schemaVersion: 1,
      shots: [
        shotOf({
          intent: "video-edit",
          target: { family: "kling-o3-video" },
          requirements: [
            requirement({ key: "src", role: "source-video", modality: "video" }),
            ...["a", "b", "c", "d"].map((key) => requirement({ key, role: "location", modality: "image" })),
            requirement({
              key: "mara-front",
              role: "identity",
              modality: "image",
              source: entitySource("mara", "front"),
              status: "ready",
            }),
            requirement({
              key: "mara-3q",
              role: "identity",
              modality: "image",
              source: entitySource("mara", "three-quarter-left"),
              status: "ready",
            }),
          ],
        }),
      ],
    },
    f.rootDir,
  );
  assert.ok(
    total.findings.some((item) => item.code === "over-limit" && item.modality === "total"),
    JSON.stringify(total.findings),
  );

  // Role not accepted: nano-banana-2.1 has no first-frame slot.
  has(
    codes(f, [
      shotOf({
        target: { family: "nano-banana-2.1" },
        requirements: [requirement({ key: "first", role: "first-frame", modality: "image" })],
      }),
    ]),
    "role-not-accepted-by-slot",
  );
  // Ready without a source.
  has(
    codes(f, [
      shotOf({ requirements: [requirement({ key: "x", role: "identity", modality: "image", status: "ready" })] }),
    ]),
    "ready-without-source",
  );
  // Unresolvable source.
  has(
    codes(f, [
      shotOf({
        requirements: [
          requirement({
            key: "x",
            role: "identity",
            modality: "image",
            source: { kind: "asset", assetId: `sha256:${"0".repeat(64)}` },
          }),
        ],
      }),
    ]),
    "unresolvable-source",
  );
  // Media outside limits, with the fixing step: a 35 s clip marked ready for Kling motion-control.
  const outside = checkReferencesPlan(
    ID,
    {
      schemaVersion: 1,
      shots: [
        shotOf({
          intent: "motion-transfer",
          target: { family: "kling-v3-motion-control" },
          requirements: [
            requirement({
              key: "motion",
              role: "motion",
              modality: "video",
              source: { kind: "asset", assetId: f.a.long.id },
              status: "ready",
            }),
            requirement({
              key: "mara-front",
              role: "identity",
              modality: "image",
              source: entitySource("mara", "front"),
              status: "ready",
            }),
          ],
        }),
      ],
    },
    f.rootDir,
  ).findings.find((item) => item.code === "media-outside-limits");
  assert.equal(outside?.severity, "error");
  assert.deepEqual(outside?.fix, { op: "trim", startSec: 0, durationSec: 30 });
  // The same clip with the trim in prepare passes.
  assert.deepEqual(
    codes(f, [
      shotOf({
        intent: "motion-transfer",
        target: { family: "kling-v3-motion-control" },
        requirements: [
          requirement({
            key: "motion",
            role: "motion",
            modality: "video",
            source: { kind: "asset", assetId: f.a.long.id },
            prepare: [{ op: "trim", startSec: 0, durationSec: 30 }],
            status: "planned",
          }),
          requirement({
            key: "mara-front",
            role: "identity",
            modality: "image",
            source: entitySource("mara", "front"),
            status: "ready",
          }),
        ],
      }),
    ]),
    [],
  );
  // A missing mandatory slot: motion-control without its motion video.
  has(
    codes(f, [
      shotOf({
        target: { family: "kling-v3-motion-control" },
        requirements: [
          requirement({
            key: "mara-front",
            role: "identity",
            modality: "image",
            source: entitySource("mara", "front"),
            status: "ready",
          }),
        ],
      }),
    ]),
    "slot-min-unmet",
  );

  // Chaining: last-frame chaining with no anchored identity, then with the card re-attached.
  const chained = (identity: unknown[]) => [
    shotOf({
      shotId: "s0",
      requirements: [
        requirement({
          key: "mara-front",
          role: "identity",
          modality: "image",
          source: entitySource("mara", "front"),
          status: "ready",
        }),
      ],
    }),
    shotOf({
      shotId: "s2",
      intent: "image-to-video",
      target: { family: "kling-o3" },
      chaining: "first-from-previous-last",
      requirements: [
        requirement({
          key: "first",
          role: "first-frame",
          modality: "image",
          source: { kind: "shot-output", shotId: "s0", frame: "last" },
          status: "planned",
        }),
        ...identity,
      ],
    }),
  ];
  has(codes(f, chained([])), "chaining-without-anchor");
  has(
    codes(
      f,
      chained([
        requirement({
          key: "face",
          role: "identity",
          modality: "image",
          source: { kind: "shot-output", shotId: "s0", frame: "last" },
          status: "planned",
        }),
      ]),
    ),
    "chaining-without-anchor",
  );
  assert.ok(
    !codes(
      f,
      chained([
        requirement({
          key: "mara-front",
          role: "identity",
          modality: "image",
          source: entitySource("mara", "front"),
          status: "ready",
        }),
      ]),
    ).includes("chaining-without-anchor"),
  );

  // A consented real face aimed at a profile that rejects real faces (D11).
  has(
    codes(f, [
      shotOf({
        requirements: [
          requirement({
            key: "lena-front",
            role: "identity",
            modality: "image",
            source: entitySource("lena", "front"),
            status: "ready",
          }),
        ],
      }),
    ]),
    "real-face-policy",
  );
  assert.ok(
    !codes(f, [
      shotOf({
        target: { family: "kling-o3" },
        requirements: [
          requirement({
            key: "lena-front",
            role: "identity",
            modality: "image",
            source: entitySource("lena", "front"),
            status: "ready",
          }),
        ],
      }),
    ]).includes("real-face-policy"),
  );
  // Unknown target and duplicate shot ids.
  has(
    codes(f, [
      shotOf({
        target: { family: "no-such-model" },
        requirements: [requirement({ key: "x", role: "identity", modality: "image" })],
      }),
    ]),
    "unknown-target",
  );
  has(
    codes(f, [
      shotOf({
        target: { endpoint: "no/such/endpoint", family: "x" },
        requirements: [requirement({ key: "x", role: "identity", modality: "image" })],
      }),
    ]),
    "unknown-target",
  );
  const dup = shotOf({ requirements: [requirement({ key: "x", role: "identity", modality: "image" })] });
  has(codes(f, [dup, dup]), "duplicate-shot-id");
});

// --- Status, board, CLI ---

test("planStatus names the command that resolves each open requirement and the pack", media, (t) => {
  const f = fixture(t);
  const shot = draft(f, {
    intent: "image-to-video",
    family: "kling-o3",
    entities: [entity("draftie"), entity("market", "location")],
    assets: [{ role: "first-frame", assetId: f.a.tiny.id }],
  }).shot;
  writeReferencesPlan(ID, mergeShot(undefined, shot), f.rootDir);
  f.write("pipeline/material.json", {
    schemaVersion: 1,
    filmType: "ai-video",
    items: [
      {
        id: "item-s1",
        shots: ["s1"],
        what: "shot one",
        kind: "generated-video",
        route: "generated",
        status: "pending",
        provenance: "kling",
        licence: "generated",
      },
      {
        id: "item-s2",
        shots: ["s2"],
        what: "shot two",
        kind: "generated-image",
        route: "generated",
        status: "pending",
        provenance: "nano",
        licence: "generated",
      },
    ],
  });
  const status = planStatus(ID, f.rootDir);
  const s1 = status.shots[0]!;
  assert.equal(s1.ready, false);
  assert.equal(s1.counts["pending-approval"], 1);
  assert.equal(s1.counts.ready, 1);
  const byKey = new Map(s1.open.map((item) => [item.key, item]));
  assert.match(
    byKey.get("draftie-front")!.command,
    /entity:card --project refs --action approve --kind character --id draftie --revision 1/,
  );
  assert.match(byKey.get("first-frame")!.command, /refs:derive --project refs --action plan/);
  assert.match(byKey.get("last-frame")!.command, /asset:import --project refs/);
  assert.equal(s1.pack, null);
  assert.deepEqual(
    status.unplanned.map((item) => item.itemId),
    ["item-s2"],
  );
  assert.match(
    status.unplanned[0]!.command,
    /refs:plan --project refs --action draft --shot s2 --material-item item-s2/,
  );
});

function cli(rootDir: string, ...args: string[]) {
  const result = spawnSync(process.execPath, [TSX, path.join(REPO, "scripts/refs-plan.ts"), ...args], {
    cwd: rootDir,
    encoding: "utf8",
    // spawnSync blocks the test's own timeout, so a hung CLI must end here, with its output in the failure.
    timeout: 120000,
    killSignal: "SIGKILL",
  });
  assert.equal(result.error, undefined, `refs:plan ${args.join(" ")}: ${result.error}\n${result.stderr}`);
  const lines = result.stdout.trim().split("\n");
  return { status: result.status, json: JSON.parse(lines.at(-1)!) as Record<string, any>, stderr: result.stderr };
}

test("CLI: draft writes references.json, check passes, status and an escaped static board", media, (t) => {
  const f = fixture(t);
  const dry = cli(
    f.rootDir,
    "--project",
    ID,
    "--action",
    "draft",
    "--shot",
    "s1",
    "--material-item",
    "item-s1",
    "--intent",
    "keyframe-image",
    "--family",
    "nano-banana-2.1",
    "--entity",
    "character:mara,location:market",
  );
  assert.equal(dry.status, 0, dry.stderr);
  assert.equal(dry.json.metadata.written, false);
  assert.equal(readReferencesPlan(ID, f.rootDir), undefined, "a dry draft writes nothing");
  const written = cli(
    f.rootDir,
    "--project",
    ID,
    "--action",
    "draft",
    "--shot",
    "s1",
    "--material-item",
    "item-s1",
    "--intent",
    "reference-to-video",
    "--endpoint",
    "bytedance/seedance-2.5/reference-to-video",
    "--entity",
    "character:mara@1",
    "--entity",
    "character:ivo",
    "--asset",
    `music:${f.a.music.id}`,
    "--write",
  );
  assert.equal(written.status, 0, written.stderr);
  const plan = readReferencesPlan(ID, f.rootDir)!;
  assert.equal(plan.shots.length, 1);
  assert.ok(plan.shots[0]!.requirements.some((item) => item.role === "music" && item.required === false));
  const check = cli(f.rootDir, "--project", ID, "--action", "check");
  assert.equal(check.status, 0, JSON.stringify(check.json));
  assert.equal(check.json.metadata.ok, true);
  const status = cli(f.rootDir, "--project", ID, "--action", "status");
  assert.equal(status.status, 0);
  assert.equal(status.json.metadata.shots[0].shotId, "s1");
  // A hostile role sentence is escaped on the board; the board has no scripts.
  const stored = JSON.parse(readFileSync(path.join(f.project, "pipeline/references.json"), "utf8"));
  stored.shots[0].requirements[0].roleSentence = `<script>alert(1)</script>`;
  writeFileSync(path.join(f.project, "pipeline/references.json"), JSON.stringify(stored));
  const preview = cli(f.rootDir, "--project", ID, "--action", "board");
  assert.equal(preview.status, 0, preview.stderr);
  assert.equal(preview.json.metadata.written, false);
  assert.ok(!existsSync(path.join(f.project, "pipeline/references-board.html")), "board writes only with --save");
  assert.match(preview.json.metadata.html, /&lt;script&gt;/);
  const board = cli(f.rootDir, "--project", ID, "--action", "board", "--save");
  assert.equal(board.status, 0, board.stderr);
  const html = readFileSync(board.json.outputs[0], "utf8");
  assert.doesNotMatch(html, /<script/i);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /<img src="\.\.\/assets\/imported\/[a-f0-9]{64}\.png"/);
  // A broken plan fails check with VALIDATION and the findings.
  stored.shots[0].requirements[0] = { ...stored.shots[0].requirements[0], status: "ready", source: undefined };
  writeFileSync(path.join(f.project, "pipeline/references.json"), JSON.stringify(stored));
  const failing = cli(f.rootDir, "--project", ID, "--action", "check");
  assert.equal(failing.status, 1);
  assert.equal(failing.json.error, "VALIDATION");
  assert.match(failing.json.message, /ready-without-source/);
  const bad = cli(
    f.rootDir,
    "--project",
    ID,
    "--action",
    "draft",
    "--shot",
    "s1",
    "--material-item",
    "m",
    "--intent",
    "voice",
    "--family",
    "flux-2",
    "--entity",
    "nonsense",
  );
  assert.equal(bad.json.error, "INVALID_INPUT");
});

// --- Chain: references-ready (AC16) ---

function writePack(f: Fixture, packId: string, shotId: string, approve: boolean) {
  const receipt = ReferencePackReceiptSchema.parse({
    schemaVersion: 1,
    projectId: ID,
    id: packId,
    createdAt: "2026-11-17T10:00:00.000Z",
    spec: {
      schemaVersion: 1,
      id: packId,
      shotId,
      endpoint: "google/nano-banana-2.1/edit",
      profileFamily: "nano-banana-2.1",
      attachments: [
        {
          requirementKey: "mara-front",
          source: { assetId: f.a.maraFront.id },
          slot: "images",
          order: 1,
          roleSentence: "Mara",
        },
      ],
      prompt: { action: "Mara looks up." },
      audioPolicy: "mute",
    },
    profileSha256: "a".repeat(64),
    endpoint: "google/nano-banana-2.1/edit",
    schemaSha256: "b".repeat(64),
    requestSha256: "c".repeat(64),
    attachments: [],
    compiledPrompt: "Mara looks up.",
    markerMap: {},
    warnings: [],
    reviewFiles: [{ path: "board.html", sha256: "d".repeat(64) }],
  });
  f.write(`pipeline/reference-packs/${packId}/receipt.json`, receipt);
  const sha256 = packDigest(receipt);
  if (approve)
    f.write(`pipeline/reference-packs/${packId}/approval.json`, {
      schemaVersion: 1,
      packSha256: sha256,
      rightsSha256: "e".repeat(64),
      userStatement: "Yes, use these.",
      approvedAt: "2026-11-17T10:05:00.000Z",
      review: {
        packSha256: sha256,
        reviewer: "user",
        evidence: "board seen",
        markersVerified: true,
        promptReviewed: true,
        attachments: [
          { sha256: f.a.maraFront.hash, requirementKey: "mara-front", suitable: true, evidence: "front view" },
        ],
      },
    });
  return sha256;
}

test(
  "chain references-ready, both phases: none with a reason passes; before approval missing inputs and check errors fail; after it inputs must be ready and the pack approved",
  media,
  (t) => {
    const f = fixture(t);
    assert.ok(stepById("material")!.done.checks.includes("references-ready"));
    assert.ok(
      stepById("material")!.outputs.some(
        (output) => output.path.endsWith("references.json") && output.optional && output.schema === "references",
      ),
    );
    const project = openFilmProject(f.project, { rootDir: f.rootDir });
    const check = () => DONE_CHECKS["references-ready"]({ project, tokens: baseTokens(project), silence: false });
    const item = {
      id: "item-s1",
      shots: ["s1"],
      what: "Mara looks up",
      kind: "generated-image",
      route: "generated",
      status: "pending",
      provenance: "nano",
      licence: "generated",
      maxCostUsd: 0.2,
    };
    const material = (items: unknown[]) =>
      f.write("pipeline/material.json", { schemaVersion: 1, filmType: "ai-video", items });

    material([{ ...item, kind: "image", route: "stock" }]);
    assert.deepEqual(check(), [], "no generated item: trivially ready");
    material([{ ...item, referencePlan: { mode: "none", reason: "An abstract texture: nothing to hold." } }]);
    assert.deepEqual(check(), []);

    material([item]);
    assert.match(
      check().join(" "),
      /item-s1 is generated and has no shot in pipeline\/references\.json: pnpm refs:plan --project refs --action draft --shot s1 --material-item item-s1/,
    );

    // Before the material approval: planned requirements suffice; missing inputs and check errors do not.
    const after = (items: unknown[]) =>
      referencesReadyFailures(ID, items as Parameters<typeof referencesReadyFailures>[1], f.rootDir, {
        approved: true,
      });
    const pending = draft(f, {
      intent: "keyframe-image",
      family: "nano-banana-2.1",
      entities: [entity("draftie")],
    }).shot;
    writeReferencesPlan(ID, mergeShot(undefined, pending), f.rootDir);
    assert.deepEqual(check(), [], "before approval a card awaiting approval and the pack may wait");
    const failures = after([item]);
    assert.match(
      failures.join(" "),
      /shot s1 requirement draftie-front is pending-approval .*entity:card --project refs --action approve --kind character --id draftie/,
    );
    assert.match(failures.join(" "), /has no reference pack: pnpm refs:pack --project refs --action prepare/);
    const ghost = draft(f, { intent: "keyframe-image", family: "nano-banana-2.1", entities: [entity("ghost")] }).shot;
    writeReferencesPlan(ID, mergeShot(undefined, ghost), f.rootDir);
    assert.match(
      check().join(" "),
      /requirement ghost-identity is missing .*entity:card --project refs --action create/,
    );
    writeReferencesPlan(
      ID,
      mergeShot(undefined, {
        ...ghost,
        requirements: [
          {
            ...ghost.requirements[0]!,
            source: { kind: "asset", assetId: `sha256:${"0".repeat(64)}` },
            status: "planned",
          },
        ],
      }),
      f.rootDir,
    );
    assert.match(check().join(" "), /shot s1 \[unresolvable-source\] .*asset:import --project refs/);

    // After it: ready inputs and an approved, current pack.
    const ready = draft(f, { intent: "keyframe-image", family: "nano-banana-2.1", entities: [entity("mara")] }).shot;
    writeReferencesPlan(ID, mergeShot(undefined, ready), f.rootDir);
    const prepared = writePack(f, "pack-s1", "s1", false);
    assert.equal(packStatus(ID, "pack-s1", f.rootDir), "prepared");
    const bound = { ...item, referencePack: { id: "pack-s1", sha256: prepared } };
    material([bound]);
    assert.deepEqual(check(), []);
    assert.match(
      after([bound]).join(" "),
      /pack pack-s1 is prepared: pnpm refs:pack --project refs --action approve --id pack-s1/,
    );
    writePack(f, "pack-s1", "s1", true);
    assert.equal(packStatus(ID, "pack-s1", f.rootDir), "approved");
    assert.deepEqual(after([bound]), []);
    // A stale binding does not pass.
    assert.match(
      after([{ ...item, referencePack: { id: "pack-s1", sha256: "f".repeat(64) } }]).join(" "),
      /not the bound one: rebind/,
    );
    assert.equal(packStatus(ID, "no-such-pack", f.rootDir), "missing");
  },
);

test(
  "chain references-ready with a chained shot: the shot-output frame may wait until approval, then until that shot is made",
  media,
  (t) => {
    const f = fixture(t);
    const project = openFilmProject(f.project, { rootDir: f.rootDir });
    const check = () => DONE_CHECKS["references-ready"]({ project, tokens: baseTokens(project), silence: false });
    const s0 = draft(f, {
      shotId: "s0",
      materialItemId: "item-s0",
      intent: "keyframe-image",
      family: "nano-banana-2.1",
      entities: [entity("mara")],
    }).shot;
    writeReferencesPlan(ID, mergeShot(undefined, s0), f.rootDir);
    const s1 = draft(f, {
      shotId: "s1",
      materialItemId: "item-s1",
      intent: "image-to-video",
      family: "kling-o3",
      entities: [entity("mara")],
      chainFrom: "s0",
    });
    assert.equal(s1.shot.chaining, "anchor-reinject");
    assert.equal(req(s1.shot, "first-frame").status, "planned");
    assert.deepEqual(s1.shot.requirements.find((r) => r.key === "first-frame")!.source, {
      kind: "shot-output",
      shotId: "s0",
      frame: "last",
    });
    assert.deepEqual(errorsOf(s1.findings), []);
    writeReferencesPlan(ID, mergeShot(readReferencesPlan(ID, f.rootDir), s1.shot), f.rootDir);
    const base = { what: "shot", route: "generated", provenance: "model", licence: "generated", maxCostUsd: 0.5 };
    const items = (s0Status: string) => [
      {
        ...base,
        id: "item-s0",
        shots: ["s0"],
        kind: "generated-image",
        status: s0Status,
        referencePack: { id: "pack-s0", sha256: writePack(f, "pack-s0", "s0", true) },
      },
      {
        ...base,
        id: "item-s1",
        shots: ["s1"],
        kind: "generated-video",
        status: "pending",
        referencePack: { id: "pack-s1", sha256: writePack(f, "pack-s1", "s1", true) },
      },
    ];
    f.write("pipeline/material.json", { schemaVersion: 1, filmType: "ai-video", items: items("pending") });
    assert.deepEqual(check(), [], "before approval the chained first frame stays planned");
    const after = (list: unknown[]) =>
      referencesReadyFailures(ID, list as Parameters<typeof referencesReadyFailures>[1], f.rootDir, { approved: true });
    assert.match(
      after(items("pending")).join(" "),
      /item-s1: shot s1 requirement first-frame is planned .*generate shot s0/,
    );
    assert.deepEqual(after(items("acquired")), [], "once shot s0 is made its last frame can be extracted");
  },
);
