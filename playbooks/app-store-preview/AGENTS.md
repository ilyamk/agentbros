# App Store preview playbook

Last updated: 2026-11-15

Choose it for an App Store app preview or a Google Play preview (promo) video of a mobile app: 15–30 s of the app's own screens that must pass store review. A launch or ad film for social feeds is [product-promo](../product-promo/AGENTS.md); teaching one task in the app is [product-tutorial](../product-tutorial/AGENTS.md).

## Start

```bash
pnpm film:init --project <id> --type ui-demo --playbook app-store-preview --profile promo --product <path>
pnpm film:next --project <id>        # repeat: do what it says
```

`ui-demo` brings capture, ui blocks and their QA lines ([film types](../../docs/film-types.md)); `--profile promo` fits a film of 45 s or less ([promo profile](../../docs/production-chain.md#the-promo-profile-films-of-45-s-or-less)), and this playbook narrows it to 15–30 s. The user's own device recordings, already made, enter as material (`pnpm asset:import`); the chain is the same.

## What good looks like

- **Passes review first time.** Only screen captures of the app itself; narration, text and video overlays allowed (App Review 2.3.4). No people, hands or fingers on a device; drawn touch hotspots are fine (Apple, app previews guide).
- **15–30 s exactly, 30 fps, at an accepted resolution** for each device class (Apple spec). Google Play: one public or unlisted YouTube video, ads off, landscape or portrait, real app in the first 10 s; only its first 30 s autoplay.
- **Reads muted.** Both stores autoplay without sound; the copy overlays carry the message, the sound only adds to it.
- **The reason to install by 5 s.** Apple's default poster frame is 5 s; it is also what people see with autoplay off. Frame 150 is a composed still, not a transition.
- **Real UI at native resolution, not zoomed in** (Apple's recommendation); seeded, fictional account data (2.3.9); 4+ content whatever the app's rating (2.3.8).
- **Honest copy:** no prices, no dates or seasonal words, no "#1", "best", "Editor's choice" or "new" (Apple guide, 2.3.7; Play metadata policy). Purchases or sign-in needed for what is shown are disclosed in the footage or the end frame (2.3.2).

## Method

1. **Fix the targets at intake.** Stores, device classes and locales from `playbook.json` `intake`; each class is its own canvas: iPhone 886×1920 (6.9", 6.5", 6.1"), 1080×1920 (5.5"), iPad 1200×1600, Mac and Apple TV 1920×1080. Apple scales the largest down to smaller sizes of the same family, so one iPhone and one iPad cut cover most apps (Apple spec, Scaling). Google Play: 1080×1920 or 1920×1080 (`brief-collector`, through `film:next`).
2. **One proposition, three to five app moments.** The strategist names the reason to install; the script is captions of 2–6 words per moment, no sentence the screen already shows (`strategist`, `script-writer`, `copywriter` skill). Gameplay over cutscenes for a game (Apple guide).
3. **Capture the real app on its own canvas size.** Native app: record on a device with QuickTime (Apple guide) or in the iOS Simulator (`xcrun simctl io booted recordVideo`), after `xcrun simctl status_bar booted override --time 9:41 --batteryLevel 100` for a clean status bar; Android: `adb shell screenrecord`; a mirrored window in real time through the `aiscreen` MCP ([real-ui](../../docs/real-ui.md), [capture-app fallback](../../docs/capture-app.md#fallback-aiscreen-mcp-recording)). Import each take with `pnpm asset:import`. A web-based UI from a local repo: `pnpm capture:app --width 443 --height 960 --scale 2` gives exactly 886×1920 (540×960 for 1080×1920; 600×800 for iPad). Test account and seed data, no real people (2.3.9). The user records on their device with the `recording-guide` skill.
4. **Build at the store size.** One `<Composition>` per class in the project's own entry (`src/projects/<id>/`), e.g. `width={886} height={1920} fps={30}`, scenes laid out from `useVideoConfig()`; `build.json` names the first (`motion-engineer`). `film:render` and `store:conform` never rescale. Device footage is scaled to the canvas width and cropped a few pixels in height, never letterboxed (Play forbids side bars).
5. **No device frame.** 2.3.4 allows only the app's screen captures plus overlays, so the screen fills the canvas: no `DeviceFrame`, `ui-phone-hero` or 3D device in an App Store cut (house reading of 2.3.4; Apple states no explicit device-frame rule). The Google Play cut may frame the phone, since Play only requires the real app experience.
6. **Touch is a hotspot, not a finger.** `ui-touch-hotspot` inside the camera: a soft dot per touch, taps from the capture log (`tapsFromCapture`), long presses and swipes keyed by hand. Never a mouse pointer in a phone preview.
7. **Zoom sparingly.** `ui-camera-read` at most 1.3× (house rule, starting point), only when a control is too small to read at phone size; Apple recommends native resolution over zooming in.
8. **Copy overlays, held to read.** Kinetic captions over a dimmed band or between moments, held for the reading floor `plan:check` enforces; simple cuts and dissolves only (Apple guide); nothing implying a feature the app lacks.
9. **Poster frame at 5 s.** `motion-director` puts the proposition's best still at frame 150; check it with `pnpm motion:still` and set it in App Store Connect when another frame is chosen. An approved poster frame cannot be changed without a new preview.
10. **Sound.** One music track throughout or none, in-app UI sounds from `pnpm sfx:synth` and `pnpm sfx:cues` or authorised `sfx:generate`; narration optional and paid (`pnpm generate:voiceover` only within budget). Licences cover every territory (Apple guide). Agents cannot hear: the mix is the user's call.
11. **End frame.** `scene-end-card` with the app name and any purchase or sign-in disclosure; no price, no store badge claims, no fade.
12. **Store master.** `pnpm film:render` (through `film:next`; another class's composition with `--composition`, `--output`, `--receipt`, `--measure`), then per cut `pnpm store:conform --input out/<id>/film.mp4 --store apple --class iphone|iphone-55|ipad|mac|tv --output out/<id>/appstore-<class>-<locale>.mp4` (`--store google` for the YouTube master). It re-encodes the audio to AAC 256 kbps stereo 48 kHz, adds a silent track when there is none (App Store Connect refuses a preview without one; developer reports), copies the picture when it is H.264 High 4.0 at 30 fps or less, refuses a wrong size, and verifies by ffprobe; `--reencode-video` aims at Apple's 10–12 Mbps (flat UI may encode lower; a warning).
13. **Localise per locale.** Up to three previews per language; a missing locale falls back to the next best language (Apple spec). Re-capture the UI in each language and re-set the copy (`captions-and-localization` skill).

## Tools

- `capture:app` at the store canvas for web UI; `aiscreen` MCP, the iOS Simulator, QuickTime or `adb` for native apps; `asset:import` for each take.
- `ui-camera-read` (gentle reads), `ui-touch-hotspot` (touches), `scene-end-card` (end frame); `pnpm library:list --category ui`.
- `motion:still`, `review:sheet`: poster frame and every overlay at phone size.
- `film:render`, then `store:conform` per class (without `--output` it only checks a file); `delivery` for the 1080×1920 and 1920×1080 cuts.

## Anti-patterns

- A social ad cut to the store: logo sting, lifestyle shots, people holding phones, a presenter.
- A device mockup, a hand or a finger in an App Store preview.
- Prices, "free for a week", dates, "new", "#1", "best", award badges.
- A 31 s or 14 s file; 60 fps capture left in; no audio track.
- A transition or splash on the 5 s poster frame.
- Copy that needs sound, or a voice reading what the screen shows.
- A 1080×1920 cut uploaded to the 6.9" slot (wrong aspect, refused), or letterboxed to fit.
- Real users' names, photos or messages in the captured UI.

## References

- Apple, [App preview specifications](https://developer.apple.com/help/app-store-connect/reference/app-information/app-preview-specifications/): 15–30 s, 500 MB, H.264 or ProRes 422 HQ, up to 30 fps, 10–12 Mbps High Profile 4.0, stereo 256 kbps AAC at 44.1 or 48 kHz, resolutions per class, default poster frame 5 s, up to three per size and language, scaling down, locale fallback.
- Apple, [App previews](https://developer.apple.com/app-store/app-previews/) and [Show more with app previews](https://developer.apple.com/support/app-previews/): on-device footage, stay within the app, no people or fingers, hotspots allowed, native resolution, legible copy, no prices or timely references, disclose purchases and sign-in, simple transitions, muted autoplay, poster frame.
- Apple, [App Review Guidelines](https://developer.apple.com/app-store/review/guidelines/) 2.3.2, 2.3.4, 2.3.7, 2.3.8, 2.3.9.
- Google Play Console Help, [Add preview assets](https://support.google.com/googleplay/android-developer/answer/9866151): YouTube URL, public or unlisted, ads off, not age-restricted, embeddable, landscape or portrait without side bars, real app in 10 s, 30 s muted autoplay, 1024×500 feature graphic required.
- Google Play, [Metadata policy](https://support.google.com/googleplay/android-developer/answer/9898842): no ranking, price, promotion or Play-programme claims; videos reflect the actual app.
- sarunw.com, [unsupported or corrupted audio](https://sarunw.com/posts/how-to-fix-app-preview-contains-unsupported-or-corrupted-audio/) (practitioner, rule of thumb): a silent stereo track fixes the refusal.

## Done when

- `film:next` reports the chain complete.
- `pnpm store:conform` returns ok for each App Store file: the class's exact size, 30 fps or less, 15.0–30.0 s, H.264, one AAC stereo track at 48 kHz, under 500 MB; its warnings read.
- `pnpm delivery` passes for the 1080×1920 and 1920×1080 cuts; `store:conform` alone checks 886×1920 and 1200×1600.
- The frame at 5 s is the intended poster; no people, hands, device frame, price or dated copy anywhere; purchases or sign-in disclosed when shown.
- Google Play: the user has uploaded the film to YouTube as public or unlisted with monetisation off and supplied a 1024×500 feature graphic.
- The user has approved the film; their verdict goes to `creative-postmortem`.
