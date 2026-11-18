# Feature update playbook

Last updated: 2026-11-15

Choose it for a 10–45 s film that announces one new feature or release of a software product (what's new, changelog or release notes video, feature announcement) on its real screens, for social, the product's site, in-app or email. Teaching the whole task step by step is [product-tutorial](../product-tutorial/AGENTS.md); selling the whole product or launching the product itself is [product-promo](../product-promo/AGENTS.md); the user's own recording of the feature starts from the footage alternative and is cut as in [footage-edit](../footage-edit/AGENTS.md).

## Start

```bash
pnpm film:init --project <id> --type ui-demo --playbook feature-update --profile promo --product <path>
pnpm film:next --project <id>        # repeat: do what it says
# own screen recording of the feature instead:
pnpm project:new --project <id>
pnpm footage:next --project <id> --playbook feature-update --source <file> --goal recut,captions
```

`ui-demo` brings the capture, the ui blocks and its QA lines ([film types](../../docs/film-types.md)). `--profile promo` fits a film of 45 s or less: a pilot shot instead of an animatic, reference numbers advisory ([promo profile](../../docs/production-chain.md#the-promo-profile-films-of-45-s-or-less)). A roundup over 45 s drops it. Ask the intake questions in `playbook.json` before `film:init`.

## What good looks like

- **One change, one viewer's job.** "Export now runs in the background", not "v4.2 is here". Lead with what users can now do, show it rather than say it, one job per message ([Intercom](https://www.intercom.com/blog/crafting-feature-announcements-that-spur-action), rule of thumb).
- **The result first.** The new state is on screen within 3 s, before any title or logo (house rule, starting point; the same opening rule as [product-promo](../product-promo/AGENTS.md)).
- **Before and after on the same screen.** The same framing, the old way then the new, so the only thing that moves is the change.
- **Readable at playback size.** Every UI string the film refers to is legible and held for its reading time.
- **A version label and date** that match the release, with availability (plan, platform, rollout) when not everyone has it.
- **One action to try it** and where, on a still end card. No fade: it is the thumbnail and loop frame.
- **Works muted.** In-app, site and feed players start silent; the film reads with no sound.

## Method

The chain owns strategy, script, look, beat sheet, build, sound and critic ([production chain](../../docs/production-chain.md)). This adds what a feature update needs.

1. **Name the change and the before.** At intake `brief-collector` records the one change, how the user did the job before, the version, date and availability, the placements and the try-it path (the `intake` list). No old way to compare: the film is the new state only, with the old way as one line of text.
2. **One film or a roundup.** Linear features one to three larger changes and groups the small fixes in one section ([Linear](https://linear.app/blog/startups-write-changelogs)); Appcues sizes the announcement to how noteworthy the update is ([Appcues](https://appcues.com/blog/choosing-the-right-ui-pattern-for-your-product-update), rule of thumb). So: a change that alters how users work gets its own film; a release of small fixes becomes the `roundup` variant; a single small fix gets no film, only the written changelog.
3. **Capture before and after identically.** Two `pnpm capture:app` runs, old build or flag off and new build, with the same `--width`, `--height`, `--scale`, `--seed`, seed data and steps file, so the frames line up ([capture-app](../../docs/capture-app.md), [real-ui](../../docs/real-ui.md)). Native or logged-in apps: the aiscreen route in capture-app. Never a drawn UI.
4. **Structure, about 20 s (house rule, starting point):** result (2–3 s) → the old way, compressed (3–5 s) → the same stop in the new build, the change in action (6–10 s) → why it matters in one line → version, date and try-it end card (2 s or more). The `strategist` fixes the one-line benefit; `script-writer` keeps one claim per beat (skill `copywriter`).
5. **Before→after at one camera stop.** `ui-camera-read` holds the same region on both captures; cut on the identical framing or carry the changed element across with `shared-element-carry`. `before-after-split` only when the change is a number (steps, seconds, clicks), rolled from old to new.
6. **Reading time for the change.** Holds and type size follow [craft rules](../../design-reference/craft-rules.md) (0.5 s + 0.3 s a word; final line 2 s or more; 28 px floor); `plan:check` enforces them in the chain. Check every UI label named on screen with `pnpm motion:still` at the hold frame.
7. **Cursor, clicks and touches.** Headless capture has no cursor: draw `Cursor` from `src/motion/ui.tsx` inside the camera, keyed to the click log, as in [product-tutorial](../product-tutorial/AGENTS.md) step 8; on a mobile capture draw `ui-touch-hotspot` dots instead (`tapsFromCapture`). Quiet UI sounds from `pnpm sfx:synth` on the click frames through `pnpm sfx:cues`.
8. **Text, voice, music.** Default: on-screen text and a music bed, no voice, because every placement may play muted. A voice only when the user asks and a budget is approved. Burned captions (`clean-sentence`, `pnpm render --captions on`) carry any voice; LinkedIn takes an SRT sidecar from `pnpm captions:export`.
9. **Version and CTA end card.** `scene-end-card` with product mark, "New in <version> · <date>" and one action ("Try it: Settings → Export"), spelled as the UI reads, held still on the last frame.
10. **Cut-downs per placement.** Render each format from the `profiles` in `playbook.json` (`pnpm render --project <id> --format <f>`). The `in-app` variant is its own 5–15 s cut, not the first seconds of the long one: result and one before-after, every claim as text, designed to start muted (Chrome allows only muted autoplay without a user gesture: [Chrome](https://developer.chrome.com/blog/autoplay)). Email: a `motion:still` poster of the result frame linked to the hosted film, since most clients do not play video ([Can I Email](https://www.caniemail.com/features/html-video/)). Then [delivery](../../docs/delivery.md).

## Tools

- `capture:app` / `capture:html`, `asset:import`: the real old and new screens.
- `ui-camera-read` (category `ui`): the reading camera on both captures; `ui-touch-hotspot` for touches on a phone capture.
- `shared-element-carry` (category `transitions`): the changed element crosses from before to after.
- `before-after-split`: a change measured in a number.
- `scene-end-card`: version, date and try-it path.
- `sfx:synth`, `sfx:cues`, `sfx:generate`: UI clicks on the capture's click frames (skill `sound-design-and-mix`).
- `motion:still`, `render --captions on`, `captions:export`, `delivery` (skill `qa-and-delivery`).

## Anti-patterns

- "Version 4.2 is here" over a logo for 5 s before anything changes on screen.
- A list of ten features as text cards, none shown working.
- Before and after at different zooms or window sizes, so the eye hunts for the change.
- A tutorial in disguise: every click of the new flow narrated.
- A version, date or "available to everyone" that is not true for the release.
- The in-app cut depending on a voice the modal will play muted.
- A mock-up or old build passed off as the new feature.

## References

- Linear, [Startups write changelogs](https://linear.app/blog/startups-write-changelogs): regular cadence; one to three larger changes up top, small fixes grouped; at least one screenshot or video; videos shared on social.
- Intercom, [Crafting feature announcements that spur action](https://www.intercom.com/blog/crafting-feature-announcements-that-spur-action) (2017, foundational; vendor blog, rule of thumb): lead with what users can now achieve, show instead of tell, one job per message, target who has the feature.
- Intercom Help, [video pointers in tours](https://www.intercom.com/help/en/articles/2901124-personally-guide-customers-with-video-pointers-in-tours): muted by default, captions to catch attention, about 5 s, shown at 4:3.
- Appcues, [Choosing the right UI pattern for your product update](https://appcues.com/blog/choosing-the-right-ui-pattern-for-your-product-update) (vendor blog, rule of thumb): noteworthiness sets the pattern; frequent announcements harm the experience.
- LinkedIn Help, [video ads specifications](https://www.linkedin.com/help/linkedin/answer/85306): 3 s to 30 min, 15–30 s recommended for all feed placements, under 30 s loops, 16:9, 1:1, 4:5 and 9:16, captions as SRT.
- X Developer Platform, [media best practices](https://docs.x.com/x-api/media/quickstart/best-practices): 16:9 or 1:1 recommended, 1:3 to 3:1 allowed, 60 fps or less, 720p playback for non-Premium accounts.
- Chrome for Developers, [Autoplay policy](https://developer.chrome.com/blog/autoplay): muted autoplay is always allowed; sound needs a user interaction.
- Can I Email, [video element](https://www.caniemail.com/features/html-video/): about 24% support; Gmail strips it (last tested 2019).

## Done when

- `film:next` reports the chain complete and `pnpm delivery` passes its check.
- The new state is on screen by 3 s; before and after share one camera stop in the real product.
- Version, date, availability and the try-it path match what the user confirmed.
- Every UI label the film names reads at playback size in `motion:still` frames.
- Each placement in the brief has its render; the in-app cut reads with sound off.
- The user approved the pilot and the final; their verdict goes to `creative-postmortem`.
- Not covered: a 4:3 render for Intercom-style pointers (formats are vertical, square, landscape) and an animated GIF for email.
