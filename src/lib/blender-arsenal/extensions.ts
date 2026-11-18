import { pythonArgs, pythonEnvironment, pythonUv } from "../python";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ExtensionDownloadReceiptSchema,
  ExtensionIdSchema,
  ExtensionInspectionSchema,
  ExtensionTrialSmokeSchema,
  ExtensionsManifestSchema,
  InstalledExtensionsSchema,
  type ExtensionEntry,
  type ExtensionInspection,
} from "../../types/blender-extensions";
import { CliErrorObject } from "../cli";
import { arsenalPaths } from "./paths";

const workers = fileURLToPath(new URL("../../../scripts/workers/blender/", import.meta.url));
const invalid = (message: string) => new CliErrorObject({ code: "VALIDATION", message });
const sha = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");
const today = () => new Date().toISOString().slice(0, 10);

/** Refuse symlinks even when an ancestor, before creating any managed files. */
export function managedPath(root: string, file: string): string {
  const lexicalRoot = path.resolve(root),
    base = realpathSync(root),
    resolved = path.resolve(file);
  if (!resolved.startsWith(lexicalRoot + path.sep)) throw invalid(`Managed path escapes workspace: ${resolved}`);
  let current = base;
  for (const part of path.relative(lexicalRoot, resolved).split(path.sep)) {
    current = path.join(current, part);
    if (
      existsSync(current) ||
      (() => {
        try {
          lstatSync(current);
          return true;
        } catch {
          return false;
        }
      })()
    )
      if (lstatSync(current).isSymbolicLink()) throw invalid(`Managed path is a symlink: ${current}`);
  }
  return resolved;
}

export function extensionEnvironment(
  root = process.cwd(),
  profile = arsenalPaths(root).blenderUser,
): Record<string, string> {
  const local = arsenalPaths(root).local;
  const directory = managedPath(root, profile);
  if (!directory.startsWith(path.resolve(local) + path.sep))
    throw invalid("Extension profiles must be under blender-arsenal/local/.");
  if (existsSync(directory)) assertNoLinks(directory);
  const env = Object.fromEntries(
    ["PATH", "TMPDIR", "LANG", "SYSTEMROOT"].filter((key) => process.env[key]).map((key) => [key, process.env[key]!]),
  );
  return {
    ...env,
    HOME: directory,
    USERPROFILE: directory,
    XDG_CONFIG_HOME: path.join(directory, "xdg-config"),
    XDG_CACHE_HOME: path.join(directory, "xdg-cache"),
    BLENDER_USER_RESOURCES: directory,
    BLENDER_USER_CONFIG: path.join(directory, "config"),
    BLENDER_USER_SCRIPTS: path.join(directory, "scripts"),
    BLENDER_USER_EXTENSIONS: path.join(directory, "extensions"),
    BLENDER_SYSTEM_EXTENSIONS: path.join(directory, "system-extensions"),
    BLENDER_USER_DATAFILES: path.join(directory, "datafiles"),
    PYTHONDONTWRITEBYTECODE: "1",
  };
}

export function readExtensions(root = process.cwd()) {
  return ExtensionsManifestSchema.parse(JSON.parse(readFileSync(arsenalPaths(root).extensionsManifest, "utf8")));
}
function writeJson(root: string, file: string, data: unknown) {
  managedPath(root, file);
  managedPath(root, file + ".tmp");
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file + ".tmp", JSON.stringify(data, null, 2) + "\n", { flag: "wx" });
  renameSync(file + ".tmp", file);
}
export function inspectExtension(file: string, directory = false) {
  const result = spawnSync(
    pythonUv(),
    pythonArgs("stdlib", [
      path.join(workers, "avc_extension_inspect.py"),
      ...(directory ? ["--directory"] : []),
      path.resolve(file),
    ]),
    { env: pythonEnvironment("stdlib"), encoding: "utf8", timeout: 30000, maxBuffer: 2 * 1024 * 1024 },
  );
  if (result.error || result.status !== 0)
    throw invalid(`Cannot inspect extension: ${result.error?.message ?? result.stderr.slice(-1200)}`);
  return ExtensionInspectionSchema.parse(JSON.parse(result.stdout));
}
export function extensionEntry(root: string, id: string): ExtensionEntry {
  ExtensionIdSchema.parse(id);
  const entry = readExtensions(root).extensions.find((item) => item.id === id);
  if (!entry) throw invalid(`Unknown extension: ${id}`);
  return entry;
}
function archivePath(root: string, entry: ExtensionEntry) {
  return managedPath(root, path.join(arsenalPaths(root).downloads, `${entry.archive.sha256}.zip`));
}
export function verifyExtensionArchive(root: string, entry: ExtensionEntry) {
  const file = archivePath(root, entry),
    data = readFileSync(file);
  if (data.length !== entry.archive.size || sha(data) !== entry.archive.sha256)
    throw invalid(`Archive hash/size mismatch: ${entry.id}`);
  checkFacts(inspectExtension(file), entry);
  return file;
}
function checkFacts(inspected: ExtensionInspection, entry: ExtensionEntry) {
  if (
    inspected.id !== entry.id ||
    inspected.version !== entry.version ||
    inspected.blenderMin !== entry.blenderMin ||
    inspected.blenderMax !== entry.blenderMax ||
    JSON.stringify(Object.entries(inspected.permissions).sort()) !==
      JSON.stringify(Object.entries(entry.permissions).sort()) ||
    inspected.nativeCode !== entry.nativeCode ||
    JSON.stringify(inspected.wheels) !== JSON.stringify(entry.wheels) ||
    inspected.licence.map((item) => item.replace(/^SPDX:/, "")).join(" AND ") !== entry.licence
  )
    throw invalid(`Archive manifest differs from pin: ${entry.id}`);
}

/** Who consented, as written into tracked manifests: never the OS account name (personal data). */
export function consentIdentity(): string {
  return process.env.AGENTBROS_CONSENT_BY?.trim() || "local user";
}

export async function fetchExtension(root: string, id: string, consent: string, fetcher: typeof fetch = fetch) {
  if (!consent.trim()) throw invalid("Fetching requires --consent identifying who/when/why.");
  const entry = extensionEntry(root, id);
  if (entry.status === "rejected") throw invalid("Rejected extensions cannot be fetched.");
  if (!entry.archive.url || !/^https:\/\//.test(entry.archive.url))
    throw invalid("A pinned HTTPS archive URL is required; local proposals have none.");
  const target = archivePath(root, entry),
    partial = managedPath(root, target + ".part");
  // The tracked manifest is not touched by a fetch: the consent receipt lives next to the archive (git-ignored).
  if (existsSync(target)) {
    verifyExtensionArchive(root, entry);
    return target;
  }
  mkdirSync(path.dirname(target), { recursive: true });
  // The consent receipt precedes the request, including failed requests.
  writeJson(
    root,
    target + ".consent.json",
    ExtensionDownloadReceiptSchema.parse({
      by: consentIdentity(),
      date: today(),
      note: consent,
      id,
      url: entry.archive.url,
    }),
  );
  const chunks: Buffer[] = [];
  let length = 0,
    ownsPartial = false;
  try {
    writeFileSync(partial, "", { flag: "wx" });
    ownsPartial = true;
    const response = await fetcher(entry.archive.url, { signal: AbortSignal.timeout(120000), redirect: "error" });
    if (!response.ok || !response.body) throw invalid(`Download failed: HTTP ${response.status}`);
    const reader = response.body.getReader();
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        length += next.value.length;
        if (length > entry.archive.size) throw invalid("Download exceeds pinned size.");
        chunks.push(Buffer.from(next.value));
      }
    } finally {
      await reader.cancel();
    }
    const bytes = Buffer.concat(chunks);
    if (length !== entry.archive.size || sha(bytes) !== entry.archive.sha256)
      throw invalid("Download hash/size mismatch.");
    writeFileSync(partial, bytes);
    checkFacts(inspectExtension(partial), entry);
    renameSync(partial, target);
    return target;
  } finally {
    if (ownsPartial) rmSync(partial, { force: true });
  }
}

function installed(root: string, profile = arsenalPaths(root).blenderUser) {
  const file = managedPath(root, path.join(profile, "installed.json"));
  return existsSync(file)
    ? InstalledExtensionsSchema.parse(JSON.parse(readFileSync(file, "utf8")))
    : { extensions: [] };
}
function assertNoLinks(directory: string): void {
  for (const name of readdirSync(directory)) {
    const file = path.join(directory, name),
      stat = lstatSync(file);
    if (stat.isSymbolicLink()) throw invalid(`Symlink in Blender profile: ${file}`);
    if (stat.isDirectory()) assertNoLinks(file);
  }
}
function treeHash(directory: string): string {
  const hash = createHash("sha256");
  const visit = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const file = path.join(dir, name),
        stat = lstatSync(file);
      if (stat.isSymbolicLink()) throw invalid(`Symlink in installed extension: ${file}`);
      if (stat.isDirectory()) visit(file);
      else {
        hash.update(path.relative(directory, file));
        hash.update("\0");
        hash.update(readFileSync(file));
      }
    }
  };
  visit(directory);
  return hash.digest("hex");
}
export function listExtensions(root = process.cwd()) {
  const pins = readExtensions(root).extensions,
    receipts = installed(root).extensions;
  return [
    ...pins.map((entry) => {
      const receipt = receipts.find((item) => item.id === entry.id),
        dir = managedPath(root, path.join(arsenalPaths(root).blenderUser, "extensions/user_default", entry.id));
      const present = existsSync(dir);
      const drift = !receipt
        ? present
          ? "unrecorded install"
          : "not installed"
        : !present
          ? "missing files"
          : receipt.version !== entry.version || receipt.sha256 !== entry.archive.sha256
            ? "pin changed"
            : treeHash(dir) !== receipt.treeSha256
              ? "installed files changed"
              : null;
      return {
        ...entry,
        installedVersion: receipt?.version ?? null,
        enableable: entry.status === "approved" && drift === null,
        drift,
      };
    }),
    ...receipts
      .filter((item) => !pins.some((entry) => entry.id === item.id))
      .map((item) => ({
        id: item.id,
        installedVersion: item.version,
        enableable: false,
        drift: "absent from manifest",
      })),
  ];
}
export function approvedExtensions(root: string, selector?: string, forRender = false) {
  if (selector === undefined) return [];
  if (!selector.trim()) throw invalid("--extensions needs ids or approved.");
  const ids =
    selector === "approved"
      ? readExtensions(root)
          .extensions.filter((entry) => entry.status === "approved" && (!forRender || entry.usage !== "authoring"))
          .map((entry) => entry.id)
      : selector.split(",");
  if (new Set(ids).size !== ids.length) throw invalid("Duplicate extension ids requested.");
  return ids.map((id) => {
    const entry = extensionEntry(root, id);
    if (forRender && entry.usage === "authoring") throw invalid(`Extension ${id} is authoring-only; use --no-render.`);
    const state = listExtensions(root).find((item) => item.id === id);
    if (entry.status !== "approved" || !state?.enableable)
      throw invalid(`Extension ${id} is not approved and installed without drift (${state?.drift ?? entry.status}).`);
    return { id: entry.id, version: entry.version };
  });
}

export type BlenderExtensionProcess = (
  executable: string,
  argv: string[],
  env: Record<string, string>,
) => { elapsedMs: number };
export const extensionProcess: BlenderExtensionProcess = (executable, argv, env) => {
  const start = performance.now();
  const result = spawnSync(executable, argv, { env, encoding: "utf8", timeout: 120000, maxBuffer: 4 * 1024 * 1024 });
  if (result.error || result.status !== 0)
    throw invalid(
      `Blender extension command failed: ${result.error?.message ?? result.stderr.slice(-1500)} ${result.stdout?.slice(-1500)}`,
    );
  return { elapsedMs: Math.round(performance.now() - start) };
};
const baseArgs = [
  "--background",
  "--factory-startup",
  "--disable-autoexec",
  "--offline-mode",
  "--python-exit-code",
  "1",
];
export function extensionInstallArguments(file: string): string[] {
  return [
    ...baseArgs,
    "--python",
    path.join(workers, "avc_extensions.py"),
    "--command",
    "extension",
    "install-file",
    "-r",
    "user_default",
    "--no-prefs",
    file,
  ];
}
function installFile(root: string, file: string, executable: string, profile: string, runner: BlenderExtensionProcess) {
  const env = extensionEnvironment(root, profile);
  if (existsSync(profile)) treeHash(profile); // Reject links anywhere Blender could write during installation.
  managedPath(root, path.join(profile, "extensions/user_default"));
  for (const key of [
    "BLENDER_USER_RESOURCES",
    "BLENDER_USER_CONFIG",
    "BLENDER_USER_SCRIPTS",
    "BLENDER_USER_EXTENSIONS",
    "BLENDER_SYSTEM_EXTENSIONS",
    "BLENDER_USER_DATAFILES",
  ])
    mkdirSync(managedPath(root, env[key]!), { recursive: true });
  return runner(executable, extensionInstallArguments(file), env);
}
export function installExtension(
  root: string,
  id: string,
  executable: string,
  runner: BlenderExtensionProcess = extensionProcess,
) {
  const entry = extensionEntry(root, id);
  if (entry.status !== "approved")
    throw invalid("Only approved extensions may be installed in the main isolated profile; use trial.");
  const file = verifyExtensionArchive(root, entry),
    profile = arsenalPaths(root).blenderUser;
  const result = installFile(root, file, executable, profile, runner);
  const directory = managedPath(root, path.join(profile, "extensions/user_default", id));
  treeHash(directory);
  checkFacts(inspectExtension(directory, true), entry);
  const receipts = installed(root);
  receipts.extensions = receipts.extensions.filter((item) => item.id !== id);
  receipts.extensions.push({
    id,
    version: entry.version,
    sha256: entry.archive.sha256,
    treeSha256: treeHash(directory),
    installedAt: new Date().toISOString(),
  });
  writeJson(root, path.join(profile, "installed.json"), InstalledExtensionsSchema.parse(receipts));
  return { ...result, id, version: entry.version, profile };
}
export function trialExtension(
  root: string,
  file: string,
  name: string,
  executable: string,
  runner: BlenderExtensionProcess = extensionProcess,
) {
  if (!/^[a-z][a-z0-9_-]*$/.test(name)) throw invalid("Trial name must be a safe lowercase name.");
  const inspected = inspectExtension(file),
    profile = managedPath(root, path.join(arsenalPaths(root).trials, name, "blender-user"));
  if (existsSync(profile)) throw invalid("Trial profile already exists; use a new candidate name.");
  const snapshot = managedPath(root, path.join(path.dirname(profile), "candidate.zip"));
  mkdirSync(path.dirname(snapshot), { recursive: true });
  writeFileSync(snapshot, readFileSync(file), { flag: "wx" });
  const install = installFile(root, snapshot, executable, profile, runner);
  const reportFile = managedPath(root, path.join(path.dirname(profile), "smoke.json"));
  const env = {
    ...extensionEnvironment(root, profile),
    AGENTBROS_EXTENSION_SMOKE_ID: inspected.id,
    AGENTBROS_EXTENSION_SMOKE_RESULT: reportFile,
  };
  const smoke = runner(executable, [...baseArgs, "--python", path.join(workers, "avc_extensions.py")], env);
  const report = ExtensionTrialSmokeSchema.parse(JSON.parse(readFileSync(reportFile, "utf8")));
  return {
    inspected,
    sha256: sha(readFileSync(snapshot)),
    profile,
    installMs: install.elapsedMs,
    smokeMs: smoke.elapsedMs,
    ...report,
  };
}
export function proposeExtension(root: string, file: string, purpose: string) {
  if (!purpose.trim()) throw invalid("--purpose is required.");
  const data = inspectExtension(file),
    bytes = readFileSync(file),
    manifest = readExtensions(root);
  if (manifest.extensions.some((entry) => entry.id === data.id))
    throw invalid("Extension already exists; review its current entry.");
  const evaluation = `docs/blender-arsenal/${data.id}.md`,
    doc = managedPath(root, path.join(root, evaluation));
  if (existsSync(doc)) throw invalid("Evaluation already exists.");
  const entry: ExtensionEntry = {
    id: data.id,
    name: data.name,
    repo: "local",
    version: data.version,
    blenderMin: data.blenderMin,
    blenderMax: data.blenderMax,
    archive: { url: null, sha256: sha(bytes), size: bytes.length },
    licence: data.licence.map((item) => item.replace(/^SPDX:/, "")).join(" AND "),
    licenceUrl: null,
    maintainer: data.maintainer,
    permissions: data.permissions,
    platforms: data.platforms,
    wheels: data.wheels,
    nativeCode: data.nativeCode,
    needsAccount: false,
    headless: { status: "partial", note: "Not tested" },
    deterministic: "Not tested",
    purpose,
    useWith: [],
    status: "proposed",
    evaluation,
    addedBy: consentIdentity(),
    verified: null,
  };
  manifest.extensions.push(entry);
  const validated = ExtensionsManifestSchema.parse(manifest);
  mkdirSync(path.dirname(doc), { recursive: true });
  writeFileSync(
    doc,
    readFileSync(path.join(root, "docs/blender-arsenal/_template.md"), "utf8")
      .replace("{{id}}", data.id)
      .replace("{{purpose}}", purpose),
    { flag: "wx" },
  );
  // Cache the original archive; local proposals never invent a download URL.
  const archive = archivePath(root, entry);
  mkdirSync(path.dirname(archive), { recursive: true });
  if (!existsSync(archive)) writeFileSync(archive, bytes, { flag: "wx" });
  writeJson(root, arsenalPaths(root).extensionsManifest, validated);
  return { entry, evaluation: doc, archive };
}
export function approveExtension(root: string, id: string, consent: string, allowNetworkAccount = false) {
  if (!consent.trim()) throw invalid("Approval requires --consent identifying who/when/why.");
  const manifest = readExtensions(root),
    entry = manifest.extensions.find((item) => item.id === id);
  if (!entry || entry.status === "rejected") throw invalid("Unknown or rejected extension.");
  const evaluation = readFileSync(managedPath(root, path.join(root, entry.evaluation)), "utf8");
  const verdict = /^## Verdict\s*\n([\s\S]*?)(?=^## |$(?![\s\S]))/m.exec(evaluation)?.[1]?.trim();
  if (!verdict || /^(pending|todo|not tested|<!--)/i.test(verdict))
    throw invalid("Evaluation requires a completed Verdict.");
  entry.status = "approved";
  entry.consent = {
    by: consentIdentity(),
    date: today(),
    note: consent,
    ...(allowNetworkAccount ? { allowNetworkAccount: true } : {}),
  };
  writeJson(root, arsenalPaths(root).extensionsManifest, ExtensionsManifestSchema.parse(manifest));
  return entry;
}
