/**
 * Reference packs (RFC 0003 §9): prepare, check, board, rights, approve, request, result-board, review-result.
 * Spend none. rights, approve and review-result record the user's or reviewer's statements and are CLI-only.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { ZodError } from "zod";
import { CliErrorObject, parseArgs, requireProject, runScript } from "../src/lib/cli";
import { requireUserWords } from "../src/lib/cli/user-words";
import {
  approvePack,
  checkPack,
  listPacks,
  packResultBoard,
  preparePack,
  reviewPackResult,
  writePackRights,
} from "../src/lib/references/packs";

void runScript(async () => {
  try {
    const args = parseArgs([
      {
        name: "action",
        required: true,
        choices: ["prepare", "check", "board", "list", "rights", "approve", "request", "result-board", "review-result"],
        description:
          "prepare a pack from a spec; check it; show its board; list packs; record rights or approval (CLI only); emit its request; board or review a result",
      },
      { name: "project", required: true, description: "Existing project ID" },
      { name: "spec", description: "ReferencePackSpec JSON file (prepare)" },
      { name: "id", description: "Pack ID" },
      { name: "review", description: "PackVisualReview (approve) or PackResultReview (review-result) JSON file" },
      { name: "answer", description: "The user's own words, verbatim (rights, approve)" },
      { name: "result", description: "Generated result file inside the project or out/<project> (result-board)" },
      { name: "status", choices: ["owned", "licensed", "study-only"], description: "Rights status (rights)" },
      { name: "evidence", description: "Supplied ownership or licence evidence for every attachment (rights)" },
      {
        name: "allow-foreign-result",
        type: "boolean",
        description: "Review a result that generate:model did not publish from this pack (review-result)",
      },
      { name: "allow-processing", type: "boolean", description: "The user permits processing these inputs (rights)" },
      { name: "placements", description: "Comma-separated authorised placements or private-study (rights)" },
      { name: "commercial", type: "boolean", description: "The supplied rights permit commercial use (rights)" },
      { name: "audio-rights", choices: ["owned", "licensed", "muted"], description: "Audio permission (rights)" },
      { name: "advertising", type: "boolean", description: "Rights explicitly cover advertising (rights)" },
      { name: "endorsement", type: "boolean", description: "Rights explicitly cover endorsement (rights)" },
      { name: "standalone-resale", type: "boolean", description: "Rights explicitly cover standalone resale (rights)" },
    ] as const);
    const required = (value: string | undefined, flag: string): string => {
      if (!value?.trim())
        throw new CliErrorObject({ code: "INVALID_INPUT", message: `--${flag} is required for ${args.action}.` });
      return value;
    };
    const json = (file: string | undefined, flag: string): unknown => {
      const name = required(file, flag);
      try {
        return JSON.parse(readFileSync(name, "utf8"));
      } catch (error) {
        throw new CliErrorObject({
          code: "INVALID_INPUT",
          message: `Cannot read ${name}: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    };
    const project = required(args.project, "project");
    requireProject(project);
    if (args.action === "list") return { metadata: { packs: listPacks(project) } };
    if (args.action === "prepare") {
      const pack = preparePack(project, json(args.spec, "spec"));
      const id = pack.spec.id;
      return {
        outputs: pack.files,
        metadata: {
          id,
          packSha256: pack.packSha256,
          reused: pack.reused,
          endpoint: pack.receipt.endpoint,
          compiledPrompt: pack.receipt.compiledPrompt,
          markerMap: pack.receipt.markerMap,
          warnings: pack.receipt.warnings,
          approved: false,
          nextActions: [
            `Show the user ${path.join(pack.directory, "board.html")} and complete visual-review-template.json as a separate review file.`,
            `If rights are required: pnpm refs:pack --project ${project} --action rights --id ${id} --status ... --answer "<the user's words>" ...`,
            `Record the user's approval: pnpm refs:pack --project ${project} --action approve --id ${id} --review REVIEW.json --answer "<the user's words>"`,
          ],
        },
      };
    }
    const id = required(args.id, "id");
    if (args.action === "rights") {
      const answer = requireUserWords(args.answer, "--answer");
      if (!args.status || !args["allow-processing"] || !args.evidence || !args.placements || !args["audio-rights"])
        throw new CliErrorObject({
          code: "INVALID_INPUT",
          message:
            "Pack rights need --status, --allow-processing, --evidence, --placements and --audio-rights, reflecting the user's actual authorisation.",
        });
      const result = writePackRights(project, id, {
        status: args.status as "owned" | "licensed" | "study-only",
        userStatement: answer,
        evidence: args.evidence,
        processingAllowed: true,
        commercialAllowed: args.commercial === true,
        placements: args.placements
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean),
        audioRights: args["audio-rights"] as "owned" | "licensed" | "muted",
        usage: {
          advertising: args.advertising === true,
          endorsement: args.endorsement === true,
          standaloneResale: args["standalone-resale"] === true,
        },
      });
      return { outputs: [result.file], metadata: { id, rights: result.rights, required: result.required } };
    }
    if (args.action === "approve") {
      const result = approvePack(
        project,
        id,
        requireUserWords(required(args.answer, "answer"), "--answer"),
        json(args.review, "review"),
      );
      return { outputs: [result.file], metadata: { id, approved: true, packSha256: result.approval.packSha256 } };
    }
    if (args.action === "result-board") {
      const result = packResultBoard(project, id, required(args.result, "result"));
      return { outputs: [result.board, ...result.frames, result.reviewTemplate], metadata: result };
    }
    if (args.action === "review-result") {
      const result = reviewPackResult(project, id, json(args.review, "review"), process.cwd(), {
        allowForeignResult: args["allow-foreign-result"] === true,
      });
      return {
        outputs: [result.file],
        metadata: {
          id,
          verdict: result.review.verdict,
          producedByPack: result.producedByPack,
          nextAction: result.nextAction,
        },
      };
    }
    const pack = checkPack(project, id);
    const summary = {
      id,
      packSha256: pack.packSha256,
      endpoint: pack.receipt.endpoint,
      rightsRequired: pack.rightsRequired,
      rightsReasons: pack.rightsReasons,
      rightsRecorded: Boolean(pack.rights),
      approved: pack.approvalStatus.approved,
      blockers: pack.approvalStatus.problems,
    };
    if (args.action === "board")
      return {
        outputs: [path.join(pack.directory, "board.html")],
        metadata: {
          ...summary,
          compiledPrompt: pack.receipt.compiledPrompt,
          markerMap: pack.receipt.markerMap,
          attachments: pack.receipt.attachments,
          warnings: pack.receipt.warnings,
        },
      };
    if (args.action === "request")
      return {
        outputs: [path.join(pack.directory, "request.json")],
        metadata: {
          ...summary,
          request: pack.request,
          next: summary.approved
            ? "Quote and dry-run this exact request with generate:model --dry-run; approval is not an unlimited budget."
            : "Not approved: record rights (if required) and the user's approval before any paid submission.",
        },
      };
    return { outputs: [path.join(pack.directory, "receipt.json")], metadata: summary };
  } catch (error) {
    if (error instanceof ZodError) throw new CliErrorObject({ code: "VALIDATION", message: error.message });
    throw error;
  }
});
