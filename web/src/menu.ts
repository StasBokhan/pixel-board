import { availableWallets, type Wallet } from './wallet';

// One small popover menu per page (the #menu element), used for picking a wallet and for the account menu.

export type MenuItem = { label: string; icon?: string; run: () => void };

const menuEl = () => document.getElementById('menu') as HTMLElement;
let onToggle: (() => void) | null = null;

/** Closes the menu on outside clicks and Escape. `onChange` runs whenever it opens or closes. */
export function setupMenu(onChange: () => void): void {
  onToggle = onChange;
  document.addEventListener('click', (e) => {
    if (!menuEl().contains(e.target as Node)) closeMenu();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeMenu();
  });
}

export function isMenuOpen(): boolean {
  return !menuEl().hidden;
}

export function openMenu(anchor: HTMLElement, note: string, items: MenuItem[]): void {
  const menu = menuEl();
  const p = document.createElement('p');
  p.className = 'menu-note';
  p.textContent = note;
  menu.replaceChildren(p);
  for (const item of items) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'menu-item';
    if (item.icon) {
      const img = document.createElement('img');
      img.src = item.icon;
      img.alt = '';
      b.append(img);
    }
    b.append(item.label);
    b.addEventListener('click', item.run);
    menu.append(b);
  }

  menu.hidden = false;
  const r = anchor.getBoundingClientRect();
  const width = menu.offsetWidth;
  const height = menu.offsetHeight;
  // Open upwards when there is no room below (e.g. the button pinned to the bottom on phones).
  const top = r.bottom + 8 + height > window.innerHeight ? r.top - 8 - height : r.bottom + 8;
  menu.style.top = `${Math.max(8, top) + window.scrollY}px`;
  menu.style.left = `${Math.max(12, Math.min(r.right - width, window.innerWidth - width - 12)) + window.scrollX}px`;
  onToggle?.();
  menu.querySelector<HTMLElement>('button')?.focus();
}

export function closeMenu(): void {
  if (menuEl().hidden) return;
  menuEl().hidden = true;
  onToggle?.();
}

/** Connects straight away when there is one wallet, otherwise lets the user pick. */
export function openWalletPicker(anchor: HTMLElement, connect: (wallet: Wallet) => void): void {
  const wallets = availableWallets();
  if (wallets.length === 1) return connect(wallets[0]);
  if (!wallets.length) {
    return openMenu(anchor, "No browser wallet found. Install MetaMask or Rabby, or open this page in your wallet app's browser.", []);
  }
  openMenu(
    anchor,
    'Choose a wallet',
    wallets.map((wallet) => ({ label: wallet.info.name, icon: wallet.info.icon || undefined, run: () => connect(wallet) })),
  );
}
