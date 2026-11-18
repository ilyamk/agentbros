# CLI Helper — Canonical Usage Example

All production scripts follow this pattern: one JSON line on stdout, progress
on stderr, exit 0/1.

## Minimal script

```ts
/**
 * Generate an AI image and write it to disk.
 *
 * Usage:
 *   pnpm tsx --env-file=.env scripts/generate-image.ts --prompt "..." --output public/projects/foo/assets/images/hero.png
 *   pnpm tsx --env-file=.env scripts/generate-image.ts --prompt "..." --output ... --model flux-dev --force
 */

import path from "node:path";
import { existsSync } from "node:fs";
import {
  parseArgs,
  runScript,
  emitProgress,
  withRetry,
  requireEnv,
  requireProject,
  CliErrorObject,
  relativisePath,
} from "../src/lib/cli";

// ---------------------------------------------------------------------------
// Argument spec (as const — enables full type inference)
// ---------------------------------------------------------------------------

const SPECS = [
  {
    name: "prompt",
    required: true,
    description: "Image generation prompt",
  },
  {
    name: "output",
    required: true,
    description: "Destination path for the generated image",
  },
  {
    name: "model",
    default: "flux-schnell",
    choices: ["flux-schnell", "flux-dev", "gpt-image-2"] as const,
    description: "Model to use for generation",
  },
  {
    name: "project",
    short: "p",
    required: false,
    description: "Project ID for validation (optional)",
  },
  {
    name: "force",
    type: "boolean" as const,
    default: false,
    description: "Overwrite an existing output file",
  },
] as const;

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

runScript(async () => {
  // parseArgs infers: { prompt: string|undefined, output: string|undefined,
  //                     model: string|undefined, project: string|undefined,
  //                     force: boolean }
  const args = parseArgs(SPECS);

  // Project validation (optional but recommended)
  if (args.project) {
    requireProject(args.project);
  }

  // Guard against accidental overwrite
  if (!args.force && existsSync(args.output!)) {
    throw new CliErrorObject({
      code: "FILE_EXISTS",
      message: `Output already exists: ${args.output}. Pass --force to overwrite.`,
    });
  }

  const apiKey = requireEnv("FAL_KEY");

  emitProgress("Generating with model:", args.model);

  // Wrap network call in withRetry — backs off on RATE_LIMIT / NETWORK errors
  const imageUrl = await withRetry(
    async () => {
      const response = await fetch("https://fal.run/fal-ai/flux/schnell", {
        method: "POST",
        headers: {
          "Authorization": `Key ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ prompt: args.prompt }),
      });
      if (response.status === 429) {
        throw new CliErrorObject({ code: "RATE_LIMIT", message: "Rate limited", retryAfterMs: 30_000 });
      }
      if (!response.ok) {
        throw new CliErrorObject({ code: "NETWORK", message: `HTTP ${response.status}` });
      }
      const data = await response.json() as { images: [{ url: string }] };
      return data.images[0].url;
    },
    { attempts: 3, backoffMs: 5_000, factor: 2 },
  );

  // Download and write file (simplified)
  const buf = await fetch(imageUrl).then((r) => r.arrayBuffer());
  const { writeFileSync, mkdirSync } = await import("node:fs");
  mkdirSync(path.dirname(args.output!), { recursive: true });
  writeFileSync(args.output!, Buffer.from(buf));

  emitProgress("Saved to", args.output);

  return {
    outputs: [relativisePath(path.resolve(args.output!))],
    metadata: {
      model: args.model,
      cost: args.model === "gpt-image-2" ? null : 0.003,
    },
  };
});
```

## What the caller sees

On success (stdout only):
```json
{"ok":true,"outputs":["public/projects/foo/assets/images/hero.png"],"metadata":{"model":"flux-schnell","cost":0.003},"elapsedMs":4230}
```

On failure (stdout only):
```json
{"ok":false,"error":"RATE_LIMIT","message":"Rate limited","retryAfterMs":30000,"elapsedMs":1100}
```

Progress (stderr only, not captured by orchestrators):
```
[progress] Generating with model: flux-schnell
[progress] Saved to public/projects/foo/assets/images/hero.png
```

## Quick reference

| Helper | Purpose |
|--------|---------|
| `runScript(fn)` | Wrap main; catches errors, emits JSON, exits |
| `parseArgs(specs)` | Typed argv parser; throws on bad input |
| `emitProgress(msg)` | stderr line; visible to human, ignored by orchestrators |
| `emitDebug(msg)` | stderr only when `DEBUG=1` |
| `emitSuccess(opts)` | Build + emit success result, exit 0 |
| `emitError(opts)` | Build + emit error result, exit 1 |
| `withRetry(fn, opts)` | Exponential backoff on RATE_LIMIT / NETWORK / TIMEOUT |
| `requireEnv(name)` | Returns env var or throws MISSING_API_KEY |
| `requireFile(path)` | Throws FILE_NOT_FOUND if absent |
| `requireProject(id)` | Throws PROJECT_NOT_FOUND if project.json missing |
| `ensureFfmpeg()` | Throws FFMPEG_MISSING if binary absent |
| `ensureFfprobe()` | Throws FFMPEG_MISSING if binary absent |
| `slugify(s, opts)` | URL-safe slug, first N words |
| `relativisePath(p)` | Strips cwd prefix so outputs are repo-relative |
| `CliErrorObject` | Structured error with `code`, `retryAfterMs`, `details` |
| `ERROR_CODES` | Const tuple of all valid error code strings |
