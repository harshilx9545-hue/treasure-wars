import * as THREE from 'three';
import { WeaponId } from '@bedwars/shared';
import { pirateAssetCache } from './pirateAssetCache';

/** Build-time directory discovery: adding/removing a model updates this list automatically. */
const DISCOVERED_WEAPON_MODULES = import.meta.glob(
  ['./assets/pirate/weapons/*.glb', './assets/pirate/weapons/*.gltf'],
  { eager: true, query: '?url', import: 'default' },
) as Record<string, string>;

const DISCOVERED_WEAPON_ASSETS = Object.entries(DISCOVERED_WEAPON_MODULES)
  .sort(([left], [right]) => left.localeCompare(right))
  .map(([sourcePath, url]) => ({ sourcePath, url }));

export const PIRATE_WEAPON_CATEGORIES = [
  'dagger', 'sword', 'largeSword', 'cutlass', 'axe', 'doubleAxe',
] as const;

export type PirateWeaponCategory = typeof PIRATE_WEAPON_CATEGORIES[number];
export type WeaponMotion = 'stab' | 'quickSlash' | 'wideSlash' | 'overhead' | 'doubleHeavy';

export const PIRATE_GAMEPLAY_WEAPON_MAP = Object.freeze({
  [WeaponId.Dagger]: 'dagger',
  [WeaponId.NormalSword]: 'sword',
  [WeaponId.LargeSword]: 'largeSword',
  [WeaponId.Cutlass]: 'cutlass',
  [WeaponId.Axe]: 'axe',
  [WeaponId.DoubleAxe]: 'doubleAxe',
} satisfies Record<WeaponId, PirateWeaponCategory>);

const CATEGORY_MOTION: Readonly<Record<PirateWeaponCategory, WeaponMotion>> = Object.freeze({
  dagger: 'stab',
  sword: 'quickSlash',
  largeSword: 'wideSlash',
  cutlass: 'wideSlash',
  axe: 'overhead',
  doubleAxe: 'doubleHeavy',
});

const ATTACK_DURATION: Readonly<Record<WeaponMotion, number>> = Object.freeze({
  stab: 0.28,
  quickSlash: 0.38,
  wideSlash: 0.54,
  overhead: 0.62,
  doubleHeavy: 0.78,
});

/** Desired world-space lengths; local hand scale is derived from its world transform. */
const TARGET_LENGTHS: Readonly<Record<PirateWeaponCategory, { firstPerson: number; thirdPerson: number }>> = Object.freeze({
  dagger: { firstPerson: 0.54, thirdPerson: 0.46 },
  sword: { firstPerson: 0.84, thirdPerson: 0.76 },
  largeSword: { firstPerson: 1.08, thirdPerson: 0.98 },
  cutlass: { firstPerson: 0.92, thirdPerson: 0.84 },
  axe: { firstPerson: 0.86, thirdPerson: 0.78 },
  doubleAxe: { firstPerson: 1.04, thirdPerson: 0.96 },
});

interface GeometryAnalysis {
  vertices: number[];
  bounds: THREE.Box3;
  dimensions: THREE.Vector3;
  longAxis: 0 | 1 | 2;
  lateralAxis: 0 | 1 | 2;
  thinAxis: 0 | 1 | 2;
  vertexCount: number;
  triangleCount: number;
  fingerprint: string;
}

interface Classification {
  category: PirateWeaponCategory;
  confidence: number;
}

interface WeaponTemplate {
  category: PirateWeaponCategory;
  sourcePath: string;
  scene: THREE.Object3D;
  longDimension: number;
  grip: THREE.Vector3;
  orientation: THREE.Quaternion;
  rotationDegrees: THREE.Vector3;
  confidence: number;
  fingerprint: string;
}

export interface WeaponTransformReport {
  category: PirateWeaponCategory;
  sourcePath: string;
  grip: readonly [number, number, number];
  rotationDegrees: readonly [number, number, number];
  firstPersonScale: number;
  thirdPersonScale: number;
}

const tempVertex = new THREE.Vector3();
const tempMatrix = new THREE.Matrix4();
const rootInverse = new THREE.Matrix4();
const parentScale = new THREE.Vector3();

function axisVector(axis: number, sign = 1): THREE.Vector3 {
  return new THREE.Vector3(axis === 0 ? sign : 0, axis === 1 ? sign : 0, axis === 2 ? sign : 0);
}

function component(values: number[], vertexIndex: number, axis: number): number {
  return values[vertexIndex * 3 + axis]!;
}

function analyzeGeometry(scene: THREE.Object3D): GeometryAnalysis | null {
  scene.updateWorldMatrix(true, true);
  rootInverse.copy(scene.matrixWorld).invert();
  const vertices: number[] = [];
  let triangleCount = 0;

  scene.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry) return;
    const positions = mesh.geometry.getAttribute('position');
    if (!positions) return;
    tempMatrix.multiplyMatrices(rootInverse, mesh.matrixWorld);
    for (let index = 0; index < positions.count; index++) {
      tempVertex.fromBufferAttribute(positions, index).applyMatrix4(tempMatrix);
      vertices.push(tempVertex.x, tempVertex.y, tempVertex.z);
    }
    triangleCount += Math.floor((mesh.geometry.index?.count ?? positions.count) / 3);
  });
  if (vertices.length === 0) return null;

  const bounds = new THREE.Box3();
  bounds.makeEmpty();
  for (let index = 0; index < vertices.length; index += 3) {
    tempVertex.set(vertices[index]!, vertices[index + 1]!, vertices[index + 2]!);
    bounds.expandByPoint(tempVertex);
  }
  const dimensions = bounds.getSize(new THREE.Vector3());
  const axes = [0, 1, 2] as Array<0 | 1 | 2>;
  axes.sort((left, right) => dimensions.getComponent(right) - dimensions.getComponent(left));
  const [longAxis, lateralAxis, thinAxis] = axes as [0 | 1 | 2, 0 | 1 | 2, 0 | 1 | 2];
  const rounded = [dimensions.x, dimensions.y, dimensions.z]
    .sort((left, right) => left - right)
    .map((value) => value.toFixed(3));
  const vertexCount = vertices.length / 3;
  return {
    vertices,
    bounds,
    dimensions,
    longAxis,
    lateralAxis,
    thinAxis,
    vertexCount,
    triangleCount,
    fingerprint: `${rounded.join(':')}:${vertexCount}:${triangleCount}`,
  };
}

/** Geometry-only categorization; source paths and authored node names are never consulted. */
function classifyGeometry(analysis: GeometryAnalysis): Classification | null {
  const length = analysis.dimensions.getComponent(analysis.longAxis);
  const lateral = analysis.dimensions.getComponent(analysis.lateralAxis);
  const thickness = analysis.dimensions.getComponent(analysis.thinAxis);
  const lateralRatio = lateral / length;
  const thicknessRatio = thickness / length;
  const crossAspect = lateral / Math.max(thickness, 1e-6);

  // Runtime combat uses vertical melee props only. Horizontal firearms and
  // other legacy meshes are intentionally rejected.
  if (analysis.longAxis !== 1) return null;

  // Thick-bodied vertical props (for example instruments) are not weapons.
  if (thicknessRatio > 0.18) return null;
  if (lateralRatio >= 0.52) {
    return { category: 'doubleAxe', confidence: Math.min(1, 0.7 + (lateralRatio - 0.52)) };
  }
  if (lateralRatio >= 0.37 && analysis.vertexCount >= 650) {
    return { category: 'axe', confidence: Math.min(1, 0.72 + (lateralRatio - 0.37)) };
  }
  if (lateralRatio >= 0.29 && crossAspect >= 2.8) {
    return { category: 'cutlass', confidence: Math.min(1, 0.72 + (crossAspect - 2.8) * 0.04) };
  }
  if (crossAspect <= 1.35) {
    return { category: 'dagger', confidence: Math.min(1, 0.82 + (1.35 - crossAspect) * 0.2) };
  }
  if (lateralRatio >= 0.15 && lateralRatio < 0.29 && crossAspect >= 1.5) {
    // Prefer a slim, flat blade. If several sword meshes are discovered, the
    // closest geometry wins deterministically rather than by filename/order.
    const confidence = 1 - Math.min(0.8, Math.abs(lateralRatio - 0.20) * 2 + Math.abs(crossAspect - 2.0) * 0.08);
    return { category: 'sword', confidence };
  }
  return null;
}

interface BandStats {
  count: number;
  means: [number, number, number];
  area: number;
  aspect: number;
}

function bandStats(analysis: GeometryAnalysis, from: number, to: number): BandStats {
  const min = analysis.bounds.min.getComponent(analysis.longAxis);
  const length = analysis.dimensions.getComponent(analysis.longAxis);
  const sums: [number, number, number] = [0, 0, 0];
  const mins: [number, number, number] = [Infinity, Infinity, Infinity];
  const maxs: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  let count = 0;
  for (let vertex = 0; vertex < analysis.vertexCount; vertex++) {
    const along = (component(analysis.vertices, vertex, analysis.longAxis) - min) / length;
    if (along < from || along > to) continue;
    count++;
    for (let axis = 0; axis < 3; axis++) {
      const value = component(analysis.vertices, vertex, axis);
      sums[axis] += value;
      mins[axis] = Math.min(mins[axis], value);
      maxs[axis] = Math.max(maxs[axis], value);
    }
  }
  const means: [number, number, number] = count > 0
    ? [sums[0] / count, sums[1] / count, sums[2] / count]
    : [0, 0, 0];
  const a = maxs[analysis.lateralAxis] - mins[analysis.lateralAxis];
  const b = maxs[analysis.thinAxis] - mins[analysis.thinAxis];
  return {
    count,
    means,
    area: Number.isFinite(a * b) ? a * b : Infinity,
    aspect: Number.isFinite(a / Math.max(b, 1e-6)) ? Math.max(a, b) / Math.max(Math.min(a, b), 1e-6) : Infinity,
  };
}

/** Find the center of the handle rather than anchoring an asymmetric head/bounds center. */
function detectGrip(analysis: GeometryAnalysis, category: PirateWeaponCategory): { grip: THREE.Vector3; direction: THREE.Vector3 } {
  const min = analysis.bounds.min.getComponent(analysis.longAxis);
  const max = analysis.bounds.max.getComponent(analysis.longAxis);
  const length = max - min;
  const low = bandStats(analysis, 0.05, 0.28);
  const high = bandStats(analysis, 0.72, 0.95);

  // Handles are rounder than blades/axe heads. This remains valid even when a
  // blade tip has less area than the handle, where an area-only heuristic fails.
  const handleAtMin = low.aspect <= high.aspect;
  const handle = handleAtMin ? low : high;
  const grip = new THREE.Vector3(handle.means[0], handle.means[1], handle.means[2]);
  grip.setComponent(analysis.longAxis, handleAtMin ? min + length * 0.12 : max - length * 0.12);
  return { grip, direction: axisVector(analysis.longAxis, handleAtMin ? 1 : -1) };
}

/** Align handle-to-tip with the authored RightHand +Y direction and face the broad side forward. */
function detectOrientation(analysis: GeometryAnalysis, direction: THREE.Vector3): THREE.Quaternion {
  const orientation = new THREE.Quaternion().setFromUnitVectors(direction, new THREE.Vector3(0, 1, 0));
  const thinNormal = axisVector(analysis.thinAxis).applyQuaternion(orientation);
  thinNormal.y = 0;
  if (thinNormal.lengthSq() > 1e-8) {
    thinNormal.normalize();
    const twistAngle = Math.atan2(-thinNormal.x, thinNormal.z);
    const twist = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), twistAngle);
    orientation.premultiply(twist);
  }
  return orientation.normalize();
}

function degrees(quaternion: THREE.Quaternion): THREE.Vector3 {
  const euler = new THREE.Euler().setFromQuaternion(quaternion, 'XYZ');
  return new THREE.Vector3(
    THREE.MathUtils.radToDeg(euler.x),
    THREE.MathUtils.radToDeg(euler.y),
    THREE.MathUtils.radToDeg(euler.z),
  );
}

/** The only permitted attachment: an exact RightHand node, never an arm/wrist fallback. */
export function findRightHandAnchor(root: THREE.Object3D): THREE.Object3D | null {
  let rightHand: THREE.Object3D | null = null;
  root.traverse((node) => {
    const normalized = String(node.userData?.name ?? node.name).toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!rightHand && normalized === 'righthand') rightHand = node;
  });
  return rightHand;
}

class WeaponModels {
  private readonly templates = new Map<PirateWeaponCategory, WeaponTemplate>();
  private readonly waiters: Array<() => void> = [];
  private loadPromise: Promise<void> | null = null;
  ready = false;

  load(): Promise<void> {
    if (this.loadPromise) return this.loadPromise;
    this.loadPromise = Promise.all(DISCOVERED_WEAPON_ASSETS.map(async (asset) => {
      try {
        const gltf = await pirateAssetCache.load(asset.url);
        gltf.scene.traverse((node) => {
          const mesh = node as THREE.Mesh;
          if (mesh.isMesh) mesh.castShadow = true;
        });
        const analysis = analyzeGeometry(gltf.scene);
        if (!analysis) return null;
        const classification = classifyGeometry(analysis);
        if (!classification) return null;
        const detected = detectGrip(analysis, classification.category);
        const orientation = detectOrientation(analysis, detected.direction);
        return {
          category: classification.category,
          sourcePath: asset.sourcePath,
          scene: gltf.scene,
          longDimension: analysis.dimensions.getComponent(analysis.longAxis),
          grip: detected.grip,
          orientation,
          rotationDegrees: degrees(orientation),
          confidence: classification.confidence,
          fingerprint: analysis.fingerprint,
        } satisfies WeaponTemplate;
      } catch (error) {
        console.error(`[bedwars] failed to preload discovered Pirate weapon ${asset.sourcePath}`, error);
        return null;
      }
    })).then((candidates) => {
      const fingerprints = new Set<string>();
      for (const candidate of candidates) {
        if (!candidate || fingerprints.has(candidate.fingerprint)) continue;
        fingerprints.add(candidate.fingerprint);
        const current = this.templates.get(candidate.category);
        if (!current || candidate.confidence > current.confidence) this.templates.set(candidate.category, candidate);
      }
      // The Large Sword intentionally uses the approved sword mesh at a larger
      // authored gameplay scale; no fallback or legacy mesh is loaded.
      const sword = this.templates.get('sword');
      if (sword) this.templates.set('largeSword', { ...sword, category: 'largeSword' });
      this.ready = true;
      const missing = PIRATE_WEAPON_CATEGORIES.filter((category) => !this.templates.has(category));
      console.info('[bedwars] automatically detected Pirate weapon categories', this.loadedWeapons());
      if (missing.length) console.warn('[bedwars] missing Pirate weapon categories', missing);
      for (const waiter of this.waiters.splice(0)) waiter();
    });
    return this.loadPromise;
  }

  onReady(callback: () => void): void {
    if (this.ready) callback();
    else this.waiters.push(callback);
  }

  loadedWeapons(): PirateWeaponCategory[] {
    return PIRATE_WEAPON_CATEGORIES.filter((category) => this.templates.has(category));
  }

  cachedRoots(): THREE.Object3D[] {
    return this.loadedWeapons().map((category) => this.templates.get(category)!.scene);
  }

  category(id: WeaponId): PirateWeaponCategory | null {
    return PIRATE_GAMEPLAY_WEAPON_MAP[id] ?? null;
  }

  visualName(id: WeaponId): PirateWeaponCategory | null {
    const category = this.category(id);
    return category && this.templates.has(category) ? category : null;
  }

  motion(id: WeaponId): WeaponMotion | null {
    const category = this.category(id);
    return category ? CATEGORY_MOTION[category] : null;
  }

  attackDuration(motion: WeaponMotion): number {
    return ATTACK_DURATION[motion];
  }

  buildFP(id: WeaponId): THREE.Object3D | null {
    const category = this.category(id);
    return category ? this.build(category, TARGET_LENGTHS[category].firstPerson, 1) : null;
  }

  buildHand(id: WeaponId, anchor: THREE.Object3D): THREE.Object3D | null {
    const category = this.category(id);
    if (!category) return null;
    anchor.updateWorldMatrix(true, false);
    anchor.getWorldScale(parentScale);
    const inheritedScale = Math.cbrt(Math.max(1e-9, Math.abs(parentScale.x * parentScale.y * parentScale.z)));
    return this.build(category, TARGET_LENGTHS[category].thirdPerson, inheritedScale);
  }

  transformReport(): WeaponTransformReport[] {
    return this.loadedWeapons().map((category) => {
      const template = this.templates.get(category)!;
      const targets = TARGET_LENGTHS[category];
      return {
        category,
        sourcePath: template.sourcePath,
        grip: [template.grip.x, template.grip.y, template.grip.z],
        rotationDegrees: [template.rotationDegrees.x, template.rotationDegrees.y, template.rotationDegrees.z],
        firstPersonScale: targets.firstPerson / template.longDimension,
        thirdPersonScale: targets.thirdPerson / template.longDimension,
      };
    });
  }

  private build(category: PirateWeaponCategory, targetLength: number, inheritedScale: number): THREE.Object3D | null {
    const template = this.templates.get(category);
    if (!template) return null;
    const scale = targetLength / (template.longDimension * Math.max(inheritedScale, 1e-6));
    const pivot = new THREE.Group();
    pivot.name = `PirateWeapon:${category}`;
    pivot.userData.weaponCategory = category;
    const model = template.scene.clone(true);
    model.scale.setScalar(scale);
    model.quaternion.copy(template.orientation);
    model.position.copy(template.grip)
      .applyQuaternion(template.orientation)
      .multiplyScalar(-scale);
    pivot.add(model);
    return pivot;
  }
}

export const weaponModels = new WeaponModels();
