// Shared between main thread and physics worker. Keep this file
// dependency-free (no Three.js, no Rapier imports) so it can be
// imported on either side of the worker boundary cheaply.

export const BONE_NAMES = [
  'pelvis', 'spineLower', 'spineUpper', 'head',
  'upperArmL', 'lowerArmL', 'handL',
  'upperArmR', 'lowerArmR', 'handR',
  'upperLegL', 'lowerLegL', 'footL',
  'upperLegR', 'lowerLegR', 'footR',
] as const;

export type BoneName = typeof BONE_NAMES[number];
export const BONE_COUNT = BONE_NAMES.length;

export enum BoneMask {
  NONE = 0,
  HEAD_NECK = 1,       // head + spineUpper
  FULL_UPPER = 2,       // head + spine + arms
  FULL_BODY = 3,        // everything (knockdown)
}

export enum DamageZone {
  HEAD = 'head',
  BODY = 'body',
  LEGS = 'legs',
}

export enum ActionState {
  IDLE = 'idle',
  STEPPING = 'stepping',
  PUNCH_STARTUP = 'punch_startup',
  PUNCH_ACTIVE = 'punch_active',
  PUNCH_RECOVERY = 'punch_recovery',
  BLOCKING = 'blocking',
  SLIPPING = 'slipping',
  CLINCHING = 'clinching',
  STAGGERED = 'staggered',
  DOWN = 'down',
}

export enum PunchType {
  JAB = 'jab',
  CROSS = 'cross',
  HOOK = 'hook',
  UPPERCUT = 'uppercut',
}

// Per-punch frame data (startup/active/recovery in fixed-timestep ticks
// at 120Hz physics rate). These are first-pass placeholder numbers —
// tune against real fight footage frame-by-frame before shipping.
export const PUNCH_FRAME_DATA: Record<PunchType, { startup: number; active: number; recovery: number; baseForce: number; }> = {
  [PunchType.JAB]:     { startup: 6,  active: 3, recovery: 10, baseForce: 0.6 },
  [PunchType.CROSS]:   { startup: 10, active: 4, recovery: 16, baseForce: 1.0 },
  [PunchType.HOOK]:    { startup: 12, active: 5, recovery: 18, baseForce: 1.1 },
  [PunchType.UPPERCUT]:{ startup: 14, active: 4, recovery: 20, baseForce: 1.15 },
};

export interface ZoneDamage {
  accumulated: number;   // 0-100
  cutThreshold: number;  // lowers across rounds as fatigue/prior damage accumulates
  hasCut: boolean;
  swelling: number;      // 0-1, affects vision-cone UI cue
}

export interface FighterPhysicsState {
  id: 0 | 1;
  health: number;         // 0-100, KO at 0
  stamina: number;        // 0-100
  damageZones: {
    head: ZoneDamage;
    body: ZoneDamage;
  };
  stance: 'orthodox' | 'southpaw';
  actionState: ActionState;
  ragdollBlend: number;      // 0 = full animation, 1 = full physics
  ragdollTargetBlend: number;
  ragdollDecayRate: number;  // per-second recovery toward 0
  affectedBones: BoneMask;
}

export function createFighterState(id: 0 | 1, stance: 'orthodox' | 'southpaw'): FighterPhysicsState {
  return {
    id,
    health: 100,
    stamina: 100,
    damageZones: {
      head: { accumulated: 0, cutThreshold: 60, hasCut: false, swelling: 0 },
      body: { accumulated: 0, cutThreshold: 80, hasCut: false, swelling: 0 },
    },
    stance,
    actionState: ActionState.IDLE,
    ragdollBlend: 0,
    ragdollTargetBlend: 0,
    ragdollDecayRate: 2.5,
    affectedBones: BoneMask.NONE,
  };
}

// Transform snapshot layout for the SharedArrayBuffer bridge.
// Per bone: position (3 floats) + quaternion (4 floats) = 7 floats.
// Per fighter: BONE_COUNT * 7 floats. Two fighters, double-buffered.
export const FLOATS_PER_BONE = 7;
export const FLOATS_PER_FIGHTER = BONE_COUNT * FLOATS_PER_BONE;
export const FLOATS_PER_SNAPSHOT = FLOATS_PER_FIGHTER * 2; // two fighters
export const SNAPSHOT_BUFFER_COUNT = 2; // double-buffered to avoid tearing
export const TOTAL_FLOATS = FLOATS_PER_SNAPSHOT * SNAPSHOT_BUFFER_COUNT + 1; // +1 for the "which buffer is fresh" flag
