import { settings, type Settings, type BindAction, BIND_LABELS } from './settings';
import { audio } from './audio';
import { ALL_POWERUPS } from '@bedwars/shared';

type View = 'start' | 'pause' | 'settings' | 'keys';

const BIND_ORDER: BindAction[] = ['forward', 'back', 'left', 'right', 'jump', 'sprint', 'shop'];

/** Pretty-print a KeyboardEvent.code for the bindings UI. */
function keyLabel(code: string): string {
  if (!code) return '—';
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Arrow')) return code.slice(5);
  return code.replace('Left', ' L').replace('Right', ' R');
}

/**
 * Pirate-styled menu system: click-to-play splash, pause menu, settings panel
 * and key-binding editor. All controls are wired live to the persisted store.
 */
export class Menu {
  private root = document.createElement('div');
  private card = document.createElement('div');
  started = false;
  onResume?: () => void;
  onUnstuck?: () => void;
  onCloseSettings?: () => void;
  onExitMatch?: () => void;

  private capturing: BindAction | null = null;
  private captureHandler?: (e: KeyboardEvent) => void;

  constructor() {
    this.root.id = 'menu';
    this.card.className = 'menu-card'; // wooden popup shell for splash / pause / settings
    this.root.appendChild(this.card);
    document.body.appendChild(this.root);
    this.hide();
  }

  get visible(): boolean {
    return this.root.style.display !== 'none';
  }

  private btn(label: string, onClick: () => void, cls = ''): HTMLButtonElement {
    const b = document.createElement('button');
    b.className = `pirate-btn ${cls}`;
    b.innerHTML = `<span class="pb-label">${label}</span>`;
    b.addEventListener('click', () => { audio.play('click'); onClick(); });
    return b;
  }

  showStart(): void {
    this.setView('start');
    this.card.innerHTML = '';
    const title = document.createElement('div');
    title.className = 'pirate-title';
    title.innerHTML = '<span>TREASURE WARS</span>';
    const sub = document.createElement('div');
    sub.className = 'pirate-sub';
    sub.textContent = 'WASD move · Shift sprint · Space jump · LMB attack/mine · RMB place · 1-9 items · E shop';
    const play = this.btn('CLICK TO PLAY', () => this.onResume?.(), 'primary');
    const settingsBtn = this.btn('Settings', () => this.showSettings());
    this.card.append(title, sub, play, settingsBtn);
  }

  showReady(): void {
    this.setView('start');
    this.card.innerHTML = '';
    const title = document.createElement('div');
    title.className = 'pirate-title';
    title.innerHTML = '<span>MATCH READY</span>';
    const sub = document.createElement('div');
    sub.className = 'pirate-sub';
    sub.textContent = 'Click to lock your mouse and set sail · WASD move · LMB attack/mine · RMB place/use · E shop';
    const play = this.btn('CLICK TO PLAY', () => this.onResume?.(), 'primary');
    const settingsBtn = this.btn('Settings', () => this.showSettings());
    this.card.append(title, sub, play, settingsBtn);
  }

  showPause(): void {
    this.setView('pause');
    this.card.innerHTML = '';
    const title = document.createElement('div');
    title.className = 'pirate-title small';
    title.innerHTML = '<span>PAUSED</span>';
    const resume = this.btn('Resume', () => this.onResume?.(), 'primary');
    const unstuck = this.btn('Refresh (Unstuck)', () => { this.onUnstuck?.(); this.onResume?.(); });
    const settingsBtn = this.btn('Settings', () => this.showSettings());
    const fs = this.btn(document.fullscreenElement ? 'Exit Fullscreen' : 'Fullscreen', () => { this.toggleFullscreen(); this.showPause(); });
    // Leave the match entirely — pirate-themed red/gold button at the bottom.
    const exit = this.btn('EXIT MATCH', () => this.confirmExitMatch(), 'danger exit-match');
    this.card.append(title, resume, unstuck, settingsBtn, fs, exit);
  }

  /** Confirmation popup before abandoning the match. */
  private confirmExitMatch(): void {
    const scrim = document.createElement('div');
    scrim.className = 'pirate-popup-scrim';
    const pop = document.createElement('div');
    pop.className = 'pirate-popup';
    pop.innerHTML = '<div class="pp-title">EXIT MATCH?</div>'
      + '<div class="pp-body">Are you sure you want to leave this match?</div>';
    const btns = document.createElement('div');
    btns.className = 'pp-btns';
    const yes = this.btn('YES', () => { scrim.remove(); this.onExitMatch?.(); }, 'danger compact');
    const no = this.btn('NO', () => { scrim.remove(); }, 'primary compact');
    btns.append(yes, no);
    pop.append(btns);
    scrim.append(pop);
    // Click outside the popup = cancel (same as NO).
    scrim.addEventListener('mousedown', (e) => { if (e.target === scrim) scrim.remove(); });
    this.root.append(scrim);
  }

  private toggleFullscreen(): void {
    if (document.fullscreenElement) {
      void document.exitFullscreen();
      settings.set('fullscreen', false);
    } else {
      void document.documentElement.requestFullscreen().catch(() => {});
      settings.set('fullscreen', true);
    }
  }

  private slider(label: string, min: number, max: number, step: number, get: (s: Settings) => number, set: (v: number) => void, fmt: (v: number) => string): HTMLElement {
    const row = document.createElement('div');
    row.className = 'mc-row';
    const lab = document.createElement('label');
    const val = document.createElement('span');
    val.className = 'mc-val';
    const input = document.createElement('input');
    input.type = 'range';
    input.min = String(min); input.max = String(max); input.step = String(step);
    const cur = get(settings.get());
    input.value = String(cur);
    lab.textContent = label;
    val.textContent = fmt(cur);
    input.addEventListener('input', () => { const v = Number(input.value); set(v); val.textContent = fmt(v); });
    const head = document.createElement('div');
    head.className = 'mc-row-head';
    head.append(lab, val);
    row.append(head, input);
    return row;
  }

  private select(label: string, options: [string, string][], value: string, onChange: (v: string) => void): HTMLElement {
    const row = document.createElement('div');
    row.className = 'mc-row';
    const lab = document.createElement('label');
    lab.textContent = label;
    const sel = document.createElement('select');
    sel.className = 'mc-select';
    for (const [v, t] of options) {
      const o = document.createElement('option');
      o.value = v; o.textContent = t;
      if (v === value) o.selected = true;
      sel.appendChild(o);
    }
    sel.addEventListener('change', () => { audio.play('click'); onChange(sel.value); });
    const head = document.createElement('div');
    head.className = 'mc-row-head';
    head.append(lab);
    row.append(head, sel);
    return row;
  }

  private toggle(label: string, value: boolean, onChange: (v: boolean) => void): HTMLElement {
    const row = document.createElement('div');
    row.className = 'mc-row';
    const b = document.createElement('button');
    b.className = `mc-toggle ${value ? 'on' : ''}`;
    b.textContent = `${label}: ${value ? 'ON' : 'OFF'}`;
    b.addEventListener('click', () => {
      audio.play('click');
      const nv = !b.classList.contains('on');
      b.classList.toggle('on', nv);
      b.textContent = `${label}: ${nv ? 'ON' : 'OFF'}`;
      onChange(nv);
    });
    row.append(b);
    return row;
  }

  showSettings(): void {
    this.stopCapture();
    this.setView('settings');
    this.card.innerHTML = '';
    const title = document.createElement('div');
    title.className = 'pirate-title small';
    title.innerHTML = '<span>SETTINGS</span>';

    const scroll = document.createElement('div');
    scroll.className = 'mc-scroll';
    scroll.append(
      this.select('Graphics Quality', [['low', 'Low'], ['medium', 'Medium'], ['high', 'High']], settings.get().graphicsQuality, (v) => settings.set('graphicsQuality', v as Settings['graphicsQuality'])),
      this.select('Shadow Quality', [['off', 'Off'], ['low', 'Low'], ['high', 'High']], settings.get().shadowQuality, (v) => settings.set('shadowQuality', v as Settings['shadowQuality'])),
      this.slider('Music Volume', 0, 1, 0.01, (s) => s.musicVolume, (v) => settings.set('musicVolume', v), (v) => `${Math.round(v * 100)}%`),
      this.slider('SFX Volume', 0, 1, 0.01, (s) => s.sfxVolume, (v) => settings.set('sfxVolume', v), (v) => `${Math.round(v * 100)}%`),
      this.slider('Mouse Sensitivity', 0.2, 3, 0.05, (s) => s.sensitivity, (v) => settings.set('sensitivity', v), (v) => `${Math.round(v * 100)}%`),
      this.slider('Field of View', 60, 110, 1, (s) => s.fov, (v) => settings.set('fov', v), (v) => `${Math.round(v)}`),
      this.slider('Crosshair Size', 10, 40, 1, (s) => s.crosshairSize, (v) => settings.set('crosshairSize', v), (v) => `${Math.round(v)}px`),
      this.select('Crosshair Style', [['cross', 'Cross'], ['dot', 'Dot'], ['tee', 'T-Shape']], settings.get().crosshairStyle, (v) => settings.set('crosshairStyle', v as Settings['crosshairStyle'])),
      this.crosshairColorRow(),
      this.slider('UI Scale', 0.8, 1.4, 0.05, (s) => s.uiScale, (v) => settings.set('uiScale', v), (v) => `${Math.round(v * 100)}%`),
      this.toggle('Fullscreen', !!document.fullscreenElement, () => this.toggleFullscreen()),
    );

    const keysBtn = this.btn('Key Bindings', () => this.showKeyBindings());
    const back = this.btn('Back', () => {
      if (this.started) this.showPause();
      else if (this.onCloseSettings) this.onCloseSettings();
      else this.hide();
    });
    const reset = this.btn('Reset Defaults', () => { settings.reset(); this.showSettings(); });
    const rowBtns = document.createElement('div');
    rowBtns.className = 'mc-btnrow';
    rowBtns.append(back, reset);

    this.card.append(title, scroll, keysBtn, rowBtns);
  }

  private showKeyBindings(): void {
    this.setView('keys');
    this.card.innerHTML = '';
    const title = document.createElement('div');
    title.className = 'pirate-title small';
    title.innerHTML = '<span>KEY BINDINGS</span>';

    const list = document.createElement('div');
    list.className = 'mc-scroll';
    for (const action of BIND_ORDER) {
      const row = document.createElement('div');
      row.className = 'kb-row';
      const lab = document.createElement('span');
      lab.textContent = BIND_LABELS[action];
      const key = document.createElement('button');
      key.className = 'kb-key';
      const paint = () => { key.textContent = this.capturing === action ? 'Press a key…' : keyLabel(settings.binding(action)); key.classList.toggle('capturing', this.capturing === action); };
      key.addEventListener('click', () => { audio.play('click'); this.startCapture(action, paint); });
      paint();
      row.append(lab, key);
      list.append(row);
    }

    const hint = document.createElement('div');
    hint.className = 'mc-hint';
    hint.textContent = 'Power-ups: ' + ALL_POWERUPS.map((p) => `${p.name} [${p.key.replace('Key', '')}]`).join('  ·  ');

    const back = this.btn('Back', () => this.showSettings());
    const reset = this.btn('Reset Bindings', () => { settings.resetBindings(); this.showKeyBindings(); });
    const rowBtns = document.createElement('div');
    rowBtns.className = 'mc-btnrow';
    rowBtns.append(back, reset);

    this.card.append(title, list, hint, rowBtns);
  }

  private startCapture(action: BindAction, repaint: () => void): void {
    this.stopCapture();
    this.capturing = action;
    repaint();
    this.captureHandler = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.code !== 'Escape') settings.bind(action, e.code);
      this.stopCapture();
      this.showKeyBindings(); // rebuild to reflect the new binding
    };
    window.addEventListener('keydown', this.captureHandler, { capture: true, once: true });
  }

  private stopCapture(): void {
    if (this.captureHandler) { window.removeEventListener('keydown', this.captureHandler, { capture: true } as any); this.captureHandler = undefined; }
    this.capturing = null;
  }

  private crosshairColorRow(): HTMLElement {
    const row = document.createElement('div');
    row.className = 'mc-row';
    const head = document.createElement('div');
    head.className = 'mc-row-head';
    const lab = document.createElement('label');
    lab.textContent = 'Crosshair Color';
    const input = document.createElement('input');
    input.type = 'color';
    input.className = 'mc-color';
    input.value = settings.get().crosshairColor;
    input.addEventListener('input', () => settings.set('crosshairColor', input.value));
    head.append(lab, input);
    row.append(head);
    return row;
  }

  hide(): void {
    this.stopCapture();
    this.root.style.display = 'none';
  }

  private setView(v: View): void {
    this.root.style.display = 'flex';
    this.root.dataset.view = v;
  }
}
