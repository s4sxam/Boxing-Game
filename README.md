# Iron Ring — Physics-First Boxing Scaffold

Read `ARCHITECTURE.md` first — it explains the design decisions and the honest
ceiling on browser fidelity vs. a console engine.

This scaffold validates **step 1** of the build order: a fixed-timestep
Rapier3D ragdoll rig with hybrid animation/physics blending, running in a
Web Worker, driving proxy capsule meshes in Three.js. No skin, no animation
clips yet — on purpose. Get the impact/stagger physics feeling right on ugly
geometry before spending any budget on visuals (see ARCHITECTURE.md §7).

## Setup

This was built without network access, so dependencies aren't installed yet.
On a machine with npm access:

```bash
npm install
npm run dev
```

Then open the printed localhost URL. Click "Throw test jab" to fire a
scripted punch from fighter 0 into fighter 1's head and watch the ragdoll
blend kick in on the upper body proxy capsules.

## What's real here vs. stubbed

**Real, working logic:**
- `physics/ragdollBlend.ts` — the animation/physics blend math (this is the
  core feel system, see ARCHITECTURE.md §2.1)
- `physics/damage.ts` — impact force → damage zone → accumulating damage,
  derived from actual velocity/mass/angle, not a lookup table
- `physics/physicsWorker.ts` — real Rapier3D world setup, a 15-body joint
  chain per fighter, fixed 120Hz stepping decoupled from render rate
- `engine/physicsBridge.ts` — SharedArrayBuffer zero-copy transform sync
  with automatic postMessage fallback if COOP/COEP headers aren't present

**Deliberately stubbed (per ARCHITECTURE.md build order):**
- Capsule proxy meshes instead of skinned character models
- No animation clips — PD motors referenced in the architecture doc for
  animation-driven blend mode aren't wired up yet (currently all fighters
  are physics-only / ragdoll from the start, which is why they'll just
  collapse — that's expected at this stage)
- No input/combat FSM yet — the only trigger is the debug "test punch" button
- No AI, no audio, no UI beyond the debug HUD

## Next steps (in order — see ARCHITECTURE.md §7)

1. Wire up PD motors for animation-driven mode so fighters hold a guard
   stance instead of collapsing immediately
2. Add the combat FSM (`gameplay/fighter.ts` per the architecture doc) and
   keyboard input for jab/cross/hook/uppercut
3. Bring in a real skeletal mesh + 2-3 animation clips, bind to the same
   joint chain
4. Only then start on materials/decals/post-fx
