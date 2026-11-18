---
id: device-playback
name: Playback on a device
intent: A rendered or captured clip appears on a phone, so the viewer sees where it will live.
route: remotion
timing: 26-frame rise; float of 7 pixels on a sine with divisor 22
curve: expoOut
primitive: DeviceFrame, ScreenPlayback
demo: PhonePlaybackV
sources: ["src/motion/lab/PhonePlayback.tsx", ".agents/skills/motion-and-typography/references/motion-grammar.md", "src/motion/AGENTS.md"]
status: demonstrated
---

**What it does.** A phone rises into a vertical frame and runs off the bottom, playing a video on its screen.

**When it fits.** Mobile products, or a before and after of where a video ends up.

**When it does not.** When the screen content must be read: at this scale it is small. Use `real-interface-playback`.

**Timing.** Rises 900 pixels. Headline lines take 22 frames with a 5-frame stagger, from frame 2.

**Read.** `src/motion/lab/PhonePlayback.tsx`

**Pitfalls.** The screen content needs its own legibility check at phone size. The frame runs off the bottom edge on purpose, so check the safe zone for anything else down there.
