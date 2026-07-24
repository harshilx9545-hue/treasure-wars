import * as THREE from 'three';
import { pirateAssetCache } from './pirateAssetCache';
import { pirateAnimationLibrary } from './animationController';
import { findRightHandAnchor, PIRATE_GAMEPLAY_WEAPON_MAP, weaponModels } from './weaponModels';

interface PerformanceWithMemory extends Performance {
  memory?: { usedJSHeapSize: number };
}

export interface PirateStartupReport {
  assetPreloadMs: number;
  cachedModels: number;
  cachedTextures: number;
  cachedMaterials: number;
  cachedAnimationClips: number;
  peakMemoryBytes: number | null;
  remainingRuntimeAssetLoads: number;
  detectedWeaponCategories: readonly string[];
  rightHandAnchors: string;
  shadersPrecompiled: boolean;
}

let preloadPromise: Promise<PirateStartupReport> | null = null;
let latestReport: PirateStartupReport | null = null;

function usedHeap(): number | null {
  return (performance as PerformanceWithMemory).memory?.usedJSHeapSize ?? null;
}

async function precompileShaders(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
): Promise<boolean> {
  const roots = [...pirateAnimationLibrary.cachedRoots(), ...weaponModels.cachedRoots()];
  const warmup = new THREE.Group();
  warmup.name = 'PirateShaderWarmup';
  warmup.position.set(0, -10_000, 0);
  for (const root of roots) warmup.add(root);
  scene.add(warmup);
  scene.updateMatrixWorld(true);

  try {
    const asynchronous = renderer as THREE.WebGLRenderer & {
      compileAsync?: (targetScene: THREE.Scene, targetCamera: THREE.Camera) => Promise<unknown>;
    };
    if (typeof asynchronous.compileAsync === 'function') {
      await asynchronous.compileAsync(scene, camera);
    } else {
      renderer.compile(scene, camera);
    }
    return true;
  } catch (error) {
    console.warn('[bedwars] asynchronous shader warm-up failed; using synchronous fallback', error);
    renderer.compile(scene, camera);
    return true;
  } finally {
    for (const root of roots) {
      warmup.remove(root);
      root.updateWorldMatrix(false, true);
    }
    scene.remove(warmup);
    warmup.clear();
  }
}

/**
 * Starts once at application boot and is awaited before either online or
 * practice play begins. Every later consumer receives the same parsed assets.
 */
export function preloadPirateAssets(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
): Promise<PirateStartupReport> {
  if (preloadPromise) return preloadPromise;
  preloadPromise = (async () => {
    const startedAt = performance.now();
    let peakMemory = usedHeap();
    const sampler = window.setInterval(() => {
      const current = usedHeap();
      if (current !== null) peakMemory = Math.max(peakMemory ?? 0, current);
    }, 25);

    let shadersPrecompiled = false;
    try {
      await Promise.all([weaponModels.load(), pirateAnimationLibrary.load()]);
      const current = usedHeap();
      if (current !== null) peakMemory = Math.max(peakMemory ?? 0, current);
      shadersPrecompiled = await precompileShaders(renderer, scene, camera);
    } finally {
      window.clearInterval(sampler);
      pirateAssetCache.finishPreload();
    }

    const cache = pirateAssetCache.stats;
    const characterRoots = pirateAnimationLibrary.cachedRoots();
    const anchors = characterRoots.filter((root) => findRightHandAnchor(root) !== null).length;
    latestReport = Object.freeze({
      assetPreloadMs: performance.now() - startedAt,
      cachedModels: cache.cachedModels,
      cachedTextures: cache.cachedTextures,
      cachedMaterials: cache.cachedMaterials,
      cachedAnimationClips: pirateAnimationLibrary.cachedClipCount,
      peakMemoryBytes: peakMemory,
      remainingRuntimeAssetLoads: cache.remainingRuntimeAssetLoads,
      detectedWeaponCategories: Object.freeze(weaponModels.loadedWeapons()),
      rightHandAnchors: `${anchors}/${characterRoots.length} exact RightHand nodes`,
      shadersPrecompiled,
    });

    const memoryLabel = latestReport.peakMemoryBytes === null
      ? 'unavailable (browser does not expose performance.memory)'
      : `${(latestReport.peakMemoryBytes / 1024 / 1024).toFixed(1)} MiB`;
    console.info('[bedwars] Pirate startup preload report', {
      'Asset preload time': `${latestReport.assetPreloadMs.toFixed(1)} ms`,
      'Number of cached models': latestReport.cachedModels,
      'Number of cached textures': latestReport.cachedTextures,
      'Number of cached materials': latestReport.cachedMaterials,
      'Number of cached animation clips': latestReport.cachedAnimationClips,
      'Peak memory usage during startup': memoryLabel,
      'Remaining runtime asset loads': latestReport.remainingRuntimeAssetLoads,
      'Number of weapon models detected': latestReport.detectedWeaponCategories.length,
      'Automatically detected weapon categories': latestReport.detectedWeaponCategories.join(', '),
      'Gameplay weapon mapping': PIRATE_GAMEPLAY_WEAPON_MAP,
      'Attachment status': latestReport.rightHandAnchors,
      'Rotation offsets and scale values': weaponModels.transformReport(),
      'First-person validation': latestReport.detectedWeaponCategories.length === 6
        ? 'ready: cached models, idle sway, breathing, walk/sprint bob, and six attack profiles'
        : 'incomplete: one or more required categories are missing',
      'Third-person validation': `${latestReport.rightHandAnchors}; one held pivot per player; immediate visual replacement`,
      'Animation validation': 'stab, quick slash, wide slash, overhead, double-heavy, and raise/fire/recover configured',
      'Shaders precompiled': latestReport.shadersPrecompiled,
    });
    return latestReport;
  })();
  return preloadPromise;
}

export function pirateStartupReport(): PirateStartupReport | null {
  return latestReport;
}
