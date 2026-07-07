import * as THREE from 'three';
import { BLOCKS } from '@bedwars/shared';

const TILE = 16;

export interface Atlas {
  texture: THREE.CanvasTexture;
  tiles: number;
  tileIndex(block: number): number;
}

/**
 * Single procedural texture atlas for all block types: one material, one
 * texture bind for the entire world. Real art can replace the canvas later
 * without touching the mesher.
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
    ctx.fillStyle = `#${BLOCKS[id].color.toString(16).padStart(6, '0')}`;
    ctx.fillRect(i * TILE, 0, TILE, TILE);
    for (let n = 0; n < 24; n++) {
      const px = i * TILE + ((Math.random() * TILE) | 0);
      const py = (Math.random() * TILE) | 0;
      ctx.fillStyle = Math.random() > 0.5 ? 'rgba(255,255,255,.06)' : 'rgba(0,0,0,.08)';
      ctx.fillRect(px, py, 1, 1);
    }
    ctx.strokeStyle = 'rgba(0,0,0,.25)';
    ctx.strokeRect(i * TILE + 0.5, 0.5, TILE - 1, TILE - 1);
  });

  const texture = new THREE.CanvasTexture(canvas);
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.colorSpace = THREE.SRGBColorSpace;
  return { texture, tiles: ids.length, tileIndex: (b) => indexOf.get(b) ?? 0 };
}
