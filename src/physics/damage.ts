import { DamageZone, type FighterPhysicsState, type ZoneDamage } from './types';
import { computeImpactForce, type ImpactData } from './ragdollBlend';

/**
 * Resolves a physics contact into gameplay damage. Deliberately reads
 * only from real physics quantities (closing speed, mass, contact area,
 * contact angle) — there is no separate "damage number" authored per
 * punch type. This is what the architecture doc calls out as the
 * difference between a punch that feels earned vs. one that feels like
 * a dice roll: the player's actual punch velocity and the defender's
 * actual head position at the moment of contact are what matter.
 */

export interface ContactEvent {
  impact: ImpactData;
  localContactPoint: { x: number; y: number; z: number }; // fighter-local space
  contactNormal: { x: number; y: number; z: number };
  chinRotationAxis: { x: number; y: number; z: number };  // defender's head angular velocity axis at contact
}

export function resolveDamageZone(localY: number): DamageZone {
  // Fighter-local space, feet at y=0, head center around y≈1.7 for an
  // average build — thresholds should be scaled per-fighter by height
  // once real rigs are in; these are placeholder splits for the capsule
  // proxy rig in the current scaffold.
  if (localY > 1.55) return DamageZone.HEAD;
  if (localY > 0.9) return DamageZone.BODY;
  return DamageZone.LEGS;
}

/** Angle bonus: a hook landing while the target's chin is already
 * rotating away from the punch (a "check hook" scenario) multiplies
 * effective stagger. Falls out of the dot product between contact
 * normal and chin angular velocity axis rather than a special case. */
function angleMultiplier(contactNormal: Vec3, chinAxis: Vec3): number {
  const dot = contactNormal.x * chinAxis.x + contactNormal.y * chinAxis.y + contactNormal.z * chinAxis.z;
  const alignment = clamp(dot, -1, 1); // -1..1
  return 1 + Math.max(0, -alignment) * 0.4; // up to +40% when perfectly counter-timed
}

type Vec3 = { x: number; y: number; z: number };

export function applyContactDamage(state: FighterPhysicsState, event: ContactEvent, roundNumber: number): number {
  const baseForce = computeImpactForce(event.impact);
  const multiplier = angleMultiplier(event.contactNormal, event.chinRotationAxis);
  const effectiveForce = baseForce * multiplier;

  const zone = resolveDamageZone(event.localContactPoint.y);
  if (zone === DamageZone.LEGS) return 0; // leg contact isn't a scoring/damage zone in classic boxing ruleset

  const zoneDamage: ZoneDamage = state.damageZones[zone];

  // Damage accumulation is nonlinear: repeated hits to an already-damaged
  // zone do more, modeling real fight damage compounding (a cut opens
  // wider, a bruise gets more sensitive).
  const compoundingFactor = 1 + zoneDamage.accumulated / 150;
  const damageDelta = effectiveForce * 8 * compoundingFactor; // 8 = tunable damage-per-joule scalar

  zoneDamage.accumulated = clamp(zoneDamage.accumulated + damageDelta, 0, 100);
  zoneDamage.swelling = clamp(zoneDamage.swelling + damageDelta * 0.15, 0, 1);

  // Cut threshold lowers slightly each round — cuts open more easily
  // late in a fight, same as real boxing.
  const effectiveCutThreshold = zoneDamage.cutThreshold - roundNumber * 2;
  if (!zoneDamage.hasCut && zoneDamage.accumulated >= effectiveCutThreshold) {
    zoneDamage.hasCut = true;
  }

  // Overall health drains faster from head damage than body damage.
  const healthDrain = zone === DamageZone.HEAD ? damageDelta * 0.7 : damageDelta * 0.35;
  state.health = clamp(state.health - healthDrain, 0, 100);

  return damageDelta;
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}
