import { parseArgs } from "../src/lib/cli";
import { runOffline } from "../src/lib/contrib/cli";
import { applyRelease, readEntries } from "../src/lib/release";
import { NOTES_FLAGS, notesFor } from "../src/lib/release/notes";

void runOffline(async () => {
  const args = parseArgs([
    ...NOTES_FLAGS,
    {
      name: "notes",
      description: "Previously generated Markdown notes, including showcase discovery; apply never invokes git",
    },
  ] as const);
  const { entries, notes } = args.notes
    ? { entries: readEntries(process.cwd()), notes: readFileSync(args.notes, "utf8") }
    : notesFor(process.cwd(), args, false);
  const { outputs, tag } = applyRelease(process.cwd(), args.version!, notes, entries);
  return { outputs, metadata: { tag, consumed: entries.map((entry) => entry.file), notes } };
});
import { readFileSync } from "node:fs";
