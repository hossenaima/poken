# One mascot everywhere — design

**Status:** design, not implemented
**Date:** 2026-09-20

## Problem

The Poken dot is drawn five different ways:

| Where | Markup | How it looks |
|---|---|---|
| Landing | `.l-blob` | the mascot: morphing blob, aura, face, smile |
| Session (large) | `#orb` + `.ring` × 3 | grey→coloured circle, breathing, ripple rings |
| Session (pill) | `.orb-pill-dot` | 20px circle, same colour, breathing |
| Reflection loading | `.reflection-loading-orb` | 72px coral circle, pulsing |
| Setup loading | `.reflection-loading-orb` | same class, second instance |

Each has its own markup, animation and colours, and the session's live colours are held in a
JavaScript table (`ORB_STATES` in `public/app.js`) while the mascot's are in CSS. Cohesion is not
a styling problem here; it is that one idea has five implementations that drift apart.

## Decision

The seven mascot colours stay **exclusive to the mascot**. Coral and the neutrals keep doing
everything else in the app. This is not a palette refactor.

## Design

### One component

`.pk-blob`, defined once, driven by custom properties and a state class:

```
.pk-blob.is-<state>      idle listening thinking speaking curious confused excited
  --size    the box it draws into
  --fill    set by the state class, never inline
  --glow
  --beat    how fast it breathes
  --amp     how far it squashes
  --lean
```

Two variants:

- **`.pk-blob` (default)** — face, aura, and the reactions that belong to a state: the hop and
  smiling arcs on excited, the raised brow and question mark on curious and confused, the three
  cycling dots on thinking.
- **`.pk-blob--bare`** — the morphing silhouette and colour only. No eyes, no blush, no bubble.
  For the 20px pill, where a face cannot read.

State colours move **out of `ORB_STATES` and into CSS**, next to the shape. That is what stops the
two halves drifting again.

### What each screen gets

| Screen | Variant | State | Notes |
|---|---|---|---|
| Landing | default | idle | keeps its `--t0` greeting: smile + blush as the last polka dot lands |
| Session large | default | live, all seven | rings stay; label stays |
| Session pill | `--bare` | live, all seven | 20px; colour is the whole signal |
| Reflection loading | default | idle | **no smile, no blush** — see below |
| Setup loading | default | idle | same |

### The loading screens do not smile

A grinning, blushing mascot while the student writes up what you got wrong reads as gloating. Both
loading screens use idle with the greeting suppressed: the shape morphs and the aura breathes,
nothing more.

### `setOrbState()` keeps its contract

Same name, same seven state names, same call sites. It stops writing `--orb-color` / `--orb-glow` /
`--orb-speed` and instead swaps `is-<state>` on both blobs. `ORB_STATES` keeps `label` and `rings`
and loses `color`, `glow` and `speed`.

## Non-goals

- No palette change outside the mascot.
- No layout change to any screen. Sizes match what is there now: 120px session, 20px pill,
  72px loading, 104px landing.
- No new dependencies. Classic scripts, CSS only.

## Risks

- **The session orb is live.** It is driven by audio and by `emotion` frames from the server. The
  seven states must map one to one, and it has to be checked with a real session, not by clicking.
- **Animation cost.** The session runs the blob plus three rings continuously for up to an hour.
  Keep it to transform and opacity, and never animate `box-shadow` colour on a loop.
- **The pill is 20px.** Morphing `border-radius` at that size can look like jitter. If it does, the
  bare variant should hold a fixed silhouette and only carry colour.

## Testing

Mostly behavioural, since none of this is unit-testable:

1. Landing looks and behaves exactly as it does today.
2. Both loading screens show an idle mascot that never smiles or blushes.
3. In a real session, the mascot changes with the student: listening while you speak, thinking
   while it works, speaking with rings while it talks.
4. The pill mirrors the large one, and stays legible at 20px.
5. `prefers-reduced-motion` stops the animation everywhere.
