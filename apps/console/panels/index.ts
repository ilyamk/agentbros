/** Every panel the console knows, registered once at boot (RFC 0004 §5.2). */
import { registerFilmPanels } from "./film";
import { registerFootagePanels } from "./footage";
import { registerGenericPanels } from "./generic";
import { registerRoutePanels } from "./routes";

let registered = false;

export function registerAllPanels(): void {
  if (registered) return;
  registered = true;
  registerGenericPanels();
  registerFilmPanels();
  registerFootagePanels();
  registerRoutePanels();
}
