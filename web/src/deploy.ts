import '@fontsource/tiny5';
import '@fontsource-variable/atkinson-hyperlegible-next';
import './style.css';

import {
  BaseError,
  InsufficientFundsError,
  UserRejectedRequestError,
  createPublicClient,
  createWalletClient,
  custom,
  encodeDeployData,
  formatEther,
  getAddress,
  http,
  type Address,
  type Hash,
  type PublicClient,
} from 'viem';
import { pixelBoardAbi } from './abi';
import { pixelBoardBytecode } from './bytecode';
import { CHAINS, ENV_NETWORK, type NetworkKey } from './config';
import { closeMenu, isMenuOpen, openMenu, openWalletPicker, setupMenu } from './menu';
import { discoverWallets, walletById, walletId, type Wallet } from './wallet';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const OPTIONS: NetworkKey[] = ENV_NETWORK === 'anvil' ? ['anvil', 'testnet', 'mainnet'] : ['testnet', 'mainnet'];
const LABELS: Record<NetworkKey, string> = { testnet: 'Testnet', mainnet: 'Mainnet', anvil: 'Local anvil' };
const NOTES: Record<NetworkKey, string> = {
  testnet:
    'Test ETH is free and nothing real is at stake. Get some from the <a href="https://www.alchemy.com/faucets/robinhood-testnet" target="_blank" rel="noopener">Alchemy faucet</a>.',
  mainnet:
    'Uses real ETH. Try the testnet first. To move ETH to Robinhood Chain, use the <a href="https://portal.arbitrum.io/bridge?destinationChain=robinhood-chain&sourceChain=ethereum" target="_blank" rel="noopener">Arbitrum bridge</a>.',
  anvil: 'Your local anvil node at 127.0.0.1:8545.',
};
const MAX_COOLDOWN = 604_800; // a week
const SAVED_WALLET = 'pixel-board:wallet'; // same key as the board page, so one connection works for both
const SAVED_DEPLOYS = 'pixel-board:deployments';

type Deployment = { network: NetworkKey; address: Address; cooldown: number; hash: Hash; at: number };
type Tone = 'info' | 'ok' | 'error';

const state = {
  network: OPTIONS[0],
  wallet: null as Wallet | null,
  account: null as Address | null,
  walletChainId: null as number | null,
  balance: null as bigint | null,
  cost: null as bigint | null,
  phase: 'idle' as 'idle' | 'switching' | 'signing' | 'pending',
  status: { text: '', tone: 'info' as Tone, link: null as { href: string; label: string } | null },
  result: null as Deployment | null,
};

const clients = new Map<NetworkKey, PublicClient>();
function client(key: NetworkKey): PublicClient {
  let c = clients.get(key);
  if (!c) {
    c = createPublicClient({ chain: CHAINS[key], transport: http() }) as PublicClient;
    clients.set(key, c);
  }
  return c;
}

// ─── Setup ────────────────────────────────────────────────────────────────────────────────

function init(): void {
  renderNetworks();
  setupMenu(renderAccount);
  $('deploy-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    action().run?.();
  });
  $('account-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    if (isMenuOpen()) return closeMenu();
    if (state.account) {
      const account = state.account;
      openMenu($('account-btn'), `${short(account)} via ${state.wallet?.info.name ?? 'wallet'}`, [
        { label: 'Copy address', run: () => void navigator.clipboard.writeText(account).then(closeMenu) },
        { label: 'Disconnect', run: disconnect },
      ]);
    } else {
      openWalletPicker($('account-btn'), (w) => void connect(w));
    }
  });
  $<HTMLInputElement>('cooldown').addEventListener('input', () => {
    state.cost = null;
    render();
    void refreshCost();
  });
  discoverWallets((wallet) => {
    if (!state.account && storage.get(SAVED_WALLET) === walletId(wallet)) void connect(wallet, true);
  });
  setTimeout(() => {
    const legacy = walletById('injected');
    if (!state.account && legacy && storage.get(SAVED_WALLET) === 'injected') void connect(legacy, true);
  }, 400);
  render();
}

function renderNetworks(): void {
  $('networks').innerHTML = OPTIONS.map(
    (key) => `
      <label class="choice">
        <input type="radio" name="network" value="${key}" ${key === state.network ? 'checked' : ''} />
        <span>${LABELS[key]}<small>${CHAINS[key].name}</small></span>
      </label>`,
  ).join('');
  $('networks').addEventListener('change', (e) => {
    state.network = (e.target as HTMLInputElement).value as NetworkKey;
    state.balance = null;
    state.cost = null;
    setStatus('');
    render();
    void refresh();
  });
}

// ─── Wallet ───────────────────────────────────────────────────────────────────────────────

async function connect(wallet: Wallet, silent = false): Promise<void> {
  try {
    const accounts = silent
      ? await wallet.provider.request({ method: 'eth_accounts' })
      : await wallet.provider.request({ method: 'eth_requestAccounts' });
    if (!accounts.length) return;
    if (state.wallet && state.wallet !== wallet) detach(state.wallet);
    state.wallet = wallet;
    state.account = getAddress(accounts[0]);
    state.walletChainId = Number(await wallet.provider.request({ method: 'eth_chainId' }));
    storage.set(SAVED_WALLET, walletId(wallet));
    attach(wallet);
    closeMenu();
    if (!silent) setStatus('');
    render();
    await refresh();
  } catch (err) {
    if (!silent) setStatus(explain(err), 'error');
  }
}

function disconnect(): void {
  if (state.wallet) detach(state.wallet);
  state.wallet = null;
  state.account = null;
  state.walletChainId = null;
  state.balance = null;
  state.cost = null;
  storage.remove(SAVED_WALLET);
  closeMenu();
  render();
}

const onAccountsChanged = (accounts: readonly Address[]) => {
  if (!accounts.length) return disconnect();
  state.account = getAddress(accounts[0]);
  state.balance = null;
  render();
  void refresh();
};
const onChainChanged = (chainId: string) => {
  state.walletChainId = Number(chainId);
  render();
};

function attach(wallet: Wallet): void {
  wallet.provider.on('accountsChanged', onAccountsChanged);
  wallet.provider.on('chainChanged', onChainChanged);
}

function detach(wallet: Wallet): void {
  wallet.provider.removeListener('accountsChanged', onAccountsChanged);
  wallet.provider.removeListener('chainChanged', onChainChanged);
}

async function switchNetwork(): Promise<void> {
  const wallet = state.wallet;
  if (!wallet) return;
  const chain = CHAINS[state.network];
  state.phase = 'switching';
  render();
  const walletClient = createWalletClient({ chain, transport: custom(wallet.provider) });
  try {
    await walletClient.switchChain({ id: chain.id });
  } catch (err) {
    if (isRejection(err)) {
      setStatus(explain(err), 'error');
    } else {
      try {
        await walletClient.addChain({ chain });
      } catch (addErr) {
        setStatus(explain(addErr), 'error');
      }
    }
  } finally {
    state.walletChainId = Number(await wallet.provider.request({ method: 'eth_chainId' }).catch(() => '0x0'));
    state.phase = 'idle';
    render();
  }
}

// ─── Balance, cost, deploy ────────────────────────────────────────────────────────────────

async function refresh(): Promise<void> {
  const { account, network } = state;
  if (!account) return;
  try {
    const balance = await client(network).getBalance({ address: account });
    if (state.account === account && state.network === network) state.balance = balance;
  } catch {
    // RPC hiccup: leave the balance unknown
  }
  render();
  await refreshCost();
}

async function refreshCost(): Promise<void> {
  const { account, network } = state;
  const cooldown = cooldownValue();
  if (!account || cooldown === null) return;
  try {
    const data = encodeDeployData({ abi: pixelBoardAbi, bytecode: pixelBoardBytecode, args: [BigInt(cooldown)] });
    const [gas, price] = await Promise.all([
      client(network).estimateGas({ account, data }),
      client(network).getGasPrice(),
    ]);
    if (state.account === account && state.network === network && cooldownValue() === cooldown) state.cost = gas * price;
  } catch {
    state.cost = null;
  }
  render();
}

async function deploy(): Promise<void> {
  const { wallet, account, network } = state;
  const cooldown = cooldownValue();
  if (!wallet || !account || cooldown === null || state.phase !== 'idle') return;
  const chain = CHAINS[network];

  setStatus('');
  state.phase = 'signing';
  render();
  try {
    const walletClient = createWalletClient({ chain, transport: custom(wallet.provider) });
    const hash = await walletClient.deployContract({
      abi: pixelBoardAbi,
      bytecode: pixelBoardBytecode,
      args: [BigInt(cooldown)],
      account,
    });
    state.phase = 'pending';
    setStatus('Sent. Waiting for the block…', 'info', txLink(network, hash));
    render();

    const receipt = await client(network).waitForTransactionReceipt({ hash, pollingInterval: 1_000 });
    if (receipt.status !== 'success' || !receipt.contractAddress) throw new Error('The deployment failed onchain. Nothing was created.');
    const deployment: Deployment = { network, address: getAddress(receipt.contractAddress), cooldown, hash, at: Date.now() };
    state.result = deployment;
    saveDeployment(deployment);
    setStatus('Deployed.', 'ok', txLink(network, hash));
    void refresh();
  } catch (err) {
    setStatus(explain(err), 'error');
  } finally {
    state.phase = 'idle';
    render();
  }
}

type Action = { label: string; disabled: boolean; run?: () => void };

function action(): Action {
  const chain = CHAINS[state.network];
  if (!state.account) return { label: 'Connect wallet', disabled: false, run: () => openWalletPicker($('deploy-btn'), (w) => void connect(w)) };
  if (state.walletChainId !== chain.id) {
    const busy = state.phase === 'switching';
    return { label: busy ? 'Check your wallet…' : `Switch to ${chain.name}`, disabled: busy, run: () => void switchNetwork() };
  }
  if (state.phase === 'signing') return { label: 'Confirm in your wallet…', disabled: true };
  if (state.phase === 'pending') return { label: 'Deploying…', disabled: true };
  if (cooldownValue() === null) return { label: `Cooldown must be 0 to ${MAX_COOLDOWN.toLocaleString('en-US')}`, disabled: true };
  if (state.balance === 0n) return { label: `No ETH on ${chain.name} yet`, disabled: true };
  return { label: `Deploy to ${chain.name}`, disabled: false, run: () => void deploy() };
}

function cooldownValue(): number | null {
  const raw = $<HTMLInputElement>('cooldown').value.trim();
  const n = Number(raw);
  return raw !== '' && Number.isInteger(n) && n >= 0 && n <= MAX_COOLDOWN ? n : null;
}

// ─── Rendering ────────────────────────────────────────────────────────────────────────────

function render(): void {
  const chain = CHAINS[state.network];
  $('network-note').innerHTML = NOTES[state.network];

  const info = $('wallet-info');
  if (!state.account) {
    info.textContent = `Connect the wallet that should pay for the deployment. It needs a little ETH on ${chain.name}.`;
  } else {
    const parts = [`${short(state.account)} has ${state.balance === null ? '…' : `${eth(state.balance)} ETH`} on ${chain.name}.`];
    if (state.cost !== null) parts.push(`Deploying costs about ${eth(state.cost)} ETH.`);
    info.textContent = parts.join(' ');
  }

  const btn = $<HTMLButtonElement>('deploy-btn');
  const a = action();
  btn.textContent = a.label;
  btn.disabled = a.disabled;
  btn.dataset.kind = a.disabled ? 'idle' : 'step';

  renderStatus();
  renderAccount();
  renderResult();
  renderHistory();
}

function renderAccount(): void {
  const btn = $('account-btn');
  btn.textContent = state.account ? short(state.account) : 'Connect wallet';
  btn.setAttribute('aria-expanded', String(isMenuOpen()));
}

function renderStatus(): void {
  const el = $('status');
  const { text, tone, link } = state.status;
  el.dataset.tone = tone;
  if (!text) return el.replaceChildren();
  el.replaceChildren(text);
  if (link) {
    const a = document.createElement('a');
    a.href = link.href;
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = link.label;
    el.append(' ', a);
  }
}

function renderResult(): void {
  const box = $('result');
  const d = state.result;
  box.hidden = !d;
  if (!d) return;
  const chain = CHAINS[d.network];
  const explorer = chain.blockExplorers?.default.url;
  const snippet = `"${d.network}": { "address": "${d.address}", "cooldown": ${d.cooldown} }`;
  box.innerHTML = `
    <h2>Your board is on ${chain.name}</h2>
    <p class="address-full">${d.address}</p>
    <div class="links">
      <button class="text-btn" type="button" id="copy-address">Copy address</button>
      ${explorer ? `<a href="${explorer}/address/${d.address}" target="_blank" rel="noopener">View on Blockscout</a>` : ''}
    </div>
    <p class="note">Last step: add the address to <code>web/src/deployments.json</code> in the repo and push. The site rebuilds and the board shows up a couple of minutes later.</p>
    <pre class="snippet">${snippet}</pre>`;
  $('copy-address').addEventListener('click', (e) => {
    const b = e.currentTarget as HTMLButtonElement;
    void navigator.clipboard.writeText(d.address).then(() => {
      b.textContent = 'Copied';
      setTimeout(() => (b.textContent = 'Copy address'), 1500);
    });
  });
}

function renderHistory(): void {
  const list = loadDeployments().filter((d) => d.hash !== state.result?.hash);
  $('history-section').hidden = list.length === 0;
  $('history').innerHTML = list
    .map((d) => {
      const chain = CHAINS[d.network];
      const explorer = chain.blockExplorers?.default.url;
      const addr = explorer ? `<a href="${explorer}/address/${d.address}" target="_blank" rel="noopener">${d.address}</a>` : d.address;
      return `<li><span class="when">${chain.name}, ${new Date(d.at).toLocaleString()}, cooldown ${d.cooldown}s</span>${addr}</li>`;
    })
    .join('');
}

function setStatus(text: string, tone: Tone = 'info', link: { href: string; label: string } | null = null): void {
  state.status = { text, tone, link };
  renderStatus();
}

// ─── Helpers ──────────────────────────────────────────────────────────────────────────────

function explain(err: unknown): string {
  if (err instanceof BaseError) {
    if (isRejection(err)) return 'You declined the request in your wallet. Nothing was sent.';
    if (err.walk((e) => e instanceof InsufficientFundsError)) {
      return `Not enough ETH on ${CHAINS[state.network].name} to pay for the deployment.`;
    }
    return err.shortMessage;
  }
  return err instanceof Error ? err.message : String(err);
}

function isRejection(err: unknown): boolean {
  return (
    err instanceof BaseError &&
    Boolean(err.walk((e) => e instanceof UserRejectedRequestError || (e as { code?: number }).code === 4001))
  );
}

function txLink(network: NetworkKey, hash: Hash): { href: string; label: string } | null {
  const explorer = CHAINS[network].blockExplorers?.default.url;
  return explorer ? { href: `${explorer}/tx/${hash}`, label: 'View transaction' } : null;
}

function eth(wei: bigint): string {
  if (wei === 0n) return '0';
  return Number(formatEther(wei)).toLocaleString('en-US', { maximumSignificantDigits: 3 });
}

function short(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function loadDeployments(): Deployment[] {
  try {
    const list = JSON.parse(storage.get(SAVED_DEPLOYS) ?? '[]') as Deployment[];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function saveDeployment(d: Deployment): void {
  storage.set(SAVED_DEPLOYS, JSON.stringify([d, ...loadDeployments()].slice(0, 20)));
}

const storage = {
  get: (key: string): string | null => {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set: (key: string, value: string): void => {
    try {
      localStorage.setItem(key, value);
    } catch {
      /* ignore */
    }
  },
  remove: (key: string): void => {
    try {
      localStorage.removeItem(key);
    } catch {
      /* ignore */
    }
  },
};

init();
