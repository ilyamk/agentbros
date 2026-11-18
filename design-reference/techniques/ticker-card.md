---
id: ticker-card
name: Ticker card swaps in place, then pulls back to a row
intent: "Function proof: many assets, prices or listings read as one rhythm in one place; the pull-back says there are many more."
route: remotion
timing: "polymarket (30 fps): the card holds while its asset, price and line swap every 6-12 frames; pull-back F248-F268 (about 0.67 s) on sine.inOut from a card about 0.37 W to a row at about 0.27 W, neighbours blurred by depth, the row sliding left"
curve: none (swaps); sine.inOut (pull-back); linear (row slide)
primitive: track
demo: src/motion/library/data/TickerCard.tsx
sources: ["design-reference/library/polymarket/techniques.json", "src/motion/library/data/TickerCard.tsx"]
status: draft
---

**What it does.** One market card stays put while everything on it changes on a fast cadence: mark, symbol, name, price, change and line chart swap in place, so the card itself becomes the beat. Then a soft pull-back shows it as one card of a row; the neighbours arrive soft, as if out of the lens's depth of field, and the row keeps sliding left. Library block `ticker-card`; numbers in `src/motion/library/data/ticker-plan.ts`.

**When it fits.** Everything of one kind in one place, a catalogue, listings, prices, rates: a set too large to list that still has one shape per item.

**When it does not.** One number that matters (use a hero stat); a real product's card, which must be captured, not drawn (the block's tickers are invented and unbranded on purpose); a slow film, where 6-12-frame swaps read as flicker.

**Timing.** polymarket 7.20-10.53 s at 30 fps: swaps every 6-12 frames; the pull-back's frame differences 0.4-0.9 (F249-F253), rising to 3.0 by F259-F260 and falling to 0.7 by F268, a sine.inOut over about 20 frames. Ours: seeded swaps in [6, 12] frames, the pull-back starting after the last swap over 20 frames on sine.inOut to scale 0.72, gap a third of a card, neighbours blurred by distance and staying soft, the row sliding 0.02 W a second. Side by side with polymarket 8.20-9.20 s (`motion:strip --vs`) the row scale, gaps and the soft neighbours match after one correction (scale 0.62 to 0.72, gap 0.1 to 0.32 of a card); polymarket's reflection under the cards is not built.

**Read.** `src/motion/library/data/TickerCard.tsx`, `src/motion/library/data/ticker-plan.ts`, `tests/motion-blocks-gap-scenes.test.ts`.

**Pitfalls.** Swaps under 6 frames stop reading as content. Keep prices invented or sourced: a real ticker with a made-up price is a false claim. Neighbours cross the frame edge by design and declare it with `intendedOverflow`.
