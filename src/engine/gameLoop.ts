import * as THREE from 'three';
import { PhysicsBridge, type BoneTransform } from './physicsBridge';
import { BONE_NAMES } from '../physics/types';

/**
 * Render-thread loop. Deliberately thin: it reads whatever the physics
 * bridge has (SharedArrayBuffer snapshot or fallback map) and drives
 * simple proxy meshes per bone. This is the "step 1" scaffold per
 * ARCHITECTURE.md — skeletal mesh binding + skinning replaces the proxy
 * capsule meshes once the physics feel is validated, without touching
 * this loop's structure.
 */
export class GameLoop {
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private renderer: THREE.WebGLRenderer;
  private physics: PhysicsBridge;
  private boneMeshes: Map<0 | 1, Map<string, THREE.Mesh>> = new Map();
  private clock = new THREE.Clock();

  constructor(container: HTMLElement) {
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0a0a0c);

    this.camera = new THREE.PerspectiveCamera(50, container.clientWidth / container.clientHeight, 0.1, 100);
    this.camera.position.set(0, 1.8, 4.5);
    this.camera.lookAt(0, 1.2, 0);

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setSize(container.clientWidth, container.clientHeight);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    container.appendChild(this.renderer.domElement);

    this.setupLighting();
    this.setupRing();
    this.physics = new PhysicsBridge();

    window.addEventListener('resize', () => this.onResize(container));
  }

  private setupLighting() {
    const key = new THREE.SpotLight(0xfff4e0, 8, 12, Math.PI / 5, 0.4, 1.5);
    key.position.set(-2, 5, 2);
    key.castShadow = true;
    this.scene.add(key);

    const rim = new THREE.SpotLight(0xdce8ff, 5, 12, Math.PI / 5, 0.4, 1.5);
    rim.position.set(2.5, 4.5, -2);
    this.scene.add(rim);

    const ambient = new THREE.AmbientLight(0x223344, 0.6);
    this.scene.add(ambient);
  }

  private setupRing() {
    const canvasGeo = new THREE.PlaneGeometry(6, 6);
    const canvasMat = new THREE.MeshStandardMaterial({ color: 0x2255aa, roughness: 0.85, metalness: 0.05 });
    const canvas = new THREE.Mesh(canvasGeo, canvasMat);
    canvas.rotation.x = -Math.PI / 2;
    canvas.receiveShadow = true;
    this.scene.add(canvas);

    // Corner posts as placeholders — replace with real ring asset.
    const postGeo = new THREE.CylinderGeometry(0.05, 0.05, 1.8, 8);
    const postMat = new THREE.MeshStandardMaterial({ color: 0x888888, metalness: 0.6, roughness: 0.4 });
    for (const [x, z] of [[-2.8, -2.8], [2.8, -2.8], [-2.8, 2.8], [2.8, 2.8]]) {
      const post = new THREE.Mesh(postGeo, postMat);
      post.position.set(x, 0.9, z);
      this.scene.add(post);
    }
  }

  async start() {
    await this.physics.waitUntilReady();
    this.buildProxyMeshes(0, 0xcc4433);
    this.buildProxyMeshes(1, 0x3366cc);

    this.physics.onTransforms((id, bones) => this.applyTransformsToMeshes(id, bones));
    this.physics.onDamage((id, dmg, state) => {
      // Wire into UI/health-bar system here. Logged for scaffold visibility.
      console.log(`[damage] fighter ${id} took ${dmg.toFixed(1)} dmg`, state);
    });

    this.animate();
  }

  private buildProxyMeshes(id: 0 | 1, color: number) {
    const bones = new Map<string, THREE.Mesh>();
    const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.6, metalness: 0.1 });
    for (const name of BONE_NAMES) {
      const geo = new THREE.CapsuleGeometry(0.08, 0.16, 4, 8); // proxy size; per-bone sizing comes from physics/physicsWorker.ts boneSpecs once shared
      const mesh = new THREE.Mesh(geo, mat);
      mesh.castShadow = true;
      this.scene.add(mesh);
      bones.set(name, mesh);
    }
    this.boneMeshes.set(id, bones);
  }

  private applyTransformsToMeshes(id: 0 | 1, bones: Map<string, BoneTransform>) {
    const meshes = this.boneMeshes.get(id);
    if (!meshes) return;
    for (const [name, t] of bones) {
      const mesh = meshes.get(name);
      if (!mesh) continue;
      mesh.position.set(...t.position);
      mesh.quaternion.set(...t.quaternion);
    }
  }

  private animate = () => {
    requestAnimationFrame(this.animate);
    this.clock.getDelta();

    // If SharedArrayBuffer is available, pull the freshest snapshot
    // directly here instead of waiting on the (unused in that path)
    // postMessage transform events.
    const shared = this.physics.readSharedTransforms();
    if (shared) {
      for (const [id, bones] of shared) this.applyTransformsToMeshes(id, bones);
    }

    this.renderer.render(this.scene, this.camera);
  };

  private onResize(container: HTMLElement) {
    this.camera.aspect = container.clientWidth / container.clientHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(container.clientWidth, container.clientHeight);
  }

  /** Test harness hook — throws a scripted jab from fighter 0 at fighter 1's head. */
  debugThrowTestPunch() {
    this.physics.reportPunchLanded({
      targetId: 1,
      relativeSpeed: 6.5,       // m/s, roughly a fast jab
      attackerMass: 4.2,        // effective punching mass (arm + rotational contribution), not full body mass
      gloveArea: 0.012,
      localContactPoint: { x: 0, y: 1.65, z: 0.1 }, // head zone
      contactNormal: { x: 0, y: 0, z: 1 },
      chinRotationAxis: { x: 0, y: 0.1, z: 0 },
      roundNumber: 1,
    });
  }
}
