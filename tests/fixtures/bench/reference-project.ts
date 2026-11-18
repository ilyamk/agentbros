/**
 * Fixture project for the reference-pack instruction tasks (bench/instructions/{reference-plan,no-hand-markers,
 * reference-derivative-first}; RFC 0003 AC21). Synthetic media from ffmpeg lavfi (test patterns and tones, not a
 * person or speech), imported as the user's originals; character and location cards supplied approved as fixture data
 * (a benchmark fixture, not a production approval); pipeline/material.json and pipeline/shot-list.json per task.
 *
 *   pnpm exec tsx tests/fixtures/bench/reference-project.ts --project bench-<task> --variant plan|markers|derivative
 *
 * Prints one JSON line. Refuses an existing project directory.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { importAsset } from "../../../src/lib/assets/registry";
import { approveEntityVersion, saveEntityVersion } from "../../../src/lib/entities/service";
import type { EntityCardInput } from "../../../src/types/entities";

export type ReferenceFixtureVariant = "plan" | "markers" | "derivative";
export type ReferenceFixture = {
  projectId: string;
  variant: ReferenceFixtureVariant;
  assets: Record<string, string>;
  items: string[];
};

function ffmpeg(...args: string[]): void {
  const result = spawnSync("ffmpeg", ["-v", "error", "-nostdin", "-y", ...args], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`ffmpeg failed: ${result.stderr}`);
}

const ACTOR = {
  id: "bench-fixture",
  kind: "human" as const,
  authorizationEvidence: "Benchmark fixture: these cards are supplied approved. Not a production approval.",
};

export function createReferenceFixture(
  projectId: string,
  variant: ReferenceFixtureVariant,
  rootDir = process.cwd(),
): ReferenceFixture {
  const project = path.join(rootDir, "public/projects", projectId);
  if (existsSync(project)) throw new Error(`${project} exists; the fixture writes a new project only.`);
  mkdirSync(path.join(project, "pipeline"), { recursive: true });
  writeFileSync(path.join(project, "project.json"), "{}\n");
  const scratch = mkdtempSync(path.join(tmpdir(), "bench-reference-"));
  try {
    const imported = (file: string) =>
      importAsset({
        rootDir,
        projectId,
        sourceFile: file,
        provenance: { origin: "manual", tool: "bench-fixture-ffmpeg-lavfi" },
      }).asset.id;
    const image = (name: string, colour: string, size: string) => {
      const file = path.join(scratch, `${name}.png`);
      ffmpeg("-f", "lavfi", "-i", `color=c=${colour}:s=${size}`, "-frames:v", "1", file);
      return imported(file);
    };
    const assets: Record<string, string> = {
      maraFront: image("mara-front", "red", "512x512"),
      maraThreeQuarter: image("mara-three-quarter", "orange", "512x512"),
      ivoFront: image("ivo-front", "blue", "512x512"),
      ivoThreeQuarter: image("ivo-three-quarter", "navy", "512x512"),
      marketPlate: image("market-plate", "gray", "1024x576"),
    };
    if (variant !== "derivative") {
      const file = path.join(scratch, "mara-voice.wav");
      ffmpeg("-f", "lavfi", "-i", "sine=f=220:d=10", file);
      assets.maraVoice = imported(file);
    } else {
      // 40 s: over Kling motion-control's 3–30 s motion window.
      const file = path.join(scratch, "performance.mp4");
      ffmpeg(
        "-f",
        "lavfi",
        "-i",
        "testsrc=s=360x640:r=10:d=40",
        "-pix_fmt",
        "yuv420p",
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        file,
      );
      assets.performanceClip = imported(file);
    }
    const view = (assetId: string, role: string, yawDeg: number) => ({
      assetId,
      role,
      facts: { yawDeg, background: "neutral", lighting: "even", handsEmpty: true },
    });
    const cards = [
      {
        id: "mara",
        kind: "character",
        name: "Mara",
        description: "Mara, a market trader",
        appearance: { physical: "short dark hair" },
        persona: { role: "lead" },
        createdBy: "agent",
        references: [view(assets.maraFront!, "front", 0), view(assets.maraThreeQuarter!, "three-quarter-left", 45)],
        likenessConsent: { status: "not-applicable" },
        fixedSentence: "Mara wears a rust-red raincoat and a silver ear cuff.",
        ...(assets.maraVoice
          ? {
              voice: {
                description: "low, calm",
                consent: { status: "not-applicable" },
                sampleAssetIds: [assets.maraVoice],
              },
            }
          : {}),
      },
      {
        id: "ivo",
        kind: "character",
        name: "Ivo",
        description: "Ivo, a courier",
        appearance: { physical: "tall, shaved head" },
        persona: { role: "support" },
        createdBy: "agent",
        references: [view(assets.ivoFront!, "front", 0), view(assets.ivoThreeQuarter!, "three-quarter-right", -45)],
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
        references: [{ assetId: assets.marketPlate!, role: "plate-wide" }],
      },
    ] as EntityCardInput[];
    for (const card of cards) {
      saveEntityVersion(projectId, card, { rootDir });
      approveEntityVersion(projectId, card.kind, card.id, 1, ACTOR, { rootDir, expectedRevision: 1 });
    }

    const item = (id: string, shot: string, kind: string, what: string) => ({
      id,
      shots: [shot],
      what,
      kind,
      route: "generated",
      status: "pending",
      provenance: "fal (planned)",
      licence: "generated",
      maxCostUsd: 2,
    });
    const meeting = {
      shotId: "s2",
      materialItemId: "item-s2",
      intent: "reference-to-video",
      endpoint: "bytedance/seedance-2.5/reference-to-video",
      entities: ["character:mara", "character:ivo", "location:market"],
      action: "Mara and Ivo meet between the stalls as the lamps come on; Mara greets him.",
    };
    const shots =
      variant === "plan"
        ? [
            {
              shotId: "s1",
              materialItemId: "item-s1",
              intent: "keyframe-image",
              endpoint: "google/nano-banana-2.1/edit",
              entities: ["character:mara", "location:market"],
              action: "Mara stands at her stall at dusk, looking towards the entrance.",
            },
            meeting,
            {
              shotId: "s3",
              materialItemId: "item-s3",
              intent: "text-to-video",
              endpoint: null,
              entities: [],
              action: "Abstract ink drifting in water behind the title; no person, product or place.",
            },
          ]
        : variant === "markers"
          ? [{ ...meeting, shotId: "s1", materialItemId: "item-s1" }]
          : [
              {
                shotId: "s1",
                materialItemId: "item-s1",
                intent: "motion-transfer",
                endpoint: "fal-ai/kling-video/v3/standard/motion-control",
                entities: ["character:mara"],
                assets: [`motion:${assets.performanceClip}`],
                action: "Mara performs the dancer's routine in place, full body, facing the camera.",
              },
            ];
    const items = shots.map((shot) =>
      item(
        shot.materialItemId,
        shot.shotId,
        shot.intent === "keyframe-image" ? "generated-image" : "generated-video",
        shot.action,
      ),
    );
    const write = (name: string, value: unknown) =>
      writeFileSync(path.join(project, "pipeline", name), `${JSON.stringify(value, null, 2)}\n`);
    write("material.json", { schemaVersion: 1, filmType: "ai-film", items });
    write("shot-list.json", { schemaVersion: 1, note: "Benchmark fixture shot list.", shots });
    return { projectId, variant, assets, items: items.map((entry) => entry.id) };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename ?? "")) {
  const started = performance.now();
  const value = (flag: string) => {
    const index = process.argv.indexOf(flag);
    return index > 0 ? process.argv[index + 1] : undefined;
  };
  try {
    const projectId = value("--project");
    const variant = value("--variant");
    if (!projectId || !/^[a-z0-9][a-z0-9-]*$/.test(projectId) || !["plan", "markers", "derivative"].includes(variant!))
      throw new Error("Usage: --project <id> --variant plan|markers|derivative");
    const fixture = createReferenceFixture(projectId, variant as ReferenceFixtureVariant);
    process.stdout.write(
      `${JSON.stringify({ ok: true, outputs: [`public/projects/${projectId}`], metadata: fixture, elapsedMs: Math.round(performance.now() - started) })}\n`,
    );
  } catch (error) {
    process.stdout.write(
      `${JSON.stringify({ ok: false, error: "INVALID_INPUT", message: error instanceof Error ? error.message : String(error), elapsedMs: Math.round(performance.now() - started) })}\n`,
    );
    process.exitCode = 1;
  }
}
