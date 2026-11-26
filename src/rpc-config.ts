import { nodeRpcUrlsDefault } from '@allbridge/bridge-core-sdk';

/**
 * Public RPC endpoints used when no `ALLBRIDGE_<CHAIN>_RPC_URL` override is set.
 * They are rate limited: operators should configure their own RPC for every chain they use.
 * Non-EVM defaults come from the Allbridge Core SDK (`nodeRpcUrlsDefault`).
 */
const DEFAULT_EVM_RPC_URLS: Readonly<Record<string, string>> = Object.freeze({
  ETH: 'https://ethereum-rpc.publicnode.com',
  BSC: 'https://bsc-dataseed.binance.org',
  POL: 'https://polygon-bor-rpc.publicnode.com',
  ARB: 'https://arb1.arbitrum.io/rpc',
  OPT: 'https://mainnet.optimism.io',
  AVA: 'https://api.avax.network/ext/bc/C/rpc',
  BAS: 'https://mainnet.base.org',
  CEL: 'https://forno.celo.org',
  SNC: 'https://rpc.soniclabs.com',
  UNI: 'https://mainnet.unichain.org',
  LIN: 'https://rpc.linea.build',
});

/** EVM chain ids of the chains above, to find the RPC of a signed transaction that carries only its chain id. */
const EVM_CHAIN_SYMBOLS_BY_ID: Readonly<Record<number, string>> = Object.freeze({
  1: 'ETH',
  56: 'BSC',
  137: 'POL',
  42161: 'ARB',
  10: 'OPT',
  43114: 'AVA',
  8453: 'BAS',
  42220: 'CEL',
  146: 'SNC',
  130: 'UNI',
  59144: 'LIN',
});

export function evmChainSymbolById(chainId: number): string | undefined {
  return EVM_CHAIN_SYMBOLS_BY_ID[chainId];
}

const SUPPORTED_NON_EVM_CHAINS = ['SOL', 'TRX', 'SRB', 'STLR', 'STX', 'SUI'] as const;

export const STELLAR_MAINNET_PASSPHRASE = 'Public Global Stellar Network ; September 2015';

function readEnvUrl(env: NodeJS.ProcessEnv, chainSymbol: string): string | undefined {
  const value = env[`ALLBRIDGE_${chainSymbol}_RPC_URL`]?.trim();
  return value ? value : undefined;
}

/**
 * RPC URLs keyed by Allbridge chain symbol: the defaults merged with `ALLBRIDGE_<CHAIN>_RPC_URL`
 * overrides. Any chain symbol can be overridden, including chains added to the Core API later.
 */
export function resolveRpcUrls(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const urls: Record<string, string> = { ...DEFAULT_EVM_RPC_URLS };

  for (const chainSymbol of SUPPORTED_NON_EVM_CHAINS) {
    const fallback = nodeRpcUrlsDefault[chainSymbol];
    if (fallback) {
      urls[chainSymbol] = fallback;
    }
  }

  for (const [name, value] of Object.entries(env)) {
    const match = /^ALLBRIDGE_([A-Z0-9]+)_RPC_URL$/.exec(name);
    const chainSymbol = match?.[1];
    if (chainSymbol && value?.trim()) {
      urls[chainSymbol] = value.trim();
    }
  }

  return urls;
}

export function resolveRpcUrl(chainSymbol: string, env: NodeJS.ProcessEnv = process.env): string {
  const symbol = chainSymbol.trim().toUpperCase();
  const url = readEnvUrl(env, symbol) ?? resolveRpcUrls(env)[symbol];
  if (!url) {
    throw new Error(`No RPC URL for chain ${symbol}. Set ALLBRIDGE_${symbol}_RPC_URL.`);
  }
  return url;
}
