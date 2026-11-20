/**
 * Test double for `@allbridge/bridge-core-sdk`. Unit tests exercise the MCP logic against a mocked
 * CoreGateway, so they need only the SDK's enums, error classes and route helpers, not the SDK
 * itself (its Stellar dependency chain is ESM-only and cannot load under Jest's CommonJS runtime).
 * Values mirror @allbridge/bridge-core-sdk 3.38.0.
 */
export enum Messenger {
  ALLBRIDGE = 1,
  WORMHOLE = 2,
  CCTP = 3,
  CCTP_V2 = 4,
  OFT = 5,
  X_RESERVE = 6,
  NEAR_INTENTS = 7,
  LIFI_INTENTS = 8,
}

export enum FeePaymentMethod {
  WITH_NATIVE_CURRENCY = 'native',
  WITH_STABLECOIN = 'stablecoin',
  WITH_ABR = 'abr',
}

export const nodeRpcUrlsDefault: Record<string, string> = {
  SOL: 'https://api.mainnet-beta.solana.com',
  TRX: 'https://api.trongrid.io',
  SRB: 'https://rpc.stellar.org:443',
  STLR: 'https://horizon.stellar.org',
  SUI: 'https://fullnode.mainnet.sui.io',
  STX: 'https://api.hiro.so',
};

export const mainnet = { coreApiUrl: 'https://api.core.allbridge.io', coreApiHeaders: {} };

export class AllbridgeCoreSdk {
  constructor() {
    throw new Error('AllbridgeCoreSdk is not available in unit tests; use a CoreGateway mock.');
  }
}

export abstract class SdkRootError extends Error {
  constructor(public errorCode: string, message?: string) {
    super(message);
  }
}

export class SdkError extends SdkRootError {
  constructor(message?: string) {
    super('SdkError', message);
  }
}

export class NodeRpcUrlNotInitializedError extends SdkRootError {
  constructor(message?: string) {
    super('NodeRpcUrlNotInitializedError', message);
  }
}

export class CCTPDoesNotSupportedError extends SdkRootError {
  constructor(message?: string) {
    super('CCTPDoesNotSupportedError', message);
  }
}

export class OFTDoesNotSupportedError extends SdkRootError {
  constructor(message?: string) {
    super('OFTDoesNotSupportedError', message);
  }
}

export class NearIntentsDoesNotSupportedError extends SdkRootError {
  constructor(message?: string) {
    super('NearIntentsDoesNotSupportedError', message);
  }
}

export class NearIntentsAmountTooLowError extends SdkRootError {
  constructor(message?: string, public minAmount?: string, public minAmountUsd?: string) {
    super('NearIntentsAmountTooLowError', message);
  }
}

export class NearIntentsNoLiquidityError extends SdkRootError {
  constructor(message?: string) {
    super('NearIntentsNoLiquidityError', message);
  }
}

export class NearIntentsQuoteError extends SdkRootError {
  constructor(message?: string) {
    super('NearIntentsQuoteError', message);
  }
}

export class LifiIntentsDoesNotSupportedError extends SdkRootError {
  constructor(message?: string) {
    super('LifiIntentsDoesNotSupportedError', message);
  }
}

export class LifiIntentsAmountTooLowError extends SdkRootError {
  constructor(message?: string, public minAmount?: string) {
    super('LifiIntentsAmountTooLowError', message);
  }
}

export class LifiIntentsAmountTooHighError extends SdkRootError {
  constructor(message?: string, public maxAmount?: string) {
    super('LifiIntentsAmountTooHighError', message);
  }
}

export class LifiIntentsNoQuoteError extends SdkRootError {
  constructor(message?: string) {
    super('LifiIntentsNoQuoteError', message);
  }
}

export class LifiIntentsQuoteError extends SdkRootError {
  constructor(message?: string) {
    super('LifiIntentsQuoteError', message);
  }
}

type LifiRouteToken = {
  chainSymbol: string;
  chainType: string;
  tokenAddress: string;
  lifiIntents?: { bridgeAddress?: string; destinations?: Record<string, string[]> };
};

/** Copy of the SDK 3.38.0 rule: EVM or Solana source listing the destination token among its destinations. */
export function isLifiIntentsRouteSupported(sourceToken: LifiRouteToken, destinationToken: LifiRouteToken): boolean {
  if (!['EVM', 'SOLANA'].includes(sourceToken.chainType) || sourceToken.chainSymbol === destinationToken.chainSymbol) {
    return false;
  }
  if (!sourceToken.lifiIntents?.bridgeAddress) {
    return false;
  }
  const destinations = sourceToken.lifiIntents.destinations?.[destinationToken.chainSymbol] ?? [];
  const normalize = (address: string) => (destinationToken.chainType === 'EVM' ? address.toLowerCase() : address);
  return destinations.some((address) => normalize(address) === normalize(destinationToken.tokenAddress));
}
