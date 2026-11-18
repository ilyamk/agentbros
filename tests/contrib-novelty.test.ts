import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  checkNovelty,
  differenceHash,
  hammingDistance,
  previewHash,
  textSimilarities,
} from "../src/lib/contrib/novelty";
import type { Playbook } from "../src/types/playbook";
import { changeText, temporaryRepository } from "./contrib-tools-helpers";

const config = readFileSync("contrib/novelty.json", "utf8");
const block = (id: string, title: string, description: string) => ({
  id,
  title,
  description,
  preview: { image: `docs/library/previews/${id}.png` },
});
const original = block("fold", "Paper fold", "Paper fold opens an origami card with creased layers");
const duplicate = block("fold-copy", original.title, original.description);
const distinct = block("wave", "Ocean currents", "Simulate fluid ocean currents beneath iridescent jellyfish");
const book = (id: string, summary: string, en = ["paper fold", "origami card", "creased layers"]): Playbook => ({
  version: 1,
  id,
  title: `Playbook ${id}`,
  summary,
  status: "draft",
  triggers: { en, ru: ["бумага", "оригами", "слой"] },
  notFor: [],
  route: { kind: "film", filmType: "motion-graphics", start: "pnpm film:init" },
  alternatives: [],
  agents: [],
  skills: [],
  library: { categories: [], blocks: [] },
  commands: [],
  read: [],
  qa: ["Check concrete geometry", "Check frame boundaries"],
  benchmarks: [],
});

function fixture() {
  const repo = temporaryRepository();
  repo.git("rm", ".changes/repair.md");
  repo.write("contrib/novelty.json", config);
  repo.write("docs/library/catalogue.json", JSON.stringify({ version: 1, items: [original], styles: [] }));
  repo.git("add", ".");
  repo.git("commit", "-m", "novelty base");
  const base = repo.git("rev-parse", "HEAD");
  return { ...repo, base };
}
const commit = (repo: ReturnType<typeof fixture>) => {
  repo.git("add", ".");
  repo.git("commit", "-m", "novelty head");
};
function entry(repo: ReturnType<typeof fixture>, category = "library", justification?: string) {
  repo.write(
    ".changes/repair.md",
    changeText(category).replace(
      "harness: codex",
      `harness: codex${justification ? `\nnovelty: ${justification}` : ""}`,
    ),
  );
}

test("TF-IDF handles stop words, empty text, identical and distinct documents", () => {
  const [same, other] = textSimilarities("THE paper fold", ["paper fold", "ocean current"]);
  assert.ok(same! > 0.999);
  assert.equal(other, 0);
  assert.deepEqual(textSimilarities("the and of", ["the", "paper"]), [0, 0]);
});

for (const [subject, blocking] of [
  [duplicate, true],
  [distinct, false],
] as const)
  test(`block ${subject.id}: ${blocking ? "duplicate blocks" : "distinct passes"}`, () => {
    const repo = fixture();
    try {
      repo.write("docs/library/catalogue.json", JSON.stringify({ version: 1, items: [original, subject], styles: [] }));
      entry(repo);
      commit(repo);
      const report = checkNovelty({ root: repo.root, base: repo.base });
      assert.equal(report.blocking.length, blocking ? 1 : 0);
      assert.equal(report.items.length, 1);
      assert.equal(report.items[0]!.nearest[0]!.id, "fold");
      assert.equal(report.items[0]!.skipped[0]!.reason, "Preview is missing; image comparison skipped.");
      const result = repo.cli("contrib-novelty", "--base", repo.base);
      assert.equal(result.status, blocking ? 1 : 0, result.stdout + result.stderr);
      assert.equal(result.stdout.trim().split("\n").length, 1);
      assert.equal(JSON.parse(result.stdout).metadata.report.blocking.length, blocking ? 1 : 0);
    } finally {
      repo.dispose();
    }
  });

test("justification must name each overlapping existing id and explain the new behaviour", () => {
  const repo = fixture();
  try {
    repo.write("docs/library/catalogue.json", JSON.stringify({ version: 1, items: [original, duplicate], styles: [] }));
    for (const [justification, accepted] of [
      ["fold adds controllable creases and perspective", true],
      ["fold", false],
      ["fold-other adds controllable creases", false],
      ["New controllable creases and perspective", false],
    ] as const) {
      entry(repo, "library", justification);
      commit(repo);
      const report = checkNovelty({ root: repo.root, base: repo.base });
      assert.equal(report.items[0]!.justified, accepted);
      assert.equal(report.blocking.length, accepted ? 0 : 1);
      assert.ok(report.items[0]!.nearest[0]!.score > 0.99, "neighbours remain visible when justified");
    }
  } finally {
    repo.dispose();
  }
});

test("material catalogue changes are compared by id while unchanged items/sourceHash are ignored", () => {
  const repo = fixture();
  try {
    repo.write(
      "docs/library/catalogue.json",
      JSON.stringify({ version: 1, sourceHash: "new hash", items: [original], styles: [] }),
    );
    entry(repo);
    commit(repo);
    assert.deepEqual(checkNovelty({ root: repo.root, base: repo.base }).items, []);
    repo.write(
      "docs/library/catalogue.json",
      JSON.stringify({
        version: 1,
        items: [{ ...original, description: "Updated crease geometry with adjustable angles" }],
        styles: [],
      }),
    );
    commit(repo);
    const report = checkNovelty({ root: repo.root, base: repo.base });
    assert.equal(report.items.length, 1);
    assert.deepEqual(report.items[0]!.nearest, []);
    assert.deepEqual(report.blocking, [], "an existing block does not overlap its own base version");
  } finally {
    repo.dispose();
  }
});

test("batch additions are compared, and text neighbours retain the top three", () => {
  const repo = fixture();
  try {
    repo.write(
      "docs/library/catalogue.json",
      JSON.stringify({
        version: 1,
        items: [original, ...["a", "b", "c", "d"].map((id) => ({ ...duplicate, id }))],
        styles: [],
      }),
    );
    entry(repo);
    commit(repo);
    const report = checkNovelty({ root: repo.root, base: repo.base });
    assert.equal(report.blocking.length, 4);
    assert.equal(report.items[0]!.nearest.length, 3);
    assert.equal(report.items[0]!.overlaps.length, 4);
    entry(repo, "library", "fold a b c d");
    commit(repo);
    assert.equal(
      checkNovelty({ root: repo.root, base: repo.base }).blocking.length,
      4,
      "a list of ids alone is not an explanation",
    );
  } finally {
    repo.dispose();
  }
});

test("two changed existing blocks compare their head descriptions and new custom preview paths", () => {
  const repo = fixture();
  try {
    repo.write("docs/library/catalogue.json", JSON.stringify({ version: 1, items: [original, distinct], styles: [] }));
    commit(repo);
    const base = repo.git("rev-parse", "HEAD");
    const updated = [original, distinct].map((item) => ({
      ...item,
      title: "Telescoping rails",
      description: "Telescoping mechanical rails extend along a tracked gantry",
      preview: { image: `docs/custom/${item.id}.png` },
    }));
    repo.write("docs/library/catalogue.json", JSON.stringify({ version: 1, items: updated, styles: [] }));
    for (const item of updated) repo.write(item.preview.image, Buffer.from([42]));
    entry(repo);
    commit(repo);
    const report = checkNovelty({ root: repo.root, base }, () => ({ hash: 42n }));
    assert.equal(report.blocking.length, 2);
    for (const item of report.items) {
      assert.ok(item.nearest[0]!.score > 0.99);
      assert.equal(item.images[0]!.distance, 0);
      assert.deepEqual(item.skipped, []);
    }
  } finally {
    repo.dispose();
  }
});

test("dHash is 64-bit and preview similarity blocks textually distinct items; unavailable tools are recorded", () => {
  assert.equal(differenceHash(Uint8Array.from({ length: 72 }, (_, i) => 255 - i)), (1n << 64n) - 1n);
  assert.equal(differenceHash(Uint8Array.from({ length: 72 }, (_, i) => i)), 0n);
  assert.equal(hammingDistance(0n, (1n << 64n) - 1n), 64);
  assert.throws(() => differenceHash(new Uint8Array(64)), /9×8/);
  const repo = fixture();
  try {
    repo.write("docs/library/catalogue.json", JSON.stringify({ version: 1, items: [original, distinct], styles: [] }));
    repo.write(original.preview.image, Buffer.from([1]));
    repo.write(distinct.preview.image, Buffer.from([2]));
    entry(repo);
    commit(repo);
    const report = checkNovelty({ root: repo.root, base: repo.base }, () => ({ hash: 42n }));
    assert.deepEqual(report.items[0]!.images, [{ id: "fold", distance: 0 }]);
    assert.equal(report.blocking.length, 1);
    const distinctReport = checkNovelty({ root: repo.root, base: repo.base }, (bytes) => ({
      hash: bytes[0] === 1 ? 0n : (1n << 64n) - 1n,
    }));
    assert.equal(distinctReport.blocking.length, 0);
    const missing = checkNovelty({ root: repo.root, base: repo.base }, () => ({
      reason: "ffmpeg is unavailable; image comparison skipped.",
    }));
    assert.match(missing.items[0]!.skipped[0]!.reason, /ffmpeg is unavailable/);
    assert.equal(missing.blocking.length, 0);
  } finally {
    repo.dispose();
  }
});

test("ffmpeg hashes an in-memory synthetic preview when installed", (t) => {
  const pixels = Buffer.from(Array.from({ length: 72 }, (_, i) => i));
  const result = previewHash(Buffer.concat([Buffer.from("P5\n9 8\n255\n"), pixels]));
  if (result.hash === undefined) {
    t.skip(result.reason);
    return;
  }
  assert.equal(result.hash, 0n);
});

test("a duplicate playbook blocks; its own English triggers report existing routes that outrank it", () => {
  const repo = fixture();
  const originalBook = book("existing", "Create paper folds and origami layers");
  try {
    repo.write("playbooks/existing/playbook.json", JSON.stringify(originalBook));
    commit(repo);
    const base = repo.git("rev-parse", "HEAD");
    const newBook = { ...originalBook, id: "new", title: "New paper folds" };
    repo.write("playbooks/new/playbook.json", JSON.stringify(newBook));
    entry(repo, "playbook");
    commit(repo);
    const report = checkNovelty({ root: repo.root, base });
    assert.deepEqual(report.blocking, ["playbook:new"]);
    assert.equal(report.items[0]!.nearest[0]!.id, "existing");
    assert.ok(
      report.items[0]!.outranked.some((row) => row.id === "existing"),
      "matcher ranking handles ties consistently",
    );
    entry(repo, "playbook", "existing adds a new creased product route");
    commit(repo);
    assert.deepEqual(checkNovelty({ root: repo.root, base }).blocking, []);
  } finally {
    repo.dispose();
  }
});

test("playbook matcher outranking is reported even with low textual similarity", () => {
  const repo = fixture();
  try {
    const existing = book("existing", "Create procedural origami sculptures", ["paper", "fold", "creased"]);
    repo.write("playbooks/existing/playbook.json", JSON.stringify(existing));
    commit(repo);
    const base = repo.git("rev-parse", "HEAD");
    const newBook = book("new", "Demonstrate geometric robotics assemblies", [
      "paper fold",
      "geometric arm",
      "robot assembly",
    ]);
    newBook.triggers.ru = ["робот", "сборка", "механизм"];
    repo.write("playbooks/new/playbook.json", JSON.stringify(newBook));
    entry(repo, "playbook");
    commit(repo);
    const report = checkNovelty({ root: repo.root, base });
    assert.ok(report.items[0]!.nearest[0]!.score < 0.55);
    assert.deepEqual(
      report.items[0]!.outranked.find((row) => row.trigger === "paper fold"),
      { trigger: "paper fold", id: "existing", score: 2, ownScore: 1.5 },
    );
    assert.equal(report.blocking.length, 1);
  } finally {
    repo.dispose();
  }
});

test("a new playbook compares against another playbook's updated head request", () => {
  const repo = fixture();
  try {
    repo.write(
      "playbooks/existing/playbook.json",
      JSON.stringify(book("existing", "Create procedural origami sculptures")),
    );
    commit(repo);
    const base = repo.git("rev-parse", "HEAD");
    const updated = book("existing", "Demonstrate geometric robotics assemblies", [
      "geometric arm",
      "robot assembly",
      "mechanical joint",
    ]);
    updated.triggers.ru = ["робот", "сборка", "механизм"];
    repo.write("playbooks/existing/playbook.json", JSON.stringify(updated));
    repo.write("playbooks/new/playbook.json", JSON.stringify({ ...updated, id: "new" }));
    entry(repo, "playbook");
    commit(repo);
    const report = checkNovelty({ root: repo.root, base });
    assert.deepEqual(report.blocking, ["playbook:new"]);
    assert.ok(report.items[0]!.nearest[0]!.score > 0.99);
    assert.ok(report.items[0]!.outranked.some((row) => row.id === "existing"));
  } finally {
    repo.dispose();
  }
});

test("novelty CLI help/invalid arguments follow the JSON contract", () => {
  const repo = fixture();
  try {
    for (const flags of [[], ["--base", "absent"], ["--unknown"]]) {
      const result = repo.cli("contrib-novelty", ...flags);
      assert.equal(result.status, 1);
      assert.equal(result.stdout.trim().split("\n").length, 1);
      assert.equal(JSON.parse(result.stdout).ok, false);
    }
    assert.equal(JSON.parse(repo.cli("contrib-novelty", "--help").stdout).metadata.help, true);
  } finally {
    repo.dispose();
  }
});

test("a PR cannot relax its own novelty thresholds: the base config decides", () => {
  const repo = fixture();
  try {
    repo.write(
      "contrib/novelty.json",
      JSON.stringify({ ...JSON.parse(config), text: { block: 1, playbook: 1 }, image: { maxHammingDistance: 0 } }),
    );
    repo.write("docs/library/catalogue.json", JSON.stringify({ version: 1, items: [original, duplicate], styles: [] }));
    entry(repo);
    commit(repo);
    assert.equal(checkNovelty({ root: repo.root, base: repo.base }).blocking.length, 1);
  } finally {
    repo.dispose();
  }
});
