import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { contained, digest, fail, filesIn, writeJson } from "./io";
import { signBundle, verifyBundle, type VerifyOptions } from "./sign";
import { checkPublicExport, publicManifest, publicSummary } from "./public";

/** Publish an allowlisted measurement summary; no arbitrary source artefact is copied. */
export async function exportBundle(options: VerifyOptions & { out: string; key: string }) {
  const source = path.resolve(options.bundle),
    out = path.resolve(options.out);
  if (out === source || out.startsWith(source + path.sep) || source.startsWith(out + path.sep) || existsSync(out))
    fail("Export needs a new directory outside the original bundle");
  const verified = await verifyBundle(options);
  if (verified.manifest.publication) fail("Export the private original, not an existing public export");
  const original = verified.manifest;
  const sourceManifestSha256 = digest(readFileSync(contained(source, "manifest.json")));
  const summary = publicSummary(original, sourceManifestSha256);
  const manifest = publicManifest(original, sourceManifestSha256);
  checkPublicExport(options.root, manifest, summary);
  mkdirSync(path.dirname(out), { recursive: true });
  mkdirSync(out);
  try {
    writeJson(path.join(out, "summary.json"), summary);
    writeJson(path.join(out, "manifest.json"), manifest);
    signBundle(out, options.key);
    checkPublicExport(options.root, manifest, summary, readFileSync(path.join(out, "manifest.json.sig"), "utf8"));
    return {
      outputs: filesIn(out).map((name) => path.join(out, name)),
      metadata: {
        visibility: "public",
        sourceManifestSha256,
        measurements: "claimed; private original required for recomputation",
      },
    };
  } catch (error) {
    rmSync(out, { recursive: true, force: true });
    throw error;
  }
}
