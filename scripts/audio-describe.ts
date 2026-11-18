import path from "node:path";
import { ensureFfmpeg, parseArgs, requireFile, runScript } from "../src/lib/cli";
import {
  CLAP_MODEL,
  DESCRIPTORS,
  descriptorPrompt,
  GENRES,
  genrePrompt,
  MOODS,
  moodPrompt,
  relativeTags,
  runClap,
  SFX_LABELS,
  sfxTagsFromScores,
} from "../src/lib/audio/sfx-clap";

const SPECS = [
  { name: "input", required: true, description: "Any audio or video file (music, SFX, voice)" },
  { name: "top", type: "number", default: 5, description: "Tags per group" },
  {
    name: "labels",
    description: 'Extra comma-separated prompts to score, e.g. "warm hopeful piano,cold industrial drone"',
  },
  { name: "clap-model", default: CLAP_MODEL, description: "Hugging Face CLAP model id" },
] as const;

void runScript(async () => {
  const args = parseArgs(SPECS);
  requireFile(args.input!);
  ensureFfmpeg();
  const extra = (args.labels ?? "")
    .split(",")
    .map((label) => label.trim())
    .filter(Boolean);
  const labels = [...SFX_LABELS, ...MOODS.map(moodPrompt), ...GENRES.map(genrePrompt), ...extra];
  const input = path.resolve(args.input!);
  const result = runClap({ audio: [input], labels, model: args["clap-model"] });
  const item = result.audio[input];
  if (!item?.labelScores) throw new Error(item?.error ?? "CLAP returned no scores");
  const scores = item.labelScores;
  const sfxCount = SFX_LABELS.length;
  const top = args.top!;
  const sfx = sfxTagsFromScores(scores.slice(0, sfxCount));
  const moods = relativeTags(MOODS, scores.slice(sfxCount, sfxCount + MOODS.length), top);
  const genres = relativeTags(
    GENRES,
    scores.slice(sfxCount + MOODS.length, sfxCount + MOODS.length + GENRES.length),
    top,
  );
  const custom = extra
    .map((label, index) => ({
      tag: label,
      similarity: Math.round(scores[sfxCount + MOODS.length + GENRES.length + index]! * 1000) / 1000,
    }))
    .sort((a, b) => b.similarity - a.similarity);
  return {
    outputs: [],
    metadata: {
      input: args.input,
      model: result.model,
      moods,
      genres,
      sfxKinds: sfx.kinds,
      descriptors: relativeTags(DESCRIPTORS, scores.slice(SFX_LABELS.length - DESCRIPTORS.length, sfxCount), top),
      ...(custom.length ? { custom } : {}),
      scoreNote:
        "moods, genres, descriptors: standard deviations above the group mean; sfxKinds: softmax share; custom: raw cosine similarity",
      notice: "CLAP similarity is a proxy for listening, not a judgement of quality or fit. The user judges music.",
      apiCalls: 0,
    },
  };
});
