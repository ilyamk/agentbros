/**
 * RFC 0004 gaps over the real console server (A9, A10/US14, H3): a tsx child (tests/helpers/console-gaps-e2e-server.ts)
 * runs the server with the daemon's actions on a temporary root with a real `film:init` film and two in-flight paid
 * jobs. The user raises the ceiling in the autonomy form (real `film:policy`), stops the project and cancels the one
 * job that can be cancelled (real `job:cancel`, local, no provider), and installs the hooks from Settings (real
 * `harness:setup --hooks --apply`, into the temporary root). Nothing calls a provider; nothing touches this checkout.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

test.skip(process.env.RUN_CONSOLE_E2E !== "1", "set RUN_CONSOLE_E2E=1 to run the console end-to-end tests");

const repo = process.cwd();
const QA = path.join(repo, "out/qa/console");
const PROJECT = "film";

let child: ChildProcess | undefined;
let started: { url: string; root: string } | undefined;

test.beforeAll(async () => {
  child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      path.join(repo, "tests/helpers/console-gaps-e2e-server.ts"),
      path.join(repo, "out/console/dist"),
    ],
    { cwd: repo, stdio: ["pipe", "pipe", "inherit"] },
  );
  const line = await new Promise<string>((resolve, reject) => {
    const lines = createInterface({ input: child!.stdout! });
    lines.once("line", resolve);
    child!.once("exit", (code) => reject(new Error(`gaps e2e server exited with ${code}`)));
  });
  started = JSON.parse(line) as { url: string; root: string };
});

test.afterAll(async () => {
  if (!child || child.exitCode !== null) return;
  const exited = new Promise((resolve) => child!.once("exit", resolve));
  child.kill("SIGTERM");
  await exited;
});

async function open(page: Page, hash: string, theme: "dark" | "light") {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (event) => {
      const w = window as unknown as { __csp?: string[] };
      (w.__csp ??= []).push(`${event.violatedDirective} ${event.blockedURI}`);
    });
  });
  const [origin, fragment] = started!.url.split("#");
  await page.goto(`${origin}?lang=en&theme=${theme}#${fragment}`);
  await page.waitForFunction(() => !location.hash.includes("token="));
  await page.evaluate((target) => (location.hash = target), hash);
  return () => page.evaluate(() => (window as unknown as { __csp?: string[] }).__csp ?? []);
}

async function axe(page: Page, include: string) {
  await page.mouse.move(0, 0);
  const results = await new AxeBuilder({ page }).include(include).analyze();
  return results.violations
    .filter((violation) => ["serious", "critical"].includes(violation.impact ?? ""))
    .map((violation) => ({ id: violation.id, nodes: violation.nodes.map((node) => node.target.join(" ")) }));
}

const policyFile = () => path.join(started!.root, "public/projects", PROJECT, "pipeline/policy.json");

test("raise the ceiling, stop and cancel one paid job, install hooks: over the real server", async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1280, height: 900 });
  const violations = await open(page, `#/projects/${PROJECT}`, "dark");
  const topBar = page.getByRole("banner", { name: "Project" });
  await expect(topBar).toContainText("of $10.00");

  // A10: a raise is confirmed with the server's own argv, then applied by film:policy with the user's words.
  await topBar.getByRole("button", { name: /Change autonomy and budget/ }).click();
  const form = page.getByRole("dialog", { name: "Autonomy and budget" });
  await form.getByLabel("Budget ceiling (USD)").fill("12");
  await form.getByLabel("Your words").fill("Raise it to twelve dollars for the narration.");
  await form.getByRole("button", { name: "Apply" }).click();
  const confirm = page.getByRole("dialog", { name: "Confirm a wider grant" });
  await expect(confirm.locator("[data-policy-command]")).toHaveText(
    'pnpm film:policy --project film "--answer=Raise it to twelve dollars for the narration." --ceiling-usd 12',
  );
  expect(await axe(page, "[role=dialog]")).toEqual([]);
  await page.screenshot({ path: path.join(QA, "gaps-server-autonomy-1280.png") });
  await confirm.getByRole("button", { name: "Confirm and apply" }).click();
  await expect(confirm).toBeHidden({ timeout: 30_000 });
  await expect(topBar).toContainText("of $12.00", { timeout: 10_000 });
  const policy = readFileSync(policyFile(), "utf8");
  expect(policy).toContain("Raise it to twelve dollars for the narration.");
  expect(policy).toContain('"channel": "console"');

  // A9: stop lists both in-flight jobs; only the reserved one can be cancelled, on its own confirmation.
  await page.locator("[data-header-more]").click();
  await page.locator('[data-control="stopped"]').click();
  const stop = page.getByRole("dialog", { name: "Stop the project" });
  await stop.getByRole("button", { name: "Stop" }).click();
  const reserved = stop.locator('[data-job="op-reserved"]');
  const queued = stop.locator('[data-job="op-queued"]');
  await expect(reserved).toContainText("$0.50 reserved", { timeout: 30_000 });
  await expect(queued).toContainText("Cannot be cancelled: the fal job adapter has no cancel call");
  await expect(queued.getByRole("button")).toHaveCount(0);
  await reserved.getByRole("button", { name: "Cancel job op-reserved" }).click();
  expect(await axe(page, "[role=dialog]")).toEqual([]);
  await page.screenshot({ path: path.join(QA, "gaps-server-stop-1280.png") });
  await reserved.getByRole("button", { name: "Cancel this job" }).click();
  await expect(reserved.getByRole("status")).toHaveText("Cancelled.", { timeout: 30_000 });
  await expect(reserved).toHaveAttribute("data-job-state", "cancelled", { timeout: 10_000 });
  const operations = JSON.parse(
    readFileSync(path.join(started!.root, "public/projects", PROJECT, "pipeline/operations.json"), "utf8"),
  ) as { jobs: Record<string, { state: string; reservedMicros: number }> };
  expect(operations.jobs["op-reserved"]?.state).toBe("cancelled");
  expect(operations.jobs["op-reserved"]?.reservedMicros).toBe(0);
  expect(operations.jobs["op-queued"]?.state).toBe("queued");
  await stop.getByRole("button", { name: "Close" }).first().click();

  // D12: the user's own policy change still applies while the project is stopped (the console grant).
  await topBar.getByRole("button", { name: /Change autonomy and budget/ }).click();
  const lower = page.getByRole("dialog", { name: "Autonomy and budget" });
  await lower.getByLabel("Budget ceiling (USD)").fill("11");
  await lower.getByRole("button", { name: "Apply" }).click();
  await expect(lower).toBeHidden({ timeout: 30_000 });
  await expect(topBar).toContainText("of $11.00", { timeout: 10_000 });

  // H3: the real status of the (temporary) checkout; Install runs harness:setup --hooks --apply after the confirm.
  await page.evaluate(() => (location.hash = "#/settings"));
  const hooks = page.locator("[data-hooks-settings]");
  await expect(hooks.locator('[data-hook-state="missing"]')).toHaveCount(2);
  await hooks.getByRole("button", { name: "Install hooks…" }).click();
  const install = page.getByRole("dialog", { name: "Install the harness hooks" });
  await expect(install).toContainText(".claude/settings.local.json");
  await install.getByRole("button", { name: "Install" }).click();
  await expect(hooks.locator("[data-hooks-trust]")).toContainText("Claude Code", { timeout: 30_000 });
  await expect(hooks.locator('[data-hook-state="installed"]')).toHaveCount(2);
  expect(readFileSync(path.join(started!.root, ".codex/hooks.json"), "utf8")).toContain("agentbros-hook");
  expect(await axe(page, "[data-hooks-settings]")).toEqual([]);
  await page.screenshot({ path: path.join(QA, "gaps-server-hooks-1280.png"), fullPage: true });
  expect(await violations()).toEqual([]);
});

test("the autonomy form at 390 px over the real server: no horizontal scroll, light theme", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await open(page, `#/projects/${PROJECT}`, "light");
  await page.getByRole("button", { name: /Change autonomy and budget/ }).click();
  const form = page.getByRole("dialog", { name: "Autonomy and budget" });
  await expect(form.getByRole("radio", { name: /Autonomous/ })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  expect(await axe(page, "[role=dialog]")).toEqual([]);
  await page.screenshot({ path: path.join(QA, "gaps-server-autonomy-390.png") });
});
