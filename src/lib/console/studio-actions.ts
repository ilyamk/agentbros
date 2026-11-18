/**
 * The console's Remotion Studio actions (RFC 0004 §17, D21 as amended 2026-11-18). The status is read in-process
 * (no props, no spawn); opening and stopping spawn `studio:open` as the user with the console grant (control-actions'
 * runner), so they also run while the project is paused. The console never runs composition code itself.
 */
import {
  StudioOpenResponseSchema,
  type CliEnvelope,
  type StudioOpenRequest,
  type StudioOpenResponse,
  type StudioStatusResponse,
} from "../../types/console";
import { HttpError } from "../local-server/errors";
import { spawnCli, type CliRunner } from "./control-actions";
import type { ConsoleActions } from "./data";
import { STUDIO_READY_TIMEOUT_MS, studioStatus } from "./studio";

/** How a refused `studio:open` maps to HTTP. */
const STATUS: Record<string, number> = {
  PROJECT_NOT_FOUND: 404,
  INVALID_INPUT: 400,
  VALIDATION: 400,
  STAGE_INCOMPLETE: 409,
  PAUSED: 409,
  TIMEOUT: 504,
};

const refused = (envelope: CliEnvelope) =>
  new HttpError(
    STATUS[envelope.error ?? ""] ?? 500,
    envelope.error ?? "INTERNAL",
    (envelope.message ?? "studio:open refused").slice(0, 4000),
  );

/** Spawn deadline: Studio's own ready timeout plus the CLI's start and props generation. */
const OPEN_TIMEOUT_MS = STUDIO_READY_TIMEOUT_MS + 60_000;

export function studioActions(
  rootDir: string,
  run: CliRunner = spawnCli,
  options: { codeRoot?: string } = {},
): Pick<ConsoleActions, "studioStatus" | "openStudio" | "stopStudio"> {
  const status = async (project: string): Promise<StudioStatusResponse> =>
    studioStatus(rootDir, project, { codeRoot: options.codeRoot });
  return {
    studioStatus: status,
    async openStudio(project: string, request: StudioOpenRequest): Promise<StudioOpenResponse> {
      const envelope = await run(
        rootDir,
        "studio-open.ts",
        ["--project", project, ...(request.format ? ["--format", request.format] : [])],
        OPEN_TIMEOUT_MS,
      );
      if (!envelope.ok) throw refused(envelope);
      const metadata = envelope.metadata ?? {};
      const url = typeof metadata.url === "string" ? metadata.url : "";
      if (!/^http:\/\/127\.0\.0\.1:\d{1,5}\/[A-Za-z0-9-]{1,128}$/.test(url))
        throw new HttpError(500, "INTERNAL", "studio:open answered without a loopback Studio URL.");
      return StudioOpenResponseSchema.parse({ ok: true, url, reused: metadata.reused === true });
    },
    async stopStudio(project: string): Promise<StudioStatusResponse> {
      const envelope = await run(rootDir, "studio-open.ts", ["--project", project, "--stop"], 30_000);
      if (!envelope.ok) throw refused(envelope);
      return status(project);
    },
  };
}
