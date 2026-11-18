/**
 * LottieFiles — Lottie animation search & download
 * Endpoint: https://graphql.lottiefiles.com/ (public GraphQL)
 * Rate limit: fair use (no hard limit documented)
 * License: per-animation (many are Lottie Simple License — free for commercial)
 * NO API KEY REQUIRED
 */

const GRAPHQL_URL = "https://graphql.lottiefiles.com/";

// --- Types ---

export type LottieAnimation = {
  id: string;
  name: string;
  lottieUrl: string; // direct .json download URL
  gifUrl: string | null;
  createdBy: { name: string } | null;
};

type SearchResponse = {
  data: {
    searchPublicAnimations: {
      edges: { node: LottieAnimation }[];
      totalCount: number;
    };
  };
};

// --- Search ---

export async function searchAnimations(
  query: string,
  options: { limit?: number } = {},
): Promise<{ animations: LottieAnimation[]; total: number }> {
  const limit = options.limit ?? 10;

  const graphqlQuery = {
    query: `
      query SearchAnimations($query: String!, $first: Int!) {
        searchPublicAnimations(query: $query, first: $first) {
          totalCount
          edges {
            node {
              id
              name
              lottieUrl
              gifUrl
              createdBy {
                name
              }
            }
          }
        }
      }
    `,
    variables: { query, first: limit },
  };

  const res = await fetch(GRAPHQL_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(graphqlQuery),
  });

  if (!res.ok) throw new Error(`LottieFiles search failed (${res.status}): ${await res.text()}`);

  const json: SearchResponse = await res.json();
  const data = json.data.searchPublicAnimations;

  return {
    animations: data.edges.map((e) => e.node),
    total: data.totalCount,
  };
}

/** Download a Lottie JSON file to public/lottie/ */
export async function downloadAnimation(animation: LottieAnimation, outputPath: string): Promise<void> {
  const { writeFileSync, mkdirSync, existsSync } = await import("fs");
  const { dirname } = await import("path");

  const dir = dirname(outputPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const res = await fetch(animation.lottieUrl);
  if (!res.ok) throw new Error(`Lottie download failed (${res.status}): ${animation.lottieUrl}`);
  const json = await res.text();
  writeFileSync(outputPath, json);
}
