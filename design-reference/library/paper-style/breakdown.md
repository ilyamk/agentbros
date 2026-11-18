# Paper style: method breakdown

60 s, 1280x720, 30 fps. For study only. Speech runs through the whole film. I did not hear the sound: I rely on the transcript, the waveform and the measurements. Some words were misrecognised ("dears" instead of, apparently, "ideas").

## Idea

A short history of printing, told as a single printed sheet. Each chapter is a panel of the same sheet, the camera slides between them, and at the end it pulls back, and we see that all along we have been reading a finished page. The form is the film's idea.

## Hook (0–2.1 s)

Straight into a close-up: a cut-out figure writes by hand. There is no title, the voice starts from the first frames. At about 1.5 s the frame widens, and this coincides with a short pause in the voice (1.78–2.14 s). At 2.13 s, together with the words "every book", the first large text drops in.

## Structure

| Time | Panel | How it fills |
|---|---|---|
| 0–5.7 | I. Before the press | Scrap letters, a pen writes, a red circle, a strip of typewritten text |
| 5.7–15.5 | II. China and Korea | Dates as stamps, clay type that later turns into metal |
| 15.5–25.3 | III. Mainz | A portrait, the sum "type + ink + press", a flash, a Bible page |
| 25.3–32.5 | IV. Spread | Pins on a map, a counter up to 20 million, a BANNED stamp |
| 32.5–36.9 | V. Steam | A newspaper flies in, a pressure-gauge needle, gears, smoke |
| 36.9–40.9 | VI. Mass printing | A large machine, a newspaper seller, the headline last |
| 40.9–45 | VII. Copy | The devices get smaller and smaller |
| 45–51.7 | VIII. Today | The word "3D" prints from the bottom up |
| 51.7–60 | The whole sheet | Pull-back, the title develops, THE END |

## Sound and editing

The clock of this film is the voice, not the music. A tempo of 118.6 BPM at a confidence of 0.11 cannot be relied on. The "cut on the beat" metrics mean nothing either: these are 8 boundaries, and they are not cuts. Whether there is music under the voice cannot be told from the measurements.

What the words show: the slides land in the pauses between phrases. The previous sentence ends, the camera moves, and the first word of the new chapter sounds at the very end of the move, usually 0.06–0.12 s before it stops. Word timings are approximate, the last words especially: "impression" sits inside a measured silence.

The detector found 9 shots and 7 whips; after corrections, 11 segments (a flash to white at 23.9 s and the change from close-up to wide at 1.5 s). In essence it is one continuous shot: six camera slides across one sheet, one thrown sheet and one long pull-back.

## Signature moves

1. **Pull-back to the whole sheet (50.6–54.7 s).** The camera starts from rest, accelerates towards 52.6 s and decelerates just as smoothly, about 4.1 s; it moves back with a tilt of roughly 5 degrees and passes the panels already seen. Eight chapters become one object. The tilt gives the feeling that someone has picked up a real sheet.
2. **Slide to an empty panel (first at 5.66 s, six times in all).** The move takes 10–11 frames, the blur is moderate: the letters are almost readable. The new panel arrives empty and stays empty for at least 5 frames. This emptiness is the breath, and the first object appears when the new phrase has already begun.
3. **The thrown newspaper (32.5–33.2 s).** The only time it replaces a slide: a small sheet spins, grows larger than the frame and settles. This breaks the rhythm in the middle of the film. It seems also to hide the move to the lower row of panels; this is my inference, not an observation.
4. **Words do what they mean (2.13–5.2 s).** The letters are pasted on one at a time, "copied by hand" is written by a pen under the voice, a five-word phrase about working page by page is typed onto a strip. The way the text appears itself illustrates the phrase.
5. **Text assembled by the chapter's object (46.8–47.9 s).** A thin line rises from below and leaves "3D" with a colour offset behind it. A simple effect that reads as layer-by-layer printing.

Plus the typeface changes with the era: scraps, blackletter, newspaper headline, poster, typewriter, colour offset.

## What we can and cannot do

**We can in Remotion:** the shared sheet and camera (there are `RegionCamera`, `regionTransform`, `Shutter`), stamps, pins, the counter, the gauge, the thrown sheet, the pull-back. Small primitives are needed: word-level markers, a stamp hit, a cut-out with a white edge, a stroke reveal. The sheet is best built in from the very start: bolting it on later is hard.

**Main risk:** the illustrations. The whole look rests on consistent engravings by one hand. That means either paid generation (an estimate is needed, style consistency is untested) or public-domain engravings. The pen and the handwriting need prepared strokes for every line.

**Must not be carried over:** their illustrations, text, title, voice and sound. A new subject needs its own material and its own period typefaces, checked for Cyrillic.
