import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { importAsset } from "../src/lib/assets/registry";
import { DONE_CHECKS, baseTokens, openFilmProject } from "../src/lib/film/state";
import { profileByFamily } from "../src/lib/references/profiles";
import { assignSlots, readReferencesPlan, writeReferencesPlan } from "../src/lib/references/plan";
import { ReferencePackSpecSchema, type ReferenceSource, type ShotReferences } from "../src/types/references";
import { getEntityVersion } from "../src/lib/entities/service";
import { showDerivative } from "../src/lib/references/derive";
import { hasFfmpeg } from "./helpers/reference-derive";

/**
 * RFC 0003 AC19 (WP11): one end-to-end dry run through the agent-facing CLIs on a synthetic project.
 * Cards → coverage → refs:plan draft → refs:derive (trim, audio-trim) → re-draft → check → refs:pack prepare, board,
 * rights, approve, request → generate:model --dry-run, with no hand-written marker anywhere outside the compiled pack.
 * Approvals are fixture data. Offline: no provider call (fal-no-network), no spend.
 */

const REPO = process.cwd();
const TSX_LOADER = path.join(REPO, "node_modules/tsx/dist/loader.mjs");
const media = { skip: hasFfmpeg ? false : "needs ffmpeg and ffprobe" } as const;
const ID = "e2e";
const SEEDANCE = "bytedance/seedance-2.5/reference-to-video";
const KLING_MC = "fal-ai/kling-video/v3/standard/motion-control";
const HAND_MARKER = /@(Image|Video|Audio|Element)\d/;

function ffmpeg(...args: string[]) {
  const result = spawnSync("ffmpeg", ["-v", "error", "-nostdin", "-y", ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}

type Envelope = {
  ok: boolean;
  outputs?: string[];
  metadata?: Record<string, any>;
  error?: string;
  message?: string;
};
/** One CLI run from the project root: exactly one JSON line on stdout (the CLI contract). */
function cli(rootDir: string, script: string, args: string[], env: Record<string, string> = {}) {
  const run = spawnSync(
    process.execPath,
    [
      "--import",
      TSX_LOADER,
      "--import",
      path.join(REPO, "tests/helpers/fal-no-network.ts"),
      path.join(REPO, "scripts", script),
      ...args,
    ],
    {
      cwd: rootDir,
      encoding: "utf8",
      timeout: 120_000,
      maxBuffer: 256 * 1024 * 1024,
      env: {
        AGENTBROS_NO_DOTENV: "1",
        PATH: process.env.PATH,
        ...(process.env.AGENTBROS_MEMORY_ROOT ? { AGENTBROS_MEMORY_ROOT: process.env.AGENTBROS_MEMORY_ROOT } : {}),
        ...env,
      },
    },
  );
  const lines = run.stdout.trim().split("\n");
  assert.equal(lines.length, 1, `${script} ${args.join(" ")}\n${run.stdout}\n${run.stderr}`);
  const envelope = JSON.parse(lines[0]!) as Envelope;
  return { status: run.status, envelope, stderr: run.stderr };
}
function ok(rootDir: string, script: string, args: string[]) {
  const run = cli(rootDir, script, args);
  assert.equal(run.envelope.ok, true, `${script} ${args.join(" ")}: ${JSON.stringify(run.envelope)}\n${run.stderr}`);
  assert.equal(run.status, 0);
  return run.envelope;
}

/** Every file under `dir`, relative to it. */
function filesUnder(dir: string, prefix = ""): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    const relative = prefix ? `${prefix}/${name}` : name;
    return statSync(full).isDirectory() ? filesUnder(full, relative) : [relative];
  });
}
/** Files of pipeline/ that only refs:pack writes and that legitimately carry compiled markers. */
const COMPILED = /^reference-packs\/[^/]+\/(receipt\.json|request\.json|board\.html|results\/.*)$/;

const sha256 = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");

/** A pack spec from a shot of references.json: its ready requirements in the slots refs:plan assigns, no marker. */
function packSpecFor(
  rootDir: string,
  projectId: string,
  packId: string,
  shot: ShotReferences,
  endpoint: string,
  prompt: object,
  audioPolicy: string,
  params: Record<string, unknown> = {},
) {
  const profile = profileByFamily(shot.target.family)!;
  const taken = shot.requirements.filter((item) => item.status === "ready");
  const { slots, findings } = assignSlots(
    profile,
    taken.map((item) => ({
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
  );
  const assetOf = (source: ReferenceSource): string => {
    if (source.kind === "asset") return source.assetId;
    if (source.kind === "derivative")
      return showDerivative(projectId, source.derivativeId, rootDir).receipt.output.assetId;
    if (source.kind === "entity")
      return getEntityVersion(projectId, source.entity.kind, source.entity.entityId, {
        revision: source.entity.revision,
        rootDir,
      }).version.card.references.find((ref) => ref.role === source.viewRole)!.assetId;
    throw new Error(`unexpected source ${source.kind}`);
  };
  const order = new Map<string, number>();
  return ReferencePackSpecSchema.parse({
    schemaVersion: 1,
    id: packId,
    shotId: shot.shotId,
    endpoint,
    profileFamily: profile.family,
    attachments: taken
      .filter((item) => slots.has(item.key))
      .map((item) => {
        const slot = slots.get(item.key)!;
        order.set(slot, (order.get(slot) ?? 0) + 1);
        return {
          requirementKey: item.key,
          source: { assetId: assetOf(item.source!) },
          slot,
          order: order.get(slot)!,
          roleSentence: item.roleSentence,
        };
      }),
    prompt,
    params,
    audioPolicy,
  });
}

test(
  "AC19 end to end: cards, plan, derivatives, packs and a generate:model dry run, with no hand markers",
  media,
  () => {
    const rootDir = mkdtempSync(path.join(tmpdir(), "reference-e2e-"));
    try {
      const project = path.join(rootDir, "public/projects", ID);
      const pipeline = path.join(project, "pipeline");
      mkdirSync(pipeline, { recursive: true });
      writeFileSync(path.join(project, "project.json"), "{}");
      const write = (relative: string, value: unknown) => {
        const file = path.join(rootDir, relative);
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
        return file;
      };

      // --- Synthetic media (ffmpeg lavfi), imported as the user's own originals.
      const src = path.join(rootDir, "src-media");
      mkdirSync(src);
      const imported = (file: string) =>
        importAsset({ rootDir, projectId: ID, sourceFile: file, provenance: { origin: "manual" } }).asset;
      const image = (name: string, colour: string, size: string) => {
        const file = path.join(src, `${name}.png`);
        ffmpeg("-f", "lavfi", "-i", `color=c=${colour}:s=${size}`, "-frames:v", "1", file);
        return imported(file);
      };
      const maraFront = image("mara-front", "red", "512x512");
      const maraThree = image("mara-3q", "orange", "512x512");
      const ivoFront = image("ivo-front", "blue", "512x512");
      const ivoThree = image("ivo-3q", "navy", "512x512");
      const plate = image("market", "gray", "1024x576");
      // The performance clip runs past Kling motion-control's 30 s window (profile: 3–30 s), so the plan proposes a trim.
      const clipFile = path.join(src, "performance.mp4");
      ffmpeg(
        "-f",
        "lavfi",
        "-i",
        "testsrc=s=360x640:r=10:d=36",
        "-pix_fmt",
        "yuv420p",
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        clipFile,
      );
      const clip = imported(clipFile);
      const voiceFile = path.join(src, "voice.wav");
      ffmpeg("-f", "lavfi", "-i", "sine=f=220:d=40", voiceFile);
      const voice = imported(voiceFile);

      // --- Cards through entity:card create / approve / coverage.
      const turnaround = (front: string, three: string) => [
        {
          assetId: front,
          role: "front",
          facts: { yawDeg: 0, background: "neutral", lighting: "even", handsEmpty: true },
        },
        {
          assetId: three,
          role: "three-quarter-left",
          facts: { yawDeg: 45, background: "neutral", lighting: "even", handsEmpty: true },
        },
      ];
      const cards = [
        {
          id: "mara",
          kind: "character",
          name: "Mara",
          description: "Mara, a market trader",
          appearance: { physical: "short dark hair" },
          persona: { role: "lead" },
          createdBy: "agent",
          references: turnaround(maraFront.id, maraThree.id),
          likenessConsent: { status: "not-applicable" },
          fixedSentence: "Mara wears a rust-red raincoat and a silver ear cuff.",
          voice: { description: "low, calm", consent: { status: "not-applicable" }, sampleAssetIds: [voice.id] },
        },
        {
          id: "ivo",
          kind: "character",
          name: "Ivo",
          description: "Ivo, a courier",
          appearance: { physical: "tall, shaved head" },
          persona: { role: "support" },
          createdBy: "agent",
          references: turnaround(ivoFront.id, ivoThree.id),
          likenessConsent: { status: "not-applicable" },
        },
        {
          id: "market",
          kind: "location",
          name: "Night market",
          description: "a covered night market",
          geography: "city",
          layout: "two rows of stalls",
          lighting: "warm practicals",
          createdBy: "agent",
          references: [{ assetId: plate.id, role: "plate-wide", facts: { background: "scene", lighting: "scene" } }],
        },
      ];
      for (const card of cards) {
        const input = write(`cards/${card.id}.json`, card);
        ok(rootDir, "entity-card.ts", ["--project", ID, "--action", "create", "--input", input]);
        ok(rootDir, "entity-card.ts", [
          "--project",
          ID,
          "--action",
          "approve",
          "--kind",
          card.kind,
          "--id",
          card.id,
          "--revision",
          "1",
          "--expected-revision",
          "1",
          "--actor",
          "director",
          "--authorization-evidence",
          "Fixture: the user approved the cards in chat.",
          "--confirm-user-approval",
        ]);
      }
      const coverage = ok(rootDir, "entity-card.ts", [
        "--project",
        ID,
        "--action",
        "coverage",
        "--kind",
        "character",
        "--id",
        "mara",
      ]).metadata!.coverage;
      assert.equal(coverage.advisory, true);
      assert.deepEqual(coverage.missingRequired, []);
      assert.ok(coverage.present.includes("voice-sample"));
      assert.ok(
        !coverage.ruleFindings.some((item: { rule: string }) => /minDistinctYaw/.test(item.rule)),
        `a 45° turnaround satisfies the angle rule: ${JSON.stringify(coverage.ruleFindings)}`,
      );

      // --- Material: two generated shots, made from references.
      const materialFile = path.join(pipeline, "material.json");
      const item = (id: string, shot: string, what: string) => ({
        id,
        shots: [shot],
        what,
        kind: "generated-video",
        route: "generated",
        status: "pending",
        provenance: "fal",
        licence: "generated",
        maxCostUsd: 2,
      });
      const items = [
        item("item-s1", "s1", "Mara and Ivo meet in the night market; Mara speaks"),
        item("item-s2", "s2", "Mara repeats the performer's dance"),
      ];
      const writeMaterial = (list: unknown[]) =>
        writeFileSync(
          materialFile,
          `${JSON.stringify({ schemaVersion: 1, filmType: "ai-video", items: list }, null, 2)}\n`,
        );
      writeMaterial(items);

      // --- refs:plan draft (a) Seedance 2.5: two characters, a location and a voice; (b) Kling motion-control.
      const draft = (shot: string, itemId: string, extra: string[]) =>
        ok(rootDir, "refs-plan.ts", [
          "--project",
          ID,
          "--action",
          "draft",
          "--shot",
          shot,
          "--material-item",
          itemId,
          ...extra,
          "--write",
        ]).metadata!;
      const s1 = draft("s1", "item-s1", [
        "--intent",
        "reference-to-video",
        "--endpoint",
        SEEDANCE,
        "--entity",
        "character:mara,character:ivo,location:market",
      ]);
      assert.equal(s1.profile, "seedance-2.5");
      const s1Shot = s1.shot as ShotReferences;
      const voiceReq = s1Shot.requirements.find((item) => item.role === "voice")!;
      assert.equal(voiceReq.modality, "audio");
      assert.equal(voiceReq.status, "planned", "a 40 s voice sample is over Seedance's 30.2 s audio window");
      assert.deepEqual(
        voiceReq.prepare.map((step) => step.op),
        ["audio-trim"],
      );
      for (const key of ["mara-front", "ivo-front", "market-plate-wide"])
        assert.equal(s1Shot.requirements.find((item) => item.key === key)?.status, "ready", key);
      const s2 = draft("s2", "item-s2", [
        "--intent",
        "motion-transfer",
        "--endpoint",
        KLING_MC,
        "--entity",
        "character:mara",
        "--asset",
        `motion:${clip.id}`,
      ]);
      const motionReq = (s2.shot as ShotReferences).requirements.find((item) => item.key === "motion")!;
      assert.equal(motionReq.status, "planned");
      assert.deepEqual(motionReq.prepare, [{ op: "trim", startSec: 0, durationSec: 30 }]);

      // Chain check, phase one: before the material approval planned requirements pass.
      const film = openFilmProject(project, { rootDir });
      const chainCheck = () =>
        DONE_CHECKS["references-ready"]({ project: film, tokens: baseTokens(film), silence: false });
      assert.deepEqual(chainCheck(), [], "before approval planned requirements and absent packs may wait");
      const materialRelative = path.relative(rootDir, materialFile);
      const approveMaterial = () =>
        write("public/projects/e2e/pipeline/approvals/material.json", {
          schemaVersion: 1,
          step: "material",
          events: [
            {
              answer: "Yes, go ahead with these shots.",
              at: "2026-11-17T12:00:00.000Z",
              artefacts: { [materialRelative]: sha256(materialFile) },
            },
          ],
        });
      approveMaterial();
      const after = chainCheck().join(" ");
      assert.match(after, /item-s2: shot s2 requirement motion is planned \(needs preparation \(trim\)\)/);
      assert.match(after, /has no reference pack: pnpm refs:pack --project e2e --action prepare/);

      // --- refs:derive: the plan's own prepare steps become derivative specs.
      const derive = (id: string, assetId: string, steps: unknown[], purpose: string) => {
        const spec = write(`specs/${id}.json`, { schemaVersion: 1, id, input: { assetId }, steps, purpose });
        const planned = ok(rootDir, "refs-derive.ts", ["--project", ID, "--action", "plan", "--spec", spec]).metadata!;
        assert.equal(planned.spend, "none");
        const run = ok(rootDir, "refs-derive.ts", ["--project", ID, "--action", "run", "--spec", spec]).metadata!;
        assert.equal(run.status, "ready");
        return run;
      };
      const motionTrim = derive(
        "motion-trim",
        clip.id,
        motionReq.prepare,
        "Fit the performance into Kling motion-control's 30 s window",
      );
      assert.ok(Math.abs(motionTrim.output.durationSec - 30) < 0.2, String(motionTrim.output.durationSec));
      assert.notEqual(motionTrim.assetId, clip.id);
      const voiceTrim = derive(
        "voice-trim",
        voice.id,
        voiceReq.prepare,
        "Fit Mara's voice into Seedance's audio window",
      );

      // Re-draft the motion shot on the derivative: ready. The voice requirement takes the derivative as its source.
      const s2Again = draft("s2", "item-s2", [
        "--intent",
        "motion-transfer",
        "--endpoint",
        KLING_MC,
        "--entity",
        "character:mara",
        "--asset",
        `motion:${motionTrim.assetId}`,
      ]);
      const motionReady = (s2Again.shot as ShotReferences).requirements.find((item) => item.key === "motion")!;
      assert.equal(motionReady.status, "ready");
      assert.deepEqual(motionReady.prepare, []);
      const plan = readReferencesPlan(ID, rootDir)!;
      writeReferencesPlan(
        ID,
        {
          ...plan,
          shots: plan.shots.map((shot) => ({
            ...shot,
            requirements: shot.requirements.map((requirement) =>
              requirement.key === voiceReq.key
                ? {
                    ...requirement,
                    source: { kind: "derivative" as const, derivativeId: "voice-trim" },
                    prepare: [],
                    status: "ready" as const,
                    notes: undefined,
                  }
                : requirement,
            ),
          })),
        },
        rootDir,
      );
      const checked = ok(rootDir, "refs-plan.ts", ["--project", ID, "--action", "check"]).metadata!;
      assert.equal(checked.ok, true);
      assert.equal(checked.errors, 0);
      const status = ok(rootDir, "refs-plan.ts", ["--project", ID, "--action", "status"]).metadata!;
      assert.deepEqual(status.unplanned, []);
      for (const shot of status.shots) assert.deepEqual(shot.open, [], `shot ${shot.shotId} has no open requirement`);

      // --- refs:pack: specs from references.json (slot assignment as the plan check does it), no marker typed.
      const ready = readReferencesPlan(ID, rootDir)!;
      const packSpec = (
        packId: string,
        shot: ShotReferences,
        endpoint: string,
        prompt: object,
        audioPolicy: string,
        params: Record<string, unknown> = {},
      ) =>
        write(
          `specs/pack-${packId}.json`,
          packSpecFor(rootDir, ID, packId, shot, endpoint, prompt, audioPolicy, params),
        );
      const shot1 = ready.shots.find((shot) => shot.shotId === "s1")!;
      const shot2 = ready.shots.find((shot) => shot.shotId === "s2")!;
      const specs = {
        "pack-s1": packSpec(
          "pack-s1",
          shot1,
          SEEDANCE,
          {
            action: "Mara and Ivo meet between the stalls as the lamps come on; Mara turns and greets him.",
            invariants: ["Mara wears a rust-red raincoat and a silver ear cuff."],
            camera: "Slow push-in at eye level.",
            audio: 'Mara says: "You are late again."',
          },
          "native",
        ),
        "pack-s2": packSpec(
          "pack-s2",
          shot2,
          KLING_MC,
          { action: "Mara dances the performer's routine in place, full body, facing the camera." },
          "mute",
          { character_orientation: "video" },
        ),
      };
      const packs: Record<string, { sha256: string; request: string }> = {};
      for (const [packId, spec] of Object.entries(specs)) {
        const prepared = ok(rootDir, "refs-pack.ts", [
          "--project",
          ID,
          "--action",
          "prepare",
          "--spec",
          spec,
        ]).metadata!;
        assert.equal(prepared.approved, false);
        const board = ok(rootDir, "refs-pack.ts", ["--project", ID, "--action", "board", "--id", packId]);
        assert.equal(board.metadata!.packSha256, prepared.packSha256);
        assert.match(readFileSync(board.outputs![0]!, "utf8"), new RegExp(packId));
        // Unapproved: the request is emitted, but generate:model will not call it executable.
        const unapproved = ok(rootDir, "refs-pack.ts", ["--project", ID, "--action", "request", "--id", packId]);
        assert.equal(unapproved.metadata!.approved, false);
        assert.equal(unapproved.metadata!.rightsRequired, true, "manual originals and video need rights");
        ok(rootDir, "refs-pack.ts", [
          "--project",
          ID,
          "--action",
          "rights",
          "--id",
          packId,
          "--status",
          "owned",
          "--allow-processing",
          "--evidence",
          "Fixture: synthetic test patterns made for this test.",
          "--placements",
          "private-study",
          "--audio-rights",
          "owned",
          "--answer",
          "Yes, these are all mine to use.",
        ]);
        const template = JSON.parse(
          readFileSync(path.join(pipeline, "reference-packs", packId, "visual-review-template.json"), "utf8"),
        );
        const review = write(`specs/review-${packId}.json`, {
          ...template,
          reviewer: "fixture reviewer",
          evidence: "Inspected board.html and every attachment at full size.",
          markersVerified: true,
          promptReviewed: true,
          attachments: template.attachments.map((item: Record<string, unknown>) => ({
            ...item,
            suitable: true,
            evidence: "Shows what its role sentence asks for.",
          })),
        });
        ok(rootDir, "refs-pack.ts", [
          "--project",
          ID,
          "--action",
          "approve",
          "--id",
          packId,
          "--review",
          review,
          "--answer",
          "Yes, use these.",
        ]);
        const request = ok(rootDir, "refs-pack.ts", ["--project", ID, "--action", "request", "--id", packId]);
        assert.equal(request.metadata!.approved, true);
        packs[packId] = { sha256: prepared.packSha256, request: request.outputs![0]! };
      }
      const receipt = (packId: string) =>
        JSON.parse(readFileSync(path.join(pipeline, "reference-packs", packId, "receipt.json"), "utf8"));
      const seedance = receipt("pack-s1");
      assert.match(seedance.compiledPrompt, /@Image1/, "Seedance's at-indexed dialect compiled by refs:pack");
      assert.match(seedance.compiledPrompt, /@Audio1/);
      assert.ok(Object.keys(seedance.markerMap).includes("@Audio1"));
      const kling = receipt("pack-s2");
      assert.ok(
        kling.attachments.some(
          (item: { requirementKey: string; media: { sha256: string } }) =>
            item.requirementKey === "motion" && item.media.sha256 === motionTrim.output.sha256,
        ),
        "the motion pack attaches the trimmed derivative",
      );
      assert.ok(
        !kling.spec.attachments.some((item: { source: { assetId: string } }) => item.source.assetId === clip.id),
      );

      // --- generate:model --dry-run on each approved pack's request (default enforcement: warn).
      for (const [packId, pack] of Object.entries(packs)) {
        const run = cli(rootDir, "generate-model.ts", [
          "--request",
          pack.request,
          "--project",
          ID,
          "--output",
          `public/projects/${ID}/assets/videos/${packId}.mp4`,
          "--dry-run",
          "--max-cost-usd",
          "5",
        ]);
        assert.equal(run.envelope.ok, true, JSON.stringify(run.envelope));
        assert.equal(run.envelope.metadata!.executable, true, JSON.stringify(run.envelope.metadata));
        assert.deepEqual(run.envelope.metadata!.referencePack, { id: packId, sha256: pack.sha256, status: "approved" });
        assert.equal(run.envelope.metadata!.warnings, undefined);
      }

      // --- Chain check, phase two: bound, approved packs pass once the user approved this material.
      writeMaterial(
        items.map((entry, index) => ({
          ...entry,
          referencePack: { id: `pack-s${index + 1}`, sha256: packs[`pack-s${index + 1}`]!.sha256 },
        })),
      );
      assert.deepEqual(chainCheck(), []);
      approveMaterial();
      assert.deepEqual(chainCheck(), [], "after approval: ready inputs and approved, current packs");

      // --- No hand-written markers: markers exist only in what refs:pack compiled.
      const files = filesUnder(pipeline);
      const marked = files.filter((file) => HAND_MARKER.test(readFileSync(path.join(pipeline, file), "utf8")));
      assert.ok(marked.length > 0);
      assert.deepEqual(
        marked.filter((file) => !COMPILED.test(file)),
        [],
        `markers outside compiled pack files: ${marked.join(", ")}`,
      );
      for (const file of ["references.json", "material.json"])
        assert.doesNotMatch(readFileSync(path.join(pipeline, file), "utf8"), HAND_MARKER, file);
      for (const packId of Object.keys(packs)) {
        const spec = JSON.parse(readFileSync(path.join(pipeline, "reference-packs", packId, "spec.json"), "utf8"));
        assert.doesNotMatch(JSON.stringify(spec.prompt), HAND_MARKER, `${packId} spec prompt`);
        const request = JSON.parse(readFileSync(packs[packId]!.request, "utf8"));
        const outsidePrompt = JSON.stringify({ ...request, input: { ...request.input, prompt: undefined } });
        assert.doesNotMatch(outsidePrompt, HAND_MARKER, `${packId} request outside its compiled prompt`);
        assert.equal(request.input.prompt, receipt(packId).compiledPrompt);
      }
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  },
);

/** The bench check for `task`, run as bench measure runs it: the bundle root as data, the trusted repo as cwd. */
function benchCheck(task: string, root: string) {
  const run = spawnSync(process.execPath, [path.join(REPO, `bench/instructions/${task}/check.mjs`), root], {
    cwd: REPO,
    encoding: "utf8",
    timeout: 10_000,
    env: { PATH: process.env.PATH },
  });
  return { passed: run.status === 0, stderr: run.stderr };
}

test(
  "AC21 instruction tasks: the fixture setup, the intended agent flow passes each check.mjs and a violation fails it",
  media,
  () => {
    const rootDir = mkdtempSync(path.join(tmpdir(), "reference-bench-"));
    try {
      const setup = (task: string, variant: string) => {
        const run = spawnSync(
          process.execPath,
          [
            "--import",
            TSX_LOADER,
            path.join(REPO, "tests/fixtures/bench/reference-project.ts"),
            "--project",
            `bench-${task}`,
            "--variant",
            variant,
          ],
          {
            cwd: rootDir,
            encoding: "utf8",
            timeout: 120_000,
            env: { PATH: process.env.PATH, AGENTBROS_NO_DOTENV: "1" },
          },
        );
        const lines = run.stdout.trim().split("\n");
        assert.equal(lines.length, 1, run.stdout + run.stderr);
        const envelope = JSON.parse(lines[0]!);
        assert.equal(envelope.ok, true, JSON.stringify(envelope));
        return envelope.metadata as { projectId: string; assets: Record<string, string>; items: string[] };
      };
      const draft = (project: string, shot: string, item: string, args: string[]) =>
        ok(rootDir, "refs-plan.ts", [
          "--project",
          project,
          "--action",
          "draft",
          "--shot",
          shot,
          "--material-item",
          item,
          ...args,
          "--write",
        ]).metadata!;
      const prepare = (
        project: string,
        packId: string,
        shotId: string,
        endpoint: string,
        action: string,
        params?: Record<string, unknown>,
      ) => {
        const shot = readReferencesPlan(project, rootDir)!.shots.find((item) => item.shotId === shotId)!;
        const file = path.join(rootDir, `${project}-${packId}.json`);
        writeFileSync(
          file,
          JSON.stringify(packSpecFor(rootDir, project, packId, shot, endpoint, { action }, "native", params)),
        );
        return ok(rootDir, "refs-pack.ts", ["--project", project, "--action", "prepare", "--spec", file]).metadata!;
      };
      const result = (value: unknown) => writeFileSync(path.join(rootDir, "bench-result.json"), JSON.stringify(value));
      const pipeline = (project: string) => path.join(rootDir, "public/projects", project, "pipeline");

      // reference-plan: two shots planned and packed, the abstract one recorded as text-only; stop at the pack gate.
      const plan = setup("reference-plan", "plan");
      draft(plan.projectId, "s1", "item-s1", [
        "--intent",
        "keyframe-image",
        "--endpoint",
        "google/nano-banana-2.1/edit",
        "--entity",
        "character:mara,location:market",
      ]);
      draft(plan.projectId, "s2", "item-s2", [
        "--intent",
        "reference-to-video",
        "--endpoint",
        SEEDANCE,
        "--entity",
        "character:mara,character:ivo,location:market",
      ]);
      const materialFile = path.join(pipeline(plan.projectId), "material.json");
      const material = JSON.parse(readFileSync(materialFile, "utf8"));
      material.items[2].referencePlan = {
        mode: "none",
        reason: "Abstract ink texture: no subject, place or look to hold.",
      };
      writeFileSync(materialFile, JSON.stringify(material, null, 2));
      ok(rootDir, "refs-plan.ts", ["--project", plan.projectId, "--action", "check"]);
      result({ blocked: true, gate: "pack approval" });
      assert.equal(benchCheck("reference-plan", rootDir).passed, false, "a ready shot without a prepared pack fails");
      prepare(plan.projectId, "pack-s1", "s1", "google/nano-banana-2.1/edit", "Mara looks towards the entrance.");
      prepare(plan.projectId, "pack-s2", "s2", SEEDANCE, "Mara and Ivo meet as the lamps come on.");
      assert.deepEqual(benchCheck("reference-plan", rootDir), { passed: true, stderr: "" });
      const fabricated = path.join(pipeline(plan.projectId), "reference-packs/pack-s1/approval.json");
      writeFileSync(fabricated, "{}");
      assert.equal(benchCheck("reference-plan", rootDir).passed, false, "a fabricated pack approval fails");
      rmSync(fabricated);

      // no-hand-markers: one pack prepared; markers only in its compiled files.
      const markers = setup("no-hand-markers", "markers");
      draft(markers.projectId, "s1", "item-s1", [
        "--intent",
        "reference-to-video",
        "--endpoint",
        SEEDANCE,
        "--entity",
        "character:mara,character:ivo,location:market",
      ]);
      const packed = prepare(markers.projectId, "pack-s1", "s1", SEEDANCE, "Mara and Ivo meet as the lamps come on.");
      assert.match(packed.compiledPrompt, /@Image1/);
      result({ packId: "pack-s1" });
      assert.deepEqual(benchCheck("no-hand-markers", rootDir), { passed: true, stderr: "" });
      const notes = path.join(pipeline(markers.projectId), "notes.md");
      writeFileSync(notes, "Prompt draft: @Image1 walks to @Image2.\n");
      assert.equal(benchCheck("no-hand-markers", rootDir).passed, false, "a hand-written marker in notes fails");
      rmSync(notes);

      // reference-derivative-first: the 40 s clip is trimmed, the pack attaches the trim.
      const derived = setup("reference-derivative-first", "derivative");
      const clip = derived.assets.performanceClip!;
      const first = draft(derived.projectId, "s1", "item-s1", [
        "--intent",
        "motion-transfer",
        "--endpoint",
        KLING_MC,
        "--entity",
        "character:mara",
        "--asset",
        `motion:${clip}`,
      ]);
      const motion = (first.shot as ShotReferences).requirements.find((item) => item.key === "motion")!;
      assert.deepEqual(motion.prepare, [{ op: "trim", startSec: 0, durationSec: 30 }]);
      const specFile = path.join(rootDir, "motion-trim.json");
      writeFileSync(
        specFile,
        JSON.stringify({
          schemaVersion: 1,
          id: "motion-trim",
          input: { assetId: clip },
          steps: motion.prepare,
          purpose: "Fit the performance into the 30 s motion window",
        }),
      );
      const trim = ok(rootDir, "refs-derive.ts", [
        "--project",
        derived.projectId,
        "--action",
        "run",
        "--spec",
        specFile,
      ]).metadata!;
      draft(derived.projectId, "s1", "item-s1", [
        "--intent",
        "motion-transfer",
        "--endpoint",
        KLING_MC,
        "--entity",
        "character:mara",
        "--asset",
        `motion:${trim.assetId}`,
      ]);
      prepare(derived.projectId, "pack-s1", "s1", KLING_MC, "Mara performs the routine in place.", {
        character_orientation: "video",
      });
      result({ derivativeId: "motion-trim" });
      assert.deepEqual(benchCheck("reference-derivative-first", rootDir), { passed: true, stderr: "" });
      // Editing tracked profile data (a changed file in the bundle) fails.
      const profiles = path.join(rootDir, "src/lib/models/reference-profiles.json");
      mkdirSync(path.dirname(profiles), { recursive: true });
      writeFileSync(profiles, readFileSync(path.join(REPO, "src/lib/models/reference-profiles.json"), "utf8") + " ");
      assert.equal(benchCheck("reference-derivative-first", rootDir).passed, false, "an edited profile fails");
      rmSync(path.join(rootDir, "src"), { recursive: true });
      result({ derivativeId: "no-such-derivative" });
      assert.equal(benchCheck("reference-derivative-first", rootDir).passed, false);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  },
);
