# script-writer: worked examples

"Lumen" is an invented note-taking app that keeps exact quotes from connected sources.

| Bad | Why | Good |
|---|---|---|
| "Nobody talks about the one thing holding your AI back…" | A hook from a table: fits anything, says nothing | No line. The first frame is an empty window with a blinking cursor; let it be |
| "Convenient search across all your chats" | A claim where proof exists | "If you raise a round, write to me." 14 March 2021. The quote and date are the argument |
| "Your AI will get smarter" | Fits every AI product, and untrue: the model does not change | "Your AI is one day old." then "You have years." Two screens of 5 and 3 words on a low section. True of this product |
| "They roast for stock. They don't know what will sell." held over a blur | Words doing a frame's job, in a roastery film | A discount sticker lands on a pack. No line |
| Eleven words in a 1.2 s phrase of a high section | The viewer gets three | Two words at the peak; the rest moves to the low section before it, or is cut |
| "The assistant writes and sends it for you" | Untrue; on `mayNotSay` | "Draft ready. You send it." Only as a teaser while the claim is `in-development` |

## Reading floor (from src/lib/film/plan-check.ts)

At most two words need 0.8 s settled; more need 0.3 s a word; Cyrillic takes 1.25×. Allow ~0.3 s entrance.

| Cyrillic words on one screen | Settled | Shortest screen with entrance |
|---|---|---|
| 1–2 | 1.0 s | 1.3 s |
| 3 | 1.13 s | 1.45 s |
| 4 | 1.5 s | 1.8 s |
| 5 | 1.88 s | 2.2 s |
| 6 | 2.25 s | 2.55 s |
| 8 | 3.0 s | 3.3 s |

Latin script: 1–2 words 0.8 s settled (1.1 s with entrance); n ≥ 3 words n × 0.3 s settled.
