import type { CoreToken } from './core-gateway.js';

const NATIVE_DECIMALS_BY_CHAIN_TYPE: Readonly<Record<string, number>> = {
  EVM: 18,
  SOLANA: 9,
  TRX: 6,
  SRB: 7,
  STX: 6,
};

const NATIVE_SYMBOL_BY_CHAIN: Readonly<Record<string, string>> = {
  ETH: 'ETH',
  ARB: 'ETH',
  OPT: 'ETH',
  BAS: 'ETH',
  UNI: 'ETH',
  LIN: 'ETH',
  BSC: 'BNB',
  POL: 'POL',
  AVA: 'AVAX',
  CEL: 'CELO',
  SNC: 'S',
  SOL: 'SOL',
  TRX: 'TRX',
  SRB: 'XLM',
  STX: 'STX',
};

/** Decimals of the native currency of the token's chain. */
export function nativeDecimals(token: Pick<CoreToken, 'chainType'>): number {
  const decimals = NATIVE_DECIMALS_BY_CHAIN_TYPE[String(token.chainType)];
  if (decimals === undefined) {
    throw new Error(`Unknown native currency decimals for chain type ${String(token.chainType)}.`);
  }
  return decimals;
}

export function nativeSymbol(token: Pick<CoreToken, 'chainSymbol'>): string | null {
  return NATIVE_SYMBOL_BY_CHAIN[token.chainSymbol] ?? null;
}
