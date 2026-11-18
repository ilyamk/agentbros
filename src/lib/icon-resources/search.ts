import { IconSearchResultSchema, type IconCandidate, type IconProvider } from "../../types/icon-resources";
import { localCatalogue, providers, svglCatalogue } from "./providers";
import { IconHttp } from "./http";
import { z } from "zod";
import { CliErrorObject } from "../cli";

export const synonyms: Record<string, string[]> = {
  защита: ["shield", "lock", "privacy"],
  данные: ["database", "data"],
  персональных: ["privacy", "user"],
  безопасность: ["shield", "lock", "security"],
  деньги: ["money", "wallet", "currency"],
  рост: ["trend", "growth", "chart"],
  команда: ["users", "team"],
  облако: ["cloud"],
  время: ["clock", "timer"],
  скорость: ["speed", "lightning", "gauge"],
  оплата: ["payment", "credit-card", "wallet"],
  поиск: ["search", "magnifying-glass"],
  видео: ["video", "film", "camera"],
  связь: ["chat", "network", "message"],
  обучение: ["book", "graduation", "school"],
};
const normal = (s: string) => s.normalize("NFKC").toLowerCase();
export function searchTerms(query: string, extra: string[] = []) {
  if (!query.trim() || query.length > 500 || extra.length > 8 || extra.some((q) => q.length > 100))
    throw new CliErrorObject({
      code: "INVALID_INPUT",
      message: "Provide a query (max 500 characters) and up to eight short expansions",
    });
  const words = normal(query)
    .split(/[^\p{L}\p{N}-]+/u)
    .filter(Boolean);
  return [
    ...new Set([normal(query), ...words, ...extra.map(normal), ...words.flatMap((w) => synonyms[w] ?? [])]),
  ].slice(0, 32);
}
export async function searchIcons(
  options: {
    query: string;
    queries?: string[];
    providers?: IconProvider[];
    kind?: "icon" | "brand";
    offline?: boolean;
    limit?: number;
    collection?: string;
    preferred?: string;
  },
  http = new IconHttp(),
  cached: IconCandidate[] = [],
) {
  const terms = searchTerms(options.query, options.queries),
    limit = options.limit ?? 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "Limit must be 1–100" });
  const selected =
    options.providers ??
    providers.filter((p) =>
      options.kind === "brand" ? ["simple-icons", "svgl"].includes(p) : !["simple-icons", "svgl"].includes(p),
    );
  if (!selected.length)
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "Select at least one icon provider" });
  const statuses: { provider: IconProvider; status: string; message?: string; code?: string }[] = [];
  const candidates: IconCandidate[] = cached.filter((c) => selected.includes(c.provider));
  const remote: IconCandidate[] = [];
  const svglMatches = new Set<string>();
  await Promise.all(
    selected.map(async (provider) => {
      try {
        if (["iconify", "svgl"].includes(provider) && options.offline) {
          statuses.push({ provider, status: "offline" });
          return;
        }
        if (provider === "svgl") {
          const found = await svglCatalogue(http, options.query);
          found.forEach((c) => svglMatches.add(c.id));
          candidates.push(...found);
        } else if (provider === "iconify") {
          const schema = z.object({ icons: z.array(z.string()).max(999) });
          for (const term of terms.filter((t) => /^[a-z0-9 -]+$/.test(t)).slice(0, 3)) {
            const result = schema.parse(
              await http.json(
                `https://api.iconify.design/search?query=${encodeURIComponent(term)}&limit=32${options.collection ? `&prefix=${encodeURIComponent(options.collection)}` : ""}`,
              ),
            );
            for (const id of result.icons) {
              const [collection, name] = id.split(":");
              if (!/^[a-z0-9-]+$/.test(collection) || !/^[a-z0-9-]+$/.test(name))
                throw Error("Invalid Iconify result identifier");
              const local = (
                { ph: "phosphor", lucide: "lucide", tabler: "tabler", "simple-icons": "simple-icons" } as Record<
                  string,
                  IconProvider
                >
              )[collection];
              if (local && selected.includes(local)) {
                const canonical =
                  collection === "ph" || collection === "tabler"
                    ? name.replace(/-(thin|light|bold|fill|duotone|filled)$/, "")
                    : name;
                if (
                  localCatalogue(local as "phosphor" | "lucide" | "tabler" | "simple-icons").some(
                    (c) => c.name === canonical,
                  )
                )
                  continue;
              }
              remote.push({
                id: `iconify:${id}`,
                provider: "iconify",
                collection,
                name,
                title: name,
                kind: collection === "simple-icons" ? "brand" : "icon",
                tags: [],
                variants: ["original"],
                version: "live",
                source: `https://api.iconify.design/${collection}/${name}.svg`,
                rights: {
                  licence: "unknown",
                  licenceUrl: "https://iconify.design/docs/icons/icon-set-basics.html",
                  notice: "Inspect this exact collection to retrieve its author and licence metadata.",
                  attribution: "unverified",
                  commercialAllowed: "unknown",
                  brand: collection === "simple-icons",
                },
              });
            }
          }
        } else candidates.push(...localCatalogue(provider as "phosphor" | "lucide" | "tabler" | "simple-icons"));
        statuses.push({ provider, status: "ok" });
      } catch (error) {
        statuses.push({
          provider,
          status: "error",
          message: String(error),
          code: error instanceof CliErrorObject ? error.code : "VALIDATION",
        });
      }
    }),
  );
  if (statuses.every((s) => s.status === "error"))
    throw new CliErrorObject({ code: "NETWORK", message: "All icon sources failed", details: { statuses } });
  const seen = new Set<string>();
  const results = [...candidates, ...remote]
    .filter((c) => (!options.kind || c.kind === options.kind) && !seen.has(c.id) && !!seen.add(c.id))
    .map((c) => {
      const text = normal(`${c.name} ${c.title} ${c.tags.join(" ")}`),
        matches = terms.filter((t) => text.includes(t));
      const score =
        (normal(c.title) === normal(options.query) ? 100 : 0) +
        matches.reduce((s, t) => s + (normal(c.name) === t ? 20 : 5), 0) +
        (c.provider === options.preferred ? 1000 : 0);
      return { ...c, score, matchReasons: matches };
    })
    .filter((c) => c.matchReasons.length || svglMatches.has(c.id))
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, limit);
  return IconSearchResultSchema.parse({
    results,
    queries: terms,
    synonymsVersion: 1,
    statuses: statuses.sort((a, b) => a.provider.localeCompare(b.provider)),
    partial: statuses.some((s) => s.status === "error"),
    next: "Inspect a candidate ID before acquire; use the project profile to keep one family.",
  });
}
