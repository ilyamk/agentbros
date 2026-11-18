import path from "node:path";
/** Exact module aliases keep rendering smoke tests offline without bypassing font QA or readiness. */
export function offlineSmokeFontAliases(checkout: string): Record<string, string> {
  const families = [
    "Anton",
    "Archivo",
    "BebasNeue",
    "DMSans",
    "Geist",
    "GeistMono",
    "GolosText",
    "InstrumentSerif",
    "Inter",
    "InterTight",
    "JetBrainsMono",
    "Montserrat",
    "Oswald",
    "PlayfairDisplay",
    "RobotoFlex",
    "Rubik",
    "SofiaSansCondensed",
    "SofiaSansExtraCondensed",
    "SpaceGrotesk",
    "Unbounded",
  ];
  return {
    [path.join(checkout, "src/lib/fonts")]: path.join(checkout, "tests/fixtures/offline-fonts.ts"),
    ...Object.fromEntries(
      families.map((family) => [
        `@remotion/google-fonts/${family}$`,
        path.join(checkout, "tests/fixtures/offline-google-font.ts"),
      ]),
    ),
  };
}

/** Block Google font hosts on every render page and retain attempted requests as a failing-test sensor. */
export function blockGoogleFontRequests(browser: import("@remotion/renderer").HeadlessBrowser): string[] {
  const requests: string[] = [];
  const createPage = browser.newPage.bind(browser);
  browser.newPage = async (options) => {
    const page = await createPage(options);
    const client = page._client();
    client.on("Network.requestWillBeSent", (event: { request: { url: string } }) => {
      if (/^https?:\/\/fonts\.(googleapis|gstatic)\.com\//.test(event.request.url)) requests.push(event.request.url);
    });
    await client.send("Network.enable");
    await (
      client as unknown as { send(method: "Network.setBlockedURLs", options: { urls: string[] }): Promise<unknown> }
    ).send("Network.setBlockedURLs", { urls: ["*fonts.googleapis.com*", "*fonts.gstatic.com*"] });
    return page;
  };
  return requests;
}

export async function measureSmokeStep<T>(label: string, work: () => T | Promise<T>): Promise<T> {
  const started = performance.now();
  try {
    return await work();
  } finally {
    console.error(JSON.stringify({ smokeStep: label, elapsedMs: Math.round(performance.now() - started) }));
  }
}
