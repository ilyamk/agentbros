# flex: method breakdown

42.03 s, 1280×720, 30 fps. No speech: the meaning is carried by on-screen text and music. **I cannot hear the sound.** Everything said below about the sound comes from the numbers in `audio.json` and `sync.json`.

## Idea

A business bank keeps the solidity of an old institution, but money in it moves at the speed of digital dollars. The film shows this through one object: a metal card. It grows straight out of the thesis, and is then backed up: a live interface, a map of cities, payment by phone.

## Hook (0–5.7 s)

- **0–1.97 s.** The facade of an old bank with columns and flags, shot from below. The wordmark is revealed right to left (frames 1–15).
- **1.67 s.** A dark green sheet rises from below and covers the facade. On it, a six-word thesis about old banking meeting new money builds one word at a time.
- The viewer sees the symbol of the category and its refutation straight away, in under 6 s and without a voice.

## Structure

1. **Setup, 0–2.0 s.** Facade and mark.
2. **Thesis, 2.0–5.7 s.** A line on the green ground.
3. **Object, 5.7–13.6 s.** The frame shrinks into a plate, the plate becomes a button, the button flips into a card, then a fan of cards in 3D. All of this without a single cut.
4. **Promise, 13.6–15.1 s.** A line over a stormy sky.
5. **Proof, 15.1–22.6 s.** The real interface, then a transfer form.
6. **Speed, 22.6–25.7 s.** Source city, five flashes of 4 frames each, destination city.
7. **Scale, 25.7–28.2 s.** The number of countries over a sphere of strokes.
8. **Everyday, 28.2–31.2 s.** Phone and payment.
9. **Anthem, 31.2–38.2 s.** Six shots of roughly 1 s each.
10. **Signature, 38.2–42.0 s.** The mark and a small call to action.

## Edit and sound (not heard)

- **Cuts.** The detector found 20 shots and 19 cuts. After corrections there are 22 shots, 21 cuts, 30 cuts per minute, median shot 1.25 s.
- **Two speeds.** Up to 22.6 s there are six long shots (median 2.85 s), joined by built transitions. After 22.6 s, hard cuts.
- **Tempo.** 111 BPM, confidence 0.57.
- **Cuts and beats.** 9 of the 21 cuts land on a beat (±80 ms), which is 0.43 against a random level of 0.29.
- **Onsets.** There are 6 per second, so matches with onsets (0.95 against 0.84 for random) prove nothing.
- **Downbeats.** Confidence in them is 0.007; I draw no conclusions about them.
- **Loudness spikes.** 6 of 21 against a random level of 0.26, so there is no evidence.
- **The only hint of a grid is the anthem.** There, 5 of 7 cuts land on a beat, and shots hold for 0.97–1.20 s, which is close to two beats (1.08 s). The sample is small, so this is an inference, not a measurement.

## Signature moves

- **The frame shrinks into an object, 5.43–8.4 s, frames 163–260.**
  - The whole thesis frame shrinks over 19 frames to a plate about 40% of the frame wide on a warm milky ground, with a highlight sweeping across it.
  - The plate becomes a button; its label types at one letter per 2 frames.
  - The button turns edge-on (frames 241–245) and opens out into a card (frames 246–251).
  - The eye does not have to look for a new object: what it was reading has become the object.
- **Flashes under one caption, 22.6–25.7 s.**
  - Five shots of 4 frames each (one of 3 frames).
  - The caption stays in place, only the city name changes, and the tail of the phrase keeps revealing across the cuts.
  - The speed of the edit is itself the proof of the promised speed.
- **Rising sheet, 1.67–2.5 s and 14.8–16.2 s.**
  - The new ground rises from below: 6% of the height on frame 52, 55% on frame 56, 86% on frame 64.
  - Then comes a long tail, and a strip of the old frame stays at the top until frame 74.
- **Anthem, 31.2–38.2 s.**
  - A constant start of the phrase in an upright light grotesque, the value word in a serif italic; the italic reveals over 8 frames.
  - The last shot is white, the word "you" in the brand green (#3b7755).
- **Organic mask, 13.4–13.77 s.** A soft cloud-like mask opens the sky over the card in 11 frames; a coloured fringe is visible at its edge.

## What can and cannot be repeated

**Can do in Remotion:**

- the rising sheet: a short custom presentation, `missing:sheetCover`;
- line-by-line word build;
- frame shrink through `LayoutMorph`/`GrowToScene`;
- caption typing;
- button flip: `missing:flipCard`;
- camera over the interface through `RegionCamera`, ease power1.inOut;
- sphere of strokes: `missing:strokeSphere`;
- bloom from the edges: `missing:radialBloom`;
- the anthem and the final mark.

**Needs other routes:**

- the metal fan of cards: Blender, through `blender-plate`;
- the organic mask: a Hyperframes shader; the nearest equivalent in Remotion is a blurred radial mask;
- the cities and the anthem shots: licensed stock;
- the interface: only the real product, captured through `capture:app`;
- the wallet screen on the phone: an exact replica from a fresh, dated screenshot.

**Cannot:** take the original's brand, music, graphics or text. This material is for study only.
