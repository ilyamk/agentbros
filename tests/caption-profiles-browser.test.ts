import { offlineSmokeFontAliases } from "./helpers/offline-smoke-fonts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { bundle } from "@remotion/bundler";
import { enableTailwind } from "@remotion/tailwind-v4";
import { ensureBrowser, openBrowser, renderStill, selectComposition } from "@remotion/renderer";
import { ProjectVideoSchema } from "../src/lib/project-props";
import { CAPTION_SAFE_ZONE } from "../src/lib/captions/readability";
import { CaptionProfileIdSchema, type CaptionProfileId } from "../src/types/caption-style";
import { captionBlocks } from "../src/motion/library/captions";
import type { TimelineIR } from "../src/types/timeline";

const words = ["Most", "people", "quit", "right", "before", "it", "works."];
const timeline = (captionStyle?: Record<string, unknown>): TimelineIR =>
  ({
    version: 1,
    projectId: "test",
    timebase: { num: 30, den: 1 },
    tracks: [
      {
        id: "captions",
        kind: "captions",
        clips: [
          {
            id: "speech",
            assetId: "speech",
            start: { num: 0, den: 1 },
            source: { start: { num: 0, den: 1 }, end: { num: 90, den: 1 }, timebase: { num: 30, den: 1 } },
            rate: { num: 1, den: 1 },
            transition: { kind: "cut" },
            captions: words.map((text, i) => ({
              id: `w${i}`,
              text,
              start: { num: 6 + i * 10, den: 1 },
              end: { num: 14 + i * 10, den: 1 },
              emphasis: text === "quit",
              translation: `t${i}`,
            })),
          },
        ],
      },
    ],
    ...(captionStyle ? { captionStyle } : {}),
  }) as TimelineIR;

const PROFILES: CaptionProfileId[] = [...CaptionProfileIdSchema.options];
const BLOCKS = new Set<CaptionProfileId>(Object.keys(captionBlocks) as CaptionProfileId[]);

test(
  "every caption profile renders through TimelineComposition; library profiles stay inside the vertical safe zone",
  { skip: process.env.RUN_RENDER_TESTS !== "1" ? "set RUN_RENDER_TESTS=1 to render" : false, timeout: 600_000 },
  async () => {
    const checkout = process.cwd();
    const keep = process.env.CAPTION_PROFILES_OUT;
    const root = keep ?? mkdtempSync(path.join(os.tmpdir(), "caption-profiles-"));
    const installed = await ensureBrowser({
      logLevel: "error",
      onBrowserDownload: () => {
        throw new Error("Installed Chromium required; no downloads");
      },
    });
    if (!("path" in installed)) throw new Error("Installed Chromium required");
    const browser = await openBrowser("chrome", { browserExecutable: installed.path, logLevel: "error" });
    try {
      const serveUrl = await bundle({
        entryPoint: path.join(checkout, "tests/fixtures/caption-profiles-render.tsx"),
        outDir: path.join(root, "bundle"),
        webpackOverride: (config) => {
          const enhanced = enableTailwind(config);
          return {
            ...enhanced,
            resolve: {
              ...enhanced.resolve,
              alias: { ...enhanced.resolve?.alias, ...offlineSmokeFontAliases(checkout) },
            },
          };
        },
      });
      const still = async (name: string, extra: Record<string, unknown>) => {
        const inputProps = ProjectVideoSchema.parse({
          projectId: "test",
          format: "vertical",
          productName: "Fixture",
          tagline: "",
          accentColor: "#FFE600",
          bgColor: "#203040",
          textColor: "#FFFFFF",
          scenes: [],
          voiceoverEnabled: true,
          musicVolume: 0,
          ...extra,
        });
        const composition = await selectComposition({
          serveUrl,
          id: "CaptionProfiles",
          inputProps,
          puppeteerInstance: browser,
          logLevel: "error",
        });
        const output = path.join(root, `${name}.png`);
        await renderStill({
          serveUrl,
          composition,
          inputProps,
          puppeteerInstance: browser,
          output,
          frame: 28,
          imageFormat: "png",
          scale: 0.5,
          logLevel: "error",
        });
        return execFileSync("ffmpeg", ["-v", "error", "-i", output, "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], {
          maxBuffer: 64 * 1024 * 1024,
        });
      };
      const W = 540,
        H = 960,
        k = 0.5;
      const changed = (a: Buffer, b: Buffer, x0 = 0, y0 = 0, x1 = W, y1 = H) => {
        let count = 0;
        for (let y = y0; y < y1; y++)
          for (let x = x0; x < x1; x++) {
            const i = (y * W + x) * 3;
            if (Math.abs(a[i]! - b[i]!) + Math.abs(a[i + 1]! - b[i + 1]!) + Math.abs(a[i + 2]! - b[i + 2]!) > 24)
              count++;
          }
        return count;
      };
      const clean = await still("clean", { timeline: timeline(), captionsEnabled: false });
      const shots = new Map<CaptionProfileId, Buffer>();
      for (const profile of PROFILES) {
        const style =
          profile === "karaoke"
            ? undefined
            : profile === "bilingual"
              ? { profile, sourceLanguage: "en", translationLanguage: "ru" }
              : { profile };
        shots.set(profile, await still(profile, { timeline: timeline(style) }));
        assert.ok(changed(shots.get(profile)!, clean) > 200, `${profile} draws captions`);
      }
      assert.deepEqual(
        await still("karaoke-explicit", { timeline: timeline({ profile: "karaoke" }) }),
        shots.get("karaoke"),
        "no captionStyle renders exactly as an explicit karaoke profile",
      );
      const viaOption = await still("option", {
        timeline: timeline({ profile: "phrase" }),
        captionStyle: { profile: "bold-upper" },
      });
      assert.equal(
        changed(viaOption, shots.get("bold-upper")!),
        0,
        "a render option wins over the timeline's captionStyle",
      );
      for (const [a, b] of [
        ["karaoke", "outline-pop"],
        ["outline-pop", "italic-shadow"],
        ["word-box", "line-box"],
        ["chunky-stack", "editorial-mix"],
        ["clean-sentence", "typewriter"],
        ["phrase", "single-punch"],
      ] as const)
        assert.ok(changed(shots.get(a)!, shots.get(b)!) > 200, `${a} and ${b} differ`);
      const zone = CAPTION_SAFE_ZONE.vertical;
      for (const profile of BLOCKS) {
        const shot = shots.get(profile)!;
        assert.equal(
          changed(shot, clean, 0, Math.ceil(zone.bottom * k), W, H),
          0,
          `${profile} clear of the bottom 400 px`,
        );
        assert.equal(
          changed(shot, clean, Math.ceil(zone.right * k), 0, W, H),
          0,
          `${profile} clear of the right 140 px`,
        );
        assert.equal(
          changed(shot, clean, 0, 0, W, Math.floor(zone.top * k)),
          0,
          `${profile} below the top of the core`,
        );
      }
    } finally {
      await browser.close({ silent: true });
      if (!keep) rmSync(root, { recursive: true, force: true });
    }
  },
);
