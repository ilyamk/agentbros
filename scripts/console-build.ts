/**
 * Build the studio console bundle into out/console/dist (RFC 0004 D4): Vite with apps/console/vite.config.mts, stamped
 * with the hash of the UI sources; skipped when the stamp is current unless --force. The server also builds on demand.
 * A build that is not exactly index.html, app.js and style.css, or has inline script or style or a data: URL, is
 * refused (VALIDATION, details.findings) and the served folder is left as it was.
 */
import path from "node:path";
import { CliErrorObject, emitProgress, parseArgs, runScript } from "../src/lib/cli";
import { buildConsoleBundle, codeRoot, distDirOf } from "../src/lib/console/bundle";

void runScript(async () => {
  const args = parseArgs([
    { name: "force", type: "boolean", description: "Rebuild even when the source hash is unchanged" },
  ] as const);
  const root = codeRoot();
  const distDir = distDirOf(root);
  const result = await buildConsoleBundle({
    distDir,
    root,
    force: Boolean(args.force),
    log: (line) => emitProgress(line),
  });
  const dist = path.relative(root, distDir).split(path.sep).join("/");
  if (!result.ok && result.findings)
    throw new CliErrorObject({
      code: "VALIDATION",
      message: result.error ?? "The built console bundle is not servable.",
      details: { dist, bundle: result.bundle, findings: result.findings },
    });
  if (!result.ok)
    throw new CliErrorObject({
      code: "INTERNAL",
      message: result.error ?? "The console bundle could not be built.",
      details: { dist, bundle: result.bundle },
    });
  return {
    outputs: result.built ? ["index.html", "app.js", "style.css"].map((file) => `${dist}/${file}`) : [],
    metadata: { built: result.built, bundle: result.bundle, dist, buildMs: result.elapsedMs },
  };
});
