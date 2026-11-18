# Real product interfaces in films

Last updated: 2026-11-12

When a film shows a product's interface (an app, a website, a chat, a settings screen), the frame must be 90–100% identical to the real thing: layout, spacing, type, colours, icons, status bar, copy and behaviour. A viewer who uses the product should recognise it at once. A generic component that only suggests the product looks cheap and is a defect, not a style.

## Choose the source

Take the first route that applies. Record the route, source and date for each shot in `material.json` (bespoke) or the asset plan (template).

| What is shown | Route |
|---|---|
| A public website or web app | Render the real page: `pnpm capture:app --url <url>` ([capture-app](capture-app.md)) for motion, or a full-height screenshot at the film's device width for a scroll or camera read. A local copy of the page's HTML and CSS is allowed for animation when the site's terms permit; keep it in the project, never in the library |
| The user's released product (mobile, desktop or web) | Run it with computer use on a device, simulator or browser and screenshot or record the film's flow at native resolution (`aiscreen` MCP, the iOS Simulator, or the OS recorder). Use a test account |
| A product in development, with a local repo | Read the repo, find how it runs with test or seed data, ask the user before running it, then record the flow: `capture:app` (Playwright) for web, screen recording for native |
| A third-party platform the product lives in (Telegram, WhatsApp, iOS, a marketplace) | A pixel-faithful replica built from a **fresh, dated reference screenshot** of the current version, on the film's OS and theme, as a library block (below) |

Never: a generic UI kit standing in for a named product, a grey box beyond the animatic, an invented layout, an outdated version of the platform.

## Ask when it is not obvious

If the route is unclear (no URL, the app cannot be run here, the OS, theme or version is unknown, the product is private), ask the user in one question, offering the likely route: "Shall I record the web app at <url>, or will you send screenshots of the iOS app?" Never fall back to a drawn approximation without the user's consent.

## Replicas of platform interfaces

- Start from one or more reference screenshots at native resolution, dated, of the exact screen and state. Store them git-ignored in the project (`assets/reference-ui/`) or ask the user for them; record the source in `CREDITS.md` only when it is a public image.
- Rebuild at 1:1 against the reference: measure spacing, radii, colours and type sizes from the pixels. Use the platform's font where its licence allows, otherwise the closest metric-compatible face, and say which.
- Every state the film needs (typing, sent, read, unread badge, banner) is a prop, frame-pure, so the block animates flat or as the screen of a 3D device (`blender-plate`, device GLBs).
- Check: render the replica at the reference's size and compare side by side with the reference at full size before using it in a film. Any visible difference in layout, colour or type is a defect to fix first.
- Copy on screen is realistic and in the film's language; never real people's personal data.

## Who applies this

- `brief-collector` asks for the interface source when the film shows a product and the sources do not settle it.
- `asset-planner` names the route per UI shot in the material step.
- `design-director` and `motion-engineer` build UI shots only from these sources.
- `creative-critic` and `qa-reviewer` fail a frame whose interface would not pass as the real product.
