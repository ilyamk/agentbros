import { readFileSync } from "node:fs";
import { entry, type GitHub } from "./api";
export type Label = { name: string; color: string; description: string };
export async function labelsSync(api: GitHub, wanted: Label[]) {
  const existing = await api.pages<Label>("/labels");
  let changed = 0;
  for (const label of wanted) {
    const old = existing.find((item) => item.name === label.name);
    if (old && old.color.toLowerCase() === label.color && old.description === label.description) continue;
    await api.call(old ? `/labels/${encodeURIComponent(label.name)}` : "/labels", old ? "PATCH" : "POST", label);
    changed++;
  }
  return { changed };
}
entry(import.meta.url, async (api) =>
  labelsSync(api, JSON.parse(readFileSync(".github/labels.json", "utf8")) as Label[]),
);
