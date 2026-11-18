/**
 * The one registry of service keys a user may put in `.env`: what each unlocks,
 * what it costs, where to get it, and which goals it serves. `.env.example`
 * stays hand-written; tests/setup-keys.test.ts keeps the two in step, and the
 * doctor, `pnpm keys` and `pnpm bootstrap` read only this file.
 *
 * Values are never read beyond "set or not" and a shape check: nothing here
 * prints, logs or returns a key's value.
 */
import { splitHiggsfieldKey } from "../providers/higgsfield/credentials";

export type KeyCost = "paid" | "free";

export type SetupGoal =
  | "voiceover"
  | "music"
  | "sfx"
  | "transcription"
  | "speaker-diarisation"
  | "image-generation"
  | "video-generation"
  | "stock-media"
  | "3d-models"
  | "reference-download";

export interface EnvKey {
  name: string;
  /** Provider as a person knows it. */
  service: string;
  cost: KeyCost;
  /** What it unlocks, in the user's words. */
  unlocks: string;
  /** Where the user creates the key. */
  signup: string;
  goals: readonly SetupGoal[];
  /** Commented out in `.env.example` because the code has a public default. */
  commentedOut?: boolean;
  /** Keys that only work together, such as an OAuth client ID and secret. */
  pairedWith?: readonly string[];
}

export const ENV_KEYS: readonly EnvKey[] = [
  {
    name: "ELEVENLABS_API_KEY",
    service: "ElevenLabs",
    cost: "paid",
    unlocks: "voiceover, music, sound effects, transcription and caption alignment",
    signup: "https://elevenlabs.io (Profile → API Keys)",
    goals: ["voiceover", "music", "sfx", "transcription"],
  },
  {
    name: "FAL_KEY",
    service: "fal.ai",
    cost: "paid",
    unlocks: "image and video generation, music, upscaling, background removal",
    signup: "https://fal.ai/dashboard/keys",
    goals: ["image-generation", "video-generation", "music"],
  },
  {
    name: "HIGGSFIELD_API_KEY",
    service: "Higgsfield",
    cost: "paid",
    unlocks: "Higgsfield image and video models (Seedance, Kling, Genjutsu, Soul); value is <id>:<secret>",
    signup: "https://open.higgsfield.ai/api-keys",
    goals: ["image-generation", "video-generation"],
  },
  {
    name: "PEXELS_API_KEY",
    service: "Pexels",
    cost: "free",
    unlocks: "stock photos and video",
    signup: "https://www.pexels.com/api/new/",
    goals: ["stock-media"],
  },
  {
    name: "PIXABAY_API_KEY",
    service: "Pixabay",
    cost: "free",
    unlocks: "stock photos (1280 px without full API access), illustrations and video up to 4K",
    signup: "https://pixabay.com/api/docs/",
    goals: ["stock-media"],
  },
  {
    name: "UNSPLASH_ACCESS_KEY",
    service: "Unsplash",
    cost: "free",
    unlocks: "curated high-resolution stock photos (photos only)",
    signup: "https://unsplash.com/documentation#creating-a-developer-account",
    goals: ["stock-media"],
  },
  {
    name: "FREESOUND_API_KEY",
    service: "Freesound",
    cost: "free",
    unlocks: "sound effects and ambiences (previews)",
    signup: "https://freesound.org/apiv2/apply/",
    goals: ["sfx"],
  },
  {
    name: "FREESOUND_OAUTH_TOKEN",
    service: "Freesound",
    cost: "free",
    unlocks: "original-quality Freesound downloads (previews need only FREESOUND_API_KEY)",
    signup: "https://freesound.org/docs/api/authentication.html",
    goals: [],
  },
  {
    name: "JAMENDO_CLIENT_ID",
    service: "Jamendo",
    cost: "free",
    unlocks: "stock music search (free tier is non-commercial only)",
    signup: "https://devportal.jamendo.com",
    goals: ["music"],
  },
  {
    name: "OPENVERSE_ACCESS_TOKEN",
    service: "Openverse",
    cost: "free",
    unlocks: "higher Openverse rate limits (works anonymously without it)",
    signup: "https://docs.openverse.org/api/",
    goals: [],
  },
  {
    name: "OPENVERSE_CLIENT_ID",
    service: "Openverse",
    cost: "free",
    unlocks: "Openverse OAuth client (with OPENVERSE_CLIENT_SECRET)",
    signup: "https://docs.openverse.org/api/",
    goals: [],
    pairedWith: ["OPENVERSE_CLIENT_SECRET"],
  },
  {
    name: "OPENVERSE_CLIENT_SECRET",
    service: "Openverse",
    cost: "free",
    unlocks: "Openverse OAuth client (with OPENVERSE_CLIENT_ID)",
    signup: "https://docs.openverse.org/api/",
    goals: [],
    pairedWith: ["OPENVERSE_CLIENT_ID"],
  },
  {
    name: "POLY_PIZZA_API_KEY",
    service: "Poly Pizza",
    cost: "free",
    unlocks: "low-poly CC0 3D models in Blender catalogue search",
    signup: "https://poly.pizza (account → API)",
    goals: ["3d-models"],
  },
  {
    name: "SI_API_KEY",
    service: "Smithsonian Open Access",
    cost: "free",
    unlocks: "CC0 3D scans without the shared, rate-limited DEMO_KEY",
    signup: "https://api.data.gov/signup/",
    goals: ["3d-models"],
    commentedOut: true,
  },
  {
    name: "HF_TOKEN",
    service: "Hugging Face",
    cost: "free",
    unlocks: "gated open models: local speaker diarisation in speech:local",
    signup: "https://huggingface.co/settings/tokens (read token; accept the model's conditions first)",
    goals: ["speaker-diarisation"],
  },
  {
    name: "RAPIDAPI_KEY",
    service: "RapidAPI",
    cost: "paid",
    unlocks: "fallback download of public Instagram/TikTok references",
    signup: "https://rapidapi.com/coder2077/api/instagram-downloader-download-instagram-videos-stories1",
    goals: ["reference-download"],
  },
  {
    name: "APIFY_TOKEN",
    service: "Apify",
    cost: "paid",
    unlocks: "fallback download of public social references",
    signup: "https://console.apify.com/account/integrations",
    goals: ["reference-download"],
  },
];

export interface GoalSpec {
  id: SetupGoal;
  label: string;
  /** Any one of these keys makes the goal work. */
  anyOf: readonly string[];
  /** What works with no key at all; undefined when nothing does. */
  withoutKeys?: string;
}

export const SETUP_GOALS: readonly GoalSpec[] = [
  {
    id: "voiceover",
    label: "Generated voiceover",
    anyOf: ["ELEVENLABS_API_KEY"],
    withoutKeys: "the user's own recorded voice",
  },
  {
    id: "music",
    label: "Music (generated or stock)",
    anyOf: ["ELEVENLABS_API_KEY", "FAL_KEY", "JAMENDO_CLIENT_ID"],
    withoutKeys: "the user's own licensed track",
  },
  {
    id: "sfx",
    label: "Sound effects",
    anyOf: ["FREESOUND_API_KEY", "ELEVENLABS_API_KEY"],
    withoutKeys: "the bundled synthesised pack (pnpm sfx:synth)",
  },
  {
    id: "transcription",
    label: "Transcribing speech",
    anyOf: ["ELEVENLABS_API_KEY"],
    withoutKeys: "pnpm speech:local (free, on this machine, needs uv)",
  },
  {
    id: "speaker-diarisation",
    label: "Who speaks when (local)",
    anyOf: ["HF_TOKEN"],
  },
  {
    id: "image-generation",
    label: "AI image generation",
    anyOf: ["FAL_KEY", "HIGGSFIELD_API_KEY"],
    withoutKeys: "the user's own images, stock, or images imported from Codex/Claude (pnpm asset:import)",
  },
  {
    id: "video-generation",
    label: "AI video generation",
    anyOf: ["FAL_KEY", "HIGGSFIELD_API_KEY"],
    withoutKeys: "motion graphics built in code, the user's own footage, or stock",
  },
  {
    id: "stock-media",
    label: "Stock photos and video",
    anyOf: ["PEXELS_API_KEY", "PIXABAY_API_KEY", "UNSPLASH_ACCESS_KEY"],
    withoutKeys: "Openverse (anonymous, lower rate limit)",
  },
  {
    id: "3d-models",
    label: "3D model catalogues for Blender",
    anyOf: ["POLY_PIZZA_API_KEY", "SI_API_KEY"],
    withoutKeys: "Smithsonian with its public DEMO_KEY, or models the user downloads",
  },
  {
    id: "reference-download",
    label: "Downloading a reference video by link",
    anyOf: ["RAPIDAPI_KEY", "APIFY_TOKEN"],
    withoutKeys: "yt-dlp for YouTube and most public links (via uv)",
  },
];

export type KeyState = "set" | "unset" | "malformed" | "incomplete";

export interface KeyStatus {
  name: string;
  service: string;
  cost: KeyCost;
  unlocks: string;
  signup: string;
  goals: readonly SetupGoal[];
  state: KeyState;
}

const present = (env: NodeJS.ProcessEnv, name: string): boolean => !!env[name]?.trim();

/** Presence and shape only; the returned objects never carry a value. */
export function keyStatuses(env: NodeJS.ProcessEnv = process.env): KeyStatus[] {
  return ENV_KEYS.map((key) => {
    let state: KeyState = present(env, key.name) ? "set" : "unset";
    if (state === "set" && key.name === "HIGGSFIELD_API_KEY" && !splitHiggsfieldKey(env[key.name])) state = "malformed";
    if (state === "set" && key.pairedWith?.some((other) => !present(env, other))) state = "incomplete";
    return {
      name: key.name,
      service: key.service,
      cost: key.cost,
      unlocks: key.unlocks,
      signup: key.signup,
      goals: key.goals,
      state,
    };
  });
}

export interface GoalStatus {
  id: SetupGoal;
  label: string;
  ready: boolean;
  /** Keys that are set and usable for this goal. */
  via: string[];
  /** Keys the user could add, cheapest first. */
  options: { name: string; service: string; cost: KeyCost; signup: string }[];
  withoutKeys?: string;
}

export function goalStatuses(statuses: readonly KeyStatus[], only?: readonly SetupGoal[]): GoalStatus[] {
  const byName = new Map(statuses.map((status) => [status.name, status]));
  return SETUP_GOALS.filter((goal) => !only?.length || only.includes(goal.id)).map((goal) => {
    const candidates = goal.anyOf.map((name) => byName.get(name)).filter((s): s is KeyStatus => !!s);
    const via = candidates.filter((s) => s.state === "set").map((s) => s.name);
    const options = candidates
      .filter((s) => s.state !== "set")
      .sort((a, b) => (a.cost === b.cost ? 0 : a.cost === "free" ? -1 : 1))
      .map((s) => ({ name: s.name, service: s.service, cost: s.cost, signup: s.signup }));
    return {
      id: goal.id,
      label: goal.label,
      ready: via.length > 0,
      via,
      options,
      ...(goal.withoutKeys ? { withoutKeys: goal.withoutKeys } : {}),
    };
  });
}

export function parseGoals(value: string | undefined): SetupGoal[] {
  if (!value?.trim()) return [];
  const known = new Set(SETUP_GOALS.map((goal) => goal.id));
  const goals = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const unknown = goals.filter((goal) => !known.has(goal as SetupGoal));
  if (unknown.length) throw new Error(`Unknown goal(s): ${unknown.join(", ")}. Known: ${[...known].join(", ")}`);
  return goals as SetupGoal[];
}

/** Key names written in sections 1–5 of `.env.example` (before "Local settings"), set or commented out. */
export function envExampleKeys(text: string): { name: string; commentedOut: boolean }[] {
  const cut = text.search(/^#\s*\d+\.\s*Local settings/m);
  const body = cut < 0 ? text : text.slice(0, cut);
  const keys: { name: string; commentedOut: boolean }[] = [];
  for (const match of body.matchAll(/^(#\s*)?([A-Z][A-Z0-9_]+)=/gm))
    keys.push({ name: match[2]!, commentedOut: !!match[1] });
  return keys;
}

export function formatKeys(statuses: readonly KeyStatus[], goals: readonly GoalStatus[]): string {
  const lines = ["", "Service keys (values are never shown):", ""];
  for (const key of statuses)
    lines.push(`  ${key.state.padEnd(10)} ${key.name.padEnd(24)} [${key.cost}] ${key.unlocks}`);
  lines.push("", "By goal:", "");
  for (const goal of goals) {
    const head = `  ${goal.ready ? "ready " : "needs "} ${goal.label}`;
    if (goal.ready) lines.push(`${head} (via ${goal.via.join(", ")})`);
    else {
      lines.push(`${head}: add one of ${goal.options.map((o) => `${o.name} [${o.cost}]`).join(", ")}`);
      if (goal.withoutKeys) lines.push(`         or without a key: ${goal.withoutKeys}`);
    }
  }
  lines.push("", "Add keys by editing .env yourself; never paste a key into an agent chat.", "");
  return lines.join("\n");
}
