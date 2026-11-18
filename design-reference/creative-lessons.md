# Creative lessons

The harness's curated creative lessons: generalised, with no person, product or brand names, and shared by every user of this harness. The creative director reads this file every review round; `pnpm playbook --id <id>` lists the entries tagged with a playbook, alongside the user's own.

**The rule:** a user's own lessons stay in their local memory (`memory/lessons/`, through the creative-postmortem skill), not here. A personal lesson comes here only through the improvement loop: proposed in generalised form, citing the memory ids behind it, and added once the user approves it. A benchmark proxy's decision, an agent's opinion, a critic's score or a passing check is never a lesson.

Add newest first, one entry per lesson:

```markdown
### Short name of the lesson

- **Lesson:** what to do differently, in one sentence, true for another product too: no product or brand names.
- **Rubric axis:** the creative rubric axes it bears on (picture, hook, distinctiveness, truth, feasibility, ambition, native; hookLine, reading, musicFit, oneMessage), or none.
- **Evidence:** what was seen, with the frame, render or user's words. State what is not known.
- **Project:** project id.
- **Playbook:** playbook id, when the project was bound to one.
- **Date:** YYYY-MM-DD, when the user confirmed it.
```

## Lessons

### A film built on effects, without sound, is not a film

- **Lesson:** start from music, a reference's numbers and an idea made of a picture; a list of techniques and passing sensors produce a catalogue of effects.
- **Rubric axis:** picture, ambition, native.
- **Evidence:** the user on `out/qa/creative-s1/showcase.mp4`: very weak in dynamics, motion design, frames, text animation and idea, with no sound to build the edit on, and far from the reference films. Measured: 3.9 s median between cuts against 0.2 to 2.2 s, no audio against audio in all ten references. All `motion:check` counters were at zero. What the user would accept isn't known yet.
- **Project:** creative-s1 showcase.
- **Date:** 2026-11-04.
