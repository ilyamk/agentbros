import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { attachmentUrl, download } from "../scripts/github/download";
import { extractBundle, fetchBenchBundle, submissionFields } from "../scripts/bench-fetch-bundle";
import {
  changedShowcaseEntries,
  fetchShowcaseMedia,
  mediaType,
  validateShowcaseArtefact,
} from "../scripts/showcase-fetch-media";
import { prepareBenchReport, publishBenchReport } from "../scripts/github/gh-bench-report";
import { GitHub, type Fetch } from "../scripts/github/api";
import { ShowcaseSchema } from "../src/types/showcase";
import { BenchSubmissionReportSchema } from "../src/types/bench";

const root = process.cwd();
function workspace(t: test.TestContext) {
  const dir = mkdtempSync(path.join(tmpdir(), "automation-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const body = (bundle = "https://github.com/example/repo/releases/download/test/bundle.tar.gz") =>
  `### Bundle URL\n\n${bundle}\n\n### Signature and signer\n\nhttps://github.com/user-attachments/files/123/manifest.sig\n\n### Cells and protocol identity\n\nfixture, codex, test, protocol 1\n`;
function tar(entries: { name: string; type?: string; data?: string }[]): Buffer {
  return Buffer.concat([
    ...entries.flatMap((entry) => {
      const header = Buffer.alloc(512),
        data = Buffer.from(entry.data ?? "");
      header.write(entry.name, 0, 100);
      header.write("0000644\0", 100);
      header.write("0000000\0", 108);
      header.write("0000000\0", 116);
      header.write(data.length.toString(8).padStart(11, "0") + "\0", 124);
      header.write("00000000000\0", 136);
      header.fill(32, 148, 156);
      header.write(entry.type ?? "0", 156);
      header.write("ustar\0", 257);
      header.write("00", 263);
      const checksum = header.reduce((sum, byte) => sum + byte, 0);
      header.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148);
      return [header, data, Buffer.alloc((512 - (data.length % 512)) % 512)];
    }),
    Buffer.alloc(1024),
  ]);
}
test("bounded GitHub downloads validate origins, redirects and streamed bytes without credentials", async () => {
  for (const value of [
    "http://github.com/file",
    "https://evil.invalid/file",
    "https://github.com.evil.invalid/file",
    "https://user:pass@github.com/file",
    "https://github.com:444/file",
  ])
    assert.throws(() => attachmentUrl(value));
  const calls: string[] = [];
  const fetcher: Fetch = async (url, init) => {
    calls.push(String(url));
    assert.equal(init?.redirect, "manual");
    assert.equal(init?.headers, undefined);
    return calls.length === 1
      ? new Response(null, { status: 302, headers: { location: "https://objects.githubusercontent.com/data" } })
      : new Response("data");
  };
  assert.equal((await download("https://github.com/asset", 4, fetcher)).toString(), "data");
  assert.equal(calls.length, 2);
  await assert.rejects(
    download("https://github.com/asset", 3, async () => new Response("data")),
    /size cap/,
  );
  await assert.rejects(
    download("https://github.com/asset", 3, async () => new Response("x", { headers: { "content-length": "4" } })),
    /size cap/,
  );
  await assert.rejects(
    download(
      "https://github.com/asset",
      4,
      async () => new Response(null, { status: 302, headers: { location: "http://127.0.0.1/private" } }),
    ),
    /allowlisted/,
  );
  await assert.rejects(
    download(
      "https://github.com/asset",
      4,
      async () => new Response(null, { status: 302, headers: { location: "/loop" } }),
    ),
    /redirects/,
  );
});
test("benchmark archive extraction rejects traversal, links, devices, duplicates, corruption and expansion bombs", (t) => {
  const dir = workspace(t);
  extractBundle(
    gzipSync(
      tar([
        { name: "manifest.json", data: "{}" },
        { name: "nested/data.json", data: "data" },
      ]),
    ),
    path.join(dir, "valid"),
  );
  assert.equal(readFileSync(path.join(dir, "valid/nested/data.json"), "utf8"), "data");
  const cases = [
    tar([{ name: "../escape" }]),
    tar([{ name: "/absolute" }]),
    tar([{ name: "C:/absolute" }]),
    tar([{ name: "a/../escape" }]),
    tar([{ name: "a\\escape" }]),
    ...["1", "2", "3", "4", "6", "x", "L"].map((type) => tar([{ name: "link", type }])),
    tar([{ name: "same" }, { name: "same" }]),
    tar([{ name: "a" }, { name: "a/child" }]),
    Buffer.from("bad"),
    tar([{ name: "a" }]).subarray(0, 512),
  ];
  for (const [i, archive] of cases.entries())
    assert.throws(() => extractBundle(archive, path.join(dir, `invalid-${i}`)));
  const corrupt = tar([{ name: "bad" }]);
  corrupt[0] = 88;
  assert.throws(() => extractBundle(corrupt, path.join(dir, "corrupt")), /checksum/);
  assert.throws(() =>
    extractBundle(gzipSync(tar([{ name: "large", data: "x".repeat(5000) }])), path.join(dir, "bomb"), 2048),
  );
});
test("benchmark issue fields remain data and detached signatures are fetched offline", async (t) => {
  const dir = workspace(t),
    archive = gzipSync(tar([{ name: "manifest.json", data: "{}" }]));
  const signature = Buffer.from("-----BEGIN SSH SIGNATURE-----\nfixture\n-----END SSH SIGNATURE-----\n");
  const request: Fetch = async (url) => new Response(String(url).endsWith(".sig") ? signature : archive);
  const result = await fetchBenchBundle(body(), path.join(dir, "bundle"), request);
  assert.ok(result.cells.includes("codex"));
  assert.equal(readFileSync(path.join(dir, "bundle/manifest.json.sig"), "utf8"), signature.toString());
  assert.throws(() => submissionFields(body() + "\n### Bundle URL\nhttps://github.com/another"), /duplicate/);
  assert.throws(
    () =>
      submissionFields(
        body().replace("https://github.com/example/repo/releases/download/test/bundle.tar.gz", "$(echo evil)"),
      ),
    /one attachment/,
  );
  await assert.rejects(
    fetchBenchBundle(body("https://evil.invalid/bundle"), path.join(dir, "evil"), async () => {
      throw new Error("must not fetch");
    }),
    /allowlisted/,
  );
});
test("benchmark reporting validates schema, binds issue identity and upserts one comment", async () => {
  const event = { issue: { number: 12, user: { login: "alice" }, body: body() } };
  const report = prepareBenchReport(event, { ok: true, metadata: { verified: true } }, true);
  assert.equal(report.result.verified, false);
  assert.equal(BenchSubmissionReportSchema.safeParse({ ...report, arbitrary: true }).success, false);
  const calls: { route: string; method: string; body: unknown }[] = [];
  let comment: { id: number; body: string; user: { login: string } } | undefined;
  const api = new GitHub("example/repo", "fixture", async (input, init) => {
    const url = new URL(String(input)),
      route = url.pathname.replace("/repos/example/repo", "") + url.search,
      method = init?.method ?? "GET";
    const payload: unknown = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ route, method, body: payload });
    if (method === "POST" && route === "/issues/12/comments")
      comment = { id: 1, body: (payload as { body: string }).body, user: { login: "github-actions[bot]" } };
    const value =
      route === "/issues/12"
        ? { user: { login: "alice" }, labels: [{ name: "bench:submitted" }, { name: "bench:verified" }] }
        : route.startsWith("/issues/12/comments?")
          ? comment
            ? [comment]
            : []
          : {};
    return new Response(JSON.stringify(value));
  });
  await publishBenchReport(api, report, 12, "alice");
  await publishBenchReport(api, report, 12, "alice");
  assert.equal(calls.filter((call) => call.method === "POST" && call.route === "/issues/12/comments").length, 1);
  assert.ok(calls.some((call) => call.method === "DELETE" && call.route.endsWith("bench%3Averified")));
  await assert.rejects(publishBenchReport(api, report, 13, "alice"), /triggering issue/);
});
test("showcase sources require HTTPS and unique media kinds", () => {
  const sample = JSON.parse(readFileSync("tests/fixtures/showcase/showcase.json", "utf8"));
  assert.equal(
    ShowcaseSchema.safeParse({ ...sample, mediaSources: [{ kind: "thumbnail", url: "http://github.com/file" }] })
      .success,
    false,
  );
  assert.equal(
    ShowcaseSchema.safeParse({
      ...sample,
      mediaSources: [
        { kind: "thumbnail", url: "https://github.com/a" },
        { kind: "thumbnail", url: "https://github.com/b" },
      ],
    }).success,
    false,
  );
  assert.throws(() => mediaType(Buffer.from("<html>")));
});
test("showcase media is re-encoded, bounded, muted and revalidated as an artefact", async (t) => {
  if (spawnSync("ffmpeg", ["-version"]).status !== 0 || spawnSync("ffprobe", ["-version"]).status !== 0)
    return t.skip("FFmpeg/ffprobe missing");
  const dir = workspace(t),
    source = path.join(dir, "source.jpg"),
    preview = path.join(dir, "source.mp4");
  const run = (args: string[]) => {
    const result = spawnSync("ffmpeg", ["-v", "error", "-nostdin", ...args], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  };
  run(["-f", "lavfi", "-i", "color=c=red:s=1500x1800", "-frames:v", "1", source]);
  run([
    "-f",
    "lavfi",
    "-i",
    "color=c=blue:s=200x100:r=10:d=0.3",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:duration=0.3",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-shortest",
    preview,
  ]);
  const entry = JSON.parse(readFileSync("tests/fixtures/showcase/showcase.json", "utf8"));
  entry.mediaSources = ["thumbnail", "contactSheet", "preview"].map((kind) => ({
    kind,
    url: `https://github.com/user-attachments/${kind}`,
  }));
  const entryDir = path.join(dir, "showcases", entry.slug);
  mkdirSync(entryDir, { recursive: true });
  const entryFile = path.join(entryDir, "showcase.json");
  writeFileSync(entryFile, JSON.stringify(entry));
  const output = path.join(dir, "media");
  const manifest = await fetchShowcaseMedia(
    [entryFile],
    output,
    async (url) => new Response(readFileSync(String(url).endsWith("/preview") ? preview : source)),
  );
  assert.equal(manifest.files.length, 3);
  assert.equal(validateShowcaseArtefact(output, dir).assets.length, 3);
  assert.equal(validateShowcaseArtefact(output, dir, { structural: true }).assets.length, 3);
  assert.ok(manifest.files.every((file) => file.sha256.length === 64));
  writeFileSync(path.join(output, "unexpected.txt"), "bad");
  assert.throws(() => validateShowcaseArtefact(output, dir), /inventory/);
  rmSync(path.join(output, "unexpected.txt"));
  symlinkSync(source, path.join(output, "link"));
  assert.throws(() => validateShowcaseArtefact(output, dir), /symlink/);
  assert.deepEqual(readdirSync(entryDir), ["showcase.json"]);
});
test("new CLIs return one JSON line and never load .env", (t) => {
  const dir = workspace(t);
  writeFileSync(path.join(dir, ".env"), "INVALID ENV FILE");
  const scripts = ["showcase-fetch-media.ts", "bench-fetch-bundle.ts", "github/gh-bench-report.ts"];
  for (const script of scripts) {
    const result = spawnSync(
      process.execPath,
      ["--import", path.join(root, "node_modules/tsx/dist/loader.mjs"), path.join(root, "scripts", script), "--help"],
      { cwd: dir, encoding: "utf8", env: { AGENTBROS_NO_DOTENV: "1", PATH: process.env.PATH } },
    );
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(result.stdout.trim().split("\n").length, 1);
    assert.equal(JSON.parse(result.stdout).metadata.help, true);
  }
  const event = path.join(dir, "event.json"),
    output = path.join(dir, "report.json");
  writeFileSync(event, JSON.stringify({ issue: { number: 12, user: { login: "alice" }, body: body() } }));
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      path.join(root, "node_modules/tsx/dist/loader.mjs"),
      path.join(root, "scripts/github/gh-bench-report.ts"),
      "--event",
      event,
      "--out",
      output,
    ],
    { cwd: dir, encoding: "utf8", env: { AGENTBROS_NO_DOTENV: "1", PATH: process.env.PATH } },
  );
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(JSON.parse(readFileSync(output, "utf8")).result.verified, false);
});

test("benchmark release redirects use their own allowlist without extending showcase hosts", async () => {
  const { BENCH_ATTACHMENT_HOSTS } = await import("../scripts/github/download");
  assert.throws(() => attachmentUrl("https://release-assets.githubusercontent.com/file"));
  let calls = 0;
  const request: Fetch = async () =>
    ++calls === 1
      ? new Response(null, { status: 302, headers: { location: "https://release-assets.githubusercontent.com/file" } })
      : new Response("data");
  assert.equal((await download("https://github.com/asset", 4, request, BENCH_ATTACHMENT_HOSTS)).toString(), "data");
});

test("verified public exports report signature integrity without claiming recomputation", async () => {
  const claims = {
    tokens: null,
    toolCalls: 0,
    spendUsd: null,
    transcriptState: "complete",
    delivery: "unavailable",
    criteria: [],
    technical: {},
  };
  const manifest = {
    version: 1,
    protocolVersion: 1,
    suiteVersion: 1,
    taskSha256: "a".repeat(64),
    visibility: "public",
    publication: { policyVersion: 1, sourceManifestSha256: "b".repeat(64) },
    cell: { task: "fixture", harness: "codex", model: "test", harnessCommit: "c".repeat(40), run: 1 },
    files: [],
    omitted: [],
    env: { os: "fixture", arch: "fixture", node: "22", harnessVersion: "test" },
    tokens: null,
    toolCalls: 0,
    wallTimeSec: 1,
    spendUsd: null,
    transcript: null,
    status: "completed",
    exitCode: 0,
    claims,
  };
  const report = prepareBenchReport(
    { issue: { number: 12, user: { login: "alice" }, body: body() } },
    {
      ok: true,
      metadata: {
        verified: true,
        label: "community-export",
        signer: "alice",
        manifest,
        recomputed: null,
        limitations: ["Measurements are claims."],
      },
    },
    true,
  );
  assert.equal(report.result.verified, true);
  let comment = "";
  const api = new GitHub("example/repo", "fixture", async (url, init) => {
    const route = new URL(String(url)).pathname;
    if (init?.method === "POST" && route.endsWith("/comments")) comment = JSON.parse(String(init.body)).body;
    const result = route.endsWith("/issues/12")
      ? { user: { login: "alice" }, labels: [{ name: "bench:submitted" }] }
      : route.endsWith("/comments")
        ? []
        : {};
    return new Response(JSON.stringify(result));
  });
  await publishBenchReport(api, report, 12, "alice");
  assert.match(comment, /file integrity verification passed; measurements remain claims/);
  assert.ok(!comment.includes("deterministic verification passed"));
});

test("showcase selection covers whole push ranges, initial pushes and only direct manifests", (t) => {
  const dir = workspace(t);
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: dir,
      encoding: "utf8",
      env: {
        AGENTBROS_NO_DOTENV: "1",
        PATH: process.env.PATH,
        HOME: dir,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: path.join(dir, "no-config"),
        GIT_AUTHOR_NAME: "Fixture",
        GIT_AUTHOR_EMAIL: "test@example.invalid",
        GIT_COMMITTER_NAME: "Fixture",
        GIT_COMMITTER_EMAIL: "test@example.invalid",
      },
    }).trim();
  git("init");
  writeFileSync(path.join(dir, "README.md"), "fixture");
  git("add", ".");
  git("commit", "-m", "base");
  const base = git("rev-parse", "HEAD");
  for (const slug of ["first", "second"]) {
    mkdirSync(path.join(dir, "showcases", slug), { recursive: true });
    writeFileSync(path.join(dir, "showcases", slug, "showcase.json"), "{}");
    git("add", ".");
    git("commit", "-m", slug);
  }
  const head = git("rev-parse", "HEAD");
  assert.deepEqual(changedShowcaseEntries(base, head, dir), [
    "showcases/first/showcase.json",
    "showcases/second/showcase.json",
  ]);
  assert.deepEqual(changedShowcaseEntries("0".repeat(40), head, dir), [
    "showcases/first/showcase.json",
    "showcases/second/showcase.json",
  ]);
  assert.throws(() => changedShowcaseEntries("--all", head, dir));
});
