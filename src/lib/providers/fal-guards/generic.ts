import { fail, isObject } from "../fal-errors";
import type { FalGuard } from "./index";

function validateReferenceUrls(value: unknown, key = "input"): void {
  if (typeof value === "string" && /_url$/.test(key)) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      fail(`${key}: requires an uploaded HTTP(S) or data reference, not a local path.`);
    }
    if (!["http:", "https:", "data:"].includes(url!.protocol)) fail(`${key}: unsupported reference URL protocol.`);
  }
  if (Array.isArray(value))
    value.forEach((item) => validateReferenceUrls(item, key.endsWith("_urls") ? key.slice(0, -1) : key));
  if (isObject(value)) for (const [childKey, child] of Object.entries(value)) validateReferenceUrls(child, childKey);
}
/** Every endpoint: `*_url` fields must be uploaded HTTP(S) or data references, before any family guard. */
export const referenceUrlsGuard: FalGuard = {
  id: "reference-urls",
  phase: "before",
  match: () => true,
  check: (input) => validateReferenceUrls(input),
};
/** Every endpoint, after the others: sync_mode and missing remote media metadata warnings. */
export const genericWarningsGuard: FalGuard = {
  id: "generic-warnings",
  phase: "after",
  match: () => true,
  check: (input, ctx, warnings) => {
    if (input.sync_mode === true)
      warnings.push(
        "sync_mode returns inline output with no provider history; durable output publication must still occur locally.",
      );
    // Unknown remote media metadata is explicit; an ffprobe step must establish it before production submit.
    const urls = JSON.stringify(input).match(/https?:\/\/[^"\s]+/g) ?? [];
    if (urls.some((url) => !ctx.media[url]))
      warnings.push(
        "Some remote reference media lack local size/duration metadata; provider validation remains necessary.",
      );
  },
};
