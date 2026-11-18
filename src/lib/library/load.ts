import { registerHooks } from "node:module";
import type { LibraryItem, LibraryStyle } from "../../motion/library/types";

let hooked = false;

/**
 * Loads the motion library registry in Node. Scripts run as CommonJS, but some render packages
 * (such as `@remotion/media`) export only an ESM entry; resolve those through the `import` condition.
 * Import lazily, after argument parsing: the component graph takes several seconds to load.
 */
export async function loadLibrary(): Promise<{ items: LibraryItem[]; styles: LibraryStyle[] }> {
  if (!hooked) {
    registerHooks({
      resolve(specifier, context, next) {
        try {
          return next(specifier, context);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ERR_PACKAGE_PATH_NOT_EXPORTED") throw error;
          return next(specifier, { ...context, conditions: ["import", ...(context.conditions ?? [])] });
        }
      },
    });
    hooked = true;
  }
  const registry = await import("../../motion/library/registry");
  return { items: registry.libraryItems, styles: registry.libraryStyles };
}
