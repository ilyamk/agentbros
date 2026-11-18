/**
 * Campaign view end-to-end checks (RFC 0004 WP13e, parity rows RU-CP01–06; RUN_CONSOLE_E2E=1 pnpm console:e2e). The
 * built console runs against the real HTTP client: Playwright answers the console API (session, projects, the
 * campaign container's view and its `/api/review/<id>/campaign|selection|file` routes) the way the console server
 * does. The session URL carries `&view=timeline`, so the page opens on the campaign view. It filters, plays a pinned
 * variant, saves an exact selection, shows a 409 without re-sending, and takes screenshots at 1280 and 390 px in both
 * themes into out/qa/console/ with axe and the strict CSP.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { choose } from "./select";

test.skip(process.env.RUN_CONSOLE_E2E !== "1", "set RUN_CONSOLE_E2E=1 to run the console end-to-end tests");

const QA = path.resolve(process.cwd(), "out/qa/console");
const FIXTURES = path.resolve(process.cwd(), "tests/fixtures/console");
const NONCE = "e2eNonce0123456789abcdef";
const TOKEN = "e".repeat(64);
const PROJECT = "spring-batch";
const PLAN = "b".repeat(64);
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

let dir = "";
let clip: Buffer = Buffer.alloc(0);

test.beforeAll(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "console-campaign-e2e-"));
  const mp4 = path.join(dir, "clip.mp4");
  try {
    execFileSync("ffmpeg", [
      "-v", "error", "-y",
      "-f", "lavfi", "-i", "testsrc2=size=270x480:rate=30:duration=1",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart",
      mp4,
    ]); // prettier-ignore
    clip = readFileSync(mp4);
  } catch {
    clip = Buffer.from("not a video"); // the page still lists the pinned variant
  }
});

test.afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

type Choice = { memberId: string; planHash: string; choice: string; note: string };

function campaignState(revision: number, choices: Choice[]) {
  return {
    campaignId: PROJECT,
    planHash: PLAN,
    selection: { revision, planHash: PLAN, choices },
    members: [
      {
        id: "hook-question",
        heldForPilot: false,
        excluded: false,
        productId: "trail-sneaker",
        language: "en",
        factors: { hook: "question", length: "15s" },
        choice: choices.filter((entry) => entry.memberId === "hook-question").at(-1)?.choice,
        tasks: [
          { id: "hook-question-render", state: "complete" },
          { id: "hook-question-qa", state: "complete" },
        ],
        outputs: [{ path: "out/spring-batch/hook-question.mp4", sha256: "c".repeat(64) }],
      },
      {
        id: "hook-demo-de",
        heldForPilot: true,
        excluded: true,
        productId: "winter-boot",
        language: "de",
        factors: { hook: "demo" },
        tasks: [{ id: "hook-demo-de-render", state: "waiting" }],
        outputs: [],
      },
    ],
  };
}

/** Answers the console API as the console server would for one campaign container. */
async function serveConsole(page: Page, options: { conflictOnSave?: boolean } = {}) {
  const posts: unknown[] = [];
  let revision = 0;
  const choices: Choice[] = [];
  const view = JSON.parse(readFileSync(path.join(FIXTURES, "view-empty.json"), "utf8"));
  view.project = { ...view.project, id: PROJECT, route: "campaign", title: "Spring batch" };
  const projects = JSON.parse(readFileSync(path.join(FIXTURES, "projects-response.json"), "utf8"));
  const json = (body: unknown, status = 200) => ({
    status,
    body: JSON.stringify(body),
    headers: { "content-type": "application/json; charset=utf-8" },
  });
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    if (url.pathname === "/api/session") return route.fulfill(json({ ok: true }));
    if (url.pathname === "/api/projects") return route.fulfill(json(projects));
    if (url.pathname === `/api/projects/${PROJECT}/view`) return route.fulfill(json(view));
    if (url.pathname === "/api/stream")
      return route.fulfill({ status: 200, body: ": ok\n\n", headers: { "content-type": "text/event-stream" } });
    if (url.pathname === `/api/review/${PROJECT}/campaign`) {
      expect(request.headers()["x-console-token"]).toBe(TOKEN);
      return route.fulfill(json(campaignState(revision, choices)));
    }
    if (url.pathname === `/api/review/${PROJECT}/selection` && method === "POST") {
      const body = request.postDataJSON() as Choice & { expectedRevision: number };
      posts.push(body);
      if (options.conflictOnSave) {
        revision += 1; // someone else saved meanwhile
        return route.fulfill(json({ ok: false, error: "CONFLICT", message: "Campaign review changed; refresh" }, 409));
      }
      choices.push({ memberId: body.memberId, planHash: body.planHash, choice: body.choice, note: body.note });
      revision += 1;
      return route.fulfill(json({ revision, planHash: PLAN, choices }));
    }
    if (url.pathname === `/api/review/${PROJECT}/file`)
      return route.fulfill({
        status: 200,
        body: clip,
        headers: { "content-type": "video/mp4", "accept-ranges": "bytes", "content-length": String(clip.length) },
      });
    return route.fulfill(json({ ok: false, error: "NOT_FOUND", message: `No route ${url.pathname}` }, 404));
  });
  await page.route(
    (url) => url.pathname === "/" || url.pathname.endsWith("/index.html"),
    async (route) => {
      const response = await route.fetch();
      const body = (await response.text()).replace("<head>", `<head><meta name="csp-nonce" content="${NONCE}">`);
      await route.fulfill({ response, body, headers: { ...response.headers(), "content-security-policy": CSP } });
    },
  );
  await page.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (event) => {
      (window as unknown as { __csp: string[] }).__csp ??= [];
      (window as unknown as { __csp: string[] }).__csp.push(`${event.violatedDirective} ${event.blockedURI}`);
    });
  });
  return { posts, violations: () => page.evaluate(() => (window as unknown as { __csp?: string[] }).__csp ?? []) };
}

const open = (page: Page, theme = "dark") =>
  page.goto(`./?lang=en&theme=${theme}#token=${TOKEN}&project=${PROJECT}&view=timeline`);

async function axe(page: Page) {
  const results = await new AxeBuilder({ page }).analyze();
  return results.violations
    .filter((violation) => ["serious", "critical"].includes(violation.impact ?? ""))
    .map((violation) => ({
      id: violation.id,
      nodes: violation.nodes.map((node) => node.target.join(" ")).slice(0, 5),
    }));
}

test("the session URL opens the campaign view; filter, play and save an exact selection (RU-CP01–06)", async ({
  page,
}) => {
  const { posts, violations } = await serveConsole(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await open(page);
  await expect(page).toHaveURL(new RegExp(`#/projects/${PROJECT}/timeline$`));
  expect(page.url()).not.toContain(TOKEN);
  await expect(page.locator("#campaign-identity")).toHaveText(
    `${PROJECT} · ${"b".repeat(12)} · review draft revision 0`,
  );
  await expect(page.getByText(/user approval and strict delivery remain separate/)).toBeVisible();
  const video = page.getByTestId("campaign-member-hook-question").locator("video");
  await expect(video).toHaveAttribute("src", `/api/review/${PROJECT}/file?path=out%2Fspring-batch%2Fhook-question.mp4`);
  await expect(page.getByTestId("campaign-member-hook-demo-de").getByTestId("campaign-choice")).toHaveAttribute(
    "data-value",
    "reject",
  );

  await page.getByLabel("Filter").fill("WINTER");
  await expect(page.getByTestId("campaign-member-hook-question")).toHaveCount(0);
  await page.getByLabel("Filter").fill("");

  const card = page.getByTestId("campaign-member-hook-question");
  await choose(page, card.getByTestId("campaign-choice"), "fix");
  await card.getByTestId("campaign-note").fill("Open on the shoe, not the logo");
  await card.getByTestId("campaign-save").click();
  await expect(page.locator("#campaign-identity")).toContainText("review draft revision 1");
  await expect(page.locator("#status")).toHaveText("Ready");
  expect(posts).toEqual([
    {
      planHash: PLAN,
      expectedRevision: 0,
      memberId: "hook-question",
      choice: "fix",
      note: "Open on the shoe, not the logo",
      outputs: [{ path: "out/spring-batch/hook-question.mp4", sha256: "c".repeat(64) }],
    },
  ]);
  await expect(card.getByText("fix", { exact: true })).toBeVisible();
  expect(await violations()).toEqual([]);
});

test("a 409 refreshes, keeps the note and never re-sends (G2)", async ({ page }) => {
  const { posts } = await serveConsole(page, { conflictOnSave: true });
  await page.setViewportSize({ width: 1280, height: 900 });
  await open(page);
  const card = page.getByTestId("campaign-member-hook-question");
  await card.getByTestId("campaign-note").fill("Typed before someone else saved");
  await card.getByTestId("campaign-save").click();
  await expect(page.locator("#status")).toHaveText("Campaign review changed; refresh");
  await expect(page.locator("#conflict-notice")).toBeVisible();
  await expect(page.locator("#campaign-identity")).toContainText("review draft revision 1");
  await expect(card.getByTestId("campaign-note")).toHaveValue("Typed before someone else saved");
  expect(posts).toHaveLength(1);
});

for (const theme of ["dark", "light"] as const) {
  for (const width of [1280, 390]) {
    test(`campaign view ${theme} ${width}px: screenshot, accessibility, no horizontal scroll`, async ({ page }) => {
      const { violations } = await serveConsole(page);
      await page.setViewportSize({ width, height: 900 });
      await open(page, theme);
      await expect(page.getByTestId("campaign-view")).toBeVisible();
      await page.screenshot({ path: path.join(QA, `campaign-${theme}-${width}.png`), fullPage: true });
      expect(await axe(page)).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      expect(await violations()).toEqual([]);
    });
  }
}
