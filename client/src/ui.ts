export interface ScoreboardRow {
  name: string;
  color: string; // css color
  bed: boolean;
  players: number;
  you: boolean;
}

/** Lightweight DOM HUD (no framework; cheap to update, easy to restyle). */
export class HUD {
  private stats = document.getElementById('stats')!;
  private hearts = document.getElementById('hearts')!;
  private board = document.getElementById('scoreboard')!;
  private feed = document.getElementById('killfeed')!;
  private status = document.getElementById('status')!;

  setStats(fps: number, ping: number | null, cps: number): void {
    this.stats.textContent = `FPS ${fps}  |  Ping ${ping === null ? '\u2014' : `${ping}ms`}  |  CPS ${cps}`;
  }

  setHearts(hp: number): void {
    const full = Math.max(0, Math.min(10, Math.round(hp / 2)));
    this.hearts.textContent = '\u2665'.repeat(full) + '\u2661'.repeat(10 - full);
  }

  setScoreboard(rows: ScoreboardRow[]): void {
    this.board.innerHTML =
      `<div class="sb-title">BED WARS</div>` +
      rows
        .map(
          (r) =>
            `<div class="sb-row"><span><span class="sb-dot" style="background:${r.color}"></span>${r.name}${r.you ? ' (you)' : ''}</span>` +
            `<span>${r.bed ? '\u2713' : '\u2717'} ${r.players}</span></div>`,
        )
        .join('');
  }

  addFeed(text: string): void {
    const div = document.createElement('div');
    div.className = 'feed';
    div.textContent = text;
    this.feed.prepend(div);
    while (this.feed.children.length > 6) this.feed.lastChild?.remove();
    setTimeout(() => div.remove(), 7000);
  }

  setStatus(text: string): void {
    this.status.style.display = text ? 'block' : 'none';
    this.status.textContent = text;
  }
}
