/**
 * Session hardening end to end (RFC 0004 D15, A1; RUN_CONSOLE_E2E=1 pnpm console:e2e): a real console server
 * (tests/helpers/console-timeline-server.ts) over a temporary checkout.
 *
 * - The token URL opens the canvas; the cookie holds a derived value, never the token; a reload keeps the session
 *   (the tab's sessionStorage), and the token never comes back from the server.
 * - A1: a fresh browser context (a harness preview pane) opening a next-step answer's one-use pairing link reaches the
 *   canvas; the same link in another fresh context is refused; Settings lists the paired browser.
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const DIST = path.resolve(process.cwd(), "out/console/dist");
const PROJECT = "film-1";

let root = "";
let child: ChildProcess | undefined;
let server: { origin: string; token: string } | undefined;

test.beforeAll(async () => {
  root = mkdtempSync(path.join(os.tmpdir(), "console-session-e2e-"));
  child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      path.resolve(process.cwd(), "tests/helpers/console-timeline-server.ts"),
      "--root",
      root,
      "--dist",
      DIST,
      "--projects",
      "1",
      "--capture-browser",
    ],
    {
      cwd: process.cwd(),
      stdio: ["pipe", "pipe", "inherit"],
      env: { ...process.env, AGENTBROS_EVENTS: "off", AGENTBROS_HOOKS: "off", FAL_KEY: undefined },
    },
  );
  const line = await new Promise<string>((resolve, reject) => {
    child!.once("exit", (code) => reject(new Error(`console server exited (${code})`)));
    createInterface({ input: child!.stdout! }).once("line", resolve);
  });
  server = JSON.parse(line) as { origin: string; token: string };
});

test.afterAll(async () => {
  if (child && child.exitCode === null) {
    const exited = new Promise((resolve) => child!.once("exit", resolve));
    child.stdin?.end();
    await exited;
  }
  if (root) rmSync(root, { recursive: true, force: true });
});

/** What a next-step answer does: a one-use code for this checkout (src/lib/console/pairing.ts). */
function issueCode(): string {
  const module = path.resolve(process.cwd(), "src/lib/console/pairing.ts");
  const script = `const { issuePairingCode } = await import(${JSON.stringify(module)}); process.stdout.write(issuePairingCode(process.argv[1]));`;
  return execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script, root], {
    cwd: process.cwd(),
    encoding: "utf8",
  }).trim();
}

const onCanvas = (page: Page) =>
  expect(page.locator('nav a[aria-current="page"]', { hasText: /^Canvas$/ })).toBeVisible({ timeout: 15_000 });

test("token URL: derived cookie, the token never served back, and a reload keeps the session", async ({ page }) => {
  const sessionReplies: string[] = [];
  page.on("response", async (response) => {
    if (new URL(response.url()).pathname.startsWith("/api/session"))
      sessionReplies.push(await response.text().catch(() => ""));
  });
  await page.goto(`${server!.origin}/?lang=en#token=${server!.token}&project=${PROJECT}`);
  await onCanvas(page);
  expect(page.url()).not.toContain(server!.token);
  const cookies = await page.context().cookies(server!.origin);
  expect(cookies).toHaveLength(1);
  expect(cookies[0]!.httpOnly).toBe(true);
  expect(cookies[0]!.sameSite).toBe("Strict");
  expect(cookies[0]!.value).not.toBe(server!.token);
  await page.reload();
  await onCanvas(page);
  await expect(page.getByText("did not accept this link")).toHaveCount(0);
  for (const reply of sessionReplies) expect(reply).not.toContain(server!.token);
});

test("A1: a fresh browser opening a pairing link reaches the canvas; the link works once", async ({ browser }) => {
  const code = issueCode();
  expect(code).toMatch(/^[a-f0-9]{32}$/);
  const url = `${server!.origin}/?lang=en#pair=${code}&project=${PROJECT}`;

  const fresh = await browser.newContext();
  try {
    const page = await fresh.newPage();
    await page.goto(url);
    await onCanvas(page);
    expect(page.url()).not.toContain(code);
    // A reload of the paired tab keeps working (the token is in this tab's sessionStorage).
    await page.reload();
    await onCanvas(page);
    // The next answer's link opened in the same pane: a same-document hash change. The code is stripped, the
    // route followed and the code left unredeemed (no second pairing).
    const next = issueCode();
    await page.goto(`${server!.origin}/?lang=en#pair=${next}&project=${PROJECT}`);
    await expect.poll(() => page.url()).not.toContain(next);
    await onCanvas(page);
    // Settings lists the one paired browser.
    await page.evaluate(() => (location.hash = "#/settings"));
    await expect(page.getByTestId("paired-browsers")).toContainText(/Chrome|Chromium|Headless/);
    await expect(page.getByTestId("paired-browsers").locator("li")).toHaveCount(1);
  } finally {
    await fresh.close();
  }

  const second = await browser.newContext();
  try {
    const page = await second.newPage();
    await page.goto(url);
    await expect(page.getByText("did not accept this link")).toBeVisible({ timeout: 15_000 });
  } finally {
    await second.close();
  }
});

test("Settings opens the API keys editor and supports masked editing, copying and saving", async ({ page: paired }) => {
  const legacy = "example-legacy-fal";
  const replacement = "example-new-fal";
  writeFileSync(path.join(root, ".env"), `FAL_KEY=${legacy}\n`, { mode: 0o600 });
  await paired.goto(`${server!.origin}/?lang=en&theme=dark#pair=${issueCode()}`);
  await paired.getByRole("link", { name: "Settings" }).click();
  const pairedField = paired.getByLabel("FAL_KEY", { exact: true });
  await expect(pairedField).toBeVisible();
  await expect(pairedField).toHaveAttribute("type", "password");
  await expect(pairedField).toBeDisabled();
  await expect(pairedField).toHaveValue("");
  const reply = paired.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/credentials/open" && response.request().method() === "POST",
  );
  await paired.getByRole("button", { name: "Edit API keys" }).click();
  expect(await (await reply).json()).toEqual({ ok: true });
  await expect(pairedField).toBeDisabled();

  const page = await paired.context().newPage();
  const handoff = new URL(readFileSync(path.join(root, "browser-url"), "utf8"));
  const capability = new URLSearchParams(handoff.hash.slice(1)).get("credentials")!;
  handoff.searchParams.set("lang", "en");
  handoff.searchParams.set("theme", "dark");
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: server!.origin });
  const paths: string[] = [];
  const violations: string[] = [];
  page.on("request", (req) => {
    if (new URL(req.url()).pathname.startsWith("/api/credentials")) paths.push(req.url());
  });
  page.on("console", (msg) => {
    if (/Content Security Policy|Refused to/i.test(msg.text())) violations.push(msg.text());
  });
  await page.goto(handoff.href);
  await expect(page).toHaveURL(/#\/settings\/api-keys$/);
  expect(page.url()).not.toContain("credential-launch");
  const section = page
    .locator('[data-slot="card"]')
    .filter({ has: page.getByRole("heading", { name: "API keys", exact: true }) });
  const field = section.getByLabel("FAL_KEY", { exact: true });
  await expect(field).toHaveAttribute("type", "password");
  await expect(field).toBeEditable();
  await expect(field).toHaveValue("");
  expect(page.url()).not.toContain(capability);
  expect(paths).toHaveLength(1);
  expect(paths[0]).not.toContain(legacy);

  const fal = section.getByRole("listitem").filter({ has: page.getByRole("link", { name: "fal.ai" }) });
  for (const width of [390, 1280]) {
    await page.setViewportSize({ width, height: 800 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
    const [row, description, input] = await Promise.all([
      fal.boundingBox(),
      fal.getByText(/hosts AI media models/).boundingBox(),
      field.boundingBox(),
    ]);
    expect(description!.width).toBeCloseTo(row!.width);
    expect(input!.x).toBeCloseTo(description!.x);
    expect(input!.y).toBeGreaterThan(description!.y + description!.height);
    expect(input!.width).toBeGreaterThan(row!.width / 2);
    const { violations } = await new AxeBuilder({ page }).include("#api-key-settings").analyze();
    expect(violations.filter(({ impact }) => impact === "critical" || impact === "serious")).toEqual([]);
  }
  await expect(fal.getByRole("link", { name: "fal.ai" })).toHaveAttribute("href", "https://fal.ai/dashboard/keys");
  await expect(fal.getByText(/hosts AI media models/)).toBeVisible();
  await expect(fal.getByText("Key set")).toBeVisible();
  await expect(fal.locator("svg.lucide-circle-check.text-status-done")).toBeVisible();
  await section.getByRole("button", { name: "Show FAL_KEY" }).click();
  await expect(field).toHaveValue(legacy);
  await section.getByRole("button", { name: "Hide FAL_KEY" }).click();
  await expect(field).toHaveValue("");
  await section.getByRole("button", { name: "Copy FAL_KEY" }).click();
  await expect(section.getByText("Key copied.")).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(legacy);

  await field.fill("discard-this-draft");
  await section.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(field).toHaveValue("");
  await field.fill(replacement);
  await section.getByRole("button", { name: "Save", exact: true }).click();
  await expect(section.getByText("API keys saved.")).toBeVisible();
  await expect(field).toHaveValue("");
  await page.reload();
  await section.getByRole("button", { name: "Show FAL_KEY" }).click();
  await expect(field).toHaveValue(replacement);
  await section.getByRole("button", { name: "Remove FAL_KEY" }).click();
  await section.getByRole("button", { name: "Save", exact: true }).click();
  await expect(section.getByRole("button", { name: "Copy FAL_KEY" })).toBeDisabled();
  await expect(fal.getByText("No key")).toBeVisible();
  await expect(fal.locator("svg.lucide-circle-alert.text-status-paused")).toBeVisible();
  expect(paths.every((url) => ![legacy, replacement, capability].some((value) => url.includes(value)))).toBe(true);
  expect(violations).toEqual([]);
});
