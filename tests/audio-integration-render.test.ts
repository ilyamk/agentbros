import test from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { bundle } from "@remotion/bundler";
import { renderMedia, renderStill, selectComposition } from "@remotion/renderer";
import { enableTailwind } from "@remotion/tailwind-v4";
import { executeStudioAudio } from "../src/lib/elevenlabs/operations";
import { OperationStore } from "../src/lib/jobs/store";
import { planProjectRender } from "../src/lib/render-plan";
import { USER_GRANT } from "./helpers/ceiling-grant";

const actual = process.env.RUN_AUDIO_INTEGRATION_RENDER === "1";
test(
  "mock Eleven v4 Russian speech and canonical words render through the production Root in all formats",
  { skip: !actual, timeout: 300_000 },
  async (t) => {
    const root = mkdtempSync(path.join(tmpdir(), "audio-render-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const projectId = "audio-integration",
      project = path.join(root, "public/projects", projectId),
      text = "Новая речь";
    mkdirSync(project, { recursive: true });
    mkdirSync(path.join(project, "talking-head"));
    const presenter = spawnSync("ffmpeg", [
      "-v",
      "error",
      "-nostdin",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=320x180:rate=30:duration=1.5",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      path.join(project, "talking-head/full.mp4"),
    ]);
    assert.equal(presenter.status, 0);
    writeFileSync(
      path.join(project, "project.json"),
      JSON.stringify({
        name: "Synthetic audio integration",
        formats: ["vertical", "square", "landscape"],
        productName: "Fixture",
        tagline: "Synthetic",
        voice: "drew",
        musicPrompt: "",
        musicVolume: 0,
        talkingHead: {
          enabled: true,
          presenterVideo: `projects/${projectId}/talking-head/full.mp4`,
          audioSource: "elevenlabs",
        },
        colors: { accent: "#6C5CE7", background: "#111111", text: "#ffffff" },
        scenes: [{ id: "intro", visualType: "title", text, headline: text, durationInFrames: 45 }],
      }),
    );
    const encoded = spawnSync("ffmpeg", [
      "-v",
      "error",
      "-nostdin",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=660:duration=1.5",
      "-f",
      "mp3",
      "pipe:1",
    ]);
    assert.equal(encoded.status, 0);
    const store = new OperationStore(projectId, {
      directory: path.join(project, "pipeline"),
      responseCacheDirectory: path.join(root, ".cache/paid-responses"),
    });
    store.configure({ ceilingUsd: 2, maxJobUsd: 1, repairReserveFraction: 0 }, USER_GRANT);
    let posts = 0;
    await executeStudioAudio(
      {
        version: 1,
        task: "tts",
        projectId,
        output: `public/projects/${projectId}/voiceover/intro.mp3`,
        text,
        approvedText: text,
        voiceId: "fixture_voice",
        model: "eleven_v4",
        language: "ru",
        maxCostUsd: 1,
      },
      {
        rootDir: root,
        store,
        dryRun: false,
        apiKey: "FAKE_FIXTURE_ONLY",
        fetch: (async (_url: string, init?: RequestInit) => {
          posts++;
          assert.equal(JSON.parse(String(init?.body)).model_id, "eleven_v4");
          return new Response(
            JSON.stringify({
              audio_base64: encoded.stdout.toString("base64"),
              alignment: {
                characters: [...text],
                character_start_times_seconds: [...text].map((_, i) => i * 0.1),
                character_end_times_seconds: [...text].map((_, i) => (i + 1) * 0.1),
              },
            }),
          );
        }) as typeof fetch,
      },
    );
    assert.equal(posts, 1);
    const words = JSON.parse(readFileSync(path.join(project, "voiceover/intro.words.json"), "utf8"));
    assert.equal(words.words.map((word: { text: string }) => word.text).join(" "), text);
    copyFileSync(
      path.join(project, "voiceover/intro.words.json"),
      path.join(project, "voiceover/intro.words.edited.json"),
    );
    const serveUrl = await bundle({
      entryPoint: path.resolve("src/index.ts"),
      publicDir: path.join(root, "public"),
      outDir: path.join(root, "bundle"),
      webpackOverride: (config) => {
        const enhanced = enableTailwind(config);
        return {
          ...enhanced,
          resolve: {
            ...enhanced.resolve,
            alias: {
              ...enhanced.resolve?.alias,
              [path.resolve("src/lib/fonts")]: path.resolve("tests/fixtures/offline-fonts.ts"),
            },
          },
        };
      },
    });
    const evidence = path.resolve("out/qa/audio-integrations-render");
    mkdirSync(evidence, { recursive: true });
    const results = [];
    for (const job of planProjectRender(projectId, undefined, root).jobs) {
      const composition = await selectComposition({ serveUrl, id: job.compositionId, inputProps: job.props });
      const outputLocation = path.join(evidence, `${job.format}.mp4`);
      await renderMedia({
        serveUrl,
        composition,
        inputProps: job.props,
        codec: "h264",
        outputLocation,
        scale: 0.25,
        concurrency: 2,
      });
      const probe = spawnSync("ffprobe", ["-v", "error", "-show_streams", "-of", "json", outputLocation]);
      assert.equal(probe.status, 0);
      const video = JSON.parse(probe.stdout.toString()).streams.find(
        (stream: { codec_type: string }) => stream.codec_type === "video",
      );
      assert.equal(video.width, composition.width / 4);
      assert.equal(video.height, composition.height / 4);
      const pcm = spawnSync(
        "ffmpeg",
        ["-v", "error", "-i", outputLocation, "-f", "f32le", "-ac", "1", "-ar", "16000", "pipe:1"],
        { maxBuffer: 8 * 1024 * 1024 },
      );
      assert.equal(pcm.status, 0);
      const samples = new Float32Array(pcm.stdout.buffer, pcm.stdout.byteOffset, pcm.stdout.byteLength / 4);
      const rms = Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length);
      assert.ok(rms > 0.001);
      let captionPixels: number | undefined;
      if (job.format === "landscape") {
        const pixels: Buffer[] = [];
        for (const captionsEnabled of [true, false]) {
          const frameFile = path.join(root, `frame-${captionsEnabled}.png`);
          const inputProps = { ...job.props, captionsEnabled };
          await renderStill({
            serveUrl,
            composition: await selectComposition({ serveUrl, id: job.compositionId, inputProps }),
            inputProps,
            frame: 12,
            output: frameFile,
            scale: 0.25,
          });
          const raw = spawnSync("ffmpeg", [
            "-v",
            "error",
            "-i",
            frameFile,
            "-f",
            "rawvideo",
            "-pix_fmt",
            "rgb24",
            "pipe:1",
          ]);
          assert.equal(raw.status, 0, raw.stderr.toString());
          pixels.push(raw.stdout);
        }
        assert.equal(pixels[0]!.length, pixels[1]!.length);
        captionPixels = 0;
        for (let i = 0; i < pixels[0]!.length; i += 3)
          if ([0, 1, 2].some((channel) => Math.abs(pixels[0]![i + channel]! - pixels[1]![i + channel]!) > 30))
            captionPixels++;
        assert.ok(captionPixels > 20, "the timed captions should change the rendered frame");
      }
      results.push({
        format: job.format,
        width: composition.width / 4,
        height: composition.height / 4,
        frames: composition.durationInFrames,
        rms,
        captionPixels,
      });
    }
    copyFileSync(path.join(project, "voiceover/intro.words.json"), path.join(evidence, "intro.words.json"));
    writeFileSync(
      path.join(evidence, "report.json"),
      JSON.stringify(
        {
          results,
          actualExternalApiCalls: 0,
          mockSubmissions: posts,
          fontMode: "offline fixture fonts",
          humanCreativeAcceptance: false,
        },
        null,
        2,
      ) + "\n",
    );
    assert.equal(results.length, 3);
  },
);
