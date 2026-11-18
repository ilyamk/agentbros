import path from "node:path";
import { mkdirSync } from "node:fs";
import { bundle } from "@remotion/bundler";
import { selectComposition, renderStill } from "@remotion/renderer";
import { enableTailwind } from "@remotion/tailwind-v4";
import type { ProjectVideoProps } from "../project-props";
import { PROJECT_COMPOSITION_IDS } from "../project-props";
import type { EvidenceEvent } from "./events";
import { artifactHash } from "./frames";
import { prepareRenderFontContext } from "../font-resources/render-context";
export async function renderBrowserEvidence(
  props: ProjectVideoProps,
  events: EvidenceEvent[],
  directory: string,
  options: { rootDir?: string; codeDir?: string; offlineFonts?: boolean; fontContext?: string } = {},
) {
  const codeDir = options.codeDir ?? process.cwd(),
    root = options.rootDir ?? codeDir;
  if (options.offlineFonts && options.fontContext)
    throw new Error("Choose verified font context or smoke-only substitute, not both");
  const font = options.fontContext
    ? prepareRenderFontContext(props.projectId, path.resolve(root, options.fontContext), props, root)
    : undefined;
  mkdirSync(directory, { recursive: true });
  const serveUrl = await bundle({
    entryPoint: path.join(codeDir, "src/index.ts"),
    publicDir: path.join(root, "public"),
    outDir: path.join(directory, "bundle"),
    webpackOverride: (config) => {
      const enhanced = enableTailwind(config);
      if (font)
        return {
          ...enhanced,
          resolve: {
            ...enhanced.resolve,
            alias: { ...enhanced.resolve?.alias, [path.join(codeDir, "src/lib/fonts")]: font.modulePath },
          },
        };
      return options.offlineFonts
        ? {
            ...enhanced,
            resolve: {
              ...enhanced.resolve,
              alias: {
                ...enhanced.resolve?.alias,
                [path.join(codeDir, "src/lib/fonts")]: path.join(codeDir, "tests/fixtures/offline-fonts.ts"),
              },
            },
          }
        : enhanced;
    },
  });
  const inputProps = { ...props, qaEvidence: true };
  const composition = await selectComposition({
    serveUrl,
    id: PROJECT_COMPOSITION_IDS[props.format],
    inputProps,
  });
  const frames = [];
  for (const event of events) {
    const file = path.join(directory, `browser-${String(event.frame).padStart(6, "0")}.png`);
    let measurement: Record<string, unknown> | undefined;
    await renderStill({
      serveUrl,
      composition,
      inputProps,
      frame: event.frame,
      output: file,
      imageFormat: "png",
      logLevel: "error",
      onBrowserLog: (log) => {
        const prefix = "QA_EVIDENCE:";
        if (log.text.startsWith(prefix)) {
          const value = JSON.parse(log.text.slice(prefix.length));
          if (value.frame === event.frame) measurement = value;
        }
      },
    });
    frames.push({
      ...event,
      file,
      sha256: artifactHash(file),
      measurement: measurement ?? null,
    });
  }
  return {
    compositionId: composition.id,
    width: composition.width,
    height: composition.height,
    durationInFrames: composition.durationInFrames,
    fontMode: options.offlineFonts
      ? "offline-substitute-not-production-font-approval"
      : font
        ? "cached-production-fonts"
        : "production-fonts",
    fontContext: font?.contextFile ?? null,
    frames,
    findings: frames.flatMap((f) =>
      f.measurement
        ? ((f.measurement.findings as unknown[]) ?? []).map((finding) => ({
            frame: f.frame,
            finding,
          }))
        : [
            {
              frame: f.frame,
              finding: { code: "MISSING_BROWSER_MEASUREMENT" },
            },
          ],
    ),
    status: "needs-manual-review",
  };
}
