/** Offline, immutable Genjutsu input preparation; approvals always record the user's own words. */
import { requireUserWords } from "../src/lib/cli/user-words";
import { readFileSync } from "node:fs";
import path from "node:path";
import { ZodError } from "zod";
import { CliErrorObject, parseArgs, requireProject, runScript } from "../src/lib/cli";
import { GenjutsuModeSchema } from "../src/types/model-preparation";
import { prepareModel } from "../src/lib/model-preparation/prepare";
import { preparationProfile } from "../src/lib/model-preparation/profiles";
import { approvePreparation, preparationAdmission, validatePreparation } from "../src/lib/model-preparation/approval";
import { preparationDirectory, readPreparation } from "../src/lib/model-preparation/storage";
import { preparationResultBoard, reviewPreparationResult } from "../src/lib/model-preparation/results";
import { preparationAsPack } from "../src/lib/model-preparation/as-pack";

void runScript(async () => {
  try {
    const args = parseArgs([
      {
        name: "action",
        required: true,
        choices: ["profile", "prepare", "check", "approve", "result-board", "review-result", "as-pack"],
        description:
          "Inspect a recipe, prepare inputs, check readiness, record approval, inspect/review a result, or (optional) as-pack: write the prepared input as reference pack genjutsu-ID for refs:pack review",
      },
      { name: "project", description: "Existing project ID" },
      { name: "mode", choices: GenjutsuModeSchema.options, description: "Exact Genjutsu mode for action=profile" },
      { name: "spec", description: "Strict ModelPreparationSpec JSON for action=prepare" },
      { name: "id", description: "Immutable preparation ID" },
      {
        name: "review",
        description: "Completed PreparationVisualReview or PreparationResultReview JSON, with exact hashes",
      },
      { name: "answer", description: "The user's explicit approval, verbatim; action=approve only" },
      { name: "result", description: "Published result video for action=result-board" },
    ] as const);
    const required = (value: string | undefined, flag: string): string => {
      if (!value?.trim())
        throw new CliErrorObject({ code: "INVALID_INPUT", message: `--${flag} is required for ${args.action}.` });
      return value;
    };
    const json = (file: string | undefined, flag: string): unknown =>
      JSON.parse(readFileSync(required(file, flag), "utf8"));
    if (args.action === "profile")
      return { metadata: preparationProfile(GenjutsuModeSchema.parse(required(args.mode, "mode"))) };
    const project = required(args.project, "project");
    requireProject(project);
    if (args.action === "prepare") {
      const data = prepareModel(project, json(args.spec, "spec"));
      const directory = preparationDirectory(project, data.receipt.id);
      return {
        outputs: ["receipt.json", "request.json", "board.html", "visual-review-template.json"].map((name) =>
          path.join(directory, name),
        ),
        metadata: {
          id: data.receipt.id,
          sha256: data.sha256,
          mode: data.receipt.spec.mode,
          warnings: data.receipt.warnings,
          reused: data.reused,
          ready: false,
          nextActions: [
            "Inspect board.html and the full prepared clip; complete a separate visual-review JSON.",
            `Record source-use rights with pnpm film:rights --project ${project} --preparation ${data.receipt.id}.`,
            `Record the user's approval with pnpm model:prepare --project ${project} --action approve --id ${data.receipt.id} --review REVIEW.json --answer USER_WORDS.`,
          ],
        },
      };
    }
    const id = required(args.id, "id");
    if (args.action === "approve") {
      const result = approvePreparation(
        project,
        id,
        requireUserWords(required(args.answer, "answer"), "--answer"),
        json(args.review, "review"),
      );
      return { outputs: [result.file], metadata: { approved: true, id } };
    }
    if (args.action === "as-pack") {
      const { pack, preparation } = preparationAsPack(project, id);
      return {
        outputs: pack.files,
        metadata: {
          packId: pack.receipt.id,
          packSha256: pack.packSha256,
          preparation,
          reused: pack.reused,
          nextActions: [
            `Review with pnpm refs:pack --project ${project} --action check --id ${pack.receipt.id}.`,
            `Submit the preparation's own request (model:prepare --action check --id ${id}); the pack is for review and listing.`,
          ],
        },
      };
    }
    if (args.action === "result-board") {
      const result = preparationResultBoard(project, id, required(args.result, "result"));
      return { outputs: [...result.frames, result.assessmentFile], metadata: result };
    }
    if (args.action === "review-result") {
      const result = reviewPreparationResult(project, id, json(args.review, "review"));
      return {
        outputs: [result.file],
        metadata: {
          verdict: result.review.verdict,
          nextAction:
            result.review.verdict === "reshoot"
              ? "Ask the user before a new paid attempt."
              : result.review.verdict === "repair"
                ? "Repair and review a new result revision."
                : "Continue the existing edit and delivery checks.",
        },
      };
    }
    const data = readPreparation(project, id),
      binding = { id, sha256: data.sha256 };
    const validated = validatePreparation(project, binding);
    const admission = preparationAdmission(project, binding, data.receipt.endpoint, validated.plan.input);
    if (!admission.ready)
      throw new CliErrorObject({ code: "STAGE_INCOMPLETE", message: admission.blockers.join(" "), details: admission });
    return {
      metadata: {
        ...admission,
        request: path.join(preparationDirectory(project, id), "request.json"),
        quoteNext:
          "Use hf:quote and generate:model --dry-run on the exact prepared request; approval does not authorise an unlimited budget.",
      },
    };
  } catch (error) {
    if (error instanceof ZodError) throw new CliErrorObject({ code: "VALIDATION", message: error.message });
    throw error;
  }
});
