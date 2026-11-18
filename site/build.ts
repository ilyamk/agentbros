import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { z } from "zod";
import { assertPathWithin } from "../src/lib/cli";
import { readShowcases, optionalJson, jsonFiles } from "../src/lib/showcase/data";
import { contributorStats } from "../src/lib/community/stats";
import { listPlaybookIds, loadPlaybook } from "../src/lib/playbooks/project";
import type { Catalogue, CatalogueItem } from "../src/lib/library/catalogue";
import type { Playbook } from "../src/types/playbook";
import { SITE_CSS } from "./theme";

export const SITE_URL = "https://ilyamk.github.io/agentbros/";
export const REPOSITORY_URL = "https://github.com/ilyamk/agentbros";
export const escapeHtml = (value: unknown): string =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!,
  );
const e = escapeHtml;
const href = (route = "") => `/agentbros/${route}`;
const link = (route: string, title: string) => `<a href="${href(route)}">${e(title)}</a>`;
const data = (value: unknown) => `<pre>${e(JSON.stringify(value, null, 2))}</pre>`;
const plain = (text: string) =>
  text
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
const clip = (text: string, max: number) => {
  const value = plain(text);
  return value.length <= max
    ? value
    : `${value.slice(0, value.lastIndexOf(" ", max - 1) > max * 0.6 ? value.lastIndexOf(" ", max - 1) : max - 1)}…`;
};
const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

/** The gallery filter script; tests run it in a VM with a minimal document. Data is read from attributes only. */
const filters = `document.querySelectorAll('[data-filter]').forEach(control=>control.addEventListener('input',()=>{let count=0;document.querySelectorAll('[data-showcase]').forEach(card=>{const matches=Array.from(document.querySelectorAll('[data-filter]')).every(input=>{const key=input.dataset.filter,value=input.value;if(!value)return true;if(key==='budget'||key==='length'){const amount=card.dataset[key];return amount!==''&&Number(amount)<=Number(value)}return card.dataset[key]===value});card.hidden=!matches;if(matches)count++});document.getElementById('result-count').textContent=count+' films shown'}));`;
/** Chips, a select and a search box over [data-item] cards; sections hide when empty. textContent only, never HTML. */
const board = `(()=>{const chips=[...document.querySelectorAll('[data-chip]')],size=document.getElementById('size'),search=document.getElementById('search'),items=[...document.querySelectorAll('[data-item]')],status=document.getElementById('board-count');let active='';function run(){const q=(search&&search.value||'').trim().toLowerCase(),s=size&&size.value||'';let n=0;items.forEach(item=>{const ok=(!active||item.dataset.group===active)&&(!s||item.dataset.size===s)&&(!q||(item.dataset.search||'').includes(q));item.hidden=!ok;if(ok)n++});document.querySelectorAll('[data-section]').forEach(section=>{section.hidden=!section.querySelector('[data-item]:not([hidden])');const more=section.querySelector('details.more');if(more&&(q||s))more.open=true});if(status)status.textContent=n+' shown'}chips.forEach(chip=>chip.addEventListener('click',()=>{active=chip.dataset.chip===active?'':chip.dataset.chip;chips.forEach(c=>c.setAttribute('aria-pressed',String(c.dataset.chip===active||(!active&&c.dataset.chip===''))));run()}));[size,search].forEach(c=>c&&c.addEventListener('input',run))})();`;

type Nav = "home" | "genres" | "library" | "films" | "crew" | "needs" | "other";
const NAV: [Nav, string, string][] = [
  ["genres", "genres/", "Genres"],
  ["library", "library/", "Library"],
  ["films", "films/", "Films"],
  ["crew", "crew/", "Crew"],
  ["needs", "needs/", "Contribute"],
];
interface PageOptions {
  title: string;
  route: string;
  nav: Nav;
  body: string;
  description?: string;
  script?: string;
  fullTitle?: boolean;
  logo?: string;
}
function page({ title, route, nav, body, description, script, fullTitle, logo }: PageOptions) {
  const mark = logo ? `<img src="${e(logo)}" alt="" width="44" height="36">` : "";
  const summary =
    description ??
    "A source-available film studio run by two agent brothers, Claude Code and Codex. One sentence in, a rendered film and its source out.";
  const pageTitle = fullTitle ? title : `${title} · Agent Bros. Pictures`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark"><meta name="theme-color" content="#07080c"><title>${e(pageTitle)}</title><meta name="description" content="${e(summary)}"><link rel="canonical" href="${SITE_URL}${route}"><meta property="og:type" content="website"><meta property="og:site_name" content="Agent Bros. Pictures"><meta property="og:title" content="${e(pageTitle)}"><meta property="og:description" content="${e(summary)}"><meta property="og:url" content="${SITE_URL}${route}"><meta property="og:image" content="${SITE_URL}assets/readme/social-preview.jpg"><meta name="twitter:card" content="summary_large_image">${logo ? `<link rel="icon" type="image/png" href="${e(logo)}">` : ""}<link rel="stylesheet" href="${href("assets/site.css")}"></head><body><a class="skip" href="#content">Skip to content</a><header class="top"><div class="wrap"><a class="brand" href="${href("")}">${mark}<span>Agent Bros.<small>Pictures</small></span></a><nav class="nav" aria-label="Main navigation">${NAV.map(([id, url, label]) => `<a href="${href(url)}"${id === nav ? ' aria-current="page"' : ""}>${label}</a>`).join("")}<a class="gh" href="${REPOSITORY_URL}">GitHub</a></nav></div></header><main id="content">${body}</main><footer class="foot"><div class="wrap"><div><a class="brand" href="${href("")}">${mark}<span>Agent Bros.<small>Pictures</small></span></a><p>A source-available video studio run by Claude Code and Codex. Free for individuals, organisations of up to three people, non-profits and education; larger companies need a <a href="${REPOSITORY_URL}/blob/main/COMMERCIAL-LICENSE.md">commercial licence</a>. Each release becomes AGPL-3.0-or-later after four years.</p><p>© 2026 Ilia Maksimenka · <a href="${REPOSITORY_URL}/blob/main/LICENSE">BUSL-1.1</a></p><p>No telemetry, no cookies, no external requests. Credits recognise categories, without rankings.</p></div><div><h4>Studio</h4><ul><li>${link("genres/", "Genres")}</li><li>${link("library/", "Motion library")}</li><li>${link("films/", "Films")}</li><li>${link("crew/", "The crew")}</li><li>${link("benchmarks/", "Benchmarks")}</li><li>${link("metrics/", "Metrics")}</li></ul></div><div><h4>Crew</h4><ul><li>${link("needs/", "Pick a job")}</li><li>${link("contributors/", "Contributors")}</li><li>${link("releases/", "Releases")}</li><li><a href="${REPOSITORY_URL}/blob/main/CONTRIBUTING.md">Contributing guide</a></li><li><a href="${REPOSITORY_URL}/blob/main/SECURITY.md">Security</a></li><li><a href="${REPOSITORY_URL}">Contribute on GitHub</a></li></ul></div></div></footer>${script ? `<script>${script}</script>` : ""}</body></html>`;
}
const pageHead = (eyebrow: string, title: string, lede: string, crumbs?: [string, string]) =>
  `<div class="pagehead"><div class="wrap">${crumbs ? `<p class="crumbs"><a href="${href(crumbs[0])}">← ${e(crumbs[1])}</a></p>` : ""}<p class="eyebrow left">${e(eyebrow)}</p><h1 class="gilt">${e(title)}</h1><p class="lede">${lede}</p></div></div>`;
const section = (inner: string, cls = "") =>
  `<section${cls ? ` class="${cls}"` : ""}><div class="wrap">${inner}</div></section>`;

interface Agent {
  name: string;
  description: string;
  model: string;
}
function readAgents(root: string): Agent[] {
  const dir = path.join(root, ".agents/agents");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((file) => file.endsWith(".md") && file !== "README.md")
    .sort()
    .flatMap((file) => {
      const head = /^---\n([\s\S]*?)\n---/.exec(readFileSync(path.join(dir, file), "utf8"))?.[1];
      if (!head) return [];
      const field = (key: string) =>
        new RegExp(`^${key}:\\s*(.+)$`, "m")
          .exec(head)?.[1]
          ?.trim()
          .replace(/^["']|["']$/g, "") ?? "";
      return field("name") ? [{ name: field("name"), description: field("description"), model: field("model") }] : [];
    });
}
interface Need {
  id: string;
  category: string;
  size: "S" | "M" | "L";
  title: string;
  why: string;
  evidence: string[];
  definitionOfDone: string[];
  covering: string[];
  source?: string;
}
const NeedSchema = z.object({
  id: z.string(),
  category: z.string(),
  size: z.enum(["S", "M", "L"]),
  title: z.string(),
  why: z.string(),
  evidence: z.array(z.string()),
  definitionOfDone: z.array(z.string()),
  covering: z.array(z.string()).default([]),
  source: z.string().optional(),
});
function readNeeds(root: string): { rows: Need[]; counts: Record<string, number>; total: number } | undefined {
  const raw = optionalJson(path.join(root, "out/contrib/needs.json")) as
    { opportunities?: unknown[]; counts?: Record<string, number>; total?: number } | undefined;
  if (!raw) return undefined;
  const rows = (raw.opportunities ?? []).flatMap((row) => {
    const parsed = NeedSchema.safeParse(row);
    return parsed.success ? [parsed.data] : [];
  });
  const counts =
    raw.counts && typeof raw.counts === "object"
      ? raw.counts
      : rows.reduce<Record<string, number>>(
          (all, row) => ({ ...all, [row.category]: (all[row.category] ?? 0) + 1 }),
          {},
        );
  return { rows, counts, total: typeof raw.total === "number" ? raw.total : rows.length };
}
interface Category {
  id: string;
  title: string;
  valuable: string;
}
function readCategories(root: string): Category[] {
  const registry = optionalJson(path.join(root, "contrib/categories.json")) as
    { categories?: { id: string; title: string }[] } | { id: string; title: string }[] | undefined;
  const list = Array.isArray(registry) ? registry : (registry?.categories ?? []);
  return list.map((row) => {
    const card = path.join(root, "contrib/categories", `${row.id}.md`);
    const valuable = existsSync(card)
      ? (/## What is valuable\n\n([^\n]+)/.exec(readFileSync(card, "utf8"))?.[1] ?? "")
      : "";
    return { id: row.id, title: row.title, valuable: plain(valuable) };
  });
}
function changelogHtml(markdown: string): string {
  const out: string[] = [];
  let list = false;
  for (const line of markdown.split("\n")) {
    const item = /^\s*[-*] (.*)$/.exec(line);
    if (!item && list) {
      out.push("</ul>");
      list = false;
    }
    if (item) {
      if (!list) {
        out.push("<ul>");
        list = true;
      }
      out.push(`<li>${e(plain(item[1]!))}</li>`);
    } else if (/^#{1,2} /.test(line)) out.push(`<h2>${e(line.replace(/^#+ /, ""))}</h2>`);
    else if (/^#{3,} /.test(line)) out.push(`<h3>${e(line.replace(/^#+ /, ""))}</h3>`);
    else if (line.trim()) out.push(`<p>${e(plain(line))}</p>`);
  }
  if (list) out.push("</ul>");
  return out.join("");
}

const DEPARTMENTS: [string, string, string, string][] = [
  ["writers", "Writers' room", "Strategy, hooks, ideas from rival teams, scripts judged blind.", "film:brief"],
  ["art", "Art department", "Motion blocks, looks and styleframes rendered from real code.", "library:list"],
  ["camera", "Camera & 3D", "Blender, three.js and the real UI of your product, captured live.", "capture:app"],
  ["generation", "Generation", "Image and video models behind durable jobs and hard budgets.", "generate:video"],
  ["sound", "Voice & music", "Voiceover, scores, sound effects, cuts locked to the beat.", "audio:mix"],
  ["editing", "Editing suite", "Silences, fillers and false starts cut; multicam; vertical reframe.", "recut:plan"],
  ["reference", "Reference lab", "Any film taken apart frame by frame, then rebuilt for your idea.", "ref:analyze"],
  ["critics", "Critics' table", "A fresh, harsh critic every round; measured motion, sync and QA.", "motion:check"],
];
const CATEGORY_LABELS: Record<string, string> = {
  typography: "Typography",
  finish: "Finish",
  backgrounds: "Backgrounds",
  ui: "Product UI",
  transitions: "Transitions",
  camera: "Camera",
  three: "3D",
  data: "Data",
  scenes: "Scenes",
  kinetic: "Kinetic type",
  effects: "Effects",
  captions: "Captions",
};

/** Kept here so tsc covers the framework-free generator through the CLI import. */
export function buildSite(root: string, out: string) {
  const output = path.resolve(root, out);
  assertPathWithin(path.join(root, "out"), output);
  if (output === path.join(root, "out")) throw new Error("Site output needs its own directory under out/");
  const outputs: string[] = [];
  const manifestFile = path.join(output, ".site-files.json");
  const safeFile = (target: string) => {
    assertPathWithin(output, target);
    const stat = lstatSync(target, { throwIfNoEntry: false });
    if (stat && !stat.isFile()) throw new Error("Site outputs must be regular files");
  };
  safeFile(manifestFile);
  const fileName = z
    .string()
    .regex(
      /^(?:index\.html|(?:contributors|showcases|genres)\/[a-z0-9-]+\/index\.html|(?:contributors|metrics|benchmarks|needs|releases|genres|library|films|crew)\/index\.html|benchmarks\/data\/result-[1-9][0-9]*\.json|assets\/site\.css|assets\/(?:readme|library)\/[a-z0-9_-]+\.(?:jpg|png))$/,
    );
  const previousFiles = existsSync(manifestFile) ? z.array(fileName).parse(optionalJson(manifestFile)) : [];
  previousFiles.forEach((file) => safeFile(path.join(output, file)));
  const write = (file: string, source: string) => {
    fileName.parse(file);
    const target = path.join(output, file);
    safeFile(target);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, source);
    outputs.push(path.relative(root, target));
  };
  /** Copy a tracked image once; returns its site URL, or undefined when the source is absent (fixture repositories). */
  const copied = new Map<string, string | undefined>();
  const asset = (source: string, kind: "readme" | "library"): string | undefined => {
    if (copied.has(source)) return copied.get(source);
    const from = path.join(root, source);
    const name = path.basename(source).toLowerCase();
    let url: string | undefined;
    if (existsSync(from) && lstatSync(from).isFile() && /^[a-z0-9_-]+\.(?:jpg|png)$/.test(name)) {
      const file = `assets/${kind}/${name}`;
      fileName.parse(file);
      const target = path.join(output, file);
      safeFile(target);
      mkdirSync(path.dirname(target), { recursive: true });
      copyFileSync(from, target);
      outputs.push(path.relative(root, target));
      url = href(file);
    }
    copied.set(source, url);
    return url;
  };
  const readme = (name: string) => asset(`docs/readme/${name}`, "readme");
  const img = (url: string | undefined, alt: string, extra = "") =>
    url ? `<img src="${e(url)}" alt="${e(alt)}" loading="lazy" decoding="async"${extra}>` : "";

  write("assets/site.css", SITE_CSS.trim() + "\n");
  const logo = readme("logo-dark.png");
  readme("social-preview.jpg");
  const render = (options: PageOptions) => page({ ...options, logo });

  const entries = readShowcases(root),
    stats = contributorStats(root);
  const books: Playbook[] = listPlaybookIds(root)
    .map((id) => loadPlaybook(id, root))
    .sort((a, b) => (a.status === "draft" ? 1 : 0) - (b.status === "draft" ? 1 : 0) || a.title.localeCompare(b.title));
  const catalogue =
    (optionalJson(path.join(root, "docs/library/catalogue.json")) as Catalogue | undefined)?.items ?? [];
  const blocks = new Map(catalogue.map((item) => [item.id, item]));
  const agents = readAgents(root);
  const needs = readNeeds(root);
  const categories = readCategories(root);
  const preview = (item: CatalogueItem) =>
    asset(
      item.preview?.image && existsSync(path.join(root, item.preview.image))
        ? item.preview.image
        : `docs/library/previews/${item.id}.jpg`,
      "library",
    );
  const status = (book: Playbook) =>
    book.status === "draft"
      ? '<span class="tag beta">Beta</span>'
      : `<span class="tag ready">${book.status === "proven" ? "Proven" : "Ready"}</span>`;
  const ready = books.filter((book) => book.status !== "draft").length;

  const blockCard = (item: CatalogueItem) =>
    `<article class="card" data-item data-group="${e(item.category)}" data-size="" data-search="${e(`${item.id} ${item.title} ${item.tags.join(" ")} ${item.category}`.toLowerCase())}">${preview(item) ? `<div class="strip">${img(preview(item), `Frame strip of the ${item.title} block`)}</div>` : ""}<div class="body"><h3>${e(item.title)}</h3><p>${e(clip(item.description, 170))}</p><div class="meta"><span class="tag gold">${e(CATEGORY_LABELS[item.category] ?? item.category)}</span><span class="tag"><code>${e(item.id)}</code></span></div></div></article>`;
  const genreCard = (book: Playbook) =>
    `<article class="card"><span class="poster-badge">${status(book)}</span><div class="media">${img(readme(`card-${book.id}.jpg`) ?? readme("card-your-genre.jpg"), `Poster art for ${book.title}`)}</div><div class="body"><h3>${link(`genres/${book.id}/`, book.title)}</h3><p>${e(clip(book.summary, 150))}</p></div></article>`;
  const filmCard = (entry: (typeof entries)[number]) =>
    `<article class="card" data-showcase data-playbook="${e(entry.playbook)}" data-harness="${e(entry.harness)}" data-model="${e(entry.model)}" data-verification="${entry.verification}" data-budget="${entry.budget.totalUsd ?? ""}" data-length="${entry.durationSec}">${entry.media ? `<div class="media"><img loading="lazy" src="${e(entry.media.thumbnail)}" alt="Thumbnail of ${e(entry.title)}"></div>` : ""}<div class="body"><h3>${link(`showcases/${entry.slug}/`, entry.title)}</h3><p>${e(entry.summary)}</p><div class="meta"><span class="tag gold">${e(entry.playbook ?? "Unbound")}</span><span class="tag">${e(entry.verification)}</span><span class="tag">${entry.durationSec.toFixed(1)} s</span>${entry.media ? "" : '<span class="tag">Media awaiting publication</span>'}</div></div></article>`;
  const emptyPremieres = `<div class="empty"><div class="posters">${["poster-1.jpg", "poster-2.jpg", "poster-3.jpg"].map((name, index) => img(readme(name), `Illustrated premiere poster ${index + 1}`)).join("")}</div><h3>No showcases published yet</h3><p>The first films made with the studio open here, each with its process, budget and evidence. Posters above are illustrations, not renders.</p><a class="btn primary" href="${REPOSITORY_URL}/blob/main/docs/showcases.md">Share a film</a></div>`;

  // Home
  const needTotal = needs?.total ?? 0;
  const topNeedCategories = needs
    ? Object.entries(needs.counts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 6)
    : [];
  const home = `
<section class="hero">${img(readme("hero.jpg"), "Night at the Agent Bros. Pictures studio gate: two robot brothers under a marquee that reads Now showing: your idea", ' fetchpriority="high" loading="eager"')}<div class="wrap"><p class="eyebrow left">Source-available film studio · Claude Code &amp; Codex</p><h1 class="gilt">Your idea, now showing.</h1><p class="lede">Two agent brothers run a whole studio in code: strategy, script, motion design, sound, edit and a harsh critic. Say one sentence; get a rendered film and every file that made it.</p><div class="prompt" role="note"><b>&gt;</b><span>Make a 20-second vertical ad for my app, here is the landing page.</span></div><div class="actions"><a class="btn primary" href="${REPOSITORY_URL}">Get the studio</a><a class="btn" href="${href("genres/")}">See the genres</a><a class="btn" href="${href("needs/")}">Join the crew</a></div></div></section>
<div class="marquee"><div class="wrap"><div class="stats"><div class="stat"><b>${books.length}</b><span>genres · ${ready} ready</span></div><div class="stat"><b>${catalogue.length}</b><span>motion blocks</span></div><div class="stat"><b>${agents.length}</b><span>crew agents</span></div><div class="stat"><b>3</b><span>formats 9:16 · 1:1 · 16:9</span></div><div class="stat"><b>0</b><span>API keys to render</span></div></div></div></div>
${section(`<div class="center"><p class="eyebrow">How it works</p><h2>One sentence. A finished cut.</h2><p class="lede">Ask in your own words. The crew picks the genre, writes, builds, renders and watches its own frames before you see a thing.</p></div><div class="deco"></div><div class="steps" style="margin-top:2rem"><div class="step"><h3>Say it</h3><p>Any video, in plain language.</p><p class="quote">Cut five Shorts from my podcast, with key-word captions.</p></div><div class="step"><h3>Approve, don't micromanage</h3><p>You sign off the idea, the look, the music and the final cut. Nothing paid runs without a budget you set.</p></div><div class="step"><h3>Get the cut and the source</h3><p>A render in 9:16, 1:1 or 16:9, plus editable Remotion code, the plan, critic notes and a priced log of every paid call.</p></div></div>`)}
${section(`<div class="center"><p class="eyebrow">The studio</p><h2>Every department, staffed by agents</h2><p class="lede">Each department is a command with a JSON answer, so the crew can check its own work.</p></div><div class="grid four" style="margin-top:2.5rem">${DEPARTMENTS.map(([icon, name, text, command]) => `<div class="dept">${img(readme(`icon-${icon}.png`), "", ' width="84" height="84"')}<h3>${e(name)}</h3><p>${e(text)}</p><code>${e(command)}</code></div>`).join("")}</div>`, "band")}
${section(`<div class="center"><p class="eyebrow">Now showing</p><h2>Pick a genre, or just ask</h2><p class="lede">Each genre is a playbook: a method, a quality bar and the tools for one kind of video. Poster art is illustration; real films open under Films.</p></div><div class="grid" style="margin-top:2.5rem">${books.map(genreCard).join("") || '<p class="muted">No playbooks in this checkout.</p>'}</div><div class="actions" style="justify-content:center"><a class="btn" href="${href("genres/")}">All genres</a></div>`)}
${section(`<div class="split"><div><p class="eyebrow left">Motion library</p><h2>${catalogue.length} blocks, real renders</h2><p class="lede">Films are built from frame-driven motion blocks: typography, product UI, transitions, camera, 3D, data and captions. Every strip on the library page is a real render of the block.</p><ul class="list"><li><b>Deterministic.</b> Every value is a function of the frame, so a render is repeatable.</li><li><b>Studied from references.</b> Moves measured from professional films, then promoted to blocks.</li><li><b>Open to contributors.</b> A missing move is a job on the board.</li></ul><div class="actions"><a class="btn primary" href="${href("library/")}">Browse the library</a></div></div><div class="frame">${img(asset("docs/library/previews/_typography.jpg", "library"), "Contact sheet of the typography blocks, rendered")}</div></div>`, "band")}
${section(`<div class="center"><p class="eyebrow">Premieres</p><h2>Films from the lot</h2></div><div style="margin-top:2rem">${entries.length ? `<div class="grid wide">${entries.slice(0, 6).map(filmCard).join("")}</div><div class="actions" style="justify-content:center"><a class="btn" href="${href("films/")}">All films</a></div>` : emptyPremieres}</div>`)}
${section(`<div class="split rev"><div class="frame">${img(readme("story.jpg"), "Illustration of the two agent brothers at work in the studio")}</div><div><p class="eyebrow left">Join the crew</p><h2>Pick a job. Bring your agent.</h2><p class="lede">${needTotal ? `${needTotal} open jobs, found by scanning the repository: missing moves, uncalibrated sensors, draft genres, agent and prompt quality.` : "Open jobs are found by scanning the repository: missing moves, uncalibrated sensors, draft genres, agent and prompt quality."} You choose; your Claude Code or Codex can do the work under your name.</p>${topNeedCategories.length ? `<div class="meta" style="display:flex;flex-wrap:wrap;gap:.4rem;margin:1rem 0">${topNeedCategories.map(([id, count]) => `<span class="tag gold">${e(id)} · ${count}</span>`).join("")}</div>` : ""}<pre class="cmd"><span class="c"># in your fork</span>\n<span class="p">$</span> pnpm contrib:scout --online\n<span class="p">$</span> pnpm contrib:check\n<span class="p">$</span> pnpm contrib:pr --out .contrib/pr.md</pre><div class="actions"><a class="btn primary" href="${href("needs/")}">See open jobs</a><a class="btn" href="${REPOSITORY_URL}/blob/main/CONTRIBUTING.md">How contributing works</a></div></div></div>`, "band")}
${section(
  `<div class="center"><p class="eyebrow">Honest limits</p><h2>What it will not pretend</h2></div><div class="grid" style="margin-top:2rem">${[
    ["The agents cannot hear", "They read loudness, beats and spectra; whether the music is right is your call."],
    [
      "Taste depends on the model",
      "Built and tested on the strongest Claude and Codex models; smaller models follow rules but judge less well.",
    ],
    [
      "Generation costs money",
      "Rendering is local and needs no provider account; image, video, voice and music models run on your own accounts and budgets.",
    ],
    [
      "Larger companies need two licences",
      "Free for individuals and organisations of up to three people; a larger company needs our commercial licence and a Remotion Company License.",
    ],
  ]
    .map(([title, text]) => `<div class="step" style="padding:1.3rem"><h3>${e(title)}</h3><p>${e(text)}</p></div>`)
    .join("")}</div>`,
)}`;
  write(
    "index.html",
    render({
      title: "Agent Bros. Pictures: a source-available film studio run by agents",
      fullTitle: true,
      route: "",
      nav: "home",
      body: home,
    }),
  );

  // Films
  const controls =
    (["playbook", "harness", "model", "verification"] as const)
      .map(
        (key) =>
          `<label>${e(key[0]!.toUpperCase() + key.slice(1))}<select data-filter="${key}"><option value="">All</option>${[
            ...new Set(
              entries.map((entry) => entry[key]).filter((value): value is NonNullable<typeof value> => value !== null),
            ),
          ]
            .sort()
            .map((value) => `<option value="${e(value)}">${e(value)}</option>`)
            .join("")}</select></label>`,
      )
      .join("") +
    '<label>Maximum budget (USD)<input data-filter="budget" type="number" min="0" step="0.01"></label><label>Maximum length (seconds)<input data-filter="length" type="number" min="0" step="1"></label>';
  write(
    "films/index.html",
    render({
      title: "Films",
      route: "films/",
      nav: "films",
      description: "Films made with Agent Bros. Pictures, with the process, budget and evidence behind each.",
      script: filters,
      body:
        pageHead(
          "Made with Agent Bros.",
          "Films",
          "Films, the process behind them and their evidence. Verification describes provenance, not creative quality.",
        ) +
        section(
          entries.length
            ? `<div class="filters" role="group" aria-label="Filter films">${controls}</div><p id="result-count" class="count" role="status">${entries.length} films shown</p><div class="grid wide">${entries.map(filmCard).join("")}</div>`
            : `<div class="filters" role="group" aria-label="Filter films">${controls}</div><p id="result-count" class="count" role="status">0 films shown</p>${emptyPremieres}`,
        ),
    }),
  );
  for (const entry of entries) {
    const media = entry.media
      ? `<div class="frame"><video controls muted playsinline preload="metadata" poster="${e(entry.media.thumbnail)}" aria-label="Muted preview of ${e(entry.title)}" style="width:100%;display:block"><source src="${e(entry.media.preview)}" type="video/mp4"></video></div><p class="small muted">Muted preview, up to ten seconds. <a href="${e(entry.media.contactSheet)}">View contact sheet</a></p>`
      : '<div class="empty"><p>Media awaiting publication.</p></div>';
    const facts: [string, unknown][] = [
      ["Format", entry.format],
      ["Length", `${entry.durationSec.toFixed(1)} s`],
      ["Language", entry.language],
      ["Genre", entry.playbook ?? "Unbound"],
      ["Harness", entry.harness],
      ["Model", entry.model],
      ["Rounds", entry.rounds],
      ["Wall time", entry.wallTimeMin === null || entry.wallTimeMin === undefined ? "—" : `${entry.wallTimeMin} min`],
      ["Interventions", entry.userInterventions],
      ["Verification", entry.verification],
      [
        "Budget",
        entry.budget.totalUsd === null || entry.budget.totalUsd === undefined ? "—" : `$${entry.budget.totalUsd}`,
      ],
    ];
    const body =
      pageHead(entry.playbook ?? "Film", entry.title, e(entry.summary), ["films/", "All films"]) +
      section(
        `<div class="split"><div>${media}</div><div><div class="facts">${facts.map(([label, value]) => `<div class="fact"><span>${e(label)}</span><b>${e(value ?? "—")}</b></div>`).join("")}</div><p>Author: ${link(`contributors/${entry.author.handle.toLowerCase()}/`, entry.author.displayName)} · ${e(entry.author.credits)}</p>${entry.author.links.map((url) => `<p><a href="${e(url)}">Author link</a></p>`).join("")}${entry.links.map((url, i) => `<p><a href="${e(url)}">Film link ${i + 1}</a></p>`).join("")}</div></div><div class="prose"><h2>Process</h2>${data({ route: entry.route, filmType: entry.filmType, libraryBlocks: entry.libraryBlocks, harnessVersion: entry.harnessVersion })}<h2>Budget</h2>${data(entry.budget)}<h2>Settings</h2>${data(entry.settings)}<h2>Rights and entry licence</h2><p>${e(entry.rights ?? "Declaration pending author review.")}</p><p>${e(entry.licence ?? "Entry licence pending author review.")}</p><h2>Evidence</h2>${data(entry.evidence)}</div>`,
      );
    write(
      `showcases/${entry.slug}/index.html`,
      render({ title: entry.title, route: `showcases/${entry.slug}/`, nav: "films", description: entry.summary, body }),
    );
  }

  // Genres
  write(
    "genres/index.html",
    render({
      title: "Genres",
      route: "genres/",
      nav: "genres",
      description: "Every kind of video the studio makes, each with its method, quality bar and tools.",
      body:
        pageHead(
          "Playbooks",
          "Genres",
          `${books.length} kinds of video, ${ready} ready and ${books.length - ready} in beta. Ask in your own words; the crew matches the request to a genre. Poster art is illustration.`,
        ) +
        section(
          `<div class="grid">${books.map(genreCard).join("") || '<p class="muted">No playbooks in this checkout.</p>'}</div>`,
        ),
    }),
  );
  const byId = new Map(books.map((book) => [book.id, book]));
  for (const book of books) {
    const starter = (book.starter?.blocks ?? []).flatMap((id) => (blocks.get(id) ? [blocks.get(id)!] : []));
    const used = book.library.blocks.flatMap((id) =>
      blocks.get(id) && !book.starter?.blocks.includes(id) ? [blocks.get(id)!] : [],
    );
    const body =
      pageHead(book.status === "draft" ? "Genre · beta" : "Genre", book.title, e(book.summary), [
        "genres/",
        "All genres",
      ]) +
      section(
        `<div class="split top"><div class="frame sticky">${img(readme(`card-${book.id}.jpg`) ?? readme("card-your-genre.jpg"), `Poster art for ${book.title}`)}</div><div><p class="eyebrow left">Say it like</p><div class="meta" style="display:flex;flex-wrap:wrap;gap:.4rem">${book.triggers.en
          .slice(0, 10)
          .map((word) => `<span class="tag cyan">${e(word)}</span>`)
          .join(
            "",
          )}</div><h3 style="margin-top:1.8rem">What QA looks at hardest</h3><ul class="list">${book.qa.map((line) => `<li>${e(plain(line))}</li>`).join("")}</ul>${book.notFor.length ? `<h3 style="margin-top:1.8rem">Not this genre when</h3><ul class="list">${book.notFor.map((row) => `<li>${e(plain(row.when))} → ${byId.has(row.use) ? link(`genres/${row.use}/`, byId.get(row.use)!.title) : e(row.use)}</li>`).join("")}</ul>` : ""}${book.status === "draft" ? `<p class="small muted" style="margin-top:1.5rem">This method is still a draft. ${link("needs/", "Help bring it to ready")}.</p>` : ""}</div></div>`,
      ) +
      (starter.length
        ? section(
            `<p class="eyebrow left">Starter cut</p><h2>The blocks a first cut starts from</h2>${book.starter?.note ? `<p class="lede">${e(plain(book.starter.note))}</p>` : ""}<div class="grid wide" style="margin-top:1.5rem">${starter.map(blockCard).join("")}</div>`,
            "band",
          )
        : "") +
      (used.length
        ? section(
            `<p class="eyebrow left">From the library</p><h2>${plural(used.length, "more block")} this genre uses</h2><div class="grid wide" style="margin-top:1.5rem">${used.map(blockCard).join("")}</div>`,
          )
        : "") +
      section(
        `<div class="facts"><div class="fact"><span>Commands</span><b>${book.commands.length}</b></div><div class="fact"><span>Skills</span><b>${book.skills.length}</b></div><div class="fact"><span>Benchmarks</span><b>${book.benchmarks.length}</b></div><div class="fact"><span>Status</span><b>${e(book.status)}</b></div></div><p class="muted">Method and tools: <a href="${REPOSITORY_URL}/blob/main/playbooks/${e(book.id)}/AGENTS.md">playbooks/${e(book.id)}</a>${
          book.commands.length
            ? ` · commands ${book.commands
                .slice(0, 12)
                .map((command) => `<code>${e(command)}</code>`)
                .join(" ")}`
            : ""
        }</p>`,
        "band",
      );
    write(
      `genres/${book.id}/index.html`,
      render({ title: book.title, route: `genres/${book.id}/`, nav: "genres", description: book.summary, body }),
    );
  }

  // Library
  const libraryGroups = [...new Set(catalogue.map((item) => item.category))];
  const libraryBody =
    pageHead(
      "Motion library",
      `${catalogue.length} motion blocks`,
      "Frame-driven building blocks the films are made from. Each strip is a real render of the block, start to finish.",
    ) +
    section(
      catalogue.length
        ? `<div class="chips" role="group" aria-label="Filter by category"><button class="chip" type="button" data-chip="" aria-pressed="true">All<span>${catalogue.length}</span></button>${libraryGroups.map((id) => `<button class="chip" type="button" data-chip="${e(id)}" aria-pressed="false">${e(CATEGORY_LABELS[id] ?? id)}<span>${catalogue.filter((item) => item.category === id).length}</span></button>`).join("")}</div><div class="filters"><label>Search<input id="search" type="search" placeholder="marquee, counter, phone…" autocomplete="off"></label></div><p id="board-count" class="count" role="status">${catalogue.length} shown</p>${libraryGroups
            .map(
              (id) =>
                `<div data-section><div class="board-cat"><h2>${e(CATEGORY_LABELS[id] ?? id)}</h2></div><div class="grid wide">${catalogue
                  .filter((item) => item.category === id)
                  .map(blockCard)
                  .join("")}</div></div>`,
            )
            .join("")}`
        : '<div class="empty"><p>No library catalogue in this checkout.</p></div>',
    );
  write(
    "library/index.html",
    render({
      title: "Motion library",
      route: "library/",
      nav: "library",
      description: `${catalogue.length} frame-driven motion design blocks with real rendered previews.`,
      script: board,
      body: libraryBody,
    }),
  );

  // Crew
  write(
    "crew/index.html",
    render({
      title: "The crew",
      route: "crew/",
      nav: "crew",
      description: "The agents that staff the studio, each with one job.",
      body:
        pageHead(
          "Behind the camera",
          "The crew",
          `${plural(agents.length, "agent")}, each with one job and one output. Leaf agents: they never hire more agents.`,
        ) +
        section(
          `<div class="grid four">${DEPARTMENTS.map(([icon, name]) => `<div class="dept">${img(readme(`icon-${icon}.png`), "", ' width="84" height="84"')}<h3>${e(name)}</h3></div>`).join("")}</div>`,
          "band",
        ) +
        section(
          `<div class="grid wide">${agents.map((agent) => `<article class="card"><div class="body"><h3><code>${e(agent.name)}</code></h3><p>${e(clip(agent.description, 260))}</p><div class="meta">${agent.model ? `<span class="tag">${e(agent.model)}</span>` : ""}</div></div></article>`).join("") || '<p class="muted">No agents in this checkout.</p>'}</div>`,
        ),
    }),
  );

  // Contribute: the needs board
  const order = categories.map((row) => row.id);
  const groups = needs
    ? [...new Set(needs.rows.map((row) => row.category))].sort(
        (a, b) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99),
      )
    : [];
  const categoryTitle = (id: string) => categories.find((row) => row.id === id)?.title ?? id;
  const issueUrl = (row: Need) =>
    `${REPOSITORY_URL}/issues/new?${new URLSearchParams({ template: "opportunity.yml", title: `[Opportunity] ${row.title}`, category: row.category, size: row.size, problem: `${row.why}\n\nScout id: ${row.id}\nEvidence: ${row.evidence.join(", ")}`, done: row.definitionOfDone.join("\n") }).toString()}`;
  const job = (row: Need) =>
    `<article class="job" data-item data-group="${e(row.category)}" data-size="${row.size}" data-search="${e(`${row.title} ${row.why} ${row.category} ${row.id}`.toLowerCase())}"><div class="row"><span class="tag gold">${e(row.category)}</span><span class="tag">${row.size === "S" ? "S · up to 300 lines" : row.size === "M" ? "M · claim first" : "L · proposal first"}</span>${row.covering.length ? '<span class="tag cyan">Has an issue</span>' : ""}</div><h3>${e(row.title)}</h3><p>${e(clip(row.why, 260))}</p><details><summary>Evidence and definition of done</summary><ul>${row.definitionOfDone.map((item) => `<li>${e(plain(item))}</li>`).join("")}</ul><p class="small" style="margin-top:.5rem">Evidence: ${row.evidence
      .slice(0, 8)
      .map((item) => `<code>${e(item)}</code>`)
      .join(
        " ",
      )}</p><p class="small">Scout id <code>${e(row.id)}</code></p></details><div class="go"><a class="claim" href="${e(issueUrl(row))}">${row.size === "S" ? "Open an issue" : "Claim via issue"}</a><a href="${e(`${REPOSITORY_URL}/issues?q=${encodeURIComponent(row.id)}`)}">Already taken?</a></div></article>`;
  const SHOWN = 9;
  const featured = needs?.rows.filter((row) => row.source === "curated") ?? [];
  const featuredJob = (row: Need) => job(row).replace(" data-item data-group=", " data-featured data-group=");
  const needsBody = needs
    ? pageHead(
        "Join the crew",
        "Pick a job",
        `${needs.total} open jobs found by scanning the repository, not assigned by anyone. Choose one yourself, or let your agent choose; you stay the accountable human.`,
      ) +
      section(
        `<div class="steps"><div class="step"><h3>Small (S)</h3><p>Up to 300 changed lines in one category. Just start: fork, change, test, open a PR.</p></div><div class="step"><h3>Medium (M)</h3><p>Up to 1000 lines. Comment <code>/claim</code> on the issue first and link a draft PR within seven days.</p></div><div class="step"><h3>Large (L)</h3><p>New dependencies, categories or contracts. Open a proposal with an RFC draft and wait for design approval.</p></div></div><pre class="cmd" style="margin-top:1.5rem"><span class="c"># let your agent pick and do the work, from a fork</span>\n<span class="p">$</span> pnpm contrib:scout --online --tier 0   <span class="c"># jobs you may take, newest data from GitHub</span>\n<span class="p">$</span> pnpm contrib:check                     <span class="c"># the same gates CI runs</span>\n<span class="p">$</span> pnpm contrib:pr --out .contrib/pr.md   <span class="c"># the PR body, then gh pr create</span></pre><p class="small muted">The board is a snapshot from the last build; <code>contrib:scout --online</code> drops work already claimed or in an open PR. Read <a href="${REPOSITORY_URL}/blob/main/contrib/AGENTS.md">contrib/AGENTS.md</a> before an agent starts.</p>`,
        "band",
      ) +
      (featured.length
        ? section(
            `<p class="eyebrow left">Picked by the maintainer</p><h2>Bigger jobs that move the studio forward</h2><p class="lede">Agent judgement, prompts, genres and evidence that a scan cannot find. These shape what the brothers can do next.</p><div class="grid wide" style="margin-top:1.5rem">${featured.map(featuredJob).join("")}</div>`,
          )
        : "") +
      section(
        `<p class="eyebrow left">Every open job</p><div class="chips" role="group" aria-label="Filter by category"><button class="chip" type="button" data-chip="" aria-pressed="true">All<span>${needs.rows.length}</span></button>${groups.map((id) => `<button class="chip" type="button" data-chip="${e(id)}" aria-pressed="false">${e(id)}<span>${needs.counts[id] ?? needs.rows.filter((row) => row.category === id).length}</span></button>`).join("")}</div><div class="filters"><label>Size<select id="size"><option value="">Any size</option><option value="S">S</option><option value="M">M</option><option value="L">L</option></select></label><label>Search<input id="search" type="search" placeholder="sensor, caption, playbook…" autocomplete="off"></label></div><p id="board-count" class="count" role="status">${needs.rows.length} shown</p>${groups
          .map((id) => {
            const rows = needs.rows.filter((row) => row.category === id);
            const valuable = categories.find((row) => row.id === id)?.valuable;
            return `<div data-section><div class="board-cat"><h2>${e(categoryTitle(id))}</h2><span class="tag gold">${needs.counts[id] ?? rows.length}</span>${valuable ? `<p class="small">${e(clip(valuable, 220))}</p>` : ""}</div><div class="grid wide">${rows.slice(0, SHOWN).map(job).join("")}</div>${rows.length > SHOWN ? `<details class="more"><summary>${rows.length - SHOWN} more ${e(id)} jobs</summary><div class="grid wide">${rows.slice(SHOWN).map(job).join("")}</div></details>` : ""}</div>`;
          })
          .join("")}`,
      )
    : pageHead("Join the crew", "Pick a job", "Open jobs are scanned from the repository.") +
      section(
        '<div class="empty"><p>No needs snapshot available. Scout opportunities locally or visit GitHub issues.</p><pre>pnpm contrib:scout --online</pre></div>',
      );
  write(
    "needs/index.html",
    render({
      title: "Contribute",
      route: "needs/",
      nav: "needs",
      description:
        "Open jobs on the Agent Bros. Pictures lot, found by scanning the repository. Pick one, or let your agent pick.",
      script: needs ? board : undefined,
      body: needsBody,
    }),
  );

  // Contributors
  write(
    "contributors/index.html",
    render({
      title: "Contributors",
      route: "contributors/",
      nav: "other",
      body:
        pageHead(
          "End credits",
          "Contributors",
          "Alphabetical credits by category. Counts are evidence of contribution, not a ranking.",
        ) +
        section(
          `${stats.contributors.length ? `<div class="grid">${stats.contributors.map((row) => `<article class="card"><div class="body"><h3>${link(`contributors/${row.handle}/`, row.profile?.displayName ?? row.handle)}</h3><p>${e(row.profile?.bio ?? "")}</p><div class="meta">${row.badges.map((badge) => `<span class="tag gold">${e(badge)}</span>`).join("")}</div></div></article>`).join("")}</div>` : '<div class="empty"><p>No contributor profiles yet.</p></div>'}${stats.warnings.length ? `<details class="more"><summary>Attribution notes</summary>${data(stats.warnings)}</details>` : ""}`,
        ),
    }),
  );
  for (const row of stats.contributors)
    write(
      `contributors/${row.handle}/index.html`,
      render({
        title: row.profile?.displayName ?? row.handle,
        route: `contributors/${row.handle}/`,
        nav: "other",
        body:
          pageHead(`@${row.handle}`, row.profile?.displayName ?? row.handle, e(row.profile?.bio ?? ""), [
            "contributors/",
            "All contributors",
          ]) +
          section(
            `<p>${e(row.profile?.credits ?? "")}</p>${(row.profile?.links ?? []).map((url) => `<p><a href="${e(url)}">Contributor link</a></p>`).join("")}<div class="facts">${Object.entries(
              row.mergedByCategory,
            )
              .map(([id, count]) => `<div class="fact"><span>${e(id)}</span><b>${count}</b></div>`)
              .join(
                "",
              )}<div class="fact"><span>Blocks authored</span><b>${row.blocksAuthored}</b></div><div class="fact"><span>Showcases</span><b>${row.showcases}</b></div></div><h2>Contributions</h2>${data({ ...row, profile: undefined })}`,
          ),
      }),
    );

  // Metrics
  const metrics = optionalJson(path.join(root, "out/metrics/metrics.json")) as
    { raw?: Record<string, unknown>; verified?: Record<string, number>; health?: { unknown?: string[] } } | undefined;
  const number = (value: unknown): string =>
    typeof value === "number"
      ? String(value)
      : value &&
          typeof value === "object" &&
          "total" in value &&
          typeof (value as { total: unknown }).total === "number"
        ? String((value as { total: number }).total)
        : "—";
  const rawFacts = metrics?.raw
    ? Object.entries(metrics.raw)
        .map(
          ([key, value]) =>
            `<div class="fact"><span>${e(key.replace(/([A-Z])/g, " $1").toLowerCase())}</span><b>${e(number(value))}</b></div>`,
        )
        .join("")
    : "";
  write(
    "metrics/index.html",
    render({
      title: "Metrics",
      route: "metrics/",
      nav: "other",
      body:
        pageHead(
          "Inventory",
          "Metrics",
          "Inventory, health and context from the last build. A count is not a quality claim.",
        ) +
        section(
          metrics
            ? `<div class="facts">${rawFacts}</div>${
                metrics.verified
                  ? `<h2>With evidence</h2><div class="facts">${Object.entries(metrics.verified)
                      .map(([key, value]) => `<div class="fact"><span>${e(key)}</span><b>${e(value)}</b></div>`)
                      .join("")}</div>`
                  : ""
              }${metrics.health?.unknown?.length ? `<h2>Not measured here</h2><ul class="list">${metrics.health.unknown.map((line) => `<li>${e(line)}</li>`).join("")}</ul>` : ""}<details class="more"><summary>Full snapshot</summary>${data(metrics)}</details>`
            : '<div class="empty"><p>No metrics snapshot available. Generate out/metrics/metrics.json to publish inventory and health data.</p></div>',
        ),
    }),
  );

  // Benchmarks
  const benchFiles = jsonFiles(path.join(root, "bench/results"));
  const benchmarkRows = benchFiles
    .map((file, index) => {
      const bundle = optionalJson(file);
      const name = `result-${index + 1}.json`;
      write(`benchmarks/data/${name}`, JSON.stringify(bundle, null, 2) + "\n");
      return `<tr><th scope="row">${e(path.basename(file, ".json"))}</th><td>${data(bundle)}</td><td>${link(`benchmarks/data/${name}`, "Download JSON")}</td></tr>`;
    })
    .join("");
  write(
    "benchmarks/index.html",
    render({
      title: "Benchmarks",
      route: "benchmarks/",
      nav: "other",
      body:
        pageHead(
          "Evidence",
          "Benchmarks",
          "Submitted results retain their intervals, uncertainty and verification status. Sound requires measured evidence and human review.",
        ) +
        section(
          benchmarkRows
            ? `<div class="table"><table><caption class="small muted" style="text-align:left;padding:.8rem">Benchmark result bundles, including reported intervals</caption><thead><tr><th scope="col">Bundle</th><th scope="col">Results and intervals</th><th scope="col">Data</th></tr></thead><tbody>${benchmarkRows}</tbody></table></div>`
            : '<div class="empty"><p>No benchmark results published yet.</p></div>',
        ),
    }),
  );

  // Releases
  const changelog = path.join(root, "CHANGELOG.md");
  write(
    "releases/index.html",
    render({
      title: "Release history",
      route: "releases/",
      nav: "other",
      body:
        pageHead(
          "Changelog",
          "Release history",
          `Every release, from the change entries merged into it. <a href="${REPOSITORY_URL}/releases">Releases on GitHub</a>, each with a signed provenance attestation.`,
        ) +
        section(
          `<div class="prose">${existsSync(changelog) ? changelogHtml(readFileSync(changelog, "utf8")) : '<div class="empty"><p>No releases published yet.</p></div>'}</div>`,
        ),
    }),
  );

  const generatedFiles = outputs.map((file) => path.relative(output, path.join(root, file)).split(path.sep).join("/"));
  for (const file of previousFiles)
    if (!generatedFiles.includes(file) && existsSync(path.join(output, file))) unlinkSync(path.join(output, file));
  mkdirSync(output, { recursive: true });
  writeFileSync(manifestFile, JSON.stringify(generatedFiles, null, 2) + "\n");
  outputs.push(path.relative(root, manifestFile));
  return {
    outputs,
    metadata: {
      showcases: entries.length,
      contributors: stats.contributors.length,
      genres: books.length,
      blocks: catalogue.length,
      agents: agents.length,
      needs: needs?.total ?? 0,
      warnings: stats.warnings,
      baseUrl: SITE_URL,
    },
  };
}
