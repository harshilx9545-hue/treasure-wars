import * as THREE from 'three';
import { clone as skeletonClone } from 'three/examples/jsm/utils/SkeletonUtils.js';

import anneUrl from './assets/pirate/characters/anne.glb?url';
import captainBarbarossaUrl from './assets/pirate/characters/captain-barbarossa.glb?url';
import henryUrl from './assets/pirate/characters/henry.glb?url';
import makoUrl from './assets/pirate/characters/mako.glb?url';
import sharkUrl from './assets/pirate/characters/shark.glb?url';
import sharkyUrl from './assets/pirate/characters/sharky.glb?url';
import skeletonUrl from './assets/pirate/characters/skeleton.glb?url';
import { findRightHandAnchor, type WeaponMotion } from './weaponModels';
import { pirateAssetCache } from './pirateAssetCache';

export const PIRATE_CHARACTER_IDS = [
  'anne',
  'captain-barbarossa',
  'henry',
  'mako',
  'shark',
  'sharky',
  'skeleton',
] as const;

export type PirateCharacterId = typeof PIRATE_CHARACTER_IDS[number];
type PirateRig = 'humanoid' | 'shark';

export const PLAYER_ANIMATION_STATES = [
  'Idle',
  'Walk',
  'Run',
  'Sprint',
  'Jump',
  'Fall',
  'Land',
  'Sword Idle',
  'Sword Attack',
  'Block',
  'Hit',
  'Death',
  'Celebrate',
] as const;

export type PlayerAnimationState = typeof PLAYER_ANIMATION_STATES[number];

const CROSSFADE_SECONDS = 0.2;
const TARGET_PLAYER_HEIGHT = 1.85;
const TARGET_SHARK_LENGTH = 2.2;
const MODEL_YAW_OFFSET = Math.PI;

const CHARACTER_DEFINITIONS: ReadonlyArray<{
  id: PirateCharacterId;
  name: string;
  rig: PirateRig;
  url: string;
}> = [
  { id: 'anne', name: 'Anne', rig: 'humanoid', url: anneUrl },
  { id: 'captain-barbarossa', name: 'Captain Barbarossa', rig: 'humanoid', url: captainBarbarossaUrl },
  { id: 'henry', name: 'Henry', rig: 'humanoid', url: henryUrl },
  { id: 'mako', name: 'Mako', rig: 'humanoid', url: makoUrl },
  { id: 'shark', name: 'Shark', rig: 'shark', url: sharkUrl },
  { id: 'sharky', name: 'Sharky', rig: 'humanoid', url: sharkyUrl },
  { id: 'skeleton', name: 'Skeleton', rig: 'humanoid', url: skeletonUrl },
];

const HUMANOID_ALIASES: Record<PlayerAnimationState, readonly string[]> = {
  Idle: ['Idle'],
  Walk: ['Walk'],
  Run: ['Run'],
  Sprint: ['Run'],
  Jump: ['Jump'],
  Fall: ['Jump_Idle'],
  Land: ['Jump_Land'],
  'Sword Idle': ['Idle'],
  'Sword Attack': ['Sword', 'Punch'],
  Block: ['Duck'],
  Hit: ['HitReact'],
  Death: ['Death'],
  Celebrate: ['Wave', 'Yes'],
};

const SHARK_ALIASES: Record<PlayerAnimationState, readonly string[]> = {
  Idle: ['Swim'],
  Walk: ['Swim'],
  Run: ['Swim_Fast', 'Swim'],
  Sprint: ['Swim_Fast'],
  Jump: ['Swim_Fast'],
  Fall: ['Swim'],
  Land: ['Swim'],
  'Sword Idle': ['Swim'],
  'Sword Attack': ['Swim_Bite'],
  Block: ['Swim'],
  Hit: ['Swim_Bite'],
  Death: ['Swim_Bite'],
  Celebrate: ['Swim_Fast'],
};

const LOOPING_STATES = new Set<PlayerAnimationState>([
  'Idle', 'Walk', 'Run', 'Sprint', 'Fall', 'Sword Idle', 'Block', 'Celebrate',
]);

const TRANSIENT_SECONDS: Partial<Record<PlayerAnimationState, number>> = {
  Jump: 0.37,
  Land: 0.37,
  'Sword Attack': 0.87,
  Hit: 0.6,
};

const STATE_TIME_SCALE: Partial<Record<PlayerAnimationState, number>> = {
  Sprint: 1.25,
};

// Core bones exist in all six humanoid rigs. Position/scale tracks and fingers
// are intentionally excluded: shared clips then preserve each character's own
// proportions, and no animation can translate the rendered player root.
const HUMANOID_CORE_BONES = new Set([
  'root', 'footl', 'footr', 'body', 'hips', 'abdomen', 'torso', 'neck', 'head',
  'shoulderl', 'upperarml', 'lowerarml', 'shoulderr', 'upperarmr', 'lowerarmr',
  'upperlegl', 'lowerlegl', 'upperlegr', 'lowerlegr',
]);

interface LoadedGltf {
  scene: THREE.Group;
  animations: THREE.AnimationClip[];
}

interface CharacterTemplate {
  id: PirateCharacterId;
  name: string;
  rig: PirateRig;
  scene: THREE.Object3D;
  scale: number;
  yOffset: number;
}

export interface PreparedAnimationSet {
  rig: PirateRig;
  clips: Readonly<Partial<Record<PlayerAnimationState, THREE.AnimationClip>>>;
  mappedNames: Readonly<Record<PlayerAnimationState, string | null>>;
}

export interface PirateAnimationReport {
  loadedCharacters: readonly string[];
  loadedAnimations: readonly string[];
  mappedHumanoidAnimations: Readonly<Record<PlayerAnimationState, string | null>>;
  mappedSharkAnimations: Readonly<Record<PlayerAnimationState, string | null>>;
  missingAssets: readonly string[];
  rootMotionRemoved: boolean;
}

export interface PirateAvatar {
  characterId: PirateCharacterId;
  characterName: string;
  model: THREE.Object3D;
  animations: PreparedAnimationSet;
  weaponAnchor: THREE.Object3D | null;
}

export interface AnimationFrameState {
  speed: number;
  verticalSpeed: number;
  grounded: boolean;
  alive: boolean;
  celebrating: boolean;
  armed: boolean;
}

interface LibraryData {
  templates: ReadonlyMap<PirateCharacterId, CharacterTemplate>;
  animationSets: Readonly<Record<PirateRig, PreparedAnimationSet>>;
  report: Readonly<PirateAnimationReport>;
}

async function loadGltf(url: string): Promise<LoadedGltf> {
  const gltf = await pirateAssetCache.load(url);
  return { scene: gltf.scene, animations: [...gltf.animations] };
}

function compactName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function trackTargetName(trackName: string): string {
  const propertyDot = trackName.lastIndexOf('.');
  const target = propertyDot >= 0 ? trackName.slice(0, propertyDot) : trackName;
  const bracket = target.lastIndexOf('[');
  return compactName(bracket >= 0 ? target.slice(bracket + 1).replace(/\]$/, '') : target);
}

function prepareClip(source: THREE.AnimationClip, rig: PirateRig): THREE.AnimationClip {
  const tracks = source.tracks
    .filter((track) => {
      if (!track.name.endsWith('.quaternion')) return false;
      return rig === 'shark' || HUMANOID_CORE_BONES.has(trackTargetName(track.name));
    })
    .map((track) => track.clone());
  return new THREE.AnimationClip(`${rig}:${source.name}`, source.duration, tracks, source.blendMode).optimize();
}

function prepareAnimationSet(
  rig: PirateRig,
  sourceClips: readonly THREE.AnimationClip[],
  aliases: Record<PlayerAnimationState, readonly string[]>,
): PreparedAnimationSet {
  const byName = new Map(sourceClips.map((clip) => [clip.name.toLowerCase(), clip]));
  const preparedBySource = new Map<string, THREE.AnimationClip>();
  const clips: Partial<Record<PlayerAnimationState, THREE.AnimationClip>> = {};
  const mappedNames = {} as Record<PlayerAnimationState, string | null>;

  for (const state of PLAYER_ANIMATION_STATES) {
    const source = aliases[state]
      .map((name) => byName.get(name.toLowerCase()))
      .find((clip): clip is THREE.AnimationClip => clip !== undefined);
    if (source) {
      let prepared = preparedBySource.get(source.uuid);
      if (!prepared) {
        prepared = prepareClip(source, rig);
        preparedBySource.set(source.uuid, prepared);
      }
      clips[state] = prepared;
      mappedNames[state] = source.name;
    } else {
      mappedNames[state] = null;
    }
  }

  return Object.freeze({
    rig,
    clips: Object.freeze(clips),
    mappedNames: Object.freeze(mappedNames),
  });
}

function modelPlacement(scene: THREE.Object3D, rig: PirateRig): { scale: number; yOffset: number } {
  scene.updateWorldMatrix(true, true);
  const bounds = new THREE.Box3().setFromObject(scene);
  const size = bounds.getSize(new THREE.Vector3());
  const reference = rig === 'shark'
    ? Math.max(size.x, size.y, size.z, 0.001)
    : Math.max(size.y, 0.001);
  const target = rig === 'shark' ? TARGET_SHARK_LENGTH : TARGET_PLAYER_HEIGHT;
  const scale = target / reference;
  return { scale, yOffset: -bounds.min.y * scale };
}

/** Resolve an authored glTF name after GLTFLoader sanitizes punctuation. */
export function findPirateNode(root: THREE.Object3D, authoredName: string): THREE.Object3D | null {
  const sanitized = THREE.PropertyBinding.sanitizeNodeName(authoredName);
  const direct = root.getObjectByName(sanitized) ?? root.getObjectByName(authoredName);
  if (direct) return direct;
  let match: THREE.Object3D | null = null;
  root.traverse((node) => {
    if (!match && (node.userData?.name === authoredName || compactName(node.name) === compactName(authoredName))) {
      match = node;
    }
  });
  return match;
}

function chooseCharacter(playerId: string, team: number): PirateCharacterId {
  let hash = (2166136261 ^ team) >>> 0;
  for (let i = 0; i < playerId.length; i++) {
    hash ^= playerId.charCodeAt(i);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return PIRATE_CHARACTER_IDS[hash % PIRATE_CHARACTER_IDS.length]!;
}

/**
 * Loads all seven approved characters once. The six humanoids use one shared
 * rotation-only clip set; Shark uses its native clips through the same
 * semantic state map and controller API.
 */
class PirateAnimationLibrary {
  private promise: Promise<LibraryData> | null = null;
  private data: LibraryData | null = null;

  load(): Promise<LibraryData> {
    if (this.promise) return this.promise;
    this.promise = Promise.all([
      ...CHARACTER_DEFINITIONS.map((definition) => loadGltf(definition.url)),
    ]).then((loaded) => {
      const characterAssets = loaded;
      const templates = new Map<PirateCharacterId, CharacterTemplate>();
      const allAnimationNames = new Set<string>();

      CHARACTER_DEFINITIONS.forEach((definition, index) => {
        const asset = characterAssets[index]!;
        asset.scene.traverse((node) => {
          const mesh = node as THREE.Mesh;
          if (mesh.isMesh) mesh.castShadow = true;
        });
        const placement = modelPlacement(asset.scene, definition.rig);
        asset.animations.forEach((clip) => allAnimationNames.add(clip.name));
        templates.set(definition.id, {
          id: definition.id,
          name: definition.name,
          rig: definition.rig,
          scene: asset.scene,
          scale: placement.scale,
          yOffset: placement.yOffset,
        });
      });

      const humanoidSource = characterAssets[0]!.animations;
      const sharkIndex = CHARACTER_DEFINITIONS.findIndex((definition) => definition.rig === 'shark');
      const sharkSource = characterAssets[sharkIndex]!.animations;
      const humanoid = prepareAnimationSet('humanoid', humanoidSource, HUMANOID_ALIASES);
      const shark = prepareAnimationSet('shark', sharkSource, SHARK_ALIASES);
      const report: PirateAnimationReport = Object.freeze({
        loadedCharacters: Object.freeze(CHARACTER_DEFINITIONS.map((definition) => definition.name)),
        loadedAnimations: Object.freeze([...allAnimationNames].sort()),
        mappedHumanoidAnimations: humanoid.mappedNames,
        mappedSharkAnimations: shark.mappedNames,
        missingAssets: Object.freeze(['Pirate Kit Animations folder']),
        rootMotionRemoved: true,
      });

      const data: LibraryData = {
        templates,
        animationSets: Object.freeze({ humanoid, shark }),
        report,
      };
      this.data = data;
      pirateAssetCache.releaseSourceAnimationClips();

      console.info(`[bedwars] pirate characters: ${report.loadedCharacters.join(', ')}`);
      console.info(`[bedwars] pirate animations: ${report.loadedAnimations.join(', ')}`);
      console.info('[bedwars] Pirate Kit Animations folder missing; using selected characters\' embedded actions');
      console.info('[bedwars] animation translation/scale tracks removed; movement remains code-driven');
      return data;
    });
    return this.promise;
  }

  createAvatar(playerId: string, team: number): PirateAvatar {
    if (!this.data) throw new Error('Pirate animation library is not loaded');
    const characterId = chooseCharacter(playerId, team);
    const template = this.data.templates.get(characterId)!;
    const model = skeletonClone(template.scene) as THREE.Object3D;
    model.name = `PirateCharacter:${template.name}`;
    model.scale.setScalar(template.scale);
    model.position.y = template.yOffset;
    model.rotation.y = MODEL_YAW_OFFSET;
    return {
      characterId,
      characterName: template.name,
      model,
      animations: this.data.animationSets[template.rig],
      weaponAnchor: findRightHandAnchor(model),
    };
  }

  cachedRoots(): THREE.Object3D[] {
    return this.data ? [...this.data.templates.values()].map((template) => template.scene) : [];
  }

  get cachedClipCount(): number {
    if (!this.data) return 0;
    const clips = new Set<string>();
    for (const set of Object.values(this.data.animationSets)) {
      for (const clip of Object.values(set.clips)) if (clip) clips.add(clip.uuid);
    }
    return clips.size;
  }

  get report(): Readonly<PirateAnimationReport> | null {
    return this.data?.report ?? null;
  }
}

export const pirateAnimationLibrary = new PirateAnimationLibrary();

/** One state machine and one AnimationMixer for one rendered remote avatar. */
export class AnimationController {
  readonly mixer: THREE.AnimationMixer;
  private readonly actions = new Map<PlayerAnimationState, THREE.AnimationAction>();
  private currentState: PlayerAnimationState | null = null;
  private currentAction: THREE.AnimationAction | null = null;
  private overrideState: PlayerAnimationState | null = null;
  private overrideRemaining = 0;
  private grounded = true;
  private dead = false;

  constructor(private readonly root: THREE.Object3D, set: PreparedAnimationSet) {
    this.mixer = new THREE.AnimationMixer(root);
    for (const state of PLAYER_ANIMATION_STATES) {
      const clip = set.clips[state];
      if (!clip) continue;
      const action = this.mixer.clipAction(clip);
      action.setLoop(LOOPING_STATES.has(state) ? THREE.LoopRepeat : THREE.LoopOnce, LOOPING_STATES.has(state) ? Infinity : 1);
      action.clampWhenFinished = state === 'Death';
      this.actions.set(state, action);
    }
    this.transition('Sword Idle', true);
  }

  private transition(state: PlayerAnimationState, force = false, duration?: number): number {
    const next = this.actions.get(state);
    if (!next) return 0;
    if (!force && state === this.currentState) return next.getClip().duration;

    const clipDuration = Math.max(next.getClip().duration, 0.001);
    const targetDuration = duration ?? clipDuration / (STATE_TIME_SCALE[state] ?? 1);
    next.stopFading();
    next.reset();
    next.enabled = true;
    next.setEffectiveWeight(1);
    next.setEffectiveTimeScale(clipDuration / Math.max(targetDuration, 0.001));
    next.play();

    if (this.currentAction && this.currentAction !== next) {
      this.currentAction.stopFading();
      this.currentAction.fadeOut(CROSSFADE_SECONDS);
      next.fadeIn(CROSSFADE_SECONDS);
    } else if (!this.currentAction) {
      next.fadeIn(CROSSFADE_SECONDS);
    }

    this.currentState = state;
    this.currentAction = next;
    return targetDuration;
  }

  private transient(state: PlayerAnimationState, requestedDuration?: number): number {
    const duration = requestedDuration ?? TRANSIENT_SECONDS[state] ?? this.actions.get(state)?.getClip().duration ?? 0;
    if (duration <= 0) return 0;
    this.overrideState = state;
    this.overrideRemaining = this.transition(state, true, duration);
    return this.overrideRemaining;
  }

  triggerAttack(motion: WeaponMotion = 'quickSlash'): void {
    if (this.dead) return;
    const duration = motion === 'stab' ? 0.28
      : motion === 'overhead' ? 0.62
        : motion === 'doubleHeavy' ? 0.78
          : motion === 'wideSlash' ? 0.54
            : 0.38;
    this.transient('Sword Attack', duration);
  }

  triggerHit(): void {
    if (!this.dead) this.transient('Hit');
  }

  triggerDeath(): number {
    if (this.dead) return this.actions.get('Death')?.getClip().duration ?? 0;
    this.dead = true;
    this.overrideState = 'Death';
    this.overrideRemaining = Infinity;
    return this.transition('Death', true);
  }

  respawn(): void {
    this.dead = false;
    this.overrideState = null;
    this.overrideRemaining = 0;
    this.grounded = true;
    this.transition('Sword Idle', true);
  }

  update(dt: number, frame: AnimationFrameState): void {
    if (!frame.alive && !this.dead) this.triggerDeath();
    if (frame.alive && this.dead) this.respawn();

    if (!this.dead) {
      if (Number.isFinite(this.overrideRemaining) && this.overrideRemaining > 0) {
        this.overrideRemaining = Math.max(0, this.overrideRemaining - dt);
        if (this.overrideRemaining === 0) this.overrideState = null;
      }

      const tookOff = this.grounded && !frame.grounded && frame.verticalSpeed > 0.1;
      const landed = !this.grounded && frame.grounded;
      this.grounded = frame.grounded;
      if (tookOff) this.transient('Jump');
      else if (landed) this.transient('Land');

      if (!this.overrideState) {
        let desired: PlayerAnimationState;
        if (frame.celebrating) desired = 'Celebrate';
        else if (!frame.grounded) desired = 'Fall';
        else if (frame.speed >= 10) desired = 'Sprint';
        else if (frame.speed >= 4) desired = 'Run';
        else if (frame.speed >= 0.35) desired = 'Walk';
        else desired = frame.armed ? 'Sword Idle' : 'Idle';
        this.transition(desired);
      }
    }

    this.mixer.update(dt);
  }

  dispose(): void {
    this.mixer.stopAllAction();
    this.mixer.uncacheRoot(this.root);
    this.actions.clear();
  }
}
