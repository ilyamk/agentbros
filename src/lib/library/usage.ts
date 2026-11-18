import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { CliErrorObject } from "../cli";
import { memoryDir } from "../memory";
import { MotionPlanSchema, type MotionPlan } from "../../types/creative";
import {
  CuePlacementsSchema,
  LibraryUsageSchema,
  type CuePlacements,
  type LibraryUsage,
  type UsageBlock,
} from "../../types/tournament";

// Which library blocks each film used, kept in local memory so the next film does not repeat the last one's hero.

export const USAGE_DIR = "usage";
/** plan:check compares a film with this many of the most recently recorded other films. */
export const RECENT_FILMS = 2;

const CHECKOUT_MEMORY = path.resolve(import.meta.dirname, "..", "..", "..", "memory");

export const usageDir = (root?: string) => path.join(memoryDir(root), USAGE_DIR);

/** JSON with every object's keys sorted, so the same props hash the same whatever their order. */
export function canonicalJson(value: unknown): string {
  if (value === undefined || value === null) return "null";
  if (Array.isArray(value))
    return `[${value.map((item) => (item === undefined ? "null" : canonicalJson(item))).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** sha256 of the canonical props, 16 hex; no props hash as `{}`. */
export const propsHash = (props: unknown): string =>
  createHash("sha256")
    .update(canonicalJson(props ?? {}))
    .digest("hex")
    .slice(0, 16);

const isCustom = (block: string) => /^custom\s*:/i.test(block.trim());

/**
 * The film's library blocks with their weight: placements (with props) first, each weighted by the plan shot whose frames
 * hold its start; then plan blocks no placement covers, with no props. A placement covers its plan block when it starts in
 * that shot or in the shot before (a transition placed ahead of its cut), and then takes the heavier of the two weights, so
 * one block is never recorded twice, once with an empty-props hash. `custom:` entries are not library blocks.
 */
export function usageBlocks(plan: MotionPlan, placements?: CuePlacements): UsageBlock[] {
  const scale = placements ? plan.fps / placements.fps : 1;
  const shotIndexAt = (frame: number) => {
    const index = plan.shots.findIndex(
      (shot) => frame >= shot.startFrame && frame < shot.startFrame + shot.durationFrames,
    );
    return index >= 0 ? index : frame >= 0 ? plan.shots.length - 1 : 0;
  };
  const weightOf = (index: number): UsageBlock["weight"] => (plan.shots[index]?.weight === "hero" ? "hero" : "support");
  const rows: (UsageBlock & { shotIndex: number; covers: Set<number> })[] = [];
  for (const block of placements?.blocks ?? []) {
    const shotIndex = shotIndexAt(Math.round(block.startFrame * scale));
    rows.push({
      id: block.id,
      propsHash: propsHash(block.props),
      weight: weightOf(shotIndex),
      shotIndex,
      covers: new Set(),
    });
  }
  for (const [index, shot] of plan.shots.entries()) {
    for (const id of (shot.blocks ?? []).map((block) => block.trim()).filter((block) => block && !isCustom(block))) {
      const placed =
        rows.find((row) => row.id === id && row.shotIndex === index && !row.covers.size) ??
        rows.find((row) => row.id === id && row.shotIndex === index - 1 && !row.covers.has(index));
      if (placed) {
        placed.covers.add(index);
        if (weightOf(index) === "hero") placed.weight = "hero";
        continue;
      }
      if (rows.some((row) => row.id === id && (row.shotIndex === index || row.covers.has(index)))) continue;
      rows.push({
        id,
        propsHash: propsHash(undefined),
        weight: weightOf(index),
        shotIndex: index,
        covers: new Set([index]),
      });
    }
  }
  const unique = new Map<string, UsageBlock>();
  for (const { id, propsHash: hash, weight } of rows)
    unique.set(`${id}|${hash}|${weight}`, { id, propsHash: hash, weight });
  return [...unique.values()].sort(
    (a, b) => a.id.localeCompare(b.id) || a.propsHash.localeCompare(b.propsHash) || a.weight.localeCompare(b.weight),
  );
}

const localDate = (date: Date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;

/** Writes memory/usage/<project>.json, replacing the project's earlier record. */
export function recordUsage(
  projectId: string,
  plan: MotionPlan,
  placements: CuePlacements | undefined,
  options: { root?: string; date?: Date } = {},
): { file: string; usage: LibraryUsage } {
  const dir = usageDir(options.root);
  if (
    process.env.NODE_TEST_CONTEXT &&
    !process.env.AGENTBROS_MEMORY_ROOT &&
    path.resolve(memoryDir(options.root)) === CHECKOUT_MEMORY
  ) {
    throw new CliErrorObject({
      code: "VALIDATION",
      message: "A test may not write this checkout's memory/: set AGENTBROS_MEMORY_ROOT or pass a temporary root.",
    });
  }
  const usage = LibraryUsageSchema.parse({
    schemaVersion: 1,
    projectId,
    date: localDate(options.date ?? new Date()),
    blocks: usageBlocks(plan, placements),
  });
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${projectId}.json`);
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(usage, null, 2)}\n`);
  renameSync(temporary, file);
  return { file, usage };
}

/** film:done --step build: records the film's blocks from its pipeline files. Best-effort: a warning instead of a throw. */
export function noteUsage(projectDir: string, projectId: string, root?: string): string | undefined {
  try {
    const plan = MotionPlanSchema.parse(
      JSON.parse(readFileSync(path.join(projectDir, "pipeline", "motion-plan.json"), "utf8")),
    );
    const placementsFile = path.join(projectDir, "pipeline", "cue-placements.json");
    const placements = existsSync(placementsFile)
      ? CuePlacementsSchema.parse(JSON.parse(readFileSync(placementsFile, "utf8")))
      : undefined;
    recordUsage(projectId, plan, placements, { root });
    return undefined;
  } catch (error) {
    return `library usage was not recorded: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/** Every valid record, newest first (date, then project id); unreadable files become warnings. */
export function listUsage(root?: string): { records: LibraryUsage[]; warnings: string[] } {
  const dir = usageDir(root);
  if (!existsSync(dir)) return { records: [], warnings: [] };
  const records: LibraryUsage[] = [];
  const warnings: string[] = [];
  for (const name of readdirSync(dir)
    .filter((file) => file.endsWith(".json"))
    .sort()) {
    try {
      const parsed = LibraryUsageSchema.safeParse(JSON.parse(readFileSync(path.join(dir, name), "utf8")));
      if (parsed.success) records.push(parsed.data);
      else warnings.push(`${USAGE_DIR}/${name}: ${parsed.error.issues[0]?.message ?? "invalid"}`);
    } catch (error) {
      warnings.push(`${USAGE_DIR}/${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  records.sort((a, b) => b.date.localeCompare(a.date) || b.projectId.localeCompare(a.projectId));
  return { records, warnings };
}

/** The most recently recorded films other than this one; with `exists`, only films whose project is still on disk. */
export const recentOtherFilms = (
  records: readonly LibraryUsage[],
  projectId: string,
  count = RECENT_FILMS,
  exists?: (projectId: string) => boolean,
) =>
  [...records]
    .sort((a, b) => b.date.localeCompare(a.date) || b.projectId.localeCompare(a.projectId))
    .filter((record) => record.projectId !== projectId && (!exists || exists(record.projectId)))
    .slice(0, count);
