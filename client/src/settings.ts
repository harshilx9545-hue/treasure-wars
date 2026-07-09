/** Persisted user settings with a tiny pub/sub so any system can react live. */
export type GraphicsQuality = 'low' | 'medium' | 'high';
export type ShadowQuality = 'off' | 'low' | 'high';
export type BindAction = 'forward' | 'back' | 'left' | 'right' | 'jump' | 'sprint' | 'shop';

/** Default keyboard bindings (identical to the previous hardcoded scheme). */
export const DEFAULT_BINDINGS: Record<BindAction, string> = {
  forward: 'KeyW', back: 'KeyS', left: 'KeyA', right: 'KeyD',
  jump: 'Space', sprint: 'ShiftLeft', shop: 'KeyE',
};

export const BIND_LABELS: Record<BindAction, string> = {
  forward: 'Move Forward', back: 'Move Back', left: 'Strafe Left', right: 'Strafe Right',
  jump: 'Jump', sprint: 'Sprint', shop: 'Open Shop',
};

export interface Settings {
  playerName: string;
  sensitivity: number; // 0.2 .. 3
  fov: number; // 60 .. 110
  masterVolume: number; // 0 .. 1
  musicVolume: number; // 0 .. 1
  sfxVolume: number; // 0 .. 1
  renderDistance: number; // chunks: 4 .. 16
  fullscreen: boolean;
  crosshairStyle: 'cross' | 'dot' | 'tee';
  crosshairColor: string;
  crosshairSize: number; // px
  graphicsQuality: GraphicsQuality;
  shadowQuality: ShadowQuality;
  uiScale: number; // 0.8 .. 1.4
  keyBindings: Record<string, string>; // BindAction -> KeyboardEvent.code
  // Legacy (derived from quality now; kept so old code/state doesn't break).
  bloom: boolean;
  shadows: boolean;
}

const DEFAULTS: Settings = {
  playerName: '',
  sensitivity: 1,
  fov: 75,
  masterVolume: 1,
  musicVolume: 0.4,
  sfxVolume: 0.9,
  renderDistance: 12,
  fullscreen: false,
  crosshairStyle: 'cross',
  crosshairColor: '#ffffff',
  crosshairSize: 22,
  graphicsQuality: 'high',
  shadowQuality: 'high',
  uiScale: 1,
  keyBindings: { ...DEFAULT_BINDINGS },
  bloom: true,
  shadows: true,
};

const KEY = 'bedwars:settings';

type Listener = (s: Settings) => void;

class SettingsStore {
  private data: Settings;
  private listeners = new Set<Listener>();

  constructor() {
    let loaded: Partial<Settings> = {};
    try {
      loaded = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    } catch {
      loaded = {};
    }
    this.data = { ...DEFAULTS, ...loaded };
    // Merge any missing key bindings so upgrades don't lose actions.
    this.data.keyBindings = { ...DEFAULT_BINDINGS, ...(this.data.keyBindings ?? {}) };
  }

  get(): Settings {
    return this.data;
  }

  set<K extends keyof Settings>(key: K, value: Settings[K]): void {
    this.data[key] = value;
    this.persist();
    this.emit();
  }

  /** Rebind a single action key. */
  bind(action: BindAction, code: string): void {
    this.data.keyBindings = { ...this.data.keyBindings, [action]: code };
    this.persist();
    this.emit();
  }

  binding(action: BindAction): string {
    return this.data.keyBindings[action] ?? DEFAULT_BINDINGS[action];
  }

  patch(partial: Partial<Settings>): void {
    Object.assign(this.data, partial);
    this.persist();
    this.emit();
  }

  reset(): void {
    this.data = { ...DEFAULTS, keyBindings: { ...DEFAULT_BINDINGS } };
    this.persist();
    this.emit();
  }

  resetBindings(): void {
    this.data.keyBindings = { ...DEFAULT_BINDINGS };
    this.persist();
    this.emit();
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    fn(this.data);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const fn of this.listeners) fn(this.data);
  }

  private persist(): void {
    try {
      localStorage.setItem(KEY, JSON.stringify(this.data));
    } catch {
      /* ignore quota errors */
    }
  }
}

export const settings = new SettingsStore();
