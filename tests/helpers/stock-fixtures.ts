/** Offline fixtures for the stock adapters (Unsplash, Pixabay, Pexels): API-shaped bodies and a recording fetch. */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export const TIME = "2026-11-17T10:00:00.000Z";
export const TIME_MS = Date.parse(TIME);
/** One-pixel PNG: real image bytes for imports. */
export const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=",
  "base64",
);

export type Call = { url: string; headers: Record<string, string> };
type Reply = unknown | Response | ((url: string) => unknown | Response);

/** Answers by the first route whose substring is in the URL; records every call with its headers. */
export function routedFetch(routes: [string, Reply][], calls: Call[] = []) {
  const fetch: typeof globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, headers: { ...((init?.headers as Record<string, string>) ?? {}) } });
    const route = routes.find(([part]) => url.includes(part));
    if (!route) return new Response("not found", { status: 404 });
    const reply = typeof route[1] === "function" ? (route[1] as (url: string) => unknown)(url) : route[1];
    if (reply instanceof Response) return reply.clone();
    if (Buffer.isBuffer(reply)) return new Response(new Uint8Array(reply));
    return new Response(JSON.stringify(reply), { headers: { "content-type": "application/json" } });
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

export const json = (body: unknown, headers: Record<string, string> = {}, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

export function unsplashPhoto(overrides: Record<string, unknown> = {}) {
  return {
    id: "abc123",
    width: 4000,
    height: 6000,
    color: "#8c5a3c",
    blur_hash: "LKO2?U%2Tw=w]~RBVZRi};RPxuwH",
    description: "Barista pours steamed milk",
    alt_description: "barista pouring latte art in a cafe",
    urls: {
      raw: "https://images.unsplash.com/photo-1?ixid=M3wxfDB8MXxzZWFyY2g&ixlib=rb-4.0.3",
      full: "https://images.unsplash.com/photo-1?ixid=M3wxfDB8MXxzZWFyY2g&q=85",
      regular: "https://images.unsplash.com/photo-1?ixid=M3wxfDB8MXxzZWFyY2g&w=1080",
      small: "https://images.unsplash.com/photo-1?ixid=M3wxfDB8MXxzZWFyY2g&w=400",
      thumb: "https://images.unsplash.com/photo-1?ixid=M3wxfDB8MXxzZWFyY2g&w=200",
    },
    links: {
      html: "https://unsplash.com/photos/abc123",
      download: "https://unsplash.com/photos/abc123/download",
      download_location: "https://api.unsplash.com/photos/abc123/download?ixid=M3wxfDB8MXxzZWFyY2g",
    },
    user: {
      username: "jane",
      name: "Jane Doe",
      links: { html: "https://unsplash.com/@jane" },
    },
    ...overrides,
  };
}

export function pixabayImage(overrides: Record<string, unknown> = {}) {
  return {
    id: 195893,
    pageURL: "https://pixabay.com/photos/coffee-latte-195893/",
    type: "photo",
    tags: "coffee, latte, cafe",
    previewURL: "https://cdn.pixabay.com/photo/2013/10/15/coffee_150.jpg",
    webformatURL: "https://pixabay.com/get/coffee_640.jpg",
    largeImageURL: "https://pixabay.com/get/coffee_1280.jpg",
    imageWidth: 4000,
    imageHeight: 6000,
    user_id: 48777,
    user: "Josch13",
    ...overrides,
  };
}

export function pixabayVideo(overrides: Record<string, unknown> = {}) {
  return {
    id: 125,
    pageURL: "https://pixabay.com/videos/id-125/",
    type: "film",
    tags: "coffee, pour",
    duration: 12,
    videos: {
      large: { url: "", width: 0, height: 0, size: 0, thumbnail: "" },
      medium: {
        url: "https://cdn.pixabay.com/video/125/medium.mp4",
        width: 1920,
        height: 1080,
        size: 9_000_000,
        thumbnail: "https://cdn.pixabay.com/video/125/medium.jpg",
      },
      small: {
        url: "https://cdn.pixabay.com/video/125/small.mp4",
        width: 1280,
        height: 720,
        size: 4_000_000,
        thumbnail: "https://cdn.pixabay.com/video/125/small.jpg",
      },
      tiny: {
        url: "https://cdn.pixabay.com/video/125/tiny.mp4",
        width: 960,
        height: 540,
        size: 2_000_000,
        thumbnail: "https://cdn.pixabay.com/video/125/tiny.jpg",
      },
    },
    user_id: 1,
    user: "Coverr",
    ...overrides,
  };
}

export function pexelsPhoto(overrides: Record<string, unknown> = {}) {
  return {
    id: 2014422,
    width: 3024,
    height: 3024,
    url: "https://www.pexels.com/photo/brown-rocks-2014422/",
    photographer: "Joey Farina",
    photographer_url: "https://www.pexels.com/@joey",
    photographer_id: 680589,
    avg_color: "#978E82",
    alt: "Brown rocks during golden hour",
    src: {
      original: "https://images.pexels.com/photos/2014422/pexels-photo-2014422.jpeg",
      medium: "https://images.pexels.com/photos/2014422/pexels-photo-2014422.jpeg?h=350",
      tiny: "https://images.pexels.com/photos/2014422/pexels-photo-2014422.jpeg?h=200",
    },
    ...overrides,
  };
}

export function pexelsVideo(overrides: Record<string, unknown> = {}) {
  return {
    id: 3,
    width: 3840,
    height: 2160,
    url: "https://www.pexels.com/video/3/",
    image: "https://images.pexels.com/videos/3/preview.jpg",
    duration: 8,
    user: { id: 9, name: "Video Maker", url: "https://www.pexels.com/@maker" },
    video_files: [
      { link: "https://videos.pexels.com/3/sd.mp4", width: 960, height: 540, file_type: "video/mp4", quality: "sd" },
      { link: "https://videos.pexels.com/3/hd.mp4", width: 1920, height: 1080, file_type: "video/mp4", quality: "hd" },
      {
        link: "https://videos.pexels.com/3/uhd.mp4",
        width: 3840,
        height: 2160,
        file_type: "video/mp4",
        quality: "uhd",
      },
      {
        link: "https://videos.pexels.com/3/hls.m3u8",
        width: 3840,
        height: 2160,
        file_type: "application/vnd.apple.mpegurl",
      },
    ],
    ...overrides,
  };
}

/** A temporary checkout root with one project, for acquisition tests. */
export function projectRoot(projectId = "demo") {
  const root = mkdtempSync(path.join(tmpdir(), "stock-"));
  const project = path.join(root, "public/projects", projectId);
  mkdirSync(project, { recursive: true });
  writeFileSync(path.join(project, "project.json"), "{}");
  return { root, project };
}
