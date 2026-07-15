import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { VoxelWorld, BlockType, BASE_Y, SEA_Y, ISLAND_RADIUS, FORT_OFFSET, FORT_HALF, MAP_CENTER, CENTER_RADIUS, TEAMS, type SpawnPoint } from '@bedwars/shared';

/**
 * FBX tree models (Tree/ at the repo root). Imported as URLs via Vite's glob so
 * each file is fetched at most once; the loader below caches one normalized
 * template per variant and every placed tree instances that shared geometry.
 */
const TREE_URLS: string[] = Object.entries(
  import.meta.glob('../../TREE/*.FBX', { eager: true, query: '?url', import: 'default' }) as Record<string, string>,
)
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([, url]) => url);

const TREE_COUNT = 55;        // same population as the previous palms
const TREE_TARGET_H = 5.2;    // normalized trunk-to-canopy height (world units)
const INSTANCE_CELL = 48;     // static-instance culling cell (three map chunks)

/**
 * Shared low-poly color atlas for the trees ("tree Textures/"). Every temp-
 * climate tree variant samples this single texture through its UVs (green
 * canopy band / brown bark band), so one MeshStandardMaterial is reused across
 * every tree — reproducing the source asset's look with minimal draw state.
 * The FBX ships no normal/roughness/metallic/AO/opacity/emissive maps, and its
 * leaves are opaque geometry (not alpha cards), so albedo-only + opaque is the
 * correct, artifact-free setup.
 */
const TREE_TEX_URL: string | undefined = Object.values(
  import.meta.glob('../../tree Textures/*.png', { eager: true, query: '?url', import: 'default' }) as Record<string, string>,
)[0];

let treeMaterial: THREE.MeshStandardMaterial | null = null;
function getTreeMaterial(): THREE.MeshStandardMaterial {
  if (treeMaterial) return treeMaterial;
  const mat = new THREE.MeshStandardMaterial({ roughness: 0.9, metalness: 0 });
  if (TREE_TEX_URL) {
    const tex = new THREE.TextureLoader().load(TREE_TEX_URL);
    tex.colorSpace = THREE.SRGBColorSpace; // albedo — keep authored colors
    // Flat two-band palette: nearest + no mipmaps keeps green/brown crisp and
    // prevents the bands bleeding into each other at the seam.
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestFilter;
    tex.generateMipmaps = false;
    mat.map = tex;
  }
  treeMaterial = mat;
  return mat;
}

/** Small seeded PRNG (mulberry32) so every client sees identical decoration. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DUMMY = new THREE.Object3D();

/**
 * Client-only pirate-fantasy dressing for the arena: animated ocean, FBX
 * trees, crates/barrels, torches, cannons, team flags, coastal ships, center
 * statues and rope bridges. Everything is instanced or reused (few draw calls)
 * and is purely visual — it never touches the voxel grid, collision or
 * networking.
 */
export class Environment {
  private oceanMat: THREE.ShaderMaterial;
  private flags: THREE.Mesh[] = [];
  private time = 0;

  constructor(scene: THREE.Scene, private world: VoxelWorld, spawns: SpawnPoint[]) {
    this.oceanMat = this.buildOcean(scene);
    this.buildTrees(scene);
    this.buildProps(scene, spawns);
    this.buildTorches(scene, spawns);
    this.buildFortDressing(scene, spawns);
    this.buildShips(scene);
    this.buildStatues(scene);
    this.buildRopeBridges(scene);
  }

  // --- Animated ocean (single plane, one draw call) ---
  private buildOcean(scene: THREE.Scene): THREE.ShaderMaterial {
    const geo = new THREE.PlaneGeometry(900, 900, 120, 120);
    geo.rotateX(-Math.PI / 2);
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      uniforms: {
        uTime: { value: 0 },
        uDeep: { value: new THREE.Color(0x0a3a63) },
        uShallow: { value: new THREE.Color(0x1f8fb8) },
        uFoam: { value: new THREE.Color(0xbfe9ff) },
      },
      vertexShader: `
        uniform float uTime; varying float vH;
        void main(){
          vec3 p = position;
          float h = sin(p.x*0.06 + uTime*1.1)*0.5 + cos(p.z*0.08 + uTime*0.9)*0.5 + sin((p.x+p.z)*0.03 + uTime*0.6)*0.4;
          p.y += h; vH = h;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(p,1.0);
        }`,
      fragmentShader: `
        uniform vec3 uDeep; uniform vec3 uShallow; uniform vec3 uFoam; varying float vH;
        void main(){
          float t = clamp(vH*0.5+0.5,0.0,1.0);
          vec3 c = mix(uDeep, uShallow, t);
          c = mix(c, uFoam, smoothstep(0.85,1.0,t)*0.6);
          gl_FragColor = vec4(c, 0.9);
        }`,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(MAP_CENTER, SEA_Y, MAP_CENTER);
    mesh.renderOrder = -1;
    scene.add(mesh);
    return mat;
  }

  private onGrass(x: number, z: number): boolean {
    return this.world.get(x, BASE_Y, z) === BlockType.Grass && this.world.get(x, BASE_Y + 1, z) === BlockType.Air;
  }

  /**
   * Split static instances into compact spatial cells. One giant instance
   * range has a world-sized bounding sphere and therefore cannot be frustum
   * culled; cells keep batching while letting Three.js reject unseen islands.
   */
  private buildInstanced(scene: THREE.Scene, geo: THREE.BufferGeometry, mat: THREE.Material, transforms: THREE.Matrix4[], receiveShadow = false): void {
    if (transforms.length === 0) return;
    const cells = new Map<string, THREE.Matrix4[]>();
    for (const matrix of transforms) {
      const e = matrix.elements;
      const key = `${Math.floor(e[12] / INSTANCE_CELL)},${Math.floor(e[14] / INSTANCE_CELL)}`;
      let cell = cells.get(key);
      if (!cell) { cell = []; cells.set(key, cell); }
      cell.push(matrix);
    }
    for (const transformsInCell of cells.values()) {
      const inst = new THREE.InstancedMesh(geo, mat, transformsInCell.length);
      inst.castShadow = true;
      inst.receiveShadow = receiveShadow;
      inst.instanceMatrix.setUsage(THREE.StaticDrawUsage);
      for (let i = 0; i < transformsInCell.length; i++) inst.setMatrixAt(i, transformsInCell[i]!);
      inst.instanceMatrix.needsUpdate = true;
      inst.computeBoundingSphere();
      inst.frustumCulled = true;
      scene.add(inst);
    }
  }

  // --- Trees (FBX models, instanced) scattered on open grass ---
  // Each unique FBX is loaded once, normalized to a natural height, and every
  // placement instances the shared geometry so the whole forest stays cheap.
  private buildTrees(scene: THREE.Scene): void {
    const rng = mulberry32(1337);
    // Placement is computed synchronously (world is ready); models stream in.
    const spots: Array<{ x: number; z: number; yaw: number; scale: number; variant: number }> = [];
    let tries = 0;
    while (spots.length < TREE_COUNT && tries < 4000) {
      tries++;
      const a = rng() * Math.PI * 2;
      const r = CENTER_RADIUS + 6 + rng() * (ISLAND_RADIUS - CENTER_RADIUS - 10);
      const x = Math.round(MAP_CENTER + Math.cos(a) * r);
      const z = Math.round(MAP_CENTER + Math.sin(a) * r);
      if (!this.onGrass(x, z)) continue;
      // Avoid crowding fort courtyards.
      let nearFort = false;
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        if (Math.hypot(x - (MAP_CENTER + dx * FORT_OFFSET), z - (MAP_CENTER + dz * FORT_OFFSET)) < FORT_HALF + 3) nearFort = true;
      }
      if (nearFort) continue;
      const scale = 0.85 + rng() * 0.4; // natural size variation
      const yaw = rng() * Math.PI * 2;
      const variant = TREE_URLS.length > 0 ? Math.floor(rng() * TREE_URLS.length) : 0;
      spots.push({ x: x + 0.5, z: z + 0.5, yaw, scale, variant });
    }
    if (spots.length === 0 || TREE_URLS.length === 0) return;

    // Which variants are actually used, so we only fetch those models.
    const used = [...new Set(spots.map((s) => s.variant))];
    const loader = new FBXLoader();
    for (const variant of used) {
      const url = TREE_URLS[variant];
      const placements = spots.filter((s) => s.variant === variant);
      loader.load(
        url,
        (obj) => this.buildTreeVariant(scene, obj, placements),
        undefined,
        (err) => console.error('[bedwars] failed to load tree', url, err),
      );
    }
  }

  /** Normalize one loaded FBX tree and instance it across its placements. */
  private buildTreeVariant(
    scene: THREE.Scene,
    obj: THREE.Object3D,
    placements: Array<{ x: number; z: number; yaw: number; scale: number }>,
  ): void {
    obj.updateWorldMatrix(true, true);
    // Normalize: uniform scale to a target height, base sitting at y=0, centered
    // on the trunk. Baked into cloned geometry so instances carry only world TRS.
    const box = new THREE.Box3().setFromObject(obj);
    const size = new THREE.Vector3();
    box.getSize(size);
    const norm = TREE_TARGET_H / (size.y || 1);
    const cx = (box.min.x + box.max.x) / 2;
    const cz = (box.min.z + box.max.z) / 2;
    const bake = new THREE.Matrix4()
      .makeScale(norm, norm, norm)
      .premultiply(new THREE.Matrix4().makeTranslation(-cx * norm, -box.min.y * norm, -cz * norm));

    const geos: THREE.BufferGeometry[] = [];
    obj.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!(mesh as any).isMesh || !mesh.geometry) return;
      const geo = mesh.geometry.clone();
      geo.applyMatrix4(mesh.matrixWorld); // world-space, then normalize
      geo.applyMatrix4(bake);             // clone/applyMatrix4 preserves UVs
      geos.push(geo);
    });
    if (geos.length === 0) return;

    // All variants sample the same shared color atlas through their UVs.
    const mat = getTreeMaterial();
    for (const geo of geos) {
      const transforms: THREE.Matrix4[] = [];
      for (let i = 0; i < placements.length; i++) {
        const p = placements[i];
        DUMMY.position.set(p.x, BASE_Y + 1, p.z);
        DUMMY.rotation.set(0, p.yaw, 0);
        DUMMY.scale.setScalar(p.scale);
        DUMMY.updateMatrix();
        transforms.push(DUMMY.matrix.clone());
      }
      this.buildInstanced(scene, geo, mat, transforms, true);
    }
  }

  // --- Crates + barrels near forts, docks and center ---
  private buildProps(scene: THREE.Scene, spawns: SpawnPoint[]): void {
    const rng = mulberry32(90210);
    const crates: THREE.Matrix4[] = [];
    const barrels: THREE.Matrix4[] = [];
    const anchors: Array<[number, number]> = [[MAP_CENTER, MAP_CENTER]];
    for (const s of spawns) anchors.push([Math.round(s.x), Math.round(s.z)], [Math.round(s.gx), Math.round(s.gz)]);
    for (const [ax, az] of anchors) {
      const n = 8 + Math.floor(rng() * 6);
      for (let i = 0; i < n; i++) {
        const x = ax + Math.round((rng() - 0.5) * 22);
        const z = az + Math.round((rng() - 0.5) * 22);
        const top = this.world.get(x, BASE_Y, z);
        if (top === BlockType.Air || this.world.get(x, BASE_Y + 1, z) !== BlockType.Air) continue;
        DUMMY.rotation.set(0, rng() * 6.28, 0);
        DUMMY.scale.set(1, 1, 1);
        if (rng() > 0.5) {
          DUMMY.position.set(x + 0.5, BASE_Y + 1.4, z + 0.5);
          DUMMY.updateMatrix();
          barrels.push(DUMMY.matrix.clone());
        } else {
          DUMMY.position.set(x + 0.5, BASE_Y + 1.4, z + 0.5);
          DUMMY.updateMatrix();
          crates.push(DUMMY.matrix.clone());
        }
      }
    }
    this.buildInstanced(scene, new THREE.BoxGeometry(0.8, 0.8, 0.8), new THREE.MeshStandardMaterial({ color: 0x9c6b34, roughness: 0.85 }), crates);
    this.buildInstanced(scene, new THREE.CylinderGeometry(0.38, 0.34, 0.9, 10), new THREE.MeshStandardMaterial({ color: 0x7a4a24, roughness: 0.8 }), barrels);
  }

  // --- Torches (post + glowing flame) along roads & fort walls ---
  private buildTorches(scene: THREE.Scene, spawns: SpawnPoint[]): void {
    const posts: THREE.Matrix4[] = [];
    const flames: THREE.Matrix4[] = [];
    const add = (x: number, z: number) => {
      if (this.world.get(x, BASE_Y, z) === BlockType.Air || this.world.get(x, BASE_Y + 1, z) !== BlockType.Air) return;
      DUMMY.rotation.set(0, 0, 0); DUMMY.scale.set(1, 1, 1);
      DUMMY.position.set(x + 0.5, BASE_Y + 1.5, z + 0.5); DUMMY.updateMatrix(); posts.push(DUMMY.matrix.clone());
      DUMMY.position.set(x + 0.5, BASE_Y + 2.15, z + 0.5); DUMMY.updateMatrix(); flames.push(DUMMY.matrix.clone());
    };
    // Along each road.
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const px = -dz, pz = dx;
      for (let i = CENTER_RADIUS + 2; i <= FORT_OFFSET - FORT_HALF; i += 6) {
        add(MAP_CENTER + dx * i + px * 2, MAP_CENTER + dz * i + pz * 2);
        add(MAP_CENTER + dx * i - px * 2, MAP_CENTER + dz * i - pz * 2);
      }
    }
    // Around each fort spawn.
    for (const s of spawns) {
      for (const [ox, oz] of [[-6, -6], [6, -6], [-6, 6], [6, 6]] as const) add(Math.round(s.x) + ox, Math.round(s.z) + oz);
    }
    this.buildInstanced(scene, new THREE.CylinderGeometry(0.08, 0.08, 1, 5), new THREE.MeshStandardMaterial({ color: 0x5a3a1c }), posts);
    // Emissive flame — bloom makes it glow (no per-torch light needed).
    this.buildInstanced(scene, new THREE.IcosahedronGeometry(0.22, 0), new THREE.MeshStandardMaterial({ color: 0xff8a1e, emissive: 0xff5a00, emissiveIntensity: 2.2 }), flames);
  }

  // --- Cannons on wall tops + waving team flags on watchtowers ---
  private buildFortDressing(scene: THREE.Scene, spawns: SpawnPoint[]): void {
    const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const;
    const bases: THREE.Matrix4[] = [];
    const barrelsGeoT: THREE.Matrix4[] = [];
    spawns.forEach((s, t) => {
      const [dx, dz] = dirs[t];
      const px = -dz, pz = dx;
      const fx = MAP_CENTER + dx * FORT_OFFSET, fz = MAP_CENTER + dz * FORT_OFFSET;
      const color = TEAMS[t].color;
      // Cannons: front wall (facing center) + two on the flanks, on the battlements.
      const cannonSpots: Array<[number, number, number, number]> = [
        [fx - dx * FORT_HALF, fz - dz * FORT_HALF, -dx, -dz],
        [fx + px * FORT_HALF, fz + pz * FORT_HALF, px, pz],
        [fx - px * FORT_HALF, fz - pz * FORT_HALF, -px, -pz],
      ];
      for (const [cx, cz, ax, az] of cannonSpots) {
        const yaw = Math.atan2(ax, az);
        DUMMY.position.set(cx + 0.5, BASE_Y + 5.3, cz + 0.5); DUMMY.rotation.set(0, yaw, 0); DUMMY.scale.set(1, 1, 1);
        DUMMY.updateMatrix(); bases.push(DUMMY.matrix.clone());
        DUMMY.position.set(cx + 0.5 + ax * 0.35, BASE_Y + 5.55, cz + 0.5 + az * 0.35); DUMMY.rotation.set(Math.PI / 2 - 0.25, yaw, 0);
        DUMMY.updateMatrix(); barrelsGeoT.push(DUMMY.matrix.clone());
      }
      // Team flags on the back watchtowers.
      for (const [sx, sz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]] as const) {
        if (sx * dx + sz * dz <= 0) continue; // back corners only
        const tx = fx + sx * (FORT_HALF - 1);
        const tz = fz + sz * (FORT_HALF - 1);
        const flag = new THREE.Mesh(
          new THREE.PlaneGeometry(1.4, 0.9, 6, 1),
          new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.2, side: THREE.DoubleSide, roughness: 0.7 }),
        );
        flag.position.set(tx + 0.7, BASE_Y + 1 + 9 + 2.5, tz + 0.5);
        scene.add(flag);
        this.flags.push(flag);
      }
    });
    this.buildInstanced(scene, new THREE.BoxGeometry(0.7, 0.4, 1.0), new THREE.MeshStandardMaterial({ color: 0x3a2c1a }), bases);
    this.buildInstanced(scene, new THREE.CylinderGeometry(0.16, 0.18, 1.0, 10), new THREE.MeshStandardMaterial({ color: 0x2b2b30, metalness: 0.6, roughness: 0.4 }), barrelsGeoT);
  }

  // --- Decorative galleons anchored around the coast ---
  private buildShips(scene: THREE.Scene): void {
    const rng = mulberry32(7);
    const hull = new THREE.MeshStandardMaterial({ color: 0x5a3a1c, roughness: 0.85 });
    const sailMat = new THREE.MeshStandardMaterial({ color: 0xe8dcc0, roughness: 0.9, side: THREE.DoubleSide });
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 + 0.4;
      const r = ISLAND_RADIUS + 14 + rng() * 8;
      const x = MAP_CENTER + Math.cos(a) * r;
      const z = MAP_CENTER + Math.sin(a) * r;
      const g = new THREE.Group();
      const body = new THREE.Mesh(new THREE.BoxGeometry(7, 2.2, 2.6), hull); body.position.y = 0.4;
      const bow = new THREE.Mesh(new THREE.BoxGeometry(2, 1.6, 2.2), hull); bow.position.set(4, 0.6, 0);
      const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.15, 6, 6), hull); mast.position.set(0, 3.4, 0);
      const sail = new THREE.Mesh(new THREE.PlaneGeometry(3.4, 3.6), sailMat); sail.position.set(0, 3.8, 0); sail.rotation.y = Math.PI / 2;
      g.add(body, bow, mast, sail);
      g.position.set(x, SEA_Y + 0.5, z);
      g.rotation.y = -a + Math.PI / 2;
      scene.add(g);
    }
  }

  // --- Pirate statues on the center pedestals ---
  private buildStatues(scene: THREE.Scene): void {
    const stone = new THREE.MeshStandardMaterial({ color: 0x8a8f98, roughness: 0.9 });
    const gold = new THREE.MeshStandardMaterial({ color: 0xf5c542, metalness: 0.6, roughness: 0.4, emissive: 0x3a2c00, emissiveIntensity: 0.25 });
    for (const [ox, oz] of [[13, 13], [-13, -13]] as const) {
      const g = new THREE.Group();
      const legs = new THREE.Mesh(new THREE.BoxGeometry(0.7, 1.0, 0.5), stone); legs.position.y = 0.5;
      const torso = new THREE.Mesh(new THREE.BoxGeometry(0.9, 1.0, 0.55), stone); torso.position.y = 1.5;
      const head = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, 0.5), stone); head.position.y = 2.3;
      const sword = new THREE.Mesh(new THREE.BoxGeometry(0.08, 1.4, 0.08), gold); sword.position.set(0.6, 1.9, 0); sword.rotation.z = -0.5;
      g.add(legs, torso, head, sword);
      g.position.set(MAP_CENTER + ox + 0.5, BASE_Y + 3, MAP_CENTER + oz + 0.5);
      g.castShadow = true;
      scene.add(g);
    }
  }

  // --- Decorative rope bridges spanning between adjacent fort docks ---
  private buildRopeBridges(scene: THREE.Scene): void {
    const plankMat = new THREE.MeshStandardMaterial({ color: 0x6b4a2b, roughness: 0.9 });
    const ropeMat = new THREE.MeshStandardMaterial({ color: 0x3a2c1a });
    const dirs = [[1, 0], [0, 1], [-1, 0], [0, -1]] as const; // walk around adjacent pairs
    for (let i = 0; i < dirs.length; i++) {
      const a = dirs[i];
      const b = dirs[(i + 1) % dirs.length];
      const ax = MAP_CENTER + a[0] * (FORT_OFFSET + 16), az = MAP_CENTER + a[1] * (FORT_OFFSET + 16);
      const bx = MAP_CENTER + b[0] * (FORT_OFFSET + 16), bz = MAP_CENTER + b[1] * (FORT_OFFSET + 16);
      const g = new THREE.Group();
      const len = Math.hypot(bx - ax, bz - az);
      const yaw = Math.atan2(bz - az, bx - ax);
      const deck = new THREE.Mesh(new THREE.BoxGeometry(len, 0.12, 1.2), plankMat);
      const rope1 = new THREE.Mesh(new THREE.BoxGeometry(len, 0.05, 0.05), ropeMat); rope1.position.set(0, 0.55, 0.55);
      const rope2 = new THREE.Mesh(new THREE.BoxGeometry(len, 0.05, 0.05), ropeMat); rope2.position.set(0, 0.55, -0.55);
      g.add(deck, rope1, rope2);
      g.position.set((ax + bx) / 2, BASE_Y - 0.5, (az + bz) / 2);
      g.rotation.y = yaw;
      scene.add(g);
    }
  }

  update(dt: number): void {
    this.time += dt;
    this.oceanMat.uniforms.uTime.value = this.time;
    // Gentle flag wave.
    const w = Math.sin(this.time * 3) * 0.15;
    for (const f of this.flags) f.rotation.z = w;
  }
}
