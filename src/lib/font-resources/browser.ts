import { staticFile, delayRender, continueRender, cancelRender } from "remotion";
export type LocalFontManifest = {
  version: 1;
  faces: {
    family: string;
    weight: number;
    style: "normal" | "italic";
    original: string;
    hash: string;
    testedText: string;
  }[];
  roles: Record<string, string>;
};
/** Must complete before any frame; loading an installed fallback is not accepted. */
export async function loadLocalFontManifest(manifest: LocalFontManifest) {
  const handle = delayRender("Verify exact local font originals");
  try {
    for (const item of manifest.faces) {
      const response = await fetch(staticFile(item.original));
      if (!response.ok) throw new Error("Missing cached font original");
      const bytes = await response.arrayBuffer();
      const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
      if (digest !== item.hash) throw new Error("Cached font checksum mismatch");
      const face = new FontFace(item.family, bytes, {
        weight: String(item.weight),
        style: item.style,
      });
      await face.load();
      if (face.status !== "loaded") throw new Error("Actual font face did not load");
      document.fonts.add(face);
      if (!document.fonts.check(`${item.style} ${item.weight} 24px ${JSON.stringify(item.family)}`, item.testedText))
        throw new Error("Browser font readiness failed");
    }
    await document.fonts.ready;
    continueRender(handle);
  } catch (error) {
    cancelRender(error);
    throw error;
  }
}
