/**
 * The projector's smaller sections (RFC 0004 §6.2): control, autonomy, assets, QA findings and the delivery check,
 * agent cards and the step guard. Each reads its own files and never throws: a corrupt file degrades to the empty
 * section plus an advisory line.
 */
import { readdirSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  CARDS_DIR,
  CONTROL_FILE,
  ControlFileSchema,
  FORMATS,
  type AssetSummary,
  type Card,
  type Finding,
  type ProjectView,
} from "../../../types/console";
import { AssetRegistrySchema } from "../../../types/assets";
import { MaterialSchema } from "../../../types/film";
import { currentPolicy } from "../../autonomy/policy";
import { stepGuardReport } from "../../step-lease/lease";
import { orderViewCards, scanCards } from "../cards";
import { locate, readJsonFile, readJsonObject, statOf, text, toIso, type ProjectPaths } from "./files";

export type Section<T> = { value: T; advisories: string[] };

const rel = (paths: ProjectPaths, file: string) => path.relative(paths.projectDir, file).split(path.sep).join("/");

// --- Control ---

export function readControl(paths: ProjectPaths): Section<ProjectView["control"]> {
  const file = path.join(paths.projectDir, CONTROL_FILE);
  const raw = readJsonObject(file);
  if (raw === undefined) return { value: { state: "running" }, advisories: [] };
  const parsed = ControlFileSchema.safeParse(raw);
  if (!parsed.success)
    return {
      value: { state: "running" },
      advisories: [`control: ${CONTROL_FILE} is not a valid control file; shown as running.`],
    };
  const control = parsed.data;
  return {
    value: {
      state: control.state,
      by: "user",
      at: control.at,
      ...(control.reason ? { reason: control.reason.slice(0, 2000) } : {}),
    },
    advisories: [],
  };
}

// --- Autonomy ---

export function readAutonomy(paths: ProjectPaths, storeCeilingUsd?: number): Section<ProjectView["autonomy"]> {
  try {
    const policy = currentPolicy(paths.projectDir);
    if (policy)
      return {
        value: {
          mode: policy.autonomy,
          ...(policy.budget ? { ceilingUsd: policy.budget.ceilingUsd } : {}),
          finalReviewOnly: policy.finalReviewOnly,
          source: "film:policy",
        },
        advisories: [],
      };
  } catch (error) {
    return {
      value: { mode: "interactive", source: "none" },
      advisories: [`autonomy: pipeline/policy.json cannot be read (${(error as Error).message ?? String(error)}).`],
    };
  }
  return storeCeilingUsd !== undefined
    ? { value: { mode: "interactive", ceilingUsd: storeCeilingUsd, source: "budget" }, advisories: [] }
    : { value: { mode: "interactive", source: "none" }, advisories: [] };
}

// --- Assets ---

const KIND = new Set(["image", "video", "audio", "model3d", "text", "json"]);
const url = z.url();

export function readAssets(paths: ProjectPaths): Section<AssetSummary[]> {
  const file = path.join(paths.projectDir, "pipeline", "asset-registry.json");
  const raw = readJsonObject(file);
  if (raw === undefined) return { value: [], advisories: [] };
  const parsed = AssetRegistrySchema.safeParse(raw);
  if (!parsed.success)
    return { value: [], advisories: ["assets: pipeline/asset-registry.json does not validate; assets not shown."] };
  // Where each file is used: the film's material items (shots) that name it.
  const material = MaterialSchema.safeParse(readJsonFile(path.join(paths.projectDir, "pipeline", "material.json")));
  const usedBy = new Map<string, string[]>();
  if (material.success)
    for (const item of material.data.items) {
      const where = item.path ? locate(paths, item.path) : undefined;
      if (!where) continue;
      const list = usedBy.get(where.path) ?? [];
      list.push(...(item.shots.length ? item.shots.map((shot) => `shot ${shot}`) : [`material ${item.id}`]));
      usedBy.set(where.path, list);
    }
  const assets: AssetSummary[] = [];
  for (const asset of parsed.data.assets) {
    const where = locate(paths, asset.files.original);
    if (!where || where.root !== "project") continue;
    const rights = asset.rights;
    const licence = {
      ...(text(rights.licence, 64) ? { id: text(rights.licence, 64) } : {}),
      ...(rights.sourceUrl && url.safeParse(rights.sourceUrl).success ? { url: rights.sourceUrl } : {}),
      ...(rights.attribution ? { attribution: rights.attribution.slice(0, 1000) } : {}),
    };
    const billing = asset.provenance.billing;
    const thumbnailKind = asset.kind === "image" ? "image" : asset.kind === "video" ? "video" : undefined;
    assets.push({
      id: asset.id.slice(0, 128),
      kind: KIND.has(asset.kind) ? asset.kind : "other",
      path: where.path,
      origin: asset.provenance.origin,
      ...(text(asset.provenance.model, 64) && asset.provenance.model !== "unknown"
        ? { provider: text(asset.provenance.model.split(/[/:]/)[0], 64) }
        : {}),
      ...(Object.keys(licence).length ? { licence } : {}),
      ...(billing.status === "reported" && billing.apiUsd !== undefined ? { costUsd: billing.apiUsd } : {}),
      usedIn: [...new Set(usedBy.get(where.path) ?? [])].slice(0, 256).map((entry) => entry.slice(0, 256)),
      sha256: asset.hash,
      ...(thumbnailKind ? { thumbnail: { path: where.path, kind: thumbnailKind, sha256: asset.hash } } : {}),
    });
  }
  return { value: assets.slice(0, 5000), advisories: [] };
}

// --- QA and delivery ---

const SEVERITY = new Set(["info", "warning", "error"]);

function findingsOf(file: string, source: string, id: string): Finding[] {
  const raw = readJsonFile(file) as { findings?: unknown } | undefined;
  if (!raw || !Array.isArray(raw.findings)) return [];
  return raw.findings.flatMap((item, index): Finding[] => {
    if (!item || typeof item !== "object") return [];
    const finding = item as Record<string, unknown>;
    const message = text(finding.message, 2000) ?? text(finding.code, 2000);
    if (!message) return [];
    const severity = SEVERITY.has(String(finding.severity))
      ? (String(finding.severity) as Finding["severity"])
      : "info";
    const format = FORMATS.find((value) => value === finding.format);
    const frame = typeof finding.frame === "number" && finding.frame >= 0 ? Math.floor(finding.frame) : undefined;
    const time =
      typeof finding.timeSec === "number" && finding.timeSec >= 0
        ? finding.timeSec
        : typeof finding.atSec === "number" && finding.atSec >= 0
          ? finding.atSec
          : undefined;
    return [
      {
        id: `${id}-${index + 1}`.slice(0, 128),
        severity,
        source,
        message,
        ...(text(finding.step, 64) ? { step: text(finding.step, 64) } : {}),
        ...(format ? { format } : {}),
        ...(frame !== undefined ? { frame } : {}),
        ...(time !== undefined ? { timeSec: time } : {}),
      },
    ];
  });
}

export function readQa(paths: ProjectPaths): Section<ProjectView["qa"]> {
  const pipeline = path.join(paths.projectDir, "pipeline");
  const findings = [
    ...findingsOf(path.join(pipeline, "qa.json"), "qa", "qa"),
    ...findingsOf(path.join(pipeline, "editorial-qa.json"), "qa:editorial", "editorial-qa"),
  ];
  // The newest delivery report (pipeline/delivery/reports/*.json, written by `delivery --action check`).
  let delivery: ProjectView["qa"]["delivery"];
  const reports = path.join(pipeline, "delivery", "reports");
  try {
    const newest = readdirSync(reports)
      .filter((name) => name.endsWith(".json"))
      .map((name) => ({ file: path.join(reports, name), mtime: statOf(path.join(reports, name))?.mtimeMs ?? 0 }))
      .sort((a, b) => b.mtime - a.mtime)[0];
    if (newest) {
      const report = readJsonFile(newest.file) as
        { state?: unknown; createdAt?: unknown; outputs?: { format?: unknown }[]; findings?: unknown } | undefined;
      if (report && typeof report === "object") {
        const ok = report.state === "production-ready";
        const checkedAt =
          typeof report.createdAt === "string" && !Number.isNaN(Date.parse(report.createdAt))
            ? new Date(report.createdAt).toISOString()
            : toIso(newest.mtime);
        const formats = [
          ...new Set(
            (Array.isArray(report.outputs) ? report.outputs : []).flatMap((output) =>
              FORMATS.filter((format) => format === output?.format),
            ),
          ),
        ].map((format) => ({ format, ok }));
        delivery = { ok, checkedAt, ...(formats.length ? { formats } : {}) };
        findings.push(...findingsOf(newest.file, "delivery", "delivery"));
      }
    }
  } catch {
    // no reports yet
  }
  return { value: { findings: findings.slice(0, 1000), ...(delivery ? { delivery } : {}) }, advisories: [] };
}

// --- Cards ---

export type CardsRead = { cards: Card[]; expired: Card[]; files: Map<string, string> };

/**
 * Agent cards through the card store's reader (`scanCards`, `orderViewCards` in ../cards.ts), valid ones only (an
 * invalid file is an advisory): unanswered cards that expect an answer first, then the rest, newest first within each
 * group. A card past `expiresAt` without an answer is left out (listed in `expired`); `files` maps a card id to its file.
 */
export function readCards(paths: ProjectPaths, project: string, now: number): Section<CardsRead> {
  const scan = scanCards(paths.projectDir, project, now);
  const advisories: string[] = [];
  if (scan.invalid)
    advisories.push(`cards: ${scan.invalid} card file(s) in ${CARDS_DIR}/ do not validate and are not shown.`);
  if (scan.expired.length) advisories.push(`cards: ${scan.expired.length} card(s) expired without an answer.`);
  const files = new Map<string, string>();
  for (const card of [...scan.cards, ...scan.expired])
    files.set(card.id, rel(paths, path.join(paths.projectDir, CARDS_DIR, `${card.id}.json`)));
  return { value: { cards: orderViewCards(scan.cards), expired: scan.expired, files }, advisories };
}

// --- Step guard ---

export function readStepGuard(paths: ProjectPaths): ProjectView["stepGuard"] {
  try {
    const report = stepGuardReport(paths.projectDir);
    if (!report) return undefined;
    const last = report.recent.at(-1);
    return {
      violations: report.outOfStep,
      ...(last && !Number.isNaN(Date.parse(last.at)) && last.alias && last.step
        ? {
            last: {
              at: new Date(last.at).toISOString(),
              alias: last.alias.slice(0, 64),
              step: last.step.slice(0, 64),
              code: last.code,
            },
          }
        : {}),
    };
  } catch {
    return undefined;
  }
}
