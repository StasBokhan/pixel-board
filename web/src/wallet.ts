import type { EIP1193Provider } from 'viem';

// Browser wallets announce themselves with EIP-6963, so several installed wallets don't fight over window.ethereum.
export type WalletInfo = { uuid: string; name: string; icon: string; rdns: string };
export type Wallet = { info: WalletInfo; provider: EIP1193Provider };

const announced = new Map<string, Wallet>();

export function discoverWallets(onAnnounce: (wallet: Wallet) => void): void {
  window.addEventListener('eip6963:announceProvider', (event) => {
    const detail = (event as CustomEvent<Wallet>).detail;
    if (!detail?.info || !detail.provider) return;
    const id = detail.info.rdns || detail.info.uuid;
    announced.set(id, detail);
    onAnnounce(detail);
  });
  window.dispatchEvent(new Event('eip6963:requestProvider'));
}

export function availableWallets(): Wallet[] {
  const list = [...announced.values()];
  const legacy = (window as unknown as { ethereum?: EIP1193Provider }).ethereum;
  if (list.length === 0 && legacy) {
    list.push({ info: { uuid: 'injected', name: 'Browser wallet', icon: '', rdns: 'injected' }, provider: legacy });
  }
  return list;
}

export function walletById(id: string): Wallet | undefined {
  return availableWallets().find((w) => (w.info.rdns || w.info.uuid) === id);
}

export function walletId(wallet: Wallet): string {
  return wallet.info.rdns || wallet.info.uuid;
}
