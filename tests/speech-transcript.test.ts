import test from "node:test";
import assert from "node:assert/strict";
import {
  buildTranscript,
  cleanAsrWords,
  confidenceFromLogprob,
  inferLanguage,
  normaliseLanguage,
  scribeRawPath,
  scribeWords,
  type RawWord,
} from "../src/lib/speech/transcript";
import { asrRegions, assignSpeakers, diarisationNote, spokenInterval } from "../src/lib/speech/local";
import { readFileSync } from "node:fs";
import path from "node:path";
import { importTranscript } from "../src/lib/ingest";
import { TranscriptSchema } from "../src/types/transcript";
import { SpeechMaskSchema } from "../src/types/speech-mask";

const source = { file: "fixture.wav", sha256: "a".repeat(64), durationSec: 20 };
const engine = {
  provider: "elevenlabs" as const,
  model: "scribe_v3",
  verbatim: true,
  diarized: true,
  timing: "native" as const,
};
const timed = (texts: string[], options: { gap?: number; speaker?: string | null; start?: number } = {}): RawWord[] => {
  let t = options.start ?? 0;
  return texts.map((text) => {
    const word: RawWord = {
      text,
      startSec: t,
      endSec: t + 0.2,
      kind: "word",
      speaker: options.speaker ?? "speaker_0",
      channel: null,
      confidence: 0.9,
    };
    t += 0.2 + (options.gap ?? 0.05);
    return word;
  });
};
const kinds = (words: RawWord[], verbatim = true) =>
  buildTranscript({ source, engine: { ...engine, verbatim }, language: "en", words }).words.map(
    (word) => `${word.text}:${word.kind}`,
  );

test("English fillers are marked; content words that double as fillers are not", () => {
  assert.deepEqual(kinds(timed(["So", "um", "I", "like", "it,", "uh,", "actually", "erm", "well", "Hmm."])), [
    "So:word",
    "um:filler",
    "I:word",
    "like:word",
    "it,:word",
    "uh,:filler",
    "actually:word",
    "erm:filler",
    "well:word",
    "Hmm.:filler",
  ]);
});

test("Russian fillers: э-sounds always, ну only when standalone", () => {
  assert.deepEqual(kinds(timed(["Ну,", "давайте", "эээ", "начнём."])), [
    "Ну,:filler",
    "давайте:word",
    "эээ:filler",
    "начнём.:word",
  ]);
  assert.deepEqual(kinds(timed(["ну", "да"])), ["ну:word", "да:word"]);
  assert.deepEqual(kinds(timed(["Это", "ну", "работает"])), ["Это:word", "ну:word", "работает:word"]);
  assert.deepEqual(
    kinds([...timed(["Это"]), ...timed(["ну"], { start: 0.6 }), ...timed(["работает"], { start: 1.2 })]),
    ["Это:word", "ну:filler", "работает:word"],
  );
  assert.deepEqual(kinds(timed(["эм,", "так", "вот", "ммм"])), ["эм,:filler", "так:word", "вот:word", "ммм:filler"]);
});

test("unambiguous fillers are marked in any transcript; plain ну and language-specific sounds need context", () => {
  assert.deepEqual(kinds(timed(["um", "yes", "uh,"]), false), ["um:filler", "yes:word", "uh,:filler"]);
  assert.deepEqual(kinds(timed(["Ну,", "давайте", "ну-у", "эээ"]), false), [
    "Ну,:word",
    "давайте:word",
    "ну-у:filler",
    "эээ:filler",
  ]);
  const russian = (texts: string[]) =>
    buildTranscript({ source, engine: { ...engine, verbatim: false }, language: "ru", words: timed(texts) }).words.map(
      (word) => `${word.text}:${word.kind}`,
    );
  assert.deepEqual(russian(["м", "думаю", "5", "м"]), ["м:filler", "думаю:word", "5:word", "м:word"]);
  const german = buildTranscript({ source, engine, language: "de", words: timed(["er", "kommt"]) }).words.map(
    (word) => word.kind,
  );
  assert.deepEqual(german, ["word", "word"]);
  assert.deepEqual(kinds(timed(["er,", "so"])), ["er,:filler", "so:word"]);
});

test("local recogniser artefacts: <unk> splits or drops, letters glued to numbers split, spans shared by length", () => {
  const word = (text: string): RawWord => ({
    text,
    startSec: 1,
    endSec: 2,
    kind: "word",
    speaker: null,
    channel: null,
    confidence: 0.9,
  });
  const clean = (text: string) =>
    cleanAsrWords([word(text)]).map((item) => [
      item.text,
      Math.round(item.startSec * 1000) / 1000,
      Math.round(item.endSec * 1000) / 1000,
    ]);
  assert.deepEqual(clean("конференции<unk>Другая"), [
    ["конференции", 1, 1.647],
    ["Другая", 1.647, 2],
  ]);
  assert.deepEqual(clean("Россия<unk>."), [["Россия.", 1, 2]]);
  assert.deepEqual(clean("<unk>"), []);
  assert.deepEqual(clean("of40.3"), [
    ["of", 1, 1.333],
    ["40.3", 1.333, 2],
  ]);
  assert.deepEqual(
    clean("Radio4").map(([text]) => text),
    ["Radio", "4"],
  );
  assert.deepEqual(
    clean("in2021.").map(([text]) => text),
    ["in", "2021."],
  );
  assert.deepEqual(
    clean("that40-degree").map(([text]) => text),
    ["that", "40-degree"],
  );
  for (const text of ["MP3", "4K", "x86", "COVID-19", "hello"]) assert.deepEqual(clean(text), [[text, 1, 2]]);
});

test("Scribe backchannels become events and punctuation-only tokens make no words or sentences", () => {
  const words = [
    ...timed(["the", "way-"], { speaker: "speaker_1" }),
    ...timed(["Mm-hmm"], { start: 0.6, speaker: "speaker_0" }),
    {
      text: "...",
      startSec: 0.8,
      endSec: 0.8,
      kind: "word" as const,
      speaker: "speaker_1",
      channel: null,
      confidence: 1,
    },
    ...timed(["then", "you", "need."], { start: 1, speaker: "speaker_1" }),
    ...timed(["uh-huh.", "Угу.", "mm"], { start: 2, speaker: "speaker_0" }),
  ];
  const transcript = buildTranscript({ source, engine, language: "en", words });
  assert.deepEqual(
    transcript.words.map((word) => `${word.text}:${word.kind}`),
    [
      "the:word",
      "way-:word",
      "Mm-hmm:event",
      "then:word",
      "you:word",
      "need.:word",
      "uh-huh.:event",
      "Угу.:event",
      "mm:filler",
    ],
  );
  assert.deepEqual(
    transcript.sentences.map((sentence) => sentence.text),
    ["the way- then you need.", "mm"],
    "a backchannel no longer breaks the speaker's sentence",
  );
});

test("sentences break on punctuation, pauses and speaker changes, and skip events", () => {
  const words = [
    ...timed(["Hello", "there."]),
    ...timed(["How", "are"], { start: 1 }),
    {
      text: "(laughter)",
      startSec: 1.5,
      endSec: 1.9,
      kind: "event" as const,
      speaker: null,
      channel: null,
      confidence: null,
    },
    ...timed(["you"], { start: 2 }),
    ...timed(["Fine", "thanks"], { start: 2.3, speaker: "speaker_1" }),
    ...timed(["Next"], { start: 5 }),
  ];
  const transcript = buildTranscript({ source, engine, language: "eng", words });
  assert.equal(transcript.language, "en");
  assert.deepEqual(
    transcript.sentences.map((s) => [s.text, s.speaker]),
    [
      ["Hello there.", "speaker_0"],
      ["How are you", "speaker_0"],
      ["Fine thanks", "speaker_1"],
      ["Next", "speaker_0"],
    ],
  );
  assert.deepEqual(transcript.speakers, [{ id: "speaker_0" }, { id: "speaker_1" }]);
  const event = transcript.words.find((word) => word.kind === "event")!;
  assert.equal(event.text, "(laughter)");
  assert.equal(transcript.sentences[1]!.firstWordId, "w3");
  assert.equal(transcript.sentences[1]!.lastWordId, "w6");
  assert.doesNotThrow(() => TranscriptSchema.parse(transcript));
});

test("language codes normalise to ISO-639-1", () => {
  assert.equal(normaliseLanguage("rus"), "ru");
  assert.equal(normaliseLanguage("en-US"), "en");
  assert.equal(normaliseLanguage(undefined), "und");
  assert.equal(normaliseLanguage("xyz"), "xyz");
});

test("Scribe single response: spacing dropped, events kept, logprob to confidence", () => {
  const parsed = scribeWords({
    language_code: "eng",
    audio_duration_secs: 3,
    words: [
      { text: "Um", start: 0, end: 0.3, type: "word", speaker_id: "speaker_0", logprob: -0.1 },
      { text: " ", start: 0.3, end: 0.4, type: "spacing", speaker_id: "speaker_0", logprob: 0 },
      { text: "(coughs)", start: 0.4, end: 0.8, type: "audio_event", speaker_id: "speaker_0", logprob: 0 },
      { text: "hi", start: null, end: null, type: "word", logprob: -1 },
    ],
  });
  assert.equal(parsed.words.length, 2);
  assert.equal(parsed.untimed, 1);
  assert.equal(parsed.words[1]!.kind, "event");
  assert.equal(parsed.words[0]!.confidence, Math.exp(-0.1));
  assert.equal(parsed.durationSec, 3);
  assert.equal(confidenceFromLogprob(null), null);
  assert.equal(confidenceFromLogprob(2), 1);
});

test("Scribe multichannel response: channel-prefixed speakers", () => {
  const parsed = scribeWords(
    {
      transcripts: [
        {
          language_code: "eng",
          channel_index: 0,
          words: [{ text: "Hi.", start: 0, end: 0.4, type: "word", speaker_id: "speaker_0", logprob: 0 }],
        },
        {
          language_code: "eng",
          channel_index: 1,
          words: [{ text: "Hello.", start: 0.2, end: 0.6, type: "word", speaker_id: "speaker_0", logprob: 0 }],
        },
      ],
      audio_duration_secs: 1,
    },
    { multichannel: true },
  );
  assert.deepEqual(
    parsed.words.map((word) => [word.speaker, word.channel]),
    [
      ["ch0-speaker_0", 0],
      ["ch1-speaker_0", 1],
    ],
  );
  const transcript = buildTranscript({ source, engine, language: parsed.language ?? "und", words: parsed.words });
  assert.deepEqual(
    transcript.speakers.map((speaker) => speaker.id),
    ["ch0-speaker_0", "ch1-speaker_0"],
  );
  assert.equal(transcript.sentences.length, 2);
});

test("raw Scribe path sits beside the transcript", () => {
  assert.equal(scribeRawPath("a/transcript.json"), "a/transcript.scribe.json");
  assert.equal(scribeRawPath("a/out"), "a/out.scribe.json");
});

test("ASR regions merge short gaps, pad without overlapping and clamp to the file", () => {
  const regions = asrRegions(
    [
      { startSec: 0, endSec: 2.5 },
      { startSec: 2.7, endSec: 5.9 },
      { startSec: 7.3, endSec: 10.1 },
      { startSec: 10.3, endSec: 12.2 },
      { startSec: 13.7, endSec: 14.9 },
    ],
    15,
  );
  assert.deepEqual(regions, [
    { startSec: 0, endSec: 6.1 },
    { startSec: 7.1, endSec: 12.4 },
    { startSec: 13.5, endSec: 15 },
  ]);
  const long = asrRegions(
    [
      { startSec: 0, endSec: 20 },
      { startSec: 20.1, endSec: 40 },
    ],
    40,
  );
  assert.equal(long.length, 2);
  assert.ok(long[0]!.endSec <= long[1]!.startSec);
});

test("a turn's last word stretched across the silence keeps its speaker (live pyannote turns, 2026-11-13)", () => {
  const fixture = JSON.parse(
    readFileSync(path.join(import.meta.dirname, "fixtures/speech/dialogue-diarisation.json"), "utf8"),
  ) as {
    words: [string, number, number][];
    speech: [number, number][];
    turns: [number, number, string][];
    expectedTurnOfWord: number[];
  };
  const words: RawWord[] = fixture.words.map(([text, startSec, endSec]) => ({
    text,
    startSec,
    endSec,
    kind: "word",
    speaker: null,
    channel: null,
    confidence: null,
  }));
  const turns = fixture.turns.map(([start, end, speaker]) => ({ start, end, speaker }));
  const speech = fixture.speech.map(([startSec, endSec]) => ({ startSec, endSec }));
  const expected = fixture.expectedTurnOfWord.map((turn) => turns[turn]!.speaker);
  assert.deepEqual(
    assignSpeakers(words, turns, speech).map((word) => word.speaker),
    expected,
  );
  assert.deepEqual(
    assignSpeakers(words, turns).map((word) => word.speaker),
    expected,
    "sentence majority fixes it even without a speech mask",
  );
  const transcript = buildTranscript({
    source,
    engine: { ...engine, provider: "local", verbatim: false },
    language: "en",
    words: assignSpeakers(words, turns, speech),
  });
  assert.ok(
    transcript.sentences.some(
      (sentence) => sentence.text.endsWith("so we keep a little of it.") && sentence.speaker === turns[3]!.speaker,
    ),
  );
  assert.equal(transcript.sentences.length, 7);
});

test("a short reply after a pause keeps its own speaker inside one unpunctuated sentence", () => {
  const words = [
    ...timed(["we", "agreed", "on", "that"], { speaker: null }),
    ...timed(["yes"], { start: 1.6, speaker: null }),
    ...timed(["and", "then"], { start: 2.4, speaker: null }),
  ];
  const turns = [
    { start: 0, end: 1.2, speaker: "A" },
    { start: 1.55, end: 1.9, speaker: "B" },
    { start: 2.35, end: 3, speaker: "A" },
  ];
  assert.deepEqual(
    assignSpeakers(words, turns).map((word) => word.speaker),
    ["A", "A", "A", "A", "B", "A", "A"],
  );
  const glued = [
    ...timed(["we", "agreed", "on", "that"], { speaker: null }),
    ...timed(["yes"], { start: 1.0, speaker: null }),
  ];
  assert.deepEqual(
    assignSpeakers(glued, [
      { start: 0, end: 0.95, speaker: "A" },
      { start: 1.05, end: 1.3, speaker: "B" },
    ]).map((word) => word.speaker),
    ["A", "A", "A", "A", "A"],
    "no pause: a stray word takes the majority",
  );
});

test("spoken interval clips a word to the VAD span it starts in, or the nearest span by its start", () => {
  const speech = [
    { startSec: 0, endSec: 1 },
    { startSec: 2, endSec: 3 },
  ];
  assert.deepEqual(spokenInterval({ startSec: 0.8, endSec: 1.9 }, speech), { startSec: 0.8, endSec: 1 });
  assert.deepEqual(spokenInterval({ startSec: 1.1, endSec: 1.9 }, speech), { startSec: 0.95, endSec: 1 });
  assert.deepEqual(spokenInterval({ startSec: 1.9, endSec: 2.4 }, speech), { startSec: 2, endSec: 2.4 });
});

test("diarisation turns label words by overlap, nearest within half a second", () => {
  const words = timed(["a", "b", "c"], { speaker: null, gap: 1 });
  const labelled = assignSpeakers(words, [
    { start: 0, end: 0.15, speaker: "SPEAKER_00" },
    { start: 1.25, end: 1.5, speaker: "SPEAKER_01" },
  ]);
  assert.deepEqual(
    labelled.map((word) => word.speaker),
    ["SPEAKER_00", "SPEAKER_01", null],
  );
});

test("media ingest keeps Scribe and transcript speakers and splits groups on a speaker change", () => {
  const scribe = importTranscript(
    {
      words: [
        { text: "Hello", start: 0, end: 0.3, type: "word", speaker_id: "speaker_0" },
        { text: " ", start: 0.3, end: 0.35, type: "spacing", speaker_id: "speaker_0" },
        { text: "there", start: 0.35, end: 0.6, type: "word", speaker_id: "speaker_0" },
        { text: "Hi.", start: 0.7, end: 0.9, type: "word", speaker_id: "speaker_1" },
      ],
    },
    "fixture",
    "hash",
    1,
  );
  assert.deepEqual(
    scribe.map((row) => [row.text, row.speaker]),
    [
      ["Hello there", "speaker_0"],
      ["Hi.", "speaker_1"],
    ],
  );
  const transcript = buildTranscript({
    source,
    engine,
    language: "en",
    words: [
      ...timed(["Yes."], { speaker: "speaker_1" }),
      { text: "(laughs)", startSec: 0.3, endSec: 0.5, kind: "event", speaker: null, channel: null, confidence: null },
    ],
  });
  transcript.words.push({ ...transcript.words[0]!, id: "w9", text: "x", startSec: 0.25, endSec: 0.25 });
  const rows = importTranscript(transcript, "fixture", "hash", 1);
  assert.deepEqual(
    rows.map((row) => [row.text, row.speaker]),
    [["Yes.", "speaker_1"]],
  );
});

test("speech mask rejects overlapping or padded-out spans", () => {
  const mask = {
    version: 1,
    source: { ...source, durationSec: 5 },
    engine: {
      provider: "silero-vad",
      version: "6.2.3",
      sampleRate: 16000,
      threshold: 0.5,
      minSpeechMs: 250,
      minSilenceMs: 100,
      padMs: 0,
    },
    speech: [
      { startSec: 0, endSec: 1 },
      { startSec: 1.5, endSec: 2 },
    ],
    speechSec: 1.5,
  };
  assert.doesNotThrow(() => SpeechMaskSchema.parse(mask));
  assert.throws(() =>
    SpeechMaskSchema.parse({
      ...mask,
      speech: [
        { startSec: 0, endSec: 1 },
        { startSec: 0.5, endSec: 2 },
      ],
    }),
  );
  assert.throws(() => SpeechMaskSchema.parse({ ...mask, engine: { ...mask.engine, padMs: 30 } }));
});

test("diarisation notes: a gated 403 becomes instructions, other errors keep the last exception line, tokens never show", () => {
  const token = "hf_SECRETfixtureTOKEN123";
  const gated = `speech-local diarize failed: Traceback (most recent call last):\n  File "x.py", line 3\nhuggingface_hub.errors.GatedRepoError: 403 Client Error. (Request ID: Root=1)\nCannot access gated repo for url https://huggingface.co/pyannote/speaker-diarization-community-1/resolve/main/config.yaml.`;
  const note = diarisationNote(gated, token);
  assert.match(note, /https:\/\/huggingface\.co\/pyannote\/speaker-diarization-community-1/);
  assert.match(note, /fine-grained token/);
  assert.doesNotMatch(note, /Traceback|hf_/);
  assert.match(diarisationNote("401 Client Error: Unauthorized for url", token), /accept its conditions/);
  const other = diarisationNote(
    `speech-local diarize failed: Traceback (most recent call last):\n  File "y.py"\nRuntimeError: out of memory with ${token}\n`,
    token,
  );
  assert.equal(other, "Diarisation failed, speakers are null: RuntimeError: out of memory with [token]");
  assert.doesNotMatch(diarisationNote("ValueError: bad hf_abcdefghijkl token", undefined), /hf_abcdefghijkl/);
});

test("a local transcript's language is inferred from Cyrillic text only; local Russian keeps context-dependent fillers unmarked", () => {
  const ru = timed("ну э я думаю что это было очень рядом с домом и с работой".split(" "));
  assert.equal(inferLanguage(ru), "ru");
  assert.equal(inferLanguage(timed(["я", "думаю"])), "und");
  assert.equal(inferLanguage(timed("I think this was very close to home and to the office".split(" "))), "und");
  assert.equal(inferLanguage(timed("я думаю що це було дуже поруч з домівкою і роботою".split(" "))), "und");
  const local = buildTranscript({
    source,
    engine: { ...engine, provider: "local", verbatim: false },
    language: inferLanguage(ru),
    words: ru,
  }).words;
  assert.deepEqual(
    local.slice(0, 2).map((word) => `${word.text}:${word.kind}`),
    ["ну:word", "э:filler"],
  );
});
