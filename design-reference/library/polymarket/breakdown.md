# Polymarket: method breakdown

36 s, 1920x1080, 30 fps. For study only. There is no voice. I did not hear the sound; conclusions about it are drawn from the measurements: tempo, peaks, waveform.

## Idea

A competition announcement in which every claim is shown as a number that grows before your eyes. The viewer sees the stake grow rather than reading about it. The sum's rise takes less than a second and already works as a small story: start, tension, result.

## Hook (0–2.9 s)

A logo on an empty light background. It is replaced by one small word, then a second, then a hard cut to saturated blue and the words "IS LIVE" with expanding circles. No product, no promise: in a large empty frame every new word becomes an event, and the colour change at 2.10 s gives the first jolt.

## Structure

| Time | What happens | Why |
|---|---|---|
| 0–2.9 | Who, what, already running | Announcement |
| 2.9–4.9 | Prize amount, a chart floods the frame, a line about it repeating every 2 weeks | Stake and regularity |
| 4.9–10.5 | Dark pause, a coin lands in a card, a row of cards | Breadth of choice |
| 10.5–14.4 | The interface places an order by itself, the button grows, a gauge up to $100K | One action and what it can bring |
| 14.4–16.4 | START / TRADING / TO ENTER | Entry rule |
| 16.4–19.4 | Profit grows, the same figure in the leaderboard at the "(You)" row | The viewer has already won |
| 19.4–23.8 | TOP 50, $10K, a paper cheque with the prizes | Reward |
| 23.8–27 | A timer falls to zero, the name, the dates | Urgency |
| 27–30.1 | The sum repeated, motion stops, a question asking whether you will make the top 50 | Challenge |
| 30.1–36 | Call to action, address, logo and legal text | Action |

## Sound and editing

Tempo 130 BPM, the grid is reliable (confidence 0.71, regularity 0.98). After 10.5 s the editing does not follow the beat: 9 of 21 cuts land on the beat against a chance rate of 35%. Before 10.5 s the picture is the reverse: 5 of 8 on the beat, but there are too few cuts to prove it. Sound peaks, however, catch 19 of 21 cuts against a chance rate of 70%. It looks as if the cuts sit on hits, but it is unclear whether that is music or effects placed under the cuts. At about 9.7 s the sound energy rises sharply, from 0.18 to 0.46. This is visible in the waveform, and before that the sound is much quieter.

The detector found 23 shots. After viewing there are 30, median 0.95 s. It missed text changes on a flat background, took the chart flood for a "whip", and placed one cut 0.1 s off and called it smooth.

## Signature moves

1. **Chart as transition (3.43–3.87 s).** Five bars grow from below, almost freeze for 6 frames so they read as a chart, and flood the whole frame in 3 frames. The next caption appears already on that colour. Meaning: money grows and becomes the next scene. Without the pause it would be just a wipe.
2. **Gauge race and pause (13.2–14.37 s).** The value changes every frame: $2K, 7, 25, 41, 52, 61 … 99, 100 in 20 frames; 61% of the way already by the fifth frame. Then $100K holds for 0.47 s, and the whole gauge pulls back with acceleration straight into the cut. The rise feels like a run-up that reaches its goal, and the pause lets $100K settle.
3. **The button eats the interface (12.7–13.2 s).** The order button lightens from the edges and grows, the label inside it shrinks. The cut comes before the button fills the frame and leads to a contrasting white. The action becomes the whole frame, and there is no dull moment of flat colour.
4. **"You're first" (16.37–19.37 s).** Profit runs on white, then a blurred leaderboard and a pinned row with the same figure and the label "(You)". The row slides up, and there is a hard push-in on the top four places. The viewer is shown as the winner before the prize is named.
5. **Stop before the question (27–30.1 s).** After 27 s of constant drift everything freezes, while the cuts continue. The question reads loudest because nothing else moves.

## What we can and cannot do

**We can in Remotion:** all the text and number scenes, the chart transition, the gauge, the button, the leaderboard, the backgrounds. Small primitives need writing: a counter, a radial gauge, a row strip with a pinned row, a nearest-peak search for cuts. All of it is simple or medium.

**Harder:** the coin. It can be built in three.js, but the gloss may look like plastic, and then Blender is needed. The paper cheque with a curl is more honestly done in Blender, and it needs your consent.

**Must not be carried over:** their brand, colour, typefaces, music, graphics, figures and text. The interface must be the real interface of the new product. If there is no product with such a leaderboard, the "you're first" scene must not be shown as fact.
