import { audio } from './audio';

/**
 * Full-screen Victory / Defeat overlay shown when the match ends.
 * - Victory: bright, winning-team color, confetti / party-popper burst.
 * - Defeat: dark overlay, "Better Luck Next Game!".
 * Buttons: Play Again (rematch in the same room) and Return to Lobby.
 * Pure DOM + CSS animations (see index.html) for reliability + polish.
 */
export class EndScreen {
  private root = document.createElement('div');
  onPlayAgain?: () => void;
  onReturnLobby?: () => void;

  constructor() {
    this.root.id = 'endscreen';
    this.root.style.display = 'none';
    document.body.appendChild(this.root);
  }

  get visible(): boolean {
    return this.root.style.display !== 'none';
  }

  show(win: boolean, teamName: string, teamColor: string): void {
    this.root.style.display = 'flex';
    this.root.className = win ? 'win' : 'lose';
    this.root.innerHTML = '';

    const card = document.createElement('div');
    card.className = 'end-card';

    const title = document.createElement('div');
    title.className = 'end-title';
    title.textContent = win ? 'VICTORY!' : 'Better Luck Next Game!';
    title.style.color = win ? teamColor : '#ff7a7a';

    const sub = document.createElement('div');
    sub.className = 'end-sub';
    sub.innerHTML = `<span class="end-dot" style="background:${teamColor}"></span>${teamName} team wins the match`;

    const btns = document.createElement('div');
    btns.className = 'end-btns';
    btns.append(
      this.btn('Play Again', () => this.onPlayAgain?.(), 'primary'),
      this.btn('Return to Lobby', () => this.onReturnLobby?.()),
    );

    card.append(title, sub, btns);
    this.root.append(card);

    if (win) {
      this.confetti(teamColor);
      audio.play('victory');
    } else {
      audio.play('defeat');
    }
  }

  hide(): void {
    this.root.style.display = 'none';
    this.root.innerHTML = '';
  }

  private btn(label: string, onClick: () => void, cls = ''): HTMLButtonElement {
    const b = document.createElement('button');
    b.className = `mc-btn ${cls}`;
    b.textContent = label;
    b.addEventListener('click', () => { audio.resume(); audio.play('click'); onClick(); });
    return b;
  }

  private confetti(teamColor: string): void {
    const layer = document.createElement('div');
    layer.className = 'confetti';
    const colors = [teamColor, '#ffd23f', '#39c0ff', '#9bff5c', '#ff5252', '#ffffff', '#ff7bd5'];
    for (let i = 0; i < 140; i++) {
      const c = document.createElement('i');
      c.className = 'conf';
      c.style.left = `${Math.random() * 100}%`;
      c.style.background = colors[i % colors.length];
      c.style.animationDelay = `${Math.random() * 0.8}s`;
      c.style.animationDuration = `${1.8 + Math.random() * 1.8}s`;
      c.style.setProperty('--rot', `${Math.random() * 360}deg`);
      c.style.setProperty('--drift', `${(Math.random() - 0.5) * 220}px`);
      if (i % 3 === 0) c.style.borderRadius = '50%';
      layer.appendChild(c);
    }
    this.root.appendChild(layer);
  }
}
