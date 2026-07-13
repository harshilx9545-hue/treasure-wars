import { ECONOMY, TEAMS, WEAPONS, WeaponId, type ShopItemId } from '@bedwars/shared';
import { audio } from './audio';

/** Maps a buyable weapon to its shop purchase id (server + offline both handle these). */
const WEAPON_SHOP_ID: Partial<Record<WeaponId, ShopItemId>> = {
  [WeaponId.Axe]: 'weapon_axe',
  [WeaponId.Pickaxe]: 'weapon_pickaxe',
  [WeaponId.Spear]: 'weapon_spear',
  [WeaponId.Bow]: 'weapon_bow',
  [WeaponId.Shield]: 'weapon_shield',
  [WeaponId.DoubleAxe]: 'weapon_doubleaxe',
};

function weaponDesc(id: WeaponId): string {
  const w = WEAPONS[id];
  const aps = (1000 / w.cooldownMs).toFixed(1);
  if (w.shield) return `Blocks melee & knockback. Slows you while raised.`;
  if (w.ranged) return `Ranged arrow âˆ™ ${w.damage} dmg âˆ™ range ${w.range.toFixed(0)}`;
  return `Dmg ${w.damage} · ${aps} hits/s · range ${w.range.toFixed(1)}${w.breakMult > 1.2 ? ` · mines x${w.breakMult}` : ''}`;
}

type Tab = 'Blocks' | 'Weapons' | 'Armor' | 'Tools' | 'Utility';
const TABS: Tab[] = ['Blocks', 'Weapons', 'Armor', 'Tools', 'Utility'];

interface Row {
  name: string;
  desc: string;
  price: number;
  id: ShopItemId;
  disabled?: boolean;
  note?: string;
  color?: number;
}

export interface TeamView { armorTier: number; genLevel: number; }

/**
 * Tabbed shop overlay (Blocks / Weapons / Armor / Tools / Utility).
 *
 * Decoupled from the network: it reads player/team state through getters and
 * emits purchases through an `onBuy` callback, so it works identically in
 * multiplayer (callback -> room.send) and in offline practice (callback ->
 * local economy). It never touches pointer lock directly.
 */
export class Shop {
  private root = document.createElement('div');
  private panel = document.createElement('div');
  private tab: Tab = 'Blocks';
  private getMe: (() => any) | null = null;
  private getTeam: (() => TeamView) | null = null;
  private onBuy: ((id: ShopItemId) => void) | null = null;
  onClose?: () => void;

  constructor() {
    this.root.id = 'shop';
    this.root.appendChild(this.panel);
    document.body.appendChild(this.root);
    this.root.style.display = 'none';
    this.root.addEventListener('mousedown', (e) => { if (e.target === this.root) this.close(); });
    // Only Escape closes from within the shop; the E key is owned by the
    // interaction system (Input -> onOpenShop) so it can toggle cleanly.
    window.addEventListener('keydown', (e) => {
      if (!this.isOpen) return;
      if (e.code === 'Escape') { e.preventDefault(); this.close(); }
    });
  }

  get isOpen(): boolean {
    return this.root.style.display !== 'none';
  }

  open(getMe: () => any, getTeam: () => TeamView, onBuy: (id: ShopItemId) => void): void {
    this.getMe = getMe;
    this.getTeam = getTeam;
    this.onBuy = onBuy;
    this.root.style.display = 'flex';
    this.render();
  }

  close(): void {
    if (!this.isOpen) return;
    this.root.style.display = 'none';
    this.onClose?.();
  }

  /** Re-render after a purchase confirmation so prices/ownership refresh. */
  refresh(): void {
    if (this.isOpen) this.render();
  }

  private rowsFor(tab: Tab, me: any, team: TeamView): Row[] {
    switch (tab) {
      case 'Blocks': {
        const w = ECONOMY.blocks.wool, pl = ECONOMY.blocks.plank, st = ECONOMY.blocks.stone;
        const stoneLocked = (me.coinsEarned ?? 0) < st.unlockCoinsEarned;
        return [
          { name: `Wool x${w.stack}`, desc: 'Team-colored. Treasure defense & bridging.', price: w.price * w.stack, id: 'block_wool', color: TEAMS[me.team].color },
          { name: `Wood Plank x${pl.stack}`, desc: 'Cheaper, but breaks faster.', price: pl.price * pl.stack, id: 'block_plank', color: 0xc08a4a },
          { name: `Stone x${st.stack}`, desc: stoneLocked ? `Unlocks after earning ${st.unlockCoinsEarned} coins` : 'Durable defensive block.', price: st.price * st.stack, id: 'block_stone', color: 0x9a9a9a, disabled: stoneLocked, note: stoneLocked ? 'LOCKED' : undefined },
        ];
      }
      case 'Weapons': {
        const owned: number = me.weapons ?? 0;
        const rows: Row[] = [];
        // Iron Sword is the starting weapon — shown as owned for context.
        rows.push({ name: WEAPONS[WeaponId.IronSword].name, desc: weaponDesc(WeaponId.IronSword), price: 0, id: 'weapon_axe', disabled: true, note: 'STARTER', color: WEAPONS[WeaponId.IronSword].color });
        for (const def of Object.values(WEAPONS)) {
          const sid = WEAPON_SHOP_ID[def.id];
          if (!sid) continue;
          const has = ((owned >> def.id) & 1) === 1;
          rows.push({
            name: def.name, desc: weaponDesc(def.id), price: def.price, id: sid,
            color: def.color, disabled: has, note: has ? 'OWNED' : undefined,
          });
        }
        return rows;
      }
      case 'Armor': {
        const next = team.armorTier + 1;
        if (next >= ECONOMY.armor.length) {
          return [{ name: ECONOMY.armor[team.armorTier].name, desc: 'Team armor maxed.', price: 0, id: 'armor', disabled: true, note: 'MAX', color: 0xb0c4de }];
        }
        const a = ECONOMY.armor[next];
        return [{ name: a.name, desc: `TEAM-WIDE. Cuts ${Math.round(a.reduction * 100)}% damage. (now: ${ECONOMY.armor[team.armorTier].name})`, price: a.price, id: 'armor', color: 0xb0c4de }];
      }
      case 'Tools': {
        const rows: Row[] = [];
        const pnext = me.pickTier + 1;
        if (pnext >= ECONOMY.pickaxes.length) {
          rows.push({ name: ECONOMY.pickaxes[me.pickTier].name, desc: 'Max mining speed.', price: 0, id: 'pick', disabled: true, note: 'MAX', color: 0x7a5230 });
        } else {
          const pk = ECONOMY.pickaxes[pnext];
          rows.push({ name: pk.name, desc: `Mining speed x${pk.speed}. (now ${ECONOMY.pickaxes[me.pickTier].name})`, price: pk.price, id: 'pick', color: 0x7a5230 });
        }
        rows.push({ name: ECONOMY.shears.name, desc: 'Break wool quickly.', price: ECONOMY.shears.price, id: 'shears', disabled: !!me.shears, note: me.shears ? 'OWNED' : undefined, color: 0xdddddd });
        return rows;
      }
      case 'Utility': {
        const u = ECONOMY.utility;
        return [
          { name: `TNT (${me.tnt})`, desc: `Timed explosion — breaks blocks & players.`, price: u.tnt.price, id: 'tnt', color: 0xd23b2b },
          { name: `Ender Pearl (${me.pearls})`, desc: 'Throw to teleport where it lands.', price: u.pearl.price, id: 'pearl', color: 0x1fe0a0 },
          { name: `Fireball (${me.fireballs})`, desc: 'Knockback + damage. Breaks bridges.', price: u.fireball.price, id: 'fireball', color: 0xff7a1a },
          { name: `Alarm Trap (${me.alarms})`, desc: 'Alerts your team of intruders.', price: u.alarm.price, id: 'alarm', color: 0xffd23f },
          { name: `Generator Upgrade`, desc: 'TEAM-WIDE. Faster coin generation.', price: (ECONOMY.generator.levels[team.genLevel + 1]?.cost ?? 0), id: 'gen_upgrade', disabled: team.genLevel + 1 >= ECONOMY.generator.levels.length, note: team.genLevel + 1 >= ECONOMY.generator.levels.length ? 'MAX' : `Lv ${team.genLevel}`, color: 0x39c0ff },
        ];
      }
    }
  }

  private render(): void {
    if (!this.getMe || !this.getTeam) return;
    const me = this.getMe();
    if (!me) return;
    const team = this.getTeam() ?? { armorTier: 0, genLevel: 0 };
    this.panel.innerHTML = '';

    // Header
    const head = document.createElement('div');
    head.className = 'shop-head';
    head.innerHTML = `<span class="shop-title">SHOP</span><span class="shop-coins"><span class="coin-icon">\u25C9</span> ${me.coins}</span>`;
    const closeBtn = document.createElement('button');
    closeBtn.className = 'shop-close';
    closeBtn.textContent = '\u2715';
    closeBtn.addEventListener('click', () => { audio.play('click'); this.close(); });
    head.append(closeBtn);

    // Tabs
    const tabBar = document.createElement('div');
    tabBar.className = 'shop-tabs';
    for (const t of TABS) {
      const b = document.createElement('button');
      b.className = 'shop-tab' + (t === this.tab ? ' active' : '');
      b.textContent = t;
      b.addEventListener('click', () => { audio.play('click'); this.tab = t; this.render(); });
      tabBar.appendChild(b);
    }

    // Items
    const items = document.createElement('div');
    items.className = 'shop-items';
    for (const r of this.rowsFor(this.tab, me, team)) {
      const row = document.createElement('div');
      row.className = 'shop-row';
      const swatch = `<span class="shop-swatch" style="background:#${(r.color ?? 0x888888).toString(16).padStart(6, '0')}"></span>`;
      const priceTxt = r.note ? r.note : `\u25C9 ${r.price}`;
      const affordable = !r.disabled && me.coins >= r.price;
      row.innerHTML =
        `<div class="shop-item">${swatch}<div><div class="shop-name">${r.name}</div><div class="shop-desc">${r.desc}</div></div></div>` +
        `<button class="shop-buy ${affordable ? '' : 'no'}" ${r.disabled || !affordable ? 'disabled' : ''}>${priceTxt}</button>`;
      const buy = row.querySelector('button')!;
      if (!r.disabled && affordable) {
        buy.addEventListener('click', () => {
          audio.play('click');
          this.onBuy?.(r.id);
        });
      }
      items.appendChild(row);
    }

    const hint = document.createElement('div');
    hint.className = 'shop-hint';
    hint.textContent = 'Press E or Esc to close · walk over coins to collect · buy blocks then place with right-click';

    this.panel.append(head, tabBar, items, hint);
  }
}
