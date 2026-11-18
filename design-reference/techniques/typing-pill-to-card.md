---
id: typing-pill-to-card
name: The typing indicator becomes the answer
intent: The waiting state turns into the reply, so the answer feels produced rather than pasted.
route: remotion
timing: "pill fills 2 f, stretches to 0.30 W in 6 f (power3.out), the card wipes through in 5 f, then grows with its lines"
curve: power3.out
primitive: progress
demo: src/motion/library/ui/AiChat.tsx
sources: ["design-reference/library/muse/techniques.json", "src/motion/library/ui/AiChat.tsx"]
status: draft
---

**What it does.** The assistant's typing pill fills with the accent, stretches sideways into a bar, and the white reply card wipes in from the bar's left end through a soft gradient, then grows taller as its lines stream. Library block: `ui-ai-chat` with `answerEntry: "pill"`.

**When it fits.** Assistant and agent products; the moment the answer arrives.

**When it does not.** A product whose real interface has no typing indicator: the capture wins over the move.

**Timing.** muse: the pill (about 0.07 W, three dots) fills blue at F325-F326, stretches into a bar about 0.30 W over F328-F333, the card wipes in from the left through the blue over F334-F338, then grows with its lines from F339.

**Read.** `PillAnswer` in `src/motion/library/ui/AiChat.tsx`, `pillTiming` and `pillState` in `src/motion/library/ui/ui-plan.ts`.

**Pitfalls.** The pill adds 25 frames before the answer; re-time cues from `aiChatCues`. One reference so far: draft.
