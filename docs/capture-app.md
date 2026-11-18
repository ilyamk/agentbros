# Real product capture (`capture:app`)

Records a real web app frame by frame at an exact frame rate, with scripted clicks, typing and scrolling landing on exact frames. Use it for product-UI proof shots: capture the real screen at 2x, then let a library camera (`ui-camera-read`) read across it.

```bash
pnpm capture:app --url https://app.example.com --script steps.json --fps 30 --duration 6 --output out/<id>/capture/hero
pnpm capture:app --url tests/fixtures/capture-app/page.html --script tests/fixtures/capture-app/steps.json --duration 1.6 --output /tmp/cap --width 900 --height 600 --scale 1
```

| Flag | Default | Meaning |
|---|---|---|
| `--url` | required | `https://…`, `file://…` or a local HTML path |
| `--script` | none | Steps JSON (below) |
| `--fps`, `--duration` | 30, required | Frame count is `round(duration × fps)` |
| `--output` | required | Must not already hold a capture |
| `--width`, `--height`, `--scale` | 1440, 900, 2 | Viewport in CSS pixels and device scale: the default gives 2880×1800 frames |
| `--format` | `both` | `png` (`f00000.png`…), `mp4` (`capture.mp4`, H.264 yuv420p CRF 16) or both |
| `--settle` | 1000 | Page-clock milliseconds the page runs after loading, before frame 0 |
| `--seed` | 1 | Seed for the page's `Math.random` |
| `--show-caret` | off | Keep the text caret; it blinks on the wall clock, so frames stop repeating |
| `--chrome` | Remotion's `chrome-headless-shell` | Another headless Chromium |

One JSON line on stdout (the CLI contract). `capture.json` in the output records the URL, fps, frames, route, Chromium version, every input event with its frame and click coordinates (for cursor overlays and SFX cues), the steps and a SHA-256 per frame.

## Steps

```json
{ "steps": [
  { "at": 12, "action": "click", "selector": "button[type=submit]" },
  { "time": 0.8, "action": "type", "selector": "#search", "text": "Find sales leaders", "framesPerChar": 2 },
  { "at": 70, "action": "key", "key": "Enter" },
  { "time": 3, "action": "scroll", "selector": ".table", "dy": 1200, "durationFrames": 18 },
  { "at": 120, "action": "hover", "selector": "tr:nth-child(4)" },
  { "at": 150, "action": "navigate", "url": "https://app.example.com/settings" }
] }
```

Each step has exactly one of `at` (frame) or `time` (seconds). Actions run before their frame's time advances. `click` and `hover` move the real mouse to the element's centre, so the page's own handlers and `:hover` styles fire. `type` focuses `selector` and sends one key event per character every `framesPerChar` frames (the edit can add human rhythm by splitting the text into several steps). `key` knows Enter, Tab, Escape, Backspace, Space and the arrows. `scroll` scrolls the element (or the window) by `dy` pixels with an ease-in-out over `durationFrames`; add motion blur in Remotion, not in the page. `navigate` waits for the new page's load event; its clock starts again at 0.

## How time is controlled (route shipped: injected clock)

`Page.addScriptToEvaluateOnNewDocument` installs a page clock before any page script runs. It replaces `performance.now`, `Date`, `requestAnimationFrame`, `setTimeout`/`setInterval` and `Math.random` (seeded), and pauses every CSS transition, CSS animation and Web Animation, seeking it to the page clock each frame. Per frame the capturer runs that frame's input, advances the clock by one frame (firing due timers in order, then one round of animation-frame callbacks) and takes `Page.captureScreenshot`. Chromium runs with `--disable-threaded-animation`, `--disable-threaded-scrolling`, `--disable-checker-imaging` and `--run-all-compositor-stages-before-draw`. Without those flags, a clicked transition differed between runs.

Verified on 2026-11-11 with HeadlessChrome 157 on macOS arm64: the fixture (CSS transition on click, infinite CSS animation, a `setTimeout`, a rAF ticker, typing and a scrolled list) gave identical SHA-256 for all 48 frames across three runs. `tests/capture-app.test.ts` checks this under `RUN_CAPTURE_APP=1`. A 2.5 s capture of a live site (`ui.shadcn.com`, scrolled) at 2880×1800 also worked.

Why not Chromium virtual time? `Emulation.setVirtualTimePolicy` did virtualise timers and `performance.now`, but:
- CSS transitions still ran on the wall clock.
- `Page.captureScreenshot` hung at a random frame once typing started.
- `HeadlessExperimental.beginFrame` fails with "BeginFrameControl is not supported on MacOS yet".

## Limits

- **Network timing is real.** A page that fetches during the capture can show data on different frames across runs. Prefer captures of a loaded state, or a local build with fixtures.
- **Workers, WebGL shaders reading their own clocks, `<video>` and `<canvas>` loops driven by worker timers** are not on the page clock.
- **The caret is hidden by default.** Draw a caret in Remotion (the library's prompt bar has one) or pass `--show-caret` and accept non-repeatable frames.
- Logged-in apps need a profile: run against a local or staging build, or add cookies through a custom page. Credentials are not handled by this tool.

## Fallback: aiscreen MCP recording

For apps that will not seek (heavy WebGL, native apps, anything behind a login you will not script), record in real time with the aiscreen MCP. Call `aiscreen_app_status`, then `aiscreen_sources_list` and `aiscreen_recording_start`, mark steps with `aiscreen_context_mark`, then stop and export. That route is on the wall clock and not repeatable: treat the recording as footage, import it as an asset and time the edit to its markers.
