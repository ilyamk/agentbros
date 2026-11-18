import assert from "node:assert/strict";
import { chmodSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { consoleActionsWith } from "../src/lib/console/apply";
import { notImplementedActions } from "../src/lib/console/data";
import { scaffoldFilmProject } from "../src/lib/film/project";
import { approveStep, openFilmProject, sealStep, stepState } from "../src/lib/film/state";
import { makeRoot, postHeaders, raw, removeRoot, startTestServer } from "./helpers/console-server";
import { writeStrategy } from "./helpers/film-studio";

test("console document reads and writes are scoped, versioned and leave strategy awaiting approval", async (t) => {
  const root = makeRoot();
  const id = "document-film";
  const directory = path.join(root, "public/projects", id);
  const project = () => openFilmProject(directory, { rootDir: root });
  scaffoldFilmProject(directory, id, []);
  const pipeline = path.join(directory, "pipeline");
  const place = (file: string) =>
    writeFileSync(path.join(pipeline, file), readFileSync(path.join(import.meta.dirname, "fixtures/film-chain", file)));
  place("brief.json");
  sealStep(project(), "intake");
  approveStep(project(), "intake", "Approved intake for the document test");
  place("product-truth.json");
  sealStep(project(), "truth");
  place("film-targets.json");
  sealStep(project(), "reference");
  writeStrategy(directory);
  sealStep(project(), "strategy");
  const server = await startTestServer(root, {
    actions: consoleActionsWith(root, notImplementedActions, { deriveWaiting: async () => [] }),
  });
  t.after(async () => {
    await server.close();
    removeRoot(root);
  });

  const api = `/api/projects/${id}/document`;
  const auth = { "x-console-token": server.token };
  const get = (file: string, headers = auth) =>
    raw(server.port, { path: `${api}?path=${encodeURIComponent(file)}`, headers });
  const post = (body: object, headers: Record<string, string> = postHeaders(server)) =>
    raw(server.port, { method: "POST", path: api, headers, body: JSON.stringify(body) });
  const jsonPath = "pipeline/strategy.json";
  const markdownPath = "pipeline/strategy.md";
  const jsonFile = path.join(directory, jsonPath);
  chmodSync(jsonFile, 0o600);
  assert.equal((await get(jsonPath, {} as typeof auth)).status, 403);
  assert.equal((await get("pipeline/brief.json")).status, 403);
  assert.equal((await get("../strategy.md")).status, 400);
  assert.equal((await raw(server.port, { path: `/media/${id}/${jsonPath}`, headers: auth })).status, 403);
  symlinkSync(path.join(pipeline, "strategy.md"), path.join(pipeline, "link.md"));
  assert.equal((await get("pipeline/link.md")).status, 403);

  const preview = await get(jsonPath);
  assert.equal(preview.status, 200, preview.text);
  assert.equal(preview.json().editable, true);
  const original = preview.json();
  const withText = (text: string) => ({ path: jsonPath, text, revision: original.revision });
  assert.equal(
    (await post(withText(original.text), { ...postHeaders(server), Origin: "http://example.com" })).status,
    403,
  );
  assert.equal((await post({ ...withText(original.text), path: "pipeline/brief.json" })).status, 400);
  assert.equal((await post(withText("{"))).status, 400);
  const strategy = JSON.parse(original.text);
  assert.equal((await post(withText(JSON.stringify({ ...strategy, filmType: "replica" })))).status, 400);
  assert.equal((await get(jsonPath)).json().revision, original.revision);

  const saved = await post(withText(JSON.stringify({ ...strategy, proposition: "An edited strategy." })));
  assert.equal(saved.status, 200, saved.text);
  assert.notEqual(saved.json().revision, original.revision);
  assert.equal(statSync(jsonFile).mode & 0o777, 0o600);
  assert.equal(stepState(project(), "strategy").status, "awaiting-gate");
  assert.equal((await post(withText(original.text))).status, 409);
  const markdown = (await get(markdownPath)).json();
  const savedMarkdown = await post({ path: markdownPath, text: "# Edited strategy\n", revision: markdown.revision });
  assert.equal(savedMarkdown.status, 200, savedMarkdown.text);
  assert.equal(stepState(project(), "strategy").status, "awaiting-gate");
  approveStep(project(), "strategy", "Approved the reviewed strategy edits");
  assert.equal((await get(markdownPath)).json().editable, false);
  assert.equal(
    (await post({ path: markdownPath, text: "# Late edit", revision: savedMarkdown.json().revision })).status,
    409,
  );
});
