import { BoneMask, type FighterPhysicsState } from './types';

/**
 * The single most important gameplay-feel system in the game.
 *
 * ragdollBlend goes from 0 (fully animation-driven — joint motors hold
 * target poses) to 1 (fully physics-driven — motors off, gravity and
 * impact impulses take over). A landed punch spikes the blend locally;
 * it decays back toward 0 as the fighter "finds their legs again."
 *
 * This is applied per-joint in the physics worker via BoneMask, so a
 * jab to the head only ragdolls the neck/head joint while the fighter's
 * legs stay animation-driven and keep their footing — a hook to the
 * temple ragdolls the whole upper body and the legs go too if it's
 * severe enough to be a knockdown.
 */

export interface ImpactData {
  relativeSpeed: number;      // m/s, glove velocity relative to target at contact
  attackerMass: number;       // kg
  gloveArea: number;          // m^2, effective contact area
  staggerThreshold: number;   // tunable per damage zone / fighter chin rating
}

export function computeImpactForce(impact: ImpactData): number {
  const kineticEnergy = 0.5 * impact.attackerMass * impact.relativeSpeed ** 2;
  const pressureFactor = 1 / Math.max(impact.gloveArea, 0.01);
  return kineticEnergy * pressureFactor;
}

export function applyPunchImpact(state: FighterPhysicsState, impact: ImpactData): void {
  const force = computeImpactForce(impact);
  const severity = clamp(force / impact.staggerThreshold, 0, 1);

  state.ragdollTargetBlend = Math.max(state.ragdollTargetBlend, severity);
  state.affectedBones = severity > 0.6 ? BoneMask.FULL_UPPER
                       : severity > 0.15 ? BoneMask.HEAD_NECK
                       : BoneMask.NONE;

  // Harder hits recover slower — this is what makes a fighter look
  // "hurt" for a few seconds after a big shot rather than snapping
  // back to guard instantly.
  state.ragdollDecayRate = lerp(2.5, 0.6, severity);

  if (severity > 0.85) {
    state.affectedBones = BoneMask.FULL_BODY; // full knockdown ragdoll
  }
}

/** Call once per physics substep (fixed 120Hz tick). */
export function updateRagdollBlend(state: FighterPhysicsState, dt: number): void {
  // Ease current blend toward target.
  const diff = state.ragdollTargetBlend - state.ragdollBlend;
  state.ragdollBlend += diff * Math.min(1, dt * state.ragdollDecayRate * 4);

  // Target itself relaxes toward 0 over time (the fighter is actively
  // fighting to recover control, not just passively decaying).
  state.ragdollTargetBlend = Math.max(0, state.ragdollTargetBlend - dt * state.ragdollDecayRate);

  if (state.ragdollBlend < 0.02 && state.ragdollTargetBlend < 0.02) {
    state.ragdollBlend = 0;
    state.affectedBones = BoneMask.NONE;
  }
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * clamp(t, 0, 1);
}
