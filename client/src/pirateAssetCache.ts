import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';

const GLB_MAGIC = 0x46546c67;
const JSON_CHUNK = 0x4e4f534a;
const BIN_CHUNK = 0x004e4942;

const TEXTURE_PROPERTIES = [
  'map', 'alphaMap', 'aoMap', 'bumpMap', 'displacementMap', 'emissiveMap',
  'envMap', 'lightMap', 'metalnessMap', 'normalMap', 'roughnessMap',
  'clearcoatMap', 'clearcoatNormalMap', 'clearcoatRoughnessMap',
  'iridescenceMap', 'iridescenceThicknessMap', 'sheenColorMap',
  'sheenRoughnessMap', 'specularColorMap', 'specularIntensityMap',
  'thicknessMap', 'transmissionMap', 'gradientMap', 'matcap',
] as const;

interface GlbChunk {
  type: number;
  bytes: Uint8Array;
}

export interface PirateAssetCacheStats {
  cachedModels: number;
  cachedTextures: number;
  cachedMaterials: number;
  sharedEmbeddedImages: number;
  parsedGlbs: number;
  remainingRuntimeAssetLoads: number;
}

function nextTask(): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, 0));
}

function colorKey(value: unknown): string {
  return value instanceof THREE.Color ? value.getHexString() : '';
}

/**
 * One cache for every Pirate GLB consumer. Fetches may overlap, but parsing is
 * deliberately serialized with a task yield between models so several image
 * decodes and scene builds cannot land in one frame.
 */
class PirateAssetCache {
  private readonly modelPromises = new Map<string, Promise<GLTF>>();
  private readonly textures = new Map<string, THREE.Texture>();
  private readonly materials = new Map<string, THREE.Material>();
  private readonly embeddedImages = new Map<string, string>();
  private readonly imageObjectIds = new WeakMap<object, number>();
  private parseTail: Promise<void> = Promise.resolve();
  private nextImageObjectId = 1;
  private parsedGlbs = 0;
  private runtimeAssetLoads = 0;
  private preloadComplete = false;

  constructor() {
    // ImageBitmapLoader/FileLoader honor THREE.Cache. Combined with stable blob
    // URLs below, identical embedded atlases are fetched and decoded only once.
    THREE.Cache.enabled = true;
  }

  load(url: string): Promise<GLTF> {
    const cached = this.modelPromises.get(url);
    if (cached) return cached;
    if (this.preloadComplete) this.runtimeAssetLoads++;

    const promise = fetch(url)
      .then((response) => {
        if (!response.ok) throw new Error(`Failed to fetch Pirate asset ${url}: ${response.status}`);
        return response.arrayBuffer();
      })
      .then((buffer) => this.enqueueParse(() => this.parse(buffer, url)));
    this.modelPromises.set(url, promise);
    return promise;
  }

  /** Release source clips after the animation library has built shared, filtered clips. */
  releaseSourceAnimationClips(): void {
    for (const promise of this.modelPromises.values()) {
      void promise.then((gltf) => { gltf.animations.length = 0; });
    }
  }

  /** Mark the pre-entry preload boundary and release temporary Blob URLs. */
  finishPreload(): void {
    this.preloadComplete = true;
    for (const url of this.embeddedImages.values()) URL.revokeObjectURL(url);
    this.embeddedImages.clear();
  }

  get stats(): PirateAssetCacheStats {
    return {
      cachedModels: this.modelPromises.size,
      cachedTextures: this.textures.size,
      cachedMaterials: this.materials.size,
      sharedEmbeddedImages: this.nextImageObjectId - 1,
      parsedGlbs: this.parsedGlbs,
      remainingRuntimeAssetLoads: this.runtimeAssetLoads,
    };
  }

  private enqueueParse<T>(work: () => Promise<T>): Promise<T> {
    const result = this.parseTail.then(work, work);
    this.parseTail = result.then(() => undefined, () => undefined);
    return result;
  }

  private async parse(source: ArrayBuffer, url: string): Promise<GLTF> {
    await nextTask();
    const redirected = await this.redirectEmbeddedImages(source);
    const loader = new GLTFLoader();
    const basePath = url.slice(0, Math.max(0, url.lastIndexOf('/') + 1));
    const gltf = await new Promise<GLTF>((resolve, reject) => {
      loader.parse(redirected, basePath, resolve, reject);
    });
    this.canonicalizeResources(gltf.scene);
    // Parsing is complete and every dependency is resolved. The parser holds
    // raw buffers and dependency maps that are not needed by cached scenes.
    (gltf as unknown as { parser?: unknown }).parser = undefined;
    this.parsedGlbs++;
    return gltf;
  }

  /**
   * Replace embedded image bufferViews with content-addressed Blob URLs before
   * GLTFLoader sees them. Equal image bytes therefore resolve to one decoded
   * ImageBitmap even when the source pack embeds the atlas in many GLBs.
   */
  private async redirectEmbeddedImages(source: ArrayBuffer): Promise<ArrayBuffer> {
    if (source.byteLength < 20) return source;
    const input = new DataView(source);
    if (input.getUint32(0, true) !== GLB_MAGIC || input.getUint32(4, true) !== 2) return source;

    const chunks: GlbChunk[] = [];
    let offset = 12;
    while (offset + 8 <= source.byteLength) {
      const length = input.getUint32(offset, true);
      const type = input.getUint32(offset + 4, true);
      const start = offset + 8;
      const end = start + length;
      if (end > source.byteLength) throw new Error('Invalid Pirate GLB chunk length');
      chunks.push({ type, bytes: new Uint8Array(source, start, length) });
      offset = end;
    }

    const jsonChunk = chunks.find((chunk) => chunk.type === JSON_CHUNK);
    const binaryChunk = chunks.find((chunk) => chunk.type === BIN_CHUNK);
    if (!jsonChunk || !binaryChunk) return source;

    const jsonText = new TextDecoder().decode(jsonChunk.bytes).replace(/[\u0000 ]+$/g, '');
    const document = JSON.parse(jsonText) as {
      images?: Array<{ bufferView?: number; mimeType?: string; uri?: string }>;
      bufferViews?: Array<{ buffer?: number; byteOffset?: number; byteLength: number }>;
    };
    let changed = false;
    for (const image of document.images ?? []) {
      if (image.bufferView === undefined) continue;
      const view = document.bufferViews?.[image.bufferView];
      if (!view || (view.buffer ?? 0) !== 0) continue;
      const start = view.byteOffset ?? 0;
      const bytes = binaryChunk.bytes.subarray(start, start + view.byteLength);
      const key = await this.hash(bytes);
      let sharedUrl = this.embeddedImages.get(key);
      if (!sharedUrl) {
        const copy = bytes.slice();
        sharedUrl = URL.createObjectURL(new Blob([copy.buffer as ArrayBuffer], {
          type: image.mimeType ?? 'application/octet-stream',
        }));
        this.embeddedImages.set(key, sharedUrl);
      }
      image.uri = sharedUrl;
      delete image.bufferView;
      delete image.mimeType;
      changed = true;
    }
    if (!changed) return source;

    const encoded = new TextEncoder().encode(JSON.stringify(document));
    const jsonLength = (encoded.byteLength + 3) & ~3;
    const rebuiltChunks = chunks.map((chunk) => chunk.type === JSON_CHUNK
      ? { type: chunk.type, bytes: this.padJson(encoded, jsonLength) }
      : chunk);
    const totalLength = 12 + rebuiltChunks.reduce((sum, chunk) => sum + 8 + chunk.bytes.byteLength, 0);
    const output = new ArrayBuffer(totalLength);
    const outputView = new DataView(output);
    outputView.setUint32(0, GLB_MAGIC, true);
    outputView.setUint32(4, 2, true);
    outputView.setUint32(8, totalLength, true);
    let writeOffset = 12;
    for (const chunk of rebuiltChunks) {
      outputView.setUint32(writeOffset, chunk.bytes.byteLength, true);
      outputView.setUint32(writeOffset + 4, chunk.type, true);
      new Uint8Array(output, writeOffset + 8, chunk.bytes.byteLength).set(chunk.bytes);
      writeOffset += 8 + chunk.bytes.byteLength;
    }
    return output;
  }

  private padJson(encoded: Uint8Array, length: number): Uint8Array {
    const output = new Uint8Array(length);
    output.fill(0x20);
    output.set(encoded);
    return output;
  }

  private async hash(bytes: Uint8Array): Promise<string> {
    if (globalThis.crypto?.subtle) {
      const copy = bytes.slice();
      const digest = await globalThis.crypto.subtle.digest('SHA-256', copy.buffer as ArrayBuffer);
      return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('');
    }
    let hash = 2166136261;
    for (let i = 0; i < bytes.length; i++) {
      hash ^= bytes[i]!;
      hash = Math.imul(hash, 16777619);
    }
    return `${bytes.length}:${hash >>> 0}`;
  }

  private canonicalizeResources(root: THREE.Object3D): void {
    root.traverse((node) => {
      const mesh = node as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.material = Array.isArray(mesh.material)
        ? mesh.material.map((material) => this.canonicalMaterial(material))
        : this.canonicalMaterial(mesh.material);
    });
  }

  private canonicalMaterial(material: THREE.Material): THREE.Material {
    const record = material as THREE.Material & Record<string, unknown>;
    let textureChanged = false;
    for (const property of TEXTURE_PROPERTIES) {
      const texture = record[property];
      if (!(texture instanceof THREE.Texture)) continue;
      const canonical = this.canonicalTexture(texture);
      if (canonical !== texture) {
        record[property] = canonical;
        textureChanged = true;
      }
    }
    if (textureChanged) material.needsUpdate = true;

    const key = this.materialKey(material);
    const cached = this.materials.get(key);
    if (cached) {
      material.dispose();
      return cached;
    }
    this.materials.set(key, material);
    return material;
  }

  private canonicalTexture(texture: THREE.Texture): THREE.Texture {
    const data = texture.source?.data as unknown;
    let sourceId: string;
    if ((typeof data === 'object' && data !== null) || typeof data === 'function') {
      const object = data as object;
      let id = this.imageObjectIds.get(object);
      if (id === undefined) {
        id = this.nextImageObjectId++;
        this.imageObjectIds.set(object, id);
      }
      sourceId = String(id);
    } else {
      sourceId = String(data);
    }
    const key = [
      sourceId, texture.mapping, texture.channel, texture.wrapS, texture.wrapT,
      texture.magFilter, texture.minFilter, texture.anisotropy, texture.flipY,
      texture.generateMipmaps, texture.colorSpace,
    ].join('|');
    const cached = this.textures.get(key);
    if (cached) {
      texture.dispose();
      return cached;
    }
    this.textures.set(key, texture);
    return texture;
  }

  private materialKey(material: THREE.Material): string {
    const value = material as THREE.Material & Record<string, any>;
    return JSON.stringify([
      material.type,
      value.transparent, value.opacity, value.alphaTest, value.side,
      value.depthTest, value.depthWrite, value.blending, value.blendSrc, value.blendDst,
      value.vertexColors, value.flatShading, value.wireframe,
      colorKey(value.color), colorKey(value.emissive), value.emissiveIntensity,
      value.roughness, value.metalness, value.shininess,
      value.normalScale?.x, value.normalScale?.y,
      ...TEXTURE_PROPERTIES.map((property) => value[property]?.uuid ?? ''),
    ]);
  }
}

export const pirateAssetCache = new PirateAssetCache();
