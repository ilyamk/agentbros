/**
 * Strict CSP has no 'unsafe-eval'. zod 4 probes `new Function` the first time it parses an object unless `jitless` is
 * set, and the probe alone reports a CSP violation. main.tsx imports this module first, before any module that parses
 * at load (lib/fixtures.ts does), and reads the returned config: the call is the export's value, so the bundler cannot drop
 * it (package.json `sideEffects` lists only CSS).
 */
import { config } from "zod";

export const ZOD_CONFIG = config({ jitless: true });
