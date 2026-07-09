import { settings } from './settings';

export interface ScoreboardRow {
  name: string;
  color: string; // css color
  treasureAlive: boolean;
  alive: number; // players currently alive
  kills: number; // team total kills
  you: boolean;
}

export interface PowerUpView {
  name: string;
  color: string;
  activeFrac: number; // 0..1 remaining duration
  cooldownFrac: number; // 0..1 remaining cooldown (0 = ready)
  active: boolean;
}

/** Lightweight DOM HUD (no framework; cheap to update, easy to restyle). */
export class HUD {
  private fpsEl = document.getElementById('stat-fps')!;
  private pingEl = document.getElementById('stat-ping')!;
  private cpsEl = document.getElementById('stat-cps')!;
  private hearts = document.getElementById('hearts')!;
  private board = document.getElementById('scoreboard')!;
  private feed = document.getElementById('killfeed')!;
  private status = document.getElementById('status')!;
  private powerbar = document.getElementById('powerbar')!;
  private crosshair = document.getElementById('crosshair')!;
  private vignette = document.getElementById('vignette')!;
  private hitmark = document.getElementById('hitmarker')!;
  private coinsEl = document.getElementById('coins')!;
  private noticeEl = document.getElementById('notice')!;
  private shopHintEl = document.getElementById('shopHint')!;
  private timerEl = document.getElementById('timer')!;
  private killEl = document.getElementById('killcount')!;
  private lastHearts = -1;
  private lastCoins = -1;
  private lastTimer = -1;
  private hitTimer = 0;

  // Cached leaderboard rows (built once, updated in place — no per-frame rebuild).
  private boardCells: Array<{ row: HTMLElement; dot: HTMLElement; name: HTMLElement; alive: HTMLElement; kills: HTMLElement; treasure: HTMLElement }> = [];
  private boardSig: string[] = [];
  // Cached kill counter.
  private killBuilt = false;
  private killK!: HTMLElement; private killD!: HTMLElement; private killA!: HTMLElement;
  private kkv = -1; private kdv = -1; private kav = -1;
  // Cached power-up cells.
  private puCells: Array<{ el: HTMLElement; fill: HTMLElement; sig: string }> = [];

  constructor() {
    settings.subscribe((s) => {
      this.applyCrosshair(s.crosshairStyle, s.crosshairColor, s.crosshairSize);
      document.documentElement.style.setProperty('--ui-scale', String(s.uiScale ?? 1));
    });
  }

  private applyCrosshair(style: string, color: string, size: number): void {
    this.crosshair.className = `ch-${style}`;
    this.crosshair.style.setProperty('--ch-color', color);
    this.crosshair.style.setProperty('--ch-size', `${size}px`);
  }

  setStats(fps: number, ping: number | null, cps: number): void {
    this.fpsEl.textContent = `${fps}`;
    this.fpsEl.style.color = fps >= 50 ? '#7CFC7C' : fps >= 30 ? '#ffd23f' : '#ff6b6b';
    this.pingEl.textContent = ping === null ? '\u2014' : `${ping}ms`;
    if (ping !== null) this.pingEl.style.color = ping < 60 ? '#7CFC7C' : ping < 140 ? '#ffd23f' : '#ff6b6b';
    this.cpsEl.textContent = `${cps}`;
  }

  setHearts(hp: number): void {
    const clamped = Math.max(0, Math.min(20, hp));
    if (clamped === this.lastHearts) return;
    const damaged = this.lastHearts >= 0 && clamped < this.lastHearts;
    this.lastHearts = clamped;
    const full = Math.floor(clamped / 2);
    const half = clamped % 2 === 1;
    let html = '';
    for (let i = 0; i < 10; i++) {
      let cls = 'heart empty';
      if (i < full) cls = 'heart full';
      else if (i === full && half) cls = 'heart half';
      html += `<span class="${cls}">\u2665</span>`;
    }
    this.hearts.innerHTML = html;
    if (damaged) {
      this.hearts.classList.remove('shake');
      void this.hearts.offsetWidth; // reflow to restart animation
      this.hearts.classList.add('shake');
    }
  }

  /** Match timer at top-center (mm:ss). Pass -1 to hide. */
  setTimer(ms: number): void {
    if (ms < 0) { this.timerEl.style.display = 'none'; return; }
    this.timerEl.style.display = 'block';
    const total = Math.max(0, Math.ceil(ms / 1000));
    if (total === this.lastTimer) return;
    this.lastTimer = total;
    const m = Math.floor(total / 60);
    const s = total % 60;
    this.timerEl.textContent = `${m}:${s.toString().padStart(2, '0')}`;
    this.timerEl.classList.toggle('low', total <= 30);
    this.timerEl.classList.remove('tick');
    void this.timerEl.offsetWidth;
    this.timerEl.classList.add('tick');
  }

  private buildKills(): void {
    this.killEl.innerHTML = '';
    this.killK = document.createElement('span'); this.killK.className = 'kc-k';
    this.killD = document.createElement('span'); this.killD.className = 'kc-d';
    this.killA = document.createElement('span'); this.killA.className = 'kc-a'; this.killA.style.display = 'none';
    this.killEl.append(this.killK, this.killD, this.killA);
    this.killBuilt = true;
  }

  /** Local player's kill / death tally (updated in place, only when it changes). */
  setKills(kills: number, deaths: number, assists: number): void {
    if (!this.killBuilt) this.buildKills();
    if (kills !== this.kkv) {
      this.killK.textContent = `\u2694 ${kills}`;
      if (this.kkv >= 0 && kills > this.kkv) { this.killEl.classList.remove('pop'); void this.killEl.offsetWidth; this.killEl.classList.add('pop'); }
      this.kkv = kills;
    }
    if (deaths !== this.kdv) { this.killD.textContent = `\u2620 ${deaths}`; this.kdv = deaths; }
    if (assists !== this.kav) { this.killA.textContent = assists > 0 ? `+${assists}` : ''; this.killA.style.display = assists > 0 ? '' : 'none'; this.kav = assists; }
  }

  /** Build the leaderboard skeleton once; values are updated in place afterwards. */
  private buildBoard(n: number): void {
    this.board.innerHTML = '';
    const title = document.createElement('div');
    title.className = 'sb-title';
    title.textContent = 'TREASURE WARS';
    const head = document.createElement('div');
    head.className = 'sb-head';
    head.innerHTML = `<span>TEAM</span><span class="sb-cols"><span title="Players alive">\u25C9</span><span title="Kills">\u2694</span><span title="Treasure">\u2666</span></span>`;
    this.board.append(title, head);
    this.boardCells = [];
    this.boardSig = [];
    for (let i = 0; i < n; i++) {
      const row = document.createElement('div');
      row.className = 'sb-row';
      const team = document.createElement('span');
      team.className = 'sb-team';
      const dot = document.createElement('span');
      dot.className = 'sb-dot';
      const name = document.createElement('span');
      team.append(dot, name);
      const cols = document.createElement('span');
      cols.className = 'sb-cols';
      const alive = document.createElement('span');
      alive.className = 'sb-alive';
      const kills = document.createElement('span');
      kills.className = 'sb-kills';
      const treasure = document.createElement('span');
      treasure.className = 'sb-treasure';
      cols.append(alive, kills, treasure);
      row.append(team, cols);
      this.board.append(row);
      this.boardCells.push({ row, dot, name, alive, kills, treasure });
      this.boardSig.push('');
    }
  }

  /**
   * Update the leaderboard in place. The DOM is created once; each row only
   * touches the DOM when its values actually change (no per-frame rebuild, no
   * animation restart, no flicker).
   */
  setScoreboard(rows: ScoreboardRow[]): void {
    if (this.boardCells.length !== rows.length) this.buildBoard(rows.length);
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const sig = `${r.color}|${r.name}|${r.you ? 1 : 0}|${r.alive}|${r.kills}|${r.treasureAlive ? 1 : 0}`;
      if (this.boardSig[i] === sig) continue; // nothing changed for this row
      this.boardSig[i] = sig;
      const c = this.boardCells[i];
      if (c.dot.style.background !== r.color) c.dot.style.background = r.color;
      const nm = r.name + (r.you ? ' (you)' : '');
      if (c.name.textContent !== nm) c.name.textContent = nm;
      const av = String(r.alive);
      if (c.alive.textContent !== av) c.alive.textContent = av;
      const kl = String(r.kills);
      if (c.kills.textContent !== kl) c.kills.textContent = kl;
      const tch = r.treasureAlive ? '\u2666' : '\u2717';
      if (c.treasure.textContent !== tch) c.treasure.textContent = tch;
      const tcls = `sb-treasure ${r.treasureAlive ? 'ok' : 'gone'}`;
      if (c.treasure.className !== tcls) {
        c.treasure.className = tcls;
        c.treasure.title = `Respawns: ${r.treasureAlive ? '\u221E' : '0'}`;
      }
      c.row.classList.toggle('me', r.you);
    }
  }

  private buildPowerups(views: PowerUpView[]): void {
    this.powerbar.innerHTML = '';
    this.puCells = [];
    for (const v of views) {
      const el = document.createElement('div');
      el.className = 'pu';
      el.style.setProperty('--pu', v.color);
      const fill = document.createElement('div');
      fill.className = 'pu-fill';
      const name = document.createElement('div');
      name.className = 'pu-name';
      name.textContent = v.name;
      el.append(fill, name);
      this.powerbar.append(el);
      this.puCells.push({ el, fill, sig: '' });
    }
  }

  /** Update power-up cells in place; only writes when a cell's state changes. */
  setPowerups(views: PowerUpView[]): void {
    if (this.puCells.length !== views.length) this.buildPowerups(views);
    for (let i = 0; i < views.length; i++) {
      const v = views[i];
      const state = v.active ? 'active' : v.cooldownFrac > 0 ? 'cooldown' : 'ready';
      const frac = v.active ? v.activeFrac : v.cooldownFrac > 0 ? v.cooldownFrac : 0;
      const h = Math.round(frac * 100);
      const sig = `${state}|${h}`;
      const c = this.puCells[i];
      if (c.sig === sig) continue;
      c.sig = sig;
      const cls = `pu ${state}`;
      if (c.el.className !== cls) c.el.className = cls;
      c.fill.style.height = `${h}%`;
    }
  }

  addFeed(text: string): void {
    const div = document.createElement('div');
    div.className = 'feed';
    div.textContent = text;
    this.feed.prepend(div);
    while (this.feed.children.length > 6) this.feed.lastChild?.remove();
    setTimeout(() => div.classList.add('fade'), 5500);
    setTimeout(() => div.remove(), 7000);
  }

  setStatus(text: string, big = false): void {
    const show = !!text;
    this.status.style.display = show ? 'block' : 'none';
    this.status.classList.toggle('huge', big);
    if (this.status.textContent !== text) this.status.textContent = text;
  }

  setShopHint(show: boolean): void {
    this.shopHintEl.style.display = show ? 'block' : 'none';
  }

  setCoins(n: number): void {
    if (n === this.lastCoins) return;
    const gained = this.lastCoins >= 0 && n > this.lastCoins;
    this.lastCoins = n;
    this.coinsEl.innerHTML = `<span class="coin-icon">\u25C9</span> ${n}`;
    if (gained) {
      this.coinsEl.classList.remove('pop');
      void this.coinsEl.offsetWidth;
      this.coinsEl.classList.add('pop');
    }
  }

  /** Transient toast for purchase results / alerts. */
  showNotice(text: string, ok: boolean): void {
    const div = document.createElement('div');
    div.className = `notice ${ok ? 'ok' : 'bad'}`;
    div.textContent = text;
    this.noticeEl.prepend(div);
    while (this.noticeEl.children.length > 4) this.noticeEl.lastChild?.remove();
    setTimeout(() => div.classList.add('fade'), 1800);
    setTimeout(() => div.remove(), 2400);
  }

  /** Red screen flash when the local player takes damage. */
  flashDamage(): void {
    this.vignette.classList.remove('flash');
    void this.vignette.offsetWidth;
    this.vignette.classList.add('flash');
  }

  /** Brief hit marker when the local player lands a hit. */
  showHitMarker(crit: boolean): void {
    this.hitmark.classList.toggle('crit', crit);
    this.hitmark.classList.remove('show');
    void this.hitmark.offsetWidth;
    this.hitmark.classList.add('show');
    this.hitTimer = 0.25;
  }

  update(dt: number): void {
    if (this.hitTimer > 0) {
      this.hitTimer -= dt;
      if (this.hitTimer <= 0) this.hitmark.classList.remove('show');
    }
  }
}
