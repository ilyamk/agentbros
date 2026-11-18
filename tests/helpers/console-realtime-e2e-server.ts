/**
 * Child process for apps/console/e2e/timeline-realtime.e2e.ts (run with tsx: the console server's modules use `import.meta`, which
 * Playwright's CommonJS transform cannot load). Makes the review realtime fixture in a temporary root (ffmpeg),
 * registers its PNG as an imported still, copies the bundle `vite build` just wrote into the root stamped as fresh,
 * adds a completed editor, starts the real console server on port 0 and prints one JSON line `{ url, root, request, imageSha256 }`. On SIGTERM
 * or SIGINT it closes the server (channels and leases first) and removes the root. Usage: tsx console-realtime-e2e-server.ts <dist>
 */
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { BUNDLE_FILES, BUNDLE_VERSION_FILE } from "../../src/lib/console/bundle";
import { startConsoleServer } from "../../src/lib/console/server";
import { RealtimeEditorStore } from "../../src/lib/realtime/editor";
import { publishedFixture, realtimeReviewFixture } from "./review-realtime";

const BUNDLE = "timeline-realtime-e2e";
const PROJECT = "demo";

for (const name of ["AGENTBROS_EVENTS", "AGENTBROS_HOOKS", "AGENTBROS_CONSOLE"]) process.env[name] = "off";

const sourceDist = process.argv[2];
if (!sourceDist) throw new Error("usage: console-realtime-e2e-server.ts <dist>");
const f = realtimeReviewFixture();

const hash = createHash("sha256").update(f.bytes).digest("hex");
const still = path.join(f.project, "assets/imported", `${hash}.png`);
mkdirSync(path.dirname(still), { recursive: true });
writeFileSync(still, f.bytes);
writeFileSync(
  path.join(f.project, "pipeline/asset-registry.json"),
  JSON.stringify({
    schemaVersion: 1,
    revision: 1,
    assets: [
      {
        schemaVersion: 1,
        id: `sha256:${hash}`,
        hash,
        revision: 1,
        createdAt: "2026-11-17T00:00:00Z",
        kind: "image",
        files: {
          original: `projects/${PROJECT}/assets/imported/${hash}.png`,
          bytes: f.bytes.length,
          mime: "image/png",
        },
        media: { width: 32, height: 32, codec: "png", hasAudio: false },
        provenance: { origin: "manual", tool: "console e2e fixture" },
        rights: { licence: "unknown" },
        entityLinks: [],
        status: "candidate",
      },
    ],
  }),
);

const dist = path.join(f.root, "out/console/dist");
mkdirSync(dist, { recursive: true });
for (const file of BUNDLE_FILES) copyFileSync(path.join(sourceDist, file), path.join(dist, file));
writeFileSync(path.join(dist, BUNDLE_VERSION_FILE), `${BUNDLE}\n`);

/**
 * A second editor whose revision `pub` is complete with a published capture (made by the fixture's local fake socket,
 * no provider), so the e2e can select it and load the SHA-verified `@realtime` preview through the session cookie.
 */
async function publishedEditor() {
  const store = new RealtimeEditorStore(f.root, PROJECT, "published");
  store.create(1);
  store.add(0, f.request("pub"));
  store.queue(1, "pub");
  store.handoff(2);
  const capture = await publishedFixture(f, "pub");
  store.complete(3, "pub", path.relative(f.root, capture.outputs[0]!));
}

async function main() {
  await publishedEditor();
  const server = await startConsoleServer({ rootDir: f.root, port: 0, bundle: BUNDLE, build: false, version: "e2e" });
  process.stdout.write(
    JSON.stringify({ url: server.url, root: f.root, request: f.request("first"), imageSha256: hash }) + "\n",
  );

  let stopping = false;
  async function stop() {
    if (stopping) return;
    stopping = true;
    try {
      await server.close();
    } finally {
      rmSync(f.root, { recursive: true, force: true });
      process.exit(0);
    }
  }
  for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, () => void stop());
  process.stdin.on("end", () => void stop());
  process.stdin.resume();
}

void main();
