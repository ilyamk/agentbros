import { higgsfieldGuards } from "./higgsfield";
import { registerFalGuard } from "./index";
import { genericWarningsGuard, referenceUrlsGuard } from "./generic";
import { gptImageGuard } from "./gpt-image";
import { fluxGuard } from "./flux";
import { nanoGuard } from "./nano";
import { klingGuard } from "./kling";
import { seedanceGuard } from "./seedance";
import { imageUtilitiesGuard } from "./image-utilities";
import { syncLipsyncV3Guard } from "./sync-lipsync-v3";
import { speechGuard } from "./speech";
import { threeDGuard } from "./three-d";
import { analysisGuard } from "./analysis";
import { musicGuard } from "./music";
import { soundGuard } from "./sound";

/**
 * Registers every built-in guard once, in order. A new plugin: its own file exporting a FalGuard,
 * plus one line here (or registerFalGuard() from its own module).
 */
for (const guard of [
  referenceUrlsGuard,
  gptImageGuard,
  fluxGuard,
  nanoGuard,
  klingGuard,
  seedanceGuard,
  imageUtilitiesGuard,
  syncLipsyncV3Guard,
  speechGuard,
  threeDGuard,
  analysisGuard,
  musicGuard,
  soundGuard,
  ...higgsfieldGuards,
  genericWarningsGuard,
])
  registerFalGuard(guard);
export { applyFalGuards, falGuardContext, listFalGuards, registerFalGuard } from "./index";
export type { FalGuard, FalGuardContext, FalGuardInfo } from "./index";
