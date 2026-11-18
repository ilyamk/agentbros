import { z } from "zod";
import { digest } from "../jobs/model-artifacts";
import { STATIC_TREE_LIMITS, staticTreeSourceName } from "./native-composition-tree";
import { INSTANCE_PARSER_PIN, validateInstanceScript } from "./native-instance-script";

export const STATIC_INSTANCES_PROFILE = "static-local-instances-v1" as const;
const id = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/),
  time = z.number().finite().nonnegative().max(36001);
const host = z
  .object({ id, source: z.string().min(1).max(200), start: time, duration: time.positive(), inPoint: time })
  .strict();
const document = z
  .object({
    html: z.string().max(1024 * 1024),
    authoredId: id,
    duration: time.positive(),
    start: z.literal(0),
    localIds: z.array(id).max(256),
    mediaIds: z.array(id).max(8),
    script: z.string().max(32768),
    styles: z.array(z.string().max(32768)).max(32),
    hosts: z.array(host).max(16),
    unsupported: z.array(z.string().min(1).max(200)).max(32),
  })
  .strict();
const inputSchema = z
  .object({
    root: document,
    assets: z.record(z.string(), document).refine((v) => Object.keys(v).length <= 128, "Instance snapshot count bound"),
  })
  .strict();
export type InstanceGraphInput = z.infer<typeof inputSchema>;
const fail = (message: string): never => {
  throw Error("Instance graph: " + message);
};
/** Initial contract accepts literal inline declaration lists only, no stylesheet rules. */
function validateStyle(style: string) {
  const seen = new Set<string>();
  for (const declaration of style.split(";").filter((part) => part.trim())) {
    const match = /^\s*([a-z-]+)\s*:\s*([^:;]+?)\s*$/.exec(declaration);
    if (!match) return fail("unsupported literal style declaration");
    const [, key, value] = match;
    if (seen.has(key)) fail("duplicate style property");
    seen.add(key);
    if (["color", "background-color", "border-color"].includes(key)) {
      if (!/^#[a-fA-F0-9]{6}$/.test(value)) fail("unsupported literal style color");
    } else if (["width", "height", "left", "top", "padding", "border-radius"].includes(key)) {
      const number = /^(0|[1-9][0-9]*)(?:\.([0-9]+))?px$/.exec(value);
      if (!number || Number.parseFloat(value) > 8192) fail("literal style dimension bound");
    } else if (key === "opacity") {
      if (!/^(?:0(?:\.[0-9]+)?|1(?:\.0+)?)$/.test(value)) fail("literal style opacity bound");
    } else if (key === "position") {
      if (!["absolute", "relative"].includes(value)) fail("unsupported literal style position");
    } else if (key === "display") {
      if (!["block", "flex", "none"].includes(value)) fail("unsupported literal style display");
    } else if (key === "overflow") {
      if (value !== "hidden") fail("unsupported literal style overflow");
    } else fail("property outside closed style whitelist");
  }
}

/** Pure EXTRACTED RECORD validation, not an HTML parser/production preflight. */
export function validateCompositionInstances(raw: unknown) {
  const input = inputSchema.parse(raw),
    limits = STATIC_TREE_LIMITS,
    root = input.root;
  const order = ([a]: [string, unknown], [b]: [string, unknown]) => (a < b ? -1 : a > b ? 1 : 0);
  const sourceRows = Object.entries(input.assets)
    .sort(order)
    .map(([name, value]) => {
      staticTreeSourceName(name);
      const bytes = Buffer.byteLength(value.html);
      if (bytes > limits.childBytes) fail("snapshot child byte bound");
      return { name, sha256: digest(value.html), bytes };
    });
  const validateDocument = (value: typeof root, targets: string[]) => {
    if (value.unsupported.length) return fail("unsupported extracted document");
    if (
      new Set(value.localIds).size !== value.localIds.length ||
      new Set(value.mediaIds).size !== value.mediaIds.length
    )
      return fail("duplicate local identity");
    if (value.mediaIds.some((media) => !value.localIds.includes(media)))
      return fail("media identity not declared locally");
    if (value.localIds.includes(value.authoredId)) return fail("authored root/local identity collision");
    for (const style of value.styles) validateStyle(style);
    return validateInstanceScript(value.script, {
      authoredId: value.authoredId,
      ownedTargetIds: targets,
      duration: value.duration,
    });
  };
  const rootBytes = Buffer.byteLength(root.html);
  if (rootBytes > limits.rootBytes) return fail("root byte bound");
  if (rootBytes + sourceRows.reduce((total, row) => total + row.bytes, 0) > limits.totalBytes)
    fail("snapshot aggregate byte bound");
  const hostIds = root.hosts.map((h) => h.id);
  if (
    new Set(hostIds).size !== hostIds.length ||
    hostIds.includes(root.authoredId) ||
    root.localIds.some((local) => hostIds.includes(local))
  )
    return fail("duplicate host/root/local identity");
  const rootTargets = root.localIds.filter((local) => !root.mediaIds.includes(local));
  const rootScript = validateDocument(root, [...rootTargets, ...hostIds]);
  let totalBytes = rootBytes,
    mediaCount = root.mediaIds.length;
  const instances = [];
  for (const h of root.hosts) {
    const name = staticTreeSourceName(h.source);
    if (!Object.hasOwn(input.assets, name)) return fail("source outside exact snapshot allowlist");
    const child = input.assets[name];
    if (child.hosts.length) return fail("only direct external leaves; recursion/cycles unsupported");
    if (
      child.authoredId === root.authoredId ||
      hostIds.includes(child.authoredId) ||
      root.localIds.includes(child.authoredId)
    )
      return fail("authored leaf identity collides with mounted root/host");
    if (
      child.localIds.some(
        (local) => root.localIds.includes(local) || hostIds.includes(local) || local === root.authoredId,
      )
    )
      return fail("leaf local identity overlaps ancestor ownership");
    const bytes = Buffer.byteLength(child.html);
    if (bytes > limits.childBytes) return fail("child byte bound");
    totalBytes += bytes;
    if (totalBytes > limits.totalBytes) return fail("expanded aggregate byte bound");
    mediaCount += child.mediaIds.length;
    if (mediaCount > limits.media) return fail("expanded media count bound");
    const end = h.start + h.duration,
      origin = h.start - h.inPoint;
    if (![end, origin].every(Number.isFinite) || end > root.duration) return fail("host outside root window");
    if (h.inPoint + h.duration > child.duration) return fail("instance source window exceeds leaf duration");
    const script = validateDocument(
      child,
      child.localIds.filter((local) => !child.mediaIds.includes(local)),
    );
    instances.push({
      ...h,
      authoredId: child.authoredId,
      sourceSha256: digest(child.html),
      sourceBytes: bytes,
      origin,
      windowStart: h.start,
      windowEnd: end,
      localIds: child.localIds,
      mediaIds: child.mediaIds,
      script,
      structureSha256: digest(JSON.stringify(child)),
    });
  }
  if (!instances.length) return fail("requires external leaf instance");
  if (instances.length > limits.children || instances.length + 1 > limits.hosts)
    return fail("expanded host count bound");
  // All extracted records are pinned too; source text alone cannot authenticate future extraction.
  const graph = {
    profile: STATIC_INSTANCES_PROFILE,
    rootId: root.authoredId,
    rootDuration: root.duration,
    rootSha256: digest(root.html),
    rootStructureSha256: digest(JSON.stringify(root)),
    rootScript,
    files: sourceRows,
    recordsSha256: digest(JSON.stringify(Object.entries(input.assets).sort(order))),
    instances,
    totalBytes,
    mediaCount,
    hostCount: instances.length + 1,
    parser: INSTANCE_PARSER_PIN,
    limits,
  };
  return { ...graph, graphSha256: digest(JSON.stringify(graph)) };
}

export function validateInstanceMediaWindow(
  graph: ReturnType<typeof validateCompositionInstances>,
  instanceId: string,
  start: number,
  end: number,
) {
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || end > graph.rootDuration)
    fail("native media outside root window");
  const instance = graph.instances.find((row) => row.id === instanceId);
  if (!instance) return fail("unknown media instance");
  if (start < instance.windowStart || end > instance.windowEnd) fail("native media outside instance window");
}
