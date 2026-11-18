import { emitProgress, emitResult, ensureFfmpeg, ensureFfprobe, parseArgs, runScript } from "../src/lib/cli";
import { FLASH_FIX, flashLines, measureFlashesInFile } from "../src/lib/sensors/flash";
import { probeVideo } from "../src/lib/vision/media";

const SPECS = [
  {
    name: "render",
    required: true,
    description: "Any video file: every frame is checked for WCAG 2.3.1 general and saturated-red flashes",
  },
] as const;

void runScript(async () => {
  const startedAt = Date.now();
  const args = parseArgs(SPECS);
  ensureFfmpeg();
  ensureFfprobe();
  const report = measureFlashesInFile(args.render!, probeVideo(args.render!).fps);
  const lines = flashLines(report);
  for (const line of lines) emitProgress(`FLASH_RISK ${line}`);
  if (!lines.length) return { outputs: [], metadata: report };
  return emitResult({
    ok: false,
    error: "VALIDATION",
    message: `FLASH_RISK: ${lines.length} stretch(es) flash more than three times a second over more than ${Math.round(report.areaLimit * 1000) / 10}% of the frame. ${FLASH_FIX}`,
    metadata: { ...report, findings: lines },
    elapsedMs: Date.now() - startedAt,
  });
});
