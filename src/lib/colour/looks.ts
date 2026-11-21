import type { z } from "zod";
import { LookSchema, type Look } from "../../types/colour";

/**
 * Starting looks for `colour:looks`: genre treatments described by what they do to tone, colour and skin, built
 * from the grade model's own controls. None reproduces a specific title's LUT or a named film stock. Vectorscope
 * angles: red 103°, skin line 123°, yellow 175°, green 230°, teal about 260°, cyan 283°, blue 355°, magenta 50°.
 * Every look carries a skin policy: `colour:looks` solves a skin secondary per frame so the look moves the world
 * and leaves faces within the policy, and the gate reports what the look did to skin, levels and saturation.
 */
const RAW: z.input<typeof LookSchema>[] = [
  {
    id: "clean-natural",
    name: "Clean natural",
    family: "technical",
    intent: "Neutral balance: true whites, honest skin, gentle contrast. The base every other look starts from.",
    typicalUse: "documentary, interviews, corporate, product truth shots, the first pass before any look",
    moves: ["neutral grey axis", "slight S-contrast", "highlight roll-off", "saturation almost untouched"],
    skin: { mode: "hold", chroma: 1, hueAllowance: 4, lightness: 0, warm: false },
    risks: ["reads flat on low-contrast generated footage", "shows every mismatch between shots"],
    mood: { valence: 0.1, arousal: 0.0 },
    palette: { scheme: "neutral", keyHues: [] },
    finish: "clean",
    grade: { contrast: { amount: 1.06, pivot: 0.435 }, saturation: 1.03, softClip: { high: 0.95 } },
  },
  {
    id: "teal-orange",
    name: "Teal and orange",
    family: "film",
    intent: "Complementary separation: the world goes teal, faces stay warm, so the subject pops off the background.",
    typicalUse: "action and blockbuster films, trailers, high-energy ads",
    moves: [
      "shadows pushed to teal",
      "highlights slightly warm",
      "blues and cyans rotated toward teal",
      "skin held warm",
    ],
    skin: { mode: "hold", chroma: 1.08, hueAllowance: 6, lightness: 0, warm: false },
    risks: [
      "orange skin when pushed: keep skin on the 123° line",
      "turns real blue skies and logos teal",
      "cliché if the film has no reason for it",
    ],
    mood: { valence: 0.15, arousal: 0.55 },
    palette: { scheme: "complementary", keyHues: ["teal", "skin/orange"] },
    finish: "filmic",
    grade: {
      lift: [-0.012, 0.004, 0.022],
      gain: [1.03, 1.0, 0.965],
      contrast: { amount: 1.12, pivot: 0.435 },
      saturation: 1.05,
      secondaries: [
        {
          name: "world to teal",
          qualifier: {
            hue: { center: 300, width: 110, softness: 25 },
            saturation: { min: 0.05, max: 2, softness: 0.04 },
          },
          hueToward: { angle: 262, amount: 0.55 },
          hueShift: 0,
          saturation: 1.12,
          luma: 0,
          strength: 1,
        },
      ],
      softClip: { high: 0.93 },
    },
  },
  {
    id: "cool-thriller",
    name: "Cool thriller",
    family: "film",
    intent: "Cold, controlled, uneasy: low saturation, green-cyan shadows, dense blacks.",
    typicalUse: "thrillers, crime and tech drama, serious brand films",
    moves: [
      "saturation down about a quarter",
      "green-cyan shadows",
      "cooler mids",
      "firmer contrast",
      "skin muted, never green",
    ],
    skin: { mode: "hold", chroma: 0.8, hueAllowance: 6, lightness: -2, warm: false },
    risks: ["sickly green skin if the shadow tint reaches faces", "crushed blacks on dark generated footage"],
    mood: { valence: -0.45, arousal: 0.35 },
    palette: { scheme: "analogous", keyHues: ["cyan", "teal"] },
    finish: "filmic",
    grade: {
      lift: [-0.012, 0.004, 0.006],
      gamma: [0.99, 1.015, 1.02],
      gain: [0.97, 1.0, 1.0],
      contrast: { amount: 1.16, pivot: 0.435 },
      saturation: 0.75,
      softClip: { high: 0.94 },
    },
  },
  {
    id: "bleach-bypass",
    name: "Bleach bypass",
    family: "film",
    intent: "Silver-retention feel: hard contrast, washed-out colour, metallic highlights; gritty and physical.",
    typicalUse: "war, sport, gritty action, music videos with a raw edge",
    moves: [
      "saturation about half",
      "strong contrast around a slightly raised pivot",
      "highlights rolled off, not clipped",
    ],
    skin: { mode: "hold", chroma: 0.6, hueAllowance: 6, lightness: 0, warm: false },
    risks: ["grey, lifeless skin", "noise and compression blocks become visible", "clipped skies"],
    mood: { valence: -0.5, arousal: 0.4 },
    palette: { scheme: "monochrome", keyHues: [] },
    finish: "tactile",
    grade: {
      contrast: { amount: 1.35, pivot: 0.45 },
      saturation: 0.55,
      softClip: { high: 0.92, low: 0.02 },
    },
  },
  {
    id: "warm-print",
    name: "Warm print film",
    family: "film",
    intent:
      "The feel of a projected print: rich warm mids, soft shoulder, slightly lifted dense blacks, restrained colour.",
    typicalUse: "drama, period pieces, prestige ads, storytelling brand films",
    moves: [
      "S-curve with a soft shoulder",
      "blacks lifted a touch and kept dense",
      "warm highlights, neutral shadows",
      "saturation slightly down",
    ],
    skin: { mode: "hold", chroma: 1.02, hueAllowance: 6, lightness: 0, warm: false },
    risks: ["muddy blacks on low-key footage", "yellow skin if the warmth goes into the mids"],
    mood: { valence: 0.35, arousal: 0.0 },
    palette: { scheme: "analogous", keyHues: ["skin/orange", "yellow"] },
    finish: "filmic",
    grade: {
      lift: [0.012, 0.008, 0.004],
      gain: [1.02, 1.0, 0.955],
      curves: {
        master: [
          [0, 0.015],
          [0.2, 0.17],
          [0.5, 0.52],
          [0.8, 0.84],
          [1, 0.96],
        ],
      },
      saturation: 0.93,
      softClip: { high: 0.92 },
    },
  },
  {
    id: "golden-hour",
    name: "Golden hour",
    family: "commercial",
    intent: "Late-sun warmth: honeyed light, glowing skin, soft contrast; optimistic and intimate.",
    typicalUse: "lifestyle and travel ads, romance, real estate, food",
    moves: ["white balance warmer", "highlights to gold", "gentle contrast", "skin allowed warmer"],
    skin: { mode: "hold", chroma: 1.12, hueAllowance: 10, lightness: 0, warm: true },
    risks: ["orange skin", "everything the same colour: no separation", "fake on night or overcast footage"],
    mood: { valence: 0.7, arousal: 0.25 },
    palette: { scheme: "analogous", keyHues: ["skin/orange", "yellow"] },
    finish: "filmic",
    grade: {
      whiteBalance: { temperature: 0.45, tint: 0.05 },
      gain: [1.03, 1.0, 0.95],
      contrast: { amount: 0.97, pivot: 0.435 },
      saturation: 1.06,
      softClip: { high: 0.93 },
    },
  },
  {
    id: "moonlight-night",
    name: "Moonlight night",
    family: "film",
    intent: "Day-for-night style moonlight: darker, blue, desaturated; faces stay readable.",
    typicalUse: "night scenes, horror, mystery, moody product reveals",
    moves: ["exposure down about two thirds of a stop", "cool white balance", "saturation down", "skin muted"],
    skin: { mode: "hold", chroma: 0.65, hueAllowance: 12, lightness: -4, warm: false },
    risks: ["blue faces", "crushed detail in shadows", "noise in lifted areas"],
    mood: { valence: -0.35, arousal: -0.35 },
    palette: { scheme: "monochrome", keyHues: ["blue"] },
    finish: "filmic",
    grade: {
      exposure: -0.65,
      whiteBalance: { temperature: -0.6, tint: 0 },
      contrast: { amount: 1.08, pivot: 0.4 },
      saturation: 0.7,
      softClip: { high: 0.94 },
    },
  },
  {
    id: "high-key-commercial",
    name: "High-key commercial",
    family: "commercial",
    intent: "Bright, clean, aspirational: open shadows, clean whites, colour that sells the product.",
    typicalUse: "tech and app ads, beauty, retail, explainer films",
    moves: ["exposure up a quarter stop", "shadows opened", "lower contrast", "saturation slightly up", "skin clean"],
    skin: { mode: "hold", chroma: 1, hueAllowance: 4, lightness: 2, warm: false },
    risks: ["clipped whites", "flat, video-like image", "milky blacks"],
    mood: { valence: 0.75, arousal: 0.2 },
    palette: { scheme: "neutral", keyHues: [] },
    finish: "clean",
    grade: {
      exposure: 0.25,
      lift: [0.015, 0.015, 0.015],
      contrast: { amount: 0.95, pivot: 0.435 },
      saturation: 1.08,
      softClip: { high: 0.95 },
    },
  },
  {
    id: "beauty-soft",
    name: "Beauty soft",
    family: "commercial",
    intent: "Flattering and gentle: soft contrast, peachy even skin, pastel surroundings.",
    typicalUse: "cosmetics, fashion, wedding, wellness",
    moves: ["lower contrast", "lifted blacks", "slightly lower saturation", "skin pulled to the skin line"],
    skin: { mode: "hold", chroma: 0.95, hueAllowance: 4, lightness: 2, warm: false },
    risks: ["plastic, waxy skin", "no depth", "dull on dark footage"],
    mood: { valence: 0.6, arousal: -0.3 },
    palette: { scheme: "analogous", keyHues: ["skin/orange", "red"] },
    finish: "clean",
    grade: {
      lift: [0.03, 0.025, 0.025],
      contrast: { amount: 0.9, pivot: 0.45 },
      saturation: 0.95,
      softClip: { high: 0.93 },
    },
  },
  {
    id: "neon-music-video",
    name: "Neon music video",
    family: "music-video",
    intent: "Electric and graphic: deep blacks, saturated magenta-cyan split, skin still human.",
    typicalUse: "music videos, nightlife, gaming, streetwear",
    moves: ["strong contrast and crushed toe", "saturation up", "blues pushed toward violet-magenta", "cyan boosted"],
    skin: { mode: "hold", chroma: 1.1, hueAllowance: 8, lightness: 0, warm: false },
    risks: ["magenta skin", "illegal chroma and blocking on compressed delivery", "tiring over a long film"],
    mood: { valence: 0.05, arousal: 0.9 },
    palette: { scheme: "complementary", keyHues: ["magenta", "cyan"] },
    finish: "tactile",
    grade: {
      lift: [-0.02, -0.025, -0.01],
      contrast: { amount: 1.18, pivot: 0.42 },
      saturation: 1.05,
      secondaries: [
        {
          name: "blues to violet",
          qualifier: {
            hue: { center: 355, width: 60, softness: 20 },
            saturation: { min: 0.06, max: 2, softness: 0.04 },
          },
          hueShift: 30,
          saturation: 1.05,
          luma: 0,
          strength: 1,
        },
        {
          name: "cyan boost",
          qualifier: {
            hue: { center: 283, width: 50, softness: 20 },
            saturation: { min: 0.06, max: 2, softness: 0.04 },
          },
          hueShift: 0,
          saturation: 1.12,
          luma: 0.02,
          strength: 1,
        },
      ],
      softClip: { high: 0.93 },
    },
  },
  {
    id: "faded-vintage",
    name: "Faded vintage",
    family: "music-video",
    intent: "Matte, nostalgic, a little sun-faded: milky blacks, soft whites, warm low-saturation colour.",
    typicalUse: "indie music videos, lifestyle social content, retro brand stories",
    moves: [
      "black point lifted to a matte",
      "white point lowered",
      "saturation down a fifth",
      "warm cast in the highlights",
    ],
    skin: { mode: "hold", chroma: 0.9, hueAllowance: 6, lightness: 0, warm: false },
    risks: ["looks like a filter preset", "washed-out on already low-contrast footage"],
    mood: { valence: 0.2, arousal: -0.55 },
    palette: { scheme: "analogous", keyHues: ["yellow", "teal"] },
    finish: "tactile",
    grade: {
      gain: [1.02, 1.0, 0.95],
      curves: {
        master: [
          [0, 0.07],
          [0.25, 0.27],
          [0.75, 0.76],
          [1, 0.93],
        ],
      },
      saturation: 0.8,
    },
  },
  {
    id: "tech-teal-lowkey",
    name: "Low-key tech teal",
    family: "film",
    intent:
      "Dark, cool interface-lab mood: faces low-key and desaturated, environment teal-cyan, practical lights glowing.",
    typicalUse: "sci-fi and tech films, product launches with holograms or screens, cyber themes",
    moves: [
      "exposure down a third of a stop",
      "firm contrast",
      "blues rotated to teal-cyan and enriched",
      "skin muted and a little darker",
    ],
    skin: { mode: "hold", chroma: 0.75, hueAllowance: 8, lightness: -4, warm: false },
    risks: ["grey or green faces", "shadow noise", "monochrome look with no warm accent"],
    mood: { valence: -0.25, arousal: 0.15 },
    palette: { scheme: "monochrome", keyHues: ["teal"] },
    finish: "filmic",
    grade: {
      exposure: -0.35,
      lift: [-0.012, 0.006, 0.016],
      contrast: { amount: 1.15, pivot: 0.42 },
      saturation: 0.92,
      secondaries: [
        {
          name: "world to teal-cyan",
          qualifier: {
            hue: { center: 315, width: 100, softness: 25 },
            saturation: { min: 0.05, max: 2, softness: 0.04 },
          },
          hueToward: { angle: 278, amount: 0.6 },
          hueShift: 0,
          saturation: 1.2,
          luma: 0,
          strength: 1,
        },
      ],
      softClip: { high: 0.93 },
    },
  },
];

export const LOOKS: readonly Look[] = RAW.map((look) => LookSchema.parse(look));

/** Six looks that differ most from one another: the default grid. */
export const DEFAULT_LOOKS = [
  "clean-natural",
  "teal-orange",
  "warm-print",
  "cool-thriller",
  "high-key-commercial",
  "neon-music-video",
] as const;

/** Looks nearest to a mood (valence, arousal), closest first: a starting shortlist, not a verdict. */
export function looksForMood(mood: { valence: number; arousal: number }, count = 6): Look[] {
  const distance = (look: Look) => Math.hypot(look.mood.valence - mood.valence, look.mood.arousal - mood.arousal);
  return [...LOOKS].sort((a, b) => distance(a) - distance(b) || a.id.localeCompare(b.id)).slice(0, count);
}

export function findLook(id: string): Look | undefined {
  return LOOKS.find((look) => look.id === id);
}
