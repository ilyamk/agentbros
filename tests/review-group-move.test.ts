import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ReviewService } from "../src/lib/review-ui/service";
import { startReviewServer } from "../src/lib/review-ui/server";
import { buildVisualGroupMove, ReviewGroupMoveSchema } from "../src/lib/review-ui/group-move";
import { applyEdit } from "../src/lib/timeline-ir/commands";
import { add, compare, sub } from "../src/lib/timeline-ir/rational";
import { groupFixture, groupRequest, groupClip, rational as r } from "./helpers/review-group-move";

test("adjacent visual group dry-run is readonly, final batch valid where individual move overlaps; one history exact undo/redo", () => {
  const f = groupFixture();
  try {
    const service = new ReviewService("demo", f.root),
      before = f.store.read(),
      bytes = readFileSync(f.store.file);
    assert.throws(
      () => applyEdit(before.timeline, { type: "move", trackId: "visual", clipId: "a", start: r(60) }),
      /Overlapping/,
    );
    const proposal = service.groupMoveProposal(groupRequest());
    assert.deepEqual(readFileSync(f.store.file), bytes);
    assert.equal(proposal.command.type, "batch");
    assert.deepEqual(
      proposal.snapshot.tracks[0].clips.slice(0, 2).map((c) => c.start),
      [r(60), r(90)],
    );
    service.mutate({ action: "edit", expectedRevision: 0, command: proposal.command });
    const after = f.store.read();
    assert.equal(after.revision, 1);
    assert.equal(after.undo.length, 1);
    assert.deepEqual(after.timeline.tracks.slice(1), before.timeline.tracks.slice(1));
    assert.deepEqual(
      after.timeline.tracks[0].clips.map((c) => ({
        ...c,
        start: before.timeline.tracks[0].clips.find((p) => p.id === c.id)!.start,
      })),
      before.timeline.tracks[0].clips,
    );
    assert.throws(
      () => service.mutate({ action: "edit", expectedRevision: 0, command: proposal.command }),
      /revision conflict/,
    );
    assert.deepEqual(f.store.read(), after);
    assert.deepEqual(f.store.undo(1).timeline, before.timeline);
    assert.deepEqual(f.store.redo(2).timeline, after.timeline);
  } finally {
    f.cleanup();
  }
});

test("cross-visual exact rational delta preserves heterogeneous source clocks/rates and relative spacing", () => {
  const f = groupFixture();
  try {
    const ir = f.store.read().timeline;
    ir.tracks[0].clips[0].source = { start: r(17), end: r(47), timebase: r(30000, 1001) };
    ir.tracks[0].clips[0].rate = r(3, 2);
    const request = {
      ...groupRequest(r(7, 3)),
      members: [
        { trackId: "overlay", clipId: "overlay-a" },
        { trackId: "visual", clipId: "a" },
      ],
    };
    const command = buildVisualGroupMove(ir, request),
      after = applyEdit(ir, command);
    for (const [index, id] of [
      [0, "a"],
      [1, "overlay-a"],
    ] as const) {
      const old = ir.tracks[index].clips.find((c) => c.id === id)!,
        changed = after.tracks[index].clips.find((c) => c.id === id)!;
      assert.deepEqual(changed.start, add(old.start, r(7, 3)));
      assert.deepEqual({ ...changed, start: old.start }, old);
    }
    assert.equal(
      compare(
        sub(after.tracks[0].clips[0].start, after.tracks[1].clips[0].start),
        sub(ir.tracks[0].clips[0].start, ir.tracks[1].clips[0].start),
      ),
      0,
    );
    assert.deepEqual(command, buildVisualGroupMove(ir, { ...request, members: [...request.members].reverse() }));
    assert.deepEqual(after.tracks.slice(2), ir.tracks.slice(2));
  } finally {
    f.cleanup();
  }
});

test("strict membership/clock/schema rejects injection, duplicates, missing/protected clips, overflow and zero without writes", () => {
  const f = groupFixture();
  try {
    const service = new ReviewService("demo", f.root),
      before = readFileSync(f.store.file),
      original = groupRequest();
    for (const bad of [
      { ...original, unexpected: true },
      { ...original, command: { type: "remove" } },
      { ...original, expectedRevision: -1 },
      { ...original, members: [original.members[0]] },
      { ...original, members: [original.members[0], original.members[0]] },
      { ...original, members: [{ trackId: "visual", clipId: "missing" }, original.members[0]] },
      ...["voiceover", "presenter", "music", "sfx", "captions"].map((trackId) => ({
        ...original,
        members: [original.members[0], { trackId, clipId: trackId }],
      })),
      { ...original, members: [{ ...original.members[0], source: {} }, original.members[1]] },
      ...[
        { num: 0, den: 1 },
        { num: 30, den: 0 },
        { num: 30, den: -1 },
        { num: 1.5, den: 1 },
        { num: Infinity, den: 1 },
        { num: Number.MAX_SAFE_INTEGER + 1, den: 1 },
        { num: 1, den: Number.MAX_SAFE_INTEGER },
        { num: 30, den: 1, seconds: 1 },
      ].map((delta) => ({ ...original, delta })),
    ]) {
      assert.throws(() => service.groupMoveProposal(bad));
      assert.deepEqual(readFileSync(f.store.file), before);
    }
    assert.equal(
      ReviewGroupMoveSchema.safeParse({
        ...original,
        members: Array.from({ length: 25 }, (_, i) => ({ trackId: "visual", clipId: String(i) })),
      }).success,
      false,
    );
    const ir = f.store.read().timeline;
    ir.tracks = [
      {
        id: "visual",
        kind: "visual",
        clips: [groupClip("a", Number.MAX_SAFE_INTEGER - 3, 1), groupClip("b", Number.MAX_SAFE_INTEGER - 1, 1)],
      },
    ];
    assert.throws(() => buildVisualGroupMove(ir, groupRequest(r(2))), /safe integer|timeline interval/);
  } finally {
    f.cleanup();
  }
});

test("range/final overlap/broken fade refuse atomically; signed left move and complete fade group remain supported", () => {
  const f = groupFixture();
  try {
    const service = new ReviewService("demo", f.root),
      before = readFileSync(f.store.file);
    for (const delta of [r(-31), r(211), r(90)]) assert.throws(() => service.groupMoveProposal(groupRequest(delta)));
    assert.deepEqual(readFileSync(f.store.file), before);
    const left = service.groupMoveProposal(groupRequest(r(-30)));
    assert.deepEqual(
      left.snapshot.tracks[0].clips.slice(0, 2).map((c) => c.start),
      [r(0), r(30)],
    );
    const ir = f.store.read().timeline;
    ir.tracks[0].clips[0].transition = { kind: "fade", duration: r(6) };
    assert.doesNotThrow(() => buildVisualGroupMove(ir, groupRequest()));
    assert.throws(
      () =>
        buildVisualGroupMove(ir, {
          ...groupRequest(r(-15)),
          members: [
            { trackId: "visual", clipId: "a" },
            { trackId: "overlay", clipId: "overlay-a" },
          ],
        }),
      /Invalid transition/,
    );
  } finally {
    f.cleanup();
  }
});

test("24 unique selected clips form one bounded batch without changing protected duration or originals", () => {
  const f = groupFixture();
  try {
    const ir = f.store.read().timeline;
    ir.tracks[0].clips = Array.from({ length: 24 }, (_, i) => groupClip("clip-" + i, i * 2, 1));
    const request = {
      expectedRevision: 0,
      members: ir.tracks[0].clips.map((c) => ({ trackId: "visual", clipId: c.id })),
      delta: r(1),
    };
    const command = buildVisualGroupMove(ir, request);
    assert.equal(command.type, "batch");
    if (command.type !== "batch") throw Error("Not batch");
    assert.equal(command.commands.length, 24);
    assert.deepEqual(applyEdit(ir, command).tracks.slice(1), ir.tracks.slice(1));
  } finally {
    f.cleanup();
  }
});

test("real authenticated HTTP group proposal retains CAS, readonly error/success, literal command and one explicit Apply", async () => {
  const f = groupFixture(),
    app = await startReviewServer({ projectId: "demo", rootDir: f.root });
  try {
    const headers = { "x-review-token": app.token, "content-type": "application/json", origin: app.origin };
    const post = (route: string, value: unknown, h = headers) =>
      fetch(app.origin + route, { method: "POST", headers: h, body: JSON.stringify(value) });
    const before = readFileSync(f.store.file),
      request = groupRequest();
    assert.equal((await post("/api/group-move-proposal", request, { ...headers, "x-review-token": "" })).status, 403);
    assert.equal(
      (await post("/api/group-move-proposal", request, { ...headers, origin: "http://foreign.invalid" })).status,
      403,
    );
    const noOrigin = { ...headers };
    delete (noOrigin as Partial<typeof headers>).origin;
    assert.equal((await post("/api/group-move-proposal", request, noOrigin)).status, 403);
    assert.equal((await post("/api/group-move-proposal", { ...request, secret: true })).status, 400);
    assert.equal((await post("/api/group-move-proposal", { ...request, expectedRevision: 1 })).status, 409);
    assert.deepEqual(readFileSync(f.store.file), before);
    const reply = await post("/api/group-move-proposal", request);
    assert.equal(reply.status, 200);
    const proposal = await reply.json();
    assert.deepEqual(readFileSync(f.store.file), before);
    const apply = await post("/api/mutate", {
      action: "edit",
      expectedRevision: proposal.revision,
      command: proposal.command,
    });
    assert.equal(apply.status, 200);
    assert.equal(f.store.read().undo.length, 1);
    assert.equal((await post("/api/group-move-proposal", request)).status, 409);
    assert.equal(
      (await post("/api/mutate", { action: "edit", expectedRevision: 0, command: proposal.command })).status,
      409,
    );
    assert.equal((await post("/api/mutate", { action: "undo", expectedRevision: 1 })).status, 200);
    assert.deepEqual(f.store.read().timeline, JSON.parse(before.toString()).timeline);
  } finally {
    await app.close();
    f.cleanup();
  }
});
