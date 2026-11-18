import { PYTHON_VERSION } from "../src/lib/python";
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { hashFile } from "../src/lib/assets/registry";
import { probeLocalWorker } from "../src/lib/ingest/local-worker";
import { asrStatus, engineFiles, ocrStatus, prepareCommand } from "../src/lib/local-engines/prepare";
import {
  analyseSpeechAndText,
  localScreenText,
  localSpeechWords,
  mergeScreenText,
  sampleVideoFrames,
  speechWordsFromRows,
} from "../src/lib/local-engines/speech-text";
import { ReferenceSpeechTextSchema } from "../src/types/reference";

const fixtures = path.resolve(import.meta.dirname, "fixtures");
const macOnly = { skip: process.platform !== "darwin" };
const box = { x: 0.1, y: 0.2, width: 0.5, height: 0.1 };
const row = (text: string, confidence = 1) => ({ text, confidence, box });

function makeVideo(file: string, audio = true) {
  const args = [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=blue:s=320x180:r=30:d=2",
    ...(audio ? ["-itsoffset", "0.5", "-f", "lavfi", "-i", "sine=frequency=440:duration=1.5"] : []),
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    ...(audio ? ["-c:a", "aac"] : []),
    file,
  ];
  const made = spawnSync("ffmpeg", args, { encoding: "utf8" });
  assert.equal(made.status, 0, made.stderr);
}

function engineFixture(mode = "ok", ocrMode = "ok") {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "local engines ")));
  const asrModel = path.join(root, "model.txt"),
    engineExecutable = path.join(root, "engine"),
    ocrMode_ = path.join(root, "ocr-mode"),
    ocrExecutable = path.join(root, "ocr-worker");
  writeFileSync(asrModel, mode);
  writeFileSync(engineExecutable, "fixture");
  writeFileSync(ocrMode_, ocrMode);
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  writeFileSync(
    ocrExecutable,
    `#!/bin/sh\nexec ${quote(realpathSync(process.execPath))} ${quote(path.join(fixtures, "ocr-worker.mjs"))} ${quote(ocrMode_)}\n`,
    { mode: 0o700 },
  );
  const asr = {
    executable: realpathSync(process.execPath),
    workerFile: path.join(fixtures, "local-engine-asr-worker.mjs"),
    engine: "whisper.cpp",
    engineExecutable,
    modelPath: asrModel,
    model: "injected",
    revision: "fixture",
    language: "auto",
    timeoutMs: 30000,
    threads: 2,
    wordTimingMethod: "native-word-segments-v1",
  } as const;
  const ocr = {
    engine: "apple-vision",
    executable: ocrExecutable,
    executableHash: hashFile(ocrExecutable),
    workerSource: path.join(fixtures, "ocr-worker.mjs"),
    workerSourceHash: hashFile(path.join(fixtures, "ocr-worker.mjs")),
    revision: 3,
    languages: ["ru-RU", "en-US"],
    maxFrames: 32,
    timeoutMs: 30000,
  };
  const files = engineFiles(root);
  mkdirSync(path.dirname(files.asrConfig), { recursive: true });
  mkdirSync(path.dirname(files.ocrConfig), { recursive: true });
  writeFileSync(files.asrConfig, JSON.stringify(asr));
  writeFileSync(files.ocrConfig, JSON.stringify(ocr));
  const probe = probeLocalWorker(asr);
  assert.ok(probe.available);
  const { executableHash, workerHash, engineHash, modelHash } = probe.identity as unknown as Record<string, string>;
  writeFileSync(
    files.manifest,
    JSON.stringify({
      version: 1,
      asr: {
        whisperCppVersion: "fixture",
        sourceUrl: "fixture",
        sourceSha256: "fixture",
        cmakeVersion: "fixture",
        pythonVersion: PYTHON_VERSION,
        buildPolicy: "fixture",
        model: "fixture",
        modelUrl: "fixture",
        modelRevision: "fixture",
        modelBytes: 1,
        pins: { executableHash, workerHash, engineHash, modelHash },
      },
    }),
  );
  return {
    root,
    asrModel,
    ocrMode: ocrMode_,
    ocrExecutable,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function cli(args: string[], pathVariable = process.env.PATH) {
  const child = spawnSync(process.execPath, ["--import", "tsx", "scripts/media-prepare.ts", ...args], {
    encoding: "utf8",
    timeout: 60000,
    env: { AGENTBROS_NO_DOTENV: "1", PATH: pathVariable, TMPDIR: process.env.TMPDIR, HOME: process.env.HOME },
  });
  assert.equal(child.stdout.trim().split("\n").length, 1, child.stdout + child.stderr);
  return { status: child.status, result: JSON.parse(child.stdout) };
}

test("prepared speech engines using a different Python pin require explicit preparation", (t) => {
  const fixture = engineFixture();
  t.after(fixture.cleanup);
  assert.equal(asrStatus(fixture.root).available, true);
  const file = engineFiles(fixture.root).manifest;
  const manifest = JSON.parse(readFileSync(file, "utf8"));
  manifest.asr.pythonVersion = "3.13";
  writeFileSync(file, JSON.stringify(manifest));
  const status = asrStatus(fixture.root);
  assert.equal(status.available, false);
  if (!status.available) assert.match(status.reason, /prepare it again/);
});

test("screen text merges consecutive samples into estimated spans on a top-left box", () => {
  const items = mergeScreenText(
    [
      { timeSec: 0, observations: [row("ЗАДАЧИ", 0.5), row("Personal OS", 0.3)] },
      { timeSec: 0.5, observations: [row("задачи", 1), row("Personal  OS", 0.5)] },
      { timeSec: 1, observations: [row("Personal OS", 0.4), row("=", 1)] },
      { timeSec: 1.5, observations: [row("ЗАДАЧИ")] },
    ],
    1.8,
  );
  assert.deepEqual(
    items.map((item) => [item.text, item.startSec, item.endSec]),
    [
      ["задачи", 0, 0.75],
      ["Personal  OS", 0, 1.25],
      ["ЗАДАЧИ", 1.25, 1.75],
    ],
  );
  assert.deepEqual(items[0]!.box, { x: 0.1, y: 0.7, width: 0.5, height: 0.1 });
  assert.equal(items[0]!.confidence, 0.75);
});

test("screen text bridges Latin and Cyrillic lookalikes, keeps two lines apart and clamps the last span", () => {
  const items = mergeScreenText(
    [
      { timeSec: 7.5, observations: [] },
      { timeSec: 8, observations: [row("ОДНА"), row("СИСТЕМА")] },
      { timeSec: 8.5, observations: [row("OДНА", 0.5), row("СИСТЕМА")] },
      { timeSec: 9, observations: [row("ОДНА"), row("СИСТЕМА")] },
    ],
    9.2,
  );
  assert.deepEqual(
    items.map((item) => [item.text, item.startSec, item.endSec]),
    [
      ["ОДНА", 7.75, 9.2],
      ["СИСТЕМА", 7.75, 9.2],
    ],
  );
  assert.deepEqual(mergeScreenText([], 5), []);
});

test("speech words drop non-lexical rows and refuse evidence that cannot be a word clock", () => {
  const evidence = (rawRows: { text: string; offsets: { from: number; to: number } }[]) => ({
    version: 1,
    method: "native-word-segments-v1",
    estimated: true,
    reviewRequired: true,
    status: "available",
    rawRows,
  });
  const words = speechWordsFromRows(
    evidence([
      { text: " Привет", offsets: { from: 0, to: 300 } },
      { text: "", offsets: { from: 300, to: 300 } },
      { text: " [BLANK_AUDIO]", offsets: { from: 300, to: 900 } },
      { text: " (музыка)", offsets: { from: 900, to: 1000 } },
      { text: " ♪", offsets: { from: 1000, to: 1100 } },
      { text: " мир", offsets: { from: 1100, to: 1400 } },
    ]),
    2,
  );
  assert.deepEqual(words, [
    { text: "Привет", startSec: 0, endSec: 0.3 },
    { text: "мир", startSec: 1.1, endSec: 1.4 },
  ]);
  const labelled = speechWordsFromRows(
    evidence([
      { text: " (upbeat", offsets: { from: 0, to: 300 } },
      { text: " music)", offsets: { from: 300, to: 900 } },
      { text: " Да", offsets: { from: 900, to: 1000 } },
      { text: " (нет", offsets: { from: 1000, to: 1100 } },
      { text: " закрытия", offsets: { from: 1100, to: 1200 } },
    ]),
    2,
  );
  assert.deepEqual(
    labelled.map((word) => word.text),
    ["Да", "(нет", "закрытия"],
  );
  assert.throws(
    () =>
      speechWordsFromRows(
        evidence([
          { text: " a", offsets: { from: 500, to: 600 } },
          { text: " b", offsets: { from: 100, to: 200 } },
        ]),
        2,
      ),
    /overlap, reverse/,
  );
});

test("frame sampling reports decoded mid-interval times at about two per second, never beyond the source", () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "local sampling ")));
  try {
    const video = path.join(root, "source.mp4");
    makeVideo(video, false);
    const frames = sampleVideoFrames(video, root);
    assert.deepEqual(
      frames.map((frame) => Math.round(frame.timeSec * 100) / 100),
      [0.27, 0.77, 1.27, 1.77],
    );
    assert.equal(frames[0]!.hash, hashFile(frames[0]!.file));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("absent engines report a reason and the exact repair command, valid against the reference schema", async () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "local absent ")));
  try {
    const video = path.join(root, "source.mp4");
    makeVideo(video);
    const asr = asrStatus(root);
    assert.equal(asr.available, false);
    assert.ok(!asr.available && asr.reason.includes("not prepared"));
    assert.ok(!asr.available && asr.fix === prepareCommand("asr", root));
    assert.match(prepareCommand("ocr", root), /scripts\/media-prepare\.ts --engines ocr --output-dir/);
    const result = await analyseSpeechAndText({ mediaFile: video, engineDir: root });
    assert.ok(!result.speech.available && result.speech.fix?.includes("--engines asr"));
    assert.ok(!result.screenText.available && result.screenText.fix?.includes("--engines ocr"));
    const parsed = ReferenceSpeechTextSchema.parse({
      schemaVersion: 1,
      referenceId: "sample",
      speech: result.speech,
      screenText: result.screenText,
    });
    assert.equal(parsed.speech.available, false);
    assert.equal(parsed.speech.unavailableReason, result.speech.unavailableReason);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("prepared configs that drift from their pins or do not parse are refused", async () => {
  const fixture = engineFixture();
  try {
    assert.equal(asrStatus(fixture.root).available, true);
    writeFileSync(fixture.asrModel, "replaced");
    const drift = asrStatus(fixture.root);
    assert.ok(!drift.available && /differ from the prepared manifest/.test(drift.reason));
    assert.ok(!drift.available && drift.fix.includes("media-prepare"));
    writeFileSync(engineFiles(fixture.root).asrConfig, '{"executable":"/bin/sh","unknownField":true}');
    const refused = asrStatus(fixture.root);
    assert.ok(!refused.available && /configuration refused/.test(refused.reason));
    writeFileSync(fixture.ocrExecutable, "changed");
    if (process.platform === "darwin") {
      const ocr = await ocrStatus(fixture.root);
      assert.ok(!ocr.available && /checksum/.test(ocr.reason));
    }
  } finally {
    fixture.cleanup();
  }
});

test("fake engines produce schema-valid word and screen layers, cached outside any project", macOnly, async () => {
  const fixture = engineFixture();
  try {
    const video = path.join(fixture.root, "source.mp4");
    makeVideo(video);
    const before = hashFile(video);
    const first = await analyseSpeechAndText({ mediaFile: video, engineDir: fixture.root });
    assert.ok(first.speech.available);
    assert.deepEqual(first.speech.words, [
      { text: "Привет", startSec: 0.1, endSec: 0.4 },
      { text: "мир.", startSec: 0.4, endSec: 0.7 },
    ]);
    assert.ok(first.screenText.available);
    assert.deepEqual(
      first.screenText.items.map((item) => [item.text, item.startSec, item.endSec]),
      [["FRAME NOT DELETED", 0, 2]],
    );
    assert.equal(first.sourceHash, before);
    assert.equal(hashFile(video), before);
    const parsed = ReferenceSpeechTextSchema.parse({
      schemaVersion: 1,
      referenceId: "sample",
      speech: first.speech,
      screenText: first.screenText,
    });
    assert.equal(parsed.speech.words.length, 2);
    assert.equal(parsed.screenText.items[0]!.box!.width, 0.8);
    assert.equal(existsSync("public/projects/sample"), false);
    assert.ok(
      readdirSync(engineFiles(fixture.root).asrCache).length && readdirSync(engineFiles(fixture.root).ocrCache).length,
    );
    // A failing engine after the first run proves the replay needs no inference.
    writeFileSync(fixture.ocrMode, "wrong-key");
    assert.deepEqual(
      (await localScreenText({ mediaFile: video, engineDir: fixture.root })).items,
      first.screenText.items,
    );
    assert.deepEqual((await localSpeechWords({ mediaFile: video, engineDir: fixture.root })).words, first.speech.words);
    assert.equal(
      readFileSync(fixture.asrModel + ".runs", "utf8").length,
      1,
      "Unchanged source must not rerun speech inference",
    );
    assert.deepEqual(readdirSync(path.join(engineFiles(fixture.root).asrCache, "audio")), []);
  } finally {
    fixture.cleanup();
  }
});

test("a language override changes identity, not the prepared config", async () => {
  const fixture = engineFixture();
  try {
    const video = path.join(fixture.root, "source.mp4");
    makeVideo(video);
    const config = readFileSync(engineFiles(fixture.root).asrConfig);
    const pinned = await localSpeechWords({ mediaFile: video, engineDir: fixture.root, language: "ru" });
    assert.ok(pinned.available && pinned.language === "ru");
    assert.ok((await localSpeechWords({ mediaFile: video, engineDir: fixture.root, language: "ru" })).available);
    assert.equal(readdirSync(engineFiles(fixture.root).asrCache).filter((name) => name.endsWith(".json")).length, 1);
    const automatic = await localSpeechWords({ mediaFile: video, engineDir: fixture.root });
    assert.ok(automatic.available && automatic.language === undefined);
    assert.equal(readdirSync(engineFiles(fixture.root).asrCache).filter((name) => name.endsWith(".json")).length, 2);
    assert.deepEqual(readFileSync(engineFiles(fixture.root).asrConfig), config);
  } finally {
    fixture.cleanup();
  }
});

test("engine failures and missing streams stay structured per layer", macOnly, async () => {
  const fixture = engineFixture("fail", "extra-line");
  try {
    const video = path.join(fixture.root, "source.mp4");
    makeVideo(video);
    const failed = await analyseSpeechAndText({ mediaFile: video, engineDir: fixture.root });
    assert.ok(
      !failed.speech.available &&
        /Local speech recognition failed: .*Injected engine failure/s.test(failed.speech.unavailableReason),
    );
    assert.ok(
      !failed.screenText.available && /Local screen-text recognition failed/.test(failed.screenText.unavailableReason),
    );
    const silent = path.join(fixture.root, "silent.mp4");
    makeVideo(silent, false);
    writeFileSync(fixture.asrModel, "ok");
    const pins = JSON.parse(readFileSync(engineFiles(fixture.root).manifest, "utf8"));
    pins.asr.pins.modelHash = (
      probeLocalWorker(JSON.parse(readFileSync(engineFiles(fixture.root).asrConfig, "utf8"))) as {
        identity: { modelHash: string };
      }
    ).identity.modelHash;
    writeFileSync(engineFiles(fixture.root).manifest, JSON.stringify(pins));
    const noAudio = await analyseSpeechAndText({ mediaFile: silent, engineDir: fixture.root });
    assert.ok(
      !noAudio.speech.available &&
        noAudio.speech.unavailableReason === "Source has no audio stream" &&
        !noAudio.speech.fix,
    );
    const collapsed = fixture.asrModel;
    writeFileSync(collapsed, "collapsed");
    pins.asr.pins.modelHash = (
      probeLocalWorker(JSON.parse(readFileSync(engineFiles(fixture.root).asrConfig, "utf8"))) as {
        identity: { modelHash: string };
      }
    ).identity.modelHash;
    writeFileSync(engineFiles(fixture.root).manifest, JSON.stringify(pins));
    const ambiguous = await localSpeechWords({ mediaFile: video, engineDir: fixture.root });
    assert.ok(!ambiguous.available && /Word timing unavailable/.test(ambiguous.unavailableReason));
    await assert.rejects(
      () => analyseSpeechAndText({ mediaFile: path.join(fixture.root, "absent.mp4"), engineDir: fixture.root }),
      /Media not found/,
    );
  } finally {
    fixture.cleanup();
  }
});

test("OCR boxes outside the image are clipped on this route; a corrupted cache is refused", macOnly, async () => {
  const fixture = engineFixture("ok", "box");
  try {
    const video = path.join(fixture.root, "source.mp4");
    makeVideo(video, false);
    const clipped = await localScreenText({ mediaFile: video, engineDir: fixture.root });
    assert.ok(clipped.available);
    assert.equal(clipped.items[0]!.box!.x, 0.5);
    assert.equal(clipped.items[0]!.box!.width, 0.5);
    const cache = engineFiles(fixture.root).ocrCache,
      file = path.join(cache, readdirSync(cache)[0]!);
    const stored = JSON.parse(readFileSync(file, "utf8"));
    stored.frames[0].observations[0].text = "FORGED";
    writeFileSync(file, JSON.stringify(stored));
    const refused = await localScreenText({ mediaFile: video, engineDir: fixture.root });
    assert.ok(!refused.available && /cache checksum/.test(refused.unavailableReason));
  } finally {
    fixture.cleanup();
  }
});

test("media:prepare dry-run reports state and plan without writing or downloading", () => {
  const parent = realpathSync(mkdtempSync(path.join(tmpdir(), "local prepare ")));
  try {
    const target = path.join(parent, "engines");
    const { status, result } = cli(["--dry-run", "--output-dir", target]);
    assert.equal(status, 0);
    assert.equal(result.ok, true);
    assert.equal(result.metadata.dryRun, true);
    assert.deepEqual(result.outputs, []);
    const { asr, ocr } = result.metadata.engines;
    assert.equal(asr.available, false);
    assert.match(asr.fix, /--engines asr --output-dir/);
    assert.equal(asr.plan.downloads[0].bytes, 487601967);
    assert.match(asr.plan.downloads[0].url, /5359861c739e955e79d9a303bcbc70fb988958b1\/ggml-small\.bin$/);
    if (process.platform === "darwin") assert.equal(ocr.plan.downloads.length, 0);
    assert.equal(existsSync(target), false);
    const medium = cli(["--dry-run", "--engines", "asr", "--model", "medium", "--output-dir", target]).result;
    assert.equal(medium.metadata.engines.asr.plan.downloads[0].bytes, 1533763059);
    assert.equal(medium.metadata.engines.ocr, undefined);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("media:prepare names the toolchain fix when tools are absent", () => {
  const empty = realpathSync(mkdtempSync(path.join(tmpdir(), "local no tools ")));
  try {
    const engines = path.join(empty, "engines");
    const planned = cli(["--dry-run", "--output-dir", engines], empty).result.metadata.engines;
    assert.ok(planned.asr.plan.toolsMissing.includes("uv"));
    assert.match(planned.asr.plan.toolchainFix, /astral\.sh\/uv/);
    assert.equal(planned.ocr.available, false);
    if (process.platform === "darwin") assert.match(planned.ocr.fix, /xcode-select --install/);
    const actual = cli(["--output-dir", engines], empty);
    assert.equal(actual.status, 0);
    assert.equal(actual.result.metadata.engines.asr.available, false);
    assert.match(actual.result.metadata.engines.asr.reason, /Missing tools: uv/);
    assert.equal(existsSync(engineFiles(engines).asrConfig), false);
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});

test("media:prepare refuses bad flags and a directory inside the repository", () => {
  assert.equal(cli(["--dry-run", "--engines", "video"]).result.error, "INVALID_INPUT");
  assert.equal(cli(["--dry-run", "--model", "large-v3"]).result.error, "INVALID_INPUT");
  const inside = path.resolve("out/qa/local-engines-refused");
  const refused = cli(["--engines", "ocr", "--output-dir", inside]);
  assert.equal(refused.result.ok, false);
  assert.match(refused.result.message, /outside the repository/);
  assert.equal(existsSync(inside), false);
});

test(
  "actual prepared engines recognise known Russian and English speech",
  { skip: process.env.RUN_LOCAL_ENGINE_TESTS !== "1", timeout: 600000 },
  async () => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), "local actual ")));
    try {
      for (const [language, voice, text] of [
        ["ru", "Milena", "Каждое утро я открываю одну систему и выбираю главное."],
        ["en", "Samantha", "Every morning I open a single system and choose what matters."],
      ] as const) {
        const sample = path.join(root, `${language}.aiff`);
        const spoken = spawnSync("say", ["-v", voice, "-o", sample, text], { encoding: "utf8" });
        assert.equal(spoken.status, 0, spoken.stderr);
        const result = await localSpeechWords({ mediaFile: sample, engineDir: process.env.LOCAL_ENGINE_DIR, language });
        assert.ok(result.available, JSON.stringify(result));
        const normal = (value: string) =>
          value
            .toLocaleLowerCase()
            .match(/[\p{L}\p{N}]+/gu)!
            .join(" ");
        assert.equal(normal(result.words.map((word) => word.text).join(" ")), normal(text));
        result.words.forEach((word, i) =>
          assert.ok(word.endSec > word.startSec && word.startSec >= (result.words[i - 1]?.endSec ?? 0)),
        );
      }
      const video = process.env.LOCAL_ENGINE_OCR_SAMPLE;
      if (video) {
        const screen = await localScreenText({ mediaFile: video, engineDir: process.env.LOCAL_ENGINE_DIR });
        assert.ok(screen.available && screen.items.length, JSON.stringify(screen).slice(0, 500));
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
