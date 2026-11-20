import '@fontsource/tiny5';
import '@fontsource-variable/atkinson-hyperlegible-next';
import './style.css';

import {
  BaseError,
  ContractFunctionRevertedError,
  ContractFunctionZeroDataError,
  InsufficientFundsError,
  UserRejectedRequestError,
  createPublicClient,
  createWalletClient,
  custom,
  getAddress,
  hexToBytes,
  http,
  parseEventLogs,
  zeroAddress,
  type Address,
  type Hash,
} from 'viem';
import { pixelBoardAbi } from './abi';
import { BoardView, type Cell } from './board';
import { ACTIVE } from './config';
import { PALETTE, swatch, textOn } from './palette';
import { closeMenu, isMenuOpen, openMenu, openWalletPicker, setupMenu } from './menu';
import { discoverWallets, walletById, walletId, type Wallet } from './wallet';

const { chain, contract, rpcUrl, explorer } = ACTIVE;

/** localStorage can throw (private mode, blocked storage): treat that as "nothing saved". */
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

const POLL_MS = 2_500; // how often we ask the chain for new pixels
const RESYNC_MS = 30_000; // full board re-read, in case a poll was missed
const HISTORY_SPANS = [20_000n, 2_000n]; // blocks to scan for the feed (~80 min, ~8 min at 250 ms blocks)
const MAX_LOG_RANGE = 5_000n;
const FEED_SIZE = 30;

type PaintLog = {
  args: { painter: Address; x: number; y: number; color: number };
  transactionHash: Hash;
  logIndex: number;
  blockNumber: bigint;
};
type FeedItem = { id: string; order: bigint; painter: Address; x: number; y: number; color: number; time: number | null };
type Tone = 'info' | 'ok' | 'error';
type Action = { label: string; disabled: boolean; kind: 'paint' | 'step' | 'idle' | 'cooldown'; run?: () => void };

const state = {
  ready: false,
  color: loadColor(),
  selected: null as Cell | null,
  hover: null as Cell | null,
  selectedPainter: undefined as Address | null | undefined, // undefined = still loading
  wallet: null as Wallet | null,
  account: null as Address | null,
  walletChainId: null as number | null,
  cooldown: 0,
  nextPaintAt: 0,
  myCount: 0,
  totalPainted: 0,
  totalPainters: 0,
  phase: 'idle' as 'idle' | 'switching' | 'signing' | 'pending',
  cursor: 0n, // last block whose events are applied
  seen: new Set<string>(),
  pixelOrder: new Map<number, bigint>(),
  feed: [] as FeedItem[],
  historyLoaded: false,
  online: true,
  status: { text: '', tone: 'info' as Tone, link: null as { href: string; label: string } | null },
};

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
const pixelBoard = { address: (contract ?? zeroAddress) as Address, abi: pixelBoardAbi } as const;
let view: BoardView | null = null;

// ─── Startup (init() is called at the very end of this file, once every constant exists) ─

async function init(): Promise<void> {
  $('net-name').textContent = chain.name;
  renderFooter();
  if (!contract) {
    showSetup(
      `There is no board on ${chain.name} yet. <a href="./deploy.html">Deploy the contract</a> from your wallet, then add its address to web/src/deployments.json.`,
    );
    return;
  }
  renderPalette();
  setColor(state.color);
  setupWallets();
  setupControls();
  render();
  if (!(await loadBoard())) return;

  setInterval(() => void poll(), POLL_MS);
  setInterval(() => void resync().catch(() => setOnline(false)), RESYNC_MS);
  setInterval(tick, 1_000);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) void catchUp();
  });
}

/** Reads the board, retrying while the RPC is unreachable. False if there is no board at that address. */
async function loadBoard(): Promise<boolean> {
  for (let attempt = 0; ; attempt++) {
    try {
      const [width, height, cooldown, latest] = await Promise.all([
        publicClient.readContract({ ...pixelBoard, functionName: 'WIDTH' }),
        publicClient.readContract({ ...pixelBoard, functionName: 'HEIGHT' }),
        publicClient.readContract({ ...pixelBoard, functionName: 'cooldown' }),
        publicClient.getBlockNumber({ cacheTime: 0 }),
      ]);
      view ??= new BoardView($('board'), width, height, { onHover, onSelect: select, onKey: onBoardKey });
      state.cooldown = Number(cooldown);
      state.cursor = latest;
      await resync();
      state.ready = true;
      setOnline(true);
      if (state.status.tone === 'error') setStatus('');
      render();
      void loadHistory(latest);
      return true;
    } catch (err) {
      if (err instanceof BaseError && err.walk((e) => e instanceof ContractFunctionZeroDataError)) {
        showSetup(`No PixelBoard contract found at ${contract} on ${chain.name}. Check the address in web/src/deployments.json.`);
        return false;
      }
      setOnline(false);
      setStatus(`Can't reach ${chain.name} right now. Trying again…`, 'error');
      await sleep(Math.min(15_000, 2_000 * 2 ** attempt));
    }
  }
}

/** Re-reads the whole board and the counters. */
async function resync(): Promise<void> {
  if (!view) return;
  const [board] = await Promise.all([
    publicClient.readContract({ ...pixelBoard, functionName: 'getBoard' }),
    refreshTotals(),
    refreshAccount(),
  ]);
  view.setAll(hexToBytes(board));
  render();
}

async function refreshTotals(): Promise<void> {
  const [painted, painters] = await Promise.all([
    publicClient.readContract({ ...pixelBoard, functionName: 'totalPainted' }),
    publicClient.readContract({ ...pixelBoard, functionName: 'totalPainters' }),
  ]);
  state.totalPainted = Number(painted);
  state.totalPainters = Number(painters);
}

async function refreshAccount(): Promise<void> {
  const account = state.account;
  if (!account) return;
  const [next, count] = await Promise.all([
    publicClient.readContract({ ...pixelBoard, functionName: 'nextPaintAt', args: [account] }),
    publicClient.readContract({ ...pixelBoard, functionName: 'paintCount', args: [account] }),
  ]);
  if (state.account !== account) return;
  state.nextPaintAt = Number(next);
  state.myCount = Number(count);
}

// ─── Live updates: poll PixelPainted events ────────────────────────────────────────────────

let polling = false;

async function poll(): Promise<void> {
  if (!state.ready || polling || document.hidden) return;
  polling = true;
  try {
    const latest = await publicClient.getBlockNumber({ cacheTime: 0 });
    if (latest > state.cursor) {
      const from = state.cursor + 1n;
      const to = latest - state.cursor > MAX_LOG_RANGE ? state.cursor + MAX_LOG_RANGE : latest;
      const logs = await publicClient.getContractEvents({
        ...pixelBoard,
        eventName: 'PixelPainted',
        fromBlock: from,
        toBlock: to,
        strict: true,
      });
      state.cursor = to;
      if (logs.length) {
        const now = Date.now();
        let mine = false;
        for (const log of logs) {
          if (applyEvent(log, now) && isMe(log.args.painter)) mine = true;
        }
        render(); // show the new pixels right away, counters follow
        await Promise.all([refreshTotals(), mine ? refreshAccount() : null]);
        render();
      }
    }
    setOnline(true);
  } catch {
    setOnline(false);
  } finally {
    polling = false;
  }
}

/** After the tab was hidden for a while: skip the gap and just re-read the board. */
async function catchUp(): Promise<void> {
  if (!state.ready) return;
  try {
    const latest = await publicClient.getBlockNumber({ cacheTime: 0 });
    if (latest - state.cursor > MAX_LOG_RANGE) state.cursor = latest;
    await resync();
    await poll();
  } catch {
    setOnline(false);
  }
}

/** Paints a pixel from an event and adds it to the feed. Returns false if we had it already. */
function applyEvent(log: PaintLog, time: number | null): boolean {
  if (!view || !addToFeed(log, time)) return false;
  const { x, y, color } = log.args;
  const index = y * view.width + x;
  const order = eventOrder(log);
  const previous = state.pixelOrder.get(index);
  if (previous === undefined || order > previous) {
    state.pixelOrder.set(index, order);
    view.setPixel(x, y, color);
    view.ripple(x, y);
  }
  if (state.selected?.x === x && state.selected?.y === y) state.selectedPainter = log.args.painter;
  return true;
}

function addToFeed(log: PaintLog, time: number | null): boolean {
  const id = `${log.transactionHash}:${log.logIndex}`;
  if (state.seen.has(id)) return false;
  state.seen.add(id);
  const { painter, x, y, color } = log.args;
  state.feed.push({ id, order: eventOrder(log), painter, x, y, color, time });
  state.feed.sort((a, b) => (b.order > a.order ? 1 : b.order < a.order ? -1 : 0));
  state.feed.length = Math.min(state.feed.length, FEED_SIZE);
  return true;
}

function eventOrder(log: PaintLog): bigint {
  return log.blockNumber * 100_000n + BigInt(log.logIndex);
}

/** Fills the feed with recent pixels. Public RPCs limit log ranges, so try a big window, then a small one. */
async function loadHistory(latest: bigint): Promise<void> {
  for (const span of HISTORY_SPANS) {
    try {
      const logs = await publicClient.getContractEvents({
        ...pixelBoard,
        eventName: 'PixelPainted',
        fromBlock: latest > span ? latest - span : 0n,
        toBlock: latest,
        strict: true,
      });
      const recent = logs.slice(-FEED_SIZE);
      // Block timestamps for the "5 min ago" labels, a few requests at a time to stay under RPC rate limits.
      const times = new Map<bigint, number>();
      const blocks = [...new Set(recent.map((l) => l.blockNumber))];
      for (let i = 0; i < blocks.length; i += 5) {
        await Promise.all(
          blocks.slice(i, i + 5).map(async (blockNumber) => {
            const block = await publicClient.getBlock({ blockNumber }).catch(() => null);
            if (block) times.set(blockNumber, Number(block.timestamp) * 1000);
          }),
        );
      }
      for (const log of recent) addToFeed(log, times.get(log.blockNumber) ?? null);
      state.historyLoaded = true;
      renderFeed();
      return;
    } catch {
      // range too large for this RPC, try the smaller one
    }
  }
}

// ─── Wallet ────────────────────────────────────────────────────────────────────────────────

const SAVED_WALLET = 'pixel-board:wallet';

function setupWallets(): void {
  discoverWallets((wallet) => {
    // Reconnect silently, but only to the wallet this browser connected before.
    if (!state.account && storage.get(SAVED_WALLET) === walletId(wallet)) void connect(wallet, true);
  });
  setTimeout(() => {
    const legacy = walletById('injected');
    if (!state.account && legacy && storage.get(SAVED_WALLET) === 'injected') void connect(legacy, true);
  }, 400);
}

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
    await refreshAccount();
    render();
  } catch (err) {
    if (!silent) setStatus(explain(err), 'error');
  }
}

function disconnect(): void {
  if (state.wallet) detach(state.wallet);
  state.wallet = null;
  state.account = null;
  state.walletChainId = null;
  state.nextPaintAt = 0;
  state.myCount = 0;
  storage.remove(SAVED_WALLET);
  closeMenu();
  render();
}

const onAccountsChanged = (accounts: readonly Address[]) => {
  if (!accounts.length) return disconnect();
  state.account = getAddress(accounts[0]);
  render();
  void refreshAccount().then(render);
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
  state.phase = 'switching';
  render();
  const walletClient = createWalletClient({ chain, transport: custom(wallet.provider) });
  try {
    await walletClient.switchChain({ id: chain.id });
  } catch (err) {
    if (isRejection(err)) {
      setStatus(explain(err), 'error');
    } else {
      // Usually "unknown chain": ask the wallet to add Robinhood Chain (most wallets switch right after).
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

// ─── Painting ──────────────────────────────────────────────────────────────────────────────

async function paint(): Promise<void> {
  const cell = state.selected;
  const { wallet, account } = state;
  if (!cell || !wallet || !account || !view || state.phase !== 'idle') return;
  const color = state.color;

  setStatus('');
  state.phase = 'signing';
  render();
  try {
    // Dry run first: a revert (e.g. cooldown) shows up here with a readable reason, before the wallet opens.
    const { request } = await publicClient.simulateContract({
      ...pixelBoard,
      functionName: 'paint',
      args: [cell.x, cell.y, color],
      account,
    });
    const walletClient = createWalletClient({ chain, transport: custom(wallet.provider) });
    const hash = await walletClient.writeContract(request);

    state.phase = 'pending';
    view.showPending(cell, color);
    setStatus('Sent. Waiting for the next block…', 'info', txLink(hash));
    render();

    const receipt = await publicClient.waitForTransactionReceipt({ hash, pollingInterval: 500 });
    if (receipt.status !== 'success') throw new Error('The transaction failed onchain. Nothing was painted.');
    for (const log of parseEventLogs({ abi: pixelBoardAbi, eventName: 'PixelPainted', logs: receipt.logs })) {
      applyEvent(log, Date.now());
    }
    setStatus(`Painted (${cell.x}, ${cell.y}).`, 'ok', txLink(hash));
    await Promise.all([refreshAccount(), refreshTotals()]);
  } catch (err) {
    setStatus(explain(err), 'error');
  } finally {
    state.phase = 'idle';
    view.showPending(null, 0);
    render();
  }
}

/** What the big button does right now. It always offers the next step towards painting. */
function primaryAction(): Action {
  if (!state.ready) return { label: 'Loading the board…', disabled: true, kind: 'idle' };
  if (!state.account) {
    return { label: 'Connect wallet', disabled: false, kind: 'step', run: () => openWalletPicker($('paint-btn'), (w) => void connect(w)) };
  }
  if (state.walletChainId !== chain.id) {
    const busy = state.phase === 'switching';
    return { label: busy ? 'Check your wallet…' : `Switch to ${chain.name}`, disabled: busy, kind: 'step', run: () => void switchNetwork() };
  }
  if (state.phase === 'signing') return { label: 'Confirm in your wallet…', disabled: true, kind: 'idle' };
  if (state.phase === 'pending') return { label: 'Painting…', disabled: true, kind: 'idle' };
  const wait = state.nextPaintAt - Math.floor(Date.now() / 1000);
  if (wait > 0) return { label: `Next pixel in ${countdown(wait)}`, disabled: true, kind: 'cooldown' };
  if (!state.selected) return { label: 'Select a pixel first', disabled: true, kind: 'idle' };
  return { label: `Paint (${state.selected.x}, ${state.selected.y})`, disabled: false, kind: 'paint', run: () => void paint() };
}

function explain(err: unknown): string {
  if (err instanceof BaseError) {
    if (isRejection(err)) return 'You declined the request in your wallet. Nothing was sent.';
    if (err.walk((e) => e instanceof InsufficientFundsError)) {
      return `Not enough ETH on ${chain.name} to pay for gas. Bridge a little ETH there and try again.`;
    }
    const revert = err.walk((e) => e instanceof ContractFunctionRevertedError);
    if (revert instanceof ContractFunctionRevertedError) {
      const name = revert.data?.errorName;
      if (name === 'CooldownActive') {
        state.nextPaintAt = Number(revert.data?.args?.[0] ?? 0);
        return `Your cooldown isn't over yet. You can paint again at ${clock(state.nextPaintAt)}.`;
      }
      if (name === 'OutOfBounds') return 'That pixel is outside the board.';
      if (name === 'InvalidColor') return 'That color is not in the palette.';
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

// ─── Board interaction ────────────────────────────────────────────────────────────────────

function select(cell: Cell): void {
  state.selected = cell;
  state.selectedPainter = undefined;
  render();
  void loadPainter(cell);
}

async function loadPainter(cell: Cell): Promise<void> {
  try {
    const [, painter] = await publicClient.readContract({ ...pixelBoard, functionName: 'getPixel', args: [cell.x, cell.y] });
    if (state.selected?.x !== cell.x || state.selected?.y !== cell.y) return;
    state.selectedPainter = painter === zeroAddress ? null : painter;
    renderPixelInfo();
  } catch {
    // leave it as "looking up"; selecting again retries
  }
}

function onHover(cell: Cell | null): void {
  state.hover = cell;
  renderPointer();
}

function onBoardKey(e: KeyboardEvent): void {
  if (!view) return;
  const step = e.shiftKey ? 8 : 1;
  const moves: Record<string, [number, number]> = {
    ArrowLeft: [-step, 0],
    ArrowRight: [step, 0],
    ArrowUp: [0, -step],
    ArrowDown: [0, step],
  };
  const move = moves[e.key];
  if (move) {
    e.preventDefault();
    const from = state.selected ?? { x: Math.floor(view.width / 2), y: Math.floor(view.height / 2) };
    const [dx, dy] = state.selected ? move : [0, 0];
    select({ x: clamp(from.x + dx, 0, view.width - 1), y: clamp(from.y + dy, 0, view.height - 1) });
  } else if (e.key === 'Enter') {
    e.preventDefault();
    const action = primaryAction();
    if (!action.disabled) action.run?.();
  } else if (e.key === 'Escape') {
    state.selected = null;
    render();
  }
}

function setColor(index: number): void {
  state.color = index;
  storage.set('pixel-board:color', String(index));
  const root = document.documentElement.style;
  root.setProperty('--brush', swatch(index).hex);
  root.setProperty('--brush-text', textOn(index));
  render();
}

function loadColor(): number {
  const saved = storage.get('pixel-board:color');
  const n = saved === null ? NaN : Number(saved);
  return Number.isInteger(n) && n >= 0 && n < PALETTE.length ? n : 5; // default: Poppy
}

// ─── Rendering ────────────────────────────────────────────────────────────────────────────

function render(): void {
  renderAccount();
  renderPaletteState();
  renderPointer();
  renderPixelInfo();
  renderButton();
  renderStatus();
  renderStats();
  renderFeed();
}

function renderPalette(): void {
  const root = $('palette');
  root.replaceChildren(
    ...PALETTE.map((s) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'swatch';
      b.style.setProperty('--c', s.hex);
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-label', s.name);
      b.title = s.name;
      b.addEventListener('click', () => setColor(s.index));
      return b;
    }),
  );
  // Arrow keys move through the palette (one tab stop for the whole group).
  root.addEventListener('keydown', (e) => {
    const cols = 8;
    const delta = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -cols, ArrowDown: cols }[e.key];
    if (delta === undefined) return;
    e.preventDefault();
    setColor((state.color + delta + PALETTE.length) % PALETTE.length);
    (root.children[state.color] as HTMLElement).focus();
  });
}

function renderPaletteState(): void {
  const buttons = $('palette').children;
  for (let i = 0; i < buttons.length; i++) {
    const checked = i === state.color;
    buttons[i].setAttribute('aria-checked', String(checked));
    buttons[i].setAttribute('tabindex', checked ? '0' : '-1');
  }
  $('color-name').textContent = swatch(state.color).name;
}

function renderPointer(): void {
  if (!view) return;
  const { hover, selected, color } = state;
  const onSelected = hover && selected && hover.x === selected.x && hover.y === selected.y;
  view.showHover(onSelected ? null : hover, color);
  view.showSelection(selected, color);
  const focus = hover ?? selected;
  view.markRulers(focus, color);
  $('readout').textContent = focus ? `${focus.x},${focus.y}` : '';
}

function renderPixelInfo(): void {
  const el = $('pixel-info');
  const cell = state.selected;
  if (!cell || !view) {
    el.innerHTML = '<p class="hint">Click a pixel on the board to select it. Arrow keys work too.</p>';
    return;
  }
  const now = swatch(view.colorAt(cell));
  let who = 'Looking up who painted it…';
  if (state.selectedPainter === null) who = 'Nobody has painted it yet.';
  else if (state.selectedPainter) who = `Last painted by ${isMe(state.selectedPainter) ? 'you' : addressLink(state.selectedPainter)}.`;
  el.innerHTML = `
    <p class="coord">(${cell.x}, ${cell.y})</p>
    <p class="now"><span class="chip" style="--c:${now.hex}"></span>Now ${now.name.toLowerCase()}. ${who}</p>`;
}

function renderButton(): void {
  const btn = $<HTMLButtonElement>('paint-btn');
  const action = primaryAction();
  btn.textContent = action.label;
  btn.disabled = action.disabled;
  btn.dataset.kind = action.kind;
  if (action.kind === 'cooldown' && state.cooldown > 0) {
    // The strip along the bottom of the button fills up as the cooldown runs out.
    const left = state.nextPaintAt - Date.now() / 1000;
    btn.style.setProperty('--progress', `${clamp(100 - (left / state.cooldown) * 100, 0, 100)}%`);
  }
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

function renderStats(): void {
  const el = $('stats');
  if (!state.ready) {
    el.textContent = 'Loading the board…';
    return;
  }
  const p = state.totalPainted;
  const n = state.totalPainters;
  if (p === 0) {
    el.textContent = 'Nobody has painted yet. The first pixel can be yours.';
    return;
  }
  let text = `${fmt(p)} ${p === 1 ? 'pixel' : 'pixels'} painted by ${fmt(n)} ${n === 1 ? 'painter' : 'painters'} so far.`;
  if (state.account) {
    const m = state.myCount;
    text += m === 0 ? ' None of them are yours yet.' : m === 1 ? ' One of them is yours.' : ` ${fmt(m)} of them are yours.`;
  }
  el.textContent = text;
}

function renderFeed(): void {
  const list = $('feed');
  if (!state.feed.length) {
    const text = state.historyLoaded
      ? 'Nothing painted recently. New pixels show up here as they land.'
      : 'New pixels show up here as they land.';
    list.innerHTML = `<li class="empty">${text}</li>`;
    return;
  }
  list.innerHTML = state.feed
    .map(
      (item) => `
      <li><button type="button" data-x="${item.x}" data-y="${item.y}" title="Select (${item.x}, ${item.y})">
        <span class="chip" style="--c:${swatch(item.color).hex}"></span>
        <span class="what"><b>${isMe(item.painter) ? 'You' : short(item.painter)}</b> painted (${item.x}, ${item.y})</span>
        <time>${item.time ? timeAgo(item.time) : ''}</time>
      </button></li>`,
    )
    .join('');
}

function renderAccount(): void {
  const btn = $('account-btn');
  btn.textContent = state.account ? short(state.account) : 'Connect wallet';
  btn.setAttribute('aria-expanded', String(isMenuOpen()));
}

function renderFooter(): void {
  const foot = $('foot');
  if (!contract) {
    foot.textContent = '';
    return;
  }
  const where = explorer
    ? `<a href="${explorer}/address/${contract}" target="_blank" rel="noopener">${short(contract)}</a>`
    : short(contract);
  foot.innerHTML = `Board contract ${where} on ${chain.name}. No tokens and no fees: every pixel is one transaction, and you only pay gas.`;
}

function showSetup(html: string): void {
  $('app').hidden = true;
  const box = $('setup');
  box.hidden = false;
  box.innerHTML = html; // only our own strings and hex addresses end up here
}

function setStatus(text: string, tone: Tone = 'info', link: { href: string; label: string } | null = null): void {
  state.status = { text, tone, link };
  renderStatus();
}

function setOnline(online: boolean): void {
  if (state.online === online) return;
  state.online = online;
  const net = $('net');
  net.dataset.online = String(online);
  net.title = online ? `Connected to ${chain.name}` : `Can't reach ${chain.name} right now`;
}

let ticks = 0;
function tick(): void {
  ticks++;
  if (state.nextPaintAt * 1000 > Date.now() - 1000) renderButton();
  if (ticks % 10 === 0) renderFeed();
}

// ─── Controls and menus ───────────────────────────────────────────────────────────────────

function setupControls(): void {
  $('paint-btn').addEventListener('click', (e) => {
    e.stopPropagation(); // otherwise the document click handler closes the wallet menu right away
    primaryAction().run?.();
  });
  $('account-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    if (isMenuOpen()) return closeMenu();
    if (state.account) openAccountMenu();
    else openWalletPicker($('account-btn'), (w) => void connect(w));
  });
  $('feed').addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-x]');
    if (b) select({ x: Number(b.dataset.x), y: Number(b.dataset.y) });
  });
  $<HTMLInputElement>('grid-toggle').addEventListener('change', (e) => {
    $('board').classList.toggle('no-grid', !(e.target as HTMLInputElement).checked);
  });
  setupMenu(renderAccount);
}

function openAccountMenu(): void {
  const account = state.account;
  if (!account) return;
  const items = [
    { label: 'Copy address', run: () => void navigator.clipboard.writeText(account).then(closeMenu) },
    ...(explorer ? [{ label: 'View on Blockscout', run: () => void window.open(`${explorer}/address/${account}`, '_blank', 'noopener') }] : []),
    { label: 'Disconnect', run: disconnect },
  ];
  openMenu($('account-btn'), `${short(account)} via ${state.wallet?.info.name ?? 'wallet'}`, items);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────────────────

function isMe(address: Address | null | undefined): boolean {
  return Boolean(address && state.account && address.toLowerCase() === state.account.toLowerCase());
}

function short(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function addressLink(address: Address): string {
  const text = `<span class="addr">${short(address)}</span>`;
  return explorer ? `<a href="${explorer}/address/${address}" target="_blank" rel="noopener">${text}</a>` : text;
}

function txLink(hash: Hash): { href: string; label: string } | null {
  return explorer ? { href: `${explorer}/tx/${hash}`, label: 'View transaction' } : null;
}

function fmt(n: number): string {
  return n.toLocaleString('en-US');
}

function countdown(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

function clock(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function timeAgo(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 10) return 'just now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(ms).toLocaleDateString();
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

void init();
