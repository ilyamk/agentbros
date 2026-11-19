import { setFlagsFromString } from "node:v8";

// Node 24 (V8 13.6) can deadlock in process.exit: platform shutdown joins a background compile job that waits for a
// garbage collection only the exiting main thread could run (seen with Sparkplug; the optimising compilers, OSR and
// code-cache deserialisation allocate on the same background heap). Compiling on the main thread instead removes
// those jobs; Node 26 does not hang and keeps the defaults.
const BACKGROUND_COMPILE_FLAGS = [
  "--no-concurrent-sparkplug",
  "--no-concurrent-recompilation",
  "--no-concurrent-osr",
  "--no-concurrent-cache-deserialization",
];
if (Number(process.versions.node.split(".")[0]) < 26)
  for (const flag of BACKGROUND_COMPILE_FLAGS) setFlagsFromString(flag);
