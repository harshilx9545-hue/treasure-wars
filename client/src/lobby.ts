import type { Room } from 'colyseus.js';
import { Msg, TEAMS, ECONOMY } from '@bedwars/shared';
import { settings } from './settings';
import { audio } from './audio';
import { hostRoom, joinRoomById, quickJoin, listRooms } from './net';

export interface LobbyDeps {
  onRoomConnected: (room: Room) => void;
  onMatchStart: (room: Room) => void;
  onOffline: () => void;
  openSettings: () => void;
}

function randomName(): string {
  return 'Pirate' + Math.floor(100 + Math.random() * 900);
}
function currentName(): string {
  let n = settings.get().playerName.trim();
  if (!n) { n = randomName(); settings.set('playerName', n); }
  return n.slice(0, 16);
}
function getGold(): number { return Number(localStorage.getItem('tw:gold') ?? 0) || 0; }

const TEAM_LABEL: Record<number, string> = { 1: '1v1v1v1', 2: '2 per Team', 4: '4 per Team' };

/**
 * Cinematic pirate main menu built on the existing Colyseus matchmaking.
 * A persistent animated CSS scene (sky, ocean, clouds, ships, birds, dust) sits
 * behind a wooden panel that swaps between screens: Main -> Play (Quick / Host /
 * Find / Practice) / Leaderboard / How to Play. Purely presentational.
 */
export class Lobby {
  private root = document.createElement('div');
  private scene = document.createElement('div');
  private logo = document.createElement('div');
  private profile = document.createElement('div');
  private card = document.createElement('div');
  private room: Room | null = null;
  private entered = false;
  private noticeText = '';
  private selDuration = 10;
  private selTeamSize = 2;

  constructor(private deps: LobbyDeps) {
    this.root.id = 'lobby';
    this.buildScene();
    this.buildLogo();
    this.buildProfile();
    this.root.append(this.scene, this.logo, this.profile, this.card);
    document.body.appendChild(this.root);
    this.showMain();
  }

  get visible(): boolean { return this.root.style.display !== 'none'; }
  hide(): void { this.root.style.display = 'none'; }
  private show(): void { this.root.style.display = 'flex'; }

  resurface(): void {
    this.entered = false;
    if (this.room) this.renderLobby();
    else this.showMain();
  }

  notice(text: string): void {
    this.noticeText = text;
    const el = this.card.querySelector('.lb-notice');
    if (el) el.textContent = text;
  }

  // --- Cinematic animated background (pure CSS/DOM, no game map) ---
  private buildScene(): void {
    this.scene.className = 'mm-scene';
    this.scene.innerHTML =
      `<div class="mm-sky"></div><div class="mm-sun"></div>` +
      `<div class="mm-sea"><div class="mm-shimmer"></div></div>` +
      `<div class="mm-fort"></div>`;
    const clouds = document.createElement('div'); clouds.className = 'mm-clouds';
    for (let i = 0; i < 6; i++) {
      const c = document.createElement('div'); c.className = 'mm-cloud';
      c.style.top = `${4 + i * 9}%`;
      c.style.setProperty('--dur', `${48 + i * 14}s`);
      c.style.setProperty('--delay', `${-i * 11}s`);
      c.style.setProperty('--scale', `${0.6 + (i % 3) * 0.4}`);
      clouds.appendChild(c);
    }
    const ships = document.createElement('div'); ships.className = 'mm-ships';
    for (let i = 0; i < 2; i++) {
      const s = document.createElement('div'); s.className = 'mm-ship'; s.textContent = '\u26F5';
      s.style.setProperty('--dur', `${60 + i * 26}s`);
      s.style.setProperty('--delay', `${-i * 30}s`);
      s.style.bottom = `${16 + i * 6}%`;
      s.style.setProperty('--sz', `${2.4 - i * 0.7}`);
      ships.appendChild(s);
    }
    const birds = document.createElement('div'); birds.className = 'mm-birds';
    for (let i = 0; i < 5; i++) {
      const b = document.createElement('div'); b.className = 'mm-bird';
      b.style.top = `${18 + (i % 4) * 6}%`;
      b.style.setProperty('--dur', `${26 + i * 6}s`);
      b.style.setProperty('--delay', `${-i * 5}s`);
      birds.appendChild(b);
    }
    const dust = document.createElement('div'); dust.className = 'mm-dust';
    for (let i = 0; i < 24; i++) {
      const m = document.createElement('i');
      m.style.left = `${(i * 4.1) % 100}%`;
      m.style.setProperty('--dur', `${10 + (i % 7) * 3}s`);
      m.style.setProperty('--delay', `${-i * 1.3}s`);
      m.style.setProperty('--x', `${(i % 5 - 2) * 20}px`);
      dust.appendChild(m);
    }
    this.scene.append(clouds, ships, birds, dust);
  }

  private buildLogo(): void {
    this.logo.className = 'mm-logo';
    this.logo.innerHTML = `<div class="mm-logo-main">TREASURE WARS</div><div class="mm-logo-sub">\u2620 Pirate Adventure \u2620</div>`;
  }

  private buildProfile(): void {
    this.profile.className = 'mm-profile';
    this.refreshProfile();
  }

  private refreshProfile(): void {
    const name = currentName();
    const gold = getGold();
    const level = Math.max(1, 1 + Math.floor(gold / 500));
    this.profile.innerHTML =
      `<div class="pf-avatar">${name.charAt(0).toUpperCase()}<span class="pf-badge">Lv ${level}</span></div>` +
      `<div class="pf-info">` +
      `<div class="pf-name" title="Click to rename">${name} <span class="pf-edit">\u270E</span></div>` +
      `<div class="pf-gold"><span class="coin-icon">\u{1FA99}</span> ${gold.toLocaleString()} Gold</div>` +
      `</div>`;
    const nameEl = this.profile.querySelector('.pf-name') as HTMLElement;
    nameEl?.addEventListener('click', () => this.editName());
  }

  private editName(): void {
    const nameEl = this.profile.querySelector('.pf-name') as HTMLElement;
    if (!nameEl) return;
    const input = document.createElement('input');
    input.className = 'pf-name-input'; input.maxLength = 16; input.value = currentName();
    const commit = () => {
      settings.set('playerName', input.value.trim() || randomName());
      this.refreshProfile();
    };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') input.blur(); });
    input.addEventListener('blur', commit);
    nameEl.replaceWith(input);
    input.focus(); input.select();
  }

  // --- Reusable widgets ---
  private pbtn(icon: string, label: string, onClick: () => void, variant = ''): HTMLButtonElement {
    const b = document.createElement('button');
    b.className = `pirate-btn ${variant}`;
    b.innerHTML = `<span class="pb-icon">${icon}</span><span class="pb-label">${label}</span>`;
    b.addEventListener('click', () => { audio.resume(); audio.play('click'); onClick(); });
    return b;
  }
  private pill(label: string, active: boolean, onClick: () => void): HTMLButtonElement {
    const b = document.createElement('button');
    b.className = `pirate-pill${active ? ' active' : ''}`;
    b.textContent = label;
    b.addEventListener('click', () => { audio.play('click'); onClick(); });
    return b;
  }
  private title(text: string, small = false): HTMLElement {
    const t = document.createElement('div');
    t.className = 'pirate-title' + (small ? ' small' : '');
    t.innerHTML = `<span>${text}</span>`;
    return t;
  }
  private field(labelText: string): HTMLElement {
    const row = document.createElement('div');
    row.className = 'pirate-field';
    const lab = document.createElement('label'); lab.textContent = labelText;
    row.append(lab);
    return row;
  }
  private noticeBar(): HTMLElement {
    const n = document.createElement('div');
    n.className = 'lb-notice';
    n.textContent = this.noticeText;
    return n;
  }
  private setCard(view: string): HTMLElement {
    this.show();
    this.card.className = `pirate-panel view-${view}`;
    this.card.innerHTML = '';
    return this.card;
  }

  // --- Screens ---

  showMain(): void {
    this.refreshProfile();
    const c = this.setCard('main');
    c.append(
      this.pbtn('\u25B6', 'Play', () => this.showPlay(), 'primary'),
      this.pbtn('\u2699', 'Settings', () => this.deps.openSettings()),
      this.pbtn('\u{1F3C6}', 'Leaderboard', () => this.showLeaderboard()),
      this.pbtn('\u2753', 'How to Play', () => this.showHowTo()),
      this.pbtn('\u{1F6AA}', 'Exit', () => this.showExit(), 'danger'),
      this.noticeBar(),
    );
    const code = new URLSearchParams(location.search).get('room');
    if (code) { this.showFind(); const inp = this.card.querySelector<HTMLInputElement>('.lb-code'); if (inp) inp.value = code; }
  }

  private showPlay(): void {
    const c = this.setCard('play');
    c.append(
      this.title('SET SAIL', true),
      this.pbtn('\u2694', 'Quick Match', () => this.doQuick(), 'primary'),
      this.pbtn('\u{1F465}', 'Host Game', () => this.showHost()),
      this.pbtn('\u{1F50D}', 'Find Game', () => this.showFind()),
      this.pbtn('\u2693', 'Practice (Offline)', () => { this.hide(); this.deps.onOffline(); }, 'ghost'),
      this.pbtn('\u2190', 'Back', () => this.showMain(), 'ghost'),
      this.noticeBar(),
    );
  }

  private showHost(): void {
    const c = this.setCard('host');
    const durField = this.field('Match Duration');
    const durPills = document.createElement('div'); durPills.className = 'pirate-pills';
    const renderDur = () => { durPills.innerHTML = ''; for (const m of [5, 10, 20]) durPills.append(this.pill(`${m} min`, this.selDuration === m, () => { this.selDuration = m; renderDur(); })); };
    renderDur(); durField.append(durPills);

    const teamField = this.field('Players per Team');
    const teamPills = document.createElement('div'); teamPills.className = 'pirate-pills';
    const renderTeam = () => { teamPills.innerHTML = ''; for (const t of [1, 2, 4]) teamPills.append(this.pill(TEAM_LABEL[t], this.selTeamSize === t, () => { this.selTeamSize = t; renderTeam(); })); };
    renderTeam(); teamField.append(teamPills);

    c.append(
      this.title('HOST GAME', true),
      durField, teamField,
      this.pbtn('\u2691', 'Create Lobby', () => this.doHost(), 'primary'),
      this.pbtn('\u2190', 'Back', () => this.showPlay(), 'ghost'),
      this.noticeBar(),
    );
  }

  private showFind(): void {
    const c = this.setCard('find');
    const codeField = this.field('Join by Room Code');
    const codeRow = document.createElement('div'); codeRow.className = 'pirate-inline';
    const input = document.createElement('input');
    input.type = 'text'; input.className = 'pirate-input lb-code'; input.placeholder = 'e.g. AB12C';
    const joinBtn = this.pbtn('\u2693', 'Join', () => { const code = input.value.trim(); if (code) this.doJoin(code); }, 'primary compact');
    codeRow.append(input, joinBtn); codeField.append(codeRow);

    const list = document.createElement('div'); list.className = 'pirate-list';
    list.innerHTML = `<div class="pl-empty">Click "Browse Lobbies" to find open crews.</div>`;

    c.append(
      this.title('FIND GAME', true),
      codeField,
      this.pbtn('\u{1F50D}', 'Browse Lobbies', () => this.refreshBrowse(list)),
      list,
      this.pbtn('\u2190', 'Back', () => this.showPlay(), 'ghost'),
      this.noticeBar(),
    );
  }

  private showLeaderboard(): void {
    const c = this.setCard('board');
    const list = document.createElement('div'); list.className = 'pirate-list board';
    const gold = getGold();
    const rows: Array<[string, string]> = [
      ['Captain', currentName()],
      ['Gold Plundered', `\u{1FA99} ${gold.toLocaleString()}`],
      ['Global Rank', 'Unranked'],
      ['Matches Won', String(Number(localStorage.getItem('tw:wins') ?? 0) || 0)],
    ];
    list.innerHTML = rows.map(([k, v]) => `<div class="board-row"><span>${k}</span><b>${v}</b></div>`).join('');
    const note = document.createElement('div'); note.className = 'pirate-sub'; note.textContent = 'Online leaderboards are coming soon, Captain!';
    c.append(this.title('HALL OF FAME', true), list, note, this.pbtn('\u2190', 'Back', () => this.showMain(), 'ghost'));
  }

  private showHowTo(): void {
    const c = this.setCard('howto');
    const list = document.createElement('div'); list.className = 'howto';
    list.innerHTML =
      `<p><b>\u{1F3AF} Objective</b> — Protect your team's Treasure and destroy the enemy crews' treasures. Last crew standing wins!</p>` +
      `<p><b>\u{1FA99} Gold</b> — Collect coins from your generator, then buy blocks, weapons, armor and tools from the Shop (press <kbd>E</kbd> at your base).</p>` +
      `<p><b>\u{1F6E1} Defend</b> — Wall your treasure with blocks. If your treasure is destroyed you can no longer respawn.</p>` +
      `<p><b>\u2694 Controls</b> — <kbd>WASD</kbd> move · <kbd>Shift</kbd> sprint · <kbd>Space</kbd> jump · <kbd>LMB</kbd> attack/mine · <kbd>RMB</kbd> place/use · <kbd>1-9</kbd> items.</p>`;
    c.append(this.title('HOW TO PLAY', true), list, this.pbtn('\u2190', 'Back', () => this.showMain(), 'ghost'));
  }

  private showConnecting(text: string): void {
    const c = this.setCard('connecting');
    const spinner = document.createElement('div'); spinner.className = 'pirate-spinner';
    const p = document.createElement('div'); p.className = 'lb-notice'; p.textContent = text;
    c.append(this.title('SETTING SAIL', true), spinner, p);
  }

  private showExit(): void {
    const pop = document.createElement('div');
    pop.className = 'pirate-popup-scrim';
    pop.innerHTML = `<div class="pirate-popup"><div class="pp-title">Abandon Ship?</div><div class="pp-body">Are you sure you want to exit Treasure Wars?</div></div>`;
    const box = pop.querySelector('.pirate-popup')!;
    const btns = document.createElement('div'); btns.className = 'pp-btns';
    btns.append(
      this.pbtn('\u2714', 'Yes', () => { pop.remove(); this.doExit(); }, 'danger compact'),
      this.pbtn('\u2716', 'No', () => { audio.play('click'); pop.remove(); }, 'ghost compact'),
    );
    box.append(btns);
    pop.addEventListener('mousedown', (e) => { if (e.target === pop) pop.remove(); });
    this.root.append(pop);
  }

  private doExit(): void {
    audio.play('defeat');
    try { window.close(); } catch { /* ignore */ }
    const c = this.setCard('exit');
    c.append(
      this.title('FAIR WINDS', true),
      Object.assign(document.createElement('div'), { className: 'lb-notice', textContent: 'Thanks for playing Treasure Wars! You may close this tab.' }),
      this.pbtn('\u2693', 'Return to Port', () => this.showMain(), 'primary'),
    );
  }

  // --- Actions ---
  private async refreshBrowse(list: HTMLElement): Promise<void> {
    list.innerHTML = `<div class="pl-empty">Scanning the seas for open crews…</div>`;
    try {
      const rooms = (await listRooms()).filter((r) => r.phase === 'lobby' && r.clients < r.maxClients);
      if (rooms.length === 0) {
        list.innerHTML = `<div class="pl-empty">No open lobbies found. Host your own crew!</div>`;
        return;
      }
      list.innerHTML = '';
      for (const r of rooms) {
        const row = document.createElement('div');
        row.className = 'lb-room';
        row.innerHTML = `<span>${r.name} <small>${r.clients}/${r.maxClients}</small></span>`;
        row.append(this.pbtn('⚓', 'Join', () => this.doJoin(r.roomId), 'primary compact'));
        list.append(row);
      }
    } catch {
      list.innerHTML = `<div class="pl-empty">Could not reach the server. Is it running?</div>`;
    }
  }

  private async doHost(): Promise<void> {
    this.showConnecting('Raising the colours\u2026');
    try {
      const room = await hostRoom(currentName());
      this.attach(room);
      room.send(Msg.SetDuration, { minutes: this.selDuration });
      room.send(Msg.SetTeamSize, { size: this.selTeamSize });
    } catch { this.showHost(); this.notice('Failed to host — is the server running?'); }
  }
  private async doJoin(code: string): Promise<void> {
    this.showConnecting(`Boarding ${code}\u2026`);
    try { const room = await joinRoomById(code, currentName()); this.attach(room); }
    catch { this.showFind(); this.notice(`Could not join "${code}". It may be full or already started.`); }
  }
  private async doQuick(): Promise<void> {
    this.showConnecting('Finding a crew\u2026');
    try { const room = await quickJoin(currentName()); this.attach(room); }
    catch { this.showPlay(); this.notice('Quick Play failed — is the server running?'); }
  }

  // --- In-room lobby ---
  private attach(room: Room): void {
    this.room = room;
    this.entered = false;
    this.deps.onRoomConnected(room);
    room.onStateChange(() => this.onState());
    room.onLeave(() => this.onDisconnect());
    room.onError((_c, message) => this.notice(`Error: ${message ?? 'unknown'}`));
    this.renderLobby();
  }
  private onState(): void {
    if (!this.room) return;
    const phase = (this.room.state as any).phase;
    if (phase === 'playing' && !this.entered) {
      this.entered = true; this.hide(); this.deps.onMatchStart(this.room); return;
    }
    if (this.visible) this.renderLobby();
  }
  private onDisconnect(): void {
    const wasIn = this.entered;
    this.room = null; this.entered = false;
    this.showMain();
    this.notice(wasIn ? 'Disconnected from the match.' : 'The lobby closed (host may have left).');
  }

  private renderLobby(): void {
    const room = this.room;
    if (!room) return;
    const state: any = room.state;
    if (state.phase === 'playing') return;

    const c = this.setCard('room');
    const isHost = state.hostId === room.sessionId;

    const codeBar = document.createElement('div');
    codeBar.className = 'lb-code-bar';
    codeBar.innerHTML = `<span>Room Code</span><b>${room.id}</b>`;
    codeBar.append(this.pbtn('\u{1F517}', 'Copy Invite', () => {
      const link = `${location.origin}${location.pathname}?room=${room.id}`;
      navigator.clipboard?.writeText(link).then(() => this.notice('Invite link copied!')).catch(() => this.notice(link));
    }, 'ghost compact'));

    const settingsRow = document.createElement('div');
    settingsRow.className = 'lb-settings';
    if (isHost) {
      const durPills = document.createElement('div'); durPills.className = 'pirate-pills mini';
      for (const m of [5, 10, 20]) durPills.append(this.pill(`${m}m`, state.durationMin === m, () => room.send(Msg.SetDuration, { minutes: m })));
      const teamPills = document.createElement('div'); teamPills.className = 'pirate-pills mini';
      for (const t of [1, 2, 4]) teamPills.append(this.pill(TEAM_LABEL[t], state.teamSize === t, () => room.send(Msg.SetTeamSize, { size: t })));
      const d = document.createElement('div'); d.className = 'lb-set-line'; d.append(Object.assign(document.createElement('span'), { textContent: 'Duration' }), durPills);
      const e = document.createElement('div'); e.className = 'lb-set-line'; e.append(Object.assign(document.createElement('span'), { textContent: 'Teams' }), teamPills);
      settingsRow.append(d, e);
    } else {
      settingsRow.innerHTML = `<div class="lb-set-info">${state.durationMin} min \u00B7 ${TEAM_LABEL[state.teamSize] ?? state.teamSize}</div>`;
    }

    const list = document.createElement('div');
    list.className = 'pirate-list crew';
    let readyCount = 0; let count = 0;
    state.players.forEach((p: any, id: string) => {
      count++; if (p.ready) readyCount++;
      const row = document.createElement('div');
      row.className = 'crew-row';
      const color = `#${TEAMS[p.team].color.toString(16).padStart(6, '0')}`;
      const you = id === room.sessionId ? ' (you)' : '';
      const host = id === state.hostId ? ' \u265B' : '';
      row.innerHTML = `<span><span class="sb-dot" style="background:${color}"></span>${p.name}${you}${host}</span>` +
        `<span class="${p.ready ? 'rdy' : 'notrdy'}">${p.ready ? 'READY' : 'waiting'}</span>`;
      list.append(row);
    });

    const me: any = state.players.get(room.sessionId);
    const myReady = !!me?.ready;
    const readyBtn = this.pbtn(myReady ? '\u2716' : '\u2714', myReady ? 'Unready' : 'Ready Up', () => room.send(Msg.Ready, { ready: !myReady }), myReady ? 'ghost' : 'primary');
    const canStart = isHost && count >= ECONOMY.minMatchPlayers && readyCount >= ECONOMY.minMatchPlayers;
    const startBtn = this.pbtn('\u2691', isHost ? `Start Match (${readyCount}/${ECONOMY.minMatchPlayers})` : 'Waiting for host\u2026', () => room.send(Msg.StartMatch, {}), 'primary');
    startBtn.disabled = !canStart;
    const leaveBtn = this.pbtn('\u2693', 'Leave', () => { room.leave(); this.room = null; this.showMain(); }, 'ghost');

    c.append(this.title('CREW LOBBY', true), codeBar, settingsRow, list, readyBtn, startBtn, leaveBtn, this.noticeBar());
  }
}
