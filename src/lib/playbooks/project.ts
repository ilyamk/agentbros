/** Loading a playbook and binding a project to one (`pipeline/playbook.json`). */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { CliErrorObject } from "../cli";
import { PlaybookSchema, ProjectPlaybookSchema, type Playbook, type ProjectPlaybook } from "../../types/playbook";

export const PLAYBOOKS_DIR = "playbooks";

/**
 * Playbooks are harness, so they are read from the checkout that holds this code, never from the working directory or a
 * project's parent: the CLI, `next`, `film:init`, `footage:next` and the MCP bridge (whose cwd is its workspace root) all
 * see the same set. `AGENTBROS_PLAYBOOKS_ROOT` points tests at fixture playbooks.
 */
export const CHECKOUT_ROOT = path.resolve(import.meta.dirname, "..", "..", "..");
export const playbooksRoot = (): string => process.env["AGENTBROS_PLAYBOOKS_ROOT"] || CHECKOUT_ROOT;

export const playbookDir = (id: string, root = playbooksRoot()) => path.join(root, PLAYBOOKS_DIR, id);
export const playbookGuide = (id: string) => `${PLAYBOOKS_DIR}/${id}/AGENTS.md`;

export function listPlaybookIds(root = playbooksRoot()): string[] {
  const dir = path.join(root, PLAYBOOKS_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(path.join(dir, entry.name, "playbook.json")))
    .map((entry) => entry.name)
    .sort();
}

/** Throws when the playbook is missing or invalid. */
export function loadPlaybook(id: string, root = playbooksRoot()): Playbook {
  const file = path.join(playbookDir(id, root), "playbook.json");
  if (!existsSync(file))
    throw new Error(`Unknown playbook "${id}". Known: ${listPlaybookIds(root).join(", ") || "none"}.`);
  const playbook = PlaybookSchema.parse(JSON.parse(readFileSync(file, "utf8")));
  if (playbook.id !== id) throw new Error(`${file}: id "${playbook.id}" differs from its folder "${id}".`);
  return playbook;
}

export const projectPlaybookFile = (projectDir: string) => path.join(projectDir, "pipeline", "playbook.json");

/** The binding file read as it is: absent, a valid binding, or a warning saying why it cannot be used. */
export function readProjectBinding(
  projectDir: string,
  root = playbooksRoot(),
): { binding?: ProjectPlaybook; warning?: string } {
  const file = projectPlaybookFile(projectDir);
  if (!existsSync(file)) return {};
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    return {
      warning: `pipeline/playbook.json is invalid: not JSON (${(error as Error).message}). Fix or rebind it: pnpm playbook --use <id> --project ${path.basename(projectDir)} --force`,
    };
  }
  const parsed = ProjectPlaybookSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    return {
      warning: `pipeline/playbook.json is invalid: ${issues}. Fix or rebind it: pnpm playbook --use <id> --project ${path.basename(projectDir)} --force`,
    };
  }
  if (!listPlaybookIds(root).includes(parsed.data.id))
    return {
      binding: parsed.data,
      warning: `pipeline/playbook.json names unknown playbook "${parsed.data.id}". Known: ${listPlaybookIds(root).join(", ")}.`,
    };
  return { binding: parsed.data };
}

/** The project's binding when it is valid; undefined when it has none or the file is invalid (readProjectBinding says why). */
export const readProjectPlaybook = (projectDir: string): ProjectPlaybook | undefined => {
  const { binding } = readProjectBinding(projectDir);
  return binding;
};

/** Why binding `id` would replace another choice, or undefined when it is safe (no binding, or the same playbook). */
export function bindingConflict(projectDir: string, id: string): string | undefined {
  const { binding, warning } = readProjectBinding(projectDir);
  if (binding?.id === id) return undefined;
  if (binding)
    return `${path.basename(projectDir)} is already bound to playbook ${binding.id} (chosen by the ${binding.by} at ${binding.chosenAt}).`;
  return warning;
}

/**
 * Binds the project. The same playbook again keeps the first `chosenAt` and never downgrades a user's choice to the agent's;
 * a different playbook, or an unreadable binding, is refused (FILE_EXISTS) unless `force` is set for a deliberate rebind.
 */
export function writeProjectPlaybook(
  projectDir: string,
  id: string,
  by: ProjectPlaybook["by"],
  root = playbooksRoot(),
  options: { force?: boolean } = {},
): ProjectPlaybook {
  loadPlaybook(id, root);
  const conflict = options.force ? undefined : bindingConflict(projectDir, id);
  if (conflict) {
    throw new CliErrorObject({
      code: "FILE_EXISTS",
      message: `${conflict} Not rebinding to ${id}. Ask the user; rebind deliberately with pnpm playbook --use ${id} --project ${path.basename(projectDir)} --force.`,
    });
  }
  const existing = readProjectPlaybook(projectDir);
  const same = existing?.id === id ? existing : undefined;
  const binding: ProjectPlaybook = {
    version: 1,
    id,
    chosenAt: same?.chosenAt ?? new Date().toISOString(),
    by: same?.by === "user" ? "user" : by,
  };
  if (same && same.by === binding.by) return same;
  mkdirSync(path.dirname(projectPlaybookFile(projectDir)), { recursive: true });
  writeFileSync(projectPlaybookFile(projectDir), `${JSON.stringify(binding, null, 2)}\n`);
  return binding;
}

/** A playbook's files for one step: its AGENTS.md, its `read` files, then that step's `stepRead` files (none without a step). */
export function playbookStepFiles(playbook: Playbook, step?: string | null): string[] {
  const scoped = step ? (playbook.stepRead?.[step] ?? []) : [];
  return [...new Set([playbookGuide(playbook.id), ...playbook.read, ...scoped])];
}

/**
 * What an agent reads for a bound project at `step`, first: the playbook's method, then its extra files. Empty when
 * unbound; an unusable binding returns `warning` instead of looking unbound.
 */
export function playbookRead(
  projectDir: string,
  root = playbooksRoot(),
  step?: string | null,
): { playbook?: { id: string; title: string }; read: string[]; warning?: string } {
  const { binding, warning } = readProjectBinding(projectDir, root);
  if (warning || !binding) return { read: [], ...(warning ? { warning } : {}) };
  try {
    const playbook = loadPlaybook(binding.id, root);
    return { playbook: { id: playbook.id, title: playbook.title }, read: playbookStepFiles(playbook, step) };
  } catch (error) {
    return { read: [], warning: `playbooks/${binding.id}/playbook.json cannot be loaded: ${(error as Error).message}` };
  }
}
