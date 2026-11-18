import { z } from "zod";
import { digest } from "../jobs/model-artifacts";

export const STATIC_TREE_PROFILE = "static-local-tree-v1" as const;
export const STATIC_TREE_LIMITS = Object.freeze({
  depth: 3,
  children: 16,
  hosts: 32,
  childBytes: 128 * 1024,
  totalBytes: 2 * 1024 * 1024,
  rootBytes: 1024 * 1024,
  media: 8,
});
const id = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/);
const finite = z.number().finite().nonnegative().max(36001);
export const StaticTreeHostSchema = z
  .object({
    id,
    parentId: id.nullable(),
    src: z.string().min(1).max(200),
    start: finite,
    duration: z.number().finite().positive().max(36001),
    inPoint: finite.default(0),
    authored: z
      .object({ start: z.string().nullable(), duration: z.string(), inPoint: z.string().nullable() })
      .strict()
      .optional(),
  })
  .strict();
export const StaticTreeDocumentSchema = z
  .object({
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    bytes: z.number().int().safe().nonnegative(),
    rootId: id.nullable(),
    rootAttributes: z.record(z.string(), z.string().nullable()).optional(),
    rootDuration: z.number().finite().positive().max(36001).nullable(),
    hosts: z.array(StaticTreeHostSchema).max(32),
    mediaCount: z.number().int().nonnegative().max(8),
    unsupported: z.array(z.string().min(1).max(100)).max(32),
  })
  .strict();
export const StaticTreeInputSchema = z
  .object({ root: StaticTreeDocumentSchema, assets: z.record(z.string(), StaticTreeDocumentSchema) })
  .strict()
  .refine((value) => Object.keys(value.assets).length <= 128, "Static tree snapshot count bound");
export type StaticTreeDocument = z.infer<typeof StaticTreeDocumentSchema>;
export interface StaticTreeNode {
  id: string;
  parentId: string;
  source: string;
  sourceSha256: string;
  depth: number;
  start: number;
  duration: number;
  inPoint: number;
  origin: number;
  windowStart: number;
  windowEnd: number;
  authored?: { start: string | null; duration: string; inPoint: string | null };
}

/** Root-document-relative literal names only. No URL normalization or guessed directory base. */
export function staticTreeSourceName(raw: string): string {
  if (!/^(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.html$/.test(raw))
    throw Error("Static tree requires literal root-relative allowlisted HTML source");
  return raw;
}
/** Pure structural validation. Records must come from inert DOM extraction, never caller-authored receipts. */
export function validateStaticCompositionTree(raw: unknown) {
  const input = StaticTreeInputSchema.parse(raw),
    limits = STATIC_TREE_LIMITS,
    rootId = input.root.rootId;
  if (!rootId || input.root.rootDuration === null) throw Error("Static tree requires one authored root composition");
  if (input.root.bytes > limits.rootBytes) throw Error("Static tree root byte bound");
  let totalBytes = input.root.bytes,
    mediaCount = input.root.mediaCount;
  const nodes: StaticTreeNode[] = [],
    ids = new Set([rootId]),
    visited = new Set<string>(),
    sources: { name: string; sha256: string; bytes: number }[] = [];
  const visit = (
    document: StaticTreeDocument,
    parentId: string,
    depth: number,
    parentOrigin: number,
    parentWindow: { start: number; end: number },
    stack: Set<string>,
  ) => {
    if (document.unsupported.length)
      throw Error("Static tree unsupported document contract: " + document.unsupported.join(","));
    if (document.rootId !== null && document.rootId !== parentId)
      throw Error("Static tree child authored root differs from host");
    for (const host of document.hosts) {
      if (host.parentId !== document.rootId)
        throw Error("Static tree external host must belong to document root, not another unresolved host");
      if (ids.has(host.id)) throw Error("Static tree duplicate composition id");
      ids.add(host.id);
      if (ids.size > limits.hosts) throw Error("Static tree host count bound");
      const name = staticTreeSourceName(host.src);
      if (stack.has(name)) throw Error("Static tree cycle");
      if (visited.has(name)) throw Error("Static tree repeated source instance unsupported");
      if (!Object.hasOwn(input.assets, name)) throw Error("Static tree source outside snapshot allowlist");
      if (depth + 1 > limits.depth) throw Error("Static tree external depth bound");
      const child = input.assets[name]!;
      if (child.bytes > limits.childBytes) throw Error("Static tree child byte bound");
      totalBytes += child.bytes;
      if (totalBytes > limits.totalBytes) throw Error("Static tree aggregate byte bound");
      visited.add(name);
      if (visited.size > limits.children) throw Error("Static tree child count bound");
      mediaCount += child.mediaCount;
      if (mediaCount > limits.media) throw Error("Static tree media count bound");
      const start = parentOrigin + host.start,
        end = start + host.duration,
        origin = start - host.inPoint;
      if (![start, end, origin].every(Number.isFinite)) throw Error("Static tree timing overflow");
      const windowStart = Math.max(parentWindow.start, start),
        windowEnd = Math.min(parentWindow.end, end);
      if (windowStart < 0 || windowEnd <= windowStart) throw Error("Static tree empty/out-of-parent host window");
      nodes.push({
        id: host.id,
        parentId,
        source: name,
        sourceSha256: child.sha256,
        depth: depth + 1,
        start: host.start,
        duration: host.duration,
        inPoint: host.inPoint,
        origin,
        windowStart,
        windowEnd,
        ...(host.authored ? { authored: host.authored } : {}),
      });
      sources.push({ name, sha256: child.sha256, bytes: child.bytes });
      visit(child, host.id, depth + 1, origin, { start: windowStart, end: windowEnd }, new Set([...stack, name]));
    }
  };
  visit(input.root, rootId, 0, 0, { start: 0, end: input.root.rootDuration }, new Set());
  const graph = {
    profile: STATIC_TREE_PROFILE,
    rootId,
    rootAttributes: input.root.rootAttributes,
    rootDuration: input.root.rootDuration,
    rootSha256: input.root.sha256,
    nodes,
    sources,
    totalBytes,
    mediaCount,
    hostCount: ids.size,
    limits,
  };
  return { ...graph, graphSha256: digest(JSON.stringify(graph)) };
}

/** Post-bootstrap genuine media cache descriptors must fit EVERY ancestor slot, not just in-points. */
export function validateTreeMediaWindow(
  graph: ReturnType<typeof validateStaticCompositionTree>,
  ancestorIds: string[],
  start: number,
  end: number,
) {
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start)
    throw Error("Static tree invalid native media window");
  if (!ancestorIds.length || ancestorIds[0] !== graph.rootId || ancestorIds.length > graph.limits.depth + 1)
    throw Error("Static tree media requires exact root-to-host ancestor chain");
  if (end > graph.rootDuration) throw Error("Static tree native media outside root window");
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const seen = new Set<string>();
  let parentId = graph.rootId;
  for (const id of ancestorIds.slice(1)) {
    if (seen.has(id)) throw Error("Static tree duplicate media ancestor");
    seen.add(id);
    const host = byId.get(id);
    if (!host) throw Error("Static tree unknown media ancestor");
    if (host.parentId !== parentId) throw Error("Static tree media ancestor chain mismatch");
    parentId = id;
    if (start < host.windowStart || end > host.windowEnd)
      throw Error("Static tree native media outside ancestor window");
  }
}

/** Read an already inert DOMParser document; does not mount nodes, run scripts or fetch. */
export function extractStaticTreeDocument(
  document: Document,
  sha256: string,
  bytes: number,
  allowedAssets?: string[],
): StaticTreeDocument {
  const unsupported: string[] = [];
  if (allowedAssets) {
    const allowed = new Set(allowedAssets);
    const check = (raw: string) => {
      if (/[\\%?#:]/.test(raw) || !allowed.has(raw))
        throw Error("Static tree resource outside exact local snapshot allowlist");
    };
    for (const element of document.querySelectorAll("[src],[href]"))
      for (const name of ["src", "href"]) {
        const value = element.getAttribute(name);
        if (value !== null) check(value);
      }
    for (const element of document.querySelectorAll("style,[style]")) {
      const css =
        element.tagName.toLowerCase() === "style" ? (element.textContent ?? "") : (element.getAttribute("style") ?? "");
      if (/@import/i.test(css)) throw Error("Static tree CSS imports unsupported");
      for (const match of css.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/gi)) check(match[1].trim());
    }
  }
  if (document.querySelector("[data-composition-id][data-end],[data-composition-src][data-end]"))
    unsupported.push("composition end attributes unsupported");
  if (document.querySelector("[data-hf-authored-duration],[data-hf-authored-end]"))
    unsupported.push("authored private timing attributes unsupported");
  if (
    document.querySelector(
      "base,meta[http-equiv],[srcset],[imagesrcset],[background],[action],[formaction],[ping],[codebase],[archive],template,iframe,object,embed,canvas,animate,animateTransform,animateMotion,set,[data-no-timeline]",
    )
  )
    unsupported.push("template/iframe/clockless/GPU document unsupported");
  if (document.querySelector('script[src],script[type="module"],script[type="importmap"]'))
    unsupported.push("external/module scripts unsupported");
  const compositionElements = [...document.querySelectorAll("[data-composition-id],[data-composition-src]")];
  const roots = compositionElements.filter((element) => !element.hasAttribute("data-composition-src"));
  if (roots.length > 1) unsupported.push("multiple/inline composition roots unsupported");
  const root = roots[0],
    rootId = root?.getAttribute("data-composition-id") ?? null;
  const number = (element: Element, name: string, optional = false) => {
    const raw = element.getAttribute(name);
    if (raw === null && optional) return 0;
    if (raw === null || !/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(raw))
      throw Error("Static tree requires literal nonnegative numeric " + name);
    const value = Number(raw);
    if (!Number.isFinite(value) || value > 36001) throw Error("Static tree numeric timing outside bounds");
    return value;
  };
  const rootDuration = root ? number(root, "data-duration") : null;
  const hosts = compositionElements
    .filter((element) => element.hasAttribute("data-composition-src"))
    .map((element) => ({
      id: element.getAttribute("data-composition-id") ?? "",
      parentId:
        element.parentElement
          ?.closest("[data-composition-id],[data-composition-src]")
          ?.getAttribute("data-composition-id") ?? null,
      src: element.getAttribute("data-composition-src") ?? "",
      start: number(element, "data-start", true),
      duration: number(element, "data-duration"),
      inPoint: number(element, "data-media-start", true),
      authored: {
        start: element.getAttribute("data-start"),
        duration: element.getAttribute("data-duration")!,
        inPoint: element.getAttribute("data-media-start"),
      },
    }));
  const rootAttributes = root
    ? Object.fromEntries(
        [
          "data-composition-id",
          "data-composition-src",
          "data-start",
          "data-duration",
          "data-end",
          "data-media-start",
          "data-width",
          "data-height",
          "data-fps",
        ].map((name) => [name, root.getAttribute(name)]),
      )
    : undefined;
  return {
    sha256,
    bytes,
    rootId,
    rootAttributes,
    rootDuration,
    hosts,
    mediaCount: document.querySelectorAll("video,audio").length,
    unsupported,
  };
}

/** Private bounded worker traversal; extraction callback runs inert browser parsing, not project code. */
export async function preflightStaticCompositionTree(
  rootHtml: string,
  children: Record<string, string>,
  extract: (html: string, sha256: string, bytes: number) => Promise<StaticTreeDocument>,
) {
  const limits = STATIC_TREE_LIMITS;
  if (Buffer.byteLength(rootHtml) > limits.rootBytes) throw Error("Static tree root byte bound");
  const read = async (html: string) => {
    const sha256 = digest(html),
      bytes = Buffer.byteLength(html),
      record = StaticTreeDocumentSchema.parse(await extract(html, sha256, bytes));
    if (record.sha256 !== sha256 || record.bytes !== bytes) throw Error("Static tree extracted source pin differs");
    if (record.unsupported.length)
      throw Error("Static tree unsupported document contract: " + record.unsupported.join(","));
    return record;
  };
  const root = await read(rootHtml);
  if (root.rootAttributes?.["data-start"] !== "0")
    throw Error('Static tree requires explicit root data-start=\"0\" before authored execution');
  const assets: Record<string, StaticTreeDocument> = {};
  let total = Buffer.byteLength(rootHtml);
  const queue = root.hosts.map((host) => host.src);
  while (queue.length) {
    const name = staticTreeSourceName(queue.shift()!);
    if (Object.hasOwn(assets, name)) continue;
    if (Object.keys(assets).length >= limits.children) throw Error("Static tree child count bound");
    if (!Object.hasOwn(children, name) || typeof children[name] !== "string")
      throw Error("Static tree source outside snapshot allowlist");
    const html = children[name]!,
      bytes = Buffer.byteLength(html);
    if (bytes > limits.childBytes) throw Error("Static tree child byte bound");
    total += bytes;
    if (total > limits.totalBytes) throw Error("Static tree aggregate byte bound");
    const record = await read(html);
    assets[name] = record;
    queue.push(...record.hosts.map((host) => host.src));
    if (queue.length > limits.children * limits.hosts) throw Error("Static tree traversal queue bound");
  }
  return validateStaticCompositionTree({ root, assets });
}
