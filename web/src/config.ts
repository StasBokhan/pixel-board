import { defineChain, type Address } from 'viem';
import deployments from './deployments.json';

export type NetworkKey = 'mainnet' | 'testnet' | 'anvil';

// ─── 1. Contract addresses live in deployments.json (the deploy page tells you what to put there) ─
export const CONTRACTS: Record<NetworkKey, Address | ''> = {
  mainnet: deployments.mainnet.address as Address | '',
  testnet: deployments.testnet.address as Address | '',
  // First contract deployed by anvil's default account, so `npm run dev:anvil` just works.
  anvil: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
};

// ─── 2. Which network the board page shows ─────────────────────────────────────────────────────
// Mainnet as soon as it has an address, testnet before that. `?network=testnet` in the URL or
// VITE_NETWORK in an .env file override it.

// Values from https://docs.robinhood.com/chain/connecting
export const robinhood = defineChain({
  id: 4663,
  name: 'Robinhood Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: ['https://rpc.mainnet.chain.robinhood.com'] } },
  blockExplorers: { default: { name: 'Blockscout', url: 'https://robinhoodchain.blockscout.com' } },
});

export const robinhoodTestnet = defineChain({
  id: 46630,
  name: 'Robinhood Chain Testnet',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: ['https://rpc.testnet.chain.robinhood.com'] } },
  blockExplorers: { default: { name: 'Blockscout', url: 'https://explorer.testnet.chain.robinhood.com' } },
  testnet: true,
});

export const anvil = defineChain({
  id: 31337,
  name: 'Local Anvil',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: ['http://127.0.0.1:8545'] } },
  testnet: true,
});

export const CHAINS = { mainnet: robinhood, testnet: robinhoodTestnet, anvil } as const;

export const ENV_NETWORK = import.meta.env.VITE_NETWORK as string | undefined;

function pickNetwork(): NetworkKey {
  const fromUrl = new URLSearchParams(window.location.search).get('network');
  if (fromUrl && fromUrl in CHAINS) return fromUrl as NetworkKey;
  if (ENV_NETWORK && ENV_NETWORK in CHAINS) return ENV_NETWORK as NetworkKey;
  return CONTRACTS.mainnet ? 'mainnet' : 'testnet';
}

const key = pickNetwork();
const chain = CHAINS[key];

export const ACTIVE = {
  key,
  chain,
  contract: CONTRACTS[key] || null,
  rpcUrl: (import.meta.env.VITE_RPC_URL as string | undefined) || chain.rpcUrls.default.http[0],
  explorer: chain.blockExplorers?.default.url ?? null,
};
