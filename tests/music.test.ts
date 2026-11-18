import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { MusicCandidateSchema, MusicDecisionSchema, MusicShortlistSchema } from "../src/types/film";
import { acquireMusic } from "../src/lib/music/acquire";
import { MusicHttp } from "../src/lib/music/http";
import { classifyTrackLicence, commerciallyUsable } from "../src/lib/music/licence";
import { buildMusicOptions, recordMusicDecision } from "../src/lib/music/options";
import { archiveItemHit, ccmixterHit, freesoundHit, jamendoHit, openverseHit } from "../src/lib/music/providers";
import { extractReferenceAudio, referenceHit } from "../src/lib/music/reference";
import { checkProjectMusicRights, musicRights } from "../src/lib/music/rights-guard";
import { dedupe, searchFreeStock } from "../src/lib/music/search";
import { buildShortlist, runAudioMap } from "../src/lib/music/shortlist";
import { parseNames, searchTrending } from "../src/lib/music/trending";
import { MUSIC_PATHS, MusicSearchFileSchema, TRENDING_NOTICE, type MusicHit } from "../src/lib/music/types";

const NOW = "2026-11-04T00:00:00.000Z";
const fixture = (name: string) => JSON.parse(readFileSync(`tests/fixtures/music/${name}.json`, "utf8"));
type Route = [RegExp, () => Response | Promise<Response>];
const json = (value: unknown) =>
  new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });

/** Any request without a route throws, so a test can never reach the network. */
function mockFetch(routes: Route[], calls: string[] = []): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    const route = routes.find(([pattern]) => pattern.test(url));
    if (!route) throw new Error(`Unexpected request in a test: ${url}`);
    return route[1]();
  }) as typeof fetch;
}

function tempRoot(t: test.TestContext, project = "demo") {
  const root = mkdtempSync(path.join(tmpdir(), "music-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const projectDir = path.join(root, "public/projects", project);
  mkdirSync(path.join(projectDir, "pipeline/music"), { recursive: true });
  writeFileSync(path.join(projectDir, "project.json"), "{}");
  return { root, projectDir };
}

function toneFile(file: string, seconds = 1, frequency = 440) {
  mkdirSync(path.dirname(file), { recursive: true });
  const result = spawnSync("ffmpeg", [
    "-v",
    "error",
    "-nostdin",
    "-y",
    "-f",
    "lavfi",
    "-i",
    `sine=frequency=${frequency}:duration=${seconds}`,
    file,
  ]);
  assert.equal(result.status, 0, String(result.stderr));
  return file;
}

const stockRoutes = (over: Route[] = []): Route[] => [
  ...over,
  [/api\.openverse\.org/, () => json(fixture("openverse-audio"))],
  [/ccmixter\.org\/api\/query.*offset=0/, () => json(fixture("ccmixter-query"))],
  [/ccmixter\.org\/api\/query/, () => json([])],
  [/archive\.org\/advancedsearch/, () => json(fixture("archive-search"))],
  [/archive\.org\/metadata\//, () => json(Object.values(fixture("archive-metadata"))[1])],
  [/freesound\.org\/apiv2\/search/, () => json(fixture("freesound-search"))],
];

const hit = (over: Partial<MusicHit> = {}): MusicHit => ({
  id: "ccmixter:1",
  route: "free-stock",
  provider: "ccmixter",
  title: "Track",
  creator: "Artist",
  sourceUrl: "https://ccmixter.org/files/a/1",
  licence: { code: "CC BY 4.0", commercial: "yes", attribution: "Track by Artist", verifiedAt: NOW },
  acquisition: "manual",
  instrumental: "yes",
  tags: [],
  sourceVerified: true,
  syncAllowed: true,
  shareAlike: false,
  ...over,
});

function writeSearch(projectDir: string, candidates: MusicHit[], name = MUSIC_PATHS.searchFreeStock) {
  const file = path.join(projectDir, name);
  writeFileSync(
    file,
    JSON.stringify(MusicSearchFileSchema.parse({ schemaVersion: 1, kind: "free-stock", brief: "calm", candidates })),
  );
  return file;
}

// --- Licences ---

test("licences come from licence fields, and anything unrecognised stays unknown", () => {
  const common = { title: "T", sourceUrl: "https://example.com/t" };
  assert.deepEqual(
    classifyTrackLicence({ ...common, url: "http://creativecommons.org/publicdomain/zero/1.0/" }).licence.code,
    "CC0 1.0",
  );
  const by = classifyTrackLicence({ ...common, creator: "A", url: "https://creativecommons.org/licenses/by/4.0/" });
  assert.equal(by.licence.commercial, "yes");
  assert.ok(by.licence.attribution);
  assert.equal(
    classifyTrackLicence({ ...common, url: "https://creativecommons.org/licenses/by-nc/3.0/" }).licence.commercial,
    "no",
  );
  const nd = classifyTrackLicence({ ...common, url: "https://creativecommons.org/licenses/by-nd/4.0/" });
  assert.equal(nd.syncAllowed, false, "syncing to picture is an adaptation");
  assert.equal(commerciallyUsable(nd), false);
  for (const licence of [
    { url: "http://creativecommons.org/licenses/sampling+/1.0/" },
    {},
    { licence: "royalty free!" },
  ]) {
    const result = classifyTrackLicence({ ...common, title: "CC0_free_commercial.mp3", ...licence });
    assert.equal(result.licence.code, "unknown");
    assert.equal(result.licence.commercial, "unknown");
    assert.equal(commerciallyUsable(result), false);
  }
});

// --- Adapters, on recorded responses ---

test("every adapter normalises a recorded response to the contract", () => {
  const rows = [
    ...fixture("openverse-audio").results.map(openverseHit),
    ...fixture("ccmixter-query").map((item: never) => ccmixterHit(item, NOW)),
    ...fixture("freesound-search").results.map((item: never) => freesoundHit(item, NOW)),
    ...fixture("jamendo-tracks").results.map((item: never) => jamendoHit(item, NOW)),
    ...Object.entries(fixture("archive-metadata")).flatMap(
      ([id, meta]) => archiveItemHit(id, meta as never, 0, NOW) ?? [],
    ),
  ] as MusicHit[];
  assert.ok(rows.length >= 8);
  for (const row of rows) assert.ok(MusicCandidateSchema.safeParse(row).success, row.id);
});

test("Openverse is never verified at source; a host's own record is", () => {
  const openverse = fixture("openverse-audio").results.map(openverseHit) as MusicHit[];
  assert.ok(openverse.every((row) => !row.sourceVerified && !row.licence.verifiedAt));
  const viaFreesound = openverse.find((row) => row.origin === "freesound");
  if (viaFreesound)
    assert.equal(viaFreesound.originalUrl, undefined, "the file Openverse gives for Freesound is the preview");
  const [cc] = fixture("ccmixter-query").map((item: never) => ccmixterHit(item, NOW)) as MusicHit[];
  assert.ok(cc!.sourceVerified && cc!.licence.verifiedAt);
  assert.equal(cc!.previewUrl, undefined, "ccMixter refuses downloads from outside its pages");
  assert.equal(cc!.acquisition, "manual");
});

test("Jamendo tracks stay unknown for commercial use on the free API tier", () => {
  const [row] = fixture("jamendo-tracks").results.map((item: never) => jamendoHit(item, NOW)) as MusicHit[];
  assert.equal(row!.licence.code, "CC BY 3.0");
  assert.equal(row!.licence.commercial, "unknown");
  assert.match(row!.acquisitionNote!, /non-commercial/);
});

test("Internet Archive builds a direct file address and honours the shortest length", () => {
  const items = Object.entries(fixture("archive-metadata"));
  assert.equal(
    archiveItemHit(items[0]![0], items[0]![1] as never, 1, NOW),
    undefined,
    "this recorded item holds no MP3",
  );
  const [id, meta] = items[1]!;
  const row = archiveItemHit(id, meta as never, 1, NOW)!;
  assert.match(row.originalUrl!, /^https:\/\/[^/]+\.archive\.org\//);
  assert.equal(archiveItemHit(id, meta as never, 99_999, NOW), undefined);
});

// --- Search ---

test("the commercial filter keeps only licences known to allow commercial sync", async () => {
  const http = new MusicHttp({ fetch: mockFetch(stockRoutes()), now: () => NOW });
  const result = await searchFreeStock(
    http,
    { query: "calm piano", commercial: true, limit: 30 },
    { freesound: "key" },
  );
  assert.ok(result.candidates.length > 0);
  for (const row of result.candidates) {
    assert.equal(row.licence.commercial, "yes", row.id);
    assert.equal(row.syncAllowed, true, row.id);
    assert.notEqual(row.licence.code, "unknown");
    assert.ok(row.why);
  }
  assert.deepEqual(
    new Set(result.manualRoutes.map((route) => (route as { provider: string }).provider)),
    new Set(["pixabay-music", "youtube-audio-library", "ncs", "ende-app"]),
  );
});

test("a Jamendo track through Openverse is treated like one through Jamendo's own API", async () => {
  const row = {
    ...fixture("openverse-audio").results.find((item: { source: string }) => item.source === "jamendo"),
    license: "by",
    license_version: "3.0",
    license_url: "https://creativecommons.org/licenses/by/3.0/",
  };
  const hit = openverseHit(row);
  assert.equal(hit.licence.code, "CC BY 3.0");
  assert.equal(hit.licence.commercial, "unknown");
  assert.match(hit.acquisitionNote!, /non-commercial/);
  const http = new MusicHttp({
    fetch: mockFetch(stockRoutes([[/api\.openverse\.org/, () => json({ results: [row] })]])),
    now: () => NOW,
  });
  const commercial = await searchFreeStock(http, { query: "calm piano", commercial: true, limit: 30 }, {});
  assert.ok(!commercial.candidates.some((item) => item.provider === "openverse"));
  assert.ok(commercial.excluded.licenceUnknown! >= 1);
  const open = await searchFreeStock(http, { query: "calm piano", commercial: false, limit: 30 }, {});
  assert.ok(open.candidates.some((item) => item.provider === "openverse"));
});

test("a failed provider and an unconnected one are reported without hiding the rest", async () => {
  const http = new MusicHttp({
    fetch: mockFetch(stockRoutes([[/ccmixter\.org/, () => new Response("Forbidden", { status: 403 })]])),
    now: () => NOW,
  });
  const result = await searchFreeStock(http, { query: "calm piano", commercial: false, limit: 12 }, {});
  const status = Object.fromEntries(result.providers.map((item) => [item.provider, item]));
  assert.equal(status.ccmixter!.status, "failed");
  assert.equal(status.jamendo!.status, "not-connected");
  assert.match(status.jamendo!.howToConnect!, /JAMENDO_CLIENT_ID/);
  assert.equal(status.freesound!.status, "not-connected");
  assert.equal(status.openverse!.status, "ok");
  assert.ok(result.candidates.length > 0);
});

test("the same track through an aggregator gives way to the host's own record", () => {
  const url = "https://freesound.org/people/a/sounds/1/";
  const rows = dedupe([
    hit({ id: "openverse:1", sourceUrl: url, sourceVerified: false }),
    hit({ id: "freesound:1", sourceUrl: url, sourceVerified: true }),
  ]);
  assert.deepEqual(
    rows.map((row) => row.id),
    ["freesound:1"],
  );
});

test("ccMixter is read four rows at a time, since it repeats the body in a response header", async () => {
  const calls: string[] = [];
  const http = new MusicHttp({ fetch: mockFetch(stockRoutes(), calls), now: () => NOW });
  await searchFreeStock(http, { query: "calm", commercial: false, limit: 12 }, {});
  const cc = calls.filter((url) => url.includes("ccmixter"));
  assert.ok(cc.length >= 1);
  assert.ok(cc.every((url) => new URL(url).searchParams.get("limit") === "4"));
});

// --- Trending ---

test("charts say what they are and every candidate is native-only", async () => {
  const http = new MusicHttp({
    fetch: mockFetch([
      [/deezer\.com\/chart/, () => json(fixture("deezer-chart"))],
      [/most-played/, () => json(fixture("apple-most-played"))],
      [/itunes\.apple\.com\/lookup/, () => json(fixture("itunes-lookup"))],
    ]),
    now: () => NOW,
  });
  const result = await searchTrending(http, { market: "gb", limit: 3 });
  assert.equal(result.notice, TRENDING_NOTICE);
  assert.match(result.notice!, /not TikTok/);
  assert.deepEqual(new Set(result.candidates.map((row) => row.provider)), new Set(["deezer", "itunes"]));
  for (const row of result.candidates) {
    assert.equal(row.route, "trending-native");
    assert.equal(row.licence.commercial, "no");
    assert.equal(row.originalUrl, undefined);
    assert.ok(row.chart);
  }
  await assert.rejects(searchTrending(http, { market: "britain", limit: 3 }), /two-letter/);
});

test("pasted names find previews and report what stays unmatched", async () => {
  assert.deepEqual(
    parseNames("A - B; C").map((item) => [item.artist, item.title]),
    [
      ["A", "B"],
      [undefined, "C"],
    ],
  );
  const calls: string[] = [];
  const http = new MusicHttp({
    fetch: mockFetch(
      [
        [/deezer\.com\/search.*Tame/, () => json(fixture("deezer-search"))],
        [/deezer\.com\/search/, () => json({ data: [] })],
        [/itunes\.apple\.com\/search/, () => json({ results: [] })],
      ],
      calls,
    ),
    now: () => NOW,
  });
  const result = await searchTrending(http, {
    market: "us",
    limit: 3,
    names: "Tame Impala - Dracula (with JENNIE); Nobody - Nothing Here",
  });
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0]!.route, "trending-native");
  assert.deepEqual(result.unmatched, ["Nobody - Nothing Here"]);
  assert.ok(
    calls.every((url) => !url.includes("artist%3A")),
    "the field syntax misses bracketed titles",
  );
});

// --- Options and record ---

test("options offer all seven routes, state connections and never clear a reference by default", () => {
  const options = buildMusicOptions({
    referenceId: "ref",
    referenceRights: { status: "study-only" },
    hasReferenceAudio: true,
    env: {},
  });
  assert.deepEqual(
    options.routes.map((route) => route.route),
    ["reference-track", "free-stock", "trending-native", "generated", "user-supplied", "synth", "silence"],
  );
  assert.equal(options.routes.filter((route) => route.recommended).length, 1);
  assert.equal(options.recommended, "free-stock");
  assert.equal(options.routes[0]!.delivery, "study-only");
  assert.equal(options.routes.find((route) => route.route === "generated")!.connected.status, "not-connected");
  assert.match(options.routes[1]!.connected.detail, /Jamendo is not connected/);
  assert.match(options.question, /Which do you want\?$/);
  for (const route of options.routes) assert.ok(options.question.includes(route.label));
  assert.equal(
    buildMusicOptions({ referenceId: "ref", referenceRights: { status: "owned" }, hasReferenceAudio: true, env: {} })
      .recommended,
    "reference-track",
  );
  assert.equal(
    buildMusicOptions({ brief: { topic: "A TikTok for our founders" }, env: {} }).recommended,
    "trending-native",
  );
  assert.equal(buildMusicOptions({ brief: { topic: "A paid TikTok ad" }, env: {} }).recommended, "free-stock");
});

test("record refuses a decision the user was not asked about", (t) => {
  const { projectDir } = tempRoot(t);
  assert.throws(
    () => recordMusicDecision(projectDir, { route: "free-stock", answer: "yes", reason: "r" }),
    /not been asked/,
  );
  writeFileSync(path.join(projectDir, MUSIC_PATHS.options), JSON.stringify({ question: "Where from?" }));
  assert.throws(() => recordMusicDecision(projectDir, { route: "free-stock", answer: "  ", reason: "r" }), /own words/);
  const { target, decision } = recordMusicDecision(projectDir, {
    route: "silence",
    answer: "No music",
    reason: "Sound design carries it",
    now: NOW,
  });
  assert.equal(decision.delivery, "none");
  assert.equal(decision.askedUser.question, "Where from?");
  assert.ok(MusicDecisionSchema.safeParse(JSON.parse(readFileSync(target, "utf8"))).success);
  assert.throws(() =>
    recordMusicDecision(projectDir, { route: "trending-native", answer: "a", reason: "r", delivery: "embedded" }),
  );
});

// --- Delivery guard ---

test("the guard blocks each embedding the licence does not allow", () => {
  const embedded = { route: "free-stock", delivery: "embedded", candidateId: "c", credit: "credit" };
  const codes = (
    candidate?: Parameters<typeof musicRights>[1],
    decision: Parameters<typeof musicRights>[0] = embedded,
    options = {},
  ) =>
    musicRights(decision, candidate, options)
      .filter((item) => item.severity === "error")
      .map((item) => item.code);
  assert.deepEqual(
    codes({ id: "c", licence: { code: "CC BY 4.0", commercial: "yes", verifiedAt: NOW }, originalPath: "x" }),
    [],
  );
  assert.deepEqual(codes({ id: "c", licence: { code: "unknown", commercial: "unknown", verifiedAt: NOW } }), [
    "MUSIC_LICENCE_UNKNOWN",
  ]);
  assert.deepEqual(codes({ id: "c", licence: { code: "CC BY-NC 4.0", commercial: "no", verifiedAt: NOW } }), [
    "MUSIC_NON_COMMERCIAL",
  ]);
  assert.deepEqual(
    codes({ id: "c", licence: { code: "CC BY-NC 4.0", commercial: "no", verifiedAt: NOW } }, embedded, {
      commercialFilm: false,
    }),
    [],
  );
  assert.deepEqual(
    codes({ id: "c", syncAllowed: false, licence: { code: "CC BY-ND 4.0", commercial: "yes", verifiedAt: NOW } }),
    ["MUSIC_NO_DERIVATIVES"],
  );
  assert.deepEqual(codes({ id: "c", licence: { code: "CC BY 4.0", commercial: "yes" } }), ["MUSIC_LICENCE_UNVERIFIED"]);
  assert.deepEqual(codes(undefined), ["MUSIC_CANDIDATE_MISSING"]);
  assert.deepEqual(codes(undefined, { route: "trending-native", delivery: "embedded" }), ["MUSIC_TRENDING_EMBEDDED"]);
  assert.deepEqual(codes(undefined, { route: "trending-native", delivery: "native-on-platform" }), []);
  assert.deepEqual(codes(undefined, { route: "silence", delivery: "none" }), []);
  const reference = { route: "reference-track", delivery: "embedded", candidateId: "reference:r" };
  assert.ok(
    codes(
      {
        id: "reference:r",
        licence: { code: "reference-study-only", commercial: "no" },
        statedRights: { status: "study-only" },
      },
      reference,
    ).includes("MUSIC_REFERENCE_NO_RIGHTS"),
  );
  assert.deepEqual(codes(undefined, reference), ["MUSIC_REFERENCE_NO_RIGHTS"]);
  assert.deepEqual(
    codes(
      {
        id: "reference:r",
        syncAllowed: true,
        licence: { code: "reference-owned", commercial: "yes" },
        statedRights: { status: "owned" },
        originalPath: "x",
      },
      reference,
    ),
    [],
  );
  assert.deepEqual(codes(undefined, { route: "reference-track", delivery: "study-only" }), []);
});

test("the guard warns about what is allowed with conditions", () => {
  const codes = musicRights(
    { route: "free-stock", delivery: "embedded", candidateId: "c" },
    {
      id: "c",
      shareAlike: true,
      licence: { code: "CC BY-SA 4.0", commercial: "yes", attribution: "credit", verifiedAt: NOW },
    },
  ).map((item) => `${item.severity}:${item.code}`);
  assert.deepEqual(codes, [
    "warning:MUSIC_SHARE_ALIKE",
    "warning:MUSIC_ORIGINAL_MISSING",
    "warning:MUSIC_CREDIT_MISSING",
  ]);
});

test("the project entry point reads the decision and finds its candidate", (t) => {
  const { projectDir } = tempRoot(t);
  assert.deepEqual(checkProjectMusicRights(projectDir), []);
  assert.equal(checkProjectMusicRights(projectDir, { decisionRequired: true })[0]!.code, "MUSIC_DECISION_MISSING");
  writeSearch(projectDir, [hit({ id: "x:nc", licence: { code: "CC BY-NC 4.0", commercial: "no", verifiedAt: NOW } })]);
  writeFileSync(
    path.join(projectDir, MUSIC_PATHS.decision),
    JSON.stringify({ route: "free-stock", delivery: "embedded", candidateId: "x:nc" }),
  );
  assert.ok(checkProjectMusicRights(projectDir).some((item) => item.code === "MUSIC_NON_COMMERCIAL"));
  writeFileSync(path.join(projectDir, MUSIC_PATHS.decision), "not json");
  assert.equal(checkProjectMusicRights(projectDir)[0]!.code, "MUSIC_DECISION_INVALID");
});

// --- Reference track ---

test("a claim of rights needs the user's words; a study-only reference stays blocked", () => {
  const source = { status: "study-only" as const, durationSec: 10 };
  const study = referenceHit("ref", source, {}, NOW);
  assert.equal(study.statedRights!.status, "study-only");
  assert.equal(study.syncAllowed, false);
  assert.throws(() => referenceHit("ref", source, { rights: "owned" }, NOW), /rights-note/);
  const owned = referenceHit("ref", source, { rights: "owned", note: "I made this film" }, NOW);
  assert.equal(owned.licence.commercial, "yes");
  assert.equal(owned.statedRights!.statedBy, "user");
  assert.equal(
    referenceHit("ref", source, { rights: "licensed", note: "Licence bought" }, NOW).licence.commercial,
    "unknown",
  );
  assert.equal(referenceHit("ref", { status: "unknown", durationSec: 10 }, {}, NOW).licence.code, "unknown");
});

test("from-reference extracts the audio and reports embedding blocked", (t) => {
  const { root, projectDir } = tempRoot(t);
  const library = path.join(root, "library"),
    directory = path.join(library, "ref"),
    media = path.join(directory, "media/source.mp4");
  mkdirSync(path.dirname(media), { recursive: true });
  assert.equal(
    spawnSync("ffmpeg", [
      "-v",
      "error",
      "-nostdin",
      "-y",
      "-f",
      "lavfi",
      "-i",
      "color=c=black:s=64x64:d=1",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=1",
      "-shortest",
      "-pix_fmt",
      "yuv420p",
      media,
    ]).status,
    0,
  );
  const source = {
    schemaVersion: 1,
    referenceId: "ref",
    origin: { kind: "file", originalFilename: "source.mp4", acquiredAt: NOW },
    sha256: "a".repeat(64),
    mediaPath: "media/source.mp4",
    probe: { durationSec: 1, width: 64, height: 64, fps: 25, hasAudio: true },
    rights: { status: "unknown" },
  };
  writeFileSync(path.join(directory, "source.json"), JSON.stringify(source));
  const result = extractReferenceAudio(projectDir, "ref", library, {});
  assert.ok(existsSync(result.wav));
  assert.equal(result.delivery, "study-only");
  assert.equal(result.embeddingBlocked, true);
  writeFileSync(
    path.join(projectDir, MUSIC_PATHS.decision),
    JSON.stringify({ route: "reference-track", delivery: "embedded", candidateId: "reference:ref" }),
  );
  assert.ok(checkProjectMusicRights(projectDir).some((item) => item.code === "MUSIC_REFERENCE_NO_RIGHTS"));
  const stated = extractReferenceAudio(projectDir, "ref", library, { rights: "owned", note: "Our own film" });
  assert.equal(stated.embeddingBlocked, false);
  assert.ok(!checkProjectMusicRights(projectDir).some((item) => item.code === "MUSIC_REFERENCE_NO_RIGHTS"));
});

// --- Shortlist ---

test("the audio map adapter says it is not available until the script exists", (t) => {
  const { root } = tempRoot(t);
  const result = runAudioMap("in.mp3", "out.json", root);
  assert.equal(result.available, false);
  if (!result.available) assert.match(result.reason, /not available/);
});

test("a shortlist downloads previews, draws one sheet and tells the user to choose by ear", async (t) => {
  const { root, projectDir } = tempRoot(t);
  const audio = readFileSync(toneFile(path.join(root, "tone.wav"), 2));
  const stock = writeSearch(projectDir, [
    hit({ id: "ccmixter:9", title: "Manual only", acquisitionNote: "Download on the page." }),
    hit({ id: "freesound:1", provider: "freesound", previewUrl: "https://cdn.freesound.org/previews/1.mp3" }),
    hit({ id: "freesound:2", provider: "freesound", previewUrl: "https://cdn.freesound.org/previews/2.mp3" }),
    hit({ id: "freesound:3", provider: "freesound", previewUrl: "https://cdn.freesound.org/previews/3.mp3" }),
  ]);
  const trending = path.join(projectDir, MUSIC_PATHS.searchTrending);
  writeFileSync(
    trending,
    JSON.stringify(
      MusicSearchFileSchema.parse({
        schemaVersion: 1,
        kind: "trending",
        brief: "charts",
        candidates: [
          hit({
            id: "deezer:5",
            route: "trending-native",
            provider: "deezer",
            previewUrl: "https://cdnt-preview.dzcdn.net/old.mp3",
            licence: { code: "platform-native-only", commercial: "no" },
            acquisition: "native-platform",
            syncAllowed: false,
          }),
        ],
      }),
    ),
  );
  let staleTried = false;
  const http = new MusicHttp({
    fetch: mockFetch([
      [/freesound\.org\/previews/, () => new Response(audio)],
      [
        /dzcdn\.net\/old/,
        () => {
          staleTried = true;
          return new Response("gone", { status: 403 });
        },
      ],
      [/api\.deezer\.com\/track\/5/, () => json({ preview: "https://cdnt-preview.dzcdn.net/fresh.mp3" })],
      [/dzcdn\.net\/fresh/, () => new Response(audio)],
    ]),
    now: () => NOW,
  });
  const result = await buildShortlist(http, projectDir, {
    from: [stock, trending],
    top: 2,
    brief: "Calm founder film",
    repositoryRoot: root,
  });
  assert.ok(staleTried, "a stale signed link is resolved again");
  assert.deepEqual(
    result.shortlist.candidates.map((row) => row.id),
    ["freesound:1", "freesound:2", "deezer:5"],
  );
  assert.equal(result.skipped[0]!.id, "ccmixter:9");
  assert.ok(result.skipped[0]!.listenAt);
  assert.match(result.notice, /Agents cannot hear/);
  assert.match(result.notice, /not TikTok/);
  assert.ok(MusicShortlistSchema.safeParse(JSON.parse(readFileSync(result.target, "utf8"))).success);
  assert.ok(existsSync(result.contactSheet!));
  for (const row of result.listen) assert.ok(existsSync(row.file), row.file);
  assert.ok(result.audioMaps.every((row) => /not available/.test(row.status)));
});

test("a shortlist rerun keeps generated and user-supplied entries, and replaces old search rows", async (t) => {
  const { root, projectDir } = tempRoot(t);
  const audio = readFileSync(toneFile(path.join(root, "tone.wav"), 2));
  const generated = {
    id: "generated:take-1",
    route: "generated" as const,
    provider: "fal",
    title: "Take 1",
    previewPath: "music/take-1.mp3",
    licence: { code: "fal-terms", commercial: "unknown" as const },
  };
  const own = {
    id: "user:track",
    route: "user-supplied" as const,
    provider: "user",
    title: "Own track",
    licence: { code: "owned", commercial: "yes" as const },
  };
  const oldStock = {
    id: "freesound:old",
    route: "free-stock" as const,
    provider: "freesound",
    title: "Old",
    licence: { code: "CC0 1.0", commercial: "yes" as const },
  };
  writeFileSync(
    path.join(projectDir, MUSIC_PATHS.shortlist),
    JSON.stringify({ schemaVersion: 1, brief: "before", candidates: [oldStock, generated, own] }),
  );
  writeFileSync(
    path.join(projectDir, MUSIC_PATHS.shortlistFit),
    JSON.stringify({
      schemaVersion: 1,
      brief: "before",
      candidates: [
        { id: "generated:take-1", fit: { analysed: true, score: 0 } },
        { id: "freesound:old", fit: { analysed: true, score: 1 } },
      ],
    }),
  );
  const stock = writeSearch(projectDir, [
    hit({
      id: "freesound:1",
      provider: "freesound",
      previewUrl: "https://cdn.freesound.org/previews/1.mp3",
      fit: { analysed: false, bpm: { source: "none" }, energy: [], loop: false, score: 2, notes: [] },
    }),
  ]);
  const http = new MusicHttp({
    fetch: mockFetch([[/freesound\.org\/previews/, () => new Response(audio)]]),
    now: () => NOW,
  });
  const result = await buildShortlist(http, projectDir, { from: [stock], top: 1, repositoryRoot: root });
  assert.deepEqual(
    result.shortlist.candidates.map((row) => row.id),
    ["freesound:1", "generated:take-1", "user:track"],
  );
  assert.deepEqual(result.kept, ["generated:take-1", "user:track"]);
  const fits = JSON.parse(readFileSync(path.join(projectDir, MUSIC_PATHS.shortlistFit), "utf8")).candidates.map(
    (row: { id: string }) => row.id,
  );
  assert.deepEqual(fits, ["freesound:1", "generated:take-1"]);
});

test("a download that is not audio is skipped, not listed", async (t) => {
  const { root, projectDir } = tempRoot(t);
  const stock = writeSearch(projectDir, [
    hit({ id: "freesound:1", provider: "freesound", previewUrl: "https://cdn.freesound.org/previews/1.mp3" }),
  ]);
  const http = new MusicHttp({
    fetch: mockFetch([[/previews/, () => new Response("<html>not audio</html>")]]),
    now: () => NOW,
  });
  const result = await buildShortlist(http, projectDir, { from: [stock], top: 3, repositoryRoot: root });
  assert.equal(result.shortlist.candidates.length, 0);
  assert.match(result.skipped[0]!.reason, /not readable audio/);
});

// --- Acquire ---

const archiveRow = (over: Partial<MusicHit> = {}) =>
  hit({
    id: "internet-archive:item:a.mp3",
    provider: "internet-archive",
    sourceUrl: "https://archive.org/details/item",
    originalUrl: "https://ia1.us.archive.org/0/items/item/a.mp3",
    previewUrl: "https://ia1.us.archive.org/0/items/item/a.mp3",
    acquisition: "direct",
    licence: { code: "CC BY 4.0", commercial: "yes", verifiedAt: NOW },
    ...over,
  });

test("acquire re-reads the licence, imports the original and writes the credit", async (t) => {
  const { root, projectDir } = tempRoot(t);
  const audio = readFileSync(toneFile(path.join(root, "tone.wav")));
  writeSearch(projectDir, [archiveRow()]);
  const calls: string[] = [];
  const http = new MusicHttp({
    fetch: mockFetch(
      [
        [
          /archive\.org\/metadata\/item\/metadata/,
          () => json({ result: { licenseurl: "https://creativecommons.org/licenses/by/4.0/" } }),
        ],
        [/ia1\.us\.archive\.org/, () => new Response(audio)],
      ],
      calls,
    ),
    now: () => NOW,
  });
  const result = await acquireMusic({
    projectId: "demo",
    rootDir: root,
    candidateId: "internet-archive:item:a.mp3",
    commercial: true,
    http,
    credentials: {},
  });
  assert.ok(calls[0]!.includes("/metadata/"), "the licence is read before the file");
  assert.ok(existsSync(path.join(projectDir, result.originalPath)));
  assert.ok(existsSync(result.receiptPath));
  const credits = JSON.parse(readFileSync(result.credits, "utf8"));
  assert.match(credits.credits[0].text, /Artist/);
  assert.equal(
    JSON.parse(readFileSync(path.join(projectDir, "pipeline/asset-registry.json"), "utf8")).assets[0].rights.licence,
    "CC BY 4.0",
  );
  const stored = MusicSearchFileSchema.parse(
    JSON.parse(readFileSync(path.join(projectDir, MUSIC_PATHS.searchFreeStock), "utf8")),
  ).candidates[0]!;
  assert.equal(stored.originalPath, result.originalPath);
});

test("acquire stops when the source's licence changed or forbids the use", async (t) => {
  const { projectDir, root } = tempRoot(t);
  writeSearch(projectDir, [archiveRow()]);
  const answering = (licenseurl: string | undefined) =>
    new MusicHttp({ fetch: mockFetch([[/metadata/, () => json({ result: { licenseurl } })]]), now: () => NOW });
  const common = {
    projectId: "demo",
    rootDir: root,
    candidateId: "internet-archive:item:a.mp3",
    commercial: true,
    credentials: {},
  };
  await assert.rejects(
    acquireMusic({ ...common, http: answering("https://creativecommons.org/licenses/by-nc/4.0/") }),
    /Licence changed/,
  );
  await assert.rejects(acquireMusic({ ...common, http: answering(undefined) }), /Licence changed/);
  writeSearch(projectDir, [archiveRow({ licence: { code: "CC BY-NC 4.0", commercial: "no", verifiedAt: NOW } })]);
  await assert.rejects(
    acquireMusic({ ...common, http: answering("https://creativecommons.org/licenses/by-nc/4.0/") }),
    /blocked/,
  );
  writeSearch(projectDir, [
    archiveRow({ licence: { code: "CC BY-ND 4.0", commercial: "yes", verifiedAt: NOW }, syncAllowed: false }),
  ]);
  await assert.rejects(
    acquireMusic({ ...common, http: answering("https://creativecommons.org/licenses/by-nd/4.0/") }),
    /blocked/,
  );
  writeSearch(projectDir, [
    archiveRow({ licence: { code: "CC BY-SA 4.0", commercial: "yes", verifiedAt: NOW }, shareAlike: true }),
  ]);
  await assert.rejects(
    acquireMusic({ ...common, http: answering("https://creativecommons.org/licenses/by-sa/4.0/") }),
    /ShareAlike/,
  );
});

test("acquire refuses trending, unconfirmed aggregator rows and files it cannot fetch", async (t) => {
  const { projectDir, root } = tempRoot(t);
  const http = new MusicHttp({ fetch: mockFetch([]), now: () => NOW });
  const common = { projectId: "demo", rootDir: root, commercial: true, http, credentials: {} };
  await assert.rejects(acquireMusic({ ...common, candidateId: "nope" }), /search/);
  writeSearch(projectDir, [
    hit({ id: "deezer:1", route: "trending-native", provider: "deezer" }),
    hit({
      id: "openverse:1",
      provider: "openverse",
      origin: "jamendo",
      sourceUrl: "https://www.jamendo.com/track/5",
      originalUrl: "https://prod-1.storage.jamendo.com/?trackid=5",
      sourceVerified: false,
      licence: { code: "CC BY 3.0", commercial: "yes" },
    }),
    hit({
      id: "openverse:2",
      provider: "openverse",
      origin: "wikimedia_audio",
      sourceUrl: "https://commons.wikimedia.org/x",
      sourceVerified: false,
      licence: { code: "CC BY 3.0", commercial: "yes" },
    }),
  ]);
  await assert.rejects(acquireMusic({ ...common, candidateId: "deezer:1" }), /never acquired/);
  await assert.rejects(acquireMusic({ ...common, candidateId: "openverse:1" }), /JAMENDO_CLIENT_ID/);
  await assert.rejects(acquireMusic({ ...common, candidateId: "openverse:2" }), /confirm-licence-url/);
  await assert.rejects(
    acquireMusic({ ...common, candidateId: "openverse:2", confirmLicenceUrl: "https://example.com/terms" }),
    /not a licence/,
  );
  await assert.rejects(
    acquireMusic({
      ...common,
      candidateId: "openverse:2",
      confirmLicenceUrl: "https://creativecommons.org/licenses/by/3.0/",
    }),
    /No automatic download/,
  );
});

// --- HTTP ---

test("one redirect is followed to a listed host without credentials; others are refused", async () => {
  const seen: { url: string; authorization: string | null }[] = [];
  const request = (location: string) =>
    (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      seen.push({ url, authorization: new Headers(init?.headers).get("authorization") });
      return url.startsWith("https://archive.org/")
        ? new Response(null, { status: 302, headers: { location } })
        : new Response("bytes");
    }) as typeof fetch;
  const good = new MusicHttp({ fetch: request("https://ia1.us.archive.org/file.mp3") });
  assert.equal(
    (await good.bytes("https://archive.org/download/x", { headers: { Authorization: "Token t" } })).toString(),
    "bytes",
  );
  assert.equal(seen[0]!.authorization, "Token t");
  assert.equal(seen[1]!.authorization, null);
  await assert.rejects(
    new MusicHttp({ fetch: request("https://example.com/file.mp3") }).bytes("https://archive.org/download/x"),
    /unlisted host/,
  );
  await assert.rejects(new MusicHttp({ fetch: request("") }).bytes("https://localhost/x"), /allowlist/);
});
