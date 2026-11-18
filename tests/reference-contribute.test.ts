import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { addReference } from "../src/lib/reference/add";
import {
  checkContribution,
  creditRows,
  idPattern,
  provenanceIssues,
  referencesNamed,
} from "../src/lib/reference/contribute";
import { buildCorpus } from "../src/lib/reference/corpus";
import { validateReference, writeLayer } from "../src/lib/reference/library";
import { privateReferenceIds } from "../src/lib/reference/private";
import { redactReference } from "../src/lib/reference/redact";
import {
  hasVerbatim,
  readFullSpeechText,
  readTrackedSpeechText,
  redactSpeechText,
  SPEECH_TEXT_FULL,
  textCase,
} from "../src/lib/reference/speech-text";
import {
  copiedRun,
  filmRuns,
  longQuotes,
  MAX_QUOTE_WORDS,
  proseOf,
  referenceVerbatim,
  verbatimInText,
} from "../src/lib/reference/verbatim";
import { ReferenceSourceSchema, ReferenceSpeechTextSchema, type ReferenceSpeechText } from "../src/types/reference";

const repo = path.resolve(import.meta.dirname, "..");
const fixtures = path.join(repo, "tests/fixtures/reference-corpus");

function workspace(t: test.TestContext) {
  const root = mkdtempSync(path.join(tmpdir(), "reference-contribute-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

const write = (file: string, value: unknown) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`);
};

const film: ReferenceSpeechText = ReferenceSpeechTextSchema.parse({
  schemaVersion: 1,
  referenceId: "film",
  speech: {
    available: true,
    language: "en",
    words: ["Every", "launch", "deserves", "a", "proper", "film", "today."].map((text, index) => ({
      text,
      startSec: index * 0.4,
      endSec: index * 0.4 + 0.3,
    })),
  },
  screenText: {
    available: true,
    items: [
      { text: "SHIP IT", startSec: 0, endSec: 0.5, confidence: 0.9, box: { x: 0.4, y: 0.4, width: 0.2, height: 0.1 } },
      {
        text: "ship  it.",
        startSec: 0.5,
        endSec: 1,
        confidence: 0.9,
        box: { x: 0.4, y: 0.4, width: 0.2, height: 0.1 },
      },
      { text: "Made for Teams", startSec: 2, endSec: 2.5, confidence: 0.8 },
    ],
  },
});

test("redaction keeps structure only: counts, case and one opaque id per distinct text, never a word", () => {
  const redacted = redactSpeechText(film);
  assert.equal(redacted.content, "structure");
  assert.equal(hasVerbatim(redacted), false);
  assert.doesNotMatch(JSON.stringify(redacted), /SHIP|launch|Teams/i);
  assert.deepEqual(
    redacted.speech.words.map((word) => word.chars),
    [5, 6, 8, 1, 6, 4, 5],
  );
  assert.deepEqual(
    redacted.screenText.items.map((item) => [item.textId, item.chars, item.words, item.case]),
    [
      [0, 6, 2, "upper"],
      [0, 6, 2, "lower"],
      [1, 12, 3, "title"],
    ],
  );
  assert.deepEqual(redacted.screenText.items[0]!.box, film.screenText.items[0]!.box);
  assert.equal(textCase("Made for teams"), "sentence");
  assert.equal(textCase("iPhone sale"), "mixed");
  assert.equal(textCase("2026"), "none");
});

test("writeLayer splits speech-text: words to the git-ignored media/ file, structure to the tracked layer", (t) => {
  const directory = path.join(workspace(t), "film");
  writeLayer(directory, "speech-text.json", film);
  assert.equal(hasVerbatim(readTrackedSpeechText(directory)), false);
  assert.deepEqual(
    readFullSpeechText(directory)?.screenText.items.map((item) => item.text),
    ["SHIP IT", "ship  it.", "Made for Teams"],
  );
  assert.equal(JSON.parse(readFileSync(path.join(directory, SPEECH_TEXT_FULL), "utf8")).content, "full");
  rmSync(path.join(directory, SPEECH_TEXT_FULL));
  assert.equal(readFullSpeechText(directory), undefined, "a clone without the film has no words");
});

test("the corpus reads the same numbers from the full and the structure-only layer", (t) => {
  const library = path.join(workspace(t), "library");
  cpSync(fixtures, library, { recursive: true });
  const before = buildCorpus({ libraryRoot: library });
  for (const id of ["alpha", "beta", "gamma"])
    assert.equal(
      redactReference(path.join(library, id), id).action,
      existsSync(path.join(library, id, "speech-text.json")) ? "redacted" : "missing",
    );
  const after = buildCorpus({ libraryRoot: library });
  assert.deepEqual(after.metrics, before.metrics);
  assert.deepEqual(
    after.references.map((row) => row.metrics),
    before.references.map((row) => row.metrics),
  );
  assert.ok(before.metrics.screenTextDwellSec, "the fixture exercises screen text");
  assert.equal(redactReference(path.join(library, "alpha"), "alpha").action, "kept", "idempotent");
});

test("ref:validate skips the blueprint leak check without local words and warns on verbatim text", (t) => {
  const library = path.join(workspace(t), "library");
  cpSync(path.join(fixtures, "alpha"), path.join(library, "alpha"), { recursive: true });
  const directory = path.join(library, "alpha");
  write(path.join(directory, "story.json"), { note: "The hook reads 'every launch deserves a proper film' in white." });
  const unredacted = validateReference(directory);
  assert.ok(unredacted.warnings.some((warning) => /speech-text\.json holds the film's words/.test(warning)));
  assert.ok(unredacted.warnings.some((warning) => /story\.json quotes the film beyond 4 words/.test(warning)));
  redactReference(directory, "alpha");
  rmSync(path.join(directory, SPEECH_TEXT_FULL));
  const blueprint = {
    schemaVersion: 1,
    referenceId: "alpha",
    format: { width: 1920, height: 1080, fps: 30 },
    durationSec: 30,
    slots: [
      {
        id: "s1",
        role: "hook",
        startSec: 0,
        durationSec: 30,
        visualRecipe: "x",
        motionRecipe: "x",
        soundRecipe: "x",
        techniqueIds: [],
      },
    ],
    rhythm: { cutGrid: "every beat" },
    style: "flat",
    transferRules: { keep: ["x"], mustChange: ["brand"] },
  };
  write(path.join(directory, "blueprint.json"), blueprint);
  rmSync(path.join(directory, "story.json"));
  const report = validateReference(directory);
  assert.equal(report.filmTextLocal, false);
  assert.deepEqual(report.invalid, []);
  assert.ok(report.warnings.some((warning) => /blueprint leak check skipped/.test(warning)));
});

test("quotations over the limit and unquoted runs of the film's words are found; front matter is not a quotation", () => {
  assert.equal(MAX_QUOTE_WORDS, 4);
  assert.deepEqual(
    longQuotes(`It reads "Ship it" then 'it's still air, they said' and «одно два три четыре пять».`).map(
      (row) => row.words,
    ),
    [5, 5],
  );
  assert.deepEqual(longQuotes(`cubic-bezier "0.2, 0, 0, 1" and "12.4 s to 13.2 s"`), []);
  const runs = filmRuns(film);
  assert.equal(copiedRun("the line every launch deserves a proper film lands", runs)?.words, 6);
  assert.equal(copiedRun("every launch deserves a", runs), undefined, "four words are allowed");
  assert.equal(
    copiedRun("SHIP IT 0.5 s, then made for teams", filmRuns({ ...film, speech: { ...film.speech, words: [] } })),
    undefined,
    "two screen texts of five words together",
  );
  const card = `---\nid: x\ntiming: "a long front-matter value of many words here"\nsources: ["a/b.json", "c/d.md"]\n---\n\nBody "with a long quoted line of words".`;
  assert.deepEqual(
    verbatimInText("card.md", card).map((row) => row.where),
    ["line 7"],
  );
  assert.deepEqual(proseOf("card.md", card)[3]!.text, "a/b.json; c/d.md");
});

function gitRepo(root: string) {
  const run = (args: string[]) =>
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], {
      cwd: root,
      stdio: "pipe",
    });
  run(["init", "-q", "-b", "main"]);
  write(path.join(root, ".gitignore"), readFileSync(path.join(repo, ".gitignore"), "utf8"));
  return run;
}

const source = (id: string, extra: Record<string, unknown> = {}) =>
  ReferenceSourceSchema.parse({
    schemaVersion: 1,
    referenceId: id,
    origin: { kind: "file", originalFilename: `${id}.mp4`, acquiredAt: "2026-11-15T00:00:00.000Z" },
    sha256: "ab".repeat(32),
    mediaPath: "media/source.mp4",
    probe: { durationSec: 3, width: 1920, height: 1080, fps: 30, hasAudio: false },
    rights: { status: "study-only" },
    ...extra,
  });

const credits = (rows: string[]) =>
  `# Credits\n\n## 2. Reference films\n\n| Brand / title | Source URL | Rights | Where it lives | Analysed for |\n|---|---|---|---|---|\n${rows.join("\n")}\n\n## 3. Asset sources\n`;

test("ref:contribute refuses media, verbatim text, private references and ids, missing credits and uncredited inspiredBy", (t) => {
  const root = workspace(t);
  const run = gitRepo(root);
  const library = path.join(root, "design-reference/library");
  write(path.join(library, "alpha/source.json"), source("alpha"));
  writeLayer(path.join(library, "alpha"), "speech-text.json", { ...film, referenceId: "alpha" });
  write(path.join(library, "alpha/story.json"), { hook: "Opens on 'every launch deserves a proper film'." });
  write(path.join(library, "alpha/frame.jpg"), "jpeg");
  write(path.join(library, "zeta-client/source.json"), source("zeta-client"));
  write(path.join(root, "docs/notes.md"), "Learned from Zeta Client's film.\n");
  write(path.join(root, "docs/library/catalogue.json"), {
    items: [{ id: "block-a", inspiredBy: ["alpha 0.5-1.0 s: a hero word", "design-reference/library/omega: a wipe"] }],
  });
  write(path.join(root, "CREDITS.md"), credits([]));

  // Untracked so far: the jpg is ignored by the allow-list, the analyses are not.
  assert.equal(addReference({ id: "zeta-client", libraryRoot: library, private: true }).source.private, true);
  assert.match(
    readFileSync(path.join(root, ".git/info/exclude"), "utf8"),
    /^\/design-reference\/library\/zeta-client\/$/m,
  );
  assert.deepEqual(privateReferenceIds(library), ["zeta-client"]);
  run(["add", "-A"]);
  run([
    "add",
    "-f",
    "design-reference/library/alpha/frame.jpg",
    "design-reference/library/alpha/media/speech-text.full.json",
  ]);
  const staged = execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8" });
  assert.doesNotMatch(staged, /zeta-client\//, "the exclude keeps the private reference out of git add -A");

  const failing = checkContribution({ repoRoot: root, libraryRoot: "design-reference/library", all: true });
  assert.equal(failing.passed, false);
  assert.deepEqual(failing.localOnly, ["zeta-client"]);
  const alpha = failing.checked.find((row) => row.id === "alpha")!;
  const checks = (rows: { check: string }[]) => [...new Set(rows.map((row) => row.check))].sort();
  assert.deepEqual(checks(alpha.issues), ["media", "provenance", "verbatim"]);
  assert.equal(
    alpha.issues.filter((row) => row.check === "media").length,
    2,
    "the forced jpg and the forced full text",
  );
  assert.deepEqual(checks(failing.repository), ["inspired-by", "private-id"]);
  assert.ok(
    failing.repository.some((row) => row.check === "private-id" && row.file === "docs/notes.md"),
    "Zeta Client matches zeta-client",
  );
  assert.ok(failing.repository.some((row) => row.check === "inspired-by" && /omega/.test(row.message)));
  assert.ok(
    checkContribution({
      repoRoot: root,
      libraryRoot: "design-reference/library",
      ids: ["zeta-client"],
    }).checked[0]!.issues.some((row) => row.check === "private"),
  );

  // Fixed: media unstaged, copy described, credits written, the private id gone from tracked text.
  run([
    "rm",
    "-q",
    "--cached",
    "design-reference/library/alpha/frame.jpg",
    "design-reference/library/alpha/media/speech-text.full.json",
  ]);
  write(path.join(library, "alpha/story.json"), { hook: "Opens on a six-word sentence-case claim about launches." });
  write(path.join(root, "docs/notes.md"), "Learned from a private reference.\n");
  write(path.join(root, "docs/library/catalogue.json"), {
    items: [{ id: "block-a", inspiredBy: ["alpha 0.5-1.0 s: a hero word"] }],
  });
  write(
    path.join(root, "CREDITS.md"),
    credits([
      "| alpha | unrecorded (`alpha.mp4`, sha256 `abababab…`) | study-only | `design-reference/library/alpha/` | Hero word |",
    ]),
  );
  run(["add", "-A"]);
  const passing = checkContribution({ repoRoot: root, libraryRoot: "design-reference/library", all: true });
  assert.deepEqual(
    { repository: passing.repository, alpha: passing.checked[0]!.issues },
    { repository: [], alpha: [] },
  );
  assert.equal(passing.passed, true);

  run(["commit", "-q", "-m", "analyses"]);
  run(["checkout", "-q", "-b", "topic"]);
  run(["commit", "-q", "--allow-empty", "-m", "notes from zeta_client"]);
  assert.ok(
    checkContribution({
      repoRoot: root,
      libraryRoot: "design-reference/library",
      all: true,
      base: "main",
    }).repository.some((row) => /commit message/.test(row.message)),
  );
});

test("credit rows, provenance and inspiredBy matching", () => {
  const rows = creditRows(credits(["| alpha | unrecorded (`alpha.mp4`, sha256 `abab1234…`) | unknown | here | x |"]));
  assert.deepEqual(
    rows.map((row) => row.name),
    ["alpha"],
  );
  const issues = provenanceIssues("alpha", source("alpha"), rows);
  assert.equal(issues.length, 2, issues.join("\n"));
  assert.deepEqual(provenanceIssues("beta", source("beta"), rows).length, 1);
  assert.deepEqual(
    referencesNamed("context-dev and firecrawl launch films: crops", ["firecrawl", "context-dev", "flex"]),
    ["context-dev", "firecrawl"],
  );
  assert.deepEqual(referencesNamed("a flexbox layout, not flex-grow", ["flex"]), []);
  assert.match("Notes on acme Studio", new RegExp(idPattern("acme-studio"), "i"));
});

// The repository's own tree: no frame of a film, no film's words in speech-text.json, no long quotation of a film.
const tracked = (args: string[]) =>
  execFileSync("git", ["ls-files", ...args], { cwd: repo, encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
const inRepo = existsSync(path.join(repo, ".git"));

test(
  "the tracked reference library holds only our analyses: JSON and Markdown, structure-only speech text, short quotations",
  { skip: !inRepo },
  () => {
    const files = tracked(["design-reference/library"]);
    assert.ok(files.length > 50);
    assert.deepEqual(
      files.filter((file) => !/\.(json|md)$/.test(file)),
      [],
      "images, video and audio of films stay local (.gitignore allow-list)",
    );
    assert.deepEqual(
      files.filter((file) => /\/(media|visuals|compare)\//.test(file)),
      [],
    );
    const findings = [...new Set(files.map((file) => file.split("/").slice(0, 3).join("/")))]
      .filter((directory) => existsSync(path.join(repo, directory, "source.json")))
      .flatMap((directory) =>
        referenceVerbatim(path.join(repo, directory))
          .filter((row) => files.includes(`${directory}/${row.file}`))
          .map((row) => `${directory}/${row.file} ${row.where} ${row.kind} ${row.words}`),
      );
    assert.deepEqual(findings, []);
    const others = [
      ...tracked(["design-reference/techniques"]),
      "design-reference/reference-gap-matrix.md",
      "design-reference/gap-triage.md",
    ].filter((file) => file.endsWith(".md") && existsSync(path.join(repo, file)));
    assert.deepEqual(
      others.flatMap((file) =>
        verbatimInText(file, readFileSync(path.join(repo, file), "utf8")).map(
          (row) => `${file} ${row.where} ${row.words}`,
        ),
      ),
      [],
    );
    const catalogue = JSON.parse(readFileSync(path.join(repo, "docs/library/catalogue.json"), "utf8")) as {
      items: { id: string; inspiredBy?: string[] }[];
    };
    assert.deepEqual(
      catalogue.items.flatMap((item) =>
        (item.inspiredBy ?? []).flatMap((entry) => longQuotes(entry).map((row) => `${item.id}: ${row.words} words`)),
      ),
      [],
    );
  },
);
