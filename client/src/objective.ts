/**
 * Cinematic match-start objective popup + a persistent top-right tracker.
 *
 * Purely presentational and self-contained: it never touches gameplay, input,
 * or the game clock. The popup layer has `pointer-events: none`, so player
 * movement is never interrupted and nothing is paused. Reusable across matches
 * via reset() (called on rematch).
 */

const HOLD_MS = 4000; // how long the popup stays fully visible
const FADE_MS = 500; // matches the CSS opacity/transform transition

export class Objective {
  private popup = document.getElementById('objective-popup')!;
  private tracker = document.getElementById('objective-tracker')!;

  private protectRow!: HTMLElement;
  private destroyRow!: HTMLElement;
  private shown = false; // popup sequence already started this match
  private timers: number[] = [];
  private sig = '';

  constructor() {
    this.buildTracker();
  }

  private buildTracker(): void {
    this.tracker.innerHTML = '';
    const title = document.createElement('div');
    title.className = 'obj-track-title';
    title.textContent = 'OBJECTIVE';
    this.protectRow = this.row('Protect your Treasure');
    this.destroyRow = this.row('Destroy Enemy Treasures');
    this.tracker.append(title, this.protectRow, this.destroyRow);
  }

  private row(label: string): HTMLElement {
    const row = document.createElement('div');
    row.className = 'obj-track-row';
    const box = document.createElement('span');
    box.className = 'obj-box';
    box.textContent = '☐'; // ☐
    const text = document.createElement('span');
    text.textContent = label;
    row.append(box, text);
    return row;
  }

  /** Run the full cinematic once per match: fade in -> hold ~4s -> fade out -> tracker. */
  play(): void {
    if (this.shown) return;
    this.shown = true;
    this.clearTimers();

    // 1-2. Fade overlay in; panel slides up + scales 90% -> 100%.
    this.popup.classList.add('on');
    // Force a reflow so the transition runs from the initial (hidden) state.
    void this.popup.offsetWidth;
    this.popup.classList.add('show');

    // 6-7. Hold, then fade out smoothly.
    this.timers.push(window.setTimeout(() => {
      this.popup.classList.remove('show');
      // 8. After the fade completes, hide the layer and reveal the tracker.
      this.timers.push(window.setTimeout(() => {
        this.popup.classList.remove('on');
        this.showTracker();
      }, FADE_MS));
    }, HOLD_MS));
  }

  private showTracker(): void {
    this.tracker.classList.add('on');
    void this.tracker.offsetWidth;
    this.tracker.classList.add('show');
  }

  /**
   * Update the tracker from live match state (called every frame/board tick).
   * @param myTreasureAlive  is the local player's treasure still standing
   * @param enemyTreasuresLeft  number of enemy treasures not yet destroyed
   */
  setProgress(myTreasureAlive: boolean, enemyTreasuresLeft: number): void {
    const sig = `${myTreasureAlive ? 1 : 0}|${enemyTreasuresLeft}`;
    if (sig === this.sig) return; // only touch the DOM when something changed
    this.sig = sig;

    // ✔ Protect your Treasure — done while alive, fail once destroyed.
    this.protectRow.className = `obj-track-row ${myTreasureAlive ? 'done' : 'fail'}`;
    (this.protectRow.firstChild as HTMLElement).textContent = myTreasureAlive ? '✔' : '✗';

    // ☐ Destroy Enemy Treasures — done when none remain.
    const cleared = enemyTreasuresLeft <= 0;
    this.destroyRow.className = `obj-track-row ${cleared ? 'done' : ''}`;
    (this.destroyRow.firstChild as HTMLElement).textContent = cleared ? '✔' : '☐';
    (this.destroyRow.lastChild as HTMLElement).textContent =
      cleared ? 'Enemy Treasures Destroyed' : `Destroy Enemy Treasures (${enemyTreasuresLeft})`;
  }

  /** Hide everything and re-arm for the next match (used on rematch). */
  reset(): void {
    this.clearTimers();
    this.shown = false;
    this.sig = '';
    this.popup.classList.remove('on', 'show');
    this.tracker.classList.remove('on', 'show');
  }

  private clearTimers(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
  }
}
