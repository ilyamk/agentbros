import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { bundle } from "@remotion/bundler";
import { enableTailwind } from "@remotion/tailwind-v4";
import { openBrowser, renderStill, selectComposition, makeCancelSignal } from "@remotion/renderer";
import { fontContextWebpackAlias } from "../src/lib/font-resources/render-context";
import {
  fixture,
  requirements,
  fontContext,
  formats,
  expectedCopy,
  entrySource,
  assertProtected,
  fontFile,
  fontSha,
  pin,
  rendererSourcePins,
} from "./helpers/review-authored-copy-proof";
import { cleanupCopyRun, type CopyOperationState } from "./helpers/copy-run-cleanup";
import { type CopyCriterion } from "./helpers/copy-text-geometry";
import { type CopyBox, type CopyDiagnosticBox } from "./helpers/copy-canvas-geometry";
import { exactCopyFacesReady } from "./helpers/copy-canvas-geometry";
interface DomProof {
  frame: number;
  fontsReady: boolean;
  shadowVisible: boolean;
  canvasRect: { x: number; y: number; width: number; height: number };
  expectedWidth: number;
  expectedHeight: number;
  markerInCanvas: boolean;
  stable: boolean;
  expectedFaces: { family: string; weight: number; style: string }[];
  fontFaces: { family: string; weight: string; style: string; status: string }[];
  texts: {
    rectangleValidity: "valid" | "invalid";
    elementCriterion: CopyCriterion;
    textCriterion: CopyCriterion;
    nodes: unknown[];
    key: "headline" | "subtext";
    text: string;
    rawRect: CopyDiagnosticBox;
    rect: CopyDiagnosticBox;
    fontFamily: string;
    fontSize: string;
    opacity: string;
    whiteSpace: string;
  }[];
}
test(
  "actual authored-copy production stills: two scene kinds × three formats × baseline/mapped/Undo (18 PNG only)",
  { skip: process.env.RUN_COPY_STILL_TESTS !== "1", timeout: 180000 },
  async () => {
    const started = Date.now(),
      deadline = started + 175000,
      { browser: executable, evidence } = requirements();
    assert.equal(
      fs.readdirSync(evidence).filter((file) => file.endsWith(".png")).length,
      0,
      "Fresh evidence directory, no existing PNGs",
    );
    const runtimeSourcePins = rendererSourcePins();
    const root = fs.mkdtempSync(path.join(tmpdir(), "copy-stills-")),
      codeRoot = process.cwd(),
      { cancelSignal, cancel } = makeCancelSignal();
    let operation: CopyOperationState = "idle",
      primaryFailure: unknown;
    let browser: Awaited<ReturnType<typeof openBrowser>> | undefined;
    let ownedBrowserClosed = false;
    const reports: unknown[] = [];
    const diagnostics: unknown[] = [];
    let bytes = 0;
    const externalRequests: string[] = [],
      protocolErrors: string[] = [],
      pending = new Set<Promise<unknown>>();
    // Test-only deadline also closes the exact owned browser. The root launcher still supplies the finite outer process boundary.
    const timer = setTimeout(() => {
      if (operation === "active" || operation === "failed") {
        operation = "failed";
        cancel();
      }
      void browser?.close({ silent: true }).catch((error) => protocolErrors.push(String(error)));
    }, 175000);
    try {
      browser = await openBrowser("chrome", { browserExecutable: executable, logLevel: "error" });
      // Attach before each owned renderer page navigates; no external font/resource fallback is permitted.
      const newPage = browser.newPage.bind(browser);
      browser.newPage = async (options) => {
        const page = await newPage(options);
        const cdp = page._client() as unknown as {
          send(method: string, params: object): Promise<unknown>;
          on(event: string, callback: (event: { requestId: string; request: { url: string } }) => void): void;
        };
        cdp.on("Fetch.requestPaused", (event) => {
          let allowed = false;
          try {
            const u = new URL(event.request.url);
            allowed =
              (u.protocol === "http:" &&
                (u.hostname === "127.0.0.1" || u.hostname === "localhost" || u.hostname === "[::1]")) ||
              ["data:", "blob:", "about:"].includes(u.protocol);
          } catch {}
          if (!allowed) {
            externalRequests.push(event.request.url);
            cancel();
          }
          const p = cdp
            .send(
              allowed ? "Fetch.continueRequest" : "Fetch.failRequest",
              allowed ? { requestId: event.requestId } : { requestId: event.requestId, errorReason: "BlockedByClient" },
            )
            .catch((error) => {
              protocolErrors.push(String(error));
              cancel();
            })
            .finally(() => pending.delete(p));
          pending.add(p);
        });
        await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*" }] });
        return page;
      };
      for (const hook of [false, true]) {
        const f = fixture(root, hook),
          fonts = fontContext(f, root),
          fontPins = Object.fromEntries(fonts.captureFiles.map((file) => [path.relative(root, file), pin(file)])),
          entryPoint = path.join(root, f.id + ".tsx");
        fs.writeFileSync(entryPoint, entrySource(codeRoot, fonts.manifest));
        const serveUrl = await bundle({
          entryPoint,
          publicDir: path.join(root, "public"),
          outDir: path.join(root, f.id + "-bundle"),
          webpackOverride: (config) => {
            const c = fontContextWebpackAlias(enableTailwind(config), fonts.modulePath);
            return { ...c, resolve: { ...c.resolve, modules: [path.join(codeRoot, "node_modules"), "node_modules"] } };
          },
        });
        const phaseHashes = new Map<string, string>();
        for (const phase of ["baseline", "mapped", "undo"] as const) {
          if (phase === "mapped") {
            const proposal = f.service.authoredCopyProposal(f.request);
            f.service.mutate({ action: "edit", expectedRevision: 0, command: proposal.command });
          }
          if (phase === "undo") {
            f.service.mutate({ action: "undo", expectedRevision: 1 });
            assert.deepEqual(f.service.store.read().timeline, f.original.timeline);
          }
          assertProtected(f);
          for (const format of formats) {
            assert.ok(Date.now() + 2000 < deadline, "No new frame after case deadline");
            const props = f.props(format),
              copy = expectedCopy(props),
              remaining = Math.min(30000, deadline - Date.now());
            operation = "active";
            const composition = await selectComposition({
              serveUrl,
              id: "Copy" + format,
              inputProps: props,
              puppeteerInstance: browser,
              timeoutInMilliseconds: remaining,
              logLevel: "error",
            });
            assert.equal(composition.durationInFrames, 90);
            assert.equal(composition.fps, 30);
            let dom: DomProof | undefined;
            const output = path.join(evidence, f.id + "-" + format + "-" + phase + "-30.png");
            assert.ok(!fs.existsSync(output), "Fresh evidence directory: no overwrite");
            await renderStill({
              serveUrl,
              composition,
              inputProps: props,
              frame: 30,
              output,
              imageFormat: "png",
              puppeteerInstance: browser,
              cancelSignal,
              timeoutInMilliseconds: Math.min(30000, deadline - Date.now()),
              logLevel: "error",
              onBrowserLog: (log) => {
                if (log.text.startsWith("COPY_DIAGNOSTIC:")) {
                  diagnostics.push({
                    kind: hook ? "hook" : "legacy",
                    format,
                    phase,
                    frame: 30,
                    data: JSON.parse(log.text.slice(16)),
                  });
                  fs.writeFileSync(
                    path.join(evidence, "copy-dom-diagnostics.json"),
                    JSON.stringify(diagnostics, null, 2),
                  );
                }
                if (log.text.startsWith("COPY_PROOF:")) {
                  const data = JSON.parse(log.text.slice(11)) as DomProof;
                  if (data.frame === 30) dom = data;
                }
              },
            });
            operation = "normal";
            const outputBytes = fs.statSync(output).size;
            assert.ok(outputBytes + bytes <= 512 * 1024 * 1024, "Bound before reading written PNG");
            const png = fs.readFileSync(output);
            bytes += png.length;
            assert.ok(
              fs.readdirSync(evidence).filter((file) => file.endsWith(".png")).length <= 18,
              "All written diagnostic PNGs count against fixed quota",
            );
            assert.ok(process.memoryUsage().rss <= 1536 * 1024 * 1024, "Node RSS bound (not aggregate browser memory)");
            assert.ok(bytes <= 512 * 1024 * 1024);
            assert.ok(png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])));
            assert.equal(png.readUInt32BE(16), composition.width);
            assert.equal(png.readUInt32BE(20), composition.height);
            assert.ok(dom, "Actual DOM receipt required");
            assert.equal(dom.fontsReady, true);
            assert.equal(dom.stable, true);
            assert.deepEqual(
              dom.expectedFaces,
              fonts.manifest.faces.map(({ family, weight, style }) => ({ family, weight, style })),
            );
            assert.equal(exactCopyFacesReady(dom.expectedFaces, dom.fontFaces), true);
            assert.equal(dom.markerInCanvas, true);
            assert.equal(dom.expectedWidth, composition.width);
            assert.equal(dom.expectedHeight, composition.height);
            assert.equal(dom.canvasRect.width, composition.width);
            assert.equal(dom.canvasRect.height, composition.height);
            assert.equal(dom.shadowVisible, false);
            assert.deepEqual(
              dom.texts.map((row) => [row.key, row.text]),
              [
                ["headline", copy.headline],
                ["subtext", copy.subtext],
              ],
            );
            for (const row of dom.texts) {
              assert.equal(row.rectangleValidity, "valid", "Intrinsic invalid geometry remains refused");
              assert.ok(
                Object.values(row.rect).every((value) => typeof value === "number" && Number.isFinite(value)),
                "Receipt coordinates must be finite numbers before acceptance",
              );
              const rect = row.rect as CopyBox;
              assert.equal(row.elementCriterion.name, "copy-element-box-v1");
              assert.ok(["pass", "fail"].includes(row.elementCriterion.result));
              const elementFit =
                rect.x >= 0 &&
                rect.y >= 0 &&
                rect.width > 0 &&
                rect.height > 0 &&
                rect.x + rect.width <= composition.width &&
                rect.y + rect.height <= composition.height;
              assert.equal(
                row.elementCriterion.result,
                elementFit ? "pass" : "fail",
                "Element criterion remains independently strict",
              );
              assert.equal(row.textCriterion.name, "copy-text-lines-v1");
              assert.equal(row.textCriterion.result, "pass", JSON.stringify(row));
              assert.deepEqual(row.textCriterion.issues, []);
              assert.ok(row.nodes.length > 0);
              assert.ok(Number(row.opacity) > 0);
              assert.ok(row.fontFamily.includes(fonts.manifest.roles.primaryFont));
            }
            const sha = pin(output),
              baselineKey = format + "-baseline";
            if (phase === "mapped") assert.notEqual(sha, phaseHashes.get(baselineKey));
            if (phase === "undo") assert.equal(sha, phaseHashes.get(baselineKey), "Undo byte-exact PNG");
            phaseHashes.set(format + "-" + phase, sha);
            reports.push({
              kind: hook ? "hook" : "legacy",
              format,
              phase,
              frame: 30,
              width: composition.width,
              height: composition.height,
              sha,
              output,
              dom,
              journalSha256: pin(f.service.store.file),
              canonicalSha: f.canonicalSha,
              fontPins,
              nodeRss: process.memoryUsage().rss,
            });
          }
        }
        assert.deepEqual(
          Object.fromEntries(fonts.captureFiles.map((file) => [path.relative(root, file), pin(file)])),
          fontPins,
        );
      }
      assert.equal(reports.length, 18);
      assert.equal(fs.readdirSync(evidence).filter((file) => file.endsWith(".png")).length, 18);
      await browser.close({ silent: true });
      ownedBrowserClosed = true;
      browser = undefined;
      await Promise.all(pending);
      assert.equal(externalRequests.length, 0);
      await Promise.all(pending);
      assert.deepEqual(protocolErrors, []);
      assert.equal(pin(fontFile), fontSha);
      assert.deepEqual(rendererSourcePins(), runtimeSourcePins);
      fs.writeFileSync(
        path.join(evidence, "stills-acceptance.json"),
        JSON.stringify(
          {
            reports,
            bytes,
            elapsedMs: Date.now() - started,
            font: {
              file: fontFile,
              sha256: fontSha,
              licence: "local-test-no-redistribution; installed font diagnostic only",
            },
            browserExecutable: { file: executable, sha256: pin(executable) },
            sourcePins: Object.fromEntries(
              [
                "src/components/TitleScene.tsx",
                "src/components/TimelineComposition.tsx",
                "src/lib/review-ui/service.ts",
                "src/lib/fonts.ts",
                "src/lib/font-resources/browser.ts",
                "tests/helpers/review-authored-copy-proof.ts",
                "tests/helpers/copy-canvas-geometry.ts",
                "tests/helpers/copy-text-geometry.ts",
                "tests/helpers/copy-run-cleanup.ts",
                "tests/review-authored-copy-stills.test.ts",
              ].map((file) => [file, pin(path.resolve(file))]),
            ),
            rendererSourcePins: runtimeSourcePins,
            externalRequests,
            protocolErrors,
            apiCalls: 0,
            limits: [
              "Diagnostic explicit Arial role selection, not production brand font acceptance; renderer may synthesize token weights.",
              "Literal LF stored; CSS wrapping preserved, not universal hard line breaks.",
              "18 single-frame stills; no movie/audio/animation/human factual or creative approval.",
              "Node RSS measured only; no claim of aggregate Chrome memory cap.",
              "copy-text-lines-v1 accepts complete typographic fragments inside full frame; independent copy-element-box-v1 may fail. Neither proves painted glyph ink, source truth, safe zones or creative quality.",
            ],
          },
          null,
          2,
        ),
      );
    } catch (error) {
      primaryFailure = error;
      if (operation === "active") operation = "failed";
      throw error;
    } finally {
      clearTimeout(timer);
      const cleanupErrors = await cleanupCopyRun({
        state: operation,
        cancel,
        close: async () => {
          if (browser) {
            await browser.close({ silent: true });
            ownedBrowserClosed = true;
          }
        },
        pending: async () => {
          await Promise.all(pending);
        },
        persist: (errors) => {
          const writtenFiles = fs.readdirSync(evidence).filter((file) => file.endsWith(".png")),
            writtenBytes = writtenFiles.reduce((sum, file) => sum + fs.statSync(path.join(evidence, file)).size, 0);
          bytes = Math.max(bytes, writtenBytes);
          fs.writeFileSync(
            path.join(evidence, "stills-cleanup-diagnostics.json"),
            JSON.stringify(
              {
                completedFrames: reports.length,
                writtenFrames: writtenFiles.length,
                bytes,
                quotaWithinLimits: writtenFiles.length <= 18 && bytes <= 512 * 1024 * 1024,
                externalRequests,
                protocolErrors,
                cleanupErrors: errors,
                operation,
                primaryFailure: primaryFailure ? String(primaryFailure) : undefined,
                elapsedMs: Date.now() - started,
                ownedBrowserClosed,
              },
              null,
              2,
            ),
          );
          assert.ok(
            writtenFiles.length <= 18 && bytes <= 512 * 1024 * 1024,
            "All failed/partial written PNGs count against fixed quota",
          );
        },
        remove: () => fs.rmSync(root, { recursive: true, force: true }),
      });
      if (cleanupErrors.length) {
        console.error(
          "COPY_CLEANUP_FAILURE:" +
            JSON.stringify({
              primaryFailure: primaryFailure ? String(primaryFailure) : undefined,
              errors: cleanupErrors,
            }),
        );
        if (!primaryFailure) throw Error("Owned cleanup failed: " + cleanupErrors.join("; "));
      }
    }
  },
);
