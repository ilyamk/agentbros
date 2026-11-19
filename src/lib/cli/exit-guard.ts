import { setFlagsFromString } from "node:v8";

// Node 24 (V8 13.6) can deadlock in process.exit: platform shutdown joins a background compile job that allocates on
// the heap and waits for a garbage collection only the exiting main thread could run. gdb showed it with concurrent
// Sparkplug and with Maglev. Both flags take effect at run time (concurrent TurboFan cannot be turned off here, but it
// allocates only on the main thread); Node 26 does not hang and keeps the defaults.
const EXIT_SAFE_FLAGS = ["--no-concurrent-sparkplug", "--no-maglev"];
if (Number(process.versions.node.split(".")[0]) < 26) for (const flag of EXIT_SAFE_FLAGS) setFlagsFromString(flag);
