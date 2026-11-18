/**
 * End-to-end checks of the built console in fixture mode (RUN_CONSOLE_E2E=1 pnpm console:e2e): screenshots at 1280 and
 * 390 px in dark and light into out/qa/console/, axe with no serious violation, the main flows, and the strict CSP.
 */
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

test.skip(process.env.RUN_CONSOLE_E2E !== "1", "set RUN_CONSOLE_E2E=1 to run the console end-to-end tests");

// Playwright runs from the repository root (pnpm console:e2e); evidence stays in the git-ignored out/qa/.
const QA = path.resolve(process.cwd(), "out/qa/console");
const NONCE = "e2eNonce0123456789abcdef";
const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  `style-src 'self' 'nonce-${NONCE}'`,
  "img-src 'self'",
  "media-src 'self'",
  "font-src 'self'",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

/** Serves index.html as the console server will: a strict CSP header and the nonce in a meta tag. */
async function strictCsp(page: Page) {
  await page.route(
    (url) => url.pathname === "/" || url.pathname.endsWith("/index.html"),
    async (route) => {
      const response = await route.fetch();
      const body = (await response.text()).replace("<head>", `<head><meta name="csp-nonce" content="${NONCE}">`);
      await route.fulfill({ response, body, headers: { ...response.headers(), "content-security-policy": CSP } });
    },
  );
  const violations: string[] = [];
  page.on("console", (message) => {
    if (/Content Security Policy|Refused to/i.test(message.text())) violations.push(message.text());
  });
  await page.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (event) => {
      (window as unknown as { __csp: string[] }).__csp ??= [];
      (window as unknown as { __csp: string[] }).__csp.push(
        `${event.violatedDirective} ${event.blockedURI} ${event.sample}`,
      );
    });
  });
  return async () => {
    const inPage = await page.evaluate(() => (window as unknown as { __csp?: string[] }).__csp ?? []);
    return [...violations, ...inPage];
  };
}

/** Full-page screenshot from the top (a focused card or a clicked panel may have scrolled the page). */
async function shot(page: Page, name: string) {
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: path.join(QA, name), fullPage: true });
}

async function axe(page: Page) {
  const results = await new AxeBuilder({ page }).analyze();
  return results.violations
    .filter((violation) => ["serious", "critical"].includes(violation.impact ?? ""))
    .map((violation) => ({
      id: violation.id,
      nodes: violation.nodes.map((node) => node.target.join(" ")).slice(0, 5),
    }));
}

for (const theme of ["dark", "light"] as const) {
  for (const width of [1280, 390]) {
    test(`project canvas ${theme} ${width}px: screenshot and accessibility`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      await page.goto(`./?fixture=view-film-build&lang=en&theme=${theme}`);
      await expect(page.getByRole("heading", { level: 1, name: "Acme launch promo" })).toBeVisible();
      await expect(page.getByRole("heading", { name: "Waiting for you (1)" })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.classList.contains("dark"))).toBe(theme === "dark");
      expect(await page.evaluate(() => document.documentElement.scrollWidth), "no horizontal page scroll").toBe(width);
      // open every collapsed panel (money table and chart, assets, history, done steps) so axe and the screenshot see them
      const closed = page.locator('[data-panel] > h2 > button[aria-expanded="false"]');
      for (let guard = 0; guard < 20 && (await closed.count()) > 0; guard++) await closed.first().click();
      await expect(page.locator(".recharts-wrapper").first()).toBeVisible();
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
        "no horizontal scroll with panels open",
      ).toBe(width);
      await shot(page, `canvas-${theme}-${width}.png`);
      expect(await axe(page)).toEqual([]);
    });

    test(`home ${theme} ${width}px: screenshot and accessibility`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      await page.goto(`./?fixture=projects-response&lang=en&theme=${theme}#/`);
      await expect(page.getByRole("heading", { level: 1, name: "Home" })).toBeVisible();
      await shot(page, `home-${theme}-${width}.png`);
      expect(await axe(page)).toEqual([]);
    });
  }
}

for (const theme of ["dark", "light"] as const) {
  for (const [name, hash] of [
    ["settings", "#/settings"],
    ["history", "#/projects/promo-acme/history"],
  ] as const) {
    test(`${name} ${theme}: screenshot and accessibility`, async ({ page }) => {
      await page.setViewportSize({ width: 1280, height: 800 });
      await page.goto(`./?fixture=view-film-build&lang=en&theme=${theme}${hash}`);
      await expect(
        page.getByRole("heading", {
          level: name === "settings" ? 1 : 2,
          name: name === "settings" ? "Settings" : "History",
        }),
      ).toBeVisible();
      await shot(page, `${name}-${theme}-1280.png`);
      expect(await axe(page)).toEqual([]);
    });
  }
}

test("an open dialog passes axe (reduced motion)", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("./?fixture=view-film-build&lang=en&theme=dark");
  await page
    .locator("[data-card='decision']")
    .first()
    .getByRole("button", { name: /Approve · Send/ })
    .click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.waitForTimeout(300); // past any enter transition, so axe measures final colours
  expect(await axe(page)).toEqual([]);
});

test("all seven agent cards render, in Russian too", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("./?fixture=cards&lang=ru&theme=dark");
  await expect(page.locator("[data-card-kind]")).toHaveCount(7);
  await shot(page, "cards-ru-dark-1280.png");
  expect(await axe(page)).toEqual([]);
});

test("approves the gate with edited words, then resumes the paused project", async ({ page }) => {
  await page.goto("./?fixture=view-film-script-gate&lang=en&theme=dark");
  const card = page.locator("[data-card='decision']").first();
  await expect(card).toBeVisible();
  const words = card.getByLabel("Your words");
  await words.fill("B, but shorter hook");
  await card.getByRole("button", { name: /Approve · Send/ }).click();
  await expect(page.getByRole("heading", { name: /Waiting for you/ })).toHaveCount(0);
  await page.getByRole("button", { name: "Resume" }).first().click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("textbox")).toHaveValue("Resume the project.");
  await dialog.getByRole("button", { name: "Resume" }).click();
  await expect(page.getByRole("button", { name: "Pause" }).first()).toBeVisible();
});

test("keyboard: j focuses a card, / opens search", async ({ page }) => {
  await page.goto("./?fixture=view-film-build&lang=en&theme=dark");
  await expect(page.getByRole("heading", { name: "Waiting for you (1)" })).toBeVisible();
  await page.keyboard.press("j");
  await expect(page.locator("[data-card]:focus")).toHaveCount(1);
  await page.keyboard.press("/");
  await expect(page.getByPlaceholder("Search projects, steps and pages…")).toBeVisible();
});

test("strict CSP: no violation while opening dialogs, sheets, menus, palette and chart", async ({ page }) => {
  const collect = await strictCsp(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("./?fixture=view-film-build&lang=en&theme=dark");
  await expect(page.getByRole("heading", { level: 1, name: "Acme launch promo" })).toBeVisible();
  // the spend chart and jobs table
  const money = page.getByRole("button", { name: /^Money/ });
  if ((await money.getAttribute("aria-expanded")) === "false") await money.click();
  await expect(page.locator(".recharts-wrapper").first()).toBeVisible();
  // a confirm dialog (consequential option) and the control dialog
  await page
    .locator("[data-card='decision']")
    .first()
    .getByRole("button", { name: /Approve · Send/ })
    .click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Pause" }).first().click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  // the search palette
  await page.keyboard.press("/");
  await expect(page.getByPlaceholder("Search projects, steps and pages…")).toBeVisible();
  await page.keyboard.press("Escape");
  // settings: Radix Select
  await page.goto("./?fixture=view-film-build&lang=en&theme=dark#/settings");
  await page.getByRole("combobox", { name: "Theme" }).click();
  await expect(page.getByRole("option", { name: "Light" })).toBeVisible();
  await page.keyboard.press("Escape");
  // the mobile sheet
  await page.setViewportSize({ width: 390, height: 800 });
  await page.getByRole("button", { name: "Open navigation" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  expect(await collect()).toEqual([]);
});
