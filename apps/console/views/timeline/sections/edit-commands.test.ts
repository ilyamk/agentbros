/** RU-T05–T10, RU-P01–P06, RU-AU01–04 builders: same inputs, defaults and refusals as review:ui's client. */
import { describe, expect, it } from "vitest";
import {
  currentClip,
  defaultFields,
  defaultSplitPoint,
  EditInputError,
  groupCandidates,
  groupMoveRequest,
  isSpecialized,
  OPERATIONS,
  prepareRequest,
  reframeSignature,
  structuredCommand,
  toggleGroupMember,
  unsupportedReason,
  type ClipRef,
  type FieldValues,
} from "./edit-commands";
import { clip, editState } from "./edit-fixture";

const state = editState();
const hook: ClipRef = { trackId: "visual", clipId: "hook" };
const proof: ClipRef = { trackId: "visual", clipId: "proof" };
const bed: ClipRef = { trackId: "music", clipId: "bed" };
const refusal = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    return error instanceof EditInputError ? `${error.group}.${error.key}` : String(error);
  }
  return "no refusal";
};
const defaults = (op: (typeof OPERATIONS)[number], ref: ClipRef): FieldValues => {
  const { track, clip } = currentClip(state, ref);
  return defaultFields(op, state, track, clip);
};

describe("operations (RU-T04)", () => {
  it("offers review:ui's 15 operations in its order", () => {
    expect(OPERATIONS).toEqual([
      "move",
      "authored-copy",
      "visual-reframe",
      "visual-remove",
      "visual-slip",
      "visual-split",
      "transfer",
      "trim",
      "rate",
      "transition",
      "captions",
      "audio-position",
      "audio-trim",
      "audio-gain",
      "audio-loop",
    ]);
    expect(OPERATIONS.filter(isSpecialized)).toEqual([
      "authored-copy",
      "visual-reframe",
      "visual-remove",
      "visual-slip",
      "visual-split",
      "audio-position",
      "audio-trim",
    ]);
  });

  it("refuses without a selection or once the clip is gone", () => {
    expect(refusal(() => structuredCommand("move", state, undefined, {}))).toBe("error.selectClip");
    expect(refusal(() => structuredCommand("move", state, { trackId: "visual", clipId: "gone" }, {}))).toBe(
      "error.clipGone",
    );
  });

  it("names the track restrictions the old page showed as notices", () => {
    const { track: voice, clip: speech } = currentClip(state, { trackId: "voice", clipId: "speech" });
    expect(unsupportedReason("visual-remove", voice, speech)).toBe("visualRemove");
    expect(unsupportedReason("visual-slip", voice, speech)).toBe("visualSlip");
    expect(unsupportedReason("visual-split", voice, speech)).toBe("visualSplit");
    expect(unsupportedReason("transfer", voice, speech)).toBe("transfer");
    expect(unsupportedReason("audio-position", voice, speech)).toBe("audioPosition");
    expect(unsupportedReason("audio-gain", voice, speech)).toBe("audioMix");
    const { track, clip: hookClip } = currentClip(state, hook);
    expect(unsupportedReason("captions", track, hookClip)).toBe("noCaptions");
    expect(unsupportedReason("move", voice, speech)).toBeUndefined();
  });
});

describe("generic commands (RU-T05–T10, RU-AU03/04)", () => {
  it("move: integer output start, prefilled from the clip (RU-T05)", () => {
    expect(defaults("move", proof)).toEqual({ "edit-start": "60" });
    expect(structuredCommand("move", state, proof, { "edit-start": "45" })).toEqual({
      type: "move",
      trackId: "visual",
      clipId: "proof",
      start: { num: 45, den: 1 },
    });
    expect(refusal(() => structuredCommand("move", state, proof, { "edit-start": "4.5" }))).toBe("error.integers");
  });

  it("trim, rate and transition (RU-T06–T08)", () => {
    expect(defaults("trim", proof)).toEqual({ "edit-start": "0", "edit-end": "30" });
    expect(structuredCommand("trim", state, proof, { "edit-start": "2", "edit-end": "28" })).toMatchObject({
      type: "trim",
      start: { num: 2, den: 1 },
      end: { num: 28, den: 1 },
    });
    expect(structuredCommand("rate", state, proof, { "rate-num": "3", "rate-den": "2" })).toMatchObject({
      rate: { num: 3, den: 2 },
    });
    expect(structuredCommand("transition", state, proof, { "fade-frames": "0" })).toMatchObject({
      transition: { kind: "cut" },
    });
    expect(structuredCommand("transition", state, proof, { "fade-frames": "12" })).toMatchObject({
      transition: { kind: "fade", duration: { num: 12, den: 1 } },
    });
    const faded = editState(3, {
      tracks: [
        {
          id: "visual",
          kind: "visual",
          clips: [clip("x", 0, 30, { transition: { kind: "fade", duration: { num: 8, den: 1 } } })],
        },
      ],
    });
    const { track, clip: x } = currentClip(faded, { trackId: "visual", clipId: "x" });
    expect(defaultFields("transition", faded, track, x)).toEqual({ "fade-frames": "8" });
  });

  it("captions change text only and keep every timing (RU-T09)", () => {
    expect(defaults("captions", proof)).toEqual({ "caption-0": "First line" });
    expect(structuredCommand("captions", state, proof, { "caption-0": "New line" })).toEqual({
      type: "captions",
      trackId: "visual",
      clipId: "proof",
      captions: [{ start: { num: 60, den: 1 }, end: { num: 75, den: 1 }, text: "New line" }],
    });
    expect(refusal(() => structuredCommand("captions", state, hook, {}))).toBe("error.noCaptions");
  });

  it("transfer lists the other visual tracks and keeps rational start (RU-T10)", () => {
    expect(defaults("transfer", hook)).toEqual({ "target-track": "broll", "transfer-num": "0", "transfer-den": "1" });
    expect(
      structuredCommand("transfer", state, hook, {
        "target-track": "broll",
        "transfer-num": "61",
        "transfer-den": "2",
      }),
    ).toEqual({
      type: "transfer",
      trackId: "visual",
      clipId: "hook",
      targetTrackId: "broll",
      start: { num: 61, den: 2 },
    });
    expect(refusal(() => structuredCommand("transfer", state, hook, { "target-track": "" }))).toBe("error.targetTrack");
    expect(refusal(() => structuredCommand("transfer", state, { trackId: "host", clipId: "talk" }, {}))).toBe(
      "unsupported.transfer",
    );
  });

  it("audio gain: blank resets to null, 0–1 only; loop default/on/off (RU-AU03/04)", () => {
    expect(defaults("audio-gain", bed)).toEqual({ "audio-gain": "0" });
    expect(structuredCommand("audio-gain", state, bed, { "audio-gain": "" })).toMatchObject({ gain: null });
    expect(structuredCommand("audio-gain", state, bed, { "audio-gain": "0.25" })).toMatchObject({ gain: 0.25 });
    expect(refusal(() => structuredCommand("audio-gain", state, bed, { "audio-gain": "1.5" }))).toBe("error.gainRange");
    expect(structuredCommand("audio-loop", state, bed, { "audio-loop": "" })).toMatchObject({ loop: null });
    expect(structuredCommand("audio-loop", state, bed, { "audio-loop": "true" })).toMatchObject({ loop: true });
    expect(structuredCommand("audio-loop", state, bed, { "audio-loop": "false" })).toMatchObject({ loop: false });
    expect(refusal(() => structuredCommand("audio-gain", state, hook, {}))).toBe("unsupported.audioMix");
  });
});

describe("prepared proposals (RU-P01–P05, RU-AU01/02)", () => {
  const result = { revision: 3, timelineHash: "b".repeat(64), snapshot: { durationInFrames: 120 } };

  it("authored copy: scene.hook target, keep/set/remove, both-keep reaches the server (RU-P01)", () => {
    expect(defaults("authored-copy", hook)).toEqual({
      "copy-headline-mode": "keep",
      "copy-headline": "Ship faster",
      "copy-subtext-mode": "keep",
      "copy-subtext": "Today",
    });
    const keep = prepareRequest("authored-copy", state, hook, defaults("authored-copy", hook));
    expect(keep.route).toBe("authored-copy-proposal");
    expect(keep.body).toEqual({ expectedRevision: 3, trackId: "visual", clipId: "hook", target: "scene.hook" });
    const set = prepareRequest("authored-copy", state, hook, {
      "copy-headline-mode": "set",
      "copy-headline": "Ship today",
      "copy-subtext-mode": "remove",
      "copy-subtext": "ignored",
    });
    expect(set.body).toMatchObject({ headline: "Ship today", subtext: null });
    expect(set.display(result)).toEqual({
      revision: 3,
      proposedHash: "b".repeat(64),
      durationInFrames: 120,
      authoredCopy: true,
      freshRenderRequired: true,
    });
    expect(prepareRequest("authored-copy", state, proof, defaults("authored-copy", proof)).body.target).toBe("legacy");
  });

  it("reframe: required 0–1 coordinates or a reset, a four-control signature (RU-P02)", () => {
    const values = defaults("visual-reframe", hook);
    expect(values).toEqual({
      "reframe-format": "vertical",
      "reframe-x": "0.5",
      "reframe-y": "0.5",
      "reframe-reset": false,
    });
    const request = prepareRequest("visual-reframe", state, hook, { ...values, "reframe-x": "0.2" });
    expect(request.body).toEqual({
      expectedRevision: 3,
      trackId: "visual",
      clipId: "hook",
      format: "vertical",
      position: { x: 0.2, y: 0.5 },
    });
    expect(request.signature).toBe(reframeSignature({ ...values, "reframe-x": "0.2" }));
    expect(request.signature).not.toBe(reframeSignature(values));
    expect(request.display({ ...result, originalSha256: "c".repeat(64) })).toEqual({
      revision: 3,
      proposedHash: "b".repeat(64),
      format: "vertical",
      position: { x: 0.2, y: 0.5 },
      originalSha256: "c".repeat(64),
    });
    expect(
      prepareRequest("visual-reframe", state, hook, { ...values, "reframe-reset": true }).body.position,
    ).toBeNull();
    expect(refusal(() => prepareRequest("visual-reframe", state, hook, { ...values, "reframe-y": "" }))).toBe(
      "error.reframeRequired",
    );
    expect(refusal(() => prepareRequest("visual-reframe", state, hook, { ...values, "reframe-y": "1.1" }))).toBe(
      "error.reframeRange",
    );
  });

  it("remove, slip and split on visual tracks only (RU-P03–P05)", () => {
    expect(prepareRequest("visual-remove", state, hook, {}).display(result)).toMatchObject({
      visualRemove: true,
      gapRetained: true,
    });
    const slip = prepareRequest("visual-slip", state, proof, { "slip-num": "-2", "slip-den": "1" });
    expect(slip.body).toMatchObject({ delta: { num: -2, den: 1 } });
    expect(
      slip.display({ ...result, command: { source: { start: { num: 2, den: 1 } } }, physical: { decodedFrames: 90 } }),
    ).toMatchObject({
      sourceSlip: true,
      oldSource: currentClip(state, proof).clip.source,
      physical: { decodedFrames: 90 },
    });
    const split = prepareRequest("visual-split", state, proof, defaults("visual-split", proof));
    expect(split.body).toEqual({
      expectedRevision: 3,
      trackId: "visual",
      clipId: "proof",
      at: { num: 75, den: 1 },
      newClipId: "proof-right",
    });
    expect(
      refusal(() => prepareRequest("visual-split", state, proof, { "split-at-num": "7.5", "split-at-den": "1" })),
    ).toBe("error.splitIntegers");
    expect(refusal(() => prepareRequest("visual-remove", state, { trackId: "voice", clipId: "speech" }, {}))).toBe(
      "unsupported.visualRemove",
    );
  });

  it("the split cut defaults inside the clip, not at its start (parity plan defect 2)", () => {
    expect(defaultSplitPoint(clip("a", 60, 90))).toEqual({ num: 75, den: 1 });
    expect(defaultSplitPoint(clip("b", 10, 12))).toEqual({ num: 11, den: 1 });
    expect(defaultSplitPoint({ ...clip("c", 0, 0), start: { num: 1, den: 2 }, end: { num: 3, den: 2 } })).toEqual({
      num: 1,
      den: 1,
    });
  });

  it("audio position and inward trim: exact rationals on music/SFX (RU-AU01/02)", () => {
    expect(defaults("audio-position", bed)).toEqual({ "audio-position-num": "0", "audio-position-den": "1" });
    expect(
      prepareRequest("audio-position", state, bed, { "audio-position-num": "15", "audio-position-den": "2" }).body,
    ).toEqual({
      expectedRevision: 3,
      trackId: "music",
      clipId: "bed",
      mode: "move",
      start: { num: 15, den: 2 },
    });
    const trim = prepareRequest("audio-trim", state, bed, defaults("audio-trim", bed));
    expect(trim.route).toBe("audio-position-proposal");
    expect(trim.body).toMatchObject({
      mode: "trim",
      sourceStart: { num: 0, den: 1 },
      sourceEnd: { num: 4800, den: 1 },
    });
    expect(trim.display(result)).toMatchObject({ audioPosition: true });
    expect(refusal(() => prepareRequest("audio-position", state, bed, { "audio-position-num": "x" }))).toBe(
      "error.audioIntegers",
    );
    expect(refusal(() => prepareRequest("audio-position", state, hook, {}))).toBe("unsupported.audioPosition");
  });
});

describe("visual group (RU-P06)", () => {
  it("lists visual clips only and refuses a 25th member", () => {
    expect(groupCandidates(state)).toEqual([hook, proof, { trackId: "broll", clipId: "cut" }]);
    const full = Array.from({ length: 24 }, (_, i) => ({ trackId: "visual", clipId: `c${i}` }));
    expect(refusal(() => toggleGroupMember(full, { trackId: "visual", clipId: "c24" }, true))).toBe("error.groupMax");
    expect(toggleGroupMember(full, { trackId: "visual", clipId: "c3" }, false)).toHaveLength(23);
    expect(toggleGroupMember([hook], hook, true)).toEqual([hook]);
  });

  it("needs 2–24 members and a safe integer delta", () => {
    expect(refusal(() => groupMoveRequest([hook], "30", "1", 3))).toBe("error.groupRange");
    expect(refusal(() => groupMoveRequest([hook, proof], "3.5", "1", 3))).toBe("error.groupDelta");
    const { body, signature } = groupMoveRequest([hook, proof], "30", "1", 3);
    expect(body).toEqual({ expectedRevision: 3, members: [hook, proof], delta: { num: 30, den: 1 } });
    expect(signature).toBe(JSON.stringify([hook, proof]));
  });
});
