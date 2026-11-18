import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { requireUserWords } from "../src/lib/cli/user-words";
import path from "node:path";
import {
  CliErrorObject,
  emitProgress,
  ensureFfmpeg,
  ensureFfprobe,
  parseArgs,
  requireProject,
  runScript,
} from "../src/lib/cli";
import { acquireMusic } from "../src/lib/music/acquire";
import { MusicHttp } from "../src/lib/music/http";
import { cutMusic } from "../src/lib/film/music-cut";
import { buildMusicOptions, recordMusicDecision } from "../src/lib/music/options";
import { extractReferenceAudio } from "../src/lib/music/reference";
import { checkProjectMusicRights } from "../src/lib/music/rights-guard";
import { parseMusicBrief } from "../src/lib/music/fit";
import { analyseSearch, searchFreeStock } from "../src/lib/music/search";
import { stitchCue } from "../src/lib/music/stitch";
import { findMusicCandidate } from "../src/lib/music/rights-guard";
import { buildShortlist } from "../src/lib/music/shortlist";
import { searchTrending } from "../src/lib/music/trending";
import { MUSIC_PATHS } from "../src/lib/music/types";
import { DEFAULT_LIBRARY_ROOT, referenceDirectory } from "../src/lib/reference/library";
import type { MusicCut } from "../src/types/film";
import { ReferenceSourceSchema } from "../src/types/reference";

const ACTIONS = [
  "options",
  "record",
  "search",
  "trending",
  "from-reference",
  "shortlist",
  "acquire",
  "stitch",
  "check",
] as const;
const SPECS = [
  {
    name: "action",
    required: true,
    choices: ACTIONS,
    description: "options | record | search | trending | from-reference | shortlist | acquire | stitch | check",
  },
  { name: "project", description: "Project ID" },
  { name: "reference", description: "Reference ID in the library (options, from-reference)" },
  { name: "library-root", default: DEFAULT_LIBRARY_ROOT, description: "Reference library directory" },
  { name: "route", description: "Music route (record) or free-stock (search)" },
  { name: "answer", description: "record: the user's own words" },
  { name: "reason", description: "record: why this route serves the film" },
  { name: "question", description: "record: the question asked, when no options file exists" },
  {
    name: "delivery",
    choices: ["embedded", "native-on-platform", "study-only", "none"],
    description: "record: delivery, defaulted from the route",
  },
  { name: "candidate", description: "record, acquire: candidate ID" },
  { name: "credit", description: "record: the on-film credit" },
  { name: "query", description: "search: what to look for" },
  { name: "mood", description: "search: mood words" },
  { name: "min-duration", type: "number", description: "search: shortest track in seconds" },
  {
    name: "bpm",
    type: "number",
    description: 'search, stitch: target tempo. Also read from --query text such as "140 BPM"',
  },
  {
    name: "bpm-tolerance",
    type: "number",
    description: "search: allowed BPM distance (default 6); half and double tempo count with a penalty",
  },
  {
    name: "duration",
    type: "number",
    description: "search, stitch: cue length in seconds. record: the excerpt's length (default: the shortlist brief's)",
  },
  {
    name: "drop-at",
    type: "number",
    description: "search, stitch: seconds into the cue where the energy should arrive",
  },
  { name: "intro", choices: ["quiet", "full"], description: "search: the cue's opening" },
  { name: "ending", choices: ["hard", "fade"], description: "search, stitch: the cue's ending" },
  {
    name: "analyse",
    type: "boolean",
    description: "search: download previews and measure tempo, energy, drop and ending (needs --project)",
  },
  { name: "analyse-top", type: "number", description: "search: how many ranked candidates to measure (default 10)" },
  { name: "music-file", type: "boolean", description: "acquire: also copy the original to music/stock-<id>.<ext>" },
  { name: "input", description: "stitch: a local loop file, instead of --candidate" },
  {
    name: "start",
    type: "number",
    description:
      "stitch: seconds into the source where the loop starts. record: where the film's excerpt starts (default: the shortlist fit's offset)",
  },
  {
    name: "cut-file",
    description: "record: a file inside the project that already is the film's excerpt (e.g. from stitch), used as is",
  },
  {
    name: "commercial",
    type: "boolean",
    description: "search: keep only licences that allow commercial sync. acquire: require commercial use",
  },
  { name: "limit", type: "number", description: "search, trending: rows per provider or list (default 12)" },
  {
    name: "market",
    default: "us",
    description: "trending: two-letter country for Apple's chart. Deezer's chart is global",
  },
  { name: "names", description: 'trending: names pasted by the user, "Artist - Title; Artist - Title"' },
  { name: "from", description: "shortlist: search JSON files, comma separated" },
  { name: "top", type: "number", description: "shortlist: how many to take from each file (default 3)" },
  { name: "brief", description: "options, shortlist: what the film is, in a sentence" },
  {
    name: "rights",
    choices: ["owned", "licensed"],
    description: "from-reference: what the user states about the track's rights",
  },
  { name: "rights-note", description: "from-reference: the user's statement, in their words" },
  { name: "source-file", description: "acquire: a file the user downloaded from the source page" },
  {
    name: "confirm-licence-url",
    description: "acquire: licence page a person checked for this track, when the source has no adapter",
  },
  { name: "accept-share-alike", type: "boolean", description: "acquire: the user accepts ShareAlike for the film" },
  { name: "output", description: "search, trending: JSON path. Defaults to the project's pipeline/music" },
] as const;

const credentials = () => ({
  freesound: process.env.FREESOUND_API_KEY,
  freesoundOAuth: process.env.FREESOUND_OAUTH_TOKEN,
  jamendo: process.env.JAMENDO_CLIENT_ID,
});

function needProject(project: string | undefined): string {
  if (!project) throw new CliErrorObject({ code: "INVALID_INPUT", message: "This action needs --project." });
  requireProject(project);
  return path.resolve("public/projects", project);
}

function writeJson(file: string, value: unknown): string {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
  return file;
}

void runScript(async () => {
  const args = parseArgs(SPECS);
  const http = new MusicHttp();
  const limit = args.limit || 12;
  const destination = (fallback: string) => {
    if (args.output) return path.resolve(args.output);
    return path.join(needProject(args.project), fallback);
  };

  if (args.action === "options") {
    const projectDir = args.project ? needProject(args.project) : undefined;
    const briefPath = projectDir && path.join(projectDir, "pipeline/brief.json");
    const brief =
      briefPath && existsSync(briefPath)
        ? (JSON.parse(readFileSync(briefPath, "utf8")) as Record<string, unknown>)
        : args.brief
          ? { topic: args.brief }
          : undefined;
    // Options only need the rights and the probe: a reference's media may not be on this machine.
    const reference = args.reference
      ? ReferenceSourceSchema.parse(
          JSON.parse(
            readFileSync(path.join(referenceDirectory(args["library-root"]!, args.reference), "source.json"), "utf8"),
          ),
        )
      : undefined;
    const options = buildMusicOptions({
      ...(brief ? { brief } : {}),
      ...(reference
        ? {
            referenceId: reference.referenceId,
            referenceRights: reference.rights,
            hasReferenceAudio: reference.probe.hasAudio,
          }
        : {}),
      env: process.env,
    });
    const outputs = projectDir ? [writeJson(path.join(projectDir, MUSIC_PATHS.options), options)] : [];
    return { outputs, metadata: options };
  }

  if (args.action === "record") {
    if (!args.route || !args.answer || !args.reason)
      throw new CliErrorObject({
        code: "INVALID_INPUT",
        message: "record needs --route, --answer with the user's own words, and --reason.",
      });
    requireUserWords(args.answer, "--answer");
    const projectDir = needProject(args.project);
    let cut: MusicCut | undefined;
    if (args.route !== "silence" && args.candidate) {
      ensureFfmpeg();
      ensureFfprobe();
      cut = cutMusic(projectDir, {
        candidateId: args.candidate,
        ...(args.start !== undefined ? { startSec: args.start } : {}),
        ...(args.duration ? { durationSec: args.duration } : {}),
        ...(args["cut-file"] ? { cutFile: args["cut-file"] } : {}),
      });
    }
    const result = recordMusicDecision(projectDir, {
      route: args.route,
      answer: args.answer,
      reason: args.reason,
      delivery: args.delivery,
      candidateId: args.candidate,
      credit: args.credit,
      question: args.question,
      ...(cut ? { cut } : {}),
    });
    return {
      outputs: [result.target, ...(cut ? [path.join(projectDir, cut.file)] : [])],
      metadata: {
        decision: result.decision,
        ...(cut ? { cut } : {}),
        findings: result.findings,
        blocked: result.findings.some((item) => item.severity === "error"),
      },
    };
  }

  if (args.action === "search") {
    if (args.route && args.route !== "free-stock")
      throw new CliErrorObject({
        code: "INVALID_INPUT",
        message: "search covers --route free-stock. Use --action trending for charts.",
      });
    if (!args.query) throw new CliErrorObject({ code: "INVALID_INPUT", message: "search needs --query." });
    const brief = parseMusicBrief(`${args.query} ${args.mood ?? ""}`, {
      bpm: args.bpm,
      bpmTolerance: args["bpm-tolerance"],
      durationSec: args.duration,
      dropAtSec: args["drop-at"],
      intro: args.intro as "quiet" | "full" | undefined,
      ending: args.ending as "hard" | "fade" | undefined,
    });
    const query = {
      query: args.query,
      ...(args.mood ? { mood: args.mood } : {}),
      ...(args["min-duration"] ? { minDurationSec: args["min-duration"] } : {}),
      commercial: args.commercial,
      limit,
      brief,
    };
    let result = await searchFreeStock(http, query, credentials());
    for (const status of result.providers)
      emitProgress(
        `${status.provider}: ${status.status}, ${status.count}${status.message ? ` (${status.message})` : ""}`,
      );
    let analysis: { analysed: number; failures: { id: string; reason: string }[] } | undefined;
    if (args.analyse) {
      ensureFfmpeg();
      const measured = await analyseSearch(http, needProject(args.project), result, query, args["analyse-top"] || 10);
      result = { ...measured.file, manualRoutes: result.manualRoutes };
      analysis = { analysed: measured.analysed, failures: measured.failures };
    }
    const target = writeJson(destination(MUSIC_PATHS.searchFreeStock), result);
    const candidates = result.candidates.map(
      ({
        id,
        title,
        creator,
        provider,
        licence,
        durationSec,
        score,
        why,
        fit,
        acquisition,
        previewPath,
        audioMapPath,
        sourceUrl,
      }) => ({
        id,
        title,
        creator,
        provider,
        licence: licence.code,
        commercial: licence.commercial,
        durationSec,
        score,
        acquisition,
        sourceUrl,
        previewPath,
        audioMapPath,
        fit,
        why,
      }),
    );
    return {
      outputs: [target],
      metadata: {
        brief,
        providers: result.providers,
        excluded: result.excluded,
        ...(analysis ? { analysis } : {}),
        candidates,
        manualRoutes: result.manualRoutes,
        ...(args.analyse ? { notice: "Measurements only: agents cannot hear. The user chooses by ear." } : {}),
      },
    };
  }

  if (args.action === "trending") {
    const result = await searchTrending(http, {
      market: args.market!,
      limit,
      ...(args.names ? { names: args.names } : {}),
    });
    const target = writeJson(destination(MUSIC_PATHS.searchTrending), result);
    return { outputs: [target], metadata: result };
  }

  if (args.action === "from-reference") {
    if (!args.reference)
      throw new CliErrorObject({ code: "INVALID_INPUT", message: "from-reference needs --reference." });
    ensureFfmpeg();
    const result = extractReferenceAudio(needProject(args.project), args.reference, args["library-root"]!, {
      rights: args.rights as "owned" | "licensed" | undefined,
      note: args["rights-note"],
      commercial: args.commercial,
    });
    return {
      outputs: [result.wav, result.searchFile],
      metadata: { candidate: result.candidate, delivery: result.delivery, embeddingBlocked: result.embeddingBlocked },
    };
  }

  if (args.action === "shortlist") {
    if (!args.from)
      throw new CliErrorObject({
        code: "INVALID_INPUT",
        message: "shortlist needs --from with one or more search JSON files.",
      });
    ensureFfmpeg();
    ensureFfprobe();
    const result = await buildShortlist(http, needProject(args.project), {
      from: args.from.split(",").map((item) => path.resolve(item.trim())),
      top: args.top || 3,
      ...(args.brief ? { brief: args.brief } : {}),
    });
    return {
      outputs: [
        result.target,
        ...(result.fitPath ? [result.fitPath] : []),
        ...(result.contactSheet ? [result.contactSheet] : []),
        ...result.listen.map((item) => item.file),
      ],
      metadata: {
        notice: result.notice,
        listen: result.listen,
        fits: result.fits,
        contactSheet: result.contactSheet,
        skipped: result.skipped,
        audioMaps: result.audioMaps,
      },
    };
  }

  if (args.action === "acquire") {
    if (!args.candidate) throw new CliErrorObject({ code: "INVALID_INPUT", message: "acquire needs --candidate." });
    needProject(args.project);
    const result = await acquireMusic({
      projectId: args.project!,
      candidateId: args.candidate,
      commercial: args.commercial,
      acceptShareAlike: args["accept-share-alike"],
      ...(args["source-file"] ? { sourceFile: path.resolve(args["source-file"]) } : {}),
      ...(args["confirm-licence-url"] ? { confirmLicenceUrl: args["confirm-licence-url"] } : {}),
      musicFile: args["music-file"],
      http,
      credentials: credentials(),
    });
    return {
      outputs: [
        path.resolve("public/projects", args.project!, result.originalPath),
        ...(result.musicFile ? [path.resolve("public/projects", args.project!, result.musicFile)] : []),
        result.receiptPath,
        result.credits,
      ],
      metadata: result,
    };
  }

  if (args.action === "stitch") {
    if (!args.duration || args["drop-at"] === undefined)
      throw new CliErrorObject({ code: "INVALID_INPUT", message: "stitch needs --duration and --drop-at." });
    ensureFfmpeg();
    const projectDir = needProject(args.project);
    let source = args.input ? path.resolve(args.input) : undefined,
      candidate: ReturnType<typeof findMusicCandidate>;
    if (!source) {
      if (!args.candidate)
        throw new CliErrorObject({ code: "INVALID_INPUT", message: "stitch needs --input or --candidate." });
      candidate = findMusicCandidate(projectDir, args.candidate);
      if (!candidate)
        throw new CliErrorObject({
          code: "FILE_NOT_FOUND",
          message: `Candidate ${args.candidate} is in no pipeline/music/search-*.json file.`,
        });
      if (!candidate.syncAllowed)
        throw new CliErrorObject({
          code: "VALIDATION",
          message: `${candidate.licence.code} does not allow adaptation, so ${candidate.id} cannot be stitched.`,
        });
      const file = candidate.originalPath ?? candidate.previewPath;
      if (!file)
        throw new CliErrorObject({
          code: "FILE_NOT_FOUND",
          message: `${candidate.id} has no local file. Acquire it, or run search with --analyse to fetch its preview.`,
        });
      source = path.join(projectDir, file);
    }
    const name = candidate
      ? `stitched-${candidate.id
          .replace(/[^a-zA-Z0-9]+/g, "-")
          .toLowerCase()
          .slice(0, 50)}.mp3`
      : `stitched-${path.basename(source).replace(/\.[^.]+$/, "")}.mp3`;
    const result = stitchCue({
      source,
      output: path.join(projectDir, "music", name),
      durationSec: args.duration,
      dropAtSec: args["drop-at"]!,
      ...(args.bpm ? { bpm: args.bpm } : {}),
      ending: (args.ending as "hard" | "fade" | undefined) ?? "hard",
      ...(args.start ? { startSec: args.start } : {}),
    });
    return {
      outputs: [result.output, result.recordPath],
      metadata: {
        ...result,
        ...(candidate
          ? {
              candidate: {
                id: candidate.id,
                licence: candidate.licence.code,
                attribution: candidate.licence.attribution,
                previewOnly: !candidate.originalPath,
              },
            }
          : {}),
      },
    };
  }

  const findings = checkProjectMusicRights(needProject(args.project), { decisionRequired: true });
  return { metadata: { findings, blocked: findings.some((item) => item.severity === "error") } };
});
