import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { openBrowser } from "@remotion/renderer";
import { ProjectConfigSchema } from "../src/types/video";
import { projectToVideoProps } from "../src/lib/project-props";
import { renderBrowserEvidence } from "../src/lib/qa-evidence/browser";
import { measureCompositionText } from "../src/lib/qa-evidence/measure";
test(
  "production Root measures actual overlong text after font ready and intentionally bad DOM fails boundaries/fonts",
  { skip: process.env.RUN_QA_EVIDENCE_TESTS !== "1", timeout: 120000 },
  async () => {
    const root = mkdtempSync(path.join(tmpdir(), "qa-browser-"));
    mkdirSync(path.join(root, "public"), { recursive: true });
    try {
      const project = ProjectConfigSchema.parse({
        name: "bad",
        productName: "bad",
        musicVolume: 0,
        colors: { accent: "#6C5CE7", background: "#fff", text: "#111" },
        scenes: [
          {
            id: "hook",
            text: "",
            visualType: "title",
            headline: "overflow",
            durationInFrames: 120,
            template: {
              id: "scene.definition",
              version: 1,
              props: {
                lines: ["Очень длинный заголовок ".repeat(90), "Actual measured layout"],
              },
            },
          },
        ],
      });
      const props = projectToVideoProps(project, "bad", "vertical", false);
      const result = await renderBrowserEvidence(
        props,
        [{ frame: 30, reasons: ["reveal-max"] }],
        path.join(root, "evidence"),
        { rootDir: root, codeDir: process.cwd(), offlineFonts: true },
      );
      assert.equal(result.frames.length, 1);
      assert.ok(result.frames[0].measurement?.fontsReady);
      assert.ok(result.findings.some((f) => (f.finding as { code: string }).code === "TEXT_SAFEZONE"));
      assert.equal(result.fontMode, "offline-substitute-not-production-font-approval");
      const directory = path.join(root, "public/projects/presenter");
      mkdirSync(path.join(directory, "talking-head"), { recursive: true });
      mkdirSync(path.join(directory, "voiceover"), { recursive: true });
      const video = path.join(directory, "talking-head/full.mp4");
      const generated = spawnSync(
        "ffmpeg",
        [
          "-v",
          "error",
          "-f",
          "lavfi",
          "-i",
          "color=c=orange:s=64x64:r=30:d=2",
          "-c:v",
          "libx264",
          "-pix_fmt",
          "yuv420p",
          "-y",
          video,
        ],
        { encoding: "utf8" },
      );
      assert.equal(generated.status, 0, generated.stderr);
      writeFileSync(
        path.join(directory, "voiceover/hook.words.json"),
        JSON.stringify({
          words: [{ text: "CAPTION_MARKER", start: 0, end: 2, loss: 0 }],
        }),
      );
      const head = ProjectConfigSchema.parse({
        name: "presenter",
        productName: "presenter",
        musicVolume: 0,
        colors: { accent: "#6C5CE7", background: "#fff", text: "#111" },
        talkingHead: {
          enabled: true,
          presenterVideo: "projects/presenter/talking-head/full.mp4",
          audioSource: "embedded",
        },
        scenes: [
          {
            id: "hook",
            text: "",
            headline: "Visual proof",
            visualType: "title",
            durationInFrames: 60,
            presenterStartSec: 0,
            presenterEndSec: 2,
            leftPanel: { kind: "text", text: "Visual proof" },
          },
        ],
      });
      const withCaptions = projectToVideoProps(head, "presenter", "landscape", false);
      const on = await renderBrowserEvidence(
        { ...withCaptions, captionsEnabled: true },
        [{ frame: 20, reasons: ["caption-proof"] }],
        path.join(root, "captioned"),
        { rootDir: root, offlineFonts: true },
      );
      const off = await renderBrowserEvidence(
        { ...withCaptions, captionsEnabled: false },
        [{ frame: 20, reasons: ["clean-proof"] }],
        path.join(root, "clean"),
        { rootDir: root, offlineFonts: true },
      );
      assert.notEqual(on.frames[0].sha256, off.frames[0].sha256);
      assert.ok(JSON.stringify(on.frames[0].measurement).includes("CAPTION_MARKER"));
      const captionMeasurement = (
        on.frames[0].measurement?.measurements as {
          text: string;
          rect: { x: number; y: number; width: number; height: number };
        }[]
      ).find((row) => row.text === "CAPTION_MARKER")!;
      assert.ok(captionMeasurement, "Actual caption glyphs must be measured");
      const captionRect = captionMeasurement.rect;
      assert.ok(
        Math.abs(captionRect.x + captionRect.width / 2 - 960) < 5,
        "Karaoke must stay horizontally centered in its layout slot",
      );
      assert.ok(
        captionRect.y + captionRect.height <= 1080 - 40,
        "Caption must retain visible bottom padding instead of overflowing a zero-height Sequence container",
      );
      assert.equal(JSON.stringify(off.frames[0].measurement).includes("CAPTION_MARKER"), false);
      assert.equal(on.durationInFrames, off.durationInFrames);
      assert.equal(withCaptions.talkingHead?.audioSource, "embedded");
      const browser = await openBrowser("chrome");
      try {
        const page = await browser.newPage({
          context: () => null,
          logLevel: "error",
          indent: false,
          pageIndex: 0,
          onBrowserLog: null,
          onLog: () => {},
        });
        await page.goto({ url: "about:blank", timeout: 10000 });
        await page.evaluate(async () => {
          document.body.innerHTML =
            '<div style="position:absolute;top:-20px;left:-10px;width:20px;height:20px;overflow:hidden;font-size:80px;font-family:EvidenceMissing">Overflow proof</div>';
          const face = new FontFace("EvidenceMissing", "url(data:font/woff2;base64,AAAA)");
          document.fonts.add(face);
          try {
            await face.load();
          } catch {}
          await document.fonts.ready;
        });
        const measured = await page.evaluate(measureCompositionText, 1080, 1920, { top: 200, bottom: 300, sides: 60 });
        assert.ok(measured.findings.some((f) => f.code === "TEXT_SAFEZONE"));
        assert.ok(measured.findings.some((f) => f.code === "TEXT_CLIPPED"));
        assert.ok(measured.findings.some((f) => f.code === "FONT_NOT_LOADED"));
      } finally {
        await browser.close({ silent: true });
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
