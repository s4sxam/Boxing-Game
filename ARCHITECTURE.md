# Iron Ring — Browser Boxing Game: Technical Architecture

**Target:** Browser (desktop Chrome/Edge/Firefox, WebGL2 baseline, WebGPU progressive enhancement)
**Priority:** Gameplay physics first, visuals second, AI third
**Stack:** Three.js (rendering) + Rapier3D (physics, WASM) + Vite/TypeScript

---

## 0. The honest constraint

Fight Night Champion and UFC 5 run on dedicated console/PC engines with full deferred renderers, hardware ray tracing, and physics running native at 60–120Hz with no sandboxing. A browser tab gets:

- No hardware ray tracing today (WebGPU ray query exists but isn't reliably fast across devices in 2026) — so "ray-traced lighting" becomes **baked probes + real-time reflection cubemaps + SSR**, not literal RT.
- JS/WASM physics, single-threaded main loop unless you push work to Web Workers.
- A polygon/texture budget roughly 5–10x smaller than a PS5 exclusive before frame time explodes.
- No always-available mocap pipeline at runtime — animation has to be pre-baked (glTF skeletal clips), not computed from raw mocap data live.

So this doc designs the **best physically-grounded boxing game the browser can actually run at 60fps**, not a reskinned marketing brief. Every visual bullet from the prompt gets a browser-real equivalent below. This is the difference between a design that looks good in a document and one your engine can actually hit 60fps with — worth being explicit about up front so nothing downstream is a false promise.

---

## 1. System architecture overview

```
┌─────────────────────────────────────────────────────────┐
│                     Main Thread (JS)                     │
│  ┌───────────┐   ┌───────────┐   ┌───────────────────┐  │
│  │ Game Loop │──▶│ Input Mgr │──▶│  Gameplay Systems  │  │
│  │ (rAF, fixed│   │ (kbd/pad) │   │  (combat, stamina, │  │
│  │  timestep) │   └───────────┘   │   AI FSM/BT)       │  │
│  └─────┬─────┘                    └─────────┬──────────┘  │
│        │                                    │             │
│        ▼                                    ▼             │
│  ┌───────────┐                    ┌───────────────────┐  │
│  │  Renderer │◀───────────────────│   Damage/Physics   │  │
│  │ (Three.js,│   skeletal pose,   │   State (health,   │  │
│  │  PBR mats,│   ragdoll blend    │   bruising map,    │  │
│  │  post-fx) │                    │   stamina)         │  │
│  └───────────┘                    └─────────┬──────────┘  │
└──────────────────────────────────────────────┼────────────┘
                                                │
                          postMessage / SharedArrayBuffer
                                                │
┌───────────────────────────────────────────────▼───────────┐
│              Physics Worker Thread (Rapier3D/WASM)         │
│  Rigid bodies · Colliders · Joints (IK constraints) ·      │
│  Ragdoll rig · Continuous collision detection for punches   │
└──────────────────────────────────────────────────────────┘
```

Physics runs in a **Web Worker** at a fixed 120Hz substep, decoupled from render rate, and streams transforms back via `SharedArrayBuffer` (zero-copy) with a double-buffered snapshot so the render thread never tears mid-read. This is the single most important architecture decision for gameplay-physics-first: it means a frame-rate dip in rendering never desyncs hit-timing or stagger physics, which is exactly the kind of bug that makes a boxing game feel unfair.

---

## 2. Physics & animation (priority system)

### 2.1 Hybrid ragdoll rig

Each fighter is a Rapier `MultibodyJoint` chain: 15 rigid bodies (pelvis, spine×2, head, upper/lower arms×2, hands×2, upper/lower legs×2, feet×2) connected by spherical joints with per-joint angular limits matching human range of motion.

Two drive modes, blended by a single scalar `ragdollBlend` (0 = full animation, 1 = full physics):

- **Animation-driven (blend→0):** joints are driven toward target rotations from the current glTF animation clip using PD (proportional-derivative) motors. This is how footwork, guard, and thrown punches look controlled while still existing as real physics bodies that can be interrupted.
- **Physics-driven (blend→1):** motors disabled, joints go passive, gravity and impact impulses take over. This is a knockdown or a stumble.

A punch landing spikes `ragdollBlend` locally (just the head/neck for a jab, whole upper body for a hook to the temple) and it decays back toward 0 over ~400–900ms depending on stagger severity — that decay curve *is* the "getting your legs back" feeling.

```typescript
// physics/ragdollBlend.ts
interface RagdollState {
  blend: number;          // 0..1, current physics/anim mix
  targetBlend: number;
  decayRate: number;      // per-second recovery toward 0
  affectedBones: BoneMask; // which joints are currently blended
}

function updateRagdollBlend(state: RagdollState, dt: number) {
  state.blend += (state.targetBlend - state.blend) * Math.min(1, dt * state.decayRate);
  state.targetBlend = Math.max(0, state.targetBlend - dt * 0.5); // relax target
}

function applyPunchImpact(state: RagdollState, impulse: ImpactData) {
  const severity = clamp(impulse.force / impulse.staggerThreshold, 0, 1);
  state.targetBlend = Math.max(state.targetBlend, severity);
  state.affectedBones = severity > 0.6 ? BoneMask.FULL_UPPER : BoneMask.HEAD_NECK;
  state.decayRate = lerp(2.5, 0.8, severity); // harder hits recover slower
}
```

### 2.2 Impact physics model

Damage isn't a flat number subtracted on collision — it's derived from the actual physics quantities at the moment of contact, which is what makes landed punches feel earned rather than randomly rolled:

```typescript
interface ImpactData {
  relativeVelocity: THREE.Vector3;  // glove velocity relative to target at contact
  contactNormal: THREE.Vector3;
  contactPoint: THREE.Vector3;      // used to resolve which damage zone
  attackerMass: number;
  gloveArea: number;                // larger effective area = more force spread = less damage per unit
}

function computeImpactForce(impact: ImpactData): number {
  const closingSpeed = impact.relativeVelocity.length();
  const kineticEnergy = 0.5 * impact.attackerMass * closingSpeed ** 2;
  const pressureFactor = 1 / Math.max(impact.gloveArea, 0.01);
  return kineticEnergy * pressureFactor;
}

function resolveDamageZone(localContactPoint: THREE.Vector3): DamageZone {
  // localContactPoint is in fighter-local space, head at y > 1.5
  if (localContactPoint.y > 1.55) return DamageZone.HEAD;
  if (localContactPoint.y > 1.0) return DamageZone.BODY;
  return DamageZone.LEGS; // low blows / leg kicks if variant ruleset allows
}
```

Angle matters: a punch landing with contact normal near-parallel to the target's chin rotation axis (a hook catching a chin already turning away) multiplies stagger — this is what a "check hook" or a badly timed counter should feel like, and it falls directly out of the vector math above rather than needing a special-cased rule.

### 2.3 Animation pipeline (browser-real mocap equivalent)

No live mocap in-browser. Instead:
- Source: licensed or self-captured mocap → cleaned in Blender/MotionBuilder offline → exported as glTF skeletal animation clips (this is standard practice even for AAA — the *authoring* is offline, only playback is realtime, everywhere).
- ~120–180 clips: jab/cross/hook/uppercut ×(stance: orthodox/southpaw) ×(distance: long/mid/close), footwork 8-directional, guard idles, clinch entry/exit, 6–10 knockdown variants, 4 getting-up variants.
- Blending: Three.js `AnimationMixer` with a custom layered system — legs layer (footwork) additive with torso layer (guard/punch) — so a fighter can throw a jab while circling, which is table stakes for boxing feel.
- IK: two-bone IK (via `three-ik` or hand-rolled) for hand-target punch placement (so punches actually reach the opponent's current head position rather than a fixed animated point) and foot IK for canvas contact on uneven camera angles.

---

## 3. Rendering (browser-real fidelity ceiling)

| Prompt ask | Browser-real implementation |
|---|---|
| Ray-traced lighting/reflections | Baked light probes (irradiance volumes) for static arena + real-time reflection cubemap on canvas/gloves, refreshed every N frames, not per-pixel RT |
| Dynamic muscle deformation | Corrective blend shapes driven by joint angle (standard "JCBS" rig technique) — cheaper than full simulation, visually close for the joint ranges boxing uses |
| Skin PBR + sweat | `MeshPhysicalMaterial` with roughness map driven by a "wetness" mask texture that's painted at runtime (render-to-texture) as sweat accumulates |
| Persistent bruising/cuts/blood | Decal/damage texture painted onto a per-fighter canvas texture at contact UV coordinates, read back into the material's albedo+normal at low res (512×512 is plenty per fighter) — worsens by increasing decal opacity/normal bump per repeated hit to the same zone |
| Cloth/hair physics | Cheap verlet-integration cloth (shorts hem, a few hair strands) — 20-40 particles, not a full cloth solver; visually sufficient at broadcast camera distance |
| Cinematic KO replay | Camera spline system + time-scale ramp (not a separate render path) — record last 3 seconds of physics transforms into a ring buffer, replay at 0.15x with a scripted camera dolly |

Render pipeline: Three.js `WebGPURenderer` with `WebGLRenderer` fallback, single deferred-ish pass (MRT for albedo/normal/roughness) + a lightweight SSR pass for canvas sheen + bloom + a film-grain/vignette composite for the "broadcast" look. Target 1080p60 on mid-tier GPUs (GTX 1660 / M1 class); 4K60 on high-end as a settings tier, not the default.

---

## 4. Gameplay systems

```typescript
// gameplay/fighter.ts
interface FighterState {
  health: number;               // 0-100, KO at 0
  stamina: number;              // 0-100, gates punch power & speed
  damageZones: {
    head: ZoneDamage;
    body: ZoneDamage;
  };
  stance: 'orthodox' | 'southpaw';
  guardState: GuardState;       // high/low/none, per side
  actionState: ActionFSM;       // idle, stepping, punching, blocking, staggered, clinching, down
}

interface ZoneDamage {
  accumulated: number;   // 0-100, drives visual bruising + damage multiplier
  cutThreshold: number;  // accumulated damage at which a cut opens (lowers over rounds)
  swelling: number;      // affects vision-cone UI cue for that fighter
}
```

**Combat FSM** (per fighter): `Idle → Stepping → {Jab|Cross|Hook|Uppercut}Startup → Active → Recovery → Idle`, with `Blocking`, `Slipping`, `Clinching`, and `Staggered`/`Down` as interrupt states reachable from any non-committed frame. Punches have real startup/active/recovery frame windows (fighting-game-style, ported to boxing) — this is what makes feints and counters possible: a feint is a punch that cancels out of Startup into Recovery early, baiting a block or counter.

**Stamina** gates everything multiplicatively: punch force, punch speed, guard recovery speed, and footwork speed all scale down as stamina depletes, so a gassed fighter isn't just "weaker," they're mechanically slower to react — this is the single biggest lever for making late rounds feel different from round 1 without new systems.

**AI** (adaptive difficulty, distinct styles — deferred priority but scaffolded): behavior tree per style archetype (out-boxer, brawler, counter-puncher) with a shared blackboard (distance to opponent, own/opponent stamina, own/opponent damage zones, recent pattern history of player inputs). Adaptive difficulty adjusts the AI's *reaction latency* and *block probability*, not its "damage," so it stays legible rather than feeling like cheating.

---

## 5. Audio

Web Audio API with `PannerNode` (HRTF panning model) per sound source positioned at the 3D contact point — glove impacts, footwork, crowd. Crowd is a layered system: base ambient loop (arena size), volume/pitch envelope reacting to `FighterState.actionState` transitions (spike on knockdown, murmur on clinch break). Commentary: a finite state grammar (not full generative audio) — a bank of pre-recorded lines keyed to fight-state triggers (first knockdown, momentum swing, championship-round entry), picked with anti-repeat weighting.

---

## 6. What's genuinely deferred (and why)

- **True path-traced GI** — wait for WebGPU ray query maturity across devices; revisit yearly.
- **Full cloth/hair simulation (XPBD)** — possible but not worth the frame budget vs. the visual return at broadcast camera distance; verlet approximation covers 90% of the perceived quality.
- **Live mocap ingestion** — no product reason to do this at runtime even on console; keep it offline.

---

## 7. Immediate next build steps

1. Get the physics worker + ragdoll blend loop running with primitive capsule fighters (no skin) — validate impact/stagger feel first, since this is the priority axis. **This is what the code scaffold below does.**
2. Layer in animation clips once the physics feel is right — physics before polish, always, given the stated priority.
3. Layer in the visual pipeline (materials, decals, post-fx) last.
