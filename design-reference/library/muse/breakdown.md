# muse: method breakdown

34.8 s, 977×640, the source was shot at 24 fps and delivered at 30 fps (every fifth frame is repeated). There is no voiceover, only music. Rights: for study only.

## Idea
A personal AI assistant is shown as a soft plush character who lives in a sky world. The film plays one delegation loop in a real chat interface: ask → get a short plan → hand over the task → get the result and an unrequested useful suggestion. The main device: **one circle leads the eye through the whole film**. In turn it becomes the character's portrait, the chat avatar, the send button, a window with the character, a blue sphere and, finally, an iris into the world.

## Hook (0–2.6 s)
On an almost white pale blue background `#E4EFF7`, a promise line builds one word at a time: words appear whole within a single frame at intervals of 2–5 frames (F1, F3, F5, F8, the second line from F21). The defining words are set in accent blue, the rest in dark `#363D3E`. The line re-centres on every word and the camera pulls back: a single line 0.70 of the frame wide becomes a two-line block about 0.53 wide. From 1.6 s clouds rise from below, cover the text, and a flying island emerges from beneath them.

## Structure
| s | What | Length |
|---|---|---|
| 0–2.6 | promise | 2.6 |
| 2.6–6.4 | world: a glass dome on an island, then a close-up of the character | 2.33 + 1.47 |
| 6.4–8.43 | a two-word invitation; the character pops out of the gap between the words | 1.13 + 0.90 |
| 8.43–14.93 | proof 1: the chat at reading scale, a three-point plan | 6.5 |
| 14.93–19.73 | the user types a request large, cursor, send button | 3.7 + 1.1 |
| 19.73–23.13 | the button becomes a window with the character; a handover headline assembles around it | 3.4 |
| 23.13–28.43 | proof 2: "done" and a proactive suggestion | 5.3 |
| 28.43–31.97 | iris into a top-down view of the ocean, a giant slogan | 1.73 + 1.8 |
| 31.97–34.83 | a brush monogram, held to the end with no fade | 2.87 |

The detector found 8 shots; after corrections there are 13 (median 2.33 s). There are only three hard cuts (4.93, 8.43, 18.63 s), plus the abrupt appearance of the mark after a fade at 31.97 s. The other transitions are morphs, wipes and camera moves. Corrections: the `whip` at 2.6 s is a wipe made of clouds; the long "shot" s004 (16.7 s) is split into 6 parts; the transitions at 6.4 / 23.13 / 28.43 / 30.17 / 31.97 s are reclassified as a dissolve to white, a shape match, an iris, a wipe made of letters and a cut.

## Sound and editing (I cannot hear)
Everything below comes from `audio.json`, `sync.json` and loudness measurements. Tempo 111.8 BPM, confidence 0.571; the loudness peak detector independently gives a period of 0.50–0.55 s, so the grid is real. Downbeats are unreliable (0.118). On the 12 corrected boundaries, 0.25 land on a beat against 0.30 by chance; on onsets, 0.75 against 0.73, but there are 5.4 onsets per second, so that figure means nothing. **The cuts are not placed on the beat.** Something else matches: the onset stream breaks at 7.73–8.64 s (the character pops out of the words) and at 14.56–15.91 s (the camera leaves the card for the input field; typing starts when the music returns); it thins out at 25.98–28.51 s, before the iris. The loudest window of the track (−12.5 dBFS) starts at 30.0 s, exactly when the giant letters cover the frame. The silence from 34.38 s plays under the still mark. I chose these pauses after already watching the picture: this is a hint at the method, not proof.

## Signature moves
1. **accelerate-into-cut, 4.73–5.13 s.** The push-in on the dome accelerates over the last 4 frames (frame difference 10 → 12 → 24), the cut is at F148, and the close-up continues the push-in, halving its speed every frame. The cut is hidden in the peak of the blur.
2. **word-split-insert, 7.43–7.97 s.** A dot (about 1% of the width) appears in the gap between two words; at F226 it becomes a disc 0.32 of the width within a single frame. The words fly out past the edges on expo.out. The call to action literally opens up and shows who will answer.
3. **caret-tracking-typewriter, 15.73–18.63 s.** The input field at large scale (text 0.11 of the height), about 1.6 frames per character; the frame follows the caret, and the line runs off the left edge. A new word is blue and darkens when the next one is typed. Then a sideways cut along the same strip to the send button.
4. **circle-carry-chain, 19.6–23.8 s.** The blue of the send button drains to white over 5 frames, and the character rises into the circle over 6 frames, as if into a window. A two-line headline assembles around it, the first line hidden behind the disc. Then a fast push-in: the circle fills with a glossy blue sphere, which becomes the chat avatar.
5. **giant-word-pull-out, 29.83–30.93 s.** The slogan's letters fly in from the left at frame height, sweep through over 9 frames, shrink into a single line 0.63 wide and recolour from blue `#2876EF` to dark.

## What we can and cannot do
- **Possible in Remotion:** the line build (`type-sentence-build`), the push-in accelerating into a cut (`zoom-through`), the chat (`ui-chat-thread`, `ui-ai-chat`), the large input field (`ui-prompt-bar` + `ui-camera-read`), the iris (`shapeWipe`), the giant slogan (`DollyStack`, `ZoomSmear`, `VelocityBlur`), drawing the mark (`kinetic-line-draw` + DrawSVG).
- **Needs writing:** an insert into the gap between words (`word-gap-insert`), stretching the typing indicator into a reply card, a button that becomes a portrait window, scrolling that follows the caret, a brush stroke of variable thickness, a wipe made of clouds.
- **Blender or paid generation only:** the world with the plush character, a glass dome with an iridescent film, volumetric clouds and a top-down view of the ocean. This is a character model plus a render. The nearest cheap option: licensed cloud photos on separate layers and a flat illustration of the character, but there will be no volume or refraction.
- The chat and the input field are the product interface: only the real interface or a capture of it.

**We do not carry over:** the brand, the character, the music, the copy, the monogram. **We carry over the method:** the through-running circle, two interface scales, 3–4 hard cuts in 35 s, turns in the music's pauses, a mark that holds over silence.
