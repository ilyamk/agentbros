# Sound and sync

Last updated: 2026-11-11. Research only: no code changed. Nothing here was listened to: maps, meters and code were read. Licence and price facts quote the page fetched on this date; anything not confirmed on a primary page says **unverified**.

## 1. What the repo already has

| Piece | What it does | How good | Gap |
|---|---|---|---|
| [sound-director](../.agents/agents/sound-director.md) + [sound-design-and-mix](../.agents/skills/sound-design-and-mix/SKILL.md) | Route question to the user, shortlist, `sound-table.md`, mix plan, measured master. Rules: three layers, two planned silences, J/L cuts, duck for the hero moment | Strong method and honest about not hearing. Human checkpoint on music is correct | No numbers for SFX gain hierarchy, sync offsets or "one riser / one impact per film"; nothing ties sounds to block cue frames |
| `audio:map` ([scripts/workers/audio-map.py](../scripts/workers/audio-map.py), librosa) | Beats, downbeats, phrases, sections, events (kick/snare/hat/perc), key moments (surge, drop, hard-stop, riser-end, impact), silences, risers, energy curve, map PNG | Best part of the stack. `gridTrust` is judged from onsets against the grid, so a pad does not fake a tempo | No sub-frame lead/lag per cue kind; downbeats are heuristic |
| `edit:snap` ([src/lib/audio-map/snap.ts](../src/lib/audio-map/snap.ts)) | Snaps cue drafts (`cut`, `transition`, `reveal`, `hit`, `stop`, `sfx`) to ranked anchors within a tolerance; `--suggest` proposes cuts from the map | Good: holes reported as `unanchored`, demotes to phrases when the grid is weak | Rounds to the nearest frame: no per-kind offset (cut early, SFX on 0). Writes a sheet; nothing in Remotion reads it |
| `music:backtime` | Ranks track offsets so the ending lands on the end card and planned cues fall on anchors | Good, idea from motion-video-kit (MIT) | Only used by hand |
| `sfx:library` ([src/lib/music/sfx.ts](../src/lib/music/sfx.ts)) | Kenney CC0 packs (interface, UI, impact) with CC0 re-checked on the page; synth `whoosh`, `riser` | Licence handling is exemplary | No sub drop, no layered hit (transient + body + tail), riser cannot be told to end on a frame; tiny palette |
| `audio:editorial` | `rhythm`, deterministic `sfx` (click/pop/whoosh/impact/chime), `cues` to timeline command, `forecast` | Useful for timeline projects | Separate vocabulary from `sfx:library`; not used by bespoke films |
| `audio:mix` ([src/lib/audio/local-mix.ts](../src/lib/audio/local-mix.ts)) + `audio:analyze` | ffmpeg mix, `sidechaincompress=threshold=0.02:ratio=8:attack=20:release=250`, defaults −16 LUFS, −1.5 dBTP | Measured, checksummed masters | Duck depth uncapped and unmeasured (0.02 ≈ −34 dBFS, ratio 8); ducks only under speech |
| ElevenLabs scripts | `generate:voiceover` (v2 or v3, forced alignment), `generate:music` (prompt or composition plan, cost bound); SFX through `sfx:find` and `sfx:cues` (collection) and `sfx:synth` (procedural) | Working, budget-guarded | [narrator-director](../.agents/agents/narrator-director.md) writes `<break time>` SSML, which v3 ignores (see §3) |
| Music providers ([src/lib/music/providers.ts](../src/lib/music/providers.ts)) | Openverse, ccMixter, Internet Archive netlabels, Freesound, Jamendo; licence re-read before acquire; rights guard | Correct and cautious | Only free CC routes. No premium library (Epidemic, Soundstripe) so "viral launch" quality is hard to reach |
| Reference sync (`sync.json` of ref-service-explainer, a local, git-ignored client analysis) | Cuts/text on beat or onset within ±0.08 s, against chance | Has a chance baseline: good instinct | Cannot discriminate at fast tempi (see finding 1) |
| Library reel ([LibraryReel.tsx](../src/motion/library/scenes/LibraryReel.tsx)) | 5 shots, 4 seams, `beatFrames(120)` | — | **Silent** (ffprobe: video stream only). Shot lengths hard-coded; the beat grid is a constant 120 BPM, not a track |
| Library contract ([types.ts](../src/motion/library/types.ts)) | 46 items | — | No `cues` field. Only `CursorClick` (land frame, iris-filled frame) and `featureDemoFrames` expose timing |

## 2. Music sources

| Source | API | Paid ads / commercial social | Price model | Fit for a launch film |
|---|---|---|---|---|
| Epidemic Sound | Yes, Partner API; free key is "Prototyping only — you cannot go live on this plan", Scale and Enterprise "Contact sales" ([developers.epidemicsound.com](https://developers.epidemicsound.com/)) | "you can use our music… for ad campaigns if you choose a Pro or Enterprise plan"; API Scale: "anywhere: social, websites, ads" ([pricing](https://www.epidemicsound.com/pricing/)) | Subscription tiers; API free up to 50 downloads, then custom | Best fit: punchy catalogue, ads covered, real API |
| Soundstripe | Yes; trial key "watermarked and expire after 30 days", "API access starts with a conversation" ([soundstripe.com/api](https://www.soundstripe.com/api)) | Page says "commercial coverage"; ads not named: unverified | Sales-led | Good second API |
| Musicbed | No API on [pricing](https://www.musicbed.com/pricing) | Business = "Client and brand work"; licence "cover[s] up to $5,000 USD in advertising spend", above that "a Custom License" ([article](https://www.musicbed.com/articles/resources/music-licensing-for-corporate-videos/)) | Subscription, prices not shown | Premium cinematic; ad-spend cap |
| Artlist | Unverified (403) | Unverified (search result, not primary: Social licence excludes paid media) | Unverified | Strong catalogue, terms unread |
| Uppbeat | Unverified (429) | Unverified (search result, not primary: free tier excludes paid ads) | Unverified | Lighter catalogue |
| Pixabay Music | No: API is "royalty-free images and videos" ([api docs](https://pixabay.com/api/docs/)) | Commercial use allowed, ads not named ([licence](https://pixabay.com/service/license-summary/)) | Free | Uneven quality, no ads clause |
| Freesound | Yes, APIv2 ([docs](https://freesound.org/docs/api/)) | CC0 "do pretty much what you want", CC-BY needs credit, CC-BY-NC "can't earn any money" ([FAQ](https://freesound.org/help/faq/)) | Free | SFX and stingers, not beds |
| Jamendo Licensing | Public API, up to 35,000 requests/month ([developer.jamendo.com](https://developer.jamendo.com/v3.0)) | Individual tier includes "Online advertising" ([pricing](https://licensing.jamendo.com/en/pricing)) | Per track: 29 €, 89 €, 289 €, 389 €, 1189 € | Cheap, clear, less punchy |
| YouTube Audio Library | No | Help page covers YouTube only and "can't give legal guidance… off the platform" ([support](https://support.google.com/youtube/answer/3376882)) | Free | Not for ads off YouTube |
| ElevenLabs Music | Yes (Music API; already wired) | "All online and offline commercial use permitted, except film, TV, radio, and Studio Games" ([music-terms](https://elevenlabs.io/music-terms)); [pricing](https://elevenlabs.io/pricing) lists music commercial use from Starter. **The two pages disagree: resolve before release** | Subscription $6–$990/mo per pricing page | Fits: generated to length and structure via composition plan |
| Suno | No public API: unverified | Paid tiers "may commercially exploit Output", Free "personal and non-commercial" ([terms](https://suno.com/terms)) | Pro $10, Premier $30/mo ([pricing](https://suno.com/pricing)) | Avoid for client ads: label litigation status unverified (search results, not primary) |
| Udio | Unverified | Unverified (terms page empty) | Unverified | Avoid: settlement and download status unverified (search results, not primary) |
| Stable Audio | Weights under Stability licence | Community licence for revenue "less than $1M", "You own outputs" ([stability.ai/license](https://stability.ai/license)); ads not named | Free under $1M, then Enterprise | Workable for small firms; quality unverified |

Recommendation: add an Epidemic Sound partner provider behind the existing rights guard (user consent and plan stated), keep ElevenLabs Music for cut-to-length beds, Jamendo Licensing as the cheap licensed fallback.

## 3. Voiceover

- **ElevenLabs v3**: tags in lowercase square brackets, "somewhat voice and context dependent" ([blog](https://elevenlabs.io/blog/eleven-v3)). Documented tags include `[excited]`, `[whispers]`, `[sighs]`, `[laughs]`, `[sarcastic]`, `[curious]`, plus examples like `[professional]`, `[reassuring]` ([prompting guide](https://elevenlabs.io/docs/best-practices/prompting/eleven-v3)). The guide says "Eleven v4 and Eleven v3 do not support SSML break tags": pauses come from tags, ellipses and punctuation. **Our narrator-director emits `<break time="Xms"/>` for v3: fix it.** 5,000 characters per request ([models](https://elevenlabs.io/docs/models)). PVCs "not fully optimized for Eleven v3".
- **OpenAI gpt-4o-mini-tts**: an `instructions` prompt steers "accent, emotional range, intonation… speed, tone, and whispering"; policy requires disclosure that the voice is AI-generated ([guide](https://developers.openai.com/api/docs/guides/text-to-speech)).
- **Cartesia Sonic 3**: `speed` 0.6–1.5, `volume` 0.5–2.0, `emotion` (beta, English) treated "as guidance" ([docs](https://docs.cartesia.ai/build-with-cartesia/sonic-3/volume-speed-emotion)). Good for exact pacing control. Commercial terms unverified.
- **Hume Octave**: acting instructions in natural language; details and terms unverified (docs did not load).
- **Pace**: ad wpm figures are unverified. Practical rule: write to the music's phrases, not a wpm; the script-writer already maps lines to sections. Leave the downbeat of a drop free of words.
- **Loudness and ducking**: social target −14 LUFS integrated, true peak ≤ −1 dBTP, ≤ −2 if louder ([Spotify](https://support.spotify.com/artists/article/loudness-normalization); YouTube's figure unverified). Claude Motion masters to −2 dBFS true peak before AAC so the MP4 stays under −1 ([CM sound-design SKILL](https://github.com/whaleyxbt/claude-motion/blob/6f80380b91858dad66524a5b34e027dad656d538/.claude/skills/sound-design/SKILL.md)). Duck depth: Hyperframes' VO carve is 6 dB at default, 10 dB at 0.5 ([audio-effects](https://hyperframes.heygen.com/reference/audio-effects.md)); a sidechain default of 10 ms attack, 200 ms release, cap −20 dB, with −6 to −12 dB for a gentle dip ([Vindral](https://composer-docs.vindral.com/operators/operators-sidechain-ducking.html)). Our mixer has 20/250 ms but no cap: add `duckDb` (default −9, range −6..−14) and measure the music bed under VO in `audio:analyze`. Our −16 LUFS default is fine for review; deliver social at −14.

## 4. Picture-to-music sync craft

- **Perception sets the offsets.** ITU-R BT.1359: detectability "45 ms lead to 125 ms lag"; EBU R37 end-to-end +40 / −60 ms ([summary](https://en.wikipedia.org/wiki/Audio-to-video_synchronization)). Sound arriving before its picture is caught at ~45 ms; sound after its picture only at ~125 ms. Derived defaults (tunable, not sourced as craft lore): **SFX transient on frame 0** of its visual event, never earlier; **a cut may land 0–2 frames (0–67 ms at 30 fps) before the beat**, which keeps the sound a small, tolerated lag behind the picture; a visual hit may land up to 3 frames before a music hit, never after it by more than 1.
- **Craft anecdote, not measurement**: "If you want to jolt the audience, be a frame ahead of the cut… if it's a more 'poetic' scene, be late to the cut" (Zimmer, quoted on a [forum](https://eoshd.com/comments/topic/46696-editing)). Use early for launch energy, late for emotion.
- **Cut by phrase on calm music**: on calm tracks the grid is "a metronome the analyzer imposed"; avoid hard timestamps that "cut mid-phrase and fight the grid" ([HF music-to-video](https://hyperframes.heygen.com/guides/music-to-video.md)). Our `gridTrust` already supports this.
- **Drop to key frame**: "start the song so the drop hits the key frame", find the drop by band energy and "never trust an auto beat grid" ([claude-motion-design](https://github.com/howseen-ai/claude-motion-design)). This is `music:backtime` generalised to any key moment, not only the end card.
- **Whoosh and riser**: the whoosh peak "should land on the edit point"; a riser that stops dead leaves a gap where "the silence after is the effect" ([Morphic](https://morphic.com/resources/sounds/whoosh-sound-effect), vendor). For a TransitionSeries seam the edit point is the seam's visual peak (mid-whip, max blur of a zoom), not its first frame.
- **Layering and hierarchy** (CM SKILL above): hero hits gain 0.25–0.35, supporting 0.08–0.2, pad ~0.03 ducked ~65% under the hero transition; "one big riser per video", ending "exactly on the hit"; "one impact per video"; pan follows on-screen position; tonal sounds in one key, pitch rising with progress; continuous motion stays silent. Sound is rendered from "the same timeline JSON as the picture, so sound can't drift out of sync". Layered hit (transient + body + tail) and sub-drop recipes: unverified, keep as house practice.
- **Every event is decided (house rule)**: each cut, transition and hero moment is a sound or a deliberate silence with its reason (`sfx` or `silent` on the cue sheet, `layers` on a hero). Undecided is blocking (`plan:check` `cut-sound-decided`, `sfx:cues`); a whoosh on every cut is a template. A silent cut mutes the block's own sound there; a decided sound replaces it. `film:measure` `cut-sound-coverage` hears each decided sound on the render (an onset within ±2 frames, a whoosh or riser from its lead).
- **Stops**: a hard-stop in the map (already detected) is the strongest anchor for a type slam or product reveal; plan the first sound after it before anything else (the skill already says so).

## 5. Findings

1. **The reference sync metric cannot tell sync from chance at fast tempi.** ref-service-explainer: cuts on beat 0.432 vs chance 0.42; on onset 0.784 vs 0.738. At 174 BPM a beat lasts 345 ms, so ±80 ms covers 2 × 0.08 / 0.345 ≈ 46 % of the timeline. Report lift over chance, judge against downbeats and strong hits only, and use ±1 frame.
2. The showcase reel is silent and its `beatFrames(120)` grid is a constant, not a measured track.
3. 44 of 46 blocks expose no cue frames; `CursorClick` is the precedent ("put the click SFX here").
4. `edit:snap` has no per-kind offset and no consumer in Remotion: the cue sheet is paperwork.
5. narrator-director emits SSML breaks that v3 does not support.
6. The mixer's duck depth is uncapped and never measured.
7. The SFX palette is too thin for launch films: no sub drop, layered hit, or frame-targeted riser.
8. Music routes are free-CC only; Epidemic Sound is the one source with a self-serve API and explicit ads cover on Pro.
9. ElevenLabs Music's terms and pricing pages disagree on commercial use by plan.
10. Suno and Udio: avoid for client ads; their litigation status is unverified here.

## 6. Proposal

| # | Build | Effort | Depends on |
|---|---|---|---|
| A | **Cue contract.** Add `cues?: (props: P) => Cue[]` to `LibraryItem`, `Cue = { name: string; frame: number; kind: CueKind; sfx?: SfxKind; weight?: "hero" \| "support" }`. Reuse `CueKindSchema` (cut, transition, reveal, hit, stop, sfx) and the existing synth kinds as `SfxKind` (click, pop, whoosh, impact, chime, riser, plus new sub-drop). Ambient blocks declare `cues: () => []`. A function, because frames depend on props (`clickAt`, `durationInFrames`). Enforced in `tests/motion-library.test.ts`, printed by `library:list --id` and the catalogue | M (46 items) | none |
| B | **Transition peaks.** Each presentation exports `peakAt` as a fraction of its seam (whip ~0.5, zoomThrough at max blur, lightBurn at full white) so the perceived cut, not the seam start, is snapped | S | A |
| C | **Beat-grid helper** `src/motion/sync/beatGrid.ts`: loads an audio map or cue sheet, exposes `snapFrame(frame, { kind, lead })` with defaults cut lead 1 frame, sfx 0, hit lead ≤ 3; wraps `snap.ts`, does not fork it. Adds `leadFrames` per kind to `edit:snap`. Replaces `beatFrames(bpm)` | S–M | `audio:map` |
| D | **SFX pack.** Extend `sfx:library` synth: `sub-drop`, layered `hit` (transient/body/tail), `riser --end-frame`, `tick`, `glass-ping`, in one key per film; procedural, deterministic, seeded (Claude Motion's MIT engine as the idea). Optional licensed layer via Epidemic SFX under the same consent rules | M | A for categories |
| E | **Cue-to-sound renderer.** Collect every block's cues through its `<Sequence>` offset into one film cue sheet; render SFX with the CM gain hierarchy and a one-riser/one-impact budget; feed `audio:mix` | M | A, C, D |
| F | **Music-first reel.** Track chosen by the user (sound-director checkpoint; generated music needs cost consent) → `audio:map` → `edit:snap --suggest` + `music:backtime` → derive `REEL_SHOTS` and seams from the sheet → render → E → `audio:mix` at −14 LUFS / −1 dBTP → `audio:analyze` | M | A–E, user's track |
| G | **Sync metric v2** in reference analysis and QA: lift over chance, downbeat/strong-hit anchors, ±1 frame, signed median offset (early/late) | S | none |
| H | **Fixes**: drop SSML breaks for v3 in narrator-director; add `duckDb` cap and a measured bed-under-VO figure | S | none |
| I | **Premium music provider**: Epidemic Sound partner API behind the rights guard | M | user's plan and key |

Order: H, G, A, B, C in parallel; then D, E; then F. I is a business decision for the user.
