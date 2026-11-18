import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { bundle } from "@remotion/bundler";
import { enableTailwind } from "@remotion/tailwind-v4";
import { openBrowser, selectComposition, renderMedia, makeCancelSignal } from "@remotion/renderer";
import { prepareRenderFontContext } from "../font-resources/render-context";
import { hashFile } from "../assets/registry";
import { registerOwnedRenderProcesses } from "./bounded-worker";
import type { projectChapterPlan } from "./runner";
export type ChapterWorkerRequest = {
  job: ReturnType<typeof projectChapterPlan>["jobs"][number];
  temporary: string;
  rootDir: string;
  codeRoot: string;
  serveUrl?: string;
  concurrency?: number;
};

async function main() {
  const request = JSON.parse(readFileSync(process.argv[2], "utf8")) as ChapterWorkerRequest;
  const { job, rootDir, codeRoot, temporary } = request;
  const assertFonts = () => {
    for (const [file, hash] of Object.entries(job.fontCapture?.hashes ?? {}))
      if (!existsSync(file) || hashFile(file) !== hash) throw new Error("Chapter font source changed during rendering");
  };
  assertFonts();
  const fonts = job.fontCapture
    ? prepareRenderFontContext(job.props.projectId, job.fontCapture.contextFile, job.props, rootDir)
    : undefined;
  const serveUrl =
    request.serveUrl ??
    (await bundle({
      entryPoint: path.join(codeRoot, "src/index.ts"),
      publicDir: path.join(rootDir, "public"),
      webpackOverride: (configuration) => {
        const config = enableTailwind(configuration);
        return fonts
          ? {
              ...config,
              resolve: {
                ...config.resolve,
                alias: {
                  ...config.resolve?.alias,
                  [path.join(codeRoot, "src/lib/fonts.ts")]: fonts.modulePath,
                  [path.join(codeRoot, "src/lib/fonts")]: fonts.modulePath,
                },
              },
            }
          : config;
      },
    }));
  const browser = await openBrowser("chrome", { logLevel: "error" });
  await registerOwnedRenderProcesses();
  const cancel = makeCancelSignal();
  try {
    const composition = await selectComposition({
      serveUrl,
      id: job.compositionId,
      inputProps: job.props,
      puppeteerInstance: browser,
    });
    let lastLogged = 0;
    await renderMedia({
      serveUrl,
      composition,
      inputProps: job.props,
      codec: "h264",
      outputLocation: temporary,
      puppeteerInstance: browser,
      cancelSignal: cancel.cancelSignal,
      concurrency: request.concurrency,
      logLevel: "error",
      onProgress: (progress) => {
        process.send?.({ renderedFrames: progress.renderedFrames, encodedFrames: progress.encodedFrames });
        if (Date.now() - lastLogged > 30000) {
          lastLogged = Date.now();
          process.stderr.write(`Chapter ${job.chapterId}: ${progress.renderedFrames}/${job.durationInFrames} frames\n`);
        }
      },
    });
    assertFonts();
  } finally {
    cancel.cancel();
    await registerOwnedRenderProcesses();
    await browser.close({ silent: true });
  }
}
main()
  .then(async () => {
    await registerOwnedRenderProcesses();
    process.disconnect?.();
  })
  .catch(async (error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : error}\n`);
    try {
      await registerOwnedRenderProcesses();
    } catch (cleanup) {
      process.stderr.write(`Owned cleanup registration: ${String(cleanup)}\n`);
    }
    process.exitCode = 1;
    process.disconnect?.();
  });
