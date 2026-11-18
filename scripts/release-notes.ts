import { parseArgs } from "../src/lib/cli";
import { runOffline } from "../src/lib/contrib/cli";
import { NOTES_FLAGS, notesFor } from "../src/lib/release/notes";

void runOffline(async () => {
  const args = parseArgs(NOTES_FLAGS);
  return { metadata: { notes: notesFor(process.cwd(), args).notes } };
});
