import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { TranscriptSchema } from "../src/types/transcript";
import { SpeechMaskSchema } from "../src/types/speech-mask";

const enabled = process.env.RUN_SPEECH_LOCAL_TESTS === "1" && process.platform === "darwin";
const repo = path.resolve(import.meta.dirname, "..");
const LINES = [
  {
    voice: "Samantha",
    language: "en",
    text: "The quick brown fox jumps over the lazy dog. We record a short video about local speech recognition.",
  },
  {
    voice: "Milena",
    language: "ru",
    text: "Сегодня мы проверяем локальное распознавание речи. Это короткая запись для теста.",
  },
  { voice: "Daniel", language: "en", text: "Thank you for watching." },
];

const tokens = (text: string) =>
  text
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
/** Word error rate by edit distance. */
function wer(reference: string[], hypothesis: string[]) {
  const row = Array.from({ length: hypothesis.length + 1 }, (_, j) => j);
  for (let i = 1; i <= reference.length; i++) {
    let diagonal = row[0]!;
    row[0] = i;
    for (let j = 1; j <= hypothesis.length; j++) {
      const above = row[j]!;
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, diagonal + (reference[i - 1] === hypothesis[j - 1] ? 0 : 1));
      diagonal = above;
    }
  }
  return row[hypothesis.length]! / reference.length;
}

test(
  "speech:local on a synthetic two-language, three-voice clip (real models)",
  { skip: !enabled && "set RUN_SPEECH_LOCAL_TESTS=1 on macOS", timeout: 1_800_000 },
  (t) => {
    const directory = mkdtempSync(path.join(tmpdir(), "speech-local-actual-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const parts = LINES.map((line, i) => {
      const file = path.join(directory, `${i}.aiff`);
      assert.equal(spawnSync("say", ["-v", line.voice, "-o", file, line.text]).status, 0, `say -v ${line.voice}`);
      return file;
    });
    const mixed = path.join(directory, "mixed.wav");
    const filter =
      "[0]aresample=16000,apad=pad_dur=1.2[a];[1]aresample=16000,apad=pad_dur=1.2[b];[2]aresample=16000[c];[a][b][c]concat=n=3:v=0:a=1,aformat=sample_fmts=s16:channel_layouts=mono";
    assert.equal(
      spawnSync("ffmpeg", [
        "-v",
        "error",
        "-y",
        ...parts.flatMap((part) => ["-i", part]),
        "-filter_complex",
        filter,
        mixed,
      ]).status,
      0,
    );
    const output = path.join(directory, "transcript.json");
    const started = performance.now();
    const child = spawnSync(
      process.execPath,
      ["--import", "tsx", "scripts/speech-local.ts", "--input", mixed, "--output", output],
      { cwd: repo, encoding: "utf8", timeout: 1_700_000, env: process.env },
    );
    const elapsed = (performance.now() - started) / 1000;
    const result = JSON.parse(child.stdout.trim().split("\n").at(-1)!);
    assert.equal(result.ok, true, child.stderr.slice(-2000));
    const transcript = TranscriptSchema.parse(JSON.parse(readFileSync(output, "utf8")));
    const mask = SpeechMaskSchema.parse(JSON.parse(readFileSync(path.join(directory, "speech-mask.json"), "utf8")));
    const hypothesis = transcript.words
      .filter((word) => word.kind !== "event")
      .map((word) => word.text)
      .join(" ");
    const english = wer(
      tokens(`${LINES[0]!.text} ${LINES[2]!.text}`),
      tokens(hypothesis).filter((word) => /^[a-z]/.test(word)),
    );
    const russian = wer(
      tokens(LINES[1]!.text),
      tokens(hypothesis).filter((word) => /^[а-я]/.test(word)),
    );
    t.diagnostic(
      `engine ${result.metadata.engine}, wall ${elapsed.toFixed(1)} s, timings ${JSON.stringify(result.metadata.timings)}`,
    );
    t.diagnostic(
      `WER en ${english.toFixed(3)}, ru ${russian.toFixed(3)}; ${mask.speech.length} speech spans; ${transcript.sentences.length} sentences`,
    );
    t.diagnostic(`notes: ${(transcript.notes ?? []).join(" | ")}`);
    assert.ok(english <= 0.15, `English WER ${english}`);
    assert.ok(russian <= 0.15, `Russian WER ${russian}`);
    assert.ok(mask.speech.length >= 3);
  },
);

const DIALOGUE = [
  { voice: "Daniel", text: "Good morning. Today we are talking about editing your own footage with agents." },
  { voice: "Samantha", text: "Thanks for having me. I think the hardest part is finding the moments worth keeping." },
  { voice: "Daniel", text: "Right, and removing the pauses without making the speech sound rushed." },
  { voice: "Samantha", text: "Exactly. A natural pause is part of the rhythm, so we keep a little of it." },
  { voice: "Daniel", text: "Let us finish there. Thank you very much." },
];

test(
  "speech:local labels a two-voice dialogue turn by turn (real models, pyannote with HF_TOKEN)",
  {
    skip: (!enabled || !process.env.HF_TOKEN) && "set RUN_SPEECH_LOCAL_TESTS=1 and HF_TOKEN on macOS",
    timeout: 1_800_000,
  },
  (t) => {
    const directory = mkdtempSync(path.join(tmpdir(), "speech-local-dialogue-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const gapSec = 0.8;
    let clock = 0;
    const windows: { startSec: number; endSec: number }[] = [];
    const parts = DIALOGUE.map((line, i) => {
      const aiff = path.join(directory, `${i}.aiff`),
        wav = path.join(directory, `${i}.wav`);
      assert.equal(spawnSync("say", ["-v", line.voice, "-o", aiff, line.text]).status, 0, `say -v ${line.voice}`);
      assert.equal(
        spawnSync("ffmpeg", [
          "-v",
          "error",
          "-y",
          "-i",
          aiff,
          "-ar",
          "16000",
          "-ac",
          "1",
          "-c:a",
          "pcm_s16le",
          ...(i < DIALOGUE.length - 1 ? ["-af", `apad=pad_dur=${gapSec}`] : []),
          wav,
        ]).status,
        0,
      );
      const duration = Number(
        spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", wav], {
          encoding: "utf8",
        }).stdout,
      );
      windows.push({ startSec: clock, endSec: clock + duration - (i < DIALOGUE.length - 1 ? gapSec : 0) });
      clock += duration;
      return wav;
    });
    const dialogue = path.join(directory, "dialogue.wav");
    assert.equal(
      spawnSync("ffmpeg", [
        "-v",
        "error",
        "-y",
        ...parts.flatMap((part) => ["-i", part]),
        "-filter_complex",
        `${parts.map((_, i) => `[${i}]`).join("")}concat=n=${parts.length}:v=0:a=1`,
        dialogue,
      ]).status,
      0,
    );
    const output = path.join(directory, "transcript.json");
    const started = performance.now();
    const child = spawnSync(
      process.execPath,
      ["--import", "tsx", "scripts/speech-local.ts", "--input", dialogue, "--output", output, "--language", "en"],
      { cwd: repo, encoding: "utf8", timeout: 1_700_000, env: process.env },
    );
    const result = JSON.parse(child.stdout.trim().split("\n").at(-1)!);
    assert.equal(result.ok, true, child.stderr.slice(-2000));
    const transcript = TranscriptSchema.parse(JSON.parse(readFileSync(output, "utf8")));
    t.diagnostic(
      `wall ${((performance.now() - started) / 1000).toFixed(1)} s, timings ${JSON.stringify(result.metadata.timings)}`,
    );
    assert.equal(transcript.engine.diarized, true, (transcript.notes ?? []).join(" "));
    assert.equal(transcript.speakers.length, 2);
    const turnOf = (startSec: number) =>
      windows.findIndex(
        (window, i) => startSec < (windows[i + 1]?.startSec ?? Infinity) - gapSec / 2 || i === windows.length - 1,
      );
    const labels = windows.map((_, turn) => [
      ...new Set(transcript.words.filter((word) => turnOf(word.startSec) === turn).map((word) => word.speaker)),
    ]);
    t.diagnostic(`labels per turn ${JSON.stringify(labels)}`);
    for (const [turn, set] of labels.entries()) assert.equal(set.length, 1, `turn ${turn + 1} has one speaker`);
    const [a, b] = [labels[0]![0], labels[1]![0]];
    assert.notEqual(a, b);
    assert.deepEqual(
      labels.map((set) => set[0]),
      [a, b, a, b, a],
    );
  },
);
