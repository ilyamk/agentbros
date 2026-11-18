import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { ARTEFACT_SCHEMAS, FILM_CHAIN, stepById, type ArtefactSchemaId } from "./chain";
import { absentOutputs } from "./routes";
import { CliErrorObject } from "../cli";
import { deriveChain, fill, type FilmProject, type Tokens } from "./state";

/**
 * film:show: a compact, read-only digest of a step's inputs and outputs, or of one artefact, so an agent sees a JSON
 * file's shape and the fields it needs without writing a script to print it. Bounded: strings are cut, arrays show
 * their length and first item, objects their first keys, and a digest that is still too large is taken one level
 * shallower until it fits.
 */

export const SHOW_LIMITS = {
  /** Characters of a string value before it is cut. */
  string: 120,
  /** Keys of an object shown before "+N keys". */
  keys: 24,
  /** Array items a --fields path maps over. */
  items: 20,
  /** Bytes of one file's digest in a step listing, and of a single --artefact. */
  stepFileBytes: 2048,
  artefactBytes: 12288,
  /** Names listed for a directory. */
  entries: 20,
} as const;

export type FileDigest = {
  path: string;
  what?: string;
  exists: boolean;
  kind?: "json" | "markdown" | "text" | "media" | "directory";
  bytes?: number;
  schema?: ArtefactSchemaId;
  valid?: boolean;
  issue?: string;
  /** The depth the digest was taken at, after shrinking to fit. */
  depth?: number;
  digest?: unknown;
  fields?: Record<string, unknown>;
  /** A path with a token the project cannot fill yet, such as {previousCritique}. */
  unresolved?: boolean;
};

export type ShowOptions = { fields?: string[]; depth?: number };

const MEDIA = /\.(mp4|mov|webm|wav|mp3|m4a|aac|flac|png|jpe?g|webp|gif|exr|glb|gltf|blend)$/i;

const cut = (text: string, limit: number) =>
  text.length <= limit ? text : `${text.slice(0, limit)}…(+${text.length - limit} chars)`;

/** A value's shape to `depth` object levels: strings cut, arrays as {array: length, first} (the first item at the same depth), objects with their first keys. */
export function digestValue(value: unknown, depth: number, strings: number = SHOW_LIMITS.string): unknown {
  if (typeof value === "string") return cut(value, strings);
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    if (depth <= 0 || !value.length) return `array(${value.length})`;
    return { array: value.length, first: digestValue(value[0], depth, strings) };
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (depth <= 0) return `object(${entries.length} keys)`;
  const out: Record<string, unknown> = {};
  for (const [key, item] of entries.slice(0, SHOW_LIMITS.keys)) out[key] = digestValue(item, depth - 1, strings);
  if (entries.length > SHOW_LIMITS.keys) out["…"] = `+${entries.length - SHOW_LIMITS.keys} keys`;
  return out;
}

const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value) ?? "");

/** The deepest digest at or above `depth` that fits `cap` bytes; strings shorten before depth 0. */
export function boundedDigest(value: unknown, depth: number, cap: number): { depth: number; digest: unknown } {
  for (let level = depth; level >= 0; level--) {
    const digest = digestValue(value, level);
    if (size(digest) <= cap) return { depth: level, digest };
  }
  return { depth: 0, digest: digestValue(value, 0, 40) };
}

/** A dot path into JSON: a number indexes an array, any other segment (or *) maps over it. */
export function pick(value: unknown, field: string): unknown {
  const walk = (current: unknown, segments: string[]): unknown => {
    if (!segments.length || current === undefined) return current;
    const [head, ...rest] = segments as [string, ...string[]];
    if (Array.isArray(current)) {
      if (/^\d+$/.test(head)) return walk(current[Number(head)], rest);
      const items = current.slice(0, SHOW_LIMITS.items).map((item) => walk(item, head === "*" ? rest : segments));
      return current.length > SHOW_LIMITS.items ? [...items, `+${current.length - SHOW_LIMITS.items} items`] : items;
    }
    if (current !== null && typeof current === "object") return walk((current as Record<string, unknown>)[head], rest);
    return undefined;
  };
  return walk(value, field.split(".").filter(Boolean));
}

function markdownDigest(text: string) {
  const lines = text.split("\n");
  const headings = lines.filter((line) => /^#{1,4} /.test(line)).map((line) => cut(line, SHOW_LIMITS.string));
  return {
    lines: lines.length,
    headings: headings.slice(0, 40),
    ...(headings.length > 40 ? { moreHeadings: headings.length - 40 } : {}),
  };
}

/** One file or directory, root-relative. `schema` validates JSON; `cap` bounds the digest. */
export function digestFile(
  rootDir: string,
  relative: string,
  options: ShowOptions & { schema?: ArtefactSchemaId | null; what?: string; cap?: number; defaultDepth?: number } = {},
): FileDigest {
  const file = path.join(rootDir, relative);
  const head = { path: relative, ...(options.what ? { what: options.what } : {}) };
  if (!existsSync(file)) return { ...head, exists: false };
  const stat = statSync(file);
  if (stat.isDirectory()) {
    const names = readdirSync(file).sort();
    return {
      ...head,
      exists: true,
      kind: "directory",
      digest: {
        entries: names.length,
        names: names.slice(0, SHOW_LIMITS.entries),
      },
    };
  }
  const base = { ...head, exists: true, bytes: stat.size };
  if (MEDIA.test(relative)) return { ...base, kind: "media" };
  const text = readFileSync(file, "utf8");
  if (/\.md$/i.test(relative)) return { ...base, kind: "markdown", digest: markdownDigest(text) };
  if (!/\.json$/i.test(relative)) {
    const lines = text.split("\n");
    return {
      ...base,
      kind: "text",
      digest: { lines: lines.length, first: lines.slice(0, 3).map((line) => cut(line, 120)) },
    };
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return { ...base, kind: "json", valid: false, issue: `not JSON: ${(error as Error).message}` };
  }
  const cap = options.cap ?? SHOW_LIMITS.stepFileBytes;
  const schema = options.schema ?? undefined;
  const checked = schema ? ARTEFACT_SCHEMAS[schema].safeParse(value) : undefined;
  const issue = checked && !checked.success ? checked.error.issues[0] : undefined;
  const fields = options.fields?.length
    ? Object.fromEntries(
        options.fields.map((field) => [field, boundedDigest(pick(value, field), 2, Math.floor(cap / 2)).digest]),
      )
    : undefined;
  const { depth, digest } = boundedDigest(value, options.depth ?? options.defaultDepth ?? 1, cap);
  return {
    ...base,
    kind: "json",
    ...(schema ? { schema, valid: checked!.success } : {}),
    ...(issue ? { issue: `${issue.path.join(".") || "root"}: ${issue.message}` } : {}),
    depth,
    digest,
    ...(fields ? { fields } : {}),
  };
}

/** The schema of the chain output a filled path is, if any. */
function schemaFor(relative: string, tokens: Tokens): ArtefactSchemaId | undefined {
  for (const step of FILM_CHAIN)
    for (const output of step.outputs)
      if (output.schema && fill(output.path, tokens) === relative) return output.schema;
  return undefined;
}

/** A step's status and the digest of every input and output its film type uses. Reads only. */
export function showStep(project: FilmProject, stepId: string, options: ShowOptions = {}) {
  const step = stepById(stepId);
  if (!step) throw new CliErrorObject({ code: "INVALID_INPUT", message: `Unknown step "${stepId}".` });
  const chain = deriveChain(project);
  const { tokens } = chain;
  const absent = absentOutputs(chain.filmType, chain.secondaryFilmType);
  const state = chain.steps.find((item) => item.id === step.id);
  const listed = (items: { path: string; what: string; onlyFor?: string[]; schema?: ArtefactSchemaId | null }[]) =>
    items
      .filter((item) => !item.onlyFor || item.onlyFor.includes(chain.filmType))
      .filter((item) => !absent.has(item.path))
      .map((item): FileDigest => {
        const relative = fill(item.path, tokens);
        if (!relative) return { path: item.path, what: item.what, exists: false, unresolved: true };
        return digestFile(project.rootDir, relative, {
          ...options,
          what: item.what,
          schema: item.schema === undefined ? schemaFor(relative, tokens) : item.schema,
        });
      });
  return {
    projectId: project.id,
    step: step.id,
    status: state?.status ?? "not in this film's route",
    ...(state?.reasons.length ? { reasons: state.reasons } : {}),
    inputs: listed(step.inputs),
    outputs: listed(step.outputs),
  };
}

/** One artefact inside the project's folder or its out/<id>/ renders; anything else is refused. */
export function showArtefact(project: FilmProject, artefact: string, options: ShowOptions = {}) {
  const candidates = [path.resolve(project.rootDir, artefact), path.resolve(project.projectDir, artefact)];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found)
    throw new CliErrorObject({
      code: "INVALID_INPUT",
      message: `${artefact} does not exist (paths are relative to the repository root).`,
    });
  const real = realpathSync(found);
  const allowed = [project.projectDir, path.join(project.rootDir, "out", project.id)]
    .filter((dir) => existsSync(dir))
    .map((dir) => realpathSync(dir));
  if (!allowed.some((dir) => real === dir || real.startsWith(`${dir}${path.sep}`)))
    throw new CliErrorObject({
      code: "INVALID_INPUT",
      message: `${artefact} is outside this project's folder and out/${project.id}/: film:show reads only those.`,
    });
  const relative = path.relative(realpathSync(project.rootDir), real);
  const { tokens } = deriveChain(project);
  return {
    projectId: project.id,
    artefact: digestFile(project.rootDir, relative, {
      ...options,
      schema: schemaFor(relative, tokens),
      cap: SHOW_LIMITS.artefactBytes,
      defaultDepth: 2,
    }),
  };
}
