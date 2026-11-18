import type { MatteEngine, MatteEngineRequest, MatteKind } from "../../types/matte";

/** The asset id of the ONNX weights (src/lib/matte/models.json). */
export const ONNX_MODEL_ID = "models:birefnet-general-lite";
export const ONNX_MODEL_NAME = "birefnet-general-lite-swin-v1-tiny-epoch232";
export const VISION_PREPARE = "pnpm media:prepare --engines matte";
export const ONNX_SYNC = `pnpm assets:sync --id ${ONNX_MODEL_ID}`;
/** Vision's foreground-instance request arrived in macOS 14; person segmentation in macOS 12. */
export const SUBJECT_MIN_MACOS = 14;
export const PERSON_MIN_MACOS = 12;

export type EngineAvailability = { available: boolean; reason?: string };

export type EngineFacts = {
  platform: NodeJS.Platform;
  /** macOS product major version (sw_vers), undefined off macOS. */
  macosMajor?: number;
  vision: EngineAvailability;
  onnx: EngineAvailability;
};

export type EngineChoice =
  | { ok: true; engine: MatteEngine; fallback?: string }
  | { ok: false; code: "INVALID_INPUT" | "VALIDATION" | "ASSET_MISSING"; message: string; fix: string };

/** Why Vision cannot serve `kind` on this host, or null when it can. */
export function visionBlocker(kind: MatteKind, facts: EngineFacts): string | null {
  if (facts.platform !== "darwin") return `Apple Vision needs macOS (this host is ${facts.platform})`;
  const needed = kind === "subject" ? SUBJECT_MIN_MACOS : PERSON_MIN_MACOS;
  if (facts.macosMajor !== undefined && facts.macosMajor < needed)
    return `Vision ${kind} matte needs macOS ${needed}+ (this host has macOS ${facts.macosMajor})`;
  if (!facts.vision.available)
    return `the Vision matte worker is not prepared (${facts.vision.reason ?? "no config"}); run ${VISION_PREPARE}`;
  return null;
}

/**
 * Picks the engine. `auto`: Vision on macOS when it can serve the kind, otherwise ONNX, with the reason recorded as
 * `fallback`. An explicit engine that cannot run is an error naming its fix, never a silent switch.
 */
export function selectEngine(requested: MatteEngineRequest, kind: MatteKind, facts: EngineFacts): EngineChoice {
  const vision = visionBlocker(kind, facts);
  const onnxMissing = facts.onnx.available
    ? null
    : `the BiRefNet ONNX weights are missing (${facts.onnx.reason ?? "not downloaded"}); run ${ONNX_SYNC}`;
  if (requested === "vision") {
    if (!vision) return { ok: true, engine: "vision" };
    const prepare = vision.includes(VISION_PREPARE);
    return {
      ok: false,
      code: prepare ? "VALIDATION" : "INVALID_INPUT",
      message: `--engine vision: ${vision}`,
      fix: prepare ? VISION_PREPARE : "Use --engine onnx (or auto), which runs on every OS",
    };
  }
  if (requested === "onnx") {
    if (!onnxMissing) return { ok: true, engine: "onnx" };
    return { ok: false, code: "ASSET_MISSING", message: `--engine onnx: ${onnxMissing}`, fix: ONNX_SYNC };
  }
  if (!vision) return { ok: true, engine: "vision" };
  if (!onnxMissing)
    return {
      ok: true,
      engine: "onnx",
      ...(facts.platform === "darwin" ? { fallback: `vision unavailable: ${vision}` } : {}),
    };
  const fix =
    facts.platform === "darwin" && !vision.includes("needs macOS") ? `${VISION_PREPARE} (or ${ONNX_SYNC})` : ONNX_SYNC;
  return {
    ok: false,
    code: "ASSET_MISSING",
    message: `No matte engine can run: ${facts.platform === "darwin" ? `${vision}; ` : ""}${onnxMissing}`,
    fix,
  };
}

/** The model name a receipt records for an engine and kind. */
export function modelName(engine: MatteEngine, kind: MatteKind): string {
  if (engine === "onnx") return ONNX_MODEL_NAME;
  return kind === "subject" ? "apple-vision-foreground-instance" : "apple-vision-person-segmentation";
}
