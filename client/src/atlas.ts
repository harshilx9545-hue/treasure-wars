import * as THREE from 'three';
import { BLOCKS, BlockType } from '@bedwars/shared';

const TILE = 16;

export interface Atlas {
  texture: THREE.CanvasTexture;
  tiles: number;
  tileIndex(block: number): number;
}

function hex(color: number): string {
  return `#${color.toString(16).padStart(6, '0')}`;
}

/** Shade a base color by a multiplier (0 darkens, >1 lightens, clamped). */
function shade(color: number, m: number): string {
  const r = Math.min(255, Math.max(0, ((color >> 16) & 0xff) * m)) | 0;
  const g = Math.min(255, Math.max(0, ((color >> 8) & 0xff) * m)) | 0;
  const b = Math.min(255, Math.max(0, (color & 0xff) * m)) | 0;
  return `rgb(${r},${g},${b})`;
}

/** Paint a single detailed 16x16 tile for a block, keyed off its material name. */
function paintTile(ctx: CanvasRenderingContext2D, ox: number, id: number): void {
  const def = BLOCKS[id];
  const base = def.color;
  const name = def.name;
  ctx.fillStyle = hex(base);
  ctx.fillRect(ox, 0, TILE, TILE);

  const px = (x: number, y: number, c: string) => {
    ctx.fillStyle = c;
    ctx.fillRect(ox + x, y, 1, 1);
  };

  if (name === 'grass') {
    for (let y = 0; y < TILE; y++) for (let x = 0; x < TILE; x++) {
      const n = Math.random();
      px(x, y, shade(base, 0.85 + n * 0.35));
    }
    for (let x = 0; x < TILE; x++) {
      const h = 2 + ((Math.random() * 2) | 0);
      for (let y = 0; y < h; y++) px(x, y, shade(base, 1.1 + Math.random() * 0.25));
    }
  } else if (name === 'dirt') {
    for (let y = 0; y < TILE; y++) for (let x = 0; x < TILE; x++) px(x, y, shade(base, 0.8 + Math.random() * 0.4));
  } else if (name === 'stone' || name === 'end_stone') {
    for (let y = 0; y < TILE; y++) for (let x = 0; x < TILE; x++) px(x, y, shade(base, 0.88 + Math.random() * 0.24));
    for (let k = 0; k < 5; k++) {
      const cx = (Math.random() * TILE) | 0;
      const cy = (Math.random() * TILE) | 0;
      px(cx, cy, shade(base, 0.6));
      px(cx + 1, cy, shade(base, 0.65));
    }
  } else if (name === 'plank' || name === 'wood') {
    for (let y = 0; y < TILE; y++) {
      const plank = Math.floor(y / 4);
      const bandDark = plank % 2 === 0 ? 1 : 0.92;
      for (let x = 0; x < TILE; x++) {
        const grain = 0.9 + Math.sin((x + plank * 3) * 0.9) * 0.06 + Math.random() * 0.08;
        px(x, y, shade(base, bandDark * grain));
      }
      px((plank * 7) % TILE, y, shade(base, 0.7)); // knot streak
    }
    for (let y = 3; y < TILE; y += 4) for (let x = 0; x < TILE; x++) px(x, y, shade(base, 0.72));
  } else if (name.startsWith('wool')) {
    for (let y = 0; y < TILE; y++) for (let x = 0; x < TILE; x++) {
      const weave = (x + y) % 2 === 0 ? 1.08 : 0.92;
      px(x, y, shade(base, weave * (0.95 + Math.random() * 0.1)));
    }
  } else if (name.startsWith('bed')) {
    // Pillow band on top, blanket below, wooden frame edges.
    for (let y = 0; y < TILE; y++) for (let x = 0; x < TILE; x++) {
      const isPillow = y < 5;
      const c = isPillow ? shade(0xf5f5f5, 0.9 + Math.random() * 0.15) : shade(base, 0.9 + Math.random() * 0.2);
      px(x, y, c);
    }
    for (let x = 0; x < TILE; x++) { px(x, 0, shade(0x6b4a2b, 1)); px(x, TILE - 1, shade(0x6b4a2b, 1)); }
    for (let y = 0; y < TILE; y++) { px(0, y, shade(0x6b4a2b, 1)); px(TILE - 1, y, shade(0x6b4a2b, 1)); }
  } else if (name === 'leaves') {
    for (let y = 0; y < TILE; y++) for (let x = 0; x < TILE; x++) {
      const n = Math.random();
      px(x, y, n > 0.82 ? shade(base, 0.6) : shade(base, 0.85 + n * 0.4));
    }
  } else if (name.endsWith('_block')) {
    // Gem / metal blocks: beveled frame + sparkle.
    for (let y = 0; y < TILE; y++) for (let x = 0; x < TILE; x++) px(x, y, shade(base, 0.9 + Math.random() * 0.15));
    for (let x = 0; x < TILE; x++) { px(x, 0, shade(base, 1.3)); px(x, TILE - 1, shade(base, 0.7)); }
    for (let y = 0; y < TILE; y++) { px(0, y, shade(base, 1.2)); px(TILE - 1, y, shade(base, 0.7)); }
    for (let k = 0; k < 6; k++) px((Math.random() * TILE) | 0, (Math.random() * TILE) | 0, shade(base, 1.5));
  } else {
    // bedrock + fallback
    for (let y = 0; y < TILE; y++) for (let x = 0; x < TILE; x++) px(x, y, shade(base, 0.7 + Math.random() * 0.5));
  }

  // Subtle unified edge darkening for block definition.
  ctx.strokeStyle = 'rgba(0,0,0,.22)';
  ctx.strokeRect(ox + 0.5, 0.5, TILE - 1, TILE - 1);
}

/**
 * Single procedural texture atlas for all block types: one material, one
 * texture bind for the entire world. Textures are now painted per-material
 * (grass blades, wood grain, wool weave, bed pillow, gem bevels).
 */
export function createAtlas(): Atlas {
  const ids = Object.keys(BLOCKS).map(Number).sort((a, b) => a - b);
  const canvas = document.createElement('canvas');
  canvas.width = TILE * ids.length;
  canvas.height = TILE;
  const ctx = canvas.getContext('2d')!;
  const indexOf = new Map<number, number>();

  ids.forEach((id, i) => {
    indexOf.set(id, i);
    paintTile(ctx, i * TILE, id);
  });

  const texture = new THREE.CanvasTexture(canvas);
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestMipmapNearestFilter;
  texture.generateMipmaps = true;
  texture.anisotropy = 4;
  texture.colorSpace = THREE.SRGBColorSpace;
  return { texture, tiles: ids.length, tileIndex: (b) => indexOf.get(b) ?? 0 };
}

/** Ensure BlockType import is retained for tree-shaking friendliness. */
void BlockType;
