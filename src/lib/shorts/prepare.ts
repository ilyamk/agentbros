import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { TranscriptSchema, type Transcript } from "../../types/transcript";
import {
  ShortsCandidatesSchema,
  ShortsPreparedSchema,
  ShortsSentenceSchema,
  type ShortsPrepared,
} from "../../types/shorts";

export type ShortsSentence = z.infer<typeof ShortsSentenceSchema>;
export type ShortsParams = ShortsPrepared["params"];

export const CHUNK_SEC = 20 * 60;
export const CHUNK_OVERLAP_SEC = 60;
const SENTENCE_GAP_SEC = 1.5;

export const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

/** The producer's sentences, or sentences derived from words at end punctuation, a speaker change or a long pause. */
export function numberSentences(transcript: Transcript): { sentences: ShortsSentence[]; derived: boolean } {
  if (transcript.sentences.length)
    return {
      derived: false,
      sentences: transcript.sentences.map((s, index) => ({
        n: index + 1,
        id: s.id,
        firstWordId: s.firstWordId,
        lastWordId: s.lastWordId,
        startSec: s.startSec,
        endSec: s.endSec,
        speaker: s.speaker,
        text: s.text,
      })),
    };
  const sentences: ShortsSentence[] = [];
  let group: Transcript["words"] = [];
  const flush = () => {
    const spoken = group.filter((w) => w.kind !== "event");
    if (spoken.length) {
      const first = group[0]!,
        last = group[group.length - 1]!;
      sentences.push({
        n: sentences.length + 1,
        id: `s${sentences.length + 1}`,
        firstWordId: first.id,
        lastWordId: last.id,
        startSec: first.startSec,
        endSec: last.endSec,
        speaker: spoken[0]!.speaker,
        text: spoken.map((w) => w.text).join(" "),
      });
    }
    group = [];
  };
  transcript.words.forEach((word, index) => {
    const previous = group[group.length - 1];
    if (previous && (word.speaker !== previous.speaker || word.startSec - previous.endSec > SENTENCE_GAP_SEC)) flush();
    group.push(word);
    const next = transcript.words[index + 1];
    if (/[.!?…]["»”')]*$/.test(word.text) || !next) flush();
  });
  return { sentences, derived: true };
}

export function chunkSentences(sentences: ShortsSentence[]) {
  if (!sentences.length) return [];
  const total = sentences[sentences.length - 1]!.endSec;
  const chunks: { startSec: number; endSec: number; sentences: ShortsSentence[] }[] = [];
  for (let start = 0; ; start += CHUNK_SEC - CHUNK_OVERLAP_SEC) {
    const end = start + CHUNK_SEC;
    const inside = sentences.filter((s) => s.startSec < end && s.endSec > start);
    if (inside.length) chunks.push({ startSec: start, endSec: Math.min(end, total), sentences: inside });
    if (end >= total) break;
  }
  return chunks;
}

export const clock = (seconds: number) => {
  const whole = Math.floor(seconds),
    tenths = Math.floor((seconds - whole) * 10);
  const h = Math.floor(whole / 3600),
    m = Math.floor((whole % 3600) / 60),
    s = whole % 60;
  return `${h ? `${h}:` : ""}${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${tenths}`;
};
export const sentenceLine = (s: ShortsSentence) =>
  `S${String(s.n).padStart(4, "0")} [${clock(s.startSec)}–${clock(s.endSec)}]${s.speaker ? ` ${s.speaker}` : ""}: ${s.text}`;

const EXAMPLE = {
  version: 1,
  candidates: [
    {
      id: "c1",
      title: "Why the first price was wrong",
      firstSentence: 12,
      lastSentence: 19,
      hookSentence: 12,
      axes: {
        hook: { score: 8, sentence: 12, quote: "words copied from sentence 12" },
        standalone: { score: 7, sentence: 12, quote: "words showing the topic is introduced" },
        emotion: { score: 5, sentence: 15, quote: "words carrying the emotional peak" },
        payoff: { score: 9, sentence: 19, quote: "words of the conclusion" },
        value: { score: 7, sentence: 17, quote: "words of the useful point" },
        relevance: { score: 6, sentence: 14, quote: "words matching the brief" },
      },
      vetoes: { needsSetup: false, endsBeforePayoff: false, claimOutOfContext: false },
    },
  ],
};

export function briefMarkdown(params: ShortsParams, prepared: ShortsPrepared, language: string) {
  const schema = JSON.stringify(z.toJSONSchema(ShortsCandidatesSchema, { io: "input" }), null, 2);
  return `# Shorts candidates: task for the agent

Read every chunk file (${prepared.chunks.map((c) => c.file).join(", ")}). Sentence numbers are global; chunks overlap by ${CHUNK_OVERLAP_SEC} s, so a clip near a chunk edge appears in two chunks: propose it once. Transcript language: ${language}.

Propose up to ${Math.max(params.count * 3, 10)} candidate clips (the code keeps the best ${params.count}). Each is a contiguous range of whole sentences, ${params.minSec}–${params.maxSec} s long (30–60 s is typical); up to ${params.hardMaxSec} s only when the clip is a story whose payoff needs the length.
${params.brief ? `\nBrief: ${params.brief}\n` : ""}
## Rules

- Whole sentences only, in their original order. Never join distant sentences into a new claim; never drop a negation, caveat or qualifier the claim depends on.
- Score each axis 0–10 and support it with \`quote\`: words copied verbatim from the sentence numbered in \`sentence\`, which lies inside the range. Quotes that are not in that sentence reject the candidate.
- Do not give a total, rank or overall score: the code computes the score from the axes with its weights.
- \`hookSentence\` must start within 3 s of the clip start (normally the first sentence); the hook quote comes from it.
- The payoff quote comes from one of the last two sentences of the range.

## Axes

- \`hook\`: the first 3 s make a viewer stop (a question, a surprising claim, a conflict, a number).
- \`standalone\`: understandable without the rest of the recording; no unresolved "he", "that", "as I said", "этот", "как я говорил" at the start.
- \`emotion\`: a peak of feeling, humour, tension or surprise.
- \`payoff\`: the clip ends on its point, punchline or answer.
- \`value\`: the viewer learns or gets something useful.
- \`relevance\`: fits the brief${params.brief ? "" : " (no brief: the channel's evident topic)"} or a current trend.

## Vetoes (true rejects the clip)

- \`needsSetup\`: it only makes sense with something said before the range.
- \`endsBeforePayoff\`: the point comes after the last sentence.
- \`claimOutOfContext\`: cut this way, a claim says something the speaker did not mean.

## Output

Write one JSON file matching this schema, then run \`pnpm shorts:rank --prepared <this directory> --candidates <file>\`.

Example:

\`\`\`json
${JSON.stringify(EXAMPLE, null, 2)}
\`\`\`

JSON Schema:

\`\`\`json
${schema}
\`\`\`
`;
}

export function prepareShorts(transcriptFile: string, outputDir: string, params: ShortsParams) {
  if (!(params.minSec < params.maxSec && params.maxSec <= params.hardMaxSec))
    throw new Error("Durations must satisfy min-sec < max-sec <= hard-max-sec");
  const raw = readFileSync(transcriptFile, "utf8");
  const transcript = TranscriptSchema.parse(JSON.parse(raw));
  const { sentences, derived } = numberSentences(transcript);
  if (!sentences.length) throw new Error("Transcript has no spoken words");
  const chunks = chunkSentences(sentences);
  mkdirSync(outputDir, { recursive: true });
  const prepared = ShortsPreparedSchema.parse({
    version: 1,
    transcript: {
      file: "transcript.json",
      sha256: sha256(raw),
      sourceSha256: transcript.source.sha256,
      language: transcript.language,
    },
    params,
    sentenceCount: sentences.length,
    sentencesDerived: derived,
    chunks: chunks.map((chunk, index) => ({
      file: `chunk-${String(index + 1).padStart(2, "0")}.md`,
      startSec: chunk.startSec,
      endSec: chunk.endSec,
      firstSentence: chunk.sentences[0]!.n,
      lastSentence: chunk.sentences[chunk.sentences.length - 1]!.n,
    })),
  });
  writeFileSync(path.join(outputDir, "transcript.json"), raw);
  writeFileSync(path.join(outputDir, "sentences.json"), `${JSON.stringify(sentences, null, 2)}\n`);
  chunks.forEach((chunk, index) => {
    const meta = prepared.chunks[index]!;
    writeFileSync(
      path.join(outputDir, meta.file),
      `# Chunk ${index + 1} of ${chunks.length}: ${clock(chunk.startSec)}–${clock(chunk.endSec)}, sentences ${meta.firstSentence}–${meta.lastSentence}\n\n${chunk.sentences.map(sentenceLine).join("\n")}\n`,
    );
  });
  writeFileSync(path.join(outputDir, "brief.md"), briefMarkdown(params, prepared, transcript.language));
  writeFileSync(path.join(outputDir, "prepared.json"), `${JSON.stringify(prepared, null, 2)}\n`);
  return {
    prepared,
    files: ["prepared.json", "transcript.json", "sentences.json", "brief.md", ...prepared.chunks.map((c) => c.file)],
  };
}

export function loadPrepared(dir: string) {
  const preparedRaw = readFileSync(path.join(dir, "prepared.json"), "utf8");
  const prepared = ShortsPreparedSchema.parse(JSON.parse(preparedRaw));
  const transcriptRaw = readFileSync(path.join(dir, prepared.transcript.file), "utf8");
  if (sha256(transcriptRaw) !== prepared.transcript.sha256)
    throw new Error("Prepared transcript changed since shorts:prepare");
  const transcript = TranscriptSchema.parse(JSON.parse(transcriptRaw));
  const { sentences } = numberSentences(transcript);
  if (sentences.length !== prepared.sentenceCount) throw new Error("Sentence count differs from shorts:prepare");
  return { prepared, preparedSha256: sha256(preparedRaw), transcript, sentences };
}
