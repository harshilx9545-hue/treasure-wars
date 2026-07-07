/** Pointer-lock FPS input: WASD + mouse look + sprint + hotbar + mouse buttons. */
export class Input {
  keys = new Set<string>();
  yaw = 0;
  pitch = 0;
  locked = false;
  onHotbar?: (slot: number) => void;
  onMouseDown?: (button: number) => void;

  constructor(canvas: HTMLElement, overlay: HTMLElement) {
    window.addEventListener('keydown', (e) => {
      this.keys.add(e.code);
      const digit = /^Digit([1-9])$/.exec(e.code);
      if (digit) this.onHotbar?.(Number(digit[1]) - 1);
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));

    overlay.addEventListener('click', () => canvas.requestPointerLock());
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === canvas;
      overlay.style.display = this.locked ? 'none' : 'flex';
    });

    document.addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      this.yaw -= e.movementX * 0.0022; // Minecraft-like sensitivity
      this.pitch = Math.max(-1.55, Math.min(1.55, this.pitch - e.movementY * 0.0022));
    });
    document.addEventListener('mousedown', (e) => {
      if (this.locked) this.onMouseDown?.(e.button);
    });
    document.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  get moveX(): number {
    return (this.keys.has('KeyD') ? 1 : 0) - (this.keys.has('KeyA') ? 1 : 0);
  }

  get moveZ(): number {
    return (this.keys.has('KeyW') ? 1 : 0) - (this.keys.has('KeyS') ? 1 : 0);
  }

  get jump(): boolean {
    return this.keys.has('Space');
  }

  get sprint(): boolean {
    return this.keys.has('ControlLeft') || this.keys.has('ShiftLeft');
  }
}
