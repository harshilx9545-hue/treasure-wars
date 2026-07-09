import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { settings } from './settings';

const SKY_TOP = new THREE.Color(0x2f6fd0);
const SKY_MID = new THREE.Color(0x7fb8e8);
const SKY_BOT = new THREE.Color(0xcfe9ff);

/** Gradient sky dome (vertex-shader driven, no texture). */
function makeSky(): THREE.Mesh {
  const geo = new THREE.SphereGeometry(300, 24, 16);
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
      top: { value: SKY_TOP },
      mid: { value: SKY_MID },
      bot: { value: SKY_BOT },
    },
    vertexShader: `
      varying vec3 vPos;
      void main() {
        vPos = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      varying vec3 vPos;
      uniform vec3 top; uniform vec3 mid; uniform vec3 bot;
      void main() {
        float h = normalize(vPos).y;
        vec3 c = h > 0.0 ? mix(mid, top, pow(h, 0.6)) : mix(mid, bot, pow(-h, 0.5));
        gl_FragColor = vec4(c, 1.0);
      }
    `,
  });
  const sky = new THREE.Mesh(geo, mat);
  sky.frustumCulled = false;
  return sky;
}

export interface Graphics {
  render(): void;
  resize(w: number, h: number): void;
  update(camPos: THREE.Vector3): void;
  applyRenderDistance(chunks: number): void;
}

/**
 * Upgrades the base scene with a gradient sky, hemispheric + sun lighting,
 * soft shadow maps, distance fog and a subtle bloom post-process pass.
 * Returns a render facade that respects the live graphics settings.
 */
export function initGraphics(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.PerspectiveCamera,
): Graphics {
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const sky = makeSky();
  scene.add(sky);
  scene.background = null; // sky dome provides the backdrop

  // Warm distance fog tuned to render distance.
  scene.fog = new THREE.Fog(0x9fc7ee, 60, 220);

  // Lighting
  const hemi = new THREE.HemisphereLight(0xdff1ff, 0x6b6152, 0.85);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xfff2d0, 1.35);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 180;
  sun.shadow.bias = -0.0006;
  sun.shadow.normalBias = 0.05;
  const cam = sun.shadow.camera as THREE.OrthographicCamera;
  cam.left = -70; cam.right = 70; cam.top = 70; cam.bottom = -70;
  cam.updateProjectionMatrix();
  scene.add(sun);
  scene.add(sun.target);

  const SUN_DIR = new THREE.Vector3(0.5, 1.0, 0.35).normalize();

  // Post-processing (subtle bloom).
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.35, 0.6, 0.85);
  composer.addPass(bloom);

  let bloomOn = true;
  let lastGQ = '';
  let lastSQ = '';
  settings.subscribe((s) => {
    // Graphics quality -> bloom strength + device pixel ratio (guarded so slider
    // drags of unrelated settings don't rebuild the framebuffer every emit).
    if (s.graphicsQuality !== lastGQ) {
      lastGQ = s.graphicsQuality;
      bloomOn = s.graphicsQuality !== 'low';
      bloom.strength = s.graphicsQuality === 'high' ? 0.35 : s.graphicsQuality === 'medium' ? 0.22 : 0;
      const pr = s.graphicsQuality === 'high' ? 2 : s.graphicsQuality === 'medium' ? 1.5 : 1;
      renderer.setPixelRatio(Math.min(devicePixelRatio, pr));
    }
    // Shadow quality -> enabled + map resolution.
    if (s.shadowQuality !== lastSQ) {
      lastSQ = s.shadowQuality;
      const shOn = s.shadowQuality !== 'off';
      renderer.shadowMap.enabled = shOn;
      sun.castShadow = shOn;
      const size = s.shadowQuality === 'high' ? 2048 : 1024;
      if (sun.shadow.mapSize.x !== size) {
        sun.shadow.mapSize.set(size, size);
        sun.shadow.map?.dispose();
        (sun.shadow as any).map = null; // force a rebuild at the new resolution
      }
    }
  });

  return {
    render(): void {
      if (bloomOn) composer.render();
      else renderer.render(scene, camera);
    },
    resize(w: number, h: number): void {
      composer.setSize(w, h);
      bloom.setSize(w, h);
    },
    update(camPos: THREE.Vector3): void {
      // Keep the sky dome centered on the player and the shadow-casting sun
      // anchored above them so shadows follow the action.
      sky.position.copy(camPos);
      sun.target.position.copy(camPos);
      sun.position.copy(camPos).addScaledVector(SUN_DIR, 90);
    },
    applyRenderDistance(chunks: number): void {
      const far = Math.max(60, chunks * 16);
      if (scene.fog instanceof THREE.Fog) {
        scene.fog.near = far * 0.45;
        scene.fog.far = far;
      }
      // Keep the far plane comfortably beyond the sky dome radius (300).
      camera.far = Math.max(340, far + 120);
      camera.updateProjectionMatrix();
    },
  };
}
