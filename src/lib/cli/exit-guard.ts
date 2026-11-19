import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";

// Node 24 and 26 (V8 13.6, 14.6) can deadlock in process.exit: platform shutdown joins a background compile job that
// allocates on the heap and waits for a garbage collection only the exiting main thread could run. gdb showed it with
// concurrent Sparkplug and with Maglev. Both flags take effect at run time and stop new jobs (concurrent TurboFan
// cannot be turned off here, but it allocates only on the main thread); collectBeforeExit releases a job started
// before this module loaded, which could still be waiting for a collection.
for (const flag of ["--no-concurrent-sparkplug", "--no-maglev"]) setFlagsFromString(flag);

let gc: (() => void) | undefined;
try {
  setFlagsFromString("--expose-gc");
  gc = runInNewContext("gc") as () => void;
} catch {
  gc = undefined;
} finally {
  setFlagsFromString("--no-expose-gc");
}

/** Run a collection on the main thread right before process.exit, releasing any background job waiting for one. */
export function collectBeforeExit(): void {
  try {
    gc?.();
  } catch {
    /* Exiting matters more than the collection. */
  }
}
