import type { MediaProvider, MediaFetchOptions } from "../../types/media-fetch";
import { publicUrl } from "./http";
export const PROVIDERS = {
  rapidapi: {
    secret: "RAPIDAPI_KEY",
    setup: "https://rapidapi.com/coder2077/api/instagram-downloader-download-instagram-videos-stories1",
    kinds: ["video", "audio", "image"],
    native: ["youtube format"],
    platforms: ["instagram", "tiktok", "facebook", "twitter", "pinterest", "rutube", "likee", "youtube"],
  },
  "apify-easyapi": {
    secret: "APIFY_TOKEN",
    setup: "https://apify.com/easyapi/all-in-one-media-downloader",
    kinds: ["video", "audio", "image"],
    native: [],
    platforms: [
      "tiktok",
      "douyin",
      "instagram",
      "facebook",
      "twitter",
      "snapchat",
      "threads",
      "pinterest",
      "linkedin",
      "tumblr",
      "youtube",
      "vimeo",
      "dailymotion",
      "bilibili",
      "imgur",
      "9gag",
      "rumble",
      "febspot",
      "bitchute",
      "spotify",
      "soundcloud",
      "mixcloud",
      "bandcamp",
      "zingmp3",
      "espn",
      "imdb",
      "reddit",
      "ifunny",
      "izlesene",
      "xiaohongshu",
      "weibo",
      "sohutv",
      "nationalvideo",
      "yingke",
      "ted",
      "getstickerpack",
      "hipi",
      "streamable",
    ],
  },
  "apify-wilcode": {
    secret: "APIFY_TOKEN",
    setup: "https://apify.com/wilcode/all-social-media-video-downloader",
    kinds: ["video", "audio"],
    native: ["mergeAV", "mergeYoutube quality"],
    platforms: ["youtube", "facebook", "instagram", "twitter", "tiktok", "dailymotion", "linkedin", "vimeo"],
  },
} as const;
const domains: Record<string, string[]> = {
  youtube: ["youtube.com", "youtu.be", "youtube-nocookie.com"],
  instagram: ["instagram.com"],
  facebook: ["facebook.com", "fb.watch", "fb.com"],
  twitter: ["twitter.com", "x.com", "t.co"],
  tiktok: ["tiktok.com"],
  douyin: ["douyin.com", "iesdouyin.com"],
  pinterest: ["pinterest.com", "pin.it"],
  reddit: ["reddit.com", "redd.it"],
  threads: ["threads.net", "threads.com"],
  xiaohongshu: ["xiaohongshu.com", "xhslink.com"],
  bilibili: ["bilibili.com", "b23.tv"],
  spotify: ["spotify.com", "spotify.link"],
  soundcloud: ["soundcloud.com", "on.soundcloud.com"],
  sohutv: ["tv.sohu.com"],
  nationalvideo: ["quanmin.tv"],
  zingmp3: ["zingmp3.vn"],
};
export function platformFor(value: string): string {
  const host = publicUrl(value).hostname.toLowerCase();
  for (const [platform, aliases] of Object.entries(domains))
    if (aliases.some((domain) => host === domain || host.endsWith(`.${domain}`))) return platform;
  for (const platform of PROVIDERS["apify-easyapi"].platforms)
    if (host === `${platform}.com` || host.endsWith(`.${platform}.com`)) return platform;
  return "unknown";
}
export function isShortUrl(value: string): boolean {
  const h = publicUrl(value).hostname;
  return [
    "t.co",
    "fb.watch",
    "pin.it",
    "redd.it",
    "b23.tv",
    "xhslink.com",
    "spotify.link",
    "on.soundcloud.com",
    "vm.tiktok.com",
    "vt.tiktok.com",
    "youtu.be",
  ].includes(h);
}
export function routes(
  value: string,
  options: Pick<MediaFetchOptions, "provider" | "kind">,
  env: NodeJS.ProcessEnv = process.env,
): MediaProvider[] {
  const platform = platformFor(value);
  const all: MediaProvider[] =
    options.provider === "auto" ? ["rapidapi", "apify-easyapi", "apify-wilcode"] : [options.provider];
  return all.filter(
    (provider) =>
      !!env[PROVIDERS[provider].secret] &&
      (provider === "apify-easyapi" || (PROVIDERS[provider].platforms as readonly string[]).includes(platform)) &&
      (options.kind !== "image" || provider !== "apify-wilcode"),
  );
}
export function doctor(env: NodeJS.ProcessEnv = process.env) {
  return Object.entries(PROVIDERS).map(([provider, c]) => ({
    provider,
    secret: c.secret,
    configured: !!env[c.secret],
    setup: c.setup,
    instruction: `Add ${c.secret} to the workspace environment and authorise a quota or budget. A key alone does not permit spending.`,
  }));
}
