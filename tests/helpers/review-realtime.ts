import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { OperationStore } from "../../src/lib/jobs/store";
import { runRealtimeSession, type RealtimeSessionRequest } from "../../src/lib/realtime/session";
import { once } from "node:events";
import WebSocket, { WebSocketServer } from "ws";
import { encode } from "@msgpack/msgpack";
import { USER_GRANT } from "./ceiling-grant";
export function realtimeReviewFixture() {
  const root = mkdtempSync(path.join(tmpdir(), "review-realtime-")),
    project = path.join(root, "public/projects/demo");
  mkdirSync(path.join(project, "pipeline"), { recursive: true });
  writeFileSync(path.join(project, "project.json"), "{}");
  const image = path.join(project, "image.png");
  const made = spawnSync(
    "ffmpeg",
    ["-v", "error", "-f", "lavfi", "-i", "color=c=blue:s=32x32", "-frames:v", "1", image],
    { encoding: "utf8" },
  );
  assert.equal(made.status, 0, made.stderr);
  const bytes = readFileSync(image);
  const request = (revision: string): RealtimeSessionRequest => ({
    version: 1,
    projectId: "demo",
    sessionId: `ui-${revision}`,
    revisionId: revision,
    operation: {
      family: "flux-2",
      variant: "klein",
      operation: "realtime",
      transport: "realtime",
      input: { image_url: `data:image/png;base64,${bytes.toString("base64")}`, seed: 35 },
    },
    quote: {
      currency: "USD",
      lowUsd: 0,
      expectedUsd: 0.2,
      highUsd: 0.5,
      bounded: true,
      confidence: "user-bound",
      source: "offline fixture",
      asOf: "2026-10-11",
    },
    limits: {
      maxFrames: 2,
      maxInputBytes: 1024 * 1024,
      maxResponseBytes: 1024 * 1024,
      maxControls: 4,
      timeoutMs: 2000,
    },
  });
  return { root, project, request, bytes };
}
export async function publishedFixture(
  f: ReturnType<typeof realtimeReviewFixture>,
  revision: string,
  responseBytes = f.bytes,
) {
  const financial = new OperationStore("demo", { directory: path.join(f.project, "pipeline") });
  try {
    financial.snapshot();
  } catch {
    financial.configure(
      { ceilingUsd: 2, maxJobUsd: 1, repairReserveFraction: 0, maxPaidAttemptsPerAsset: 2 },
      USER_GRANT,
    );
  }
  const socketServer = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(socketServer, "listening");
  let connections = 0;
  socketServer.on("connection", (socket) => {
    connections++;
    socket.on("message", () =>
      socket.send(
        encode({
          seed: 35,
          images: [{ content: new Uint8Array(responseBytes), width: 32, height: 32, content_type: "image/png" }],
        }),
      ),
    );
  });
  try {
    const capture = await runRealtimeSession(f.request(revision), {
      rootDir: f.root,
      store: financial,
      tokenProvider: async () => "injected-fixture-token",
      socketFactory: () => new WebSocket(`ws://127.0.0.1:${(socketServer.address() as { port: number }).port}`),
    });
    assert.equal(capture.metadata.state, "published");
    assert.equal(connections, 1);
    return capture;
  } finally {
    for (const socket of socketServer.clients) socket.terminate();
    await new Promise<void>((resolve) => socketServer.close(() => resolve()));
  }
}
