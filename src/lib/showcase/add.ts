import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { assertPathWithin, CliErrorObject, ensureFfmpeg, ensureFfprobe, requireProject } from "../cli";
import { hashFile } from "../assets/registry";
import { generationInputHash } from "../jobs/runner";
import { listUsage } from "../library/usage";
import { probeVideo } from "../vision/media";
import { readProjectPlaybook } from "../playbooks/project";
import { prMarkdown } from "../contrib/pr";
import { DeliverySnapshotSchema, RenderReceiptSchema } from "../../types/delivery";
import {
  ShowcaseDraftSchema,
  ShowcaseSchema,
  ShowcaseReleaseAssetsSchema,
  ShowcaseSlugSchema,
  type Showcase,
} from "../../types/showcase";
import { ContributorHandleSchema, ContributorSchema } from "../../types/contributor";
import { assertPublic, jsonFiles, optionalJson, stripExportPaths, stripPaths, writeJson } from "./data";
import { projectFacts } from "./report";

const text = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? stripPaths(value.trim()) : null;
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

export function renderShowcaseMedia(input: string, directory: string, duration: number): string[] {
  ensureFfmpeg();
  mkdirSync(directory, { recursive: true });
  const files = ["thumbnail.jpg", "contact-sheet.jpg", "preview.mp4"].map((name) => path.join(directory, name));
  const run = (args: string[]) => {
    const result = spawnSync("ffmpeg", ["-v", "error", "-nostdin", "-n", ...args], {
      encoding: "utf8",
      timeout: 120000,
      maxBuffer: 1024 * 1024,
    });
    if (result.error || result.status !== 0)
      throw new CliErrorObject({
        code: "FFMPEG_FAILED",
        message: `Showcase media generation failed: ${stripPaths(result.error?.message ?? result.stderr.slice(-600))}`,
      });
  };
  run(["-i", input, "-frames:v", "1", "-vf", "scale=1280:-2", "-q:v", "2", files[0]!]);
  run([
    "-i",
    input,
    "-vf",
    `fps=${6 / duration},scale=426:-2,tile=3x2:nb_frames=6:padding=4:margin=4`,
    "-frames:v",
    "1",
    "-q:v",
    "2",
    files[1]!,
  ]);
  run([
    "-i",
    input,
    "-t",
    String(Math.min(10, duration)),
    "-map",
    "0:v:0",
    "-an",
    "-sn",
    "-dn",
    "-map_metadata",
    "-1",
    "-vf",
    "scale=1280:-2",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
    files[2]!,
  ]);
  return files;
}

/** A full renderer receipt must match the file and a checksum-valid captured identity. */
function receiptEvidence(project: string, render: string, renderHash: string, format: Showcase["format"]) {
  const evidence: Showcase["evidence"] = { renderHash, deliveryReceiptHash: null, snapshotId: null };
  let raw: unknown;
  try {
    raw = optionalJson(`${render}.receipt.json`);
  } catch {
    return evidence;
  }
  const parsed = RenderReceiptSchema.safeParse(raw);
  if (
    !parsed.success ||
    parsed.data.partial ||
    parsed.data.evidence !== "renderer" ||
    parsed.data.outputSha256 !== renderHash ||
    parsed.data.format !== format
  )
    return evidence;
  const receipt = parsed.data;
  for (const file of jsonFiles(path.join("public/projects", project, "pipeline/delivery/snapshots"))) {
    let rawSnapshot: unknown;
    try {
      rawSnapshot = optionalJson(file);
    } catch {
      continue;
    }
    const snapshot = DeliverySnapshotSchema.safeParse(rawSnapshot);
    if (!snapshot.success || snapshot.data.projectId !== project) continue;
    const { id, createdAt: _createdAt, ...basis } = snapshot.data;
    if (generationInputHash(basis) !== id) continue;
    if (
      !snapshot.data.identities.some(
        (identity) =>
          identity.projectId === project &&
          identity.sourceSnapshotHash === receipt.sourceSnapshotHash &&
          identity.propsHash === receipt.propsHash &&
          identity.format === receipt.format &&
          identity.captions === receipt.captions &&
          generationInputHash({ sources: identity.sources }) === generationInputHash({ sources: receipt.sources }),
      )
    )
      continue;
    return { ...evidence, deliveryReceiptHash: hashFile(`${render}.receipt.json`), snapshotId: id };
  }
  return evidence;
}

export interface AddShowcaseOptions {
  project: string;
  slug: string;
  author: string;
  link?: string;
  out?: string;
  harness?: "claude-code" | "codex";
  model?: string;
  rights?: string;
  licence?: string;
  skipMedia?: boolean;
}
export function addShowcase(options: AddShowcaseOptions) {
  requireProject(options.project);
  ShowcaseSlugSchema.parse(options.slug);
  const handle = ContributorHandleSchema.parse(options.author.replace(/^@/, ""));
  const root = process.cwd(),
    projectDir = path.join("public/projects", options.project),
    output = path.resolve(options.out ?? "showcases", options.slug, "showcase.json");
  assertPathWithin(path.resolve(options.out ?? "showcases"), output);
  if (existsSync(output))
    throw new CliErrorObject({
      code: "FILE_EXISTS",
      message: "Showcase entry already exists; review it before editing.",
    });
  const mediaDir = path.join("out", options.project, "showcase");
  assertPathWithin(path.resolve("out", options.project), path.resolve(mediaDir));
  if (!options.skipMedia && existsSync(mediaDir))
    throw new CliErrorObject({
      code: "FILE_EXISTS",
      message: "Showcase media directory already exists; choose whether to retain it before rerunning.",
    });
  const brief = record(optionalJson(path.join(projectDir, "pipeline/brief.json"))),
    config = record(optionalJson(path.join(projectDir, "project.json")));
  const renderCandidates = [
    path.join("out", options.project, "film.mp4"),
    path.join("out", options.project, "vertical.mp4"),
    path.join("out", options.project, "landscape.mp4"),
    path.join("out", options.project, "square.mp4"),
  ];
  const render = renderCandidates.find((file) => existsSync(file));
  if (!render)
    throw new CliErrorObject({
      code: "FILE_NOT_FOUND",
      message: "No rendered MP4 in the project output; render the film first.",
    });
  assertPathWithin(path.resolve("out", options.project), path.resolve(render));
  ensureFfmpeg();
  ensureFfprobe();
  const info = probeVideo(render),
    format = info.width === info.height ? "square" : info.width > info.height ? "landscape" : "vertical";
  const facts = projectFacts(options.project),
    binding = readProjectPlaybook(projectDir),
    plan = record(optionalJson(path.join(projectDir, "pipeline/motion-plan.json")));
  const profileRaw = optionalJson(path.join("community/contributors", `${handle}.json`));
  const profile = profileRaw === undefined ? undefined : ContributorSchema.parse(profileRaw);
  const version = spawnSync("git", ["describe", "--tags", "--always"], { encoding: "utf8" });
  if (version.status !== 0 || !version.stdout.trim())
    throw new CliErrorObject({
      code: "VALIDATION",
      message: "Cannot establish harness version with git describe --tags --always.",
    });
  const evidence = receiptEvidence(options.project, render, hashFile(render), format);
  const shots = Array.isArray(plan.shots) ? plan.shots.map(record) : [];
  const music = record(optionalJson(path.join(projectDir, "pipeline/music-decision.json")));
  const entry = ShowcaseDraftSchema.parse(
    stripExportPaths({
      schemaVersion: 1,
      slug: options.slug,
      createdAt: new Date().toISOString(),
      title: (text(brief.title) ?? text(brief.productName) ?? text(config.name) ?? options.slug).slice(0, 160),
      summary: (
        text(brief.summary) ??
        text(brief.idea) ??
        text(brief.topic) ??
        "Contributor showcase; description pending author review."
      ).slice(0, 2000),
      language: text(brief.language) ?? text(config.language),
      format,
      durationSec: info.durationSec,
      playbook: binding?.id ?? null,
      route: text(brief.renderMode),
      filmType: text(brief.filmType),
      libraryBlocks:
        listUsage()
          .records.find((row) => row.projectId === options.project)
          ?.blocks.map((row) => row.id) ?? [],
      harness: options.harness ?? facts.harness,
      model: options.model ?? text(brief.model),
      harnessVersion: version.stdout.trim(),
      wallTimeMin: facts.wallTimeMin,
      rounds: facts.rounds,
      userInterventions: facts.userInterventions,
      budget: facts.spend,
      settings: {
        briefExcerpt: (text(brief.idea) ?? text(brief.summary) ?? text(brief.topic) ?? "").slice(0, 2000),
        musicRoute: text(music.route),
        voice: text(record(brief.voice).id) ?? text(brief.voice) ?? text(config.voice),
        references:
          Array.isArray(brief.references) && brief.references.length
            ? [{ kind: "reference", count: brief.references.length }]
            : [],
        motionPlanChoices: shots
          .slice(0, 20)
          .map((shot) =>
            [text(shot.camera), text(shot.curve), text(shot.transitionToNext)].filter(Boolean).join("; ").slice(0, 300),
          ),
      },
      author: {
        handle,
        displayName: profile?.displayName ?? handle,
        links: profile?.links ?? [],
        credits: profile?.credits ?? "",
      },
      links: options.link ? [options.link] : [],
      rights: options.rights ?? null,
      licence: options.licence ?? null,
      evidence,
      mediaSources: [],
      verification: evidence.deliveryReceiptHash ? "receipt" : "declared",
    }),
  );
  assertPublic(entry, root);
  const prBody = prMarkdown(
    {
      category: "showcase",
      size: "S",
      autonomy: "assisted",
      harness: entry.harness ?? "other",
      model: entry.model ?? "undeclared",
      owner: handle,
      change: `.changes/showcase-${options.slug}.md`,
    },
    `Add ${entry.title}.\n\nVerification: ${entry.verification}. Render SHA-256: ${evidence.renderHash}.`,
    "Share a film and its declared production settings.",
    "Author must review rights, entry licence, missing declarations and media before submission. Upload thumbnail.jpg, contact-sheet.jpg and preview.mp4 from out/<project>/showcase/ as GitHub PR or issue attachments. Paste their HTTPS URLs into mediaSources as { kind: thumbnail|contactSheet|preview, url } entries. Do not commit media. Create the named change entry and run contrib:check; nothing is sent.",
  );
  assertPublic(prBody, root);
  const media = options.skipMedia ? [] : renderShowcaseMedia(render, mediaDir, info.durationSec);
  mkdirSync(path.dirname(output), { recursive: true });
  writeFileSync(output, JSON.stringify(entry, null, 2) + "\n", { flag: "wx" });
  return { outputs: [output, ...media], metadata: { entry, prBody, mediaGenerated: !options.skipMedia } };
}

export function updateShowcaseMedia(entryFile: string, releaseAssets: unknown) {
  const entry = ShowcaseSchema.parse(optionalJson(entryFile));
  const assets = ShowcaseReleaseAssetsSchema.parse(releaseAssets);
  const names = { thumbnail: "thumbnail.jpg", contactSheet: "contact-sheet.jpg", preview: "preview.mp4" } as const;
  const media = { ...entry.media };
  for (const [key, name] of Object.entries(names) as [keyof typeof names, string][]) {
    const pattern = new RegExp(`^${entry.slug}-([a-f0-9]{64})-${name.replace(".", "\\.")}$`);
    const matches = assets.filter((asset) => typeof asset.name === "string" && pattern.test(asset.name));
    if (matches.length > 1) {
      if (matches.some((asset) => asset.url === entry.media?.[key])) continue;
      throw new CliErrorObject({
        code: "VALIDATION",
        message: `Ambiguous ${name} release assets; retain the reviewed URL or supply a single asset.`,
      });
    }
    const asset = matches[0];
    if (asset) {
      if (asset.url !== `https://github.com/ilyamk/agentbros/releases/download/showcase-media/${asset.name}`)
        throw new CliErrorObject({
          code: "VALIDATION",
          message: "Media URL must be an agentbros showcase-media release asset.",
        });
      media[key] = asset.url;
    }
  }
  if (!Object.keys(media).length) return { updated: false, entry };
  const updated = ShowcaseSchema.parse({ ...entry, media });
  assertPublic(updated, process.cwd());
  writeJson(entryFile, updated);
  return { updated: true, entry: updated };
}
