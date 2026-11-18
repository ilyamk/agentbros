import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { ShowcaseSchema, ShowcaseDraftSchema } from "../src/types/showcase";
import { ContributorSchema } from "../src/types/contributor";
import { generationInputHash } from "../src/lib/jobs/runner";
import { hashFile } from "../src/lib/assets/registry";
import { probeVideo } from "../src/lib/vision/media";
import { stripPaths, stripExportPaths } from "../src/lib/showcase/data";

const root = path.resolve(import.meta.dirname, ".."),
  fixture = path.join(root, "tests/fixtures/showcase");
const sample = () => JSON.parse(readFileSync(path.join(fixture, "showcase.json"), "utf8"));
const json = (file: string, data: unknown) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(data));
};
const workspace = (t: { after: (fn: () => void) => void }) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "showcase-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};
function cli(dir: string, script: string, args: string[] = []) {
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      path.join(root, "node_modules/tsx/dist/loader.mjs"),
      path.join(root, "scripts", script + ".ts"),
      ...args,
    ],
    {
      cwd: dir,
      encoding: "utf8",
      env: { AGENTBROS_NO_DOTENV: "1", PATH: process.env.PATH, AGENTBROS_MEMORY_ROOT: path.join(dir, "memory") },
      maxBuffer: 1024 * 1024,
    },
  );
  assert.equal(result.stdout.trim().split("\n").length, 1, result.stderr);
  return { status: result.status, data: JSON.parse(result.stdout), stderr: result.stderr };
}
function git(dir: string, args: string[]) {
  const result = spawnSync("git", args, {
    cwd: dir,
    encoding: "utf8",
    env: {
      AGENTBROS_NO_DOTENV: "1",
      PATH: process.env.PATH,
      HOME: dir,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "Fixture",
      GIT_AUTHOR_EMAIL: "fixture@invalid.test",
      GIT_COMMITTER_NAME: "Fixture",
      GIT_COMMITTER_EMAIL: "fixture@invalid.test",
    },
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}
function project(dir: string) {
  for (const name of ["project", "brief"])
    json(
      path.join(dir, "public/projects/example", name === "brief" ? "pipeline/brief.json" : "project.json"),
      JSON.parse(readFileSync(path.join(fixture, name + ".json"), "utf8")),
    );
  json(path.join(dir, "public/projects/example/pipeline/playbook.json"), {
    version: 1,
    id: "product-promo",
    chosenAt: "2026-11-15T00:00:00.000Z",
    by: "user",
  });
}
function metrics(dir: string) {
  mkdirSync(path.join(dir, "memory"), { recursive: true });
  const rows = [
    { event: "round", step: "critic", value: 8 },
    { event: "removed" },
    { event: "round", step: "critic", value: 1 },
    { event: "round", step: "critic", value: 2 },
    { event: "approved" },
    { event: "rejected" },
    { event: "sensor-fail", value: 3, detail: "Private failure detail" },
    { event: "delivered" },
  ];
  writeFileSync(
    path.join(dir, "memory/metrics.jsonl"),
    rows
      .map((row, index) => JSON.stringify({ project: "example", at: `2026-11-15T00:0${index}:00.000Z`, ...row }))
      .join("\n"),
  );
}
const ffmpeg = spawnSync("ffmpeg", ["-version"]).status === 0 && spawnSync("ffprobe", ["-version"]).status === 0;

test("showcase and profile schemas enforce HTTPS, harness, verification, lengths and strict fields", () => {
  assert.ok(ShowcaseSchema.safeParse(sample()).success);
  assert.equal(ShowcaseSchema.safeParse({ ...sample(), harness: null, rights: null }).success, false);
  assert.ok(ShowcaseDraftSchema.safeParse({ ...sample(), harness: null, rights: null }).success);
  for (const patch of [
    { harness: "other" },
    { verification: "watched" },
    { links: ["http://example.org"] },
    { links: ["javascript:alert(1)"] },
    { author: { ...sample().author, credits: "x".repeat(501) } },
    {
      media: {
        thumbnail: "https://example.org/t",
        contactSheet: "https://example.org/c",
        preview: "file:///tmp/preview",
      },
    },
    { unexpected: true },
  ])
    assert.equal(ShowcaseSchema.safeParse({ ...sample(), ...patch }).success, false);
  for (const verification of ["declared", "receipt", "maintainer", "reproducible"])
    assert.ok(ShowcaseSchema.safeParse({ ...sample(), verification }).success);
  assert.ok(ContributorSchema.safeParse({ displayName: "Name", links: [], bio: "", credits: "" }).success);
  assert.equal(
    ContributorSchema.safeParse({ displayName: "Name", links: [], bio: "x".repeat(281), credits: "" }).success,
    false,
  );
  assert.equal(
    ContributorSchema.safeParse({ displayName: "Name", links: ["http://example.org"], bio: "", credits: "" }).success,
    false,
  );
  assert.equal(stripPaths("Source " + ["", "home", "private", "film.mp4"].join("/")), "Source [local path]");
  assert.equal(
    stripPaths("Source /srv/private/film.mp4 and C:/client/file and C:\\client\\file"),
    "Source [local path] and [local path] and [local path]",
  );
  assert.equal(stripPaths("https://example.org/film"), "https://example.org/film");
  assert.deepEqual(
    stripExportPaths({ author: { credits: "Shot in /srv/client" }, rights: "Files at C:/client/file" }),
    { author: { credits: "Shot in [local path]" }, rights: "Files at [local path]" },
  );
});

test(
  "showcase:add builds receipt-bound metadata and muted local media; stale/partial receipts downgrade",
  { skip: !ffmpeg ? "ffmpeg/ffprobe missing; synthetic media generation requires both tools" : false },
  (t) => {
    const dir = workspace(t);
    project(dir);
    metrics(dir);
    git(dir, ["init", "-q"]);
    writeFileSync(path.join(dir, "seed.txt"), "Fixture");
    git(dir, ["add", "seed.txt"]);
    git(dir, ["commit", "-qm", "Fixture"]);
    mkdirSync(path.join(dir, "out/example"), { recursive: true });
    const render = path.join(dir, "out/example/film.mp4");
    const made = spawnSync(
      "ffmpeg",
      [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "color=c=green:s=160x90:r=12:d=1",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:duration=1",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-shortest",
        render,
      ],
      { encoding: "utf8" },
    );
    assert.equal(made.status, 0, made.stderr);
    const hash = "a".repeat(64),
      identity = {
        version: 1,
        projectId: "example",
        format: "landscape",
        captions: "on",
        compositionId: "Fixture",
        durationInFrames: 12,
        propsHash: hash,
        sourceSnapshotHash: hash,
        storyHash: hash,
        editRevision: null,
        sources: [],
      };
    const basis = { version: 1, projectId: "example", identities: [identity] },
      snapshotId = generationInputHash(basis);
    json(path.join(dir, "public/projects/example/pipeline/delivery/snapshots", snapshotId + ".json"), {
      ...basis,
      id: snapshotId,
      createdAt: "2026-11-15T00:00:00.000Z",
    });
    const receipt = {
      version: 1,
      sourceSnapshotHash: hash,
      propsHash: hash,
      outputSha256: hashFile(render),
      format: "landscape",
      captions: "on",
      createdAt: "2026-11-15T00:00:00.000Z",
      sources: [],
    };
    json(render + ".receipt.json", receipt);
    json(path.join(dir, "community/contributors/fixture-author.json"), {
      displayName: "Fixture Author",
      bio: "",
      links: [],
      credits: "Files at /srv/private/client",
    });
    const args = [
      "--project",
      "example",
      "--slug",
      "example",
      "--author",
      "fixture-author",
      "--harness",
      "codex",
      "--model",
      "fixture-model",
      "--link",
      "https://example.org/film",
    ];
    const added = cli(dir, "showcase-add", args);
    assert.equal(added.status, 0, JSON.stringify(added.data));
    const entry = added.data.metadata.entry;
    assert.equal(entry.verification, "receipt");
    assert.equal(entry.evidence.snapshotId, snapshotId);
    assert.equal(entry.rounds, 2);
    assert.equal(entry.userInterventions, 2);
    assert.equal(entry.settings.references[0].count, 1);
    assert.equal(entry.settings.voice, "fixture-voice");
    assert.ok(added.data.metadata.prBody.includes("agentbros:pr"));
    assert.equal(entry.rights, null);
    assert.equal(entry.author.credits, "Files at [local path]");
    assert.equal(probeVideo(path.join(dir, "out/example/showcase/thumbnail.jpg")).width, 1280);
    const preview = probeVideo(path.join(dir, "out/example/showcase/preview.mp4"));
    assert.ok(preview.durationSec <= 10);
    assert.equal(preview.hasAudio, false);
    assert.ok(existsSync(path.join(dir, "out/example/showcase/contact-sheet.jpg")));
    assert.equal(existsSync(path.join(dir, "showcases/example/preview.mp4")), false);
    assert.equal(cli(dir, "showcase-add", args).data.error, "FILE_EXISTS");
    for (const [slug, patch] of [
      ["stale", { outputSha256: "b".repeat(64) }],
      ["partial", { partial: { startFrame: 0, endFrame: 1, totalFrames: 12 } }],
      ["manual", { evidence: "human-declared", reviewedBy: "Fixture", note: "Manual binding" }],
    ] as const) {
      json(render + ".receipt.json", { ...receipt, ...patch });
      const result = cli(dir, "showcase-add", [
        "--project",
        "example",
        "--slug",
        slug,
        "--author",
        "fixture-author",
        "--skip-media",
      ]);
      assert.equal(result.status, 0, JSON.stringify(result.data));
      assert.equal(result.data.metadata.entry.verification, "declared");
    }
    json(render + ".receipt.json", receipt);
    json(path.join(dir, "public/projects/example/pipeline/delivery/snapshots", snapshotId + ".json"), {
      ...basis,
      id: "c".repeat(64),
      createdAt: "2026-11-15T00:00:00.000Z",
    });
    assert.equal(
      cli(dir, "showcase-add", [
        "--project",
        "example",
        "--slug",
        "bad-snapshot",
        "--author",
        "fixture-author",
        "--skip-media",
      ]).data.metadata.entry.verification,
      "declared",
    );
  },
);

test("field report uses memory tombstones and unknown ledger costs without exporting identities", (t) => {
  const dir = workspace(t);
  project(dir);
  metrics(dir);
  const ledger = [
    { service: "fixture-provider", model: "fixture", estimatedUsd: 1, actualUsd: null },
    { service: "unknown-provider", model: "fixture", estimatedUsd: null, actualUsd: null },
  ];
  writeFileSync(
    path.join(dir, "public/projects/example/pipeline/cost-ledger.jsonl"),
    ledger.map((row) => JSON.stringify(row)).join("\n"),
  );
  const result = cli(dir, "field-report", ["--project", "example"]);
  assert.equal(result.status, 0, JSON.stringify(result.data));
  const { report, markdown } = result.data.metadata;
  assert.equal(report.rounds, 2);
  assert.equal(report.approvals, 1);
  assert.equal(report.sensorFailures, 1);
  assert.equal(report.spend.totalUsd, null);
  assert.equal(report.delivered, true);
  assert.equal(markdown.includes("example"), false);
  assert.equal(JSON.stringify(report).includes("Private failure"), false);
  assert.ok(markdown.includes("Anonymous field report"));
  assert.equal(cli(dir, "field-report", ["--project", "missing"]).data.error, "PROJECT_NOT_FOUND");
  writeFileSync(
    path.join(dir, "public/projects/example/pipeline/cost-ledger.jsonl"),
    JSON.stringify({ service: "sk-" + "a".repeat(25), estimatedUsd: 1 }),
  );
  assert.equal(cli(dir, "field-report", ["--project", "example"]).data.error, "VALIDATION");
});

test("showcase:media accepts workflow asset names and refuses ambiguous or unsafe publication", (t) => {
  const dir = workspace(t),
    file = path.join(dir, "showcase.json"),
    assetsFile = path.join(dir, "assets.json");
  json(file, sample());
  const assets = ["thumbnail.jpg", "contact-sheet.jpg", "preview.mp4"].map((name) => ({
    name: `synthetic-film-${"b".repeat(64)}-${name}`,
    url: `https://github.com/ilyamk/agentbros/releases/download/showcase-media/synthetic-film-${"b".repeat(64)}-${name}`,
  }));
  json(assetsFile, assets);
  const result = cli(dir, "showcase-media", ["--entry", file, "--release-assets", assetsFile]);
  assert.equal(result.status, 0, JSON.stringify(result.data));
  assert.ok(result.data.metadata.entry.media.preview.endsWith("preview.mp4"));
  assert.equal(cli(dir, "showcase-media", ["--entry", file, "--release-assets", assetsFile]).status, 0);
  json(assetsFile, []);
  assert.equal(cli(dir, "showcase-media", ["--entry", file, "--release-assets", assetsFile]).status, 0);
  json(file, sample());
  json(assetsFile, [...assets, { ...assets[0], name: `synthetic-film-${"c".repeat(64)}-thumbnail.jpg` }]);
  assert.equal(cli(dir, "showcase-media", ["--entry", file, "--release-assets", assetsFile]).data.error, "VALIDATION");
  json(
    assetsFile,
    assets.map((asset) => ({ ...asset, url: "javascript:alert(1)" })),
  );
  assert.equal(cli(dir, "showcase-media", ["--entry", file, "--release-assets", assetsFile]).data.error, "VALIDATION");
});

test("showcase:readme updates only its block, selects verified entries and has an empty state", (t) => {
  const dir = workspace(t);
  writeFileSync(path.join(dir, "README.md"), "# Fixture\n\n## Now Showing\n\nKeep this paragraph.\n");
  assert.equal(cli(dir, "showcase-readme").status, 0);
  assert.ok(readFileSync(path.join(dir, "README.md"), "utf8").includes("Verified community films will appear here."));
  json(path.join(dir, "showcases/synthetic-film/showcase.json"), { ...sample(), verification: "receipt" });
  assert.equal(cli(dir, "showcase-readme").status, 0);
  const content = readFileSync(path.join(dir, "README.md"), "utf8");
  assert.ok(content.includes("Keep this paragraph."));
  assert.equal(content.match(/showcases:start/g)?.length, 1);
  assert.ok(content.includes("/showcases/synthetic-film/"));
});
