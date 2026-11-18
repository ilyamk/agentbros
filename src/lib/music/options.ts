import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { z } from "zod";
import { MusicDecisionSchema, type MusicCut, type MusicDecision, MusicRouteSchema } from "../../types/film";
import type { ReferenceSource } from "../../types/reference";
import { CliErrorObject } from "../cli";
import { findMusicCandidate, musicRights } from "./rights-guard";
import { MUSIC_PATHS } from "./types";

type MusicRoute = z.infer<typeof MusicRouteSchema>;
export type RouteOption = {
  route: MusicRoute;
  label: string;
  means: string;
  rights: string;
  delivery: MusicDecision["delivery"];
  connected: { status: "ready" | "partial" | "not-connected"; detail: string };
  cost: string;
  recommended: boolean;
};
export type OptionsInput = {
  brief?: Record<string, unknown>;
  referenceRights?: ReferenceSource["rights"];
  referenceId?: string;
  hasReferenceAudio?: boolean;
  env: Record<string, string | undefined>;
};

const social = /\b(tiktok|reels?|shorts)\b/i;
const advert = /\b(ad|ads|advert|advertising|paid|campaign)\b/i;

export function recommendRoute(input: OptionsInput): { route: MusicRoute; because: string } {
  const status = input.referenceRights?.status;
  if (input.hasReferenceAudio && (status === "owned" || status === "licensed"))
    return { route: "reference-track", because: `the reference track's rights are recorded as ${status}` };
  const text = JSON.stringify(input.brief ?? {});
  if (social.test(text) && !advert.test(text))
    return {
      route: "trending-native",
      because: "the brief is organic short-form social, where a native sound helps reach",
    };
  return {
    route: "free-stock",
    because: "it gives you a real, finished track with its licence stated per track, at no cost",
  };
}

export function buildMusicOptions(input: OptionsInput) {
  const { env } = input;
  const rightsStatus = input.referenceRights?.status ?? "unknown";
  const cleared = rightsStatus === "owned" || rightsStatus === "licensed";
  const stockDetail = [
    "Openverse, ccMixter, Internet Archive and Incompetech need no key",
    env.FREESOUND_API_KEY ? "Freesound is connected" : "Freesound is not connected (FREESOUND_API_KEY)",
    env.JAMENDO_CLIENT_ID
      ? "Jamendo is connected, non-commercial tier"
      : "Jamendo is not connected (JAMENDO_CLIENT_ID)",
    "Pixabay Music, YouTube Audio Library, NCS and ende.app are manual imports",
  ].join("; ");
  const recommended = recommendRoute(input);
  const routes: Omit<RouteOption, "recommended">[] = [
    {
      route: "reference-track",
      label: "The track from the reference",
      means: "Extract the reference film's audio and cut to it.",
      rights: cleared
        ? `Recorded as ${rightsStatus}. Tell me if that is wrong.`
        : `Recorded as ${rightsStatus}. Usable for study only, and embedding stays blocked until you state who holds the rights.`,
      delivery: cleared ? "embedded" : "study-only",
      connected: !input.referenceId
        ? { status: "not-connected", detail: "No reference was given." }
        : input.hasReferenceAudio === false
          ? { status: "not-connected", detail: `Reference ${input.referenceId} has no audio stream.` }
          : { status: "ready", detail: `Reference ${input.referenceId}.` },
      cost: "Free.",
    },
    {
      route: "free-stock",
      label: "Free stock music",
      means: "I search open catalogues and give you a shortlist to choose from by ear.",
      rights:
        "Licence stated per track. Many need a credit in the film; non-commercial, no-derivatives and unknown licences are blocked for a commercial film.",
      delivery: "embedded",
      connected: { status: "ready", detail: stockDetail },
      cost: "Free.",
    },
    {
      route: "trending-native",
      label: "Trending music, added on the platform",
      means:
        "I read a chart track's 30 s preview for rhythm and cut to it. The film ships without the track and you add the sound in the app. The charts are general popularity from Deezer and Apple, not TikTok's own list, unless you paste names from TikTok.",
      rights:
        "We hold no licence and never embed it. The platform's own terms apply; business accounts are often limited to a commercial library, so check before running it as an ad.",
      delivery: "native-on-platform",
      connected: {
        status: "ready",
        detail:
          "Deezer and Apple charts need no key. TikTok Creative Center has no open API; paste names from it with --names.",
      },
      cost: "Free.",
    },
    {
      route: "generated",
      label: "Generated music",
      means: "ElevenLabs composes a track to a written brief, with one section per part of the film.",
      rights: "Governed by the ElevenLabs plan on this account. Check that the plan allows commercial use.",
      delivery: "embedded",
      connected: env.ELEVENLABS_API_KEY
        ? { status: "ready", detail: "ElevenLabs is connected." }
        : { status: "not-connected", detail: "ELEVENLABS_API_KEY is not set." },
      cost: "Paid per generation. The price is not known in advance, so generate:music takes a --max-cost-usd bound that you approve.",
    },
    {
      route: "user-supplied",
      label: "Your own track",
      means: "You give me a file and I import it with the rights you state.",
      rights: "Rests on your statement. I record who holds the rights in your words.",
      delivery: "embedded",
      connected: { status: "ready", detail: "Send a file path." },
      cost: "Whatever you paid.",
    },
    {
      route: "synth",
      label: "A synthesised bed",
      means: "A simple bed built by hand from synthesised tones. Clean but plain, not a composed piece of music.",
      rights: "No third-party rights.",
      delivery: "embedded",
      connected: {
        status: "partial",
        detail:
          "This repository only synthesises one-shot effects today (audio:editorial --action sfx). A bed has to be written for this film, which takes extra work.",
      },
      cost: "Free.",
    },
    {
      route: "silence",
      label: "No music",
      means: "Sound design only. Tell me why silence serves this film.",
      rights: "None needed.",
      delivery: "none",
      connected: { status: "ready", detail: "Nothing to connect." },
      cost: "Free.",
    },
  ];
  const withFlag: RouteOption[] = routes.map((item) => ({ ...item, recommended: item.route === recommended.route }));
  const lines = withFlag.map(
    (item, index) =>
      `${index + 1}. ${item.label}${item.recommended ? " (my recommendation)" : ""}. ${item.means} Rights: ${item.rights} Available: ${item.connected.detail} Cost: ${item.cost}`,
  );
  const question = [
    `Where should this film's music come from? I recommend "${withFlag.find((item) => item.recommended)!.label}" because ${recommended.because}.`,
    ...lines,
    "Which do you want?",
  ].join("\n");
  return {
    question,
    askVerbatim: true,
    instruction:
      "Put this question to the user word for word. Do not pick a route yourself. Record the answer with music --action record.",
    recommended: recommended.route,
    routes: withFlag,
  };
}

const DEFAULT_DELIVERY: Record<MusicRoute, MusicDecision["delivery"]> = {
  "reference-track": "study-only",
  "free-stock": "embedded",
  "trending-native": "native-on-platform",
  generated: "embedded",
  "user-supplied": "embedded",
  synth: "embedded",
  silence: "none",
};

/** The question comes from the options file, so a route cannot be recorded without having been asked. */
export function recordMusicDecision(
  projectDir: string,
  input: {
    route: string;
    answer: string;
    reason: string;
    delivery?: string;
    candidateId?: string;
    credit?: string;
    question?: string;
    now?: string;
    cut?: MusicCut;
  },
) {
  const optionsPath = path.join(projectDir, MUSIC_PATHS.options);
  let question = input.question;
  if (!question && existsSync(optionsPath))
    question = (JSON.parse(readFileSync(optionsPath, "utf8")) as { question?: string }).question;
  if (!question)
    throw new CliErrorObject({
      code: "STAGE_INCOMPLETE",
      message: "The user has not been asked. Run music --action options and put its question to the user first.",
    });
  if (!input.answer.trim())
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "--answer must hold the user's own words." });
  const route = MusicRouteSchema.parse(input.route);
  const decision = MusicDecisionSchema.parse({
    schemaVersion: 1,
    askedUser: { question, answer: input.answer, at: input.now ?? new Date().toISOString() },
    route,
    ...(input.candidateId ? { candidateId: input.candidateId } : {}),
    delivery: input.delivery ?? DEFAULT_DELIVERY[route],
    reason: input.reason,
    ...(input.credit ? { credit: input.credit } : {}),
    ...(input.cut ? { cut: input.cut } : {}),
  });
  const findings = musicRights(
    decision,
    decision.candidateId ? findMusicCandidate(projectDir, decision.candidateId) : undefined,
  );
  const target = path.join(projectDir, MUSIC_PATHS.decision);
  mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(decision, null, 2)}\n`);
  renameSync(temporary, target);
  return { decision, target, findings };
}
