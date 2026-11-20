import { isAddress as isEvmAddress } from 'ethers';
import { PublicKey } from '@solana/web3.js';
import { validateStacksAddress } from '@stacks/transactions';
import { StrKey } from '@stellar/stellar-sdk';
import TronWeb from 'tronweb';

import type { CoreGateway, CoreToken } from './core-gateway.js';
import { normalizeSymbol } from './utils.js';
import { UserFacingToolError } from './tool-errors.js';

/** Chain families this server can build and broadcast transactions for. */
export const SUPPORTED_CHAIN_TYPES: ReadonlySet<string> = new Set(['EVM', 'SOLANA', 'TRX', 'STX', 'SRB']);

export const COMMON_CHAIN_ALIASES: Record<string, string> = {
  ETHEREUM: 'ETH',
  TRON: 'TRX',
  SOLANA: 'SOL',
  STACKS: 'STX',
  STELLAR: 'SRB',
  SOROBAN: 'SRB',
  ARBITRUM: 'ARB',
  OPTIMISM: 'OPT',
  BASE: 'BAS',
  BNB: 'BSC',
  BNBCHAIN: 'BSC',
  BINANCE: 'BSC',
  CELO: 'CEL',
  POLYGON: 'POL',
  MATIC: 'POL',
  AVALANCHE: 'AVA',
  AVAX: 'AVA',
  UNICHAIN: 'UNI',
  SONIC: 'SNC',
  LINEA: 'LIN',
};

function normalizeLookupKey(value: string): string {
  return value.trim().toUpperCase().replace(/[^A-Z0-9]+/g, '');
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

function buildChainAliases(chainSymbol: string, chainName?: string, chainType?: string): string[] {
  const aliases = [
    chainSymbol,
    chainName,
    chainType,
    COMMON_CHAIN_ALIASES[normalizeLookupKey(chainSymbol)],
    chainName ? COMMON_CHAIN_ALIASES[normalizeLookupKey(chainName)] : undefined,
    chainType ? COMMON_CHAIN_ALIASES[normalizeLookupKey(chainType)] : undefined,
  ];

  return uniqueStrings(aliases);
}

export type ChainCatalogEntry = {
  chainSymbol: string;
  chainName: string | null;
  chainType: string | null;
  aliases: string[];
  tokens: CoreToken[];
};

export type ChainCatalog = {
  chains: ChainCatalogEntry[];
  byLookup: Map<string, ChainCatalogEntry>;
  tokens: CoreToken[];
};

export type ResolvedTokenSelection = {
  chain: ChainCatalogEntry;
  token: CoreToken;
};

export async function loadChainCatalog(gateway: Pick<CoreGateway, 'getTokens'>): Promise<ChainCatalog> {
  const tokens = (await gateway.getTokens()).filter((token) => SUPPORTED_CHAIN_TYPES.has(String(token.chainType)));
  const chainsBySymbol = new Map<string, ChainCatalogEntry>();

  for (const token of tokens) {
    const chainSymbol = token.chainSymbol.trim().toUpperCase();
    const existing = chainsBySymbol.get(chainSymbol);

    if (existing) {
      existing.tokens.push(token);
      if (!existing.chainName && token.chainName) {
        existing.chainName = token.chainName;
      }
      if (!existing.chainType && token.chainType) {
        existing.chainType = token.chainType;
      }
      continue;
    }

    chainsBySymbol.set(chainSymbol, {
      chainSymbol,
      chainName: token.chainName ?? null,
      chainType: token.chainType ?? null,
      aliases: buildChainAliases(chainSymbol, token.chainName, token.chainType),
      tokens: [token],
    });
  }

  const chains = [...chainsBySymbol.values()].sort((left, right) => left.chainSymbol.localeCompare(right.chainSymbol));
  const byLookup = new Map<string, ChainCatalogEntry>();

  for (const chain of chains) {
    for (const alias of chain.aliases) {
      byLookup.set(normalizeLookupKey(alias), chain);
    }
  }

  return {
    chains,
    byLookup,
    tokens,
  };
}

export function summarizeSupportedChains(catalog: ChainCatalog) {
  return catalog.chains.map((chain) => ({
    chainSymbol: chain.chainSymbol,
    chainName: chain.chainName,
    chainType: chain.chainType,
    tokenCount: chain.tokens.length,
    aliases: chain.aliases,
  }));
}

export function summarizeSupportedTokens(tokens: CoreToken[]) {
  return tokens.map((token) => ({
    symbol: token.symbol,
    name: token.name,
    tokenAddress: token.tokenAddress,
    decimals: token.decimals,
    chainSymbol: token.chainSymbol,
    chainName: token.chainName ?? null,
    chainType: token.chainType ?? null,
    isNative: token.isNative === true,
  }));
}

export function resolveChainFromCatalog(
  catalog: ChainCatalog,
  chainInput: string | null | undefined,
  fieldName: string,
): ChainCatalogEntry {
  const value = typeof chainInput === 'string' ? chainInput.trim() : '';

  if (!value) {
    throw new UserFacingToolError('missing_input', `${fieldName} is required.`, {
      field: fieldName,
      supportedChains: summarizeSupportedChains(catalog),
    });
  }

  const normalized = normalizeLookupKey(value);
  const alias = catalog.byLookup.get(normalized);
  if (alias) {
    return alias;
  }

  const fallbackSymbol = COMMON_CHAIN_ALIASES[normalized];
  if (fallbackSymbol) {
    const symbolMatch = catalog.byLookup.get(normalizeLookupKey(fallbackSymbol));
    if (symbolMatch) {
      return symbolMatch;
    }
  }

  throw new UserFacingToolError('unsupported_chain', `Unsupported chain ${value}.`, {
    field: fieldName,
    input: value,
    supportedChains: summarizeSupportedChains(catalog),
  });
}

export function resolveTokenForChain(
  catalog: ChainCatalog,
  chainInput: string | null | undefined,
  tokenAddress: string | null | undefined,
  tokenSymbol: string | null | undefined,
  fieldNames: {
    chain: string;
    tokenAddress: string;
    tokenSymbol: string;
  },
): ResolvedTokenSelection {
  const chain = resolveChainFromCatalog(catalog, chainInput, fieldNames.chain);

  if (tokenAddress && tokenAddress.trim()) {
    const normalizedAddress = tokenAddress.trim().toLowerCase();
    const token = chain.tokens.find((candidate) => candidate.tokenAddress.toLowerCase() === normalizedAddress);

    if (!token) {
      throw new UserFacingToolError('unsupported_token', `Token ${tokenAddress} is not available on ${chain.chainSymbol}.`, {
        field: fieldNames.tokenAddress,
        chainSymbol: chain.chainSymbol,
        chainName: chain.chainName,
        supportedTokens: summarizeSupportedTokens(chain.tokens),
      });
    }

    return { chain, token };
  }

  if (!tokenSymbol || !tokenSymbol.trim()) {
    throw new UserFacingToolError('missing_input', `${fieldNames.tokenSymbol} is required.`, {
      field: fieldNames.tokenSymbol,
      chainSymbol: chain.chainSymbol,
      supportedTokens: summarizeSupportedTokens(chain.tokens),
    });
  }

  const normalizedSymbol = normalizeSymbol(tokenSymbol);
  const matchingTokens = chain.tokens.filter((candidate) => normalizeSymbol(candidate.symbol) === normalizedSymbol);

  if (matchingTokens.length > 1) {
    throw new UserFacingToolError('ambiguous_token', `Token ${tokenSymbol} is ambiguous on ${chain.chainSymbol}.`, {
      field: fieldNames.tokenSymbol,
      chainSymbol: chain.chainSymbol,
      chainName: chain.chainName,
      tokenSymbol: tokenSymbol.trim(),
      matchingTokens: summarizeSupportedTokens(matchingTokens),
      supportedTokens: summarizeSupportedTokens(chain.tokens),
      nextAction: 'Use the exact token address to disambiguate this token on the selected chain.',
    });
  }

  const token = matchingTokens[0];

  if (!token) {
    throw new UserFacingToolError('unsupported_token', `Token ${tokenSymbol} is not available on ${chain.chainSymbol}.`, {
      field: fieldNames.tokenSymbol,
      chainSymbol: chain.chainSymbol,
      chainName: chain.chainName,
      supportedTokens: summarizeSupportedTokens(chain.tokens),
    });
  }

  return { chain, token };
}

/**
 * Resolves a token by address. Native currencies of EVM chains share a placeholder address, so pass
 * `chainInput` to pick the chain when an address exists on several chains.
 */
export function resolveTokenByAddressFromCatalog(
  catalog: ChainCatalog,
  tokenAddress: string | null | undefined,
  fieldName: string,
  chainInput?: string | null,
  chainFieldName = 'chain',
): CoreToken {
  const value = typeof tokenAddress === 'string' ? tokenAddress.trim() : '';

  if (!value) {
    throw new UserFacingToolError('missing_input', `${fieldName} is required.`, {
      field: fieldName,
      supportedTokens: summarizeSupportedTokens(catalog.tokens),
    });
  }

  const chain = typeof chainInput === 'string' && chainInput.trim()
    ? resolveChainFromCatalog(catalog, chainInput, chainFieldName)
    : null;
  const candidates = chain ? chain.tokens : catalog.tokens;
  const normalizedAddress = value.toLowerCase();
  const matches = candidates.filter((candidate) => candidate.tokenAddress.toLowerCase() === normalizedAddress);

  if (matches.length > 1) {
    throw new UserFacingToolError('ambiguous_token', `Token address ${value} exists on several chains.`, {
      field: fieldName,
      input: value,
      chains: matches.map((candidate) => candidate.chainSymbol),
      nextAction: `Pass ${chainFieldName} to choose the chain.`,
    });
  }

  const token = matches[0];
  if (!token) {
    throw new UserFacingToolError('unsupported_token', chain
      ? `Token ${value} is not available on ${chain.chainSymbol}.`
      : `Token ${value} is not supported by this server.`, {
      field: fieldName,
      input: value,
      supportedTokens: summarizeSupportedTokens(chain ? chain.tokens : catalog.tokens),
    });
  }

  return token;
}

export function validateAddressForChainType(
  address: string | null | undefined,
  chainType: string | null | undefined,
  fieldName: string,
): void {
  const value = typeof address === 'string' ? address.trim() : '';

  if (!value) {
    throw new UserFacingToolError('missing_input', `${fieldName} is required.`, { field: fieldName });
  }

  const normalizedType = chainType?.trim().toUpperCase();
  let valid = true;
  let validator = 'non-empty';

  switch (normalizedType) {
    case 'EVM':
      validator = 'ethers.isAddress';
      valid = isEvmAddress(value);
      break;
    case 'SOLANA':
      validator = 'Solana PublicKey';
      try {
        new PublicKey(value);
        valid = true;
      } catch {
        valid = false;
      }
      break;
    case 'TRX':
      validator = 'TronWeb.utils.address.isAddress';
      valid = typeof TronWeb.utils?.address?.isAddress === 'function'
        ? TronWeb.utils.address.isAddress(value)
        : false;
      break;
    case 'STX':
      validator = 'validateStacksAddress';
      valid = validateStacksAddress(value);
      break;
    case 'SRB':
      validator = 'StrKey.isValidEd25519PublicKey / StrKey.isValidContract';
      valid = StrKey.isValidEd25519PublicKey(value) || StrKey.isValidContract(value);
      break;
    default:
      valid = value.length > 0;
      break;
  }

  if (!valid) {
    throw new UserFacingToolError('invalid_address', `Address ${value} is not valid for ${chainType ?? 'this chain type'}.`, {
      field: fieldName,
      address: value,
      chainType: chainType ?? null,
      validator,
    });
  }
}
