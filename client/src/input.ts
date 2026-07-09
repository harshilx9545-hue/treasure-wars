import { settings } from './settings';
import { ALL_POWERUPS } from '@bedwars/shared';

/** Pointer-lock FPS input: WASD + mouse look + sprint + hotbar + mouse buttons + power-ups. */
export class Input {
  keys = new Set<string>();
  yaw = 0;
  pitch = 0;
  locked = false;
  mouseLeft = false;
  mouseRight = false;

  onHotbar?: (slot: number) => void;
  onMouseDown?: (button: number) => void;
  onMouseUp?: (button: number) => void;
  onLockChange?: (locked: boolean) => void;
  onPowerUp?: (type: number) => void;
  onOpenShop?: () => void;

  private canvas: HTMLElement;

  constructor(canvas: HTMLElement) {
    this.canvas = canvas;

    window.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      this.keys.add(e.code);
      const digit = /^Digit([1-9])$/.exec(e.code);
      if (digit) this.onHotbar?.(Number(digit[1]) - 1);
      const pu = ALL_POWERUPS.find((p) => p.key === e.code);
      if (pu && this.locked) this.onPowerUp?.(pu.id);
      // Shop toggle must work regardless of pointer-lock state so it can both
      // open (while locked) and close (while unlocked / cursor showing).
      if (e.code === settings.binding('shop')) this.onOpenShop?.();
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));

    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === canvas;
      if (!this.locked) {
        this.mouseLeft = false;
        this.mouseRight = false;
      }
      this.onLockChange?.(this.locked);
    });

    document.addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      const s = 0.0022 * settings.get().sensitivity;
      this.yaw -= e.movementX * s;
      this.pitch = Math.max(-1.55, Math.min(1.55, this.pitch - e.movementY * s));
    });
    document.addEventListener('mousedown', (e) => {
      if (!this.locked) return;
      if (e.button === 0) this.mouseLeft = true;
      if (e.button === 2) this.mouseRight = true;
      this.onMouseDown?.(e.button);
    });
    document.addEventListener('mouseup', (e) => {
      if (e.button === 0) this.mouseLeft = false;
      if (e.button === 2) this.mouseRight = false;
      this.onMouseUp?.(e.button);
    });
    document.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  requestLock(): void {
    this.canvas.requestPointerLock();
  }

  get moveX(): number {
    return (this.keys.has(settings.binding('right')) ? 1 : 0) - (this.keys.has(settings.binding('left')) ? 1 : 0);
  }

  get moveZ(): number {
    return (this.keys.has(settings.binding('forward')) ? 1 : 0) - (this.keys.has(settings.binding('back')) ? 1 : 0);
  }

  get jump(): boolean {
    return this.keys.has(settings.binding('jump'));
  }

  get sprint(): boolean {
    return this.keys.has(settings.binding('sprint')) || this.keys.has('ControlLeft');
  }
}
