/**
 * Put a typed agent card on the project's console canvas (RFC 0004 D14, §9.2; schema CardInputSchema in
 * src/types/console.ts): `pnpm console:card --project P --kind K --data card.json [--expires-in 2h]`.
 *
 * Validates the card (media inside the project or its out/<id>/, existing, servable; no HTML anywhere), writes
 * `public/projects/<id>/pipeline/cards/<cardId>.json` atomically (never creating the project), journals `card.posted`
 * and prints the card id, its file and, when a console server is live, the console's address (never the token URL).
 * The user's answer lands in the same file; `console:wait` and the hooks report it.
 */
import { lstatSync, readFileSync } from "node:fs";
import path from "node:path";
import { CliErrorObject, parseArgs, runScript, validateProjectId, type ErrorCode } from "../src/lib/cli";
import { CARD_DATA_MAX_BYTES, parseCardInput, parseExpiresIn, postCard } from "../src/lib/console/cards";
import { consoleAddress } from "../src/lib/console/agent-view";
import { HttpError } from "../src/lib/local-server/errors";
import { CARD_KINDS, type CardKind } from "../src/types/console";

/** The store's HTTP-style errors as CLI codes. */
function cliError(error: unknown): unknown {
  if (!(error instanceof HttpError)) return error;
  const code: ErrorCode =
    error.code === "PROJECT_NOT_FOUND"
      ? "PROJECT_NOT_FOUND"
      : error.code === "FILE_NOT_FOUND"
        ? "FILE_NOT_FOUND"
        : error.code === "VALIDATION" || error.status === 409
          ? "VALIDATION"
          : error.status >= 500
            ? "INTERNAL"
            : "INVALID_INPUT";
  return new CliErrorObject({ code, message: error.message });
}

function readData(file: string): unknown {
  const info = lstatSync(file, { throwIfNoEntry: false });
  if (!info?.isFile()) throw new CliErrorObject({ code: "FILE_NOT_FOUND", message: `--data file not found: ${file}` });
  if (info.size > CARD_DATA_MAX_BYTES)
    throw new CliErrorObject({
      code: "INVALID_INPUT",
      message: `--data is ${info.size} bytes; a card file is at most ${CARD_DATA_MAX_BYTES} bytes.`,
    });
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new CliErrorObject({
      code: "VALIDATION",
      message: `--data is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
}

void runScript(async () => {
  const args = parseArgs([
    { name: "project", required: true, description: "Project the card belongs to" },
    { name: "kind", required: true, choices: CARD_KINDS, description: "Card kind; must match the data's kind" },
    { name: "data", required: true, description: "JSON file with the card (CardInputSchema, at most 256 KiB)" },
    {
      name: "expires-in",
      description: "The card stops waiting after this long: 45m, 2h, 1d (plain numbers are minutes; up to 30d)",
    },
  ] as const);
  const project = String(args.project);
  validateProjectId(project);
  const rootDir = process.cwd();
  try {
    const input = parseCardInput(readData(path.resolve(String(args.data))), args.kind as CardKind);
    const expiresInMs = args["expires-in"] === undefined ? undefined : parseExpiresIn(String(args["expires-in"]));
    const { card, file } = postCard(rootDir, project, input, { expiresInMs });
    const { url } = consoleAddress(rootDir, project);
    return {
      outputs: [file],
      metadata: {
        cardId: card.id,
        project,
        kind: card.kind,
        expectsAnswer: card.expectsAnswer,
        ...(card.expiresAt ? { expiresAt: card.expiresAt } : {}),
        file,
        ...(url ? { url } : {}),
        next: card.expectsAnswer
          ? `The user answers in the console; pnpm console:wait --project ${project} returns the answer.`
          : "Information only: no answer expected.",
      },
    };
  } catch (error) {
    throw cliError(error);
  }
});
