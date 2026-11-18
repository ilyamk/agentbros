/**
 * RFC 0004 WP15, D18, US22: `pnpm console:snapshot`. The page inlines the bundle and embeds the view safely; every
 * string is scrubbed (secret flags, `.env` secret values, the session token, the checkout and home folders); a pool's
 * key never reaches it; the page is capped; the CLI follows the JSON contract and writes only out/<id>/.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ProjectViewSchema, REDACTED } from "../src/types/console";
import {
  envSecretValues,
  inlineScript,
  renderSnapshot,
  scriptJson,
  scrubSnapshotData,
  snapshotScrubber,
  SnapshotTooLarge,
  SNAPSHOT_ELEMENT_ID,
  type SnapshotData,
} from "../src/lib/console/snapshot";
import { loadOrCreateSessionToken } from "../src/lib/console/session";
import { makeRoot, PROJECT, removeRoot } from "./helpers/console-server";
import { scaffoldFilmProject } from "../src/lib/film/project";
import { approveStep, openFilmProject, sealStep } from "../src/lib/film/state";
import { buildPool } from "../src/lib/film/studio";
import { skipDiscovery, writeStrategy, writeTeams } from "./helpers/film-studio";

const REPO = path.resolve(import.meta.dirname, "..");
const CHAIN = path.join(REPO, "tests/fixtures/film-chain");
const TSX = path.join(REPO, "node_modules/tsx/dist/cli.mjs");
const SECRET = "sk-" + "fake-snapshot-secret-0123456789";
const roots: string[] = [];
after(() => roots.forEach(removeRoot));

const VIEW = ProjectViewSchema.parse(
  JSON.parse(readFileSync(path.join(REPO, "tests/fixtures/console/view-replica.json"), "utf8")),
);
const data = (view = VIEW): SnapshotData => ({
  v: 1,
  takenAt: "2026-11-17T10:00:00.000Z",
  view,
  summary: {
    id: view.project.id,
    route: view.project.route,
    waiting: 0,
    control: "running",
    spentUsd: 0,
    updatedAt: view.generatedAt,
  },
});

/** The embedded JSON of a page, parsed back. */
function embedded(html: string): SnapshotData {
  const match = new RegExp(`<script type="application/json" id="${SNAPSHOT_ELEMENT_ID}">([\\s\\S]*?)</script>`).exec(
    html,
  );
  assert.ok(match, "embedded data");
  return JSON.parse(match[1]!) as SnapshotData;
}

test("the page inlines script and style without letting them close their elements, and keeps $ patterns", () => {
  const js = 'const a = "</script><script>alert(1)</script>"; const b = "$& $1 $\'";';
  const view = { ...VIEW, advisories: ["closing </script> and \u2028 separator & <b>"] };
  const html = renderSnapshot({ data: data(view), js, css: "body{color:red}</style><b>", maxBytes: 1_000_000 });
  assert.equal(html.match(/<\/script>/g)?.length, 2, "only the two real closing tags");
  assert.match(html, /\$& \$1 \$'/);
  assert.match(html, /<\\\/style><b>/);
  assert.deepEqual(embedded(html).view.advisories, view.advisories);
  assert.doesNotMatch(scriptJson({ a: "\u2028<" }), /[\u2028<]/);
  assert.equal(inlineScript("x</SCRIPT y"), "x<\\/SCRIPT y");
  assert.throws(
    () => renderSnapshot({ data: data(), js: "x".repeat(2000), css: "", maxBytes: 1000 }),
    SnapshotTooLarge,
  );
});

test("the scrubber removes secret flags, .env secret values, the token and local folders, and re-validates", () => {
  const root = makeRoot();
  roots.push(root);
  writeFileSync(
    path.join(root, ".env"),
    `FAL_KEY=${SECRET}\nexport OPENAI_API_KEY="${SECRET}-2"\nPLAIN=not-a-secret-value\nSHORT_TOKEN=abc\n`,
  );
  assert.deepEqual(envSecretValues(root), [SECRET, `${SECRET}-2`]);
  const scrub = snapshotScrubber({
    rootDir: root,
    secrets: [...envSecretValues(root), "tok".repeat(10)],
    home: path.join(path.sep, "home", "someone"),
  });
  assert.equal(scrub(`--api-key=abc ${SECRET}-2 ${"tok".repeat(10)}`), `--api-key=${REDACTED} ${REDACTED} ${REDACTED}`);
  assert.equal(
    scrub(`${root}/public/x and ${path.join(path.sep, "home", "someone")}/y`),
    "<checkout>/public/x and ~/y",
  );
  const view = { ...VIEW, advisories: [`render failed in ${root}/out with --token ${SECRET}`] };
  const clean = scrubSnapshotData(data(view), scrub);
  assert.deepEqual(clean.view.advisories, [`render failed in <checkout>/out with --token ${REDACTED}`]);
});

function cli(root: string, ...args: string[]) {
  const result = spawnSync(process.execPath, [TSX, path.join(REPO, "scripts/console-snapshot.ts"), ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, AGENTBROS_EVENTS: "off", AGENTBROS_CONSOLE: "off", AGENTBROS_HOOKS: "off" },
  });
  const lines = result.stdout.trim().split("\n");
  assert.equal(lines.length, 1, `one JSON line: ${result.stdout}${result.stderr}`);
  return { status: result.status, json: JSON.parse(lines[0]!) as Record<string, any> };
}

test("console:snapshot writes out/<id>/console-snapshot.html: no token, no secret, no pool key, capped", () => {
  const root = makeRoot();
  roots.push(root);
  const token = loadOrCreateSessionToken(root);
  writeFileSync(path.join(root, ".env"), `FAL_KEY=${SECRET}\n`);
  const project = path.join(root, "public/projects", PROJECT);
  writeFileSync(path.join(project, "project.json"), JSON.stringify({ title: `Demo ${SECRET} --api-key leaked-value` }));
  mkdirSync(path.join(project, "pipeline/pools"), { recursive: true });
  writeFileSync(
    path.join(project, "pipeline/pools/ideas-key.json"),
    JSON.stringify({ A: { author: "blind-author-marker", team: "team-marker" } }),
  );

  const ok = cli(root, "--project", PROJECT, "--bundle-dir", "out/console/dist");
  assert.equal(ok.status, 0, JSON.stringify(ok.json));
  assert.equal(ok.json.ok, true);
  assert.deepEqual(ok.json.outputs, [`out/${PROJECT}/console-snapshot.html`]);
  assert.match(ok.json.metadata.next, /explicitly asks/);
  const file = path.join(root, ok.json.outputs[0]);
  const html = readFileSync(file, "utf8");
  assert.equal(statSync(file).mode & 0o777, 0o600);
  for (const forbidden of [token, SECRET, "leaked-value", "blind-author-marker", "team-marker", "#token=", root])
    assert.ok(!html.includes(forbidden), `the page carries ${forbidden}`);
  assert.match(html, /console\.log\('app'\)/, "the bundle's script is inlined");
  assert.doesNotMatch(html, /src="\.\/app\.js"|href="\.\/style\.css"/, "no external bundle files");
  const page = embedded(html);
  assert.equal(page.view.project.id, PROJECT);
  assert.equal(page.summary.id, PROJECT);
  assert.match(page.view.project.title ?? "", new RegExp(`Demo ${REDACTED.replace(/[<>]/g, "\\$&")}`));

  const capped = cli(root, "--project", PROJECT, "--bundle-dir", "out/console/dist", "--max-bytes", "500");
  assert.equal(capped.status, 1);
  assert.equal(capped.json.error, "VALIDATION");
  assert.equal(capped.json.details.maxBytes, 500);
  assert.equal(readFileSync(file, "utf8"), html, "a refused snapshot leaves the last one as it was");

  const missing = cli(root, "--project", "no-such-project", "--bundle-dir", "out/console/dist");
  assert.equal(missing.json.error, "PROJECT_NOT_FOUND");
  const noBundle = cli(root, "--project", PROJECT, "--bundle-dir", "out/nothing");
  assert.equal(noBundle.json.error, "FILE_NOT_FOUND");
  assert.equal(existsSync(path.join(root, "public/projects", PROJECT, "pipeline/events.jsonl")), false);
});

test("console:snapshot of a film keeps the idea pool blind: candidates shown, the pool key and authors never", () => {
  const root = makeRoot();
  roots.push(root);
  const id = "blind-film";
  const dir = path.join(root, "public/projects", id);
  scaffoldFilmProject(dir, id, []);
  const project = () => openFilmProject(dir, { rootDir: root });
  const place = (file: string) => writeFileSync(path.join(dir, "pipeline", file), readFileSync(path.join(CHAIN, file)));
  place("brief.json");
  sealStep(project(), "intake");
  approveStep(project(), "intake", "yes to intake");
  place("product-truth.json");
  sealStep(project(), "truth");
  place("film-targets.json");
  sealStep(project(), "reference");
  writeStrategy(dir);
  sealStep(project(), "strategy");
  approveStep(project(), "strategy", "yes to strategy");
  skipDiscovery(dir);
  writeTeams(dir, 1);
  sealStep(project(), "ideas");
  buildPool(dir, id, "ideas");
  // Mark the key's authorship so its absence from the page is checkable.
  const keyFile = path.join(dir, "pipeline/pools/ideas-key.json");
  const key = JSON.parse(readFileSync(keyFile, "utf8"));
  key.entries = key.entries.map((entry: Record<string, unknown>, index: number) => ({
    ...entry,
    author: `blind-author-marker-${index}`,
    sourceId: `blind-source-marker-${index}`,
  }));
  writeFileSync(keyFile, JSON.stringify(key));

  const ok = cli(root, "--project", id, "--bundle-dir", "out/console/dist");
  assert.equal(ok.json.ok, true, JSON.stringify(ok.json));
  const html = readFileSync(path.join(root, ok.json.outputs[0]), "utf8");
  const page = embedded(html);
  assert.ok((page.view.film?.ideas?.items.length ?? 0) > 0, "the pool's candidates are on the page");
  assert.doesNotMatch(html, /blind-author-marker|blind-source-marker|ideas-key|"author"|"sourceId"/);
});
