export const MESSENGERS = [
  'ALLBRIDGE',
  'WORMHOLE',
  'CCTP',
  'CCTP_V2',
  'OFT',
  'X_RESERVE',
] as const;

export const FEE_PAYMENT_METHODS = [
  'WITH_NATIVE_CURRENCY',
  'WITH_STABLECOIN',
  'WITH_ABR',
] as const;

export const TOKEN_TYPES = ['swap', 'pool', 'yield'] as const;
export const AMOUNT_UNITS = ['human', 'base'] as const;
export const OUTPUT_FORMATS = ['json', 'base64', 'hex'] as const;

/**
 * Symbol overrides for chains that are named differently in Core vs NEXT.
 * Empty map means 1:1 (most chains). Add entries only when a real divergence is found.
 * Keys are case-insensitive; the helper normalizes the input.
 */
export const CORE_TO_NEXT_CHAIN_SYMBOL: Readonly<Record<string, string>> = Object.freeze({});

export function coreToNextChainSymbol(coreSymbol: string): string {
  return CORE_TO_NEXT_CHAIN_SYMBOL[coreSymbol.toUpperCase()] ?? coreSymbol;
}
