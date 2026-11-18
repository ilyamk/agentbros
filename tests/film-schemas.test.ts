import test from "node:test";
import assert from "node:assert/strict";
import { MusicDecisionSchema } from "../src/types/film";

const decision = { schemaVersion: 1, askedUser: { question: "q", answer: "a", at: "2026-11-04" }, reason: "r" };

test("a music decision keeps a trending track off the file and silence without delivery", () => {
  assert.equal(
    MusicDecisionSchema.safeParse({ ...decision, route: "trending-native", delivery: "native-on-platform" }).success,
    true,
  );
  assert.equal(
    MusicDecisionSchema.safeParse({ ...decision, route: "trending-native", delivery: "embedded" }).success,
    false,
  );
  assert.equal(MusicDecisionSchema.safeParse({ ...decision, route: "silence", delivery: "embedded" }).success, false);
});

test("a music decision records that the user was asked", () => {
  assert.equal(
    MusicDecisionSchema.safeParse({ schemaVersion: 1, route: "free-stock", delivery: "embedded", reason: "r" }).success,
    false,
  );
});
