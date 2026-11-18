import { CliErrorObject, parseArgs, runScript } from "../src/lib/cli";
import { readStudioRequest } from "../src/lib/elevenlabs/files";
import { runSpeechReplacement } from "../src/lib/elevenlabs/speech-replacement";

runScript(async () => {
  const args = parseArgs([
    { name: "project", required: true, description: "Project containing the timeline journal" },
    { name: "request", required: true, description: "Revision-bound speech replacement request" },
    {
      name: "action",
      choices: ["plan", "prepare", "status", "apply"],
      default: "plan",
      description: "Plan, make a take, inspect or apply",
    },
    { name: "dry-run", type: "boolean", description: "Set false only for authorised paid preparation" },
    { name: "alignment", description: "Native word-time transcript of the replacement take" },
    { name: "preview", type: "boolean", description: "Write an audio preview with the joins after alignment" },
    { name: "review-sha256", description: "Current review hash from status" },
    { name: "answer", description: "The user's own approval of this audio, alignment and picture" },
  ] as const);
  try {
    const raw = readStudioRequest(process.cwd(), args.request!) as { projectId?: unknown } | null;
    if (raw?.projectId !== args.project) throw Error("Request projectId differs from --project");
    return await runSpeechReplacement(raw, {
      action: args.action as "plan" | "prepare" | "status" | "apply",
      dryRun: args["dry-run"],
      alignment: args.alignment,
      preview: args.preview,
      reviewSha256: args["review-sha256"],
      answer: args.answer,
    });
  } catch (error) {
    if (error instanceof CliErrorObject) throw error;
    throw new CliErrorObject({ code: "VALIDATION", message: (error as Error).message });
  }
});
