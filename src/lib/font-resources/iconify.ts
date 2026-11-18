import { acquireResource } from "./registry";
import { validateIconSvg } from "./icons";
/** Explicit public GETs; licence remains per collection, never an Iconify-wide grant. */
export async function acquireIconifyIcon(collection: string, name: string, fetcher: typeof fetch = fetch) {
  if (!/^[a-z0-9-]+$/.test(collection) || !/^[a-z0-9-]+$/.test(name)) throw new Error("Invalid Iconify identifier");
  const infoUrl = `https://api.iconify.design/collection?prefix=${collection}&info=true`;
  const raw = JSON.parse((await acquireResource(infoUrl, fetcher)).toString("utf8"));
  if (
    raw.prefix !== collection ||
    !raw.info?.license?.title ||
    !raw.info?.license?.url?.startsWith("https://") ||
    !raw.info?.author?.name
  )
    throw new Error("Missing authoritative collection licence/author metadata");
  const source = `https://api.iconify.design/${collection}/${name}.svg`;
  const svg = validateIconSvg((await acquireResource(source, fetcher)).toString("utf8"));
  return {
    svg,
    collectionInfo: raw,
    metadata: {
      source,
      licence: raw.info.license.spdx ?? raw.info.license.title,
      licenceEvidence: raw.info.license.url,
      attribution: raw.info.author.name,
    },
    metadataSource: infoUrl,
  };
}
