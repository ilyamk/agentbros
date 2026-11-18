/**
 * `GET /api/metrics` (RFC 0004 §12, A19, WP12): authenticated like every read, takes no query, answers the metrics
 * schema from the projector's journals and ledgers, and 501 from a data source without metrics.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { ConsoleMetricsSchema } from "../src/lib/console/metrics-schema";
import type { ConsoleServer } from "../src/lib/console/server";
import { createProjectorDataSource } from "../src/lib/console/view/source";
import { makeRoot, PROJECT, raw, removeRoot, startTestServer } from "./helpers/console-server";

describe("console server /api/metrics", () => {
  let root: string;
  let server: ConsoleServer;

  before(async () => {
    root = makeRoot();
    server = await startTestServer(root);
  });

  after(async () => {
    await server?.close();
    removeRoot(root);
  });

  test("needs the token", async () => {
    const res = await raw(server.port, { path: "/api/metrics" });
    assert.equal(res.status, 403);
    assert.equal(res.json().error, "FORBIDDEN");
  });

  test("answers the metrics schema for every project and writes out/console/metrics.json", async () => {
    const res = await raw(server.port, { path: "/api/metrics", headers: { "x-console-token": server.token } });
    assert.equal(res.status, 200, res.text);
    const metrics = ConsoleMetricsSchema.parse(res.json());
    assert.deepEqual(
      metrics.projects.map((row) => row.project),
      [PROJECT],
    );
    assert.equal(metrics.decisions.decided, 0);
    assert.ok(existsSync(path.join(root, "out/console/metrics.json")));
  });

  test("a query is refused", async () => {
    const res = await raw(server.port, {
      path: "/api/metrics?project=x",
      headers: { "x-console-token": server.token },
    });
    assert.equal(res.status, 400);
  });

  test("501 from a data source without metrics", async () => {
    const projector = createProjectorDataSource(root);
    const bare = Object.assign(Object.create(Object.getPrototypeOf(projector)), projector, { metrics: undefined });
    const other = await startTestServer(root, { dataSource: bare });
    try {
      const res = await raw(other.port, { path: "/api/metrics", headers: { "x-console-token": other.token } });
      assert.equal(res.status, 501);
    } finally {
      await other.close();
      (projector as { close?: () => void }).close?.();
    }
  });
});
