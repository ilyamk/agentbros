import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { request, responseUrl, readResponse, downloadFile, type HttpOptions, publicUrl } from "./http";
import { MediaFetchError } from "./errors";

interface Xml {
  tag: string;
  attrs: Record<string, string>;
  children: Xml[];
  text: string;
}
function xml(source: string): Xml {
  if (/<!|&(?!(?:amp|quot|apos|lt|gt);)/.test(source))
    throw new MediaFetchError("DRM_UNSUPPORTED", "Unsafe XML declarations or entities.");
  const root: Xml = { tag: "root", attrs: {}, children: [], text: "" },
    stack = [root];
  for (const token of source.match(/<[^>]*>|[^<]+/g) ?? []) {
    if (token.startsWith("<?")) continue;
    if (token.startsWith("</")) {
      if (stack.length === 1 || stack.at(-1)!.tag !== token.slice(2, -1).trim())
        throw new MediaFetchError("INVALID_MEDIA", "Malformed DASH XML.");
      stack.pop();
      continue;
    }
    if (token.startsWith("<")) {
      const tag = token.match(/^<([\w:-]+)/)?.[1];
      if (!tag) throw new MediaFetchError("INVALID_MEDIA", "Invalid DASH tag.");
      const attrs: Record<string, string> = {};
      for (const m of token.matchAll(/([\w:-]+)\s*=\s*(["'])(.*?)\2/g))
        Object.defineProperty(attrs, m[1], { value: m[3].replace(/&amp;/g, "&"), enumerable: true });
      const node = { tag, attrs, children: [], text: "" };
      stack.at(-1)!.children.push(node);
      if (!token.endsWith("/>")) stack.push(node);
      if (stack.length > 32) throw new MediaFetchError("SIZE_LIMIT", "DASH XML too deeply nested.");
    } else stack.at(-1)!.text += token;
  }
  if (stack.length !== 1) throw new MediaFetchError("INVALID_MEDIA", "Unclosed DASH XML.");
  return root;
}
const child = (node: Xml, tag: string) => node.children.find((c) => c.tag === tag);
const duration = (value: string | undefined) => {
  const m = value?.match(/^PT(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?$/);
  return m ? Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0) : 0;
};
export interface SegmentTrack {
  kind: "video" | "audio";
  segments: string[];
}
export function dashTracks(source: string, url: string, height?: number): SegmentTrack[] {
  const root = child(xml(source), "MPD");
  if (!root || root.attrs.type === "dynamic" || /ContentProtection/.test(source))
    throw new MediaFetchError(
      "DRM_UNSUPPORTED",
      "Only static unencrypted DASH is supported.",
      "Choose a merged downloadable rendition.",
    );
  const period = child(root, "Period");
  if (!period || root.children.filter((c) => c.tag === "Period").length !== 1)
    throw new MediaFetchError("FORMAT_UNAVAILABLE", "DASH requires a single finite period.");
  const base = (n: Xml, parent: string) => new URL(child(n, "BaseURL")?.text.trim() || parent, parent).href;
  const rootBase = base(root, url),
    periodBase = base(period, rootBase),
    tracks: SegmentTrack[] = [];
  for (const adaptation of period.children.filter((c) => c.tag === "AdaptationSet")) {
    const reps = adaptation.children
      .filter((c) => c.tag === "Representation")
      .filter((r) => !height || !r.attrs.height || Number(r.attrs.height) <= height)
      .sort((a, b) => Number(b.attrs.bandwidth ?? 0) - Number(a.attrs.bandwidth ?? 0));
    const rep = reps[0];
    if (!rep) continue;
    const kind = /audio/.test(rep.attrs.mimeType ?? adaptation.attrs.mimeType ?? adaptation.attrs.contentType ?? "")
      ? "audio"
      : "video";
    if (tracks.some((t) => t.kind === kind)) continue;
    const repBase = base(rep, base(adaptation, periodBase));
    const list = child(rep, "SegmentList") ?? child(adaptation, "SegmentList"),
      template = child(rep, "SegmentTemplate") ?? child(adaptation, "SegmentTemplate");
    const segments: string[] = [];
    if (list) {
      const init = child(list, "Initialization")?.attrs.sourceURL;
      if (init) segments.push(new URL(init, repBase).href);
      for (const entry of list.children.filter((c) => c.tag === "SegmentURL")) {
        if (entry.attrs.mediaRange)
          throw new MediaFetchError("FORMAT_UNAVAILABLE", "DASH byte ranges require provider merging.");
        segments.push(new URL(entry.attrs.media, repBase).href);
      }
    } else if (template) {
      const attrs = { ...(child(adaptation, "SegmentTemplate")?.attrs ?? {}), ...template.attrs };
      const fill = (pattern: string, n: number, time: number) =>
        pattern.replace(
          /\$(RepresentationID|Bandwidth|Number|Time)(?:%0(\d+)d)?\$/g,
          (_match, field: string, pad: string) =>
            String(
              field === "RepresentationID"
                ? rep.attrs.id
                : field === "Bandwidth"
                  ? rep.attrs.bandwidth
                  : field === "Number"
                    ? n
                    : time,
            ).padStart(Number(pad ?? 0), "0"),
        );
      const start = Number(attrs.startNumber ?? 1),
        scale = Number(attrs.timescale ?? 1);
      let number = start,
        time = 0;
      if (attrs.initialization) segments.push(new URL(fill(attrs.initialization, number, time), repBase).href);
      const timeline =
        child(template, "SegmentTimeline") ??
        child(child(adaptation, "SegmentTemplate") ?? template, "SegmentTimeline");
      if (timeline) {
        for (const entry of timeline.children.filter((c) => c.tag === "S")) {
          const repeat = Number(entry.attrs.r ?? 0),
            d = Number(entry.attrs.d);
          if (repeat < 0 || repeat > 10000 || !Number.isFinite(d) || d <= 0)
            throw new MediaFetchError("FORMAT_UNAVAILABLE", "Unbounded DASH timeline.");
          time = Number(entry.attrs.t ?? time);
          for (let i = 0; i <= repeat; i++) {
            segments.push(new URL(fill(attrs.media, number++, time), repBase).href);
            time += d;
            if (segments.length > 10000) throw new MediaFetchError("SIZE_LIMIT", "Too many DASH segments.");
          }
        }
      } else {
        const count = Math.ceil(
          ((duration(period.attrs.duration) || duration(root.attrs.mediaPresentationDuration)) * scale) /
            Number(attrs.duration),
        );
        if (!Number.isSafeInteger(count) || count <= 0 || count > 10000)
          throw new MediaFetchError("FORMAT_UNAVAILABLE", "DASH needs a bounded duration.");
        for (let i = 0; i < count; i++)
          segments.push(new URL(fill(attrs.media, number++, i * Number(attrs.duration)), repBase).href);
      }
    } else if (child(rep, "BaseURL")) segments.push(repBase);
    if (!segments.length || segments.length > 10000)
      throw new MediaFetchError("FORMAT_UNAVAILABLE", "No bounded DASH segments.");
    segments.forEach(publicUrl);
    tracks.push({ kind, segments });
  }
  if (!tracks.length) throw new MediaFetchError("FORMAT_UNAVAILABLE", "No supported DASH representation.");
  return tracks;
}
export function hlsSegments(source: string, url: string): string[] {
  if (
    !source.startsWith("#EXTM3U") ||
    !source.includes("#EXT-X-ENDLIST") ||
    /#EXT-X-KEY|#EXT-X-SESSION-KEY|#EXT-X-BYTERANGE/.test(source)
  )
    throw new MediaFetchError(
      "FORMAT_UNAVAILABLE",
      "Only finite unencrypted HLS media playlists without byte ranges are supported.",
      "Choose a merged file or media playlist.",
    );
  const init = source.match(/#EXT-X-MAP:URI="([^"]+)"/)?.[1];
  const urls = [
    ...(init ? [init] : []),
    ...source.split(/\r?\n/).filter((line) => line.trim() && !line.startsWith("#")),
  ].map((line) => new URL(line.trim(), url).href);
  if (!urls.length || urls.length > 10000) throw new MediaFetchError("SIZE_LIMIT", "HLS segment limit exceeded.");
  urls.forEach(publicUrl);
  return urls;
}
export async function localiseSegments(
  url: string,
  directory: string,
  options: HttpOptions,
  height?: number,
): Promise<string[]> {
  const deadline = Date.now() + (options.timeoutMs ?? 600000);
  let downloaded = 0;
  const bounded = (): HttpOptions => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new MediaFetchError("TIMEOUT", "Segmented media deadline exceeded.");
    return {
      ...options,
      timeoutMs: remaining,
      onBytes: (bytes: number) => {
        downloaded += bytes;
        if (downloaded > (options.maxBytes ?? 2 * 1024 ** 3))
          throw new MediaFetchError("SIZE_LIMIT", "Segmented media exceeds the per-file byte limit.");
        options.onBytes?.(bytes);
      },
    };
  };
  const response = await request(url, bounded());
  if (response.statusCode !== 200) {
    response.destroy();
    throw new MediaFetchError("DOWNLOAD_FAILED", "Playlist unavailable.");
  }
  url = responseUrl(response) ?? url;
  const source = (await readResponse(response, 1024 * 1024)).toString("utf8");
  let tracks: SegmentTrack[];
  if (source.startsWith("#EXTM3U") && source.includes("#EXT-X-STREAM-INF")) {
    const lines = source.split(/\r?\n/),
      variants: { url: string; height: number }[] = [];
    lines.forEach((line, i) => {
      if (line.startsWith("#EXT-X-STREAM-INF")) {
        const h = Number(line.match(/RESOLUTION=\d+x(\d+)/)?.[1] ?? 0);
        if (!height || h <= height) variants.push({ url: new URL(lines[i + 1], url).href, height: h });
      }
    });
    const chosen = variants.sort((a, b) => b.height - a.height)[0];
    if (!chosen) throw new MediaFetchError("FORMAT_UNAVAILABLE", "No HLS quality matches the height limit.");
    const next = await request(chosen.url, bounded());
    const text = (await readResponse(next, 1024 * 1024)).toString("utf8");
    tracks = [{ kind: "video", segments: hlsSegments(text, responseUrl(next) ?? chosen.url) }];
    const streamIndex = lines.findIndex(
      (line, i) => line.startsWith("#EXT-X-STREAM-INF") && new URL(lines[i + 1], url).href === chosen.url,
    );
    const group = lines[streamIndex]?.match(/AUDIO="([^"]+)"/)?.[1];
    if (group) {
      const entries = lines.filter(
        (line) =>
          line.startsWith("#EXT-X-MEDIA:") && line.includes("TYPE=AUDIO") && line.includes(`GROUP-ID="${group}"`),
      );
      const selected = entries.find((line) => line.includes("DEFAULT=YES")) ?? entries[0];
      const audioUri = selected?.match(/URI="([^"]+)"/)?.[1];
      if (!audioUri)
        throw new MediaFetchError("FORMAT_UNAVAILABLE", "Referenced HLS audio group has no supported playlist.");
      const audioUrl = new URL(audioUri, url).href;
      const audioResponse = await request(audioUrl, bounded());
      const audioText = (await readResponse(audioResponse, 1024 * 1024)).toString("utf8");
      tracks.push({ kind: "audio", segments: hlsSegments(audioText, responseUrl(audioResponse) ?? audioUrl) });
    }
  } else
    tracks = source.startsWith("#EXTM3U")
      ? [{ kind: "video", segments: hlsSegments(source, url) }]
      : dashTracks(source, url, height);
  mkdirSync(directory, { recursive: true });
  const files: string[] = [];
  for (let ti = 0; ti < tracks.length; ti++) {
    const names: string[] = [];
    for (let si = 0; si < tracks[ti].segments.length; si++) {
      const name = `${ti}-${si}.segment`;
      await downloadFile(tracks[ti].segments[si], path.join(directory, name), bounded());
      names.push(name);
    }
    // Fragmented MP4 needs its initialisation plus fragments in byte order; MPEG-TS also permits concatenation.
    const output = path.join(directory, `${ti}.track`);
    const fs = await import("node:fs");
    const handle = fs.openSync(output, "wx", 0o600);
    try {
      for (const name of names) {
        const input = fs.openSync(path.join(directory, name), "r");
        try {
          const buffer = Buffer.alloc(1024 * 1024);
          let bytes;
          while ((bytes = fs.readSync(input, buffer)) > 0) fs.writeSync(handle, buffer, 0, bytes);
        } finally {
          fs.closeSync(input);
        }
      }
    } finally {
      fs.closeSync(handle);
    }
    files.push(output);
  }
  return files;
}
