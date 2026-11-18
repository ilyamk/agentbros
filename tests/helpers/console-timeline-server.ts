/**
 * A real console server for the console's timeline end-to-end tests (apps/console/e2e/timeline-edit.e2e.ts), run with
 * tsx as a child process (Playwright's loader cannot import the server's ES modules). It makes `--projects` fresh projects (`film-1`, …),
 * each with an initialized timeline journal, under `--root`, starts the server on a free port over the built bundle
 * in `--dist` (with `--control`, the real pause/resume/stop actions), prints one JSON line `{ origin, token }` and runs until stdin closes or it is signalled.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { importAsset } from "../../src/lib/assets/registry";
import { cardAnswerer } from "../../src/lib/console/cards";
import { controlActions } from "../../src/lib/console/control-actions";
import { notImplementedActions } from "../../src/lib/console/data";
import { startConsoleServer } from "../../src/lib/console/server";
import { TimelineEditStore } from "../../src/lib/timeline-ir/store";

const r = (num: number, den = 1) => ({ num, den });
const clip = (id: string, start: number, frames: number) => ({
  id,
  assetId: `scene:${id}`,
  start: r(start),
  source: { start: r(0), end: r(frames), timebase: r(30) },
  rate: r(1),
});

/** A valid `project.json` (the specialized prepares parse it). */
const CONFIG = {
  name: "demo",
  productName: "demo",
  formats: ["vertical"],
  colors: {},
  musicVolume: 0.4,
  voiceoverEnabled: false,
  scenes: [{ id: "hook", text: "Original speech", headline: "Original", visualType: "title", durationInFrames: 90 }],
};

/**
 * Two visual tracks, a voiceover setting the 120-frame duration and a music bed, 30 fps. `hookAsset` is the imported
 * PNG of the `hook` clip (so split and remove can succeed); the other clips point at scene ids.
 */
export const timeline = (projectId: string, hookAsset = "scene:hook") => ({
  version: 1 as const,
  projectId,
  timebase: r(30),
  tracks: [
    {
      id: "visual",
      kind: "visual" as const,
      clips: [{ ...clip("hook", 0, 30), assetId: hookAsset }, clip("proof", 60, 30)],
    },
    { id: "broll", kind: "visual" as const, clips: [clip("cut", 30, 30)] },
    { id: "voice", kind: "voiceover" as const, clips: [clip("speech", 0, 120)] },
    { id: "music", kind: "music" as const, clips: [clip("bed", 0, 120)] },
  ],
});

async function main() {
  const { values } = parseArgs({
    options: {
      root: { type: "string" },
      dist: { type: "string" },
      projects: { type: "string", default: "8" },
      // Pause, resume and stop through the real console-control CLI (apps/console/e2e/editing-table.e2e.ts).
      control: { type: "boolean", default: false },
      "capture-browser": { type: "boolean", default: false },
    },
  });
  if (!values.root || !values.dist) throw new Error("--root and --dist are required");
  // A small owned PNG (no downloads); without ffmpeg the hook stays a scene id and split/remove refuse.
  const png = path.join(values.root, "blue.png");
  let hasPng = true;
  try {
    execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=c=blue:size=480x270", "-frames:v", "1", png], {
      timeout: 10000,
    });
  } catch {
    hasPng = false;
  }
  for (let i = 1; i <= Number(values.projects); i++) {
    const id = `film-${i}`;
    const project = path.join(values.root, "public/projects", id);
    mkdirSync(path.join(project, "pipeline"), { recursive: true });
    writeFileSync(path.join(project, "project.json"), JSON.stringify(CONFIG));
    const hook = hasPng
      ? importAsset({
          rootDir: values.root,
          projectId: id,
          sourceFile: png,
          rights: { licence: "synthetic-test" },
          provenance: { origin: "manual" },
        }).asset.id
      : undefined;
    new TimelineEditStore(path.join(project, "pipeline/timeline-edit.json")).initialize(timeline(id, hook));
  }
  const server = await startConsoleServer({
    rootDir: values.root,
    port: 0,
    build: false,
    distDir: values.dist,
    version: "e2e",
    ...(values["capture-browser"]
      ? { openBrowser: async (url) => writeFileSync(path.join(values.root!, "browser-url"), url, { mode: 0o600 }) }
      : {}),
    ...(values.control
      ? {
          actions: {
            ...notImplementedActions,
            answerCard: cardAnswerer(values.root),
            ...controlActions(values.root),
          },
        }
      : {}),
    // The checkout's own token (out/console/session.json under --root), so pairing codes issued there redeem here.
  });
  await server.bundle.ready;
  process.stdout.write(JSON.stringify({ origin: server.origin, token: server.token }) + "\n");
  const stop = () => void server.close().finally(() => process.exit(0));
  process.stdin.on("end", stop);
  process.stdin.resume();
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
