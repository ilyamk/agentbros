import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { BenchBundleSchema, BenchTaskSchema } from "../../types/bench";
import { command, contained, fail, fileDigest, filesIn, json, loadBenchConfig } from "./io";
import { loadTask } from "./tasks";
import { measure } from "./measure";
import { checkPublicExport } from "./public";

const NAMESPACE = "agentbros-bench";
export function signBundle(bundle: string, key: string): string {
  const manifest = contained(path.resolve(bundle), "manifest.json");
  BenchBundleSchema.parse(json(manifest));
  if (existsSync(`${manifest}.sig`)) fail("Bundle is already signed; refusing to overwrite its signature");
  command("ssh-keygen", ["-Y", "sign", "-n", NAMESPACE, "-f", path.resolve(key), manifest]);
  return `${manifest}.sig`;
}
export interface VerifyOptions {
  bundle: string;
  root: string;
  allowedSigners?: string;
  githubUser?: string;
  online?: boolean;
  suite?: string;
}
export async function verifyBundle(options: VerifyOptions) {
  const bundle = path.resolve(options.bundle),
    manifestFile = contained(bundle, "manifest.json"),
    signature = contained(bundle, "manifest.json.sig");
  if (!existsSync(signature)) fail("Unsigned bundle refused");
  if (Boolean(options.allowedSigners) === Boolean(options.githubUser))
    fail("Supply exactly one of --allowed-signers or --github-user");
  const scratch = mkdtempSync(path.join(tmpdir(), "bench-signers-"));
  try {
    let allowed = options.allowedSigners ? path.resolve(options.allowedSigners) : "";
    if (options.githubUser) {
      if (!options.online) fail("Fetching GitHub keys requires --online");
      if (!/^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,38})$/.test(options.githubUser)) fail("Invalid GitHub handle");
      const response = await fetch(`https://github.com/${options.githubUser}.keys`, {
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) fail(`GitHub key lookup failed: HTTP ${response.status}`);
      const text = await response.text();
      if (text.length > 64 * 1024) fail("GitHub key response exceeds limit");
      const keys = text.trim().split("\n");
      if (
        !keys.length ||
        keys.some((key) => !/^(ssh-ed25519|ssh-rsa|ecdsa-sha2-\S+) [A-Za-z0-9+/=]+(?: .*)?$/.test(key))
      )
        fail("Invalid GitHub keys");
      allowed = path.join(scratch, "allowed_signers");
      writeFileSync(
        allowed,
        keys.map((key) => `${options.githubUser} namespaces="${NAMESPACE}" ${key}`).join("\n") + "\n",
      );
    }
    const limits = loadBenchConfig(options.root).limits;
    if (statSync(manifestFile).size > 8 * 1024 * 1024 || statSync(signature).size > 64 * 1024)
      fail("Manifest or signature exceeds verification limits");
    const principals = command("ssh-keygen", ["-Y", "find-principals", "-s", signature, "-f", allowed])
      .split("\n")
      .filter(Boolean);
    if (!principals.length) fail("Signer is not allowed");
    const bytes = readFileSync(manifestFile);
    command(
      "ssh-keygen",
      ["-Y", "verify", "-n", NAMESPACE, "-f", allowed, "-I", principals[0]!, "-s", signature],
      undefined,
      bytes,
    );
    const manifest = BenchBundleSchema.parse(JSON.parse(bytes.toString("utf8")));
    if (
      manifest.files.length > 20_000 ||
      manifest.files.reduce((sum, item) => sum + item.bytes, 0) > limits.maxBundleBytes + limits.maxTranscriptBytes
    )
      fail("Bundle exceeds verification limits");
    const actual = filesIn(bundle)
      .filter((name) => !["manifest.json", "manifest.json.sig"].includes(name))
      .sort();
    if (!isDeepStrictEqual(actual, manifest.files.map((file) => file.path).sort()))
      fail("Bundle file inventory mismatch");
    for (const item of manifest.files) {
      const filePath = contained(bundle, item.path),
        stat = statSync(filePath);
      if (!stat.isFile() || stat.size !== item.bytes || stat.size > limits.maxBundleBytes)
        fail(`Bundle byte size mismatch: ${item.path}`);
      if ((await fileDigest(filePath)) !== item.sha256) fail(`Bundle hash mismatch: ${item.path}`);
    }
    if (manifest.publication) {
      if (manifest.visibility !== "public" || !isDeepStrictEqual(actual, ["summary.json"]))
        fail("Invalid public export inventory");
      checkPublicExport(
        options.root,
        manifest,
        json(contained(bundle, "summary.json")),
        readFileSync(signature, "utf8"),
      );
      return {
        verified: true,
        label: "community-export",
        signer: principals[0],
        manifest,
        recomputed: null,
        limitations: [
          "Public export: signature and file integrity verified; measurements are claims. Deterministic recomputation requires the private original and its pinned suite.",
          "Sound quality requires human listening.",
        ],
      };
    }
    const { suite, task, taskSha256 } = loadTask(options.root, manifest.cell.task, options.suite);
    if (
      suite.version !== manifest.suiteVersion ||
      taskSha256 !== manifest.taskSha256 ||
      !isDeepStrictEqual(BenchTaskSchema.parse(json(contained(bundle, "protocol/task.json"))), task)
    )
      fail("Bundle does not match the selected pinned suite");
    if (!manifest.transcript) fail("Private original requires a transcript");
    if (statSync(contained(bundle, manifest.transcript)).size > limits.maxTranscriptBytes)
      fail("Transcript exceeds verification limit");
    const transcript = readFileSync(contained(bundle, manifest.transcript), "utf8");
    const recomputed = measure(bundle, task, options.root, transcript, manifest.cell.harness);
    if (
      !isDeepStrictEqual(recomputed, manifest.claims) ||
      !isDeepStrictEqual(recomputed.tokens, manifest.tokens) ||
      recomputed.toolCalls !== manifest.toolCalls ||
      recomputed.spendUsd !== manifest.spendUsd
    )
      fail("Recomputed deterministic claims differ from the signed bundle");
    if (task.tier === "no-spend" && recomputed.spendUsd !== 0)
      fail("No-spend task has non-zero or unknown ledger spend");
    return {
      verified: true,
      label: "community",
      signer: principals[0],
      manifest,
      recomputed,
      limitations: [
        "Signature proves submitter identity, not truthful execution or environment; wall time and harness provenance require reproduction.",
        ...(manifest.omitted.length ? ["Large binary files omitted; unavailable checks do not imply acceptance."] : []),
        "Sound quality requires human listening; measured audio is not a creative judgement.",
      ],
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
