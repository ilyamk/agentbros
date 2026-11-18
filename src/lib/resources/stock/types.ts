import { z } from "zod";
import { STOCK_CATEGORIES, STOCK_COLOURS, type ResourceCandidate } from "../../../types/resources";
import type { StockHttp } from "./http";

export const STOCK_PROVIDER_IDS = ["unsplash", "pexels", "pixabay"] as const;
export type StockProviderId = (typeof STOCK_PROVIDER_IDS)[number];
export const StockProviderIdSchema = z.enum(STOCK_PROVIDER_IDS);

export { STOCK_CATEGORIES, STOCK_COLOURS };
export type StockColour = (typeof STOCK_COLOURS)[number];

export const StockFormatSchema = z.enum(["vertical", "square", "landscape"]);
export type StockFormat = z.infer<typeof StockFormatSchema>;

export const StockFiltersSchema = z
  .object({
    orientation: z.enum(["portrait", "landscape", "square"]).optional(),
    color: z.enum(STOCK_COLOURS).optional(),
    safe: z.boolean().optional(),
    /** Frame the media fills and how far the camera pushes in; sets the minimum source size. */
    format: StockFormatSchema.optional(),
    zoom: z.number().min(1).max(4).optional(),
    minWidth: z.number().int().positive().max(20_000).optional(),
    minHeight: z.number().int().positive().max(20_000).optional(),
    /** Provider-specific author handle from a candidate's `authorId`. */
    author: z.string().min(1).max(200).optional(),
    /** Unsplash collection ids. */
    collections: z
      .array(z.string().regex(/^[\w-]{1,64}$/))
      .max(20)
      .optional(),
    /** Unsplash topic id or slug. */
    topic: z
      .string()
      .regex(/^[\w-]{1,100}$/)
      .optional(),
    /** Pixabay still type. */
    imageType: z.enum(["photo", "illustration", "vector"]).optional(),
    /** Pixabay clip type. */
    videoType: z.enum(["film", "animation"]).optional(),
    /** Pixabay category. */
    category: z.enum(STOCK_CATEGORIES).optional(),
    editorsChoice: z.boolean().optional(),
    order: z.enum(["relevant", "popular", "latest"]).optional(),
    lang: z
      .string()
      .regex(/^[a-z]{2}$/)
      .optional(),
  })
  .strict();
export type StockFilters = z.infer<typeof StockFiltersSchema>;

export type StockQuery = StockFilters & {
  query: string;
  kind: "image" | "video";
  page: number;
  limit: number;
};

export type StockContext = {
  http: StockHttp;
  now: () => string;
  key: () => string;
};

export type DownloadTarget = { format: StockFormat; zoom?: number };
export type ResolvedDownload = {
  url: string;
  headers?: Record<string, string>;
  /** Pixel size of the file this URL returns. */
  media: { width?: number; height?: number };
};
export type TrackingEvidence = { endpoint: string; trackedAt: string; status: "reported" };

export interface StockAdapter {
  id: StockProviderId;
  kinds: readonly ("image" | "video")[];
  /** Environment variable that holds the access key. */
  keyEnv: string;
  /** Filters the provider applies natively; others are applied to results or reported as unsupported. */
  native: readonly (keyof StockFilters)[];
  search(query: StockQuery, ctx: StockContext): Promise<{ candidates: ResourceCandidate[]; notes: string[] }>;
  inspect(candidate: ResourceCandidate, ctx: StockContext): Promise<ResourceCandidate>;
  resolveDownload(candidate: ResourceCandidate, target: DownloadTarget | undefined): ResolvedDownload;
  /** Usage reporting a provider requires on acquisition; failure stops the acquisition. */
  onAcquire?(candidate: ResourceCandidate, ctx: StockContext): Promise<TrackingEvidence>;
}
