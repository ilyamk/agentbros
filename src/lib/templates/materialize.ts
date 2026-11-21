import { writeExperiments } from "../experiments/project";
import { existsSync, mkdirSync, writeFileSync, renameSync, rmSync, openSync, closeSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { assertPathWithin, CliErrorObject, validateProjectId } from "../cli";
import { validatePublicAsset } from "../render-plan";
import { typography, spacing } from "../design-tokens";
import type { RecipeRequest } from "../../types/recipes";
import { buildRecipe } from "./recipes";
const esc = (value: string) =>
  value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** New project only. project.json is published last as the atomic draft commit marker. */
export function materializeRecipe(input: RecipeRequest, rootDir = process.cwd()) {
  const plan = buildRecipe(input);
  validateProjectId(plan.request.projectId);
  const base = path.resolve(rootDir, "public/projects"),
    final = path.join(base, plan.request.projectId);
  assertPathWithin(rootDir, base);
  assertPathWithin(base, final);
  if (existsSync(final))
    throw new CliErrorObject({
      code: "FILE_EXISTS",
      message: "Recipe target project already exists; create a new draft ID to preserve existing work.",
    });
  for (const scene of plan.project.scenes) {
    if (scene.imageUrl) validatePublicAsset(scene.imageUrl, rootDir);
    const template = scene.template;
    if (
      template &&
      "imageUrl" in template.props &&
      template.props.imageUrl !== `projects/${plan.request.projectId}/assets/animatic/${scene.id}.svg`
    )
      validatePublicAsset(template.props.imageUrl, rootDir);
  }
  mkdirSync(base, { recursive: true });
  const staging = path.join(base, `.${plan.request.projectId}-${randomUUID()}.tmp`);
  const placeholders: string[] = [];
  const lock = path.join(base, `.${plan.request.projectId}.recipe.lock`);
  let lockFd: number;
  try {
    lockFd = openSync(lock, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new CliErrorObject({
        code: "TIMEOUT",
        message: "Recipe target is locked by another writer.",
      });
    throw error;
  }
  try {
    mkdirSync(path.join(staging, "pipeline"), { recursive: true });
    mkdirSync(path.join(staging, "assets/animatic"), { recursive: true });
    for (const [index, scene] of plan.project.scenes.entries()) {
      if (
        scene.imageUrl ||
        (scene.template &&
          "imageUrl" in scene.template.props &&
          scene.template.props.imageUrl !== `projects/${plan.request.projectId}/assets/animatic/${scene.id}.svg`)
      )
        continue;
      const filename = `${scene.id}.svg`;
      const headline = scene.headline ?? scene.id;
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1080" viewBox="0 0 1080 1080"><rect width="1080" height="1080" fill="${esc(plan.project.colors.background)}"/><rect x="${spacing.sidePadding.square}" y="${spacing.safeTop.square}" width="${1080 - spacing.sidePadding.square * 2}" height="${1080 - spacing.safeTop.square - spacing.safeBottom.square}" rx="28" fill="${esc(plan.project.colors.accent)}" opacity="0.14"/><text x="540" y="420" text-anchor="middle" fill="${esc(plan.project.colors.text)}" font-family="system-ui,sans-serif" font-size="${typography.bigTitle.square.fontSize}" font-weight="${typography.bigTitle.square.fontWeight}">SHOT ${index + 1}</text><text x="540" y="530" text-anchor="middle" fill="${esc(plan.project.colors.text)}" font-family="system-ui,sans-serif" font-size="${typography.subtext.square.fontSize}">APPROVED VISUAL NEEDED</text><text x="540" y="590" text-anchor="middle" fill="${esc(plan.project.colors.text)}" font-family="system-ui,sans-serif" font-size="${typography.small.square.fontSize}">${esc(scene.id)}</text></svg>`;
      writeFileSync(path.join(staging, "assets/animatic", filename), svg, {
        flag: "wx",
      });
      placeholders.push(`projects/${plan.request.projectId}/assets/animatic/${filename}`);
      // Keep the typographic template editable, backed by a visual draft placeholder.
      scene.visualType = "photo";
      scene.imageUrl = placeholders.at(-1);
      scene.headline = headline;
    }
    writeFileSync(path.join(staging, "project.json"), `${JSON.stringify(plan.project, null, 2)}\n`, { flag: "wx" });
    if (plan.request.experiment) writeExperiments(staging, [{ id: plan.request.experiment, started: true }]);
    const recipeMetadata = {
      schemaVersion: 1,
      request: plan.request,
      ...(plan.proofs ? { proofs: plan.proofs, proofGuidance: plan.proofGuidance } : {}),
      durationInFrames: plan.durationInFrames,
      productionReady: false,
      findings: plan.findings,
      placeholders,
      beatPurposes: plan.beatPurposes,
      nextAction: "Replace placeholders, supply/approve script and audio, then production QA",
    };
    writeFileSync(path.join(staging, "pipeline/recipe.json"), `${JSON.stringify(recipeMetadata, null, 2)}\n`, {
      flag: "wx",
    });
    const cards = plan.project.scenes
      .map(
        (scene) =>
          `<article><h2>${esc(scene.id)}</h2><p>${esc(scene.headline ?? "")}</p><p>${esc(plan.beatPurposes[scene.id])}</p><p>${scene.durationInFrames} frames · ${esc(scene.transitionToNext ?? "fade")}</p>${scene.imageUrl && !/^https?:/.test(scene.imageUrl) ? `<a href="${esc(path.relative(final, path.resolve(rootDir, "public", scene.imageUrl)))}">Visual source</a>` : "<p>Template / external visual</p>"}<p>${esc(scene.text || "Script required")}</p></article>`,
      )
      .join("\n");
    writeFileSync(
      path.join(staging, "animatic.html"),
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Animatic ${esc(plan.request.topic)}</title><style>body{font:16px system-ui;margin:32px;background:#f8f8fa}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:20px}article{padding:20px;border-radius:12px;background:white}</style></head><body><h1>${esc(plan.request.topic)} — draft animatic</h1><p>Not production ready. ${plan.durationInFrames} frames at 30 fps. ${plan.project.formats.map(esc).join(", ")}</p><section class="grid">${cards}</section></body></html>`,
      { flag: "wx" },
    );
    if (existsSync(final))
      throw new CliErrorObject({
        code: "FILE_EXISTS",
        message: "Recipe project was created by another writer.",
      });
    // Exclusive reservation cannot replace even an empty directory created by another writer.
    try {
      mkdirSync(final);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST")
        throw new CliErrorObject({
          code: "FILE_EXISTS",
          message: "Recipe target already exists.",
        });
      throw error;
    }
    for (const child of ["assets", "pipeline", "animatic.html", "project.json"])
      renameSync(path.join(staging, child), path.join(final, child));
    rmSync(staging, { recursive: true });
    return {
      ...plan,
      placeholders,
      outputs: [
        path.relative(rootDir, path.join(final, "project.json")),
        path.relative(rootDir, path.join(final, "pipeline/recipe.json")),
        path.relative(rootDir, path.join(final, "animatic.html")),
      ],
    };
  } catch (error) {
    if (existsSync(staging)) rmSync(staging, { recursive: true, force: true });
    throw error;
  } finally {
    closeSync(lockFd);
    unlinkSync(lock);
  }
}
