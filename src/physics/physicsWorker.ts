/// <reference lib="webworker" />
import RAPIER from '@dimforge/rapier3d-compat';
import {
  BONE_NAMES, createFighterState, PUNCH_FRAME_DATA,
  ActionState, PunchType, type FighterPhysicsState,
} from './types';
import { updateRagdollBlend, applyPunchImpact } from './ragdollBlend';
import { applyContactDamage } from './damage';

const FIXED_DT = 1 / 120; // physics runs at 120Hz regardless of render framerate
let accumulator = 0;
let lastTime = performance.now();

let world: RAPIER.World;
const fighterBodies: Map<0 | 1, Map<string, RAPIER.RigidBody>> = new Map();
const fighterStates: Map<0 | 1, FighterPhysicsState> = new Map();

// Double-buffered transform snapshot shared with the main thread.
let sharedBuffer: SharedArrayBuffer | null = null;
let sharedView: Float32Array | null = null;
let useSharedBuffer = false;
let writeBufferIndex = 0; // 0 or 1 — which half of sharedView we're writing this tick

async function init(msg: { sab?: SharedArrayBuffer }) {
  await RAPIER.init();
  world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });

  buildRing();
  fighterStates.set(0, createFighterState(0, 'orthodox'));
  fighterStates.set(1, createFighterState(1, 'southpaw'));
  buildFighterRig(0, { x: -0.8, y: 0, z: 0 });
  buildFighterRig(1, { x: 0.8, y: 0, z: 0 });

  if (msg.sab) {
    sharedBuffer = msg.sab;
    sharedView = new Float32Array(sharedBuffer);
    useSharedBuffer = true;
  }

  self.postMessage({ type: 'ready', usingSharedBuffer: useSharedBuffer });
  requestTick();
}

function buildRing() {
  // Canvas as a large flat collider — visual ring/ropes are render-only,
  // no need to model rope colliders unless a fighter-vs-ropes interaction
  // is a design requirement (recommend adding later as a soft constraint
  // volume around the ring perimeter, not full rope physics).
  const canvasDesc = RAPIER.RigidBodyDesc.fixed().setTranslation(0, 0, 0);
  const canvasBody = world.createRigidBody(canvasDesc);
  world.createCollider(RAPIER.ColliderDesc.cuboid(3, 0.05, 3), canvasBody);
}

function buildFighterRig(id: 0 | 1, origin: { x: number; y: number; z: number }) {
  const bones = new Map<string, RAPIER.RigidBody>();

  // Simplified capsule-per-bone rig for the physics-validation pass
  // (see ARCHITECTURE.md step 1). Real skeletal mesh binding comes once
  // this feels right — deliberately proxy geometry here so the impact/
  // stagger tuning loop is fast to iterate on.
  const boneSpecs: Record<string, { halfHeight: number; radius: number; localPos: [number, number, number] }> = {
    pelvis:     { halfHeight: 0.08, radius: 0.14, localPos: [0, 0.95, 0] },
    spineLower: { halfHeight: 0.10, radius: 0.13, localPos: [0, 1.15, 0] },
    spineUpper: { halfHeight: 0.12, radius: 0.15, localPos: [0, 1.40, 0] },
    head:       { halfHeight: 0.06, radius: 0.10, localPos: [0, 1.68, 0] },
    upperArmL:  { halfHeight: 0.14, radius: 0.06, localPos: [-0.25, 1.45, 0] },
    lowerArmL:  { halfHeight: 0.13, radius: 0.05, localPos: [-0.25, 1.15, 0] },
    handL:      { halfHeight: 0.05, radius: 0.06, localPos: [-0.25, 0.95, 0] },
    upperArmR:  { halfHeight: 0.14, radius: 0.06, localPos: [0.25, 1.45, 0] },
    lowerArmR:  { halfHeight: 0.13, radius: 0.05, localPos: [0.25, 1.15, 0] },
    handR:      { halfHeight: 0.05, radius: 0.06, localPos: [0.25, 0.95, 0] },
    upperLegL:  { halfHeight: 0.20, radius: 0.09, localPos: [-0.1, 0.65, 0] },
    lowerLegL:  { halfHeight: 0.20, radius: 0.07, localPos: [-0.1, 0.25, 0] },
    footL:      { halfHeight: 0.05, radius: 0.06, localPos: [-0.1, 0.03, 0.05] },
    upperLegR:  { halfHeight: 0.20, radius: 0.09, localPos: [0.1, 0.65, 0] },
    lowerLegR:  { halfHeight: 0.20, radius: 0.07, localPos: [0.1, 0.25, 0] },
    footR:      { halfHeight: 0.05, radius: 0.06, localPos: [0.1, 0.03, 0.05] },
  };

  for (const name of BONE_NAMES) {
    const spec = boneSpecs[name];
    const desc = RAPIER.RigidBodyDesc.dynamic().setTranslation(
      origin.x + spec.localPos[0], spec.localPos[1], origin.z + spec.localPos[2]
    );
    const body = world.createRigidBody(desc);
    world.createCollider(RAPIER.ColliderDesc.capsule(spec.halfHeight, spec.radius).setDensity(1.0), body);
    bones.set(name, body);
  }

  // Joint chain: connect each bone to its parent with a spherical joint
  // and angular limits. This is the minimum needed for a hybrid ragdoll —
  // PD motors are applied in the animation-blend step, not here.
  const chain: [string, string][] = [
    ['pelvis', 'spineLower'], ['spineLower', 'spineUpper'], ['spineUpper', 'head'],
    ['spineUpper', 'upperArmL'], ['upperArmL', 'lowerArmL'], ['lowerArmL', 'handL'],
    ['spineUpper', 'upperArmR'], ['upperArmR', 'lowerArmR'], ['lowerArmR', 'handR'],
    ['pelvis', 'upperLegL'], ['upperLegL', 'lowerLegL'], ['lowerLegL', 'footL'],
    ['pelvis', 'upperLegR'], ['upperLegR', 'lowerLegR'], ['lowerLegR', 'footR'],
  ];
  for (const [parent, child] of chain) {
    const parentBody = bones.get(parent)!;
    const childBody = bones.get(child)!;
    const joint = RAPIER.JointData.spherical(
      { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 } // anchor offsets — replace with real bone-length offsets once real rig is bound
    );
    world.createImpulseJoint(joint, parentBody, childBody, true);
  }

  fighterBodies.set(id, bones);
}

/** Called from the main thread when a punch's active frames land a hit. */
function handlePunchLanded(msg: {
  targetId: 0 | 1;
  relativeSpeed: number;
  attackerMass: number;
  gloveArea: number;
  localContactPoint: { x: number; y: number; z: number };
  contactNormal: { x: number; y: number; z: number };
  chinRotationAxis: { x: number; y: number; z: number };
  roundNumber: number;
}) {
  const state = fighterStates.get(msg.targetId)!;
  const staggerThreshold = 40; // tunable per-fighter "chin rating"

  applyPunchImpact(state, {
    relativeSpeed: msg.relativeSpeed,
    attackerMass: msg.attackerMass,
    gloveArea: msg.gloveArea,
    staggerThreshold,
  });

  const damageDealt = applyContactDamage(state, {
    impact: { relativeSpeed: msg.relativeSpeed, attackerMass: msg.attackerMass, gloveArea: msg.gloveArea, staggerThreshold },
    localContactPoint: msg.localContactPoint,
    contactNormal: msg.contactNormal,
    chinRotationAxis: msg.chinRotationAxis,
  }, msg.roundNumber);

  if (state.health <= 0) {
    state.actionState = ActionState.DOWN;
  }

  self.postMessage({ type: 'damage-applied', fighterId: msg.targetId, damageDealt, state: serializeState(state) });
}

function serializeState(state: FighterPhysicsState) {
  // Structured-clone-safe plain object for postMessage fallback path.
  return JSON.parse(JSON.stringify(state));
}

function tick() {
  const now = performance.now();
  let frameTime = (now - lastTime) / 1000;
  lastTime = now;
  frameTime = Math.min(frameTime, 0.25); // clamp to avoid spiral-of-death on tab-throttle wakeups

  accumulator += frameTime;
  while (accumulator >= FIXED_DT) {
    world.step();
    for (const state of fighterStates.values()) {
      updateRagdollBlend(state, FIXED_DT);
    }
    accumulator -= FIXED_DT;
  }

  writeTransformSnapshot();
  requestTick();
}

function writeTransformSnapshot() {
  if (!useSharedBuffer || !sharedView) {
    // Fallback: postMessage the transforms each tick (structured clone
    // cost, but correctness is unaffected — see vite.config.ts comment).
    const payload: Record<number, Record<string, { p: number[]; q: number[] }>> = {};
    for (const [id, bones] of fighterBodies) {
      payload[id] = {};
      for (const [name, body] of bones) {
        const p = body.translation();
        const q = body.rotation();
        payload[id][name] = { p: [p.x, p.y, p.z], q: [q.x, q.y, q.z, q.w] };
      }
    }
    self.postMessage({ type: 'transforms', payload });
    return;
  }

  // SharedArrayBuffer path: write into the inactive half, then flip the
  // "fresh buffer" flag atomically so the render thread never reads a
  // half-written frame.
  const FLOATS_PER_BONE = 7;
  const bonesPerFighter = BONE_NAMES.length;
  const floatsPerFighter = bonesPerFighter * FLOATS_PER_BONE;
  const floatsPerSnapshot = floatsPerFighter * 2;
  const offset = writeBufferIndex * floatsPerSnapshot;

  let cursor = offset;
  for (const id of [0, 1] as const) {
    const bones = fighterBodies.get(id)!;
    for (const name of BONE_NAMES) {
      const body = bones.get(name)!;
      const p = body.translation();
      const q = body.rotation();
      sharedView[cursor++] = p.x; sharedView[cursor++] = p.y; sharedView[cursor++] = p.z;
      sharedView[cursor++] = q.x; sharedView[cursor++] = q.y; sharedView[cursor++] = q.z; sharedView[cursor++] = q.w;
    }
  }

  // Flag lives at the very end of the buffer; value = index of the fresh half.
  Atomics.store(sharedView as unknown as Int32Array, sharedView.length - 1, writeBufferIndex);
  writeBufferIndex = 1 - writeBufferIndex;
}

let tickScheduled = false;
function requestTick() {
  if (tickScheduled) return;
  tickScheduled = true;
  // setTimeout(0), not requestAnimationFrame — workers have no rAF, and we
  // don't want physics tied to display refresh rate anyway (fixed_dt above
  // is what guarantees deterministic physics regardless of render fps).
  setTimeout(() => { tickScheduled = false; tick(); }, 0);
}

self.onmessage = (e: MessageEvent) => {
  const msg = e.data;
  switch (msg.type) {
    case 'init': init(msg); break;
    case 'punch-landed': handlePunchLanded(msg); break;
    default: console.warn('[physicsWorker] unknown message', msg.type);
  }
};
