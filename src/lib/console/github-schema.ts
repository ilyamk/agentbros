/** The `GET /api/github` contract, shared by the server and the console (no request code, so the bundle stays clean). */
import { z } from "zod";

export const GITHUB_REPOSITORY = "ilyamk/agentbros";
export const GITHUB_URL = `https://github.com/${GITHUB_REPOSITORY}`;

export const GithubRepoResponseSchema = z.strictObject({
  v: z.literal(1),
  repository: z.string(),
  url: z.string(),
  stars: z.number().int().nonnegative().nullable(),
});
export type GithubRepoResponse = z.infer<typeof GithubRepoResponseSchema>;
