import { z } from "zod";

export const ResourceTaskSchema = z.enum([
  "educational-archive",
  "product-graphics",
  "sound-effects",
  "motion-design",
  "three-dimensional",
  "music",
]);
export const MANUAL_RESOURCE_CATALOGUES = [
  {
    id: "kenney",
    kinds: ["image", "audio", "model"],
    catalogUrl: "https://kenney.nl/assets",
    terms: "https://kenney.nl/support",
    tasks: ["product-graphics", "sound-effects", "three-dimensional"],
    note: "Asset-page CC0 applies to assets, not Kenney branding. Download original pack manually; preserve licence file. No implemented API or automatic archive extraction.",
  },
  {
    id: "ambientcg",
    kinds: ["image", "model"],
    catalogUrl: "https://ambientcg.com/list",
    terms: "https://docs.ambientcg.com/license/",
    tasks: ["three-dimensional", "product-graphics"],
    note: "CC0 covers assets and preview images under documented terms; select original resolution/maps manually. Public API documentation exists, but this platform does not implement it.",
  },
  {
    id: "pixabay-music",
    kinds: ["audio"],
    catalogUrl: "https://pixabay.com/music/",
    terms: "https://pixabay.com/service/terms/",
    tasks: ["music"],
    note: "No music API, and the terms forbid scraping: open the site and download by hand. The Pixabay Content Licence allows commercial use without credit, but a track can still trigger a platform content claim; keep the page link.",
  },
  {
    id: "youtube-audio-library",
    kinds: ["audio"],
    catalogUrl: "https://www.youtube.com/audiolibrary",
    terms: "https://support.google.com/youtube/answer/3376882",
    tasks: ["music"],
    note: "Manual selection in YouTube Studio. Licence is per track, some need a credit, and only YouTube use is covered: do not treat a track as cleared for other platforms.",
  },
  {
    id: "ncs",
    kinds: ["audio"],
    catalogUrl: "https://ncs.io/music",
    terms: "https://ncs.io/usage-policy",
    tasks: ["music"],
    note: "Manual download. Free use is limited to individual creators' videos with the stated credit; commercial use and advertising need a separate licence. Check the usage policy for the track.",
  },
  {
    id: "ende-app",
    kinds: ["audio"],
    catalogUrl: "https://ende.app",
    terms: "https://ende.app",
    tasks: ["music"],
    note: "Sascha Ende's catalogue, manual download. Tracks are offered under CC BY with credit, and other licences for use without credit; read the licence on the track's own page and record it.",
  },
  {
    id: "rive",
    kinds: ["animation"],
    catalogUrl: "https://rive.app/marketplace/",
    terms: "https://www.rive.app/pricing",
    tasks: ["motion-design", "product-graphics"],
    note: "Check each creator file licence and current export plan. Free account is not a universal downloadable video or commercial asset licence. Import permitted original exports manually.",
  },
] as const;
export function resourceCatalogue(provider: string, query = "") {
  if (query.length > 1000) throw new Error("Catalogue query exceeds limit.");
  const catalogue = MANUAL_RESOURCE_CATALOGUES.find((item) => item.id === provider);
  if (!catalogue) throw new Error("No manual catalogue route for this provider.");
  return {
    ...catalogue,
    query,
    route: "manual" as const,
    searchImplemented: false,
    acquisition: "local-file-import" as const,
    instructions:
      "Open the catalogue, search the supplied query using its UI, record the selected asset page and licence, and import a permitted original with --source-file. No request has been made.",
  };
}
export function recommendResourceRoutes(taskInput: string) {
  const task = ResourceTaskSchema.parse(taskInput);
  const manual = MANUAL_RESOURCE_CATALOGUES.filter((item) => (item.tasks as readonly string[]).includes(task)).map(
    (item) => resourceCatalogue(item.id),
  );
  const api =
    task === "educational-archive"
      ? [
          {
            provider: "nasa",
            route: "metadata-api",
            searchImplemented: true,
            acquisition: "local-file-import",
            note: "Scientific/archive reference; all candidates start with unknown rights. Advertising/endorsement are not cleared.",
          },
          {
            provider: "wikimedia",
            route: "metadata-api",
            searchImplemented: true,
            acquisition: "selected-original",
            note: "Per-file licence, attribution and derivative conditions.",
          },
        ]
      : task === "sound-effects"
        ? [
            {
              provider: "freesound",
              route: "metadata-api",
              searchImplemented: true,
              acquisition: "oauth-original",
              note: "Per-sound licence; compressed previews require explicit selection.",
            },
          ]
        : task === "music"
          ? [
              {
                provider: "openverse",
                route: "metadata-api",
                searchImplemented: true,
                acquisition: "scripts/music.ts",
                note: "Use scripts/music.ts, which also covers ccMixter, Internet Archive, Freesound and Jamendo with licence per track.",
              },
            ]
          : task === "three-dimensional"
            ? [
                {
                  provider: "poly-haven",
                  route: "dedicated-api",
                  searchImplemented: true,
                  acquisition: "selected-original",
                  note: "Use dedicated poly-haven script; checked file selector/hash, no embedded-script execution.",
                },
              ]
            : [];
  return {
    task,
    api,
    manual,
    automaticAcquisition: false,
    note: "Routing advice does not approve a licence, submit a request, install a runtime or download media.",
  };
}
