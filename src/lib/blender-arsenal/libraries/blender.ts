import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { ensureArsenalLayout } from "../paths";

export const BlendAssetSchema = z.object({ name: z.string(), category: z.string(), catalogId: z.string() }).strict();
export const ProbeSchema = z
  .object({
    blenderVersion: z.string(),
    systemRoot: z.string(),
    files: z.array(
      z
        .object({ path: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/), assets: z.array(BlendAssetSchema) })
        .strict(),
    ),
  })
  .strict();
export type BlendAsset = z.infer<typeof BlendAssetSchema>;
export function probeAssets(root: string, options: { files?: string[]; bundled?: boolean } = {}) {
  const p = ensureArsenalLayout(root);
  const temporary = mkdtempSync(path.join(p.trials, "asset-probe-"));
  const output = path.join(temporary, "result.json"),
    request = path.join(temporary, "request.json");
  writeFileSync(request, JSON.stringify({ ...options, output }));
  const env = {
    ...process.env,
    BLENDER_USER_RESOURCES: p.blenderUser,
    BLENDER_USER_CONFIG: path.join(p.blenderUser, "config"),
    BLENDER_USER_DATAFILES: path.join(p.blenderUser, "datafiles"),
    BLENDER_USER_SCRIPTS: path.join(p.blenderUser, "scripts"),
    BLENDER_USER_EXTENSIONS: path.join(p.blenderUser, "extensions"),
    BLENDER_SYSTEM_EXTENSIONS: path.join(p.blenderUser, "system-extensions"),
  };
  try {
    const result = spawnSync(
      process.env.BLENDER_EXECUTABLE ?? "/Applications/Blender.app/Contents/MacOS/Blender",
      [
        "--background",
        "--factory-startup",
        "--disable-autoexec",
        "--offline-mode",
        "--threads",
        "2",
        "--python-exit-code",
        "1",
        "--python",
        fileURLToPath(new URL("../../../../scripts/workers/blender/avc_asset_probe.py", import.meta.url)),
        "--",
        request,
      ],
      { env, encoding: "utf8", timeout: 120000, maxBuffer: 1024 * 1024 },
    );
    if (result.status !== 0)
      throw new Error(
        `Blender asset probe failed: ${result.error?.message ?? result.stdout.slice(-2000) + result.stderr.slice(-1000)}`,
      );
    return ProbeSchema.parse(JSON.parse(readFileSync(output, "utf8")));
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}
