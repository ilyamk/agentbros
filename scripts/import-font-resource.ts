import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { parseArgs, runScript, CliErrorObject } from "../src/lib/cli";
import { importResource, acquireResource } from "../src/lib/font-resources/registry";
import { createFontManifest, writeFontRoleModule } from "../src/lib/font-resources/manifest";
runScript(async () => {
  const args = parseArgs([
    { name: "project", required: true, description: "Existing project" },
    {
      name: "metadata",
      required: true,
      description: "Supplied provenance/licence/exact face JSON or role selectors",
    },
    { name: "source", description: "Original local TTF/OTF/SVG" },
    {
      name: "url",
      description: "Explicit HTTPS GET resource; no automatic discovery",
    },
    {
      name: "context",
      description: "Create an exclusive validated font context JSON from role selectors",
    },
    {
      name: "module",
      description: "Create an exclusive font-role TS module instead of importing",
    },
  ]);
  let temporary: string | undefined;
  try {
    const metadata = JSON.parse(readFileSync(String(args.metadata), "utf8"));
    if (args.module || args.context) {
      const manifest = createFontManifest(String(args.project), metadata);
      const outputs: string[] = [];
      if (args.context) {
        writeFileSync(String(args.context), JSON.stringify(manifest, null, 2) + "\n", { flag: "wx" });
        outputs.push(String(args.context));
      }
      if (args.module) outputs.push(writeFontRoleModule(manifest, String(args.module)));
      return { outputs, metadata: { manifest, generationRequests: 0 } };
    }
    if (Boolean(args.source) === Boolean(args.url))
      throw new Error("Supply exactly one local source or explicit HTTPS URL");
    let source = String(args.source ?? "");
    if (args.url) {
      if (metadata.source !== String(args.url)) throw new Error("Acquisition URL differs from provenance");
      temporary = mkdtempSync(path.join(os.tmpdir(), "font-acquire-"));
      source = path.join(temporary, "original");
      writeFileSync(source, await acquireResource(String(args.url)));
    }
    const record = importResource(String(args.project), source, metadata);
    return {
      outputs: [path.join("public", record.original)],
      metadata: {
        record,
        generationRequests: 0,
        vectorRegistryImportSupported: false,
      },
    };
  } catch (error) {
    throw new CliErrorObject({
      code: "VALIDATION",
      message: error instanceof Error ? error.message : String(error),
    });
  } finally {
    if (temporary) rmSync(temporary, { recursive: true, force: true });
  }
});
