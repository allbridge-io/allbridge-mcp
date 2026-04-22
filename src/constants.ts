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
