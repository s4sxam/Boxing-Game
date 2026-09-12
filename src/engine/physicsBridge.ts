import { BONE_NAMES } from '../physics/types';

const FLOATS_PER_BONE = 7;
const BONES_PER_FIGHTER = BONE_NAMES.length;
const FLOATS_PER_FIGHTER = BONES_PER_FIGHTER * FLOATS_PER_BONE;
const FLOATS_PER_SNAPSHOT = FLOATS_PER_FIGHTER * 2;
const TOTAL_FLOATS = FLOATS_PER_SNAPSHOT * 2 + 1; // double-buffered + 1 flag float

export interface BoneTransform {
  position: [number, number, number];
  quaternion: [number, number, number, number];
}

type TransformListener = (fighterId: 0 | 1, bones: Map<string, BoneTransform>) => void;
type DamageListener = (fighterId: 0 | 1, damageDealt: number, state: unknown) => void;

/**
 * Owns the physics Web Worker and exposes fighter bone transforms to the
 * render loop. Prefers SharedArrayBuffer (zero-copy); falls back to
 * postMessage transform payloads automatically if cross-origin isolation
 * isn't available (e.g. deployed without the COOP/COEP headers — see
 * vite.config.ts). Either way the render thread reads via getTransforms(),
 * so the render loop never needs to know which path is active.
 */
export class PhysicsBridge {
  private worker: Worker;
  private sharedBuffer: SharedArrayBuffer | null = null;
  private sharedView: Float32Array | null = null;
  private fallbackTransforms: Map<0 | 1, Map<string, BoneTransform>> = new Map();
  private transformListeners: TransformListener[] = [];
  private damageListeners: DamageListener[] = [];
  private ready = false;
  private readyPromise: Promise<void>;
  private resolveReady!: () => void;

  constructor() {
    this.readyPromise = new Promise((res) => { this.resolveReady = res; });
    this.worker = new Worker(new URL('../physics/physicsWorker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e) => this.handleMessage(e.data);

    let sab: SharedArrayBuffer | undefined;
    if (typeof SharedArrayBuffer !== 'undefined' && crossOriginIsolated) {
      sab = new SharedArrayBuffer(TOTAL_FLOATS * 4);
      this.sharedBuffer = sab;
      this.sharedView = new Float32Array(sab);
    } else {
      console.warn('[PhysicsBridge] SharedArrayBuffer unavailable (needs COOP/COEP headers) — falling back to postMessage transform sync. Correct, but does a structured-clone copy every physics tick.');
    }

    this.worker.postMessage({ type: 'init', sab });
  }

  private handleMessage(msg: any) {
    switch (msg.type) {
      case 'ready':
        this.ready = true;
        this.resolveReady();
        break;
      case 'transforms':
        this.applyFallbackTransforms(msg.payload);
        break;
      case 'damage-applied':
        for (const l of this.damageListeners) l(msg.fighterId, msg.damageDealt, msg.state);
        break;
    }
  }

  private applyFallbackTransforms(payload: Record<number, Record<string, { p: number[]; q: number[] }>>) {
    for (const idStr of Object.keys(payload)) {
      const id = Number(idStr) as 0 | 1;
      const bones = new Map<string, BoneTransform>();
      for (const [name, t] of Object.entries(payload[id])) {
        bones.set(name, { position: t.p as [number, number, number], quaternion: t.q as [number, number, number, number] });
      }
      this.fallbackTransforms.set(id, bones);
      for (const l of this.transformListeners) l(id, bones);
    }
  }

  async waitUntilReady(): Promise<void> {
    return this.readyPromise;
  }

  /** Called from the render loop each frame if using the SharedArrayBuffer path. */
  readSharedTransforms(): Map<0 | 1, Map<string, BoneTransform>> | null {
    if (!this.sharedView) return null;
    const freshHalf = Atomics.load(this.sharedView as unknown as Int32Array, this.sharedView.length - 1);
    const offset = freshHalf * FLOATS_PER_SNAPSHOT;
    const result = new Map<0 | 1, Map<string, BoneTransform>>();

    let cursor = offset;
    for (const id of [0, 1] as const) {
      const bones = new Map<string, BoneTransform>();
      for (const name of BONE_NAMES) {
        const px = this.sharedView[cursor++], py = this.sharedView[cursor++], pz = this.sharedView[cursor++];
        const qx = this.sharedView[cursor++], qy = this.sharedView[cursor++], qz = this.sharedView[cursor++], qw = this.sharedView[cursor++];
        bones.set(name, { position: [px, py, pz], quaternion: [qx, qy, qz, qw] });
      }
      result.set(id, bones);
    }
    return result;
  }

  onTransforms(cb: TransformListener) { this.transformListeners.push(cb); }
  onDamage(cb: DamageListener) { this.damageListeners.push(cb); }

  reportPunchLanded(params: {
    targetId: 0 | 1; relativeSpeed: number; attackerMass: number; gloveArea: number;
    localContactPoint: { x: number; y: number; z: number };
    contactNormal: { x: number; y: number; z: number };
    chinRotationAxis: { x: number; y: number; z: number };
    roundNumber: number;
  }) {
    this.worker.postMessage({ type: 'punch-landed', ...params });
  }

  dispose() {
    this.worker.terminate();
  }
}
