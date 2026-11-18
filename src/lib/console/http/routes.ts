/**
 * Authenticated routes of the console server (RFC 0004 §9.1). Called after the Host, Origin and session checks;
 * `segments` are decoded but not normalised (see local-server/paths.ts).
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { z } from "zod";
import {
  CardAnswerRequestSchema,
  ConsoleIdSchema,
  ControlRequestSchema,
  DecisionRequestSchema,
  EventsQuerySchema,
  HOOKS_INSTALL_COMMAND,
  HooksResponseSchema,
  JobCancelRequestSchema,
  OperationIdSchema,
  PROJECTS_DIR,
  ProjectIdSchema,
  StreamQuerySchema,
  StudioOpenRequestSchema,
  ThumbQuerySchema,
} from "../../../types/console";
import {
  ConsoleDocumentLocatorSchema,
  ConsoleDocumentSaveSchema,
  DOCUMENT_EDIT_LIMIT,
} from "../../../types/console-document";
import { isReservedProjectId, reservedProjectReason } from "../../cli";
import { ProjectRemovalSchema, ProjectRenameSchema } from "../../../types/project-display";
import { HOOK_HARNESSES, hooksStatus, planHooks } from "../../harness/hooks";
import { parseJsonBody } from "../../local-server/body";
import { badRequest, HttpError, notFound, sendJson } from "../../local-server/errors";
import { assertRealDirectory, openRegularFile } from "../../local-server/paths";
import { serveOpenFile } from "../../local-server/range";
import type { ConsoleActions, ConsoleDataSource } from "../data";
import { readConsoleDocument } from "../documents";
import { githubRepo } from "../github";
import { resolveMedia, serveMedia } from "../media";
import type { SseHub } from "../sse";
import type { ThumbnailService } from "../thumbs";
import type { projectSettings } from "../project-settings";
import { isProject } from "../view/build";
import { projectPaths } from "../view/files";

const EMPTY_QUERY = z.strictObject({});

export interface RouteContext {
  rootDir: string;
  source: ConsoleDataSource;
  actions: ConsoleActions;
  sse: SseHub;
  thumbs: ThumbnailService;
  settings: ReturnType<typeof projectSettings>;
}

/** A strict query object: every key once, parsed by `schema` (400 on failure). */
export function parseQuery<S extends z.ZodType>(query: URLSearchParams, schema: S): z.infer<S> {
  const object: Record<string, string> = {};
  for (const [key, value] of query) {
    if (key in object) throw badRequest(`Repeated query parameter ${key}`);
    object[key] = value;
  }
  const parsed = schema.safeParse(object);
  if (!parsed.success) throw new HttpError(400, "VALIDATION", parsed.error.issues[0]?.message ?? "Invalid query");
  return parsed.data;
}

/** A valid, non-reserved id of an existing, non-symlinked project folder. */
export function requireProject(rootDir: string, project: string | undefined): string {
  if (!project || !ProjectIdSchema.safeParse(project).success) throw badRequest("Invalid project id");
  if (isReservedProjectId(project)) throw badRequest(reservedProjectReason(project));
  try {
    assertRealDirectory(path.join(rootDir, PROJECTS_DIR), "Projects directory");
    assertRealDirectory(path.join(rootDir, PROJECTS_DIR, project), "Project");
  } catch (error) {
    if (error instanceof HttpError && error.status === 404)
      throw notFound(`Project ${project} not found`, "PROJECT_NOT_FOUND");
    throw error;
  }
  return project;
}

function requireListedProject(rootDir: string, id: string | undefined): string {
  const project = requireProject(rootDir, id);
  if (!isProject(projectPaths(rootDir, project))) throw notFound(`Project ${project} not found`, "PROJECT_NOT_FOUND");
  return project;
}

/** Handles a GET or HEAD read; false when no route matches. */
export async function handleRead(
  req: IncomingMessage,
  res: ServerResponse,
  segments: string[],
  query: URLSearchParams,
  context: RouteContext,
): Promise<boolean> {
  const [first, second, third, fourth, ...rest] = segments;
  const head = req.method === "HEAD";
  if (first === "media" || first === "thumb") {
    const project = second ?? "";
    const media = resolveMedia(context.rootDir, project, segments.slice(2));
    if (first === "media") {
      if (query.size) throw badRequest("Media takes no query");
      serveMedia(req, res, media);
      return true;
    }
    const options = parseQuery(query, ThumbQuerySchema);
    const file = await context.thumbs.thumbnail(media, options);
    const opened = openRegularFile(file);
    serveOpenFile(req, res, { fd: opened.fd, size: opened.size, contentType: "image/jpeg" });
    return true;
  }
  if (first !== "api" || head) return false;
  if (second === "projects" && third === undefined) {
    parseQuery(query, EMPTY_QUERY);
    sendJson(res, 200, await context.source.listProjects());
    return true;
  }
  if (second === "projects" && fourth === "view" && !rest.length) {
    const project = requireProject(context.rootDir, third);
    const view = await context.source.view(project);
    if (!view) throw notFound(`Project ${project} not found`, "PROJECT_NOT_FOUND");
    sendJson(res, 200, view);
    return true;
  }
  if (second === "projects" && fourth === "document" && !rest.length) {
    const project = requireProject(context.rootDir, third);
    sendJson(res, 200, readConsoleDocument(context.rootDir, project, parseQuery(query, ConsoleDocumentLocatorSchema)));
    return true;
  }
  if (second === "projects" && fourth === "events" && !rest.length) {
    const project = requireProject(context.rootDir, third);
    sendJson(res, 200, await context.source.events(project, parseQuery(query, EventsQuerySchema)));
    return true;
  }
  if (second === "projects" && fourth === "studio" && !rest.length) {
    const project = requireProject(context.rootDir, third);
    parseQuery(query, EMPTY_QUERY);
    if (!context.actions.studioStatus)
      throw new HttpError(501, "NOT_IMPLEMENTED", "Remotion Studio is not available from this server.");
    sendJson(res, 200, await context.actions.studioStatus(project));
    return true;
  }
  if (second === "hooks" && third === undefined) {
    parseQuery(query, EMPTY_QUERY);
    sendJson(res, 200, hooksView(context.rootDir));
    return true;
  }
  if (second === "github" && third === undefined) {
    parseQuery(query, EMPTY_QUERY);
    sendJson(res, 200, await githubRepo());
    return true;
  }
  if (second === "metrics" && third === undefined) {
    parseQuery(query, EMPTY_QUERY);
    if (!context.source.metrics)
      throw new HttpError(501, "NOT_IMPLEMENTED", "Metrics are not implemented by this server.");
    sendJson(res, 200, await context.source.metrics());
    return true;
  }
  if (second === "stream" && third === undefined) {
    const { project } = parseQuery(query, StreamQuerySchema);
    if (project) requireProject(context.rootDir, project);
    context.sse.open(req, res, project);
    return true;
  }
  return false;
}

/** `GET /api/hooks` (§7.1 H3): this checkout's hooks status and what an install would do, read in-process. */
export function hooksView(rootDir: string) {
  return HooksResponseSchema.parse({
    v: 1,
    status: hooksStatus(rootDir),
    command: HOOKS_INSTALL_COMMAND,
    plan: HOOK_HARNESSES.map((harness) => {
      const plan = planHooks(rootDir, harness);
      return {
        harness: plan.harness,
        file: plan.file,
        action: plan.action,
        ...(plan.conflict ? { conflict: plan.conflict.slice(0, 1000) } : {}),
      };
    }),
  });
}

/** Handles a POST action (already CSRF-checked); false when no route matches. */
/** `POST …/decisions` query: only `dryRun=1` (a preview of the argv, nothing runs). */
const DECIDE_QUERY = z.strictObject({ dryRun: z.literal("1").optional() });

export async function handleAction(
  req: IncomingMessage,
  res: ServerResponse,
  segments: string[],
  context: RouteContext,
  query: URLSearchParams = new URLSearchParams(),
): Promise<boolean> {
  const [first, second, third, fourth, fifth, sixth, ...rest] = segments;
  if (first === "api" && second === "hooks" && third === "install" && fourth === undefined) {
    parseQuery(query, EMPTY_QUERY);
    await parseJsonBody(req, EMPTY_QUERY);
    if (!context.actions.installHooks)
      throw new HttpError(501, "NOT_IMPLEMENTED", "Installing hooks is not implemented by this server.");
    sendJson(res, 200, await context.actions.installHooks());
    return true;
  }
  if (first !== "api" || second !== "projects" || rest.length) return false;
  if (fourth === "rename" && fifth === undefined) {
    parseQuery(query, EMPTY_QUERY);
    const { title } = await parseJsonBody(req, ProjectRenameSchema);
    const project = requireListedProject(context.rootDir, third);
    sendJson(res, 200, context.settings.rename(project, title));
    return true;
  }
  if (fourth === "remove" && fifth === undefined) {
    parseQuery(query, EMPTY_QUERY);
    const { confirm } = await parseJsonBody(req, ProjectRemovalSchema);
    const project = requireListedProject(context.rootDir, third);
    if (confirm !== project) throw badRequest("Enter the exact project ID to confirm deletion.", "VALIDATION");
    const result = await context.settings.remove(project);
    context.source.forgetProject?.(project);
    context.sse.close(project);
    sendJson(res, 200, result);
    return true;
  }
  if (fourth === "document" && fifth === undefined) {
    const project = requireProject(context.rootDir, third);
    parseQuery(query, EMPTY_QUERY);
    const request = await parseJsonBody(req, ConsoleDocumentSaveSchema, 6 * DOCUMENT_EDIT_LIMIT + 1024);
    if (!context.actions.saveDocument) throw new HttpError(501, "NOT_IMPLEMENTED", "Document editing is unavailable.");
    sendJson(res, 200, await context.actions.saveDocument(project, request));
    return true;
  }
  if (fourth === "decisions" && fifth === undefined) {
    const project = requireProject(context.rootDir, third);
    const { dryRun } = parseQuery(query, DECIDE_QUERY);
    const request = await parseJsonBody(req, DecisionRequestSchema);
    sendJson(res, 200, await context.actions.decide(project, request, dryRun ? { dryRun: true } : {}));
    return true;
  }
  if (fourth === "control" && fifth === undefined) {
    const project = requireProject(context.rootDir, third);
    const request = await parseJsonBody(req, ControlRequestSchema);
    sendJson(res, 200, await context.actions.control(project, request));
    return true;
  }
  if (fourth === "jobs" && sixth === "cancel") {
    const project = requireProject(context.rootDir, third);
    if (!fifth || !OperationIdSchema.safeParse(fifth).success) throw badRequest("Invalid job id");
    const request = await parseJsonBody(req, JobCancelRequestSchema);
    if (!context.actions.cancelJob)
      throw new HttpError(501, "NOT_IMPLEMENTED", "Cancelling a job is not implemented by this server.");
    sendJson(res, 200, await context.actions.cancelJob(project, fifth, request));
    return true;
  }
  if (fourth === "studio" && (fifth === undefined || (fifth === "stop" && sixth === undefined))) {
    const project = requireProject(context.rootDir, third);
    parseQuery(query, EMPTY_QUERY);
    if (fifth === "stop") {
      await parseJsonBody(req, EMPTY_QUERY);
      if (!context.actions.stopStudio)
        throw new HttpError(501, "NOT_IMPLEMENTED", "Stopping Studio is not implemented by this server.");
      sendJson(res, 200, await context.actions.stopStudio(project));
      return true;
    }
    const request = await parseJsonBody(req, StudioOpenRequestSchema);
    if (!context.actions.openStudio)
      throw new HttpError(501, "NOT_IMPLEMENTED", "Opening Remotion Studio is not implemented by this server.");
    sendJson(res, 200, await context.actions.openStudio(project, request));
    return true;
  }
  if (fourth === "cards" && sixth === "answer") {
    const project = requireProject(context.rootDir, third);
    if (!fifth || !ConsoleIdSchema.safeParse(fifth).success) throw badRequest("Invalid card id");
    const answer = await parseJsonBody(req, CardAnswerRequestSchema);
    sendJson(res, 200, await context.actions.answerCard(project, fifth, answer));
    return true;
  }
  return false;
}
