---
category: audio
bump: minor
breaking: false
pr: 0
authors: [ilyamk]
harness: claude-code
---
Earshot now works inside the film chain instead of beside it. sfx:audition chooses each hero cue's sound from measured candidates (Earshot takes, the measured library, the synth pack) by fit and Earshot's model-free audit, writes sfx-selection.json, and sfx:cues --selection places the choices; the sound step's done check hero-sounds-selected (advisory in promo) holds the placed sound to the selection. film:measure's cut-sound-coverage measures each cue's lead from the placed sounds instead of fixed constants, and a new advisory sfx-evidence leg and critic:pack's audio-reviews.json carry saved audits of the exact bytes. sfx:map records a reference's candidate sound events by family, which the critic sees beside the placed density, and recut:plan --room-tone-span takes a chosen, checked room-tone span. Every Earshot reading stays advisory, and every step works when Earshot is not prepared.
