import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import {
  HarnessAssetRequestSchema,
  HarnessAssetResultSchema,
  HarnessCapabilitiesSchema,
  HarnessOperationSchema,
  type HarnessAssetRequest,
  type HarnessCapabilities,
  type HarnessOperation,
} from "../../types/harness-assets";
import { AssetProvenanceSchema } from "../../types/assets";
import { CliErrorObject } from "../cli";
import { assertProjectId } from "../render-plan";
import { importAsset, readAssetRegistry } from "./registry";
import { getEntityVersion, resolveEntityReferences } from "../entities/service";

const fail = (message: string): never => {
  throw new CliErrorObject({ code: "VALIDATION", message });
};
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object")
    return `{${Object.entries(v)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, x]) => `${JSON.stringify(k)}:${canonical(x)}`)
      .join(",")}}`;
  return JSON.stringify(v);
}
export const harnessDigest = (v: unknown) => createHash("sha256").update(canonical(v)).digest("hex");
/** Workspace containment and rejection of every existing symlink component. No arbitrary source roots. */
function safe(root: string, file: string): string {
  const base = path.resolve(root),
    target = path.resolve(base, file),
    rel = path.relative(base, target);
  if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) fail("Harness path escapes workspace.");
  let component = base;
  for (const part of ["", ...rel.split(path.sep).filter(Boolean)]) {
    component = path.join(component, part);
    try {
      if (lstatSync(component).isSymbolicLink()) fail("Harness paths cannot contain symlinks.");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return target;
}
function readChecked(
  root: string,
  file: string,
  limit = 32 * 1024 ** 3,
  contents = false,
): { sha256: string; bytes?: Buffer } {
  const full = safe(root, file);
  let fd: number;
  try {
    fd = openSync(full, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    throw new CliErrorObject({ code: "FILE_NOT_FOUND", message: "Harness file missing or inaccessible." });
  }
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.size <= 0 || before.size > limit)
      fail("Harness file must be a nonempty bounded regular file.");
    const parents: { file: string; dev: number; ino: number }[] = [];
    let directory = path.resolve(root);
    for (const part of ["", ...path.relative(directory, path.dirname(full)).split(path.sep).filter(Boolean)]) {
      directory = path.join(directory, part);
      const stat = lstatSync(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) fail("Harness parent must be a directory without aliases.");
      parents.push({ file: directory, dev: stat.dev, ino: stat.ino });
    }
    const same = (stat: ReturnType<typeof fstatSync>) =>
      stat.isFile() &&
      stat.dev === before.dev &&
      stat.ino === before.ino &&
      stat.size === before.size &&
      stat.mtimeMs === before.mtimeMs &&
      stat.ctimeMs === before.ctimeMs;
    const lexicalMatches = () => {
      try {
        return (
          same(lstatSync(safe(root, file))) &&
          parents.every((parent) => {
            const stat = lstatSync(parent.file);
            return stat.isDirectory() && !stat.isSymbolicLink() && stat.dev === parent.dev && stat.ino === parent.ino;
          })
        );
      } catch {
        return false;
      }
    };
    if (!lexicalMatches()) fail("Harness file changed while reading.");
    const hash = createHash("sha256"),
      buffer = Buffer.alloc(Math.min(before.size, 1024 * 1024)),
      chunks: Buffer[] = [];
    let count = 0;
    while (count < before.size) {
      const size = readSync(fd, buffer, 0, Math.min(buffer.length, before.size - count), null);
      if (size <= 0) fail("Harness file changed while reading.");
      count += size;
      hash.update(buffer.subarray(0, size));
      if (contents) chunks.push(Buffer.from(buffer.subarray(0, size)));
    }
    if (readSync(fd, buffer, 0, 1, null) !== 0 || !same(fstatSync(fd)) || !lexicalMatches())
      fail("Harness file changed while reading.");
    return { sha256: hash.digest("hex"), ...(contents ? { bytes: Buffer.concat(chunks) } : {}) };
  } finally {
    closeSync(fd);
  }
}
export function readHarnessJson(root: string, file: string): unknown {
  const read = readChecked(root, file, 8 * 1024 ** 2, true);
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(read.bytes!));
  } catch {
    return fail("Invalid harness JSON document.");
  }
}
function parse<T>(schema: { parse(x: unknown): T }, value: unknown): T {
  try {
    return schema.parse(value);
  } catch {
    return fail("Invalid harness schema/document.");
  }
}
function pin(root: string, p: { file: string; sha256: string }, media = false) {
  if (readChecked(root, p.file, media ? 32 * 1024 ** 3 : 8 * 1024 ** 2).sha256 !== p.sha256)
    fail("Harness evidence/original checksum mismatch.");
}
function paths(root: string, projectId: string, requestId: string) {
  assertProjectId(projectId);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(requestId)) fail("Invalid harness request identity.");
  const project = safe(root, `public/projects/${projectId}`),
    config = safe(root, path.join(project, "project.json"));
  if (!existsSync(config))
    throw new CliErrorObject({ code: "PROJECT_NOT_FOUND", message: "Harness project does not exist." });
  const directory = safe(root, path.join(project, "pipeline/harness"));
  return { config, directory, operation: safe(root, path.join(directory, `${requestId}.json`)) };
}
function validatePins(root: string, request: HarnessAssetRequest) {
  const registry = readAssetRegistry(request.projectId, root);
  for (const ref of request.references) {
    const asset = registry.assets.find((a) => a.id === ref.assetId);
    if (!asset) return fail("Harness reference is missing or stale.");
    if (asset.hash !== ref.sha256) fail("Harness reference is missing or stale.");
    pin(root, { file: `public/${asset.files.original}`, sha256: ref.sha256 }, true);
  }
  for (const entity of request.entities) {
    const view = getEntityVersion(request.projectId, entity.kind, entity.entityId, {
      rootDir: root,
      revision: entity.revision,
      requireApproved: true,
    });
    if (view.version.contentHash !== entity.contentHash) fail("Harness entity version is stale.");
    resolveEntityReferences(request.projectId, entity, root);
  }
}
export function listCapabilities(declaration?: unknown, rootDir = process.cwd(), now = new Date()) {
  if (declaration === undefined)
    return {
      status: "unavailable" as const,
      reason: "No observed/supplied runtime declaration.",
      capabilities: null,
      availableTools: [],
    };
  const capabilities = parse(HarnessCapabilitiesSchema, declaration);
  pin(rootDir, capabilities.evidence);
  const expired =
    Date.parse(capabilities.expiresAt) <= now.getTime() || Date.parse(capabilities.observedAt) > now.getTime();
  const availableTools = expired
    ? []
    : capabilities.tools.filter((t) => t.available && t.quota !== "exhausted" && t.localOriginalOutput);
  return {
    status: availableTools.length ? ("available" as const) : ("unavailable" as const),
    reason: expired
      ? "Runtime observation expired or is in the future."
      : availableTools.length
        ? "Evidence supplied; this process has not invoked the tools."
        : "No available tool returning original local files.",
    capabilities,
    availableTools,
  };
}
function atomic(root: string, file: string, value: unknown) {
  safe(root, file);
  const temporary = safe(root, path.join(path.dirname(file), `.${randomUUID()}.tmp`));
  try {
    const fd = openSync(temporary, "wx", 0o600);
    try {
      writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    safe(root, file);
    renameSync(temporary, file);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}
function locked<T>(root: string, directory: string, file: string, fn: () => T): T {
  safe(root, directory);
  mkdirSync(directory, { recursive: true });
  const lock = safe(root, `${file}.lock`);
  let fd: number;
  try {
    fd = openSync(lock, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new CliErrorObject({
        code: "TIMEOUT",
        message: "Harness operation locked; inspect stale lock before removal.",
      });
    throw error;
  }
  try {
    writeFileSync(fd, JSON.stringify({ pid: process.pid }));
    return fn();
  } finally {
    closeSync(fd);
    unlinkSync(lock);
  }
}
function readOperation(root: string, file: string): HarnessOperation {
  const op = parse(HarnessOperationSchema, readHarnessJson(root, file));
  if (
    harnessDigest(op.request) !== op.requestHash ||
    harnessDigest(op.capabilities) !== op.capabilitiesHash ||
    (op.result && harnessDigest(op.result) !== op.resultHash)
  )
    fail("Harness operation pins are corrupt.");
  return op;
}
function verifyOperation(root: string, op: HarnessOperation) {
  const p = paths(root, op.request.projectId, op.request.requestId);
  if (readChecked(root, p.config, 8 * 1024 ** 2).sha256 !== op.projectSha256)
    fail("Harness project configuration changed; create a new request.");
  pin(root, op.capabilities.evidence);
  validatePins(root, op.request);
  if (op.result) {
    if (
      op.result.requestId !== op.request.requestId ||
      op.result.requestHash !== op.requestHash ||
      op.result.toolId !== op.request.toolId ||
      op.result.runtime !== op.capabilities.runtime
    )
      fail("Persisted result identity does not match request.");
    pin(root, op.result.toolResultEvidence);
    if (op.status === "complete") {
      const expected = parse(AssetProvenanceSchema, {
        origin: "agent-harness",
        tool: op.result.toolId,
        model: op.result.model,
        prompt: op.request.prompt,
        referenceAssetIds: op.request.references.map((r) => r.assetId),
        generationJobId: op.result.requestId,
        billing: op.result.billing,
      });
      const receipt = op.receipt!;
      if (
        receipt.assetId !== `sha256:${op.result.original.sha256}` ||
        harnessDigest(receipt.provenance) !== harnessDigest(expected) ||
        harnessDigest(receipt.rights) !== harnessDigest(op.result.rights)
      )
        fail("Completed receipt does not match pinned result provenance/rights.");
      const registered = readAssetRegistry(op.request.projectId, root).assets.find((a) => a.id === receipt.assetId);
      if (!registered || registered.files.original !== receipt.original)
        fail("Completed harness asset is missing from registry.");
      pin(root, { file: `public/${receipt.original}`, sha256: op.result.original.sha256 }, true);
    }
  }
}
/** Persist intent only. The host agent fulfils it externally; retries never invoke generation. */
export function requestAsset(
  input: unknown,
  declaration: unknown,
  { rootDir = process.cwd(), dryRun = false, now = new Date() } = {},
) {
  const request = parse(HarnessAssetRequestSchema, input),
    capabilities = parse(HarnessCapabilitiesSchema, declaration);
  const p = paths(rootDir, request.projectId, request.requestId),
    requestHash = harnessDigest(request),
    capabilitiesHash = harnessDigest(capabilities);
  const perform = () => {
    if (existsSync(p.operation)) {
      const previous = readOperation(rootDir, p.operation);
      if (previous.requestHash !== requestHash || previous.capabilitiesHash !== capabilitiesHash)
        fail("Request ID already binds different request/capability content.");
      verifyOperation(rootDir, previous);
      return { operation: previous, resumed: true, dryRun, file: path.relative(rootDir, p.operation) };
    }
    const discovered = listCapabilities(capabilities, rootDir, now);
    const tool = discovered.availableTools.find(
      (t) => t.toolId === request.toolId && t.kinds.includes(request.kind) && t.operations.includes(request.operation),
    );
    if (!tool)
      throw new CliErrorObject({
        code: "STAGE_INCOMPLETE",
        message: "Requested harness tool/operation unavailable; no paid fallback.",
      });
    if (request.modelPolicy === "require-selectable-model" && !tool.selectableModels.includes(request.requestedModel!))
      fail("Requested model is not observed selectable by this tool.");
    validatePins(rootDir, request);
    const operation = parse(HarnessOperationSchema, {
      schemaVersion: 1,
      request,
      requestHash,
      capabilities,
      capabilitiesHash,
      projectSha256: readChecked(rootDir, p.config, 8 * 1024 ** 2).sha256,
      createdAt: now.toISOString(),
      status: "awaiting-import",
    });
    if (!dryRun) atomic(rootDir, p.operation, operation);
    return { operation, resumed: false, dryRun, file: path.relative(rootDir, p.operation) };
  };
  return dryRun ? perform() : locked(rootDir, p.directory, p.operation, perform);
}
export function getHarnessOperation(projectId: string, requestId: string, rootDir = process.cwd()) {
  const p = paths(rootDir, projectId, requestId),
    op = readOperation(rootDir, p.operation);
  if (op.request.projectId !== projectId || op.request.requestId !== requestId)
    fail("Harness operation identity mismatch.");
  verifyOperation(rootDir, op);
  return op;
}
/** Import an explicitly fulfilled original; durable result pin precedes registry commit for crash recovery. */
export function importResult(projectId: string, input: unknown, { rootDir = process.cwd(), dryRun = false } = {}) {
  const result = parse(HarnessAssetResultSchema, input),
    p = paths(rootDir, projectId, result.requestId);
  const perform = () => {
    let operation = getHarnessOperation(projectId, result.requestId, rootDir);
    if (
      operation.requestHash !== result.requestHash ||
      operation.capabilities.runtime !== result.runtime ||
      operation.request.toolId !== result.toolId
    )
      fail("Result does not match pinned harness request/tool/runtime.");
    const resultHash = harnessDigest(result);
    if (operation.resultHash && operation.resultHash !== resultHash)
      fail("Fulfilled result changed; create a separate request for another attempt.");
    pin(rootDir, result.toolResultEvidence);
    pin(rootDir, result.original, true);
    if (
      operation.request.modelPolicy === "require-selectable-model" &&
      result.model !== operation.request.requestedModel
    )
      fail("Result model does not match exact model request.");
    const provenance = parse(AssetProvenanceSchema, {
      origin: "agent-harness",
      tool: result.toolId,
      model: result.model,
      prompt: operation.request.prompt,
      referenceAssetIds: operation.request.references.map((r) => r.assetId),
      generationJobId: result.requestId,
      billing: result.billing,
    });
    const options = {
      projectId,
      rootDir,
      sourceFile: safe(rootDir, result.original.file),
      provenance,
      rights: result.rights,
      entityLinks: operation.request.entities.map((e) => ({
        entityId: e.entityId,
        revision: e.revision,
        purpose: operation.request.purpose,
      })),
    };
    const planned = importAsset({ ...options, dryRun: true });
    if (planned.asset.hash !== result.original.sha256 || planned.asset.kind !== operation.request.kind)
      fail("Original result kind/checksum does not match request.");
    if (
      (operation.request.width && planned.asset.media.width !== operation.request.width) ||
      (operation.request.height && planned.asset.media.height !== operation.request.height) ||
      (operation.request.transparency === "required" && planned.asset.media.hasAlpha !== true)
    )
      fail("Original dimensions/alpha do not meet request.");
    if (operation.status === "complete") {
      if (
        operation.receipt!.assetId !== planned.asset.id ||
        operation.receipt!.original !== planned.asset.files.original
      )
        fail("Completed receipt does not match registry original.");
      return { operation, resumed: true, dryRun, file: path.relative(rootDir, p.operation) };
    }
    if (dryRun)
      return {
        operation,
        planned: planned.asset,
        resumed: !!operation.result,
        dryRun,
        file: path.relative(rootDir, p.operation),
      };
    operation = parse(HarnessOperationSchema, { ...operation, status: "importing", result, resultHash });
    atomic(rootDir, p.operation, operation);
    const imported = importAsset(options);
    pin(rootDir, result.original, true);
    pin(rootDir, result.toolResultEvidence);
    verifyOperation(rootDir, operation);
    operation = parse(HarnessOperationSchema, {
      ...operation,
      status: "complete",
      receipt: {
        assetId: imported.asset.id,
        original: imported.asset.files.original,
        duplicate: imported.duplicate,
        provenance,
        rights: result.rights,
        registryMetadataPreserved:
          harnessDigest(imported.asset.provenance) !== harnessDigest(provenance) ||
          harnessDigest(imported.asset.rights) !== harnessDigest(result.rights),
        creativeApproval: "required",
        importedAt: new Date().toISOString(),
      },
    });
    atomic(rootDir, p.operation, operation);
    return { operation, resumed: false, dryRun, file: path.relative(rootDir, p.operation) };
  };
  return dryRun ? perform() : locked(rootDir, p.directory, p.operation, perform);
}
