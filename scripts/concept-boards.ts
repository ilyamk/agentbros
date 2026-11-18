/**
 * Concept boards: cheap stills of each idea's hook, turn and last frame, rendered from motion library blocks with the
 * props the board author chose. Reads pipeline/concept-boards.json, writes pipeline/boards/<id>-<role>.jpg and the
 * contact sheet pipeline/boards/boards.jpg (one row per idea). --plan-only validates and prints the plan without rendering.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { renderStill, selectComposition } from "@remotion/renderer";
import { CliErrorObject, emitProgress, ensureFfmpeg, parseArgs, runScript } from "../src/lib/cli";
import { openExistingFilm } from "../src/lib/film/cli";
import { compositionId } from "../src/lib/library/paths";
import { GL_CHOICES, withComposition } from "../src/lib/vision/composition";
import { BACKGROUND, RgbImage } from "../src/lib/vision/image";
import { composeGrid, type Cell } from "../src/lib/vision/sheets";
import type { LibraryFormat, LibraryItem } from "../src/motion/library/types";
import { BOARD_ROLES, ConceptBoardsSchema, StrategySchema } from "../src/types/studio";

const DEFAULT_AT: Record<(typeof BOARD_ROLES)[number], number> = { hook: 0.35, turn: 0.55, last: 0.75 };
const TILE_WIDTH = 360;
const REPO_ROOT = path.resolve(import.meta.dirname, "..");

/** A category's own preview root bundles only its items; resolved in the repository, whatever the working directory. */
function entryFor(category: string): string {
  const own = path.join(REPO_ROOT, "src/motion/library", category, "preview.tsx");
  return existsSync(own) ? own : path.join(REPO_ROOT, "src/motion/library/index.tsx");
}

type Planned = {
  candidate: string;
  role: (typeof BOARD_ROLES)[number];
  item: LibraryItem;
  format: LibraryFormat;
  composition: string;
  props: Record<string, unknown>;
  at: number;
  caption: string;
  output: string;
};

function ffmpeg(args: string[], input?: Buffer): Buffer {
  const result = spawnSync("ffmpeg", ["-v", "error", "-nostdin", ...args], { input, maxBuffer: 64 * 1024 * 1024 });
  if (result.error || result.status !== 0)
    throw new CliErrorObject({
      code: "FFMPEG_FAILED",
      message: `ffmpeg failed: ${result.error?.message ?? result.stderr?.toString().trim().slice(-400)}`,
    });
  return result.stdout;
}

function tile(file: string, width: number, height: number): RgbImage {
  const pad = BACKGROUND.map((value) => value.toString(16).padStart(2, "0")).join("");
  return new RgbImage(
    width,
    height,
    ffmpeg([
      "-i",
      file,
      "-vf",
      `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=0x${pad}`,
      "-frames:v",
      "1",
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgb24",
      "pipe:1",
    ]),
  );
}

function blank(width: number, height: number): RgbImage {
  const image = new RgbImage(width, height);
  for (let index = 0; index < width * height; index++) image.data.set(BACKGROUND, index * 3);
  return image;
}

const writeJpeg = (image: RgbImage, output: string) =>
  ffmpeg(
    [
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgb24",
      "-s",
      `${image.width}x${image.height}`,
      "-i",
      "pipe:0",
      "-frames:v",
      "1",
      "-update",
      "1",
      "-q:v",
      "4",
      "-y",
      output,
    ],
    image.data,
  );

void runScript(async () => {
  const args = parseArgs([
    { name: "project", required: true, description: "Project ID" },
    {
      name: "plan-only",
      type: "boolean",
      description: "Validate the boards and print what would be rendered, without rendering",
    },
    { name: "public-dir", default: "public", description: "Public directory served to the compositions" },
    { name: "gl", choices: GL_CHOICES, default: "angle", description: "Chromium GL backend" },
  ] as const);
  const project = openExistingFilm(args.project!);
  const pipeline = path.join(project.projectDir, "pipeline");
  const boardsFile = path.join(pipeline, "concept-boards.json");
  if (!existsSync(boardsFile))
    throw new CliErrorObject({
      code: "FILE_NOT_FOUND",
      message: `No boards to render: write ${path.relative(process.cwd(), boardsFile)} first.`,
    });
  const parsed = ConceptBoardsSchema.safeParse(JSON.parse(readFileSync(boardsFile, "utf8")));
  if (!parsed.success)
    throw new CliErrorObject({
      code: "VALIDATION",
      message: `concept-boards.json: ${parsed.error.issues[0]?.path.join(".")}: ${parsed.error.issues[0]?.message}`,
    });
  const strategy = StrategySchema.safeParse(
    existsSync(path.join(pipeline, "strategy.json"))
      ? JSON.parse(readFileSync(path.join(pipeline, "strategy.json"), "utf8"))
      : undefined,
  );
  const wanted: LibraryFormat = strategy.success ? strategy.data.platform.aspect : "vertical";

  const { loadLibrary } = await import("../src/lib/library/load");
  const { items } = await loadLibrary();
  const problems: string[] = [];
  const plan: Planned[] = [];
  for (const candidate of parsed.data.candidates) {
    const roles = candidate.frames.map((frame) => frame.role);
    for (const role of ["hook", "last"] as const)
      if (!roles.includes(role)) problems.push(`${candidate.id}: no ${role} frame`);
    if (new Set(roles).size !== roles.length) problems.push(`${candidate.id}: a role appears twice`);
    for (const frame of candidate.frames) {
      const item = items.find((entry) => entry.id === frame.itemId);
      if (!item) {
        problems.push(`${candidate.id} ${frame.role}: unknown library item "${frame.itemId}"; run library:list`);
        continue;
      }
      const props = item.schema.safeParse({ ...item.defaultProps, ...frame.props });
      if (!props.success)
        problems.push(
          `${candidate.id} ${frame.role}: props for ${item.id}: ${props.error.issues[0]?.path.join(".") || "root"}: ${props.error.issues[0]?.message}`,
        );
      const shape = (item.schema as { shape?: Record<string, unknown> }).shape;
      const unknown = shape ? Object.keys(frame.props).filter((key) => !(key in shape)) : [];
      if (unknown.length)
        problems.push(
          `${candidate.id} ${frame.role}: ${item.id} has no prop ${unknown.join(", ")}; its props: ${Object.keys(shape!).join(", ")}`,
        );
      const format = item.formats.includes(wanted) ? wanted : item.formats[0]!;
      plan.push({
        candidate: candidate.id,
        role: frame.role,
        item,
        format,
        composition: compositionId(item.id, format),
        props: { ...item.defaultProps, ...frame.props },
        at: frame.at ?? DEFAULT_AT[frame.role],
        caption: frame.caption,
        output: path.join(pipeline, "boards", `${candidate.id}-${frame.role}.jpg`),
      });
    }
  }
  if (problems.length) throw new CliErrorObject({ code: "VALIDATION", message: problems.join("; ") });
  const relative = (file: string) => path.relative(process.cwd(), file);
  const sheet = path.join(pipeline, "boards", "boards.jpg");
  const summary = plan.map((entry) => ({
    candidate: entry.candidate,
    role: entry.role,
    itemId: entry.item.id,
    composition: entry.composition,
    at: entry.at,
    output: relative(entry.output),
  }));
  if (args["plan-only"])
    return { metadata: { projectId: project.id, planOnly: true, frames: summary, sheet: relative(sheet) } };

  ensureFfmpeg();
  mkdirSync(path.dirname(sheet), { recursive: true });
  const stillsDir = mkdtempSync(path.join(tmpdir(), "concept-boards-"));
  try {
    const byEntry = new Map<string, Planned[]>();
    for (const entry of plan)
      byEntry.set(entryFor(entry.item.category), [...(byEntry.get(entryFor(entry.item.category)) ?? []), entry]);
    for (const [entry, group] of byEntry) {
      await withComposition(
        { entry, composition: group[0]!.composition, publicDir: args["public-dir"]!, gl: args.gl! },
        async ({ serveUrl, browser, chromiumOptions }) => {
          for (const frame of group) {
            emitProgress(`Board ${frame.candidate} ${frame.role}: ${frame.composition}`);
            const composition = await selectComposition({
              serveUrl,
              id: frame.composition,
              inputProps: frame.props,
              puppeteerInstance: browser,
              chromiumOptions,
              logLevel: "error",
            });
            const still = path.join(stillsDir, `${frame.candidate}-${frame.role}.png`);
            await renderStill({
              serveUrl,
              composition,
              frame: Math.min(
                composition.durationInFrames - 1,
                Math.round((composition.durationInFrames - 1) * frame.at),
              ),
              output: still,
              imageFormat: "png",
              overwrite: true,
              inputProps: frame.props,
              puppeteerInstance: browser,
              chromiumOptions,
              logLevel: "error",
            });
            ffmpeg(["-i", still, "-frames:v", "1", "-update", "1", "-q:v", "3", "-y", frame.output]);
          }
        },
      );
    }
    const height = Math.round(TILE_WIDTH * (wanted === "vertical" ? 16 / 9 : wanted === "square" ? 1 : 9 / 16));
    const cells: Cell[] = parsed.data.candidates.flatMap((candidate) =>
      BOARD_ROLES.map((role) => {
        const frame = plan.find((entry) => entry.candidate === candidate.id && entry.role === role);
        return frame
          ? {
              image: tile(frame.output, TILE_WIDTH, height),
              label: `${candidate.id} ${role.toUpperCase()}`,
              caption: frame.caption,
            }
          : { image: blank(TILE_WIDTH, height), label: `${candidate.id} ${role.toUpperCase()}`, caption: "no frame" };
      }),
    );
    writeJpeg(composeGrid(cells, { title: `concept boards: ${project.id}`, columns: BOARD_ROLES.length }), sheet);
  } finally {
    rmSync(stillsDir, { recursive: true, force: true });
  }
  return {
    outputs: [...plan.map((entry) => relative(entry.output)), relative(sheet)],
    metadata: { projectId: project.id, frames: summary, sheet: relative(sheet) },
  };
});
