import { ensureFfmpeg, parseArgs, runScript } from "../src/lib/cli";
import { fetchSfx } from "../src/lib/audio/sfx-fetch";
import { SFX_KINDS, SHARED_SFX_DIR, type IndexedSfxKind } from "../src/lib/audio/sfx-index";

const SPECS = [
  { name: "kind", choices: SFX_KINDS, description: "Only this kind (default: all)" },
  { name: "id", description: "Only this sound: file name, stem, source id or <source>-<sourceId>" },
  { name: "root", default: SHARED_SFX_DIR, description: "Shared SFX root holding <kind>/manifest.json" },
  { name: "force", type: "boolean", description: "Rebuild files whose hash differs from the manifest" },
] as const;

void runScript(async () => {
  const args = parseArgs(SPECS);
  ensureFfmpeg();
  const result = await fetchSfx({
    kind: args.kind as IndexedSfxKind | undefined,
    id: args.id,
    root: args.root,
    force: args.force,
  });
  const problems = result.items.filter((item) => item.status !== "present" && item.status !== "fetched");
  const reencoded = result.items.filter((item) => item.sha256Match === false).map((item) => item.file);
  return {
    outputs: [],
    metadata: {
      counts: result.counts,
      problems,
      ...(reencoded.length
        ? {
            reencoded,
            reencodedNote:
              "Rebuilt bytes differ from the recorded sha256 (another ffmpeg/LAME build); rerun pnpm sfx:index to measure them.",
          }
        : {}),
      apiCalls: result.counts.fetched,
    },
  };
});
