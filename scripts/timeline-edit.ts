import { assertProjectCopyEdits } from "../src/lib/review-ui/copy-validation";
import { assertProjectAudioEdits } from "../src/lib/audio/edit-validation";
import { assertOverlayBlocks, touchedOverlayIds } from "../src/lib/timeline-ir/overlays.js";
import { CATALOGUE_PATH, readCatalogue } from "../src/lib/library/catalogue.js";
import { importLegacyCaptions } from "../src/lib/timeline-ir/caption-import.js";
import path from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { parseArgs, runScript, requireProject, CliErrorObject } from "../src/lib/cli/index.js";
import {
  TimelineEditStore,
  adaptLegacyProject,
  compileTimelineIR,
  RevisionConflict,
} from "../src/lib/timeline-ir/index.js";

runScript(async () => {
  const args = parseArgs([
    { description: "Timeline edit option", name: "project", required: true },
    { description: "Timeline edit option", name: "revision", type: "number" },
    { description: "Timeline edit option", name: "command" },
    { description: "Timeline edit option", name: "command-file" },
    { description: "Timeline edit option", name: "init", type: "boolean" },
    { description: "Timeline edit option", name: "dry-run", type: "boolean" },
    { description: "Timeline edit option", name: "undo", type: "boolean" },
    { description: "Timeline edit option", name: "redo", type: "boolean" },
  ]);
  const id = String(args.project);
  requireProject(id);
  const file = path.resolve("public", "projects", id, "pipeline", "timeline-edit.json");
  const store = new TimelineEditStore(file, (timeline, command) => {
    assertProjectAudioEdits(timeline, command, id);
    assertProjectCopyEdits(timeline, command, id);
    const overlayIds = touchedOverlayIds(command);
    if (overlayIds.length) {
      const catalogue = readCatalogue();
      if (!catalogue) throw new Error(`${CATALOGUE_PATH} is missing; run pnpm library:catalogue`);
      assertOverlayBlocks(timeline, catalogue.items, overlayIds);
    }
  });
  try {
    const actions = [args.init, args.undo, args.redo, args.command || args["command-file"]].filter(Boolean);
    if (actions.length !== 1)
      throw new Error("Select exactly one action: --init, --command/--command-file, --undo or --redo");
    if (args.command && args["command-file"]) throw new Error("Select only one command input");
    if (args.init) {
      if (args["dry-run"]) throw new Error("--init cannot use --dry-run");
      const raw = JSON.parse(readFileSync(path.resolve("public", "projects", id, "project.json"), "utf8"));
      const result = store.initialize(
        importLegacyCaptions(adaptLegacyProject(raw, id), path.resolve("public", "projects", id)),
      );
      return {
        outputs: [file],
        metadata: {
          revision: result.revision,
          snapshot: compileTimelineIR(result.timeline),
        },
      };
    }
    if (!existsSync(file)) throw new Error("Initialize the edit journal with --init first");
    if (typeof args.revision !== "number") throw new Error("--revision is required for all edit operations");
    if (args["dry-run"] && (args.undo || args.redo)) throw new Error("--dry-run requires a command");
    const command = args.command
      ? JSON.parse(String(args.command))
      : args["command-file"]
        ? JSON.parse(readFileSync(String(args["command-file"]), "utf8"))
        : undefined;
    if (args["dry-run"]) {
      const result = store.dryRun(command, args.revision);
      return { outputs: [], metadata: { dryRun: true, ...result } };
    }
    const result = args.undo
      ? store.undo(args.revision)
      : args.redo
        ? store.redo(args.revision)
        : store.apply(command, args.revision);
    return {
      outputs: [file],
      metadata: {
        revision: result.revision,
        snapshot: compileTimelineIR(result.timeline),
      },
    };
  } catch (error) {
    if (error instanceof CliErrorObject) throw error;
    throw new CliErrorObject({
      code: "VALIDATION",
      message: error instanceof Error ? error.message : String(error),
      details: error instanceof RevisionConflict ? { expected: error.expected, actual: error.actual } : undefined,
    });
  }
});
