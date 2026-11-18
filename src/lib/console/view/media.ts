/**
 * Renders the console can play (RFC 0004 §6.2, D21; §16: "renders lag behind code"): the newest full render in
 * `out/<id>/` (`film.mp4` or a format's mp4), the animatic and the other renders, newest first. A render with a
 * receipt (`<file>.receipt.json`, written by render and film:render) carries `renderedAt`, `sourceHash` (the
 * receipt's source snapshot) and `stale` when any recorded source file changed since; one without a receipt is stale
 * when the film's code (`src/projects/<id>/`) is newer than it.
 */
import { readdirSync } from "node:fs";
import path from "node:path";
import { FORMATS, type MediaRef, type ProjectView } from "../../../types/console";
import { RenderReceiptSchema } from "../../../types/delivery";
import { hashFile, readJsonFile, statOf, toIso, type ProjectPaths } from "./files";

/** Directories of `out/<id>/` that are not renders the user reviews. */
const SKIP_DIRS = new Set(["versions", "releases", "console", "cache", "tmp", "qa", "frames", "stills"]);
const VIDEO = /\.(mp4|mov|webm)$/i;
const MAX_RENDERS = 200;

function newestMtime(directory: string, budget = { left: 4000 }): number {
  let newest = 0;
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    if (budget.left-- <= 0) break;
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) newest = Math.max(newest, newestMtime(full, budget));
    else if (entry.isFile()) newest = Math.max(newest, statOf(full)?.mtimeMs ?? 0);
  }
  return newest;
}

/** One render's MediaRef with its time, source hash and staleness. */
export function renderRef(
  paths: ProjectPaths,
  relative: string,
  label: string | undefined,
  codeMtime: number,
): MediaRef | undefined {
  const file = path.join(paths.outDir, relative);
  const info = statOf(file);
  if (!info?.isFile()) return undefined;
  const receipt = RenderReceiptSchema.safeParse(readJsonFile(`${file}.receipt.json`));
  const base: MediaRef = { root: "out", path: relative, kind: "video", ...(label ? { label } : {}) };
  if (receipt.success) {
    const stale = receipt.data.sources.some(
      (source) => hashFile(path.resolve(paths.rootDir, source.path)) !== source.sha256,
    );
    return {
      ...base,
      renderedAt: new Date(receipt.data.createdAt).toISOString(),
      sourceHash: receipt.data.sourceSnapshotHash,
      stale,
    };
  }
  return { ...base, renderedAt: toIso(info.mtimeMs), ...(codeMtime ? { stale: codeMtime > info.mtimeMs } : {}) };
}

/** The media section. */
export function readMedia(paths: ProjectPaths): ProjectView["media"] {
  const codeMtime = newestMtime(path.join(paths.rootDir, "src", "projects", paths.id));
  const found: { relative: string; mtime: number }[] = [];
  const walk = (directory: string, prefix: string, depth: number) => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory() && depth < 2 && !SKIP_DIRS.has(entry.name))
        walk(path.join(directory, entry.name), relative, depth + 1);
      else if (entry.isFile() && VIDEO.test(entry.name))
        found.push({ relative, mtime: statOf(path.join(directory, entry.name))?.mtimeMs ?? 0 });
    }
  };
  walk(paths.outDir, "", 0);
  found.sort((a, b) => b.mtime - a.mtime || a.relative.localeCompare(b.relative));
  const finals = new Set(["film.mp4", ...FORMATS.map((format) => `${format}.mp4`)]);
  const labelOf = (relative: string) =>
    relative === "film.mp4"
      ? "Film"
      : relative === "animatic.mp4"
        ? "Animatic"
        : finals.has(relative)
          ? `${relative.replace(/\.mp4$/, "")} render`
          : relative.slice(0, 160);
  // The film's composition id (pipeline/build.json, written at the build step) on its full renders, for "Open in Studio".
  const build = readJsonFile(path.join(paths.projectDir, "pipeline", "build.json")) as
    { composition?: unknown } | undefined;
  const composition =
    typeof build?.composition === "string" && build.composition.trim()
      ? build.composition.trim().slice(0, 128)
      : undefined;
  const refs = found
    .slice(0, MAX_RENDERS + 2)
    .map((item) => renderRef(paths, item.relative, labelOf(item.relative), codeMtime))
    .filter((ref): ref is MediaRef => !!ref)
    .map((ref) => (composition && finals.has(ref.path) ? { ...ref, composition } : ref));
  const latestRender = refs.find((ref) => finals.has(ref.path));
  const animatic = refs.find((ref) => ref.path === "animatic.mp4");
  const renders = refs.filter((ref) => ref !== latestRender && ref !== animatic).slice(0, MAX_RENDERS);
  return {
    ...(latestRender ? { latestRender } : {}),
    ...(animatic ? { animatic } : {}),
    ...(renders.length ? { renders } : {}),
  };
}
