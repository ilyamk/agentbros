import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { BenchSuiteSchema, BenchTaskSchema } from "../src/types/bench";
import { PlaybookSchema, type Playbook } from "../src/types/playbook";
import { evaluateMatching, loadMatchCorpus, MATCH_CORPUS } from "../src/lib/playbooks/eval";
import { WorkflowKindSchema } from "../src/lib/workflows/dispatch";
import { playbookSuggest, rootOfProject, withPlaybook } from "../src/lib/pipeline/route";
import {
  benchmarkWarning,
  bindingConflict,
  ENFORCE_READY_FIELDS,
  INDEX_DOC,
  knownNames,
  listPlaybookIds,
  mentions,
  playbookProblems,
  playbooksRoot,
  playbookUses,
  playbookWarnings,
  readinessProblems,
  reviewAgeWarning,
  useContext,
  wordMatches,
  loadPlaybook,
  loadPlaybooks,
  matchAgainst,
  matchPlaybooks,
  parseLessons,
  lessonsFor,
  playbookRead,
  resolvePlaybook,
  validatePlaybookRefs,
  withIndexTable,
  writeProjectPlaybook,
} from "../src/lib/playbooks";
import { addMemory, setStatus } from "../src/lib/memory";

const REPO = process.cwd();
const SECTIONS = [
  "## Start",
  "## What good looks like",
  "## Method",
  "## Tools",
  "## Anti-patterns",
  "## References",
  "## Done when",
];
const PLACEHOLDER = /<!--[^>]*fills this section[^>]*-->/;

test("every playbook folder has AGENTS.md and a valid playbook.json whose id is the folder", () => {
  const ids = listPlaybookIds();
  assert.ok(ids.includes("footage-edit"));
  for (const id of ids) {
    assert.ok(existsSync(`playbooks/${id}/AGENTS.md`), id);
    const parsed = PlaybookSchema.safeParse(JSON.parse(readFileSync(`playbooks/${id}/playbook.json`, "utf8")));
    assert.ok(parsed.success, `${id}: ${parsed.success ? "" : JSON.stringify(parsed.error.issues)}`);
    assert.equal(parsed.data.id, id);
  }
});

test("every playbook AGENTS.md has the seven sections in order, a date, resolvable links and at most 12 KiB (the sub-area budget in tests/AGENTS.md)", () => {
  for (const id of listPlaybookIds()) {
    const file = `playbooks/${id}/AGENTS.md`;
    const text = readFileSync(file, "utf8");
    assert.match(text, /^Last updated: \d{4}-\d{2}-\d{2}$/m, file);
    assert.ok(statSync(file).size <= 12 * 1024, `${file} is ${statSync(file).size} bytes`);
    const headings = text.split("\n").filter((line) => line.startsWith("## "));
    assert.deepEqual(headings, SECTIONS, file);
    for (const match of text.matchAll(/\]\(([^)]+)\)/g)) {
      const link = match[1]!.split("#")[0]!;
      if (link && !/^https?:/.test(link))
        assert.ok(existsSync(path.resolve(path.dirname(file), link)), `${file}: ${link}`);
    }
  }
});

test("a ready playbook holds no placeholder section", () => {
  for (const id of listPlaybookIds()) {
    if (loadPlaybook(id).status !== "ready") continue;
    assert.doesNotMatch(
      readFileSync(`playbooks/${id}/AGENTS.md`, "utf8"),
      PLACEHOLDER,
      `playbooks/${id}/AGENTS.md is ready but has a placeholder`,
    );
  }
});

test("every reference in a playbook resolves", () => {
  assert.deepEqual(validatePlaybookRefs(), []);
});

test("benchmark tasks are named by their playbooks and unknown task ids fail validation", () => {
  const known = knownNames();
  const suite = BenchSuiteSchema.parse(JSON.parse(readFileSync("bench/suite.json", "utf8")));
  for (const entry of suite.tasks) {
    const task = BenchTaskSchema.parse(JSON.parse(readFileSync(entry.path, "utf8")));
    assert.ok(loadPlaybook(task.playbook).benchmarks.includes(entry.id), entry.id);
  }
  const book = loadPlaybook("explainer");
  assert.deepEqual(playbookProblems(book, REPO, known), []);
  assert.deepEqual(playbookProblems({ ...book, benchmarks: ["missing-task"] }, REPO, known), [
    "unknown benchmark task missing-task (not in bench/suite.json)",
  ]);
  assert.deepEqual(playbookProblems({ ...book, status: "draft", benchmarks: ["missing-task"] }, REPO, known), [
    "unknown benchmark task missing-task (not in bench/suite.json)",
  ]);
  assert.deepEqual(
    playbookProblems(book, REPO, { ...known, benchmarks: new Set() }),
    ["unknown benchmark task explainer (not in bench/suite.json)"],
    "the suite is the source of known ids",
  );
});

test("ready benchmark gaps warn by default and fail only strict validation", () => {
  const book = { ...loadPlaybook("explainer"), benchmarks: [] };
  const warning = benchmarkWarning(book)!;
  assert.match(warning, /ready playbook needs at least 1 benchmark task/);
  assert.deepEqual(playbookProblems(book, REPO, knownNames()), []);
  assert.deepEqual(playbookProblems(book, REPO, knownNames(), { strictBenchmarks: true }), [warning]);
  assert.deepEqual(playbookWarnings([book], new Date("2026-11-15")), [`explainer: ${warning}`]);
  assert.equal(benchmarkWarning({ ...book, status: "draft" }), undefined);
  assert.deepEqual(playbookProblems({ ...book, status: "draft" }, REPO, knownNames(), { strictBenchmarks: true }), []);
  assert.equal(benchmarkWarning(loadPlaybook("explainer")), undefined);
  const strict = validatePlaybookRefs(REPO, { strictBenchmarks: true });
  const gaps = listPlaybookIds()
    .map((id) => loadPlaybook(id))
    .filter((book) => benchmarkWarning(book));
  assert.deepEqual(
    strict,
    gaps.map((book) => `${book.id}: ${benchmarkWarning(book)}`),
  );
});

test("playbook check CLI reports benchmark warnings and strict errors in one JSON line", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "playbook-check-"));
  try {
    for (const [args, status] of [
      [["--check"], 0],
      [["--check", "--strict-benchmarks"], 1],
      [["--strict-benchmarks"], 1],
    ] as const) {
      const run = spawnSync(
        process.execPath,
        [
          "--import",
          path.join(REPO, "node_modules/tsx/dist/loader.mjs"),
          path.join(REPO, "scripts/playbook.ts"),
          ...args,
        ],
        {
          cwd,
          encoding: "utf8",
          env: {
            AGENTBROS_NO_DOTENV: "1",
            PATH: process.env.PATH,
            AGENTBROS_MEMORY_ROOT: process.env.AGENTBROS_MEMORY_ROOT,
          },
        },
      );
      assert.equal(run.status, status, run.stdout + run.stderr);
      assert.equal(run.stdout.trim().split("\n").length, 1);
      const result = JSON.parse(run.stdout);
      assert.equal(result.ok, status === 0);
      if (status === 0)
        assert.ok(result.metadata.warnings.some((warning: string) => warning.includes("benchmark task")));
      else if (args.some((arg) => arg === "--check")) {
        assert.equal(result.error, "VALIDATION");
        assert.ok(result.details.problems.every((problem: string) => problem.includes("benchmark task")));
      } else assert.equal(result.error, "INVALID_INPUT");
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("the playbook route workflow enum equals the video:workflow scenarios", () => {
  const route = PlaybookSchema.shape.route.options.find((option) => "workflow" in option.shape)!;
  assert.deepEqual(
    [...(route.shape as { workflow: { options: string[] } }).workflow.options],
    [...WorkflowKindSchema.options],
  );
});

test(`${INDEX_DOC}: the index table is fresh and its links resolve`, () => {
  const text = readFileSync(INDEX_DOC, "utf8");
  assert.equal(text, withIndexTable(text), "run pnpm playbook --write-doc");
  assert.match(text, /^Last updated: \d{4}-\d{2}-\d{2}$/m);
  assert.ok(statSync(INDEX_DOC).size <= 12 * 1024, `${INDEX_DOC} exceeds the 12 KiB sub-area budget`);
  for (const match of text.matchAll(/\]\(([^)]+)\)/g)) {
    const link = match[1]!.split("#")[0]!;
    if (link && !/^https?:/.test(link)) assert.ok(existsSync(path.resolve("playbooks", link)), link);
  }
});

const fixture = (
  id: string,
  status: Playbook["status"],
  en: string[],
  ru: string[],
  notFor: Playbook["notFor"] = [],
): Playbook => ({
  ...loadPlaybook("footage-edit"),
  id,
  title: id,
  status,
  summary: `the ${id} fixture task`,
  triggers: { en, ru, zh: ["夹具任务", "测试任务", "示例任务"] },
  notFor,
  intake: undefined,
  profiles: undefined,
  starter: undefined,
  variants: undefined,
  evidence: undefined,
  reviewedAt: undefined,
});

const words = (result: ReturnType<typeof matchAgainst>) => result.candidates.map((x) => [x.id, x.score]);

test("matching: stems, phrases, ranking, ties, strength and no weak verdict", () => {
  const a = fixture(
    "alpha",
    "ready",
    ["tutorial", "how to use", "walkthrough"],
    ["туториал", "как пользоваться", "обучающ"],
  );
  const b = fixture("beta", "draft", ["promo", "launch film", "teaser"], ["промо", "тизер", "запуск"]);
  const c = fixture(
    "gamma",
    "ready",
    ["promo", "teaser", "ad"],
    ["промо", "тизер", "реклам"],
    [{ when: "it is a launch film", use: "beta" }],
  );
  const d = fixture("delta", "ready", ["promo", "teaser", "clip"], ["промо", "тизер", "клип"]);
  assert.deepEqual(
    matchAgainst("Сделай ТУТОРИАЛА по сервису", [a, b]).candidates.map((x) => x.id),
    ["alpha"],
  );
  assert.deepEqual(matchAgainst("покажи как пользоваться приложением", [a, b]).candidates[0]!.matched, [
    { trigger: "как пользоваться", words: "как пользоваться" },
  ]);
  assert.equal(matchAgainst("how do I use it", [a]).candidates.length, 0, "a phrase matches only in order");
  const launch = matchAgainst("a teaser for our launch film", [a, b]);
  assert.deepEqual(words(launch), [["beta", 2.5]], "a trigger counts once, a phrase 0.5 more per extra word");
  assert.equal(launch.strength, "clear");
  assert.deepEqual(launch.candidates[0]!.matched, [
    { trigger: "launch film", words: "launch film" },
    { trigger: "teaser", words: "teaser" },
  ]);
  const tied = matchAgainst("промо тизер", [b, c, d]);
  assert.equal(tied.tie, true, "a tie spans every candidate at the top score");
  assert.equal(tied.strength, "weak");
  assert.deepEqual(
    tied.candidates.map((x) => x.id),
    ["delta", "gamma", "beta"],
    "a draft ranks below a ready playbook on equal scores",
  );
  assert.match(tied.question!, /"delta".*"gamma".*"beta".*"beta" fits when it is a launch film/);
  assert.equal(matchAgainst("сделай тизер", [b, c]).strength, "weak");
  assert.equal(matchAgainst("a promo teaser ad", [c, d]).strength, "clear", "gamma 3 against delta 2");
  assert.equal(matchAgainst("a promo teaser", [c, d]).strength, "weak", "a lead of less than 1 is weak");
  assert.equal(matchAgainst("сделай тизер", [c]).strength, "weak", "a single trigger is weak");
  assert.equal(
    matchAgainst("a launch film please", [a, b]).strength,
    "clear",
    "a lone candidate on one two-word phrase (1.5) is clear",
  );
  assert.equal(matchAgainst("нужен как пользоваться гайд", [a]).strength, "clear", "same in Russian");
  assert.equal(
    matchAgainst("a launch film tutorial", [a, b]).strength,
    "weak",
    "a phrase with a rival keeps the old rule: 1.5 against 1",
  );
  assert.deepEqual(matchAgainst("какая погода завтра", [a, b, c]), {
    candidates: [],
    tie: false,
    strength: "none",
    modifiers: [],
  });
  assert.equal(matchAgainst("an adventure", [c]).candidates.length, 0, "short triggers match whole words only");
});

test("matching: Chinese triggers match as character runs, beside Latin words", () => {
  const tutorial = {
    ...fixture("alpha", "ready", ["tutorial"], ["туториал"]),
    triggers: { en: ["tutorial"], ru: ["туториал"], zh: ["教程", "使用教程"] },
  };
  const promo = {
    ...fixture("beta", "ready", ["promo"], ["промо"]),
    triggers: { en: ["promo", "app"], ru: ["промо"], zh: ["宣传片"] },
  };
  const hit = matchAgainst("做一个产品使用教程视频", [tutorial, promo]);
  assert.deepEqual(words(hit), [["alpha", 1.5]], "the longer run covers 教程; two characters count as one word");
  assert.deepEqual(hit.candidates[0]!.matched, [{ trigger: "使用教程", words: "使 用 教 程" }]);
  assert.deepEqual(
    words(matchAgainst("给我的App做个宣传片", [tutorial, promo])),
    [["beta", 2.5]],
    "app is its own token",
  );
  assert.equal(matchAgainst("宣传", [promo]).strength, "none", "a partial run does not match");
  assert.equal(matchAgainst("宣的传片", [promo]).strength, "none", "no extra character inside a Chinese run");
});

test("matching: one extra word may stand inside a phrase", () => {
  const recap = fixture("alpha", "ready", ["event video"], ["видео с конференции"]);
  assert.deepEqual(words(matchAgainst("смонтируй видео с нашей конференции", [recap])), [["alpha", 2]]);
  assert.deepEqual(words(matchAgainst("an event highlight video", [recap])), [["alpha", 1.5]]);
  assert.equal(matchAgainst("видео с нашей большой конференции", [recap]).strength, "none", "two extra words break it");
});

test("matching: generic triggers score half and never make a match clear", () => {
  const shorts = {
    ...fixture("alpha", "ready", ["short clips", "cut into shorts"], ["короткие ролики", "нарезк"]),
    triggers: {
      en: ["short clips", "cut into shorts"],
      ru: ["короткие ролики", "нарезк"],
      generic: ["короткие ролики"],
    },
  };
  const only = matchAgainst("хочу короткий ролик про стартап", [shorts]);
  assert.deepEqual(words(only), [["alpha", 0.5]]);
  assert.equal(only.strength, "weak");
  assert.equal(only.candidates[0]!.specific, false);
  assert.deepEqual(only.candidates[0]!.matched[0]!.generic, true);
  const both = matchAgainst("нарезка: короткие ролики из подкаста", [shorts]);
  assert.equal(both.strength, "clear", "a specific trigger beside it still binds: 1 + 0.5 alone");
  assert.equal(both.candidates[0]!.specific, true);
});

test("matching: variant triggers add to the score and name the variant, in both languages", () => {
  const base = fixture(
    "edit",
    "ready",
    ["cut my video", "subtitles", "remove pauses"],
    ["смонтируй", "субтитр", "убери паузы"],
  );
  const edit: Playbook = {
    ...base,
    variants: [
      {
        id: "podcast",
        title: "Podcast episode",
        triggers: { en: ["podcast", "episode"], ru: ["подкаст", "выпуск"] },
        changes: "two voices, no jump cuts inside answers",
      },
      {
        id: "lecture",
        title: "Lecture",
        triggers: { en: ["lecture", "slides"], ru: ["лекци", "слайд"] },
        changes: "slides stay on screen; cut only pauses",
      },
    ],
  };
  const other = fixture("other", "ready", ["subtitles", "translate"], ["субтитр", "перевод"]);
  const en = matchAgainst("cut my video, it is a podcast episode with subtitles", [edit, other]);
  assert.equal(en.candidates[0]!.id, "edit");
  assert.deepEqual(en.candidates[0]!.variant, { id: "podcast", title: "Podcast episode" });
  assert.equal(
    en.candidates[0]!.score,
    5,
    "cut my video 2 (a three-word phrase) + subtitles 1 + podcast 1 + episode 1",
  );
  assert.ok(en.candidates[0]!.matched.some((hit) => hit.variant === "podcast" && hit.words === "podcast"));
  assert.equal(en.candidates.find((x) => x.id === "other")!.variant, undefined);
  const ru = matchAgainst("смонтируй мою лекцию со слайдами", [edit, other]);
  assert.deepEqual(ru.candidates[0]!.variant, { id: "lecture", title: "Lecture" });
  assert.equal(ru.candidates[0]!.score, 3);
  assert.equal(ru.strength, "clear");
  assert.equal(
    matchAgainst("смонтируй видео", [edit]).candidates[0]!.variant,
    undefined,
    "no variant trigger, no variant",
  );
  const repeated: Playbook = {
    ...base,
    variants: [
      {
        id: "subs",
        title: "Subtitles only",
        triggers: { en: ["subtitles"], ru: ["субтитр"] },
        changes: "captions over the untouched recording",
      },
    ],
  };
  assert.equal(
    matchAgainst("subtitles", [repeated]).candidates[0]!.score,
    1,
    "a variant trigger repeating a main one counts once",
  );
});

test("matching: a stem needs five shared letters, so near words do not collide", () => {
  for (const [token, word] of [
    ["prompt", "promo"],
    ["промышленной", "промо"],
    ["запутанная", "запуск"],
    ["less", "lesson"],
    ["adventure", "ad"],
  ])
    assert.equal(wordMatches(token, word), false, `${token} ~ ${word}`);
  for (const [token, word] of [
    ["субтитрами", "субтитр"],
    ["запуска", "запуск"],
    ["запустим", "запуск"],
    ["туториала", "туториал"],
    ["subtitle", "subtitles"],
    ["ad", "ad"],
  ])
    assert.equal(wordMatches(token, word), true, `${token} ~ ${word}`);
});

test("matching: a trigger inside a longer matched one does not count again; a URL is not request words", () => {
  const p = fixture("pi", "ready", ["promo", "promo video", "youtube"], ["промо", "промо-ролик", "ролик"]);
  assert.deepEqual(words(matchAgainst("промо-ролик", [p])), [["pi", 1.5]]);
  assert.deepEqual(
    words(matchAgainst("promo video, then another promo", [p])),
    [["pi", 2.5]],
    "a shorter trigger counts where it adds words",
  );
  assert.equal(matchAgainst("https://youtube.com/watch?v=x", [p]).candidates.length, 0);
});

test("matching: modifiers and an existing project", () => {
  const none: Playbook[] = [];
  assert.deepEqual(matchAgainst("сделай ролик в стиле этого", none).modifiers, ["reference-style"]);
  assert.deepEqual(matchAgainst("a film for our app like this video", none).modifiers, ["reference-style"]);
  for (const url of [
    "https://youtube.com/watch?v=x",
    "youtu.be/abc",
    "https://www.tiktok.com/@a/video/1",
    "instagram.com/reel/x",
    "https://vimeo.com/1",
    "https://x.com/a/status/1",
  ])
    assert.deepEqual(matchAgainst(`сделай такой же по мотивам ${url}`, none).modifiers, ["reference-style"], url);
  for (const copy of [
    "сделай точную копию этого ролика",
    "скопируй этот ролик https://youtu.be/abc",
    "copy exactly this film",
    "replicate this ad shot for shot",
  ])
    assert.deepEqual(matchAgainst(copy, none).modifiers, ["replica"], copy);
  assert.deepEqual(matchAgainst("a product film", none).modifiers, []);
  const exists = (id: string) => ["bb-launch-r1", "demo"].includes(id);
  assert.equal(
    matchAgainst("перерендери проект demo в вертикальном формате", none, { projectExists: exists }).existingProject,
    "demo",
  );
  assert.equal(
    matchAgainst("re-render bb-launch-r1 as a square", none, { projectExists: exists }).existingProject,
    "bb-launch-r1",
  );
  assert.equal(
    matchAgainst("a demo of our app", none, { projectExists: exists }).existingProject,
    undefined,
    'a bare word is a project only after "project"',
  );
});

/**
 * The labelled corpus (tests/fixtures/playbooks/match-corpus.json, `pnpm playbook --eval`): requests phrased as users
 * phrase them in English, Russian and Chinese. Floors leave room for a new playbook to cost a little; a wrong clear
 * match binds the wrong method without a question and is never allowed, nor is a clear match of a vague request.
 */
test("matching corpus: top-1 and clear floors per language, no wrong clear match", () => {
  const report = evaluateMatching(loadMatchCorpus(MATCH_CORPUS), loadPlaybooks());
  const misses = JSON.stringify(report.misses.filter((miss) => miss.outcome !== "right-weak"));
  assert.equal(report.counts["wrong-clear"], 0, misses);
  assert.equal(report.counts["vague-clear"], 0, misses);
  assert.ok(report.top1 >= 0.95, `top-1 ${report.top1}: ${misses}`);
  assert.ok(report.clear >= 0.7, `clear ${report.clear}`);
  for (const lang of ["en", "ru", "zh"]) {
    assert.ok(report.byLanguage[lang]!.cases >= 40, `${lang}: at least 40 cases`);
    assert.ok(report.byLanguage[lang]!.top1 >= 0.9, `${lang} top-1 ${report.byLanguage[lang]!.top1}: ${misses}`);
  }
  const ids = new Set(loadPlaybooks().map((playbook) => playbook.id));
  const covered = new Set(loadMatchCorpus(MATCH_CORPUS).cases.flatMap((item) => item.expect.slice(0, 1)));
  assert.deepEqual(
    [...ids].filter((id) => !covered.has(id)),
    [],
    "every playbook is some case's best answer",
  );
});

const CASES: [string, string][] = [
  ["смонтируй моё интервью и добавь субтитры", "footage-edit"],
  ["убери паузы и слова-паразиты из моего видео", "footage-edit"],
  ["remove the ums from my talk", "footage-edit"],
  ["I have two cameras, sync them and make it vertical", "footage-edit"],
  ["cut my podcast into reels", "shorts-from-long"],
  ["сделай промо ролик для запуска приложения", "product-promo"],
  ["make a product launch teaser", "teaser-trailer"],
  ["сделай туториал как пользоваться нашим сервисом", "product-tutorial"],
  ["a walkthrough video showing how to use our dashboard", "product-tutorial"],
  ["объясни как работает блокчейн в видео", "explainer"],
  ["an educational video explaining how vaccines work", "explainer"],
  ["анимационный ролик с кинетической типографикой", "motion-design"],
  ["a logo animation for our studio", "motion-design"],
  ["сделай ролик из AI генерации", "ai-film"],
  ["a short film made entirely from AI generated shots", "ai-film"],
  ["смонтируй ролик под музыку из стоковых видео", "stock-montage"],
];

/** Cases found by the review and the fresh-agent test. */
for (const [request, expected] of [
  ["нарежь шортсы из моего подкаста", "shorts-from-long"],
  ["an AI ad for my app", "product-promo"],
  ["explain how my app works", "product-tutorial"],
] as const) {
  test(`match: "${request}" -> ${expected}`, () => {
    const result = matchPlaybooks(request);
    assert.equal(result.candidates[0]?.id, expected, JSON.stringify(words(result)));
    assert.equal(result.tie, false);
  });
}

/** Typical first requests in both languages resolve clearly, so an agent can bind without asking. */
for (const [request, expected] of [
  ["make a 30 second product launch video for my app", "product-promo"],
  ["promo video for our new SaaS product", "product-promo"],
  ["видео о запуске нашего продукта", "product-promo"],
  ["cut my podcast recording into shorts", "shorts-from-long"],
  ["нарежь мой подкаст на шортсы", "shorts-from-long"],
  ["remove the pauses and add subtitles to my video", "footage-edit"],
  ["explainer video about how our API works", "explainer"],
  // Neighbours: the triggers above steal none of these.
  ["edit my recording into a tight 10 minute video", "footage-edit"],
  ["turn my podcast into a video with captions", "footage-edit"],
] as const) {
  test(`match clearly: "${request}" -> ${expected}`, () => {
    const result = matchPlaybooks(request);
    assert.equal(result.candidates[0]?.id, expected, JSON.stringify(words(result)));
    assert.equal(result.strength, "clear", JSON.stringify(words(result)));
  });
}

/** Round 2: the new playbooks and the boundaries their authors probed. Each wins without a tie. */
for (const [request, expected, variant] of [
  ["анонс новой функции для линкедина", "feature-update"],
  ["make a changelog video: what's new in our app", "feature-update"],
  ["video for our new feature launch", "feature-update"],
  ["сделай превью для app store", "app-store-preview"],
  ["видео для google play", "app-store-preview"],
  ["make an App Store preview for our app", "app-store-preview"],
  ["preview video for the play store listing", "app-store-preview"],
  ["сделай афтермуви с фестиваля", "event-recap"],
  ["event recap video from our conference footage", "event-recap"],
  ["aftermovie from our conference videos and photos", "event-recap"],
  ["тизер нашего мероприятия", "teaser-trailer"],
  ["a teaser announcing our conference next month", "teaser-trailer"],
  ["coming soon teaser for our app", "teaser-trailer"],
  ["обратный отсчет до релиза", "teaser-trailer"],
  ["интригующий тизер перед запуском", "teaser-trailer"],
  ["save the date video for our conference", "teaser-trailer"],
  ["cut this creator video into a spark ad", "ugc-ad"],
  ["нативная реклама в тикток с блогером", "ugc-ad"],
  ["напиши ТЗ для блогера на рекламу", "ugc-ad"],
  ["ugc testimonial ad with a creator", "ugc-ad"],
  ["сделай UGC рекламу для нашего приложения", "ugc-ad"],
  ["сделай кейс клиента из интервью", "case-study"],
  ["testimonial interview with a client, cut it to 2 minutes", "case-study"],
  ["нарежь интервью на шортс", "shorts-from-long"],
  ["ai avatar video for sales outreach", "avatar-presenter"],
  ["сделай видео с ai ведущим", "avatar-presenter"],
  ["animate this infographic into a looping gif", "animated-infographic"],
  ["сделай зацикленную гифку из схемы", "animated-infographic"],
  ["animate my photo", "avatar-presenter"],
  ["infographic video", "explainer"],
  ["слайдшоу из фото", "photo-slideshow"],
  ["photo slideshow for mom's birthday", "photo-slideshow"],
  ["фото тур квартиры", "photo-slideshow", "real-estate-tour"],
  ["turn my instagram carousel into a reel", "photo-slideshow", "portfolio-reel"],
  ["слайдшоу из свадебных фото", "photo-slideshow"],
  ["dub my video into spanish", "localise"],
  ["переведи мой подкаст на немецкий", "localise"],
  ["Make a 20-second TikTok ad where a creator talks about our app", "ugc-ad"],
  ["Смонтируй aftermovie с нашего митапа, есть 30 клипов с телефона", "event-recap"],
  ["отчёт о продажах за квартал в виде видео с графиками", "explainer", "data-report"],
  ["Нарежь вебинар на короткие ролики для LinkedIn", "shorts-from-long", "webinar"],
] as [string, string, string?][]) {
  test(`match: "${request}" -> ${expected}${variant ? `/${variant}` : ""}`, () => {
    const result = matchPlaybooks(request);
    assert.equal(result.candidates[0]?.id, expected, JSON.stringify(words(result)));
    assert.equal(result.tie, false);
    if (variant) assert.equal(result.candidates[0]?.variant?.id, variant);
  });
}

test("match: a music video for the user's song asks: AI film or motion design", () => {
  for (const request of ["make a music video for my song", "сделай клип на мою песню"]) {
    const result = matchPlaybooks(request);
    assert.equal(result.tie, true, request);
    assert.deepEqual(
      result.candidates
        .slice(0, 2)
        .map((x) => x.id)
        .sort(),
      ["ai-film", "motion-design"],
      request,
    );
  }
});

test("match: a reference link with no kind of video is a modifier and a question, not a guess", () => {
  const result = matchPlaybooks("сделай ролик в стиле https://youtube.com/watch?v=x для нашего продукта");
  assert.deepEqual(result.modifiers, ["reference-style"]);
  assert.equal(result.candidates.length, 0);
});

test("match: real playbooks keep near words apart, and a link is a reference", () => {
  assert.ok(!matchPlaybooks("prompt engineering course").candidates.some((x) => x.id === "product-promo"));
  assert.ok(!matchPlaybooks("отчёт о промышленной безопасности").candidates.some((x) => x.id === "product-promo"));
  assert.deepEqual(matchPlaybooks("сделай ролик в стиле https://youtube.com/watch?v=x для нашего продукта").modifiers, [
    "reference-style",
  ]);
});

test("match: a request naming an existing project continues it", () => {
  const workspace = mkdtempSync(path.join(tmpdir(), "playbook-match-"));
  try {
    mkdirSync(path.join(workspace, "public/projects/fixture-talk-1"), { recursive: true });
    const result = matchPlaybooks("перерендери проект fixture-talk-1 в вертикальном формате", undefined, workspace);
    assert.equal(result.existingProject, "fixture-talk-1");
    const envelope = cli(workspace, "--match", "перерендери проект fixture-talk-1 в вертикальном формате");
    assert.equal(envelope.metadata.existingProject, "fixture-talk-1");
    assert.match(envelope.metadata.hint, /pnpm next --project fixture-talk-1/);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

for (const [request, expected] of CASES) {
  test(`match: "${request}" -> ${expected}`, () => {
    const result = matchPlaybooks(request);
    assert.equal(
      result.candidates[0]?.id,
      expected,
      JSON.stringify(result.candidates.map((x) => [x.id, x.score, x.matched])),
    );
  });
}

test("match: an unrelated request returns no candidate", () => {
  assert.deepEqual(matchPlaybooks("какая погода завтра").candidates, []);
  assert.deepEqual(matchPlaybooks("what is the weather tomorrow").candidates, []);
});

test("resolvePlaybook: footage guide, read list with the playbook first, QA kept", () => {
  const resolved = resolvePlaybook("footage-edit");
  assert.equal(resolved.route.kind, "footage");
  assert.equal(resolved.route.guide, "docs/footage-editing.md");
  assert.deepEqual(resolved.read, ["playbooks/footage-edit/AGENTS.md", ...resolved.playbook.read]);
  assert.deepEqual(resolved.qa, resolved.playbook.qa);
  assert.ok(resolved.start.startsWith("pnpm footage:next"));
});

test(
  "resolvePlaybook: a film route merges the film type tools and QA after the playbook lines",
  { skip: !listPlaybookIds().some((id) => loadPlaybook(id).route.kind === "film") && "no film playbook committed yet" },
  () => {
    const id = listPlaybookIds().find((entry) => loadPlaybook(entry).route.kind === "film")!;
    const resolved = resolvePlaybook(id);
    assert.equal(resolved.route.kind, "film");
    if (resolved.route.kind !== "film") return;
    assert.deepEqual(resolved.qa.slice(0, resolved.playbook.qa.length), [...new Set(resolved.playbook.qa)]);
    for (const line of resolved.route.qa) assert.ok(resolved.qa.includes(line), line);
    assert.equal(new Set(resolved.qa).size, resolved.qa.length);
    assert.ok(Object.keys(resolved.route.tools).length > 0);
  },
);

const KNOWN = knownNames();

test("validation: every playbook has Chinese triggers, and generic ones are among its triggers", () => {
  const base = fixture("fixture-pb", "ready", ["alpha task", "beta task", "gamma task"], ["альфа", "бета", "гамма"]);
  const known = knownNames(playbooksRoot());
  const problems = (triggers: Playbook["triggers"]) =>
    playbookProblems({ ...base, triggers }, playbooksRoot(), known).filter((problem) => problem.startsWith("triggers"));
  assert.deepEqual(problems({ ...base.triggers, zh: undefined }), ["triggers.zh: at least 3 Chinese triggers"]);
  assert.deepEqual(problems({ ...base.triggers, generic: ["бета", "广告"] }), [
    'triggers.generic: "广告" is not one of the playbook\'s triggers',
  ]);
});

test("validation: profiles, starter, variants and evidence resolve", () => {
  const base = fixture("fixture-pb", "ready", ["alpha task", "beta task", "gamma task"], ["альфа", "бета", "гамма"]);
  const good: Playbook = {
    ...base,
    reviewedAt: "2026-11-13",
    intake: [1, 2, 3].map((n) => ({ ask: `Fixture question ${n}?`, why: "fixture" })),
    profiles: [
      {
        platform: "tiktok",
        formats: ["vertical"],
        durationSec: { min: 15, max: 60 },
        captions: "outline-pop",
        note: "fixture profile",
      },
      {
        platform: "youtube",
        formats: ["landscape"],
        durationSec: { min: 60, max: 600 },
        captions: "none",
        note: "no burned captions",
      },
      {
        platform: "linkedin",
        formats: ["square"],
        durationSec: { min: 15, max: 90 },
        captions: "word-highlight",
        note: "a legacy alias",
      },
    ],
    starter: {
      blocks: ["caption-outline-pop"],
      style: "paper-signal",
      template: "caption.karaoke",
      note: "fixture starter",
    },
    variants: [
      {
        id: "fixture-variant",
        title: "Variant",
        triggers: { en: ["variant"], ru: ["вариант"] },
        changes: "what the variant changes",
      },
    ],
    evidence: [{ project: "some-ignored-project", acceptedAt: "2026-11-13" }],
  };
  assert.deepEqual(playbookProblems(good, REPO, KNOWN), []);
  assert.deepEqual(
    playbookProblems({ ...good, starter: { ...good.starter!, style: "minimal-product" } }, REPO, KNOWN),
    [],
    "a template style profile is a style too",
  );
  const bad: Playbook = {
    ...good,
    profiles: [{ ...good.profiles![0]!, captions: "comic-sans" }],
    starter: {
      blocks: ["no-such-block"],
      style: "no-such-style",
      template: "no.such-template",
      note: "fixture starter",
    },
    variants: [
      { id: "twice", title: "One", triggers: { en: ["Upper"], ru: ["ок"] }, changes: "what the variant changes" },
      { id: "twice", title: "Two", triggers: { en: ["ok"], ru: ["ок"] }, changes: "what the variant changes" },
      { id: "footage-edit", title: "Clash", triggers: { en: ["ok"], ru: ["ок"] }, changes: "what the variant changes" },
    ],
  };
  const problems = playbookProblems(bad, REPO, KNOWN).join("\n");
  for (const expected of [
    /profiles\[0\]\.captions: unknown caption profile comic-sans/,
    /starter: unknown library block no-such-block/,
    /starter: unknown style no-such-style/,
    /starter: unknown template no\.such-template/,
    /variant id twice is repeated/,
    /variant id footage-edit is a playbook id/,
    /variant twice: trigger "Upper" is not lower case/,
  ])
    assert.match(problems, expected);
});

test("validation: the readiness rule (behind ENFORCE_READY_FIELDS) and the review-age warning", () => {
  assert.equal(typeof ENFORCE_READY_FIELDS, "boolean");
  const bare = fixture("fixture-pb", "ready", ["alpha task", "beta task", "gamma task"], ["альфа", "бета", "гамма"]);
  assert.deepEqual(readinessProblems(bare), [
    "a ready playbook needs reviewedAt",
    "a ready playbook needs at least 3 intake questions (has 0)",
    "a ready playbook needs at least 1 platform profile",
  ]);
  assert.deepEqual(readinessProblems({ ...bare, status: "draft" }), [], "a draft may lack them");
  const question = { ask: "Which platform first?", why: "sets the format" };
  const filled: Playbook = {
    ...bare,
    reviewedAt: "2026-11-13",
    intake: [question, question, question],
    profiles: [
      { platform: "youtube", formats: ["landscape"], durationSec: { min: 30, max: 300 }, note: "fixture profile" },
    ],
  };
  assert.deepEqual(readinessProblems(filled), []);
  assert.deepEqual(readinessProblems({ ...filled, status: "proven", intake: [question] }), [
    "a proven playbook needs at least 3 intake questions (has 1)",
  ]);
  assert.equal(ENFORCE_READY_FIELDS, true);
  assert.ok(
    playbookProblems(bare, REPO, KNOWN).some((line) => line.includes("needs reviewedAt")),
    "enforced by --check",
  );
  const now = new Date("2026-11-13T12:00:00Z");
  assert.equal(reviewAgeWarning(filled, now), undefined);
  assert.equal(reviewAgeWarning({ ...filled, reviewedAt: "2026-05-17" }, now), undefined, "180 days is still fine");
  assert.match(reviewAgeWarning({ ...filled, reviewedAt: "2026-05-01" }, now)!, /reviewed 196 days ago/);
  assert.deepEqual(
    playbookWarnings([{ ...filled, reviewedAt: "2025-01-01" }, bare], now).map((line) => line.split(":")[0]),
    ["fixture-pb"],
  );
});

test("uses: a plain word counts only as pnpm <alias> or in backticks; categories through blocks; guides through read", () => {
  assert.equal(mentions("then render the film", "render"), false);
  assert.equal(mentions("run `pnpm render --project x`", "render"), true);
  assert.equal(mentions("the `data` blocks", "data"), true);
  assert.equal(mentions("pnpm film:render --project x", "render"), false);
  assert.equal(mentions("use captions:place first", "captions:place"), true);
  assert.equal(mentions("caption-outline-pop", "outline-pop"), false);
  const base = fixture("fixture-pb", "ready", ["alpha task", "beta task", "gamma task"], ["альфа", "бета", "гамма"]);
  const pb: Playbook = {
    ...base,
    commands: ["audio:map"],
    library: { categories: [], blocks: ["caption-outline-pop"] },
    read: ["docs/footage-editing.md"],
    starter: { blocks: [], style: "paper-signal", note: "fixture starter" },
    triggers: { en: ["audio:map", "beta task", "gamma task"], ru: ["альфа", "бета", "гамма"] },
  };
  const context = { ...useContext(), text: () => "Line one\nRun `pnpm audio:map --input x`.\nThe outline-pop look." };
  assert.deepEqual(
    playbookUses("audio:map", [pb], context)[0]!.where,
    ["commands[0]", "AGENTS.md:2"],
    "triggers are not uses",
  );
  assert.deepEqual(playbookUses("captions", [pb], context)[0]!.where, ["library.blocks[0] (caption-outline-pop)"]);
  assert.deepEqual(
    playbookUses("footage:next", [pb], context)[0]!.where.filter((where) => where.startsWith("read")),
    ["read[0] (its guide)"],
  );
  assert.deepEqual(playbookUses("paper-signal", [pb], context)[0]!.where, ["starter.style"]);
  assert.deepEqual(playbookUses("outline-pop", [pb], context)[0]!.where, ["AGENTS.md:3"]);
  assert.deepEqual(playbookUses("nothing-here", [pb], context), []);
});

test("unbound projects: playbookSuggest names the owners of the film type, footage goals or recipe", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "playbook-suggest-"));
  const project = path.join(dir, "unbound-x");
  try {
    mkdirSync(path.join(project, "pipeline"), { recursive: true });
    assert.equal(playbookSuggest(project), undefined, "nothing on disk names its kind");
    assert.equal(withPlaybook(project).playbookSuggest, undefined);
    writeFileSync(
      path.join(project, "pipeline/brief.json"),
      JSON.stringify({ renderMode: "bespoke", filmType: "explainer" }),
    );
    assert.deepEqual(playbookSuggest(project), {
      by: "film type explainer (pipeline/brief.json)",
      playbooks: [{ id: "explainer", title: loadPlaybook("explainer").title }],
      use: "pnpm playbook --use explainer --project unbound-x",
    });
    writeFileSync(
      path.join(project, "pipeline/brief.json"),
      JSON.stringify({ renderMode: "bespoke", filmType: "motion-graphics" }),
    );
    const answer = withPlaybook(project, ["docs/production-chain.md"]);
    assert.equal(
      answer.playbookHint,
      'bind one: pnpm playbook --match "<request>" then pnpm playbook --use <id> --project unbound-x',
      "the hint itself is unchanged",
    );
    assert.deepEqual(
      answer.playbookSuggest!.playbooks.slice(0, 2).map((entry) => entry.id),
      ["product-promo", "motion-design"],
    );
    assert.equal(answer.playbookSuggest!.playbooks[0]!.when, "selling a product");
    assert.equal(answer.playbookSuggest!.use, "pnpm playbook --use <id> --project unbound-x");
    writeFileSync(
      path.join(project, "pipeline/brief.json"),
      JSON.stringify({ renderMode: "bespoke", filmType: "talking-head" }),
    );
    assert.ok(
      !playbookSuggest(project)?.playbooks.some((entry) => entry.id === "footage-edit"),
      "an owner with no film route is not suggested to a film project: --use would refuse it",
    );
    rmSync(path.join(project, "pipeline/brief.json"));
    writeFileSync(
      path.join(project, "pipeline/footage-goals.json"),
      JSON.stringify({ version: 1, goals: ["recut", "shorts"] }),
    );
    assert.deepEqual(
      playbookSuggest(project)!.playbooks.map((entry) => entry.id),
      ["shorts-from-long"],
    );
    writeFileSync(
      path.join(project, "pipeline/footage-goals.json"),
      JSON.stringify({ version: 1, goals: ["recut", "captions"] }),
    );
    assert.equal(playbookSuggest(project)!.use, "pnpm playbook --use footage-edit --project unbound-x");
    rmSync(path.join(project, "pipeline/footage-goals.json"));
    writeFileSync(
      path.join(project, "pipeline/recipe.json"),
      JSON.stringify({ schemaVersion: 1, request: { recipeId: "product-demo" } }),
    );
    assert.deepEqual(
      playbookSuggest(project)!.playbooks.map((entry) => entry.id),
      ["product-tutorial"],
    );
    writeProjectPlaybook(project, "product-tutorial", "agent");
    assert.equal(withPlaybook(project).playbookSuggest, undefined, "a bound project gets no suggestion");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("binding: same playbook keeps the first choice, never downgrades the user, refuses a rebind without force", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "playbook-bind-"));
  try {
    assert.deepEqual(playbookRead(dir), { read: [] });
    const first = writeProjectPlaybook(dir, "footage-edit", "user");
    assert.equal(first.by, "user");
    assert.deepEqual(playbookRead(dir).read[0], "playbooks/footage-edit/AGENTS.md");
    const again = writeProjectPlaybook(dir, "footage-edit", "agent");
    assert.deepEqual(again, first, 'same id: chosenAt and by "user" kept');
    assert.throws(
      () => writeProjectPlaybook(dir, "explainer", "agent"),
      (error: Error & { code?: string }) =>
        error.code === "FILE_EXISTS" &&
        /already bound to playbook footage-edit/.test(error.message) &&
        /--force/.test(error.message),
    );
    assert.equal(bindingConflict(dir, "explainer")?.includes("footage-edit"), true);
    assert.equal(bindingConflict(dir, "footage-edit"), undefined);
    assert.equal(writeProjectPlaybook(dir, "explainer", "agent", undefined, { force: true }).id, "explainer");
    assert.throws(() => writeProjectPlaybook(dir, "no-such-playbook", "agent"), /Unknown playbook/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("binding: a corrupt or unknown binding warns instead of looking unbound", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "playbook-bad-"));
  try {
    mkdirSync(path.join(dir, "pipeline"));
    writeFileSync(path.join(dir, "pipeline/playbook.json"), "{ nope");
    assert.match(playbookRead(dir).warning!, /pipeline\/playbook\.json is invalid: not JSON/);
    assert.match(withPlaybook(dir).playbookWarning!, /is invalid/);
    assert.equal(withPlaybook(dir).playbookHint, undefined, 'no "bind one" hint over a broken binding');
    assert.throws(() => writeProjectPlaybook(dir, "footage-edit", "agent"), /is invalid/);
    writeFileSync(
      path.join(dir, "pipeline/playbook.json"),
      JSON.stringify({ version: 1, id: "gone-playbook", chosenAt: new Date().toISOString(), by: "agent" }),
    );
    assert.match(playbookRead(dir).warning!, /unknown playbook "gone-playbook"/);
    assert.equal(withPlaybook(dir).playbook, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("one playbook root: the checkout, whatever the working directory or the project's parent", () => {
  const workspace = mkdtempSync(path.join(tmpdir(), "playbook-root-"));
  try {
    assert.equal(playbooksRoot(), process.cwd());
    assert.equal(rootOfProject(path.join(workspace, "public/projects/x")), process.cwd());
    mkdirSync(path.join(workspace, "public/projects/fresh"), { recursive: true });
    mkdirSync(path.join(workspace, "public/projects/talk/pipeline"), { recursive: true });
    writeFileSync(
      path.join(workspace, "public/projects/talk/pipeline/footage-goals.json"),
      JSON.stringify({ version: 1, goals: ["recut"] }),
    );
    const list = cli(workspace, "--list");
    assert.ok(
      list.metadata.playbooks.some((entry: { id: string }) => entry.id === "footage-edit"),
      "listed from the checkout, not the workspace",
    );
    const used = cli(workspace, "--use", "product-promo", "--project", "fresh");
    assert.equal(used.ok, true, JSON.stringify(used));
    assert.equal(
      JSON.parse(readFileSync(path.join(workspace, "public/projects/fresh/pipeline/playbook.json"), "utf8")).id,
      "product-promo",
    );
    assert.equal(
      withPlaybook(path.join(workspace, "public/projects/fresh")).read[0],
      "playbooks/product-promo/AGENTS.md",
    );
    const rebind = cli(workspace, "--use", "explainer", "--project", "fresh");
    assert.equal(rebind.error, "FILE_EXISTS");
    assert.equal(
      cli(workspace, "--use", "explainer", "--project", "fresh", "--force").metadata.binding.id,
      "explainer",
    );
    const mismatch = cli(workspace, "--use", "product-promo", "--project", "talk");
    assert.equal(mismatch.error, "INVALID_INPUT", "a footage project refuses a playbook with no footage route");
    assert.match(mismatch.message, /footage route/);
    assert.equal(cli(workspace, "--use", "footage-edit", "--project", "talk").ok, true);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("lessons: a Playbook field tags an entry; the format example is not a lesson", () => {
  const lessons = parseLessons(
    [
      "# Creative lessons",
      "```markdown",
      "### Example",
      "- **Playbook:** footage-edit",
      "```",
      "## Lessons",
      "",
      "### Keep breaths",
      "- **Lesson:** keep them.",
      "- **Playbook:** footage-edit, shorts-from-long",
      "- **Date:** 2026-11-13.",
      "",
      "### Untagged",
      "- **Date:** 2026-11-12.",
    ].join("\n"),
  );
  assert.deepEqual(lessons, [
    { title: "Keep breaths", playbooks: ["footage-edit", "shorts-from-long"], date: "2026-11-13" },
    { title: "Untagged", playbooks: [], date: "2026-11-12" },
  ]);
});

test("lessons: lessonsFor joins tagged harness lessons and the active memory lessons scoped to the playbook", () => {
  const root = mkdtempSync(path.join(tmpdir(), "avc-lessons-"));
  const memory = path.join(root, "memory");
  const previous = process.env.AGENTBROS_MEMORY_ROOT;
  process.env.AGENTBROS_MEMORY_ROOT = memory;
  try {
    mkdirSync(path.join(root, "design-reference"));
    writeFileSync(
      path.join(root, "design-reference/creative-lessons.md"),
      [
        "## Lessons",
        "",
        "### Keep breaths",
        "- **Playbook:** footage-edit",
        "- **Date:** 2026-11-13.",
        "",
        "### Other",
        "- **Playbook:** explainer",
      ].join("\n"),
    );
    assert.deepEqual(lessonsFor("footage-edit", root), [
      { source: "harness", title: "Keep breaths", date: "2026-11-13" },
    ]);
    const user = { kind: "user" as const, quote: "cut the dead air" };
    const kept = addMemory({
      type: "lesson",
      summary: "Cut dead air before the first word",
      scope: { playbooks: ["footage-edit"] },
      source: user,
      createdAt: "2026-11-10",
    });
    addMemory({
      type: "lesson",
      summary: "Any kind of video keeps the logo small",
      scope: {},
      source: user,
      createdAt: "2026-11-11",
    });
    const retired = addMemory({
      type: "lesson",
      summary: "Captions always sit at the very top",
      scope: { playbooks: ["footage-edit"] },
      source: user,
      createdAt: "2026-11-12",
    });
    setStatus(retired.id, "retired");
    addMemory({
      type: "observation",
      summary: "The critic saw long pauses in round two",
      scope: { playbooks: ["footage-edit"] },
      source: { kind: "agent", agent: "creative-critic", evidence: "critique.md" },
    });
    assert.deepEqual(lessonsFor("footage-edit", root), [
      { source: "harness", title: "Keep breaths", date: "2026-11-13" },
      { source: "memory", id: kept.id, title: "Cut dead air before the first word", date: "2026-11-10" },
    ]);
    assert.deepEqual(
      lessonsFor("explainer", root).map((lesson) => lesson.source),
      ["harness"],
    );
    process.env.AGENTBROS_MEMORY_ROOT = path.join(root, "none");
    assert.equal(lessonsFor("footage-edit", root).length, 1, "no memory folder: harness lessons only");
  } finally {
    if (previous === undefined) delete process.env.AGENTBROS_MEMORY_ROOT;
    else process.env.AGENTBROS_MEMORY_ROOT = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

function cli(cwd: string, ...args: string[]) {
  try {
    return JSON.parse(
      execFileSync(
        process.execPath,
        [
          "--import",
          path.join(REPO, "node_modules/tsx/dist/loader.mjs"),
          path.join(REPO, "scripts/playbook.ts"),
          ...args,
        ],
        {
          cwd,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
          env: { ...process.env, AGENTBROS_PLAYBOOKS_ROOT: "" },
        },
      ).trim(),
    );
  } catch (error) {
    return JSON.parse(String((error as { stdout: string }).stdout).trim());
  }
}

test("pnpm playbook: one JSON line for list, id, match and use", () => {
  const list = cli(REPO, "--list");
  assert.equal(list.ok, true);
  assert.ok(list.metadata.playbooks.some((entry: { id: string }) => entry.id === "footage-edit"));
  const shown = cli(REPO, "--id", "footage-edit");
  assert.equal(shown.metadata.read[0], "playbooks/footage-edit/AGENTS.md");
  assert.ok(Array.isArray(shown.metadata.lessons));
  const none = cli(REPO, "--match", "какая погода завтра");
  assert.deepEqual(none.metadata.candidates, []);
  assert.equal(none.metadata.index, INDEX_DOC);
  assert.match(none.metadata.hint, /playbooks\/AGENTS\.md/);
  assert.equal(cli(REPO, "--id", "nope").error, "INVALID_INPUT");
  assert.equal(cli(REPO, "--use", "footage-edit", "--project", "no-such-project-xyz").error, "PROJECT_NOT_FOUND");
  assert.equal(cli(REPO).error, "INVALID_INPUT");
  assert.equal(cli(REPO, "--match", "").error, "INVALID_INPUT");
  assert.equal(cli(REPO, "--match", "   ").error, "INVALID_INPUT");
  for (const field of ["intake", "profiles", "variants"]) assert.ok(Array.isArray(shown.metadata[field]), field);
  assert.ok("starter" in shown.metadata && "reviewedAt" in shown.metadata);
  const uses = cli(REPO, "--uses", "footage:next");
  assert.deepEqual(uses.metadata.kinds, ["command"]);
  assert.ok(
    uses.metadata.playbooks.some(
      (entry: { id: string; where: string[] }) => entry.id === "footage-edit" && entry.where.length > 0,
    ),
  );
  assert.equal(cli(REPO, "--uses", "render").metadata.general, "renders any project or timeline");
  assert.match(cli(REPO, "--uses", "no-such-name-xyz").metadata.warning, /not a known/);
  assert.equal(cli(REPO, "--uses", " ").error, "INVALID_INPUT");
  assert.ok(Array.isArray(cli(REPO, "--check").metadata?.warnings ?? []));
});
