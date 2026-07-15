import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as skeletonClone } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { TEAMS, WeaponId } from '@bedwars/shared';
import { weaponModels } from './weaponModels';
import warriorUrl from '../../glTF/Warrior.gltf?url';

const TARGET_HEIGHT = 1.85;
const MODEL_YAW_OFFSET = Math.PI;
const RUN_SPEED = 9;
const WALK_SPEED = 0.7;
const WEAPON_BONE = 'Weapon.R';
const BUILTIN_WEAPON_MESH = 'Warrior_Sword';

/**
 * Resolve a node by its authored glTF name. three.js's GLTFLoader runs every
 * node name through PropertyBinding.sanitizeNodeName, which strips reserved
 * characters ("[ ] . : /") — so a bone authored as "Weapon.R" is loaded into
 * the scene graph as "WeaponR" (the original is kept only in userData.name).
 * We therefore match against the sanitized name first (what getObjectByName
 * actually sees), then fall back to the raw name and a userData.name scan so
 * the lookup is robust across models and future three.js versions.
 */
function findNode(root: THREE.Object3D, authoredName: string): THREE.Object3D | null {
  const sanitized = THREE.PropertyBinding.sanitizeNodeName(authoredName);
  const direct = root.getObjectByName(sanitized) ?? root.getObjectByName(authoredName);
  if (direct) return direct;
  let match: THREE.Object3D | null = null;
  root.traverse((o) => {
    if (match) return;
    if (o.userData?.name === authoredName || o.name === sanitized || o.name === authoredName) match = o;
  });
  return match;
}

export interface RemotePos {
  id: string;
  x: number;
  y: number;
  z: number;
}

interface Entry {
  team: number;
  name: string;
  weapon: number;
  tx: number; ty: number; tz: number; tyaw: number;
  px: number; pz: number;
  fresh: boolean;
  visible: boolean;
  hitFlash: number;
  root: THREE.Group | null;
  mixer: THREE.AnimationMixer | null;
  actions: Record<string, THREE.AnimationAction>;
  current: string;
  attackT: number; // >0 while an attack clip is playing (overrides locomotion)
  mats: THREE.MeshStandardMaterial[];
  bone: THREE.Object3D | null;
  held: THREE.Object3D | null;
  heldWeapon: number;
  label: THREE.Sprite | null;
  ring: THREE.Mesh | null;
}

/** Build a team-colored name label sprite (canvas texture, always faces camera). */
function makeLabel(name: string, colorHex: number): THREE.Sprite {
  const canvas = document.createElement('canvas');
  canvas.width = 256; canvas.height = 64;
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
 * Remote (third-person) player avatars: Warrior glTF, cloned per player with
 * an independent skeleton + mixer. Each holds its active weapon on the
 * Weapon.R bone, wears a team-colored feet ring + emissive tint, and shows a
 * team-colored name label. Purely visual; movement/combat stay server-side.
 */
export class RemotePlayers {
  private scene: THREE.Scene;
  private active = new Map<string, Entry>();
  private template: THREE.Object3D | null = null;
  private clips: THREE.AnimationClip[] = [];
  private scaleFactor = 1;
  private yOffset = 0;
  private loaded = false;

  constructor(scene: THREE.Scene) {
    this.scene = scene;
    weaponModels.load();
    new GLTFLoader().load(
      warriorUrl,
      (gltf) => {
        this.template = gltf.scene;
        this.clips = gltf.animations;
        const box = new THREE.Box3().setFromObject(gltf.scene);
        const size = new THREE.Vector3();
        box.getSize(size);
        this.scaleFactor = TARGET_HEIGHT / (size.y || 1);
        this.yOffset = -box.min.y * this.scaleFactor;
        this.loaded = true;
        this.active.forEach((e, id) => { if (!e.root) this.build(id, e); });
      },
      undefined,
      (err) => console.error('[bedwars] failed to load Warrior model:', err),
    );
  }

  has(id: string): boolean {
    return this.active.has(id);
  }

  add(id: string, team: number): void {
    const e: Entry = {
      team, name: '', weapon: WeaponId.IronSword,
      tx: 0, ty: 0, tz: 0, tyaw: 0, px: 0, pz: 0,
      fresh: true, visible: true, hitFlash: 0,
      root: null, mixer: null, actions: {}, current: '', attackT: 0, mats: [],
      bone: null, held: null, heldWeapon: -1, label: null,
      ring: null,
    };
    this.active.set(id, e);
    if (this.loaded) this.build(id, e);
  }

  private build(_id: string, e: Entry): void {
    if (!this.template) return;
    const model = skeletonClone(this.template) as THREE.Object3D;
    model.scale.setScalar(this.scaleFactor);
    model.position.y = this.yOffset;
    model.rotation.y = MODEL_YAW_OFFSET;

    const teamColor = TEAMS[e.team % TEAMS.length].color;
    model.traverse((o) => {
      // Hide the character's built-in sword — we attach our own weapon.
      if (o.name === BUILTIN_WEAPON_MESH) { o.visible = false; return; }
      const mesh = o as THREE.Mesh;
      if (!(mesh as any).isMesh) return;
      mesh.castShadow = true;
      const src = mesh.material;
      const tint = (mat: THREE.Material): THREE.MeshStandardMaterial => {
        const m = mat.clone() as THREE.MeshStandardMaterial;
        if (m.emissive) { m.emissive = new THREE.Color(teamColor); m.emissiveIntensity = 0.3; }
        e.mats.push(m);
        return m;
      };
      mesh.material = Array.isArray(src) ? src.map(tint) : tint(src);
    });
    e.bone = findNode(model, WEAPON_BONE);

    const root = new THREE.Group();
    root.add(model);

    // Team ring under the feet (Roblox-BedWars style).
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.32, 0.55, 28),
      new THREE.MeshBasicMaterial({ color: teamColor, transparent: true, opacity: 0.85, side: THREE.DoubleSide, depthWrite: false }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.03;
    root.add(ring);
    e.ring = ring;

    // Team-colored name label above the head.
    const label = makeLabel(e.name || TEAMS[e.team].name, teamColor);
    label.position.y = 2.25;
    root.add(label);
    e.label = label;

    root.position.set(e.tx, e.ty, e.tz);
    root.rotation.y = e.tyaw;
    root.visible = e.visible;
    this.scene.add(root);
    e.root = root;

    const mixer = new THREE.AnimationMixer(model);
    e.mixer = mixer;
    for (const name of ['Idle', 'Walk', 'Run']) {
      const clip = THREE.AnimationClip.findByName(this.clips, name);
      if (clip) e.actions[name] = mixer.clipAction(clip);
    }
    // Resolve a one-shot attack clip (first available) for melee swing sync.
    for (const name of ['Sword_Attack', 'Sword_Attack2', 'Punch', 'Attack', 'Spell1']) {
      const clip = THREE.AnimationClip.findByName(this.clips, name);
      if (clip) { const a = mixer.clipAction(clip); a.setLoop(THREE.LoopOnce, 1); a.clampWhenFinished = false; e.actions.Attack = a; break; }
    }
    this.setAction(e, e.actions.Idle ? 'Idle' : Object.keys(e.actions)[0] ?? '');

    this.attachWeapon(e, e.weapon);
  }

  private attachWeapon(e: Entry, weaponId: number): void {
    if (!e.bone || !weaponModels.ready) return;
    if (e.heldWeapon === weaponId && e.held) return;
    if (e.held) { e.bone.remove(e.held); e.held = null; }
    const model = weaponModels.buildHand(weaponId as WeaponId);
    if (model) {
      // Counter the character scale so the weapon keeps a consistent size.
      model.scale.multiplyScalar(1 / this.scaleFactor);
      e.bone.add(model);
      e.held = model;
    }
    e.heldWeapon = weaponId;
  }

  /** Play a one-shot attack/swing on the given player (server Hit event). */
  playAttack(id: string): void {
    const e = this.active.get(id);
    if (!e || !e.mixer) return;
    const a = e.actions.Attack;
    if (!a) return;
    const prev = e.current ? e.actions[e.current] : null;
    if (prev) prev.fadeOut(0.08);
    a.reset().setEffectiveWeight(1).fadeIn(0.05).play();
    e.current = ''; // force locomotion to re-blend once the swing finishes
    e.attackT = Math.min(0.6, a.getClip().duration || 0.5);
  }

  private setLabel(e: Entry): void {
    if (!e.root) return;
    if (e.label) {
      e.root.remove(e.label);
      this.disposeLabel(e.label);
    }
    const label = makeLabel(e.name || TEAMS[e.team].name, TEAMS[e.team % TEAMS.length].color);
    label.position.y = 2.25;
    e.root.add(label);
    e.label = label;
  }

  private setAction(e: Entry, name: string): void {
    if (!name || e.current === name || !e.actions[name]) return;
    const next = e.actions[name];
    const prev = e.current ? e.actions[e.current] : null;
    next.reset().setEffectiveWeight(1).fadeIn(0.2).play();
    if (prev && prev !== next) prev.fadeOut(0.2);
    e.current = name;
  }

  updateTarget(id: string, x: number, y: number, z: number, yaw: number, visible: boolean, weapon = 0, name = ''): void {
    const e = this.active.get(id);
    if (!e) return;
    e.tx = x; e.ty = y; e.tz = z; e.tyaw = yaw; e.visible = visible;
    if (name && name !== e.name) { e.name = name; if (e.root) this.setLabel(e); }
    if (weapon !== e.weapon) { e.weapon = weapon; this.attachWeapon(e, weapon); }
    if (e.root) {
      e.root.visible = visible;
      if (e.fresh) {
        e.root.position.set(x, y, z);
        e.root.rotation.y = yaw;
        e.px = x; e.pz = z;
        e.fresh = false;
      }
    }
  }

  hitFlash(id: string): void {
    const e = this.active.get(id);
    if (!e) return;
    e.hitFlash = 0.25;
    for (const m of e.mats) { if (m.emissive) { m.emissive.setHex(0xff3333); m.emissiveIntensity = 0.9; } }
  }

  remove(id: string): void {
    const e = this.active.get(id);
    if (!e) return;
    if (e.root) this.scene.remove(e.root);
    e.mixer?.stopAllAction();
    if (e.label) this.disposeLabel(e.label);
    if (e.ring) {
      e.ring.geometry.dispose();
      (e.ring.material as THREE.Material).dispose();
    }
    for (const m of e.mats) m.dispose();
    this.active.delete(id);
  }

  private disposeLabel(label: THREE.Sprite): void {
    const mat = label.material as THREE.SpriteMaterial;
    mat.map?.dispose();
    mat.dispose();
  }

  prune(seen: Set<string>): void {
    for (const id of [...this.active.keys()]) {
      if (!seen.has(id)) this.remove(id);
    }
  }

  /** Allocation-free target query used by the per-frame combat reticle. */
  findTarget(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxDist: number): string | null {
    let best: string | null = null;
    let bestDist = maxDist;
    this.active.forEach((e, id) => {
      if (!e.visible) return;
      const px = e.tx - ox;
      const py = e.ty + 1 - oy;
      const pz = e.tz - oz;
      const dist = Math.hypot(px, py, pz);
      if (dist > bestDist) return;
      if ((px * dx + py * dy + pz * dz) / (dist || 1) < 0.94) return;
      best = id;
      bestDist = dist;
    });
    return best;
  }

  update(dt: number): void {
    const k = 1 - Math.exp(-12 * dt);
    this.active.forEach((e) => {
      const root = e.root;
      if (!root) return;

      root.position.x += (e.tx - root.position.x) * k;
      root.position.y += (e.ty - root.position.y) * k;
      root.position.z += (e.tz - root.position.z) * k;
      let d = e.tyaw - root.rotation.y;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      root.rotation.y += d * k;

      const dx = root.position.x - e.px;
      const dz = root.position.z - e.pz;
      e.px = root.position.x;
      e.pz = root.position.z;
      // Invisible/dead avatars cannot contribute pixels, so their animation
      // mixer is paused until they become visible again. Visible animations
      // continue at full rate and with the exact same clips/blending.
      if (e.visible) {
        e.mixer?.update(dt);
        // Attach a queued weapon once the weapon models finish loading.
        if (e.bone && e.held === null && weaponModels.ready) this.attachWeapon(e, e.weapon);
      }
      // While an attack swing is playing, don't override it with locomotion.
      if (e.attackT > 0) {
        e.attackT -= dt;
      } else if (e.visible) {
        const speed = Math.hypot(dx, dz) / Math.max(dt, 1e-3);
        this.setAction(e, speed > RUN_SPEED ? 'Run' : speed > WALK_SPEED ? 'Walk' : 'Idle');
      }

      if (e.hitFlash > 0) {
        e.hitFlash -= dt;
        if (e.hitFlash <= 0) {
          const c = TEAMS[e.team % TEAMS.length].color;
          for (const m of e.mats) { if (m.emissive) { m.emissive.setHex(c); m.emissiveIntensity = 0.3; } }
        }
      }
    });
  }
}
