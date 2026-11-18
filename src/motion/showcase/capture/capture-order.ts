/**
 * Records the order page frame by frame at 2x with the real mouse: clicks reach the page's own handlers.
 * pnpm exec tsx src/motion/showcase/capture/capture-order.ts <output.mp4> [chrome-headless-shell]
 */
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { trackPoint } from "../../timing";
import { BUY_CLICK, ORDER_CAPTURE_FRAMES, ORDER_CURSOR_KEYS, ORDER_STAGE, PLUS_CLICKS } from "./order-script";

const [output, chromeArg] = process.argv.slice(2);
if (!output) throw new Error("Usage: capture-order.ts <output.mp4> [chrome-headless-shell]");
const chrome =
  chromeArg ??
  path.resolve(
    "node_modules/.remotion/chrome-headless-shell/mac-arm64/chrome-headless-shell-mac-arm64/chrome-headless-shell",
  );
const pageUrl = `file://${path.resolve("src/motion/showcase/capture/order-page.html")}`;
const work = mkdtempSync(path.join(tmpdir(), "order-capture-"));

const main = async (): Promise<void> => {
  const browser = spawn(chrome, [
    "--no-sandbox",
    "--remote-debugging-port=0",
    "--hide-scrollbars",
    `--user-data-dir=${path.join(work, "profile")}`,
    "about:blank",
  ]);
  const wsUrl = await new Promise<string>((resolve, reject) => {
    browser.once("error", reject);
    let log = "";
    browser.stderr.on("data", (chunk: Buffer) => {
      log += chunk.toString();
      const match = /DevTools listening on (ws:\S+)/.exec(log);
      if (match?.[1]) resolve(match[1]);
    });
  });

  const socket = new WebSocket(wsUrl);
  await new Promise((resolve) => socket.addEventListener("open", resolve, { once: true }));
  let nextId = 1;
  const pending = new Map<
    number,
    { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }
  >();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data)) as {
      id?: number;
      result?: Record<string, unknown>;
      error?: { message: string };
    };
    if (message.id === undefined) return;
    const waiter = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) waiter?.reject(new Error(message.error.message));
    else waiter?.resolve(message.result ?? {});
  });
  const send = (method: string, params: Record<string, unknown> = {}, sessionId?: string) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params, sessionId }));
    });

  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = (await send("Target.attachToTarget", { targetId, flatten: true })) as { sessionId: string };
  const page = (method: string, params: Record<string, unknown> = {}) => send(method, params, sessionId);

  try {
    await page("Page.enable");
    await page("Emulation.setDeviceMetricsOverride", {
      width: ORDER_STAGE.width,
      height: ORDER_STAGE.height,
      deviceScaleFactor: 2,
      mobile: false,
    });
    await page("Page.navigate", { url: pageUrl });
    await page("Runtime.evaluate", {
      expression:
        "new Promise((done) => { const wait = () => document.readyState === 'complete' ? document.fonts.load('800 40px \"Golos Text\"', 'Четверг').then(() => document.fonts.ready).then(() => done(true)) : setTimeout(wait, 50); wait(); })",
      awaitPromise: true,
    });
    const fontCheck = await page("Runtime.evaluate", {
      expression: "document.fonts.check('800 40px \"Golos Text\"', 'Четверг')",
      returnByValue: true,
    });
    if ((fontCheck.result as { value: boolean }).value !== true) throw new Error("Golos Text did not load.");

    const clicks = new Set<number>([...PLUS_CLICKS, BUY_CLICK]);
    for (let frame = 0; frame < ORDER_CAPTURE_FRAMES; frame++) {
      await page("Runtime.evaluate", { expression: `window.__seek(${frame})` });
      const { x, y } = trackPoint(frame, ORDER_CURSOR_KEYS);
      await page("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
      if (clicks.has(frame)) {
        await page("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
        await page("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
      }
      const { data } = (await page("Page.captureScreenshot", { format: "png" })) as { data: string };
      writeFileSync(path.join(work, `f${String(frame).padStart(5, "0")}.png`), Buffer.from(data, "base64"));
    }
    execFileSync("ffmpeg", [
      "-y",
      "-loglevel",
      "error",
      "-framerate",
      "30",
      "-i",
      path.join(work, "f%05d.png"),
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-crf",
      "16",
      "-preset",
      "slow",
      "-movflags",
      "+faststart",
      output,
    ]);
  } finally {
    socket.close();
    // Chrome keeps writing its profile (Session Storage) until it exits; removing the tree before then races it and
    // fails with ENOTEMPTY.
    const exited =
      browser.exitCode !== null || browser.signalCode !== null
        ? Promise.resolve()
        : new Promise((resolve) => browser.once("exit", resolve));
    browser.kill();
    if ((await Promise.race([exited.then(() => true), delay(5000, false, { ref: false })])) === false) {
      browser.kill("SIGKILL");
      await exited;
    }
    rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
};

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
