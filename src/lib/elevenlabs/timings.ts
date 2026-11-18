import { CharacterAlignmentSchema, VoiceSegmentSchema } from "../../types/elevenlabs";
import { z } from "zod";
import { removeDirection, type InlinePronunciation } from "./direction";

const speechText = (value: string, approvedText?: string) =>
  removeDirection(value, approvedText).normalize("NFC").replace(/\s+/gu, " ").trim();
type Spoken = {
  approvedText?: string;
  expectedSpokenText?: string;
  lineId?: string;
  pronunciations?: InlinePronunciation[];
  speaker?: string;
  sceneId?: string;
};
type Turn = Spoken & {
  text: string;
  speaker: string;
  voiceId?: string;
  voiceRef?: { voiceId: string };
  sceneId: string;
};

/** Derived word spans retain their character source; mismatched normalisation is never guessed. */
export function characterWords(
  raw: unknown,
  expected: string,
  durationSec: number,
  turns?: Turn[],
  rawSegments?: unknown,
  language?: string,
  line?: Spoken,
) {
  const alignment = CharacterAlignmentSchema.parse(raw);
  const joined = alignment.characters.join("");
  const segments = rawSegments === undefined ? [] : z.array(VoiceSegmentSchema).parse(rawSegments);
  const offsets: number[] = [];
  for (let index = 0; index < alignment.characters.length; index++)
    for (let offset = 0; offset < alignment.characters[index]!.length; offset++) offsets.push(index);
  if (alignment.character_end_times_seconds.some((end) => end > durationSec + 0.05))
    throw Error("Alignment exceeds the generated audio");
  if (turns) {
    if (!segments.length) throw Error("Dialogue needs source-bound voice segments");
    for (const segment of segments) {
      const turn = turns[segment.dialogue_input_index];
      if (
        !turn ||
        (turn.voiceRef?.voiceId ?? turn.voiceId) !== segment.voice_id ||
        segment.character_end_index <= segment.character_start_index ||
        segment.character_end_index > alignment.characters.length ||
        segment.end_time_seconds < segment.start_time_seconds ||
        segment.end_time_seconds > durationSec + 0.05
      )
        throw Error("Invalid dialogue speaker/character ownership");
    }
    for (let index = 0; index < turns.length; index++) {
      const owned = segments
        .filter((segment) => segment.dialogue_input_index === index)
        .sort((a, b) => a.character_start_index - b.character_start_index);
      if (
        !owned.length ||
        owned.some((row, i) => i > 0 && row.character_start_index < owned[i - 1]!.character_end_index)
      )
        throw Error("Dialogue ownership overlaps or omits a turn");
      const actual = owned
        .map((segment) =>
          alignment.characters.slice(segment.character_start_index, segment.character_end_index).join(""),
        )
        .join("");
      const turn = turns[index]!;
      if (
        ![turn.text, turn.expectedSpokenText].some(
          (text) => text !== undefined && speechText(actual, turn.approvedText) === speechText(text, turn.approvedText),
        )
      )
        throw Error("Dialogue text does not match its alignment");
    }
  } else if (
    ![expected, line?.expectedSpokenText].some(
      (text) => text !== undefined && speechText(joined, line?.approvedText) === speechText(text, line?.approvedText),
    )
  )
    throw Error("Aligned text differs from the authored speech; explicit alignment is required");
  const literal = new Set((turns ?? [line]).flatMap((row) => row?.approvedText?.match(/\[[^\]]*\]/g) ?? []));
  const plain = joined.replace(/\[[^\]]*\]/g, (match) => (literal.has(match) ? match : " ".repeat(match.length)));
  const words =
    language && /^(?:ja|zh|yue|th|lo|km|my)(?:-|$)/.test(language)
      ? [...new Intl.Segmenter(language, { granularity: "word" }).segment(plain)]
          .filter((word) => word.isWordLike)
          .map(({ segment, index }) => ({ text: segment, index }))
      : [...plain.matchAll(/\S+/gu)].map((match) => ({ text: match[0], index: match.index! }));
  const spellings = new Map<Spoken, number>();
  return words.map((match, index) => {
    const first = offsets[match.index]!,
      last = offsets[match.index + match.text.length - 1]!;
    const owners = segments.filter(
      (segment) => first >= segment.character_start_index && last < segment.character_end_index,
    );
    if (turns && owners.length !== 1) throw Error("A word crosses or lacks dialogue ownership");
    const turn = owners[0] ? turns![owners[0].dialogue_input_index]! : undefined;
    const spoken = turn ?? line;
    const spelling = spoken ? (spellings.get(spoken) ?? 0) : 0;
    const pronunciation = spoken?.pronunciations?.[spelling];
    const ipa = pronunciation ? `/${pronunciation.ipa}/` : undefined;
    let displayText = match.text;
    if (spoken?.approvedText && pronunciation && ipa && match.text.includes(ipa)) {
      displayText = match.text.replace(ipa, spoken.approvedText.slice(pronunciation.start, pronunciation.end));
      spellings.set(spoken, spelling + 1);
    }
    const startSec = alignment.character_start_times_seconds[first]!,
      endSec = alignment.character_end_times_seconds[last]!;
    if (turn && (startSec < owners[0]!.start_time_seconds - 0.05 || endSec > owners[0]!.end_time_seconds + 0.05))
      throw Error("Word lies outside its speaker segment");
    return {
      id: `w${index + 1}`,
      text: displayText,
      startSec,
      endSec,
      speaker: turn?.speaker ?? line?.speaker ?? null,
      ...((turn?.sceneId ?? line?.sceneId) ? { sceneId: turn?.sceneId ?? line?.sceneId } : {}),
      ...((turn?.lineId ?? line?.lineId) ? { lineId: turn?.lineId ?? line?.lineId } : {}),
      characterStart: first,
      characterEnd: last + 1,
    };
  });
}
