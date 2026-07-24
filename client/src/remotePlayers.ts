import * as THREE from 'three';
import { PLAYER_HALF_W, PLAYER_HEIGHT, TEAMS, WeaponId } from '@bedwars/shared';
import { AnimationController, pirateAnimationLibrary } from './animationController';
import { type WeaponMotion, weaponModels } from './weaponModels';

export interface RemotePos {
  id: string;
  x: number;
  y: number;
  z: number;
}

interface SharedFlashMaterial {
  material: THREE.MeshStandardMaterial;
  emissive: THREE.Color;
  emissiveIntensity: number;
}

const sharedFlashMaterials = new WeakMap<THREE.MeshStandardMaterial, SharedFlashMaterial>();

function rayAabbDistance(
  ox: number, oy: number, oz: number,
  dx: number, dy: number, dz: number,
  minX: number, minY: number, minZ: number,
  maxX: number, maxY: number, maxZ: number,
  maxDistance: number,
): number | null {
  let near = 0;
  let far = maxDistance;

  if (Math.abs(dx) < 1e-8) {
    if (ox < minX || ox > maxX) return null;
  } else {
    let a = (minX - ox) / dx;
    let b = (maxX - ox) / dx;
    if (a > b) [a, b] = [b, a];
    near = Math.max(near, a); far = Math.min(far, b);
    if (near > far) return null;
  }
  if (Math.abs(dy) < 1e-8) {
    if (oy < minY || oy > maxY) return null;
  } else {
    let a = (minY - oy) / dy;
    let b = (maxY - oy) / dy;
    if (a > b) [a, b] = [b, a];
    near = Math.max(near, a); far = Math.min(far, b);
    if (near > far) return null;
  }
  if (Math.abs(dz) < 1e-8) {
    if (oz < minZ || oz > maxZ) return null;
  } else {
    let a = (minZ - oz) / dz;
    let b = (maxZ - oz) / dz;
    if (a > b) [a, b] = [b, a];
    near = Math.max(near, a); far = Math.min(far, b);
    if (near > far) return null;
  }
  return near <= maxDistance && far >= 0 ? Math.max(0, near) : null;
}

interface Entry {
  team: number;
  name: string;
  weaponState: number;
  tx: number;
  ty: number;
  tz: number;
  tyaw: number;
  tvx: number;
  tvy: number;
  tvz: number;
  px: number;
  pz: number;
  fresh: boolean;
  alive: boolean;
  grounded: boolean;
  deathT: number;
  hitFlash: number;
  root: THREE.Group | null;
  controller: AnimationController | null;
  weaponAnchor: THREE.Object3D | null;
  heldWeapon: THREE.Object3D | null;
  heldWeaponState: number;
  weaponAttackElapsed: number;
  weaponAttackDuration: number;
  weaponAttackMotion: WeaponMotion | null;
  label: THREE.Sprite | null;
  ring: THREE.Mesh | null;
}

/** Flash one avatar while preserving cache-owned materials for every other player. */
function installSharedMaterialFlash(mesh: THREE.Mesh, entry: Entry): void {
  const materials = (Array.isArray(mesh.material) ? mesh.material : [mesh.material])
    .filter((material): material is THREE.MeshStandardMaterial => (material as THREE.MeshStandardMaterial).isMeshStandardMaterial)
    .map((material) => {
      let state = sharedFlashMaterials.get(material);
      if (!state) {
        state = {
          material,
          emissive: material.emissive.clone(),
          emissiveIntensity: material.emissiveIntensity,
        };
        sharedFlashMaterials.set(material, state);
      }
      return state;
    });
  let flashing = false;
  mesh.onBeforeRender = () => {
    if (entry.hitFlash <= 0) return;
    flashing = true;
    for (const state of materials) {
      state.material.emissive.setHex(0xff3333);
      state.material.emissiveIntensity = 0.9;
    }
  };
  mesh.onAfterRender = () => {
    if (!flashing) return;
    flashing = false;
    for (const state of materials) {
      state.material.emissive.copy(state.emissive);
      state.material.emissiveIntensity = state.emissiveIntensity;
    }
  };
}

/** Build a team-colored name label sprite (canvas texture, always faces camera). */
function makeLabel(name: string, colorHex: number): THREE.Sprite {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 64;
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, 256, 64);
  ctx.font = 'bold 34px Segoe UI, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = 6;
  ctx.strokeStyle = 'rgba(0,0,0,0.9)';
  ctx.strokeText(name, 128, 34);
  ctx.fillStyle = `#${colorHex.toString(16).padStart(6, '0')}`;
  ctx.fillText(name, 128, 34);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(1.6, 0.4, 1);
  return sprite;
}

/**
 * Remote avatars use the seven approved Pirate Kit characters. Models and
 * semantic clips are loaded once, while every player owns an independent
 * skeleton, AnimationMixer, state machine, and exact RightHand attachment.
 * Movement and combat remain driven entirely by existing replicated state.
 */
export class RemotePlayers {
  private readonly active = new Map<string, Entry>();
  private loaded = false;
  private celebratingTeam = -1;

  constructor(private readonly scene: THREE.Scene) {
    void weaponModels.load();
    weaponModels.onReady(() => {
      this.active.forEach((entry, id) => this.attachWeapon(id, entry, entry.weaponState));
    });
    pirateAnimationLibrary.load().then(() => {
      this.loaded = true;
      this.active.forEach((entry, id) => {
        if (!entry.root && this.active.get(id) === entry) this.build(id, entry);
      });
    }).catch((error) => {
      console.error('[bedwars] failed to load Pirate Kit avatars:', error);
    });
  }

  has(id: string): boolean {
    return this.active.has(id);
  }

  add(id: string, team: number): void {
    const entry: Entry = {
      team,
      name: '',
      weaponState: WeaponId.Dagger,
      tx: 0,
      ty: 0,
      tz: 0,
      tyaw: 0,
      tvx: 0,
      tvy: 0,
      tvz: 0,
      px: 0,
      pz: 0,
      fresh: true,
      alive: true,
      grounded: true,
      deathT: 0,
      hitFlash: 0,
      root: null,
      controller: null,
      weaponAnchor: null,
      heldWeapon: null,
      heldWeaponState: -1,
      weaponAttackElapsed: 0,
      weaponAttackDuration: 0,
      weaponAttackMotion: null,
      label: null,
      ring: null,
    };
    this.active.set(id, entry);
    if (this.loaded) this.build(id, entry);
  }

  private build(id: string, entry: Entry): void {
    if (!this.loaded || entry.root || this.active.get(id) !== entry) return;
    const avatar = pirateAnimationLibrary.createAvatar(id, entry.team);
    const model = avatar.model;

    // Skeleton clones retain cache-owned geometry, textures and materials.
    // Per-draw callbacks provide isolated hit flashes without material clones.
    model.traverse((node) => {
      const mesh = node as THREE.Mesh;
      if (mesh.isMesh) installSharedMaterialFlash(mesh, entry);
    });

    const root = new THREE.Group();
    root.name = `RemotePirate:${id}:${avatar.characterName}`;
    root.add(model);

    const teamColor = TEAMS[entry.team % TEAMS.length].color;
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.32, 0.55, 28),
      new THREE.MeshBasicMaterial({
        color: teamColor,
        transparent: true,
        opacity: 0.85,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.03;
    root.add(ring);
    entry.ring = ring;

    const label = makeLabel(entry.name || TEAMS[entry.team].name, teamColor);
    label.position.y = 2.25;
    root.add(label);
    entry.label = label;

    root.position.set(entry.tx, entry.ty, entry.tz);
    root.rotation.y = entry.tyaw;
    this.scene.add(root);
    entry.root = root;
    entry.controller = new AnimationController(model, avatar.animations);
    entry.weaponAnchor = avatar.weaponAnchor;
    this.attachWeapon(id, entry, entry.weaponState);

    if (!avatar.weaponAnchor) {
      console.warn(`[bedwars] ${avatar.characterName} has no exact RightHand node for the equipped weapon`);
    }
    if (!entry.alive) entry.deathT = entry.controller.triggerDeath();
    root.visible = entry.alive || entry.deathT > 0;
    label.visible = entry.alive;
    ring.visible = entry.alive;
  }

  private attachWeapon(id: string, entry: Entry, weapon: number): void {
    if (!entry.weaponAnchor || !weaponModels.ready) return;
    const category = weaponModels.category(weapon as WeaponId);
    if (entry.heldWeaponState === weapon && (entry.heldWeapon !== null || category === null)) return;

    // Remove first so an unavailable/unsupported visual can never leave the
    // previous weapon visible as a substitution or produce two held meshes.
    if (entry.heldWeapon) {
      entry.weaponAnchor.remove(entry.heldWeapon);
      entry.heldWeapon = null;
    }
    entry.heldWeaponState = weapon;
    entry.weaponAttackElapsed = 0;
    entry.weaponAttackDuration = 0;
    entry.weaponAttackMotion = null;

    const held = weaponModels.buildHand(weapon as WeaponId, entry.weaponAnchor);
    if (!held) {
      if (category) console.warn('[bedwars] missing third-person Pirate weapon', { player: id, category });
      return;
    }
    entry.weaponAnchor.add(held);
    entry.heldWeapon = held;
  }

  /** Existing authoritative Hit events drive remote visual attack motion. */
  playAttack(id: string): void {
    const entry = this.active.get(id);
    if (!entry) return;
    const motion = weaponModels.motion(entry.weaponState as WeaponId);
    if (!motion) return;
    entry.weaponAttackMotion = motion;
    entry.weaponAttackElapsed = 0;
    entry.weaponAttackDuration = weaponModels.attackDuration(motion);
    entry.controller?.triggerAttack(motion);
  }

  private setLabel(entry: Entry): void {
    if (!entry.root) return;
    if (entry.label) {
      entry.root.remove(entry.label);
      this.disposeLabel(entry.label);
    }
    const label = makeLabel(entry.name || TEAMS[entry.team].name, TEAMS[entry.team % TEAMS.length].color);
    label.position.y = 2.25;
    label.visible = entry.alive;
    entry.root.add(label);
    entry.label = label;
  }

  updateTarget(
    id: string,
    x: number,
    y: number,
    z: number,
    yaw: number,
    alive: boolean,
    weapon = 0,
    name = '',
    vx = 0,
    vy = 0,
    vz = 0,
  ): void {
    const entry = this.active.get(id);
    if (!entry) return;

    const wasAlive = entry.alive;
    const networkDy = y - entry.ty;
    entry.grounded = entry.fresh || (Math.abs(vy) < 0.05 && Math.abs(networkDy) < 0.04);
    entry.tx = x;
    entry.ty = y;
    entry.tz = z;
    entry.tyaw = yaw;
    entry.tvx = vx;
    entry.tvy = vy;
    entry.tvz = vz;
    entry.alive = alive;
    const weaponChanged = entry.weaponState !== weapon;
    entry.weaponState = weapon;
    if (weaponChanged) this.attachWeapon(id, entry, weapon);

    if (name && name !== entry.name) {
      entry.name = name;
      if (entry.root) this.setLabel(entry);
    }
    if (!entry.root) return;

    if (alive && !wasAlive) {
      entry.deathT = 0;
      entry.fresh = true;
      entry.controller?.respawn();
    } else if (!alive && wasAlive) {
      entry.deathT = entry.controller?.triggerDeath() ?? 0;
    }

    entry.root.visible = alive || entry.deathT > 0;
    if (entry.label) entry.label.visible = alive;
    if (entry.ring) entry.ring.visible = alive;
    if (entry.fresh && alive) {
      entry.root.position.set(x, y, z);
      entry.root.rotation.y = yaw;
      entry.px = x;
      entry.pz = z;
      entry.fresh = false;
    }
  }

  setCelebratingTeam(team: number): void {
    this.celebratingTeam = team;
  }

  hitFlash(id: string): void {
    const entry = this.active.get(id);
    if (!entry || !entry.alive) return;
    entry.controller?.triggerHit();
    entry.hitFlash = 0.25;
  }

  remove(id: string): void {
    const entry = this.active.get(id);
    if (!entry) return;
    if (entry.root) this.scene.remove(entry.root);
    entry.controller?.dispose();
    if (entry.heldWeapon && entry.weaponAnchor) entry.weaponAnchor.remove(entry.heldWeapon);
    if (entry.label) this.disposeLabel(entry.label);
    if (entry.ring) {
      entry.ring.geometry.dispose();
      (entry.ring.material as THREE.Material).dispose();
    }
    this.active.delete(id);
  }

  clear(): void {
    for (const id of [...this.active.keys()]) this.remove(id);
    this.celebratingTeam = -1;
  }

  private disposeLabel(label: THREE.Sprite): void {
    const material = label.material as THREE.SpriteMaterial;
    material.map?.dispose();
    material.dispose();
  }

  prune(seen: Set<string>): void {
    for (const id of [...this.active.keys()]) {
      if (!seen.has(id)) this.remove(id);
    }
  }

  /** Exact crosshair/AABB target query used by combat input. */
  findTarget(
    ox: number, oy: number, oz: number,
    dx: number, dy: number, dz: number,
    maxDist: number,
    attackerTeam: number,
  ): string | null {
    let best: string | null = null;
    let bestDist = maxDist;
    this.active.forEach((entry, id) => {
      if (!entry.alive || entry.team === attackerTeam) return;
      const distance = rayAabbDistance(
        ox, oy, oz, dx, dy, dz,
        entry.tx - PLAYER_HALF_W, entry.ty, entry.tz - PLAYER_HALF_W,
        entry.tx + PLAYER_HALF_W, entry.ty + PLAYER_HEIGHT, entry.tz + PLAYER_HALF_W,
        bestDist,
      );
      if (distance === null || distance > bestDist) return;
      best = id;
      bestDist = distance;
    });
    return best;
  }

  private updateWeaponMotion(entry: Entry, dt: number): void {
    const held = entry.heldWeapon;
    if (!held) return;
    held.position.set(0, 0, 0);
    held.rotation.set(0, 0, 0, 'XYZ');
    if (!entry.weaponAttackMotion || entry.weaponAttackDuration <= 0) return;

    entry.weaponAttackElapsed = Math.min(
      entry.weaponAttackDuration,
      entry.weaponAttackElapsed + dt,
    );
    const progress = entry.weaponAttackElapsed / entry.weaponAttackDuration;
    if (progress >= 1) {
      entry.weaponAttackDuration = 0;
      entry.weaponAttackMotion = null;
      return;
    }
    const envelope = Math.sin(progress * Math.PI);
    if (entry.weaponAttackMotion === 'stab') {
      held.position.y += envelope * 0.18;
      held.rotation.x -= envelope * 0.18;
    } else if (entry.weaponAttackMotion === 'quickSlash') {
      held.rotation.z += envelope * 0.85;
      held.rotation.x -= envelope * 0.25;
    } else if (entry.weaponAttackMotion === 'wideSlash') {
      held.rotation.z += envelope * 1.15;
      held.rotation.y -= envelope * 0.38;
    } else if (entry.weaponAttackMotion === 'overhead') {
      held.rotation.x -= envelope * 1.20;
      held.position.z -= envelope * 0.07;
    } else if (entry.weaponAttackMotion === 'doubleHeavy') {
      held.rotation.x -= envelope * 1.42;
      held.rotation.z += envelope * 0.42;
      held.position.z -= envelope * 0.10;
    } else {
      const raise = progress < 0.28 ? progress / 0.28 : Math.max(0, 1 - (progress - 0.28) / 0.72);
      const recoilProgress = (progress - 0.28) / 0.18;
      const recoil = recoilProgress >= 0 && recoilProgress <= 1 ? Math.sin(recoilProgress * Math.PI) : 0;
      held.rotation.x -= raise * 0.34;
      held.position.y += raise * 0.04;
      held.position.z += recoil * 0.09;
    }
  }

  update(dt: number): void {
    const interpolation = 1 - Math.exp(-12 * dt);
    this.active.forEach((entry) => {
      const root = entry.root;
      if (!root) return;

      root.position.x += (entry.tx - root.position.x) * interpolation;
      root.position.y += (entry.ty - root.position.y) * interpolation;
      root.position.z += (entry.tz - root.position.z) * interpolation;
      let yawDelta = entry.tyaw - root.rotation.y;
      yawDelta = Math.atan2(Math.sin(yawDelta), Math.cos(yawDelta));
      root.rotation.y += yawDelta * interpolation;

      const dx = root.position.x - entry.px;
      const dz = root.position.z - entry.pz;
      entry.px = root.position.x;
      entry.pz = root.position.z;
      const interpolatedSpeed = Math.hypot(dx, dz) / Math.max(dt, 1e-3);
      const authoritativeSpeed = Math.hypot(entry.tvx, entry.tvz);

      if (root.visible) {
        entry.controller?.update(dt, {
          speed: Math.max(interpolatedSpeed, authoritativeSpeed),
          verticalSpeed: entry.tvy,
          grounded: entry.grounded,
          alive: entry.alive,
          celebrating: entry.alive && entry.team === this.celebratingTeam,
          armed: true,
        });
        this.updateWeaponMotion(entry, dt);
      }

      if (!entry.alive && entry.deathT > 0) {
        entry.deathT = Math.max(0, entry.deathT - dt);
        if (entry.deathT === 0) root.visible = false;
      }

      if (entry.hitFlash > 0) entry.hitFlash = Math.max(0, entry.hitFlash - dt);
    });
  }
}
