import { loadHiggsfieldRestylePresets } from "../../models/hf-restyle-presets";
import { fail } from "../fal-errors";
import { arrayField, type FalGuard, type FalGuardContext } from "./index";

/** Genjutsu source limits this guard enforces (over the trim length is a warning); reference profiles are checked against them. */
export const GENJUTSU_SOURCE_LIMITS = {
  minDurationSec: 4,
  trimDurationSec: 30,
  objectSwapMinPixels: 409600,
  restyleMaxBytes: 200 * 1024 * 1024,
} as const;
const G = GENJUTSU_SOURCE_LIMITS;

function sourceDuration(
  input: Record<string, unknown>,
  ctx: FalGuardContext,
  warnings: string[],
  sourceBilling: boolean,
): void {
  const media = ctx.media[String(input.video_url)];
  if (media?.durationSec === undefined)
    warnings.push("Genjutsu source duration is unknown; measure video_url to validate the 4-second minimum.");
  else {
    if (media.durationSec < G.minDurationSec) fail("Genjutsu source video must be at least 4 seconds.");
    if (media.durationSec > G.trimDurationSec)
      warnings.push(
        sourceBilling
          ? "Genjutsu source is trimmed to 30 seconds; billing uses the prepared source duration, rounded up to a whole second."
          : "Restyle source and audio are trimmed to the first 30 seconds; exact output duration and FPS may differ from the source.",
      );
  }
}

export const higgsfieldGenjutsuGuard: FalGuard = {
  id: "higgsfield-genjutsu",
  match: (info) => info.provider === "higgsfield" && info.endpoint.startsWith("higgsfield/genjutsu/"),
  check(input, ctx, warnings, info) {
    // https://docs.higgsfield.ai/docs/models/genjutsu/motion-transfer.md
    // https://docs.higgsfield.ai/docs/models/genjutsu/object-swap.md
    // https://docs.higgsfield.ai/docs/models/genjutsu/restyle.md
    // Rounded prepared-source billing: src/lib/models/hf-prices.json (motion-transfer/object-swap estimates).
    sourceDuration(input, ctx, warnings, info.endpoint !== "higgsfield/genjutsu/restyle/v1.0");
    // User-tested web/API prompting convention, 2026-11-15; not a published provider token contract.
    for (const token of String(input.prompt ?? "").matchAll(/@(Video|Image)(?:\s+\d+|[A-Za-z0-9_-]*)/gi)) {
      const parsed = /^@(Video|Image)\s*([1-9]\d*)$/i.exec(token[0]);
      const index = Number(parsed?.[2]),
        count = token[1]!.toLowerCase() === "video" ? 1 : arrayField(input, "image_urls").length;
      if (!parsed || index > count)
        fail(`Genjutsu marker ${token[0]} has no attached ${token[1]!.toLowerCase()}; use one-based attachment order.`);
    }
    if (info.endpoint === "higgsfield/genjutsu/object-swap/v1.0") {
      // https://docs.higgsfield.ai/docs/models/genjutsu/object-swap.md: source VIDEO minimum, not reference image maximum.
      const media = ctx.media[String(input.video_url)];
      if (media?.width === undefined || media.height === undefined)
        warnings.push(
          "Object-swap source pixel count is unknown; measure video_url to validate at least 409,600 pixels per frame.",
        );
      else if (media.width * media.height < G.objectSwapMinPixels)
        fail("Object-swap source video needs at least 409,600 pixels per frame.");
    }
    if (info.endpoint === "higgsfield/genjutsu/restyle/v1.0") {
      // https://docs.higgsfield.ai/docs/models/genjutsu/restyle.md: 200 MiB source maximum and current preset UUID.
      const bytes = ctx.media[String(input.video_url)]?.bytes;
      if (bytes === undefined)
        warnings.push("Restyle source size is unknown; measure video_url to validate the 200 MiB maximum.");
      else if (bytes > G.restyleMaxBytes) fail("Restyle source video must be no larger than 200 MiB.");
      let cache;
      try {
        cache = loadHiggsfieldRestylePresets();
      } catch {
        fail("Restyle preset cache is missing or invalid. Refresh with pnpm hf:sync --presets.");
      }
      if (!cache.presets.some((preset) => preset.id === input.preset_id))
        fail(`Unknown restyle preset_id ${String(input.preset_id)}. Refresh with pnpm hf:sync --presets.`);
      if (Date.parse(ctx.now ?? new Date().toISOString()) - Date.parse(cache.asOf) > 30 * 86400000)
        warnings.push("Restyle preset cache is older than 30 days; refresh with pnpm hf:sync --presets.");
    }
  },
};

export const higgsfieldLightGuard: FalGuard = {
  id: "higgsfield-genjutsu-light",
  match: (info) => info.provider === "higgsfield" && info.endpoint.startsWith("higgsfield/genjutsu-light/"),
  check(_input, _ctx, warnings) {
    // Recorded catalogue family genjutsu-light (catalog-models.json); no workflow documentation/schema exists.
    warnings.push(
      "Genjutsu Light has no documented usage-note limits; source duration and reference limits are unknown. The catalogue description says it uses the first 15 seconds and preserves source audio; Genjutsu limits cannot be assumed.",
    );
  },
};

export const higgsfieldCinemaGuard: FalGuard = {
  id: "higgsfield-cinema",
  match: (info) => info.provider === "higgsfield" && info.endpoint.startsWith("higgsfield/cinema-studio/"),
  check(input, ctx, warnings) {
    // https://docs.higgsfield.ai/docs/models/cinema-studio-4/generate.md: tokens are one-based attached references.
    for (const token of String(input.prompt).matchAll(/<<<(image|video|audio)_(\d+)>>>/g)) {
      const index = Number(token[2]);
      if (index < 1 || index > arrayField(input, `${token[1]}_urls`).length)
        fail(`Cinema prompt token ${token[0]} must refer to an attached ${token[1]}.`);
    }
    // Same page: separate 30-second video/audio budgets are normalised, not rejection limits.
    for (const kind of ["video", "audio"]) {
      const urls = arrayField(input, `${kind}_urls`);
      let total = 0;
      for (const url of urls) {
        const duration = ctx.media[String(url)]?.durationSec;
        if (duration === undefined)
          warnings.push(
            `Cinema ${kind} reference duration is unknown; its separate 30-second budget cannot be checked.`,
          );
        else total += duration;
      }
      if (total > 30)
        warnings.push(`Cinema ${kind} references may be normalised to a separate 30-second total budget.`);
    }
  },
};

export const higgsfieldSoulGuard: FalGuard = {
  id: "higgsfield-soul",
  match: (info) => info.provider === "higgsfield" && info.endpoint.startsWith("higgsfield-ai/soul/"),
  check(input, _ctx, warnings, info) {
    // https://docs.higgsfield.ai/docs/models/soul-2/generate.md: account-scoped, completed training required.
    // https://docs.higgsfield.ai/docs/models/soul-cinema/generate.md
    // https://docs.higgsfield.ai/docs/models/soul-standard/generate.md
    if (input.custom_reference_id)
      warnings.push(
        "custom_reference_id must belong to the calling account and have completed training; ownership and training status cannot be verified offline.",
      );
    // https://docs.higgsfield.ai/docs/models/soul-2/generate.md: schema accepts zero, runtime does not for character references.
    if (
      info.endpoint === "higgsfield-ai/soul/v2/standard" &&
      input.custom_reference_id &&
      input.custom_reference_strength === 0
    )
      fail("Soul 2 custom_reference_strength must be greater than 0 when using custom_reference_id.");
  },
};

export const higgsfieldMarketingGuard: FalGuard = {
  id: "higgsfield-marketing",
  match: (info) =>
    info.provider === "higgsfield" &&
    (info.endpoint === "marketing-studio/image" || info.endpoint.startsWith("marketing-studio/image/")),
  check(input, ctx, warnings) {
    // https://docs.higgsfield.ai/docs/models/marketing-studio-image/flare.md
    // https://docs.higgsfield.ai/docs/models/marketing-studio-image/sunburst.md
    // https://docs.higgsfield.ai/docs/models/marketing-studio-image/generate-and-edit.md
    for (const url of arrayField(input, "image_urls")) {
      const mime = ctx.media[String(url)]?.contentType?.split(";")[0]?.toLowerCase();
      if (mime === undefined)
        warnings.push("Marketing reference image format is unknown; verify JPEG, PNG or WebP media.");
      else if (!["image/jpeg", "image/png", "image/webp"].includes(mime))
        fail("Marketing references must be JPEG, PNG or WebP.");
    }
    // Same pages: preset existence and semantic product/person order are not represented in JSON Schema.
    if (input.enhance_prompt === true)
      warnings.push(
        "Verify preset_id exists with GET /marketing-studio/image/presets; put the product image first and optional person/model second. Preset existence and image roles cannot be verified offline.",
      );
  },
};

export const higgsfieldGuards: readonly FalGuard[] = [
  higgsfieldGenjutsuGuard,
  higgsfieldLightGuard,
  higgsfieldCinemaGuard,
  higgsfieldSoulGuard,
  higgsfieldMarketingGuard,
];
