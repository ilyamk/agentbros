import { renderStill, type ChromiumOptions, type HeadlessBrowser } from "@remotion/renderer";
import type { VideoConfig } from "remotion";
import { measureScript, type PageMeasurement } from "./page-measure";
import type { PlatformFont } from "./text-checks";

type Page = Awaited<ReturnType<HeadlessBrowser["newPage"]>>;
export type Session = {
  serveUrl: string;
  browser: HeadlessBrowser;
  composition: VideoConfig;
  inputProps: Record<string, unknown>;
  chromiumOptions: ChromiumOptions;
};
export type PageEvents = { onException: (message: string) => void; onConsoleError: (message: string) => void };
type ExceptionEvent = { exceptionDetails: { text?: string; exception?: { description?: string } } };

const SEEK_TIMEOUT_MS = 30000;

/** One composition page, positioned on a frame and ready to be read. */
export class FramePage {
  exceptions = 0;
  private fontsReady = false;

  constructor(
    private readonly page: Page,
    private readonly composition: VideoConfig,
  ) {}

  private async send<T>(method: string, params?: unknown): Promise<T> {
    const client = this.page._client() as unknown as {
      send: (method: string, params?: unknown) => Promise<{ value: T }>;
    };
    return (await client.send(method, params)).value;
  }

  /** Throws if the page cancels the render or does not settle. */
  async seek(frame: number): Promise<void> {
    await this.page.evaluate(`window.remotion_setFrame(${frame}, ${JSON.stringify(this.composition.id)}, 0)`);
    const deadline = Date.now() + SEEK_TIMEOUT_MS;
    for (;;) {
      const state = await this.page.evaluate(
        `window.remotion_renderReady === true ? "ready" : window.remotion_cancelledError !== undefined ? String(window.remotion_cancelledError) : ""`,
      );
      if (state === "ready") break;
      if (state) throw new Error(String(state));
      if (Date.now() > deadline)
        throw new Error(`Frame ${frame} did not settle within ${SEEK_TIMEOUT_MS}ms: a delayRender() handle is open.`);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await this.page.evaluate("document.fonts.ready.then(() => true)");
  }

  measure(): Promise<PageMeasurement> {
    return this.page.evaluate(
      measureScript({ width: this.composition.width, height: this.composition.height }),
    ) as Promise<PageMeasurement>;
  }

  /** The fonts Chromium drew a measured node with, by its index in the last `measure`. */
  async platformFonts(index: number): Promise<PlatformFont[]> {
    if (!this.fontsReady) {
      await this.send("DOM.enable");
      await this.send("CSS.enable");
      await this.send("DOM.getDocument");
      this.fontsReady = true;
    }
    const { result } = await this.send<{ result: { objectId: string } }>("Runtime.evaluate", {
      expression: `window.__motionCheckNodes[${index}]`,
    });
    const { nodeId } = await this.send<{ nodeId: number }>("DOM.requestNode", { objectId: result.objectId });
    const { fonts } = await this.send<{ fonts: PlatformFont[] }>("CSS.getPlatformFontsForNode", { nodeId });
    await this.send("Runtime.releaseObject", { objectId: result.objectId });
    return fonts;
  }

  async capture(): Promise<Buffer> {
    const { width, height } = this.composition;
    const { data } = await this.send<{ data: string }>("Page.captureScreenshot", {
      format: "png",
      clip: { x: 0, y: 0, width, height, scale: 1 },
      captureBeyondViewport: true,
      optimizeForSpeed: true,
      fromSurface: true,
    });
    return Buffer.from(data, "base64");
  }

  /** Keep layout and media in place while measuring the backdrop under the glyphs. */
  async captureTextBackdrop(): Promise<Buffer> {
    await this.page.evaluate(`(() => {
      const style = document.createElement("style");
      style.id = "__motionCheckBackdrop";
      style.textContent = "* { -webkit-text-fill-color: transparent !important; -webkit-text-stroke-color: transparent !important; text-shadow: none !important; } svg text, svg tspan { fill: transparent !important; stroke: transparent !important; }";
      document.head.append(style);
    })()`);
    try {
      return await this.capture();
    } finally {
      await this.page.evaluate('document.getElementById("__motionCheckBackdrop")?.remove(); true');
    }
  }
}

/**
 * Opens a page on `frame` using Remotion's own still pipeline, then runs `work` before
 * the page closes. renderStill awaits page.close() before stopping its server, so
 * holding that call keeps staticFile() and offthread video requests alive for later seeks.
 * Returns the reason the page could not open, if any.
 */
export async function withFramePage(
  session: Session,
  frame: number,
  events: PageEvents,
  work: (page: FramePage) => Promise<void>,
): Promise<string | undefined> {
  const { browser, composition, serveUrl, inputProps, chromiumOptions } = session;
  const newPage = browser.newPage;
  let threw = false;
  let workFailed = false;
  let workError: unknown;
  browser.newPage = (async (options: Parameters<HeadlessBrowser["newPage"]>[0]) => {
    browser.newPage = newPage;
    const page = await newPage.call(browser, options);
    const framePage = new FramePage(page, composition);
    (page._client() as unknown as { on: (event: string, handler: (event: ExceptionEvent) => void) => void }).on(
      "Runtime.exceptionThrown",
      ({ exceptionDetails }) => {
        threw = true;
        framePage.exceptions++;
        events.onException(exceptionDetails.exception?.description ?? exceptionDetails.text ?? "Unknown exception");
      },
    );
    const close = page.close.bind(page);
    page.close = async (closeOptions) => {
      page.close = close;
      if (!threw)
        try {
          await work(framePage);
        } catch (error) {
          workFailed = true;
          workError = error;
        }
      await close(closeOptions);
    };
    return page;
  }) as HeadlessBrowser["newPage"];
  try {
    await renderStill({
      serveUrl,
      composition,
      inputProps,
      frame,
      imageFormat: "jpeg",
      puppeteerInstance: browser,
      chromiumOptions,
      logLevel: "error",
      onBrowserLog: (log) => {
        const source = log.stackTrace[0]?.url;
        if (log.type !== "error" || `${log.text} ${source}`.includes("favicon")) return;
        events.onConsoleError(source && !log.text.includes(source) ? `${log.text} (${source})` : log.text);
      },
    });
  } catch (error) {
    if (workFailed) throw workError;
    return threw ? "The page threw while loading this frame." : error instanceof Error ? error.message : String(error);
  } finally {
    browser.newPage = newPage;
  }
  if (workFailed) throw workError;
  return undefined;
}
