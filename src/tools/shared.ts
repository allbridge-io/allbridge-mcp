import { FeePaymentMethod } from '@allbridge/bridge-core-sdk';
import { z } from 'zod';

import type { broadcastSignedTransactionByFamily } from '../chain-broadcast.js';
import { loadChainCatalog, type ChainCatalog } from '../chain-catalog.js';
import type { CoreGateway, CoreToken } from '../core-gateway.js';
import type { AllbridgeExplorerApiClient } from '../explorer-api-client.js';
import { MESSENGERS } from '../messengers.js';
import { toUserFacingError } from '../sdk-errors.js';
import { createToolErrorResult, UserFacingToolError } from '../tool-errors.js';
import { baseUnitsToDecimal, decimalToBaseUnits, formatJson } from '../utils.js';

export type ToolContext = {
  gateway: CoreGateway;
  explorer: AllbridgeExplorerApiClient;
  explorerBaseUrl: string;
  broadcastSignedTransactionByFamily: typeof broadcastSignedTransactionByFamily;
  loadCatalog: () => Promise<ChainCatalog>;
};

export function createToolContext(params: Omit<ToolContext, 'loadCatalog'>): ToolContext {
  return {
    ...params,
    loadCatalog: () => loadChainCatalog(params.gateway),
  };
}

export const FEE_PAYMENT_METHODS = ['WITH_NATIVE_CURRENCY', 'WITH_STABLECOIN', 'WITH_ABR'] as const;
export type FeePaymentMethodName = (typeof FEE_PAYMENT_METHODS)[number];

const SDK_FEE_PAYMENT_METHODS: Record<FeePaymentMethodName, FeePaymentMethod> = {
  WITH_NATIVE_CURRENCY: FeePaymentMethod.WITH_NATIVE_CURRENCY,
  WITH_STABLECOIN: FeePaymentMethod.WITH_STABLECOIN,
  WITH_ABR: FeePaymentMethod.WITH_ABR,
};

export function toSdkFeePaymentMethod(method: FeePaymentMethodName): FeePaymentMethod {
  return SDK_FEE_PAYMENT_METHODS[method];
}

export const amountUnitSchema = z
  .enum(['human', 'base'])
  .default('human')
  .describe('"human" for token units (1.5 USDC), "base" for integer base units (1500000).');
export const messengerSchema = z.enum(MESSENGERS).describe('Messenger (bridging protocol) to use.');
export const feePaymentMethodSchema = z
  .enum(FEE_PAYMENT_METHODS)
  .default('WITH_NATIVE_CURRENCY')
  .describe('How the destination gas fee is paid: native currency, the source token, or ABR. Ignored by intent messengers.');

export function requiredTextSchema(description: string) {
  return z.string().trim().min(1).describe(description);
}

export function optionalTextSchema(description: string) {
  return z.string().trim().min(1).nullable().optional().describe(description);
}

export function requiredChainSchema() {
  return requiredTextSchema('Required chain symbol or alias. Do not pass null.');
}

export function optionalChainSchema() {
  return optionalTextSchema('Optional chain symbol or alias. Omit to list all chains.');
}

export type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent: Record<string, unknown>;
  isError?: boolean;
};

export function textResult(structuredContent: Record<string, unknown>): ToolResult {
  return {
    content: [{ type: 'text' as const, text: formatJson(structuredContent) }],
    structuredContent,
  };
}

/** Runs a tool body and turns every failure into a structured `{ ok: false, error }` result. */
export async function runTool(action: string, operation: () => Promise<Record<string, unknown>>): Promise<ToolResult> {
  try {
    return textResult(await operation());
  } catch (error) {
    return createToolErrorResult(error instanceof UserFacingToolError ? error : toUserFacingError(error, { action }));
  }
}

export function requireText(value: unknown, fieldName: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new UserFacingToolError('missing_input', `${fieldName} is required.`, { field: fieldName });
  }

  return value.trim();
}

export function optionalText(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

export type TokenAmount = {
  inBaseUnits: string;
  inHumanUnits: string;
};

export type NormalizedAmount = {
  amountInBaseUnits: string;
  amountInHumanUnits: string;
};

export function normalizeAmount(amount: string, unit: 'human' | 'base' | undefined, token: CoreToken): NormalizedAmount {
  unit = unit ?? 'human';
  try {
    const result = unit === 'base'
      ? { amountInBaseUnits: amount.trim(), amountInHumanUnits: baseUnitsToDecimal(amount, token.decimals) }
      : { amountInBaseUnits: decimalToBaseUnits(amount, token.decimals), amountInHumanUnits: amount.trim() };

    if (BigInt(result.amountInBaseUnits) <= 0n) {
      throw new Error('Amount must be greater than zero.');
    }

    return {
      amountInBaseUnits: result.amountInBaseUnits,
      amountInHumanUnits: baseUnitsToDecimal(result.amountInBaseUnits, token.decimals),
    };
  } catch (error) {
    throw new UserFacingToolError('invalid_amount', error instanceof Error ? error.message : 'Invalid amount.', {
      amount,
      amountUnit: unit,
      symbol: token.symbol,
      tokenAddress: token.tokenAddress,
      decimals: token.decimals,
    });
  }
}

/** Converts an SDK float amount to base units, rounding down any precision beyond the token decimals. */
export function floatToTokenAmount(value: string, decimals: number): TokenAmount {
  const trimmed = value.trim();
  const match = /^(\d+)(?:\.(\d+))?$/.exec(trimmed);
  if (!match) {
    throw new Error(`Unexpected amount ${value}.`);
  }

  const fraction = (match[2] ?? '').slice(0, decimals);
  const inBaseUnits = decimalToBaseUnits(fraction ? `${match[1]}.${fraction}` : match[1]!, decimals);
  return { inBaseUnits, inHumanUnits: baseUnitsToDecimal(inBaseUnits, decimals) };
}

export function baseUnitsToTokenAmount(value: string, decimals: number): TokenAmount {
  return { inBaseUnits: value, inHumanUnits: baseUnitsToDecimal(value, decimals) };
}

export function summarizeToken(token: CoreToken) {
  return {
    symbol: token.symbol,
    name: token.name,
    tokenAddress: token.tokenAddress,
    decimals: token.decimals,
    chainSymbol: token.chainSymbol,
    chainName: token.chainName ?? null,
    chainType: token.chainType ?? null,
    isNative: token.isNative === true,
  };
}

export const BRIDGE_PORTAL_NAME = 'Allbridge Core';
export const BRIDGE_PORTAL_URL = 'https://core.allbridge.io';
const BRIDGE_HISTORY_URL = 'https://core.allbridge.io/history';

export function buildBridgePortalDeepLink(params: {
  sourceToken: CoreToken;
  destinationToken: CoreToken;
  amount: NormalizedAmount;
  messenger: string;
}): string {
  const url = new URL(BRIDGE_PORTAL_URL);
  url.searchParams.set('f', params.sourceToken.chainSymbol);
  url.searchParams.set('t', params.destinationToken.chainSymbol);
  url.searchParams.set('ft', params.sourceToken.symbol);
  url.searchParams.set('tt', params.destinationToken.symbol);
  url.searchParams.set('send', params.amount.amountInHumanUnits);
  url.searchParams.set('messenger', params.messenger);
  return url.toString();
}

export function buildHistoryUrl(sourceChainSymbol: string | null | undefined, sourceTxId: string | null | undefined): string | null {
  const chain = typeof sourceChainSymbol === 'string' ? sourceChainSymbol.trim() : '';
  const txId = typeof sourceTxId === 'string' ? sourceTxId.trim() : '';

  if (!chain || !txId) {
    return null;
  }

  return `${BRIDGE_HISTORY_URL}/${encodeURIComponent(chain)}/${encodeURIComponent(txId)}`;
}

export function buildHistoryUrlTemplate(sourceChainSymbol: string): string {
  return `${BRIDGE_HISTORY_URL}/${encodeURIComponent(sourceChainSymbol)}/{txId}`;
}

export function buildBridgeSummary(params: {
  sourceToken: CoreToken;
  destinationToken: CoreToken;
  amount: NormalizedAmount;
  recipientAddress?: string;
}): string {
  const recipient = params.recipientAddress ? ` to ${params.recipientAddress}` : '';
  const destination = params.destinationToken.symbol === params.sourceToken.symbol
    ? params.destinationToken.chainSymbol
    : `${params.destinationToken.symbol} on ${params.destinationToken.chainSymbol}`;
  return `Bridge ${params.amount.amountInHumanUnits} ${params.sourceToken.symbol} from ${params.sourceToken.chainSymbol} to ${destination}${recipient}`;
}
