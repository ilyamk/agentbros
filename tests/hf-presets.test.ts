import "./helpers/fal-no-network";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  loadHiggsfieldRestylePresets,
  parseHiggsfieldRestylePresets,
  syncHiggsfieldRestylePresets,
} from "../src/lib/models/hf-restyle-presets";
const fixtureFile = path.resolve("tests/fixtures/higgsfield/restyle-presets.json");
const fixture = JSON.parse(readFileSync(fixtureFile, "utf8"));

test("tracked presets contain fixture IDs/names and date, without preview URLs", () => {
  assert.deepEqual(loadHiggsfieldRestylePresets(), parseHiggsfieldRestylePresets(fixture.response, fixture.recordedAt));
  assert.equal(loadHiggsfieldRestylePresets().presets.length, 20);
  assert.ok(!JSON.stringify(loadHiggsfieldRestylePresets()).includes("preview"));
});
test("offline refresh and dry-run never need credentials", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "hf-presets-")),
    file = path.join(root, "presets.json");
  try {
    const result = await syncHiggsfieldRestylePresets({ fixtureFile, file });
    assert.deepEqual(result.written, [file]);
    assert.deepEqual(loadHiggsfieldRestylePresets(file), result.presets);
    const before = readFileSync(file, "utf8");
    const dry = await syncHiggsfieldRestylePresets({ fixtureFile, file, asOf: "2026-12-01", dryRun: true });
    assert.deepEqual(dry.written, []);
    assert.equal(readFileSync(file, "utf8"), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("credentialled refresh uses restylePresets with injected fetch; missing key skips", async () => {
  const calls: string[] = [];
  const fetcher: typeof fetch = async (url, init) => {
    calls.push(String(url));
    assert.equal(init?.method, "GET");
    assert.equal((init?.headers as Record<string, string>).Authorization, "Key offline:secret");
    return Response.json(fixture.response);
  };
  const result = await syncHiggsfieldRestylePresets({
    credentials: "offline:secret",
    fetch: fetcher,
    dryRun: true,
    asOf: fixture.recordedAt,
  });
  assert.deepEqual(result.presets, loadHiggsfieldRestylePresets());
  assert.deepEqual(calls, ["https://api.higgsfield.ai/models/higgsfield/genjutsu/restyle/v1.0/presets"]);
  assert.deepEqual(await syncHiggsfieldRestylePresets({ fetch: fetcher }), { written: [], skipped: true });
  assert.equal(calls.length, 1);
});
test("invalid, duplicate and empty preset responses are rejected", () => {
  for (const response of [
    {},
    { items: [] },
    { items: [{ id: "invalid", name: "Test" }] },
    { items: [fixture.response.items[0], fixture.response.items[0]] },
  ])
    assert.throws(() => parseHiggsfieldRestylePresets(response, fixture.recordedAt));
});
