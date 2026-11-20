/**
 * Frame notes (2026-11-20): the console's `frame-note` decision on any route becomes one `frame:note` argv with the
 * marks and the overlay as attached files (the overlay as bytes, never in the inbox); a film's frame feedback with marks
 * runs it as a follow-up; the journal and `console:wait` hand the agent the note and the still; `writeFrameNote` takes
 * the frame from the video with ffmpeg and lays the user's overlay over it.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  DecisionRequestSchema,
  FrameCommentSchema,
  FrameNoteSchema,
  type CliEnvelope,
  type ConsoleEvent,
  type DecisionRequest,
  type FrameComment,
} from "../src/types/console";
import { createDecisionActions } from "../src/lib/console/apply";
import { readInbox } from "../src/lib/console/inbox";
import type { SpawnRequest } from "../src/lib/console/spawn";
// @ts-expect-error plain Node hook without types
import { decisionsSince, frameNoteFiles } from "../scripts/hooks/lib/state.mjs";
// @ts-expect-error plain Node hook without types
import { itemSentence } from "../scripts/hooks/lib/facts.mjs";
import { planUserInput } from "../src/lib/console/user-actions";
import { outcomeOf } from "../src/lib/console/wait";
import { boxFilters, clockMs, parseMarks, pngSize, writeFrameNote } from "../src/lib/feedback/frame-note";

const PROJECT = "demo-note";
const AT = "2026-11-20T10:00:00.000Z";
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
// a 1×1 transparent PNG
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGBgAAAABQABpfZFQAAAAABJRU5ErkJggg==",
  "base64",
);

const comment = (overrides: Partial<FrameComment> = {}): FrameComment => ({
  media: { path: "assets/clip.mp4", kind: "video", fps: 30, sha256: sha("clip"), label: "v3 — сферы" },
  frame: 12,
  marks: [
    { x: 0.1, y: 0.2, w: 0.3, h: 0.25, text: "логотип мелкий" },
    { x: 0.7, y: 0.6, text: "--answer шум" },
  ],
  text: "1. логотип мелкий\n2. --answer шум",
  ...overrides,
});

function harness(answer: (request: SpawnRequest, files: Record<string, Buffer>) => CliEnvelope) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "avc-frame-note-")));
  mkdirSync(path.join(root, "public/projects", PROJECT, "pipeline"), { recursive: true });
  const calls: { request: SpawnRequest; files: Record<string, Buffer> }[] = [];
  const actions = createDecisionActions(root, {
    deriveWaiting: async () => [],
    spawnCli: async (request) => {
      // attachments exist only while the command runs: read them now
      const files: Record<string, Buffer> = {};
      request.args.forEach((arg, index) => {
        if (arg.endsWith("-file")) files[arg] = readFileSync(request.args[index + 1]!);
      });
      calls.push({ request, files });
      return { envelope: answer(request, files), exitCode: 0 };
    },
    now: () => new Date(AT),
    routeOf: () => "unknown",
    stepExpects: () => undefined,
    env: { ...process.env, AGENTBROS_EVENTS: "on" },
  });
  return { root, calls, actions, done: () => rmSync(root, { recursive: true, force: true }) };
}

const STILL = `public/projects/${PROJECT}/pipeline/frame-notes/note-1.png`;
const NOTE = `public/projects/${PROJECT}/pipeline/frame-notes/note-1.json`;
const written: CliEnvelope = { ok: true, outputs: [STILL, NOTE], metadata: {}, elapsedMs: 5 };

test("frame note: one frame:note argv on any route, marks and overlay as files, the overlay never recorded", async (t) => {
  const h = harness(() => written);
  t.after(h.done);
  const request: DecisionRequest = {
    kind: "frame-note",
    requestId: "req-1",
    answer: comment().text,
    frameComments: [comment()],
    overlay: PNG.toString("base64"),
  };
  assert.equal(DecisionRequestSchema.safeParse(request).success, true);
  const reply = await h.actions.decide(PROJECT, request);
  assert.equal(reply.ok, true);
  const [call] = h.calls;
  assert.equal(call!.request.alias, "frame:note");
  const args = call!.request.args;
  assert.deepEqual(args.slice(0, 10), [
    "--project",
    PROJECT,
    "--media=assets/clip.mp4",
    "--frame",
    "12",
    "--fps",
    "30",
    "--expect",
    sha("clip"),
    "--answer=1. логотип мелкий\n2. --answer шум",
  ]);
  assert.deepEqual(JSON.parse(call!.files["--marks-file"]!.toString("utf8")), comment().marks);
  assert.ok(call!.files["--overlay-file"]!.equals(PNG), "the overlay arrives as the PNG's bytes");

  const stored = readInbox(h.root, PROJECT, reply.decision.id)!;
  assert.equal(stored.kind, "frame-note");
  assert.equal(stored.title, "Note on frame 12 of v3 — сферы");
  assert.deepEqual(stored.frameComments, [comment()]);
  assert.ok(!JSON.stringify(stored).includes(PNG.toString("base64")), "the inbox never keeps the overlay");

  // the journal carries the note and the still, and console:wait hands them to the agent
  const lines = readFileSync(path.join(h.root, "public/projects", PROJECT, "pipeline/events.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as ConsoleEvent);
  const applied = lines.find((event) => event.kind === "decision.applied")!;
  assert.deepEqual(outcomeOf(applied, PROJECT), {
    event: "decision.applied",
    eventId: applied.id,
    at: applied.at,
    answer: comment().text,
    decisionId: reply.decision.id,
    decisionKind: "frame-note",
    note: NOTE,
    still: STILL,
  });
});

test("frame note: an out/ render says so; no marks and no overlay attach nothing", () => {
  const plan = planUserInput(PROJECT, {
    kind: "frame-note",
    answer: "darker",
    frameComments: [
      comment({ media: { root: "out", path: "film.mp4", kind: "video" }, marks: undefined, text: "darker" }),
    ],
  });
  assert.deepEqual(plan.command.args, [
    "--project",
    PROJECT,
    "--media=film.mp4",
    "--root",
    "out",
    "--frame",
    "12",
    "--answer=darker",
  ]);
  assert.equal(plan.command.attachments, undefined);
  assert.equal(plan.followUps, undefined);
});

test("frame feedback with marks keeps reopening the build and draws the still as a follow-up", async (t) => {
  const h = harness((request) =>
    request.alias === "frame:note" ? written : { ok: true, outputs: [], metadata: {}, elapsedMs: 1 },
  );
  t.after(h.done);
  const reply = await h.actions.decide(PROJECT, {
    kind: "frame-feedback",
    answer: comment().text,
    frameComments: [comment()],
    overlay: PNG.toString("base64"),
  });
  assert.equal(reply.ok, true);
  assert.deepEqual(
    h.calls.map((call) => call.request.alias),
    ["feedback", "frame:note"],
  );
  assert.ok(h.calls[1]!.files["--overlay-file"]!.equals(PNG));
  // without marks or an overlay a frame feedback runs only feedback
  const plain = planUserInput(PROJECT, {
    kind: "frame-feedback",
    answer: "darker",
    frameComments: [comment({ marks: undefined, text: "darker" })],
  });
  assert.equal(plain.followUps, undefined);
});

test("contract: marks are points or boxes inside the frame, at most nine; only frame comments carry an overlay", () => {
  assert.equal(FrameCommentSchema.safeParse(comment()).success, true);
  const mark = { x: 0.5, y: 0.5, text: "x" };
  assert.equal(FrameCommentSchema.safeParse(comment({ marks: Array(10).fill(mark) })).success, false);
  assert.equal(FrameCommentSchema.safeParse(comment({ marks: [{ ...mark, w: 0.2 }] })).success, false, "w without h");
  assert.equal(
    FrameCommentSchema.safeParse(comment({ marks: [{ ...mark, w: 0.6, h: 0.1 }] })).success,
    false,
    "a box past the right edge",
  );
  assert.equal(FrameCommentSchema.safeParse(comment({ marks: [{ ...mark, text: "" }] })).success, false);
  assert.equal(
    DecisionRequestSchema.safeParse({ kind: "rating", answer: "4/5", ratings: { "a.png": 4 }, overlay: "AAAA" })
      .success,
    false,
  );
  assert.equal(
    DecisionRequestSchema.safeParse({
      kind: "frame-note",
      answer: "x",
      frameComments: [comment()],
      overlay: "not base64!",
    }).success,
    false,
  );
});

test("helpers: PNG size, marks file, box filters, clock", () => {
  assert.deepEqual(pngSize(PNG), { width: 1, height: 1 });
  assert.throws(() => pngSize(Buffer.from("GIF89a-not-a-png-at-all")), /not a PNG/);
  assert.deepEqual(parseMarks(JSON.stringify(comment().marks)), comment().marks);
  assert.throws(() => parseMarks("{"), /not JSON/);
  assert.throws(() => parseMarks(JSON.stringify([{ x: 2, y: 0, text: "x" }])), /Mark 1/);
  assert.deepEqual(boxFilters([{ x: 0.1, y: 0.2, w: 0.3, h: 0.4, text: "a" }]), [
    "drawbox=x=iw*0.1:y=ih*0.2:w=iw*0.3:h=ih*0.4:color=0xff3b30@1:t=4",
  ]);
  assert.equal(clockMs(16.1333), "00:16.133");
  assert.equal(clockMs(3725.5), "1:02:05.500");
});

const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0 && spawnSync("ffprobe", ["-version"]).status === 0;

test(
  "writeFrameNote: the frame from the file with the overlay over it, the note beside it",
  { skip: !hasFfmpeg },
  (t) => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), "avc-frame-note-real-")));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const projectDir = path.join(root, "public/projects", PROJECT);
    mkdirSync(path.join(projectDir, "assets"), { recursive: true });
    const video = path.join(projectDir, "assets/clip.mp4");
    const made = spawnSync("ffmpeg", [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc=size=320x180:rate=30:duration=1",
      "-pix_fmt",
      "yuv420p",
      video,
    ]);
    assert.equal(made.status, 0);
    const overlay = path.join(root, "overlay.png");
    writeFileSync(overlay, PNG);

    const result = writeFrameNote({
      rootDir: root,
      project: PROJECT,
      media: "assets/clip.mp4",
      root: "project",
      frame: 15,
      words: "логотип мелкий",
      marks: [{ x: 0.1, y: 0.1, w: 0.2, h: 0.2, text: "логотип мелкий" }],
      overlay,
      channel: "console",
      now: new Date(AT),
    });
    const record = FrameNoteSchema.parse(JSON.parse(readFileSync(path.join(root, result.note), "utf8")));
    assert.equal(record.frame, 15);
    assert.equal(record.time, "00:00.500");
    assert.equal(record.drawn, "overlay");
    assert.equal(record.channel, "console");
    assert.equal(path.join(root, "public/projects", PROJECT, record.still!), path.join(root, result.still!));
    assert.deepEqual(pngSize(readFileSync(path.join(root, result.still!))), { width: 320, height: 180 });

    // the still is the frame the console showed: a clip whose frame N has luma N×8 gives back 15×8 at frame 15
    const counted = path.join(projectDir, "assets/counted.mp4");
    assert.equal(
      spawnSync("ffmpeg", [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "nullsrc=s=32x32:r=30:d=1,geq=lum='N*8':cb=128:cr=128",
        "-c:v",
        "libx264",
        "-qp",
        "0",
        "-pix_fmt",
        "yuv444p",
        counted,
      ]).status,
      0,
    );
    for (const frame of [0, 15, 29]) {
      const still = writeFrameNote({
        rootDir: root,
        project: PROJECT,
        media: "assets/counted.mp4",
        root: "project",
        frame,
        words: "x",
      }).still!;
      const gray = spawnSync("ffmpeg", [
        "-v",
        "error",
        "-i",
        path.join(root, still),
        "-f",
        "rawvideo",
        "-pix_fmt",
        "gray",
        "-",
      ]);
      // limited-range luma comes back stretched to full range in the PNG
      const expected = Math.min(255, Math.max(0, ((frame * 8 - 16) * 255) / 219));
      assert.ok(
        Math.abs(gray.stdout[0]! - expected) <= 3,
        `frame ${frame}: luma ${gray.stdout[0]}, expected ${expected}`,
      );
    }

    // without an overlay the marks are drawn as boxes
    const boxes = writeFrameNote({
      rootDir: root,
      project: PROJECT,
      media: "assets/clip.mp4",
      root: "project",
      frame: 0,
      words: "x",
      marks: [{ x: 0.5, y: 0.5, text: "x" }],
    });
    assert.equal(boxes.record.drawn, "boxes");
    assert.ok(existsSync(path.join(root, boxes.still!)));

    const refusal = (input: Partial<Parameters<typeof writeFrameNote>[0]>) => {
      try {
        writeFrameNote({
          rootDir: root,
          project: PROJECT,
          media: "assets/clip.mp4",
          root: "project",
          frame: 0,
          words: "x",
          ...input,
        });
        return "ok";
      } catch (error) {
        return (error as { code?: string }).code;
      }
    };
    assert.equal(refusal({ frame: 30 }), "INVALID_INPUT", "past the last frame");
    assert.equal(refusal({ expect: sha("other") }), "VALIDATION", "the video changed since");
    assert.equal(refusal({ media: "../../../etc/passwd" }), "INVALID_INPUT", "outside the project");
    assert.equal(refusal({ media: "assets/none.mp4" }), "FILE_NOT_FOUND");
    assert.equal(refusal({ project: "missing" }), "PROJECT_NOT_FOUND");
  },
);

test("the relay and wake hooks name the marked still, from the command or a follow-up", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "frame-note-hook-"));
  try {
    const still = "public/projects/p/pipeline/frame-notes/note-a.png";
    const note = "public/projects/p/pipeline/frame-notes/note-a.json";
    assert.deepEqual(frameNoteFiles({ ok: true, outputs: [still, note] }), { still, note });
    assert.deepEqual(frameNoteFiles({ ok: true, metadata: { followUps: [{ ok: true, outputs: [still, note] }] } }), {
      still,
      note,
    });
    assert.deepEqual(frameNoteFiles({ ok: true, outputs: ["out/p/final.mp4"] }), {});
    mkdirSync(path.join(dir, "pipeline/inbox"), { recursive: true });
    writeFileSync(
      path.join(dir, "pipeline/inbox/d-note.json"),
      JSON.stringify({
        v: 1,
        id: "d-note",
        kind: "frame-note",
        title: "Note on frame 30 of clip.mp4",
        answer: "1. Тут текст налезает на лицо",
        status: "applied",
        decidedAt: new Date(Date.now() - 1000).toISOString(),
        result: { ok: true, outputs: [still, note] },
      }),
    );
    const [item] = decisionsSince(dir, Date.now() - 60_000);
    assert.equal(item.still, still);
    assert.match(
      itemSentence(item),
      /the frame with the user's marks: .*note-a\.png \(note .*note-a\.json\), read the image\.$/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
