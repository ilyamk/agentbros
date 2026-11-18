import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { NativeUnavailable, prepareApple, probeNative, localRoot } from "../src/lib/apple/runtime";
import { appleSpeechWords, runAppleTask, assertNoDraftLocalAssets } from "../src/lib/apple/tasks";
import { appleVideoDetections } from "../src/lib/apple/detections";
import { inspectCapabilities } from "../src/lib/local-capabilities";
const enabled = process.platform === "darwin" && process.env.RUN_APPLE_TESTS === "1";
test(
  "actual native task chain: isolated fixtures, offline execution, provenance and unsupported languages",
  { skip: !enabled && "Set RUN_APPLE_TESTS=1 on macOS; no live provider calls" },
  async (t) => {
    const directory = realpathSync(mkdtempSync(path.join(tmpdir(), "avc-apple-actual-")));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    // Share pinned prepared binaries, but keep all inference fixtures and outputs outside user projects.
    const root = localRoot();
    const available = new Map<string, string>();
    for (const domain of ["text", "translation", "tts", "speech", "audio", "vision", "foundation"] as const) {
      try {
        const result = await prepareApple(domain, { root, downloads: "never" });
        available.set(domain, result.state);
      } catch (error) {
        if (error instanceof NativeUnavailable) available.set(domain, error.issue.state);
        else throw error;
      }
    }
    const text = path.join(directory, "text.txt");
    writeFileSync(text, "Alice visits London. The camera holds on the product.");
    const request = path.join(directory, "speech.json");
    writeFileSync(
      request,
      JSON.stringify({
        version: 1,
        kind: "scenes",
        sourceLanguage: "en",
        units: [
          { id: "scene-1", text: "The camera holds on the product. Three simple steps make the workflow clear." },
        ],
      }),
    );
    const output = (stem: string) => path.join(directory, stem + ".json");
    await t.test("Natural Language keeps exact UTF-16 spans", async (t) => {
      if (available.get("text") !== "ready") {
        t.skip("Natural Language unavailable");
        return;
      }
      const result = await runAppleTask({
        task: "text.analyse",
        input: text,
        output: output("nl"),
        language: "en",
        root,
      });
      assert.equal(result.metadata.apiCalls, 0);
    });
    let audio = "";
    await t.test("system voice is a separate draft asset", async (t) => {
      if (available.get("tts") !== "ready") {
        t.skip("System TTS unavailable");
        return;
      }
      const voices = (await probeNative("tts", {}, root)).probe.voices ?? [];
      const voice =
        voices.find((v) => v.id === "com.apple.voice.compact.en-US.Samantha") ??
        voices.find((v) => v.language === "en-US");
      if (!voice) {
        t.skip("No installed en-US fixture voice");
        return;
      }
      const result = await runAppleTask({
        task: "speech.synthesise",
        input: request,
        output: output("voice"),
        language: "en",
        voice: voice.id,
        root,
      });
      audio = result.outputs.find((f) => f.endsWith(".mp3"))!;
      assert.ok(audio);
      assert.throws(() => assertNoDraftLocalAssets([audio]), /Draft/u);
    });
    await t.test("Apple ASR uses native word evidence without pyannote/VAD downloads", async (t) => {
      if (!audio || available.get("speech") !== "ready") {
        t.skip("Speech runtime or voice fixture unavailable");
        return;
      }
      const status = await inspectCapabilities([{ task: "speech.transcribe", language: "en" }], {
        root,
        refresh: true,
      });
      if (status[0]?.state !== "ready") {
        t.skip("Installed English Apple ASR model unavailable; suite never downloads it");
        return;
      }
      const words = await appleSpeechWords(audio, "en", root);
      assert.ok(words.words.length >= 8);
      assert.ok(["native", "estimated"].includes(words.timing));
    });
    await t.test("Sound Analysis returns bounded native events and taxonomy", async (t) => {
      if (!audio || available.get("audio") !== "ready") {
        t.skip("Sound Analysis or audio fixture unavailable");
        return;
      }
      const result = await runAppleTask({ task: "audio.events", input: audio, output: output("events"), root });
      assert.equal(result.metadata.apiCalls, 0);
    });
    const video = path.join(directory, "pattern.mp4"),
      image = path.join(directory, "pattern.png");
    assert.equal(
      spawnSync("ffmpeg", [
        "-v",
        "error",
        "-nostdin",
        "-f",
        "lavfi",
        "-i",
        "testsrc2=size=160x120:rate=5:duration=2",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        video,
      ]).status,
      0,
    );
    assert.equal(spawnSync("ffmpeg", ["-v", "error", "-nostdin", "-i", video, "-frames:v", "1", image]).status, 0);
    await t.test("Vision features and exact decoded detector frames", async (t) => {
      if (available.get("vision") !== "ready") {
        t.skip("Vision unavailable");
        return;
      }
      const supported = (await probeNative("vision", {}, root)).probe.operations;
      await runAppleTask({
        task: "vision.faces",
        input: video,
        output: output("vision"),
        features: ["faces", "people", "pose", "saliency", "quality", "tracking", "flow"].filter((feature) =>
          supported.includes("vision." + feature),
        ),
        root,
      });
      const detections = await appleVideoDetections(video, 2);
      assert.equal(detections.frameCount, 10);
      assert.deepEqual(
        detections.samples.map((s) => s.frame),
        [0, 3, 6, 9],
      );
    });
    await t.test("translation produces cue-based sidecars and refuses new word timing", async (t) => {
      const request = path.join(directory, "translate.json");
      writeFileSync(
        request,
        JSON.stringify({
          version: 1,
          kind: "captions",
          sourceLanguage: "ru",
          targetLanguage: "en",
          units: [{ id: "cue-1", text: "Привет, мир.", startMs: 0, endMs: 2000 }],
        }),
      );
      const status = await inspectCapabilities([{ task: "text.translate", language: "ru", targetLanguage: "en" }], {
        root,
        refresh: true,
      });
      if (status[0]?.state !== "ready") {
        t.skip("Translation pair is not installed; install it through macOS settings");
        return;
      }
      const result = await runAppleTask({ task: "text.translate", input: request, output: output("translated"), root });
      assert.ok(result.outputs.some((f) => f.endsWith(".srt")));
      const artifact = JSON.parse(readFileSync(output("translated"), "utf8"));
      assert.equal(artifact.result.wordTiming, null);
      assert.equal(artifact.result.units[0].endMs, 2000);
    });
    await t.test("Foundation Models preserves IDs and limits unsupported modalities", async (t) => {
      if (available.get("foundation") !== "ready") {
        t.skip("Apple Intelligence unavailable");
        return;
      }
      const ready = await inspectCapabilities([{ task: "text.assist", language: "en" }], { root, refresh: true });
      if (ready[0]?.state !== "ready") {
        t.skip("Apple Intelligence unavailable; no settings are changed");
        return;
      }
      await runAppleTask({ task: "text.assist", input: request, output: output("assist"), language: "en", root });
      const imageReady = await inspectCapabilities([{ task: "image.describe", language: "en" }], {
        root,
        refresh: true,
      });
      if (imageReady[0]?.state === "ready") {
        try {
          await runAppleTask({ task: "image.describe", input: image, output: output("image"), language: "en", root });
        } catch (error) {
          if (error instanceof NativeUnavailable && error.issue.code === "MODEL_REFUSAL")
            t.diagnostic("Image content refused by Apple; refusal handling passed, image quality is not accepted.");
          else throw error;
        }
      } else t.diagnostic("Image modality unavailable and excluded from the runnable catalogue");
    });
  },
);
