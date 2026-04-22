import algosdk from 'algosdk';
import { isAddress as isEvmAddress } from 'ethers';
import { PublicKey } from '@solana/web3.js';
import { isValidSuiAddress } from '@mysten/sui/utils';
import { validateStacksAddress } from '@stacks/transactions';
import { StrKey } from '@stellar/stellar-sdk';
import TronWeb from 'tronweb';

import type { AllbridgeApiClient } from './allbridge-api-client.js';
import { normalizeSymbol } from './utils.js';
import type { TokenWithChainDetails } from './types.js';
import { UserFacingToolError } from './tool-errors.js';

const COMMON_CHAIN_ALIASES: Record<string, string> = {
  ETHEREUM: 'ETH',
  TRON: 'TRX',
  TRX: 'TRX',
  SOLANA: 'SOL',
  STACKS: 'STX',
  STELLAR: 'SRB',
  SOROBAN: 'SRB',
  ALGORAND: 'ALG',
  SUI: 'SUI',
  ARBITRUM: 'ARB',
  OPTIMISM: 'OPT',
  BASE: 'BASE',
  BNB: 'BNB',
  CELO: 'CELO',
  POLYGON: 'POL',
  MATIC: 'POL',
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
  tokens: TokenWithChainDetails[];
};

export type ChainCatalog = {
  chains: ChainCatalogEntry[];
  byLookup: Map<string, ChainCatalogEntry>;
  tokens: TokenWithChainDetails[];
};

export type ResolvedTokenSelection = {
  chain: ChainCatalogEntry;
  token: TokenWithChainDetails;
};

export async function loadChainCatalog(
  client: AllbridgeApiClient,
  tokenType: 'swap' | 'pool' | 'yield' = 'swap',
): Promise<ChainCatalog> {
  const tokens = await client.getTokens({ type: tokenType });
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

export function summarizeSupportedTokens(tokens: TokenWithChainDetails[]) {
  return tokens.map((token) => ({
    symbol: token.symbol,
    name: token.name,
    tokenAddress: token.tokenAddress,
    decimals: token.decimals,
    chainSymbol: token.chainSymbol,
    chainName: token.chainName ?? null,
    chainType: token.chainType ?? null,
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
  tokenType: 'swap' | 'pool' | 'yield',
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
        tokenType,
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
  const token = chain.tokens.find((candidate) => normalizeSymbol(candidate.symbol) === normalizedSymbol);

  if (!token) {
    throw new UserFacingToolError('unsupported_token', `Token ${tokenSymbol} is not available on ${chain.chainSymbol}.`, {
      field: fieldNames.tokenSymbol,
      chainSymbol: chain.chainSymbol,
      chainName: chain.chainName,
      tokenType,
      supportedTokens: summarizeSupportedTokens(chain.tokens),
    });
  }

  return { chain, token };
}

export function resolveTokenByAddressFromCatalog(
  catalog: ChainCatalog,
  tokenAddress: string | null | undefined,
  fieldName: string,
): TokenWithChainDetails {
  const value = typeof tokenAddress === 'string' ? tokenAddress.trim() : '';

  if (!value) {
    throw new UserFacingToolError('missing_input', `${fieldName} is required.`, {
      field: fieldName,
      supportedTokens: summarizeSupportedTokens(catalog.tokens),
    });
  }

  const normalizedAddress = value.toLowerCase();
  const token = catalog.tokens.find((candidate) => candidate.tokenAddress.toLowerCase() === normalizedAddress);
  if (!token) {
    throw new UserFacingToolError('unsupported_token', `Token ${value} is not supported by this server.`, {
      field: fieldName,
      input: value,
      supportedTokens: summarizeSupportedTokens(catalog.tokens),
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
        // eslint-disable-next-line no-new
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
    case 'ALG':
      validator = 'algosdk.isValidAddress';
      valid = algosdk.isValidAddress(value);
      break;
    case 'STX':
      validator = 'validateStacksAddress';
      valid = validateStacksAddress(value);
      break;
    case 'SRB':
      validator = 'StrKey.isValidEd25519PublicKey / StrKey.isValidContract';
      valid = StrKey.isValidEd25519PublicKey(value) || StrKey.isValidContract(value);
      break;
    case 'SUI':
      validator = 'isValidSuiAddress';
      valid = isValidSuiAddress(value);
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
