import { CliErrorObject, ensureFfmpeg, ensureFfprobe, parseArgs, runScript } from "../src/lib/cli";
import { addReference } from "../src/lib/reference/add";
import { assertPublicDestination } from "../src/lib/media-fetch/http";
import { DEFAULT_LIBRARY_ROOT } from "../src/lib/reference/library";
import { ReferenceSourceSchema } from "../src/types/reference";

const ReferenceRights = ReferenceSourceSchema.shape.rights.shape.status.optional();

const SPECS = [
  { name: "file", description: "Local video. A sidecar <name>.md beside it becomes the notes" },
  { name: "url", description: "Video link, downloaded with uv run --locked --no-default-groups --group yt-dlp yt-dlp" },
  { name: "id", description: "Reference id (lower-case letters, digits, hyphens). Defaults to the file or link name" },
  { name: "rights", description: "unknown, owned, licensed or study-only. Files from an inbox default to study-only" },
  { name: "rights-note", description: "Where the rights status comes from" },
  {
    name: "library-root",
    default: DEFAULT_LIBRARY_ROOT,
    description: "Library directory; a project may use public/projects/ID/pipeline/reference",
  },
  { name: "force", type: "boolean", description: "Replace a reference that holds different media" },
  {
    name: "playbooks",
    description:
      "Comma-separated playbook ids this reference serves (ref:corpus --playbook). With only --id, tags an existing reference",
  },
  {
    name: "crop",
    description:
      "auto (the default) finds letterbox bars and static phone-UI bands; none keeps the whole frame; or W:H:X:Y in pixels. Picture layers read the cropped copy. With only --id, checks or sets an existing reference's crop; then rerun ref:analyze",
  },
  { name: "crop-note", description: "Why the crop was changed (a crop fault), kept in source.json cropHistory" },
  {
    name: "private",
    type: "boolean",
    description:
      "A private reference (a client's film): sets private: true in source.json and ignores its directory in .git/info/exclude, so its files and id never reach git. ref:corpus still reads it; ref:contribute refuses it. With only --id, marks an existing reference",
  },
] as const;

void runScript(async () => {
  const args = parseArgs(SPECS);
  const playbooks = args.playbooks
    ?.split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  if (playbooks?.some((id) => !/^[a-z0-9][a-z0-9-]*$/.test(id)))
    throw new CliErrorObject({
      code: "INVALID_INPUT",
      message: `--playbooks takes playbook ids (lower-case letters, digits, hyphens), got "${args.playbooks}".`,
    });
  if (args.url) {
    // Refuse loopback, link-local, private and metadata destinations by DNS before yt-dlp runs (it follows redirects itself).
    try {
      await assertPublicDestination(args.url);
    } catch (error) {
      const timeout = (error as { code?: unknown }).code === "TIMEOUT";
      throw new CliErrorObject({
        code: timeout ? "TIMEOUT" : "INVALID_INPUT",
        message: `Reference link refused: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }
  if (args.file || args.url || args.crop) {
    ensureFfmpeg();
    ensureFfprobe();
  }
  const { directory, source, reused, recropped, exclude } = addReference({
    playbooks,
    private: args.private === true,
    file: args.file,
    url: args.url,
    id: args.id,
    rights: ReferenceRights.parse(args.rights),
    rightsNote: args["rights-note"],
    libraryRoot: args["library-root"]!,
    force: args.force,
    crop: args.crop,
    cropNote: args["crop-note"],
  });
  return {
    outputs: [`${directory}/source.json`, `${directory}/${source.mediaPath}`],
    metadata: {
      referenceId: source.referenceId,
      directory,
      reused,
      probe: source.probe,
      rights: source.rights,
      hasNotes: !!source.notes,
      crop: source.crop,
      ...(source.playbooks ? { playbooks: source.playbooks } : {}),
      ...(source.private ? { private: true, exclude } : {}),
      ...(recropped !== undefined
        ? {
            recropped,
            next: `Picture layers were measured on the old crop: rerun pnpm ref:analyze --id ${source.referenceId}. Shot ids can renumber, so check edit.json corrections and techniques against the new shots.json.`,
          }
        : {}),
    },
  };
});
