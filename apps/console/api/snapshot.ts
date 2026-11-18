/**
 * Snapshot mode (RFC 0004 WP15, D18): the console as a static, read-only page written by `pnpm console:snapshot`. The
 * page carries one project's view and home row in `<script type="application/json" id="agentbros-snapshot">`; this
 * client serves them from memory, has no journal, no stream and no library, and refuses every action. No request
 * leaves the page.
 */
import {
  ProjectSummarySchema,
  ProjectViewSchema,
  type ProjectSummary,
  type ProjectView,
  type ProjectsResponse,
} from "@contract";
import { z } from "zod";
import { ApiFailure } from "./errors";
import type { ApiClient } from "./types";

export const SNAPSHOT_ELEMENT_ID = "agentbros-snapshot";

export const SnapshotDataSchema = z.strictObject({
  v: z.literal(1),
  takenAt: z.iso.datetime({ offset: true }),
  view: ProjectViewSchema,
  summary: ProjectSummarySchema,
});
export type SnapshotData = z.infer<typeof SnapshotDataSchema>;

/** The embedded snapshot of a document, or undefined when the page is not a snapshot (or its data does not parse). */
export function readSnapshot(doc: Document): SnapshotData | undefined {
  const element = doc.getElementById(SNAPSHOT_ELEMENT_ID);
  if (!element || element.getAttribute("type") !== "application/json") return undefined;
  try {
    const parsed = SnapshotDataSchema.safeParse(JSON.parse(element.textContent ?? ""));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

const readOnly = () => new ApiFailure("READ_ONLY", "This is a read-only snapshot: nothing can be changed here.", 405);
const clone = <T>(value: T): T => structuredClone(value);

export class SnapshotApiClient implements ApiClient {
  readonly mode = "snapshot" as const;
  private readonly snapshot: ProjectView;
  private readonly summary: ProjectSummary;

  constructor(readonly data: SnapshotData) {
    this.snapshot = data.view;
    this.summary = data.summary;
  }

  get project(): string {
    return this.snapshot.project.id;
  }

  async start(): Promise<void> {}

  async projects(): Promise<ProjectsResponse> {
    return { v: 1, projects: [clone(this.summary)], waiting: clone(this.snapshot.waiting) };
  }

  async view(project: string): Promise<ProjectView> {
    if (project !== this.snapshot.project.id)
      throw new ApiFailure("PROJECT_NOT_FOUND", `This snapshot holds ${this.snapshot.project.id} only`, 404);
    return clone(this.snapshot);
  }

  async events() {
    return { v: 1 as const, events: [], next: null };
  }

  async decide(): Promise<never> {
    throw readOnly();
  }

  async control(): Promise<never> {
    throw readOnly();
  }

  async answerCard(): Promise<never> {
    throw readOnly();
  }

  subscribe() {
    return () => {};
  }
}
