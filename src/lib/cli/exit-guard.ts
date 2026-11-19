import { setFlagsFromString } from "node:v8";

// Node 24 (V8 13.6) can deadlock in process.exit: platform shutdown joins a background Sparkplug compile that waits
// for a garbage collection only the exiting main thread could run. Compiling Sparkplug code on the main thread instead
// removes that job; Node 26 does not hang and keeps the default.
if (Number(process.versions.node.split(".")[0]) < 26) setFlagsFromString("--no-concurrent-sparkplug");
