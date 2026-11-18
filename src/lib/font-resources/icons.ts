import { validateSvg } from "../icon-resources/svg";
export const validateIconSvg = validateSvg;
export function providerIconMetadata(
  provider: "lucide" | "iconify" | "phosphor" | "tabler" | "simple-icons" | "svgl",
  collection: string,
  name: string,
  supplied: { licence: string; licenceEvidence: string },
) {
  if (!/^[a-z0-9-]+$/.test(collection) || !/^[a-z0-9-]+$/.test(name)) throw new Error("Invalid icon identifier");
  if (
    provider === "lucide" &&
    (collection !== "lucide" || supplied.licence !== "ISC" || supplied.licenceEvidence !== "https://lucide.dev/license")
  )
    throw new Error("Lucide metadata must retain official ISC evidence");
  if (provider === "iconify" && (!supplied.licence || !supplied.licenceEvidence.startsWith("https://")))
    throw new Error("Iconify collection requires its own supplied licence evidence");
  return { provider, collection, name, ...supplied };
}
