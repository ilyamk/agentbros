import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { API_KEYS } from "../src/lib/doctor";
import { ENV_KEYS, SETUP_GOALS, envExampleKeys, goalStatuses, keyStatuses, parseGoals } from "../src/lib/setup/keys";
import { SPAWN_TIMEOUT_MS } from "./helpers/timeouts";

test("the key registry matches .env.example sections 1–5, including what is commented out", () => {
  const example = envExampleKeys(readFileSync(".env.example", "utf8"));
  assert.deepEqual(
    example.map((key) => key.name).sort(),
    ENV_KEYS.map((key) => key.name).sort(),
    "add or remove the key in both src/lib/setup/keys.ts and .env.example",
  );
  for (const key of ENV_KEYS)
    assert.equal(
      example.find((item) => item.name === key.name)?.commentedOut,
      !!key.commentedOut,
      `${key.name}: commentedOut disagrees with .env.example`,
    );
});

test("local settings below section 6 are not service keys", () => {
  const text = "# 1. Generation\nFAL_KEY=\n\n#  6. Local settings\n# AGENTBROS_UV=uv\nBLENDER_EXECUTABLE=\n";
  assert.deepEqual(envExampleKeys(text), [{ name: "FAL_KEY", commentedOut: false }]);
});

test("the doctor reports exactly the registry", () => {
  assert.deepEqual(
    API_KEYS.map((key) => key.name),
    ENV_KEYS.map((key) => key.name),
  );
});

test("every goal names registered keys and every key has a sign-up link", () => {
  const names = new Set(ENV_KEYS.map((key) => key.name));
  for (const goal of SETUP_GOALS) for (const name of goal.anyOf) assert.ok(names.has(name), `${goal.id}: ${name}`);
  for (const key of ENV_KEYS) assert.match(key.signup, /^https:\/\//, key.name);
  for (const key of ENV_KEYS)
    for (const other of key.pairedWith ?? []) assert.ok(names.has(other), `${key.name} pairs with ${other}`);
});

test("statuses report presence and shape, never values", () => {
  const secret = "s3cr3t-value-never-printed";
  const statuses = keyStatuses({
    FAL_KEY: secret,
    HIGGSFIELD_API_KEY: "no-colon",
    OPENVERSE_CLIENT_ID: "id-only",
    PEXELS_API_KEY: "  ",
  });
  const state = (name: string) => statuses.find((status) => status.name === name)?.state;
  assert.equal(state("FAL_KEY"), "set");
  assert.equal(state("HIGGSFIELD_API_KEY"), "malformed");
  assert.equal(state("OPENVERSE_CLIENT_ID"), "incomplete");
  assert.equal(state("PEXELS_API_KEY"), "unset");
  assert.ok(!JSON.stringify(statuses).includes(secret));
  assert.ok(!JSON.stringify(statuses).includes("no-colon"));
});

test("goals are ready through any one key and offer free options first", () => {
  const goals = goalStatuses(keyStatuses({ FAL_KEY: "x" }));
  const image = goals.find((goal) => goal.id === "image-generation")!;
  assert.equal(image.ready, true);
  assert.deepEqual(image.via, ["FAL_KEY"]);
  const sfx = goals.find((goal) => goal.id === "sfx")!;
  assert.equal(sfx.ready, false);
  assert.equal(sfx.options[0]?.cost, "free");
  assert.match(sfx.withoutKeys ?? "", /sfx:synth/);
  assert.deepEqual(
    goalStatuses(keyStatuses({}), ["voiceover"]).map((goal) => goal.id),
    ["voiceover"],
  );
});

test("unknown goals are refused with the known list", () => {
  assert.deepEqual(parseGoals("voiceover, music"), ["voiceover", "music"]);
  assert.deepEqual(parseGoals(undefined), []);
  assert.throws(() => parseGoals("voiceover,telepathy"), /telepathy.*Known: voiceover/);
});

test("pnpm keys emits one JSON line and never a value", () => {
  const secret = "s3cr3t-cli-value";
  const run = spawnSync(process.execPath, ["--import", "tsx", "scripts/keys.ts", "--goal", "voiceover"], {
    encoding: "utf8",
    timeout: SPAWN_TIMEOUT_MS,
    env: { ...process.env, AGENTBROS_NO_DOTENV: "1", ELEVENLABS_API_KEY: secret },
  });
  assert.equal(run.status, 0, run.stderr);
  const lines = run.stdout.trimEnd().split("\n");
  assert.equal(lines.length, 1);
  const envelope = JSON.parse(lines[0]!);
  assert.equal(envelope.ok, true);
  assert.equal(envelope.metadata.goals[0].ready, true);
  assert.ok(!run.stdout.includes(secret) && !run.stderr.includes(secret));
});
