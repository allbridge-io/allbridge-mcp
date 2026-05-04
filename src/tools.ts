import { randomUUID } from 'node:crypto';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import {
  AMOUNT_UNITS,
  FEE_PAYMENT_METHODS,
  MESSENGERS,
  OUTPUT_FORMATS,
  TOKEN_TYPES,
} from './constants.js';
import { AllbridgeApiError, type AllbridgeApiClient } from './allbridge-api-client.js';
import { NextApiError, type NextApiClient } from './next-api-client.js';
import { planNextTransfer } from './next-tools.js';
import {
  AllbridgeExplorerApiError,
  type AllbridgeExplorerApiClient,
  type ExplorerTransfersListParams,
  normalizeExplorerSearchResults,
  normalizeExplorerTransfer,
  normalizeExplorerTransfers,
  type ExplorerSearchResult,
  type ExplorerTransferSummary,
} from './explorer-api-client.js';
import { config } from './config.js';
import {
  loadChainCatalog,
  resolveChainFromCatalog,
  resolveTokenByAddressFromCatalog,
  resolveTokenForChain,
  summarizeSupportedChains,
  summarizeSupportedTokens,
  validateAddressForChainType,
} from './chain-catalog.js';
import { broadcastSignedTransactionByFamily } from './chain-broadcast.js';
import { createToolErrorResult, UserFacingToolError } from './tool-errors.js';
import type { SignedTransaction } from './transaction-types.js';
import type { TokenWithChainDetails } from './types.js';
import { baseUnitsToDecimal, decimalToBaseUnits, formatJson } from './utils.js';

const tokenTypeSchema = z.enum(TOKEN_TYPES);
const messengerSchema = z.enum(MESSENGERS);
const feePaymentMethodSchema = z.enum(FEE_PAYMENT_METHODS);
const amountUnitSchema = z.enum(AMOUNT_UNITS);
const outputFormatSchema = z.enum(OUTPUT_FORMATS);
const bridgePortalUrl = 'https://core.allbridge.io';
const bridgeHistoryUrlBase = 'https://core.allbridge.io/history';

function requiredTextSchema(description: string) {
  return z.string().trim().min(1).describe(description);
}

function optionalTextSchema(description: string) {
  return z.string().trim().min(1).nullable().optional().describe(description);
}

function requiredChainSchema() {
  return requiredTextSchema('Required chain symbol or alias. Do not pass null.');
}

function optionalChainSchema() {
  return optionalTextSchema('Optional chain symbol or alias. Omit to list all chains.');
}

function buildBridgePortalDeepLink(params: {
  sourceToken: TokenWithChainDetails;
  destinationToken: TokenWithChainDetails;
  amount: NormalizedAmount;
  messenger: string;
}): string {
  const url = new URL(bridgePortalUrl);
  url.searchParams.set('f', params.sourceToken.chainSymbol);
  url.searchParams.set('t', params.destinationToken.chainSymbol);
  url.searchParams.set('ft', params.sourceToken.symbol);
  url.searchParams.set('tt', params.destinationToken.symbol);
  url.searchParams.set('send', params.amount.amountInHumanUnits);
  url.searchParams.set('messenger', params.messenger);
  return url.toString();
}

const evmSignedTransactionSchema = z.object({
  chainFamily: z.literal('EVM'),
  chainId: z.number().int().positive(),
  chainSymbol: z.string().trim().min(1).optional(),
  walletId: z.string().trim().min(1).optional(),
  signedTransaction: z.string().trim().min(1),
});

const solanaSignedTransactionSchema = z.object({
  chainFamily: z.literal('SOLANA'),
  walletId: z.string().trim().min(1).optional(),
  signedTransactionHex: z.string().trim().min(1),
});

const tronSignedTransactionSchema = z.object({
  chainFamily: z.literal('TRX'),
  walletId: z.string().trim().min(1).optional(),
  signedTransaction: z.record(z.unknown()),
});

const algSignedTransactionSchema = z.object({
  chainFamily: z.literal('ALG'),
  walletId: z.string().trim().min(1).optional(),
  signedTransactionsBase64: z.array(z.string().trim().min(1)).min(1),
});

const stxSignedTransactionSchema = z.object({
  chainFamily: z.literal('STX'),
  walletId: z.string().trim().min(1).optional(),
  signedTransactionHex: z.string().trim().min(1),
});

const srbSignedTransactionSchema = z.object({
  chainFamily: z.literal('SRB'),
  walletId: z.string().trim().min(1).optional(),
  signedTransactionXdr: z.string().trim().min(1),
});

const suiSignedTransactionSchema = z.object({
  chainFamily: z.literal('SUI'),
  walletId: z.string().trim().min(1).optional(),
  signedTransaction: z.object({
    bytesBase64: z.string().trim().min(1),
    signature: z.string().trim().min(1),
  }),
});

const signedTransactionSchema = z.discriminatedUnion('chainFamily', [
  evmSignedTransactionSchema,
  solanaSignedTransactionSchema,
  tronSignedTransactionSchema,
  algSignedTransactionSchema,
  stxSignedTransactionSchema,
  srbSignedTransactionSchema,
  suiSignedTransactionSchema,
]);

const signedTransactionInputSchema = {
  chainFamily: z.enum(['EVM', 'SOLANA', 'TRX', 'ALG', 'STX', 'SRB', 'SUI']).describe('Chain family for the signed transaction.'),
  chainId: z.number().int().positive().optional().describe('Required for EVM transactions.'),
  chainSymbol: z.string().trim().min(1).optional().describe('Optional EVM chain symbol.'),
  walletId: z.string().trim().min(1).optional().describe('Optional wallet selector.'),
  signedTransaction: z.unknown().optional().describe('Signed transaction payload for EVM, Tron, or Sui.'),
  signedTransactionHex: z.string().trim().min(1).optional().describe('Signed transaction hex payload for Solana, Stacks, or Soroban.'),
  signedTransactionsBase64: z.array(z.string().trim().min(1)).optional().describe('Signed transaction base64 payloads for Algorand.'),
  signedTransactionXdr: z.string().trim().min(1).optional().describe('Signed transaction XDR payload for Soroban / Stellar.'),
};

function normalizeAmount(amount: string, unit: z.infer<typeof amountUnitSchema>, token: TokenWithChainDetails): {
  amountInBaseUnits: string;
  amountInHumanUnits: string;
} {
  try {
    if (unit === 'base') {
      return {
        amountInBaseUnits: amount,
        amountInHumanUnits: baseUnitsToDecimal(amount, token.decimals),
      };
    }

    return {
      amountInBaseUnits: decimalToBaseUnits(amount, token.decimals),
      amountInHumanUnits: amount,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid amount.';
    throw new UserFacingToolError('invalid_amount', message, {
      amount,
      amountUnit: unit,
      symbol: token.symbol,
      tokenAddress: token.tokenAddress,
      decimals: token.decimals,
    });
  }
}

function detectMessengers(sourceToken: TokenWithChainDetails, destinationToken: TokenWithChainDetails): string[] {
  const messengers = ['ALLBRIDGE'];

  if (sourceToken.cctpAddress && destinationToken.cctpAddress) {
    messengers.push('CCTP');
  }

  if (sourceToken.cctpV2Address && destinationToken.cctpV2Address) {
    messengers.push('CCTP_V2');
  }

  if (sourceToken.oftId && destinationToken.oftId && sourceToken.oftId === destinationToken.oftId) {
    messengers.push('OFT');
  }

  if (sourceToken.xReserve && destinationToken.xReserve) {
    messengers.push('X_RESERVE');
  }

  return messengers;
}

type QuoteResult = {
  amountInt: string;
  amountFloat: string;
  sourceTokenAddress: string;
  destinationTokenAddress: string;
  options: Array<Record<string, unknown>>;
  quoteMode?: string;
};

function summarizeToken(token: TokenWithChainDetails) {
  return {
    symbol: token.symbol,
    name: token.name,
    tokenAddress: token.tokenAddress,
    decimals: token.decimals,
    chainSymbol: token.chainSymbol,
    chainName: token.chainName,
    chainType: token.chainType,
  };
}

function summarizeQuoteOptions(
  quote: QuoteResult,
  destinationToken: TokenWithChainDetails,
): Array<Record<string, unknown>> {
  return quote.options.map((option) => {
    const paymentMethods = Array.isArray(option.paymentMethods)
      ? option.paymentMethods.map((method) => {
          const estimatedMin = typeof method.estimatedAmount?.min === 'string'
            ? method.estimatedAmount.min
            : undefined;
          const estimatedMax = typeof method.estimatedAmount?.max === 'string'
            ? method.estimatedAmount.max
            : undefined;

          return {
            feePaymentMethod: method.feePaymentMethod ?? 'UNKNOWN',
            feeInBaseUnits: method.fee ?? null,
            estimatedReceive: {
              minInBaseUnits: estimatedMin ?? null,
              maxInBaseUnits: estimatedMax ?? null,
              minInHumanUnits: estimatedMin ? baseUnitsToDecimal(estimatedMin, destinationToken.decimals) : null,
              maxInHumanUnits: estimatedMax ? baseUnitsToDecimal(estimatedMax, destinationToken.decimals) : null,
            },
            transferFeeInBaseUnits: method.transferFee ?? null,
            relayerFeeInNative: method.relayerFeeInNative ?? null,
            relayerFeeInStable: method.relayerFeeInStable ?? null,
            relayerFeeInAbr: method.relayerFeeInAbr ?? null,
          };
        })
      : [];

    return {
      messenger: option.messenger,
      estimatedTimeMs: option.estimatedTimeMs ?? null,
      paymentMethods,
    };
  });
}

function txShape(tx: unknown): string {
  if (typeof tx === 'string') {
    return 'serialized';
  }
  if (tx && typeof tx === 'object') {
    return 'object';
  }
  return 'unknown';
}

type NormalizedAmount = {
  amountInBaseUnits: string;
  amountInHumanUnits: string;
};

type BridgeBalanceAssetKind = 'source_token' | 'source_native' | 'fee_native' | 'fee_abr';

type BridgeBalanceRequirement = {
  kind: BridgeBalanceAssetKind;
  label: string;
  chainSymbol: string;
  tokenAddress: string | null;
  requiredBaseUnits: string;
  availableBaseUnits: string | null;
  availableHumanUnits: string | null;
  satisfied: boolean | null;
};

type BridgeBalanceValidation = {
  sourceToken: ReturnType<typeof summarizeToken>;
  destinationToken: ReturnType<typeof summarizeToken>;
  amount: NormalizedAmount;
  messenger: string;
  feePaymentMethod: string;
  requiredBalances: BridgeBalanceRequirement[];
  canProceed: boolean;
  nextAction: string;
};

type WalletSelectorHint = {
  walletId: string | null;
  senderAddress: string;
  chainFamily: string | null;
  chainSymbol: string;
};

type DestinationSetupRequirement = {
  required: boolean;
  chainFamily: 'ALG' | 'SRB' | null;
  chainSymbol: string | null;
  accountAddress: string;
  checkTool: 'check_algorand_optin' | 'check_stellar_trustline' | null;
  buildTool: 'build_algorand_optin_transaction' | 'build_stellar_trustline_transaction' | null;
  reason: string | null;
};

type ExecutionHandoff = {
  executionTarget: 'local-signer-mcp';
  executionTool: 'sign_and_broadcast_transaction';
  executionAction: 'sign_and_broadcast';
  broadcastTarget: 'allbridge-mcp';
  broadcastTool: 'broadcast_signed_transaction';
  broadcastAction: 'broadcast';
  walletSelector: WalletSelectorHint;
};

function buildBridgeSummary(params: {
  sourceToken: TokenWithChainDetails;
  destinationToken: TokenWithChainDetails;
  amount: NormalizedAmount;
  recipientAddress?: string;
}): string {
  const recipient = params.recipientAddress ? ` to ${params.recipientAddress}` : '';
  return `Bridge ${params.amount.amountInHumanUnits} ${params.sourceToken.symbol} from ${params.sourceToken.chainSymbol} to ${params.destinationToken.chainSymbol}${recipient}`;
}

function buildWalletSelectorHint(params: {
  sourceToken: TokenWithChainDetails;
  senderAddress: string;
  walletId?: string | null;
}): WalletSelectorHint {
  return {
    walletId: params.walletId ?? null,
    senderAddress: params.senderAddress,
    chainFamily: params.sourceToken.chainType ?? null,
    chainSymbol: params.sourceToken.chainSymbol,
  };
}

function buildHistoryUrl(sourceChainSymbol: string | null | undefined, sourceTxId: string | null | undefined): string | null {
  const chain = typeof sourceChainSymbol === 'string' ? sourceChainSymbol.trim() : '';
  const txId = typeof sourceTxId === 'string' ? sourceTxId.trim() : '';

  if (!chain || !txId) {
    return null;
  }

  return new URL(
    `${encodeURIComponent(chain)}/${encodeURIComponent(txId)}`,
    `${bridgeHistoryUrlBase}/`,
  ).toString();
}

function buildHistoryUrlTemplate(sourceChainSymbol: string): string {
  return `${bridgeHistoryUrlBase}/${encodeURIComponent(sourceChainSymbol)}/{txId}`;
}

function addBaseUnits(left: string, right: string): string {
  return (BigInt(left) + BigInt(right)).toString();
}

function compareBaseUnits(available: string | null, required: string): boolean | null {
  if (available === null) {
    return null;
  }

  try {
    return BigInt(available) >= BigInt(required);
  } catch {
    return null;
  }
}

function normalizeKey(value: string): string {
  return value.trim().toUpperCase();
}

function isEmptyTokenAddress(tokenAddress: string | null | undefined): boolean {
  return !tokenAddress || tokenAddress.trim() === '';
}

function getAbrTokenAddress(token: TokenWithChainDetails): string | null {
  const abrPayer = token.abrPayer as
    | {
        abrToken?: {
          tokenAddress?: string;
        };
      }
    | undefined;

  return abrPayer?.abrToken?.tokenAddress ?? null;
}

function needsBridgeApproval(chainType: string | null | undefined): boolean {
  return chainType === 'EVM' || chainType === 'TRX';
}

function buildExecutionHandoff(params: {
  sourceToken: TokenWithChainDetails;
  senderAddress: string;
  walletId?: string | null;
}): ExecutionHandoff {
  return {
    executionTarget: 'local-signer-mcp',
    executionTool: 'sign_and_broadcast_transaction',
    executionAction: 'sign_and_broadcast',
    broadcastTarget: 'allbridge-mcp',
    broadcastTool: 'broadcast_signed_transaction',
    broadcastAction: 'broadcast',
    walletSelector: buildWalletSelectorHint(params),
  };
}

async function detectDestinationSetupRequirement(
  client: AllbridgeApiClient,
  destinationToken: TokenWithChainDetails,
  recipientAddress: string,
): Promise<DestinationSetupRequirement | null> {
  if (destinationToken.chainType === 'SRB') {
    try {
      await client.checkStellarBalanceLine({
        address: recipientAddress,
        token: destinationToken.tokenAddress,
      });
      return {
        required: false,
        chainFamily: 'SRB',
        chainSymbol: destinationToken.chainSymbol,
        accountAddress: recipientAddress,
        checkTool: 'check_stellar_trustline',
        buildTool: 'build_stellar_trustline_transaction',
        reason: 'The destination account already has a Stellar trustline for this token.',
      };
    } catch (error) {
      if (!(error instanceof AllbridgeApiError) || (error.status !== 400 && error.status !== 404)) {
        throw error;
      }

      return {
        required: true,
        chainFamily: 'SRB',
        chainSymbol: destinationToken.chainSymbol,
        accountAddress: recipientAddress,
        checkTool: 'check_stellar_trustline',
        buildTool: 'build_stellar_trustline_transaction',
        reason: 'The destination account must create a Stellar trustline before it can receive this token.',
      };
    }
  }

  if (destinationToken.chainType === 'ALG') {
    const optedIn = await client.checkAlgorandOptIn({
      sender: recipientAddress,
      id: destinationToken.tokenAddress,
      type: 'asset',
    });

    return {
      required: !optedIn,
      chainFamily: 'ALG',
      chainSymbol: destinationToken.chainSymbol,
      accountAddress: recipientAddress,
      checkTool: 'check_algorand_optin',
      buildTool: 'build_algorand_optin_transaction',
      reason: optedIn
        ? 'The destination account is already opted into this Algorand asset.'
        : 'The destination account must opt into this Algorand asset before it can receive the transfer.',
    };
  }

  return null;
}

function summarizePlan(
  sourceToken: TokenWithChainDetails,
  destinationToken: TokenWithChainDetails,
  amount: NormalizedAmount,
  quote: QuoteResult,
) {
  const options = summarizeQuoteOptions(quote, destinationToken);
  const recommendedOption = options[0] ?? null;

  return {
    summary: buildBridgeSummary({
      sourceToken,
      destinationToken,
      amount,
    }),
    bridgePortalName: 'Allbridge Core',
    bridgePortalUrl,
    bridgePortalDeepLink: recommendedOption
      ? buildBridgePortalDeepLink({
          sourceToken,
          destinationToken,
          amount,
          messenger: String(recommendedOption.messenger ?? 'ALLBRIDGE'),
        })
      : null,
    route: {
      source: summarizeToken(sourceToken),
      destination: summarizeToken(destinationToken),
    },
    amount,
    availableMessengers: detectMessengers(sourceToken, destinationToken),
    quoteMode: quote.quoteMode ?? 'direct',
    recommendedOption,
    options,
    nextAction:
      'Before calling create_bridge_execution_job, ask for the sender address and recipient address, confirm the source and destination token symbols if they were not already pinned, and run check_sender_balances. Proceed only if canProceed is true.',
  };
}

function buildExecutionJob(params: {
  sourceToken: TokenWithChainDetails;
  destinationToken: TokenWithChainDetails;
  amount: NormalizedAmount;
  senderAddress: string;
  walletId?: string | null;
  recipientAddress: string;
  messenger: string;
  feePaymentMethod: string;
  balanceValidation: BridgeBalanceValidation;
  approvalRequired: boolean;
  approvalTx: unknown;
  bridgeTx: unknown;
  destinationSetup: DestinationSetupRequirement | null;
}) {
  const jobId = randomUUID();
  const sourceFamily = params.sourceToken.chainType ?? 'the source chain family';
  const handoff = buildExecutionHandoff({
    sourceToken: params.sourceToken,
    senderAddress: params.senderAddress,
    walletId: params.walletId,
  });
  const approveStep = params.approvalRequired
    ? {
        id: 'approve',
        order: 1,
        type: 'sign_and_submit_transaction',
        status: 'awaiting_signature',
        required: true,
        summary: `Approve ${params.sourceToken.symbol} spending on ${params.sourceToken.chainSymbol}.`,
        transactionShape: txShape(params.approvalTx),
        transaction: params.approvalTx,
        handoff: {
          ...handoff,
          stepId: 'approve',
          transactionShape: txShape(params.approvalTx),
          nextStepId: 'bridge',
        },
        nextOnSuccess: 'bridge',
      }
    : null;
  const bridgeStepOrder = approveStep ? 2 : 1;
  const bridgeStep = {
    id: 'bridge',
    order: bridgeStepOrder,
    type: 'sign_and_submit_transaction',
    status: approveStep ? 'blocked' : 'awaiting_signature',
    required: true,
    summary: buildBridgeSummary({
      sourceToken: params.sourceToken,
      destinationToken: params.destinationToken,
      amount: params.amount,
      recipientAddress: params.recipientAddress,
    }),
    transactionShape: txShape(params.bridgeTx),
    transaction: params.bridgeTx,
    handoff: {
      ...handoff,
      stepId: 'bridge',
      transactionShape: txShape(params.bridgeTx),
      nextStepId: 'track_transfer',
    },
    nextOnSuccess: 'track_transfer',
  };

  return {
    jobId,
    kind: 'bridge_transfer',
    version: 'v1',
    mode: 'external_signer',
    status: 'awaiting_signature',
    summary: bridgeStep.summary,
    bridgePortalName: 'Allbridge Core',
    bridgePortalUrl,
    bridgePortalDeepLink: buildBridgePortalDeepLink({
      sourceToken: params.sourceToken,
      destinationToken: params.destinationToken,
      amount: params.amount,
      messenger: params.messenger,
    }),
    route: {
      source: summarizeToken(params.sourceToken),
      destination: summarizeToken(params.destinationToken),
      messenger: params.messenger,
      feePaymentMethod: params.feePaymentMethod,
    },
    participants: {
      senderAddress: params.senderAddress,
      recipientAddress: params.recipientAddress,
    },
    amount: params.amount,
    balanceValidation: params.balanceValidation,
    handoff: {
      ...handoff,
      stepId: approveStep ? 'approve' : 'bridge',
      transactionShape: txShape(approveStep ? params.approvalTx : params.bridgeTx),
      stepCount: approveStep ? 2 : 1,
      stepIds: approveStep ? ['approve', 'bridge'] : ['bridge'],
    },
    steps: approveStep ? [approveStep, bridgeStep] : [bridgeStep],
    tracking: {
      sourceChain: params.sourceToken.chainSymbol,
      destinationChain: params.destinationToken.chainSymbol,
      sourceTokenAddress: params.sourceToken.tokenAddress,
      destinationTokenAddress: params.destinationToken.tokenAddress,
      transferStatusTool: 'get_transfer_status',
      transferStatusArguments: {
        sourceChain: params.sourceToken.chainSymbol,
        txId: '<source transaction hash>',
      },
      historyUrlTemplate: buildHistoryUrlTemplate(params.sourceToken.chainSymbol),
    },
    destinationSetup: params.destinationSetup,
    nextAction: [
      params.balanceValidation.canProceed
        ? null
        : 'Balance preflight indicates a missing balance or fee requirement, but the bridge job was still built so you can inspect the transactions or top up before signing.',
      approveStep
        ? `Send the approve step to local-signer-mcp for ${sourceFamily} or broadcast the signed approve step with allbridge-mcp, then continue with the bridge step.`
        : `Send the bridge step to local-signer-mcp for ${sourceFamily} or broadcast the signed bridge step with allbridge-mcp.`,
      params.destinationSetup?.required
        ? `Destination setup is also required for ${params.destinationSetup.accountAddress}: ${params.destinationSetup.reason}`
        : null,
    ].filter((part): part is string => Boolean(part)).join(' '),
  };
}

function summarizeTransferStatus(status: Record<string, unknown>) {
  return {
    txId: status.txId ?? null,
    sourceChainSymbol: status.sourceChainSymbol ?? null,
    destinationChainSymbol: status.destinationChainSymbol ?? null,
    sendAmount: status.sendAmount ?? null,
    sendAmountFormatted: status.sendAmountFormatted ?? null,
    signaturesCount: status.signaturesCount ?? null,
    signaturesNeeded: status.signaturesNeeded ?? null,
    responseTime: status.responseTime ?? null,
    historyUrl: buildHistoryUrl(
      typeof status.sourceChainSymbol === 'string' ? status.sourceChainSymbol : null,
      typeof status.txId === 'string' ? status.txId : null,
    ),
    send: status.send ?? null,
    receive: status.receive ?? null,
  };
}

function normalizeExplorerStatus(status: unknown): string | undefined {
  if (typeof status !== 'string') {
    return undefined;
  }

  const trimmed = status.trim();
  if (!trimmed) {
    return undefined;
  }

  const normalized = trimmed.toLowerCase();
  if (normalized === 'complete') {
    return 'Complete';
  }

  if (normalized === 'pending') {
    return 'Pending';
  }

  throw new UserFacingToolError('validation_error', "Parameter 'status' must be 'Complete' or 'Pending'.", {
    status,
  });
}

function optionalTextValue(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function hasDirectTransferFilters(params: Record<string, unknown>): boolean {
  return [
    params.account,
    params.chain,
    params.from,
    params.to,
    params.minFromAmount,
    params.maxFromAmount,
    params.status,
  ].some((value) => value !== undefined && value !== null && value !== '');
}

function buildExplorerTransferListParams(
  params: {
    account?: unknown;
    chain?: unknown;
    from?: unknown;
    to?: unknown;
    minFromAmount?: unknown;
    maxFromAmount?: unknown;
    status?: unknown;
    page?: unknown;
    limit?: unknown;
  },
  catalog?: Awaited<ReturnType<typeof loadChainCatalog>>,
): ExplorerTransfersListParams {
  const chain = optionalTextValue(params.chain);
  const from = optionalTextValue(params.from);
  const to = optionalTextValue(params.to);

  if (chain && (from || to)) {
    throw new UserFacingToolError('validation_error', "Parameter 'chain' cannot be combined with 'from' or 'to'.", {
      chain: params.chain ?? null,
      from: params.from ?? null,
      to: params.to ?? null,
    });
  }

  if ((chain || from || to) && !catalog) {
    throw new UserFacingToolError('validation_error', 'Chain filters require the token catalog to be loaded first.', {
      chain: params.chain ?? null,
      from: params.from ?? null,
      to: params.to ?? null,
    });
  }

  if (params.page !== undefined && params.page !== null && typeof params.page !== 'number') {
    throw new UserFacingToolError('validation_error', "Parameter 'page' must be a number.", {
      page: params.page,
    });
  }

  const resolvedChain = chain ? resolveChainFromCatalog(catalog!, chain, 'chain').chainSymbol : undefined;
  const resolvedFrom = from ? resolveChainFromCatalog(catalog!, from, 'from').chainSymbol : undefined;
  const resolvedTo = to ? resolveChainFromCatalog(catalog!, to, 'to').chainSymbol : undefined;
  const minFromAmount = typeof params.minFromAmount === 'number' ? params.minFromAmount : undefined;
  const maxFromAmount = typeof params.maxFromAmount === 'number' ? params.maxFromAmount : undefined;
  const status = normalizeExplorerStatus(params.status);
  const page = typeof params.page === 'number' ? params.page : 1;
  const limit = typeof params.limit === 'number' ? params.limit : undefined;
  const account = optionalTextValue(params.account);

  return {
    account,
    chain: resolvedChain,
    from: resolvedFrom,
    to: resolvedTo,
    minFromAmount,
    maxFromAmount,
    status,
    page,
    limit,
  };
}

function transferKey(transfer: ExplorerTransferSummary): string | null {
  return transfer.transferId
    ?? transfer.sourceTxId
    ?? transfer.messagingTxId
    ?? transfer.receiveTxId
    ?? null;
}

function dedupeTransfers(transfers: ExplorerTransferSummary[]): ExplorerTransferSummary[] {
  const seen = new Set<string>();
  const result: ExplorerTransferSummary[] = [];

  for (const transfer of transfers) {
    const key = transferKey(transfer);
    if (!key || seen.has(key)) {
      continue;
    }

    seen.add(key);
    result.push(transfer);
  }

  return result;
}

function uniqueNonEmpty(values: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const value of values) {
    const trimmed = typeof value === 'string' ? value.trim() : '';
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }

    seen.add(trimmed);
    result.push(trimmed);
  }

  return result;
}

async function resolveExplorerSearchTransfers(
  explorerClient: AllbridgeExplorerApiClient,
  baseURL: string,
  query: string,
  page: number,
  limit: number,
): Promise<{
  searchMatches: ExplorerSearchResult[];
  resolvedTransfers: ExplorerTransferSummary[];
  resolvedBy: Array<'address' | 'transfer'>;
}> {
  const searchMatches = normalizeExplorerSearchResults(await explorerClient.search(query));
  const resolvedBy = new Set<'address' | 'transfer'>();
  const resolvedTransfers: ExplorerTransferSummary[] = [];

  const lookupTasks = searchMatches.map(async (match) => {
    if (match.itemType === 'Address' && match.value) {
      resolvedBy.add('address');
      const response = await explorerClient.listTransfers({
        account: match.value,
        page,
        limit,
      });
      return normalizeExplorerTransfers(response, baseURL, query);
    }

    if (match.itemType === 'Transfer' && match.value) {
      resolvedBy.add('transfer');
      const response = await explorerClient.getTransfer(match.value);
      return [normalizeExplorerTransfer(response, baseURL, match.value, query)];
    }

    return [];
  });

  for (const batch of await Promise.all(lookupTasks)) {
    resolvedTransfers.push(...batch);
  }

  return {
    searchMatches,
    resolvedTransfers: dedupeTransfers(resolvedTransfers).slice(0, limit),
    resolvedBy: [...resolvedBy],
  };
}

type ToolDependencies = {
  broadcastSignedTransactionByFamily: typeof broadcastSignedTransactionByFamily;
};

const defaultDependencies: ToolDependencies = {
  broadcastSignedTransactionByFamily,
};

async function buildQuoteFallback(
  client: AllbridgeApiClient,
  sourceToken: TokenWithChainDetails,
  destinationToken: TokenWithChainDetails,
  amountInBaseUnits: string,
): Promise<QuoteResult> {
  const options = [];

  for (const messenger of detectMessengers(sourceToken, destinationToken)) {
    try {
      const [receive, estimatedTimeMs] = await Promise.all([
        client.getAmountToBeReceived({
          amount: amountInBaseUnits,
          sourceToken: sourceToken.tokenAddress,
          destinationToken: destinationToken.tokenAddress,
          messenger,
        }),
        client.getTransferTime({
          sourceToken: sourceToken.tokenAddress,
          destinationToken: destinationToken.tokenAddress,
          messenger,
        }),
      ]);

      options.push({
        messenger,
        estimatedTimeMs,
        paymentMethods: [
          {
            estimatedAmount: {
              min: decimalToBaseUnits(receive.amountReceivedInFloat, destinationToken.decimals),
              max: decimalToBaseUnits(receive.amountReceivedInFloat, destinationToken.decimals),
            },
          },
        ],
      });
    } catch (error) {
      if (error instanceof AllbridgeApiError) {
        continue;
      }
      throw error;
    }
  }

  if (options.length === 0) {
    throw new Error('Unable to build a bridge quote from available route endpoints.');
  }

  return {
    amountInt: amountInBaseUnits,
    amountFloat: baseUnitsToDecimal(amountInBaseUnits, sourceToken.decimals),
    sourceTokenAddress: sourceToken.tokenAddress,
    destinationTokenAddress: destinationToken.tokenAddress,
    options,
    quoteMode: 'fallback',
  };
}

export function registerAllbridgeTools(
  server: McpServer,
  client: AllbridgeApiClient,
  explorerClient: AllbridgeExplorerApiClient,
  dependencies: ToolDependencies = defaultDependencies,
  nextClient?: NextApiClient,
): void {
  type ToolResult = {
    content: Array<{ type: 'text'; text: string }>;
    structuredContent: Record<string, unknown>;
    isError?: boolean;
  };

  function textResult(structuredContent: Record<string, unknown>): ToolResult {
    return {
      content: [{ type: 'text' as const, text: formatJson(structuredContent) }],
      structuredContent,
    };
  }

  function errorResult(error: UserFacingToolError): ToolResult {
    return createToolErrorResult(error);
  }

  function requireText(value: unknown, fieldName: string): string {
    if (typeof value !== 'string' || value.trim() === '') {
      throw new UserFacingToolError('missing_input', `${fieldName} is required.`, { field: fieldName });
    }

    return value.trim();
  }

  function optionalText(value: unknown): string | undefined {
    if (value === undefined || value === null) {
      return undefined;
    }

    return requireText(value, 'optional value');
  }

  async function runTool(operation: () => Promise<Record<string, unknown>>): Promise<ToolResult> {
    try {
      return textResult(await operation());
    } catch (error) {
      if (error instanceof UserFacingToolError) {
        return errorResult(error);
      }

      throw error;
    }
  }

  async function quoteTransfer(
    sourceToken: TokenWithChainDetails,
    destinationToken: TokenWithChainDetails,
    amountInBaseUnits: string,
  ): Promise<QuoteResult> {
    try {
      const directQuote = await client.getBridgeQuote({
        sourceToken: sourceToken.tokenAddress,
        destinationToken: destinationToken.tokenAddress,
        amount: amountInBaseUnits,
      });
      return {
        ...directQuote,
        options: directQuote.options as Array<Record<string, unknown>>,
        quoteMode: 'direct',
      };
    } catch (error) {
      if (!(error instanceof AllbridgeApiError)) {
        throw error;
      }

      return buildQuoteFallback(
        client,
        sourceToken,
        destinationToken,
        amountInBaseUnits,
      );
    }
  }

  type BalanceRequirement = {
    key: string;
    kind: BridgeBalanceAssetKind;
    label: string;
    chainSymbol: string;
    tokenAddress: string | null;
    tokenDecimals: number | null;
    requiredBaseUnits: string;
    availableBaseUnits: string | null;
    availableHumanUnits: string | null;
    satisfied: boolean | null;
  };

  async function validateBridgeBalances(args: {
    sourceToken: TokenWithChainDetails;
    destinationToken: TokenWithChainDetails;
    senderAddress: string;
    amount: NormalizedAmount;
    messenger: z.infer<typeof messengerSchema>;
    feePaymentMethod: z.infer<typeof feePaymentMethodSchema>;
    strict: boolean;
  }): Promise<BridgeBalanceValidation> {
    try {
      type QuotePaymentMethod = {
        feePaymentMethod?: string;
        fee?: string;
      };

      type QuoteOption = {
        messenger?: string;
        paymentMethods?: QuotePaymentMethod[];
      };

      const quote = await quoteTransfer(args.sourceToken, args.destinationToken, args.amount.amountInBaseUnits);
      const quoteOptions = quote.options as QuoteOption[];
      const selectedOption = quoteOptions.find(
        (option) => normalizeKey(String(option.messenger ?? '')) === normalizeKey(args.messenger),
      ) ?? quoteOptions[0];
      if (!selectedOption) {
        throw new UserFacingToolError('validation_error', 'Unable to determine fee requirements for the selected bridge messenger.', {
          messenger: args.messenger,
        });
      }

      const selectedMethods = Array.isArray(selectedOption.paymentMethods) ? selectedOption.paymentMethods : [];
      const selectedMethod = selectedMethods.find(
        (method) => normalizeKey(String(method.feePaymentMethod ?? '')) === normalizeKey(args.feePaymentMethod),
      ) ?? selectedMethods[0] ?? null;
      if (!selectedMethod || typeof selectedMethod.fee !== 'string' || selectedMethod.fee.trim() === '') {
        throw new UserFacingToolError('validation_error', 'Unable to determine the selected relayer fee from the bridge quote.', {
          messenger: args.messenger,
          feePaymentMethod: args.feePaymentMethod,
        });
      }

      const relayerFeeBaseUnits = selectedMethod.fee.trim();

      const requirements = new Map<string, BalanceRequirement>();
      const sourceTokenIsNative = isEmptyTokenAddress(args.sourceToken.tokenAddress);
      const sourceTokenKey = sourceTokenIsNative
        ? `native:${args.sourceToken.chainSymbol}`
        : `token:${args.sourceToken.tokenAddress.toLowerCase()}`;

      requirements.set(sourceTokenKey, {
        key: sourceTokenKey,
        kind: sourceTokenIsNative ? 'source_native' : 'source_token',
        label: sourceTokenIsNative
          ? `${args.sourceToken.chainSymbol} native balance`
          : `${args.sourceToken.symbol} balance`,
        chainSymbol: args.sourceToken.chainSymbol,
        tokenAddress: sourceTokenIsNative ? null : args.sourceToken.tokenAddress,
        tokenDecimals: sourceTokenIsNative ? null : args.sourceToken.decimals,
        requiredBaseUnits: args.amount.amountInBaseUnits,
        availableBaseUnits: null,
        availableHumanUnits: null,
        satisfied: null,
      });

      if (args.feePaymentMethod === 'WITH_STABLECOIN') {
        const existing = requirements.get(sourceTokenKey);
        if (existing) {
          existing.requiredBaseUnits = addBaseUnits(existing.requiredBaseUnits, relayerFeeBaseUnits);
          existing.label = `${existing.label} (amount + relayer fee)`;
        }
      } else if (args.feePaymentMethod === 'WITH_NATIVE_CURRENCY') {
        if (sourceTokenIsNative) {
          const existing = requirements.get(sourceTokenKey);
          if (existing) {
            existing.requiredBaseUnits = addBaseUnits(existing.requiredBaseUnits, relayerFeeBaseUnits);
            existing.label = `${existing.label} (amount + relayer fee)`;
          }
        } else {
          const nativeFeeKey = `native:${args.sourceToken.chainSymbol}`;
          requirements.set(nativeFeeKey, {
            key: nativeFeeKey,
            kind: 'fee_native',
            label: `${args.sourceToken.chainSymbol} native fee balance`,
            chainSymbol: args.sourceToken.chainSymbol,
            tokenAddress: null,
            tokenDecimals: null,
            requiredBaseUnits: relayerFeeBaseUnits,
            availableBaseUnits: null,
            availableHumanUnits: null,
            satisfied: null,
          });
        }
      } else if (args.feePaymentMethod === 'WITH_ABR') {
        const abrTokenAddress = getAbrTokenAddress(args.sourceToken);
        if (!abrTokenAddress) {
          throw new UserFacingToolError('validation_error', 'Unable to resolve the ABR token required for the selected fee payment method.', {
            sourceTokenAddress: args.sourceToken.tokenAddress,
            sourceChainSymbol: args.sourceToken.chainSymbol,
            feePaymentMethod: args.feePaymentMethod,
          });
        }
        // pre-existing: WITH_ABR branch needs the chain catalog to resolve the ABR token; load lazily here.
        const catalog = await loadChainCatalog(client);
        const abrToken = resolveTokenByAddressFromCatalog(catalog, abrTokenAddress, 'abrTokenAddress');

        const abrFeeKey = `abr:${abrTokenAddress.toLowerCase()}`;
        requirements.set(abrFeeKey, {
          key: abrFeeKey,
          kind: 'fee_abr',
          label: `${args.sourceToken.chainSymbol} ABR fee balance`,
          chainSymbol: args.sourceToken.chainSymbol,
          tokenAddress: abrTokenAddress,
          tokenDecimals: abrToken.decimals,
          requiredBaseUnits: relayerFeeBaseUnits,
          availableBaseUnits: null,
          availableHumanUnits: null,
          satisfied: null,
        });
      }

      const checks = await Promise.all([...requirements.values()].map(async (requirement) => {
        if (requirement.kind === 'fee_native' || requirement.kind === 'source_native') {
          const balance = await client.getTokenNativeBalance({
            address: args.senderAddress,
            chain: requirement.chainSymbol,
          });
          const satisfied = compareBaseUnits(balance.int, requirement.requiredBaseUnits);
          return {
            ...requirement,
            availableBaseUnits: balance.int,
            availableHumanUnits: balance.float,
            satisfied,
          };
        }

        if (!requirement.tokenAddress) {
          throw new UserFacingToolError('validation_error', 'Unable to resolve the token address required for balance validation.', {
            requirement,
          });
        }

        const balance = await client.getTokenBalance({
          address: args.senderAddress,
          token: requirement.tokenAddress,
        });
        if (requirement.tokenDecimals === null) {
          throw new UserFacingToolError('validation_error', 'Unable to determine token decimals for balance validation.', {
            requirement,
          });
        }
        const availableHumanUnits = balance.result.trim();
        const availableBaseUnits = decimalToBaseUnits(availableHumanUnits, requirement.tokenDecimals);
        return {
          ...requirement,
          availableBaseUnits,
          availableHumanUnits,
          satisfied: compareBaseUnits(availableBaseUnits, requirement.requiredBaseUnits),
        };
      }));

    const canProceed = checks.every((check) => check.satisfied === true);
    const nextAction = canProceed
      ? 'Balances are sufficient. You can call create_bridge_execution_job now.'
      : 'Top up the insufficient balance(s) and rerun check_sender_balances before create_bridge_execution_job.';

      const result: BridgeBalanceValidation = {
        sourceToken: summarizeToken(args.sourceToken),
        destinationToken: summarizeToken(args.destinationToken),
        amount: args.amount,
        messenger: args.messenger,
        feePaymentMethod: args.feePaymentMethod,
        requiredBalances: checks,
        canProceed,
        nextAction,
      };

      if (args.strict && !canProceed) {
        throw new UserFacingToolError('insufficient_balance', 'Insufficient balance to execute this bridge.', {
          ...result,
        });
      }

      return result;
    } catch (error) {
      if (error instanceof UserFacingToolError) {
        throw error;
      }

      if (error instanceof AllbridgeApiError) {
        throw new UserFacingToolError('validation_error', 'Unable to verify balances before building the bridge transaction.', {
          messenger: args.messenger,
          feePaymentMethod: args.feePaymentMethod,
          sourceTokenAddress: args.sourceToken.tokenAddress,
          destinationTokenAddress: args.destinationToken.tokenAddress,
          reason: error.message,
          status: error.status ?? null,
          details: error.details ?? null,
        });
      }

      throw error;
    }
  }

  async function buildTransactions(args: {
    sourceTokenAddress: string;
    destinationTokenAddress: string;
    senderAddress: string;
    recipientAddress: string;
    amount: string;
    amountUnit: z.infer<typeof amountUnitSchema>;
    messenger: z.infer<typeof messengerSchema>;
    feePaymentMethod: z.infer<typeof feePaymentMethodSchema>;
    contractAddress?: string;
    outputFormat: z.infer<typeof outputFormatSchema>;
  }) {
    const catalog = await loadChainCatalog(client);
    const sourceToken = resolveTokenByAddressFromCatalog(catalog, args.sourceTokenAddress, 'sourceTokenAddress');
    const destinationToken = resolveTokenByAddressFromCatalog(catalog, args.destinationTokenAddress, 'destinationTokenAddress');
    const normalizedAmount = normalizeAmount(args.amount, args.amountUnit, sourceToken);

    validateAddressForChainType(args.senderAddress, sourceToken.chainType ?? null, 'senderAddress');
    validateAddressForChainType(args.recipientAddress, destinationToken.chainType ?? null, 'recipientAddress');

    const balanceValidation = await validateBridgeBalances({
      sourceToken,
      destinationToken,
      senderAddress: args.senderAddress,
      amount: normalizedAmount,
      messenger: args.messenger,
      feePaymentMethod: args.feePaymentMethod,
      strict: false,
    });

    const approvalRequired = needsBridgeApproval(sourceToken.chainType)
      ? !(await client.checkBridgeAllowance({
          amount: normalizedAmount.amountInBaseUnits,
          ownerAddress: args.senderAddress,
          tokenAddress: args.sourceTokenAddress,
          feePaymentMethod: args.feePaymentMethod,
          contractAddress: args.contractAddress,
        }))
      : false;

    const approvalTx = approvalRequired
      ? await client.buildBridgeApproveTx({
          amount: normalizedAmount.amountInBaseUnits,
          ownerAddress: args.senderAddress,
          tokenAddress: args.sourceTokenAddress,
          messenger: args.messenger,
          feePaymentMethod: args.feePaymentMethod,
          contractAddress: args.contractAddress,
        })
      : null;

    const bridgeTx = await client.buildBridgeTx({
      amount: normalizedAmount.amountInBaseUnits,
      sender: args.senderAddress,
      recipient: args.recipientAddress,
      sourceToken: args.sourceTokenAddress,
      destinationToken: args.destinationTokenAddress,
      messenger: args.messenger,
      feePaymentMethod: args.feePaymentMethod,
      contractAddress: args.contractAddress,
      outputFormat: args.outputFormat,
    });

    const destinationSetup = await detectDestinationSetupRequirement(
      client,
      destinationToken,
      args.recipientAddress,
    );

    return {
      sourceToken,
      destinationToken,
      normalizedAmount,
      balanceValidation,
      approvalRequired,
      approvalTx,
      bridgeTx,
      destinationSetup,
    };
  }

  async function runCorePlan(parsed: {
    sourceChain?: string | null;
    destinationChain?: string | null;
    amount: string;
    amountUnit: z.infer<typeof amountUnitSchema>;
    tokenType: z.infer<typeof tokenTypeSchema>;
    sourceTokenSymbol: string;
    sourceTokenAddress?: string | null;
    destinationTokenSymbol?: string | null;
    destinationTokenAddress?: string | null;
  }): Promise<Record<string, unknown>> {
    const catalog = await loadChainCatalog(client, parsed.tokenType);
    const sourceTokenSymbol = requireText(parsed.sourceTokenSymbol, 'sourceTokenSymbol');
    const source = resolveTokenForChain(
      catalog,
      optionalText(parsed.sourceChain),
      parsed.tokenType,
      optionalText(parsed.sourceTokenAddress),
      sourceTokenSymbol,
      {
        chain: 'sourceChain',
        tokenAddress: 'sourceTokenAddress',
        tokenSymbol: 'sourceTokenSymbol',
      },
    );
    const destination = resolveTokenForChain(
      catalog,
      optionalText(parsed.destinationChain),
      parsed.tokenType,
      optionalText(parsed.destinationTokenAddress),
      optionalText(parsed.destinationTokenSymbol) ?? sourceTokenSymbol,
      {
        chain: 'destinationChain',
        tokenAddress: 'destinationTokenAddress',
        tokenSymbol: 'destinationTokenSymbol',
      },
    );
    const amount = normalizeAmount(requireText(parsed.amount, 'amount'), parsed.amountUnit, source.token);
    const quote = await quoteTransfer(source.token, destination.token, amount.amountInBaseUnits);

    return summarizePlan(source.token, destination.token, amount, quote) as unknown as Record<string, unknown>;
  }

  async function runNextPlan(parsed: {
    sourceChain?: string | null;
    destinationChain?: string | null;
    amount: string;
    amountUnit: z.infer<typeof amountUnitSchema>;
    sourceTokenSymbol: string;
    sourceTokenAddress?: string | null;
    destinationTokenSymbol?: string | null;
    destinationTokenAddress?: string | null;
  }): Promise<Record<string, unknown>> {
    if (!nextClient) {
      throw new UserFacingToolError(
        'validation_error',
        'Allbridge NEXT client is not configured for this server.',
        {},
      );
    }
    const result = await planNextTransfer(nextClient, {
      sourceChain: requireText(parsed.sourceChain, 'sourceChain'),
      destinationChain: requireText(parsed.destinationChain, 'destinationChain'),
      sourceTokenSymbol: requireText(parsed.sourceTokenSymbol, 'sourceTokenSymbol'),
      destinationTokenSymbol: optionalText(parsed.destinationTokenSymbol),
      sourceTokenAddress: optionalText(parsed.sourceTokenAddress),
      destinationTokenAddress: optionalText(parsed.destinationTokenAddress),
      amount: requireText(parsed.amount, 'amount'),
      amountUnit: parsed.amountUnit,
    });
    return result as unknown as Record<string, unknown>;
  }

  function serializePlanError(err: unknown): { code: string; message: string; details: unknown } {
    if (err instanceof UserFacingToolError) {
      return { code: err.code, message: err.message, details: err.details ?? null };
    }
    if (err instanceof AllbridgeApiError || err instanceof NextApiError) {
      return {
        code: 'validation_error',
        message: err.message,
        details: err.details ?? null,
      };
    }
    return {
      code: 'validation_error',
      message: err instanceof Error ? err.message : String(err),
      details: null,
    };
  }

  server.registerTool(
    'plan_bridge_transfer',
    {
      title: 'Plan Bridge Transfer (Core + NEXT)',
      description:
        'Primary tool for planning a cross-chain transfer. By default returns options from BOTH Allbridge Core and Allbridge NEXT side by side; pass protocol="core" or protocol="next" to query only one. Requires sourceChain, destinationChain, sourceTokenSymbol, and amount. Use token addresses when the selected chain has more than one token with the same symbol. Use destinationTokenSymbol only when the destination chain uses a different symbol. Response always wrapped as { protocols, core, next, errors }.',
      inputSchema: {
        sourceChain: requiredChainSchema(),
        destinationChain: requiredChainSchema(),
        amount: requiredTextSchema('Bridge amount. Do not pass null.'),
        amountUnit: amountUnitSchema.default('human'),
        tokenType: tokenTypeSchema.default('swap').describe('Core token type (swap | pool | yield). Ignored by NEXT.'),
        sourceTokenSymbol: requiredTextSchema('Source token symbol (e.g., USDC, ETH).'),
        sourceTokenAddress: optionalTextSchema('Optional exact source token address. Use when the source chain has multiple tokens with the same symbol.'),
        destinationTokenSymbol: optionalTextSchema('Optional destination token symbol. Defaults to the source symbol.'),
        destinationTokenAddress: optionalTextSchema('Optional exact destination token address. Use when the destination chain has multiple tokens with the same symbol.'),
        protocol: z
          .enum(['core', 'next', 'auto'])
          .default('auto')
          .describe('Which Allbridge protocol to query. "auto" runs both in parallel and returns whichever succeeds.'),
      },
    },
    async (parsed) => {
      const protocol = parsed.protocol;

      if (protocol === 'core') {
        return runTool(async () => {
          const core = await runCorePlan(parsed);
          return { protocols: ['core'], core, next: null, errors: null };
        });
      }

      if (protocol === 'next') {
        return runTool(async () => {
          const next = await runNextPlan(parsed);
          return { protocols: ['next'], core: null, next, errors: null };
        });
      }

      // auto. If NEXT client is not configured, silently degrade to core-only —
      // the caller did not opt into NEXT, so an infrastructure miss should not
      // surface as an error.
      if (!nextClient) {
        return runTool(async () => {
          const core = await runCorePlan(parsed);
          return { protocols: ['core'], core, next: null, errors: null };
        });
      }

      // run both, never throw if at least one succeeds
      const [coreSettled, nextSettled] = await Promise.allSettled([
        runCorePlan(parsed),
        runNextPlan(parsed),
      ]);

      const errors: { core?: ReturnType<typeof serializePlanError>; next?: ReturnType<typeof serializePlanError> } = {};
      const core = coreSettled.status === 'fulfilled' ? coreSettled.value : null;
      const next = nextSettled.status === 'fulfilled' ? nextSettled.value : null;
      if (coreSettled.status === 'rejected') {
        errors.core = serializePlanError(coreSettled.reason);
      }
      if (nextSettled.status === 'rejected') {
        errors.next = serializePlanError(nextSettled.reason);
      }

      if (!core && !next) {
        return errorResult(
          new UserFacingToolError(
            'validation_error',
            'Both Core and NEXT planners failed.',
            errors,
          ),
        );
      }

      return textResult({
        protocols: ['core', 'next'],
        core,
        next,
        errors: Object.keys(errors).length > 0 ? errors : null,
      });
    },
  );

  server.registerTool(
    'find_bridge_routes',
    {
      title: 'Inspect Bridge Routes',
      description:
        'Advanced route lookup for bridge planning. Use only after sourceChain and destinationChain are known. For a normal stablecoin bridge request, prefer plan_bridge_transfer.',
      inputSchema: {
        sourceChain: requiredChainSchema(),
        destinationChain: requiredChainSchema(),
        tokenType: tokenTypeSchema.default('swap'),
        sourceTokenSymbol: requiredTextSchema('Source stablecoin symbol.'),
        sourceTokenAddress: optionalTextSchema('Optional exact source token address. Use when the source chain has multiple tokens with the same symbol.'),
        destinationTokenSymbol: optionalTextSchema('Optional destination stablecoin symbol.'),
        destinationTokenAddress: optionalTextSchema('Optional exact destination token address. Use when the destination chain has multiple tokens with the same symbol.'),
      },
    },
    async (parsed) => {
      return runTool(async () => {
        const catalog = await loadChainCatalog(client, parsed.tokenType);
        const sourceTokenSymbol = requireText(parsed.sourceTokenSymbol, 'sourceTokenSymbol');
        const source = resolveTokenForChain(
          catalog,
          optionalText(parsed.sourceChain),
          parsed.tokenType,
          optionalText(parsed.sourceTokenAddress),
          sourceTokenSymbol,
          {
            chain: 'sourceChain',
            tokenAddress: 'sourceTokenAddress',
            tokenSymbol: 'sourceTokenSymbol',
          },
        );
        const destination = resolveTokenForChain(
          catalog,
          optionalText(parsed.destinationChain),
          parsed.tokenType,
          optionalText(parsed.destinationTokenAddress),
          optionalText(parsed.destinationTokenSymbol) ?? sourceTokenSymbol,
          {
            chain: 'destinationChain',
            tokenAddress: 'destinationTokenAddress',
            tokenSymbol: 'destinationTokenSymbol',
          },
        );

        return {
          route: {
            source: summarizeToken(source.token),
            destination: summarizeToken(destination.token),
            symbolPair: `${source.token.symbol} -> ${destination.token.symbol}`,
          },
          availableMessengers: detectMessengers(source.token, destination.token),
        };
      });
    },
  );

  server.registerTool(
    'quote_bridge_transfer',
    {
      title: 'Quote Bridge Transfer',
      description:
        'Quote an Allbridge transfer after the source and destination token addresses are known. Requires concrete token addresses and amount; do not pass null.',
      inputSchema: {
        sourceTokenAddress: requiredTextSchema('Source token address. Do not pass null.'),
        destinationTokenAddress: requiredTextSchema('Destination token address. Do not pass null.'),
        amount: requiredTextSchema('Bridge amount. Do not pass null.'),
        amountUnit: amountUnitSchema.default('human'),
      },
    },
    async (parsed) => {
      return runTool(async () => {
        const catalog = await loadChainCatalog(client);
        const sourceToken = resolveTokenByAddressFromCatalog(catalog, requireText(parsed.sourceTokenAddress, 'sourceTokenAddress'), 'sourceTokenAddress');
        const amount = normalizeAmount(requireText(parsed.amount, 'amount'), parsed.amountUnit, sourceToken);
        const destinationToken = resolveTokenByAddressFromCatalog(catalog, requireText(parsed.destinationTokenAddress, 'destinationTokenAddress'), 'destinationTokenAddress');
        const quote = await quoteTransfer(sourceToken, destinationToken, amount.amountInBaseUnits);

        return {
          route: {
            source: summarizeToken(sourceToken),
            destination: summarizeToken(destinationToken),
          },
          amount,
          quoteMode: quote.quoteMode ?? 'direct',
          options: summarizeQuoteOptions(quote, destinationToken),
          bridgePortalName: 'Allbridge Core',
          bridgePortalUrl,
          bridgePortalDeepLink: buildBridgePortalDeepLink({
            sourceToken,
            destinationToken,
            amount,
            messenger: String(quote.options[0]?.messenger ?? 'ALLBRIDGE'),
          }),
        };
      });
    },
  );

  server.registerTool(
    'list_supported_chains',
    {
      title: 'List Supported Chains',
      description:
        'List the bridge chains and chain aliases currently supported by the Allbridge token catalog. Use this first when the user has not yet chosen a destination chain.',
      inputSchema: {
        tokenType: tokenTypeSchema.default('swap'),
      },
    },
    async (parsed) => runTool(async () => {
      const catalog = await loadChainCatalog(client, parsed.tokenType);

      return {
        tokenType: parsed.tokenType,
        chains: summarizeSupportedChains(catalog),
        nextAction: 'Use one of the returned chainSymbol values or aliases in plan_bridge_transfer and find_bridge_routes.',
      };
    }),
  );

  server.registerTool(
    'list_supported_tokens',
    {
      title: 'List Supported Stablecoins',
      description:
        'List the supported bridge tokens for a chain. Use this after the source chain is known to choose the stablecoin before planning the bridge.',
      inputSchema: {
        tokenType: tokenTypeSchema.default('swap'),
        chain: optionalChainSchema(),
      },
    },
    async (parsed) => runTool(async () => {
      const catalog = await loadChainCatalog(client, parsed.tokenType);
      if (parsed.chain === null || parsed.chain === undefined || (typeof parsed.chain === 'string' && parsed.chain.trim() === '')) {
        return {
          tokenType: parsed.tokenType,
          chains: catalog.chains.map((chain) => ({
            chainSymbol: chain.chainSymbol,
            chainName: chain.chainName,
            chainType: chain.chainType,
            tokens: summarizeSupportedTokens(chain.tokens),
          })),
        };
      }

      const chain = resolveChainFromCatalog(catalog, parsed.chain, 'chain');
      return {
        tokenType: parsed.tokenType,
        chain: {
          chainSymbol: chain.chainSymbol,
          chainName: chain.chainName,
          chainType: chain.chainType,
          aliases: chain.aliases,
        },
        tokens: summarizeSupportedTokens(chain.tokens),
      };
    }),
  );

  server.registerTool(
    'check_sender_balances',
    {
      title: 'Check Sender Balances',
      description:
        'Sender balance preflight before building bridge transactions. Check whether the sender has enough source token balance and relayer fee balance to execute a bridge. Use this before create_bridge_execution_job when the sender wallet is known.',
      inputSchema: {
        sourceTokenAddress: requiredTextSchema('Source token address. Do not pass null.'),
        destinationTokenAddress: requiredTextSchema('Destination token address. Do not pass null.'),
        senderAddress: requiredTextSchema('Sender address. Do not pass null.'),
        amount: requiredTextSchema('Bridge amount. Do not pass null.'),
        amountUnit: amountUnitSchema.default('human'),
        messenger: messengerSchema,
        feePaymentMethod: feePaymentMethodSchema,
      },
    },
    async (parsed) => {
      return runTool(async () => {
        const catalog = await loadChainCatalog(client);
        const sourceToken = resolveTokenByAddressFromCatalog(catalog, requireText(parsed.sourceTokenAddress, 'sourceTokenAddress'), 'sourceTokenAddress');
        const destinationToken = resolveTokenByAddressFromCatalog(catalog, requireText(parsed.destinationTokenAddress, 'destinationTokenAddress'), 'destinationTokenAddress');
        const amount = normalizeAmount(requireText(parsed.amount, 'amount'), parsed.amountUnit, sourceToken);

        validateAddressForChainType(requireText(parsed.senderAddress, 'senderAddress'), sourceToken.chainType ?? null, 'senderAddress');

        return validateBridgeBalances({
          sourceToken,
          destinationToken,
          senderAddress: requireText(parsed.senderAddress, 'senderAddress'),
          amount,
          messenger: parsed.messenger,
          feePaymentMethod: parsed.feePaymentMethod,
          strict: false,
        });
      });
    },
  );

  server.registerTool(
    'create_bridge_execution_job',
    {
      title: 'Create Bridge Execution Job',
      description:
        'Create an ordered bridge execution job with explicit signing steps for an external wallet or signer. Use after the bridge route and quote are known. Balance validation is returned as advisory data, not a hard stop. Works for all supported source chain families, including EVM, Solana, Tron, Algorand, Stacks, Soroban/Stellar, and Sui.',
      inputSchema: {
        sourceTokenAddress: requiredTextSchema('Source token address. Do not pass null.'),
        destinationTokenAddress: requiredTextSchema('Destination token address. Do not pass null.'),
        senderAddress: requiredTextSchema('Sender address. Do not pass null.'),
        walletId: optionalTextSchema('Optional wallet identifier.'),
        recipientAddress: requiredTextSchema('Recipient address. Do not pass null.'),
        amount: requiredTextSchema('Bridge amount. Do not pass null.'),
        amountUnit: amountUnitSchema.default('human'),
        messenger: messengerSchema,
        feePaymentMethod: feePaymentMethodSchema,
        contractAddress: optionalTextSchema('Optional contract address.'),
        outputFormat: outputFormatSchema.default('json'),
      },
    },
    async (parsed) => {
      return runTool(async () => {
        const built = await buildTransactions({
          sourceTokenAddress: requireText(parsed.sourceTokenAddress, 'sourceTokenAddress'),
          destinationTokenAddress: requireText(parsed.destinationTokenAddress, 'destinationTokenAddress'),
          senderAddress: requireText(parsed.senderAddress, 'senderAddress'),
          recipientAddress: requireText(parsed.recipientAddress, 'recipientAddress'),
          amount: requireText(parsed.amount, 'amount'),
          amountUnit: parsed.amountUnit,
          messenger: parsed.messenger,
          feePaymentMethod: parsed.feePaymentMethod,
          contractAddress: optionalText(parsed.contractAddress),
          outputFormat: parsed.outputFormat,
        });
        return buildExecutionJob({
          sourceToken: built.sourceToken,
          destinationToken: built.destinationToken,
          amount: built.normalizedAmount,
          balanceValidation: built.balanceValidation,
          senderAddress: requireText(parsed.senderAddress, 'senderAddress'),
          walletId: optionalText(parsed.walletId),
          recipientAddress: requireText(parsed.recipientAddress, 'recipientAddress'),
          messenger: parsed.messenger,
          feePaymentMethod: parsed.feePaymentMethod,
          approvalRequired: built.approvalRequired,
          approvalTx: built.approvalTx,
          bridgeTx: built.bridgeTx,
          destinationSetup: built.destinationSetup,
        });
      });
    },
  );

  server.registerTool(
    'build_bridge_transactions',
    {
      title: 'Build Bridge Transactions',
      description:
        'Build raw approval and bridge transactions for an Allbridge transfer after the route, sender, recipient, and amount are known. Balance validation is returned as advisory data, not a hard stop. Works for all supported source chain families.',
      inputSchema: {
        sourceTokenAddress: requiredTextSchema('Source token address. Do not pass null.'),
        destinationTokenAddress: requiredTextSchema('Destination token address. Do not pass null.'),
        senderAddress: requiredTextSchema('Sender address. Do not pass null.'),
        recipientAddress: requiredTextSchema('Recipient address. Do not pass null.'),
        amount: requiredTextSchema('Bridge amount. Do not pass null.'),
        amountUnit: amountUnitSchema.default('human'),
        messenger: messengerSchema,
        feePaymentMethod: feePaymentMethodSchema,
        contractAddress: optionalTextSchema('Optional contract address.'),
        outputFormat: outputFormatSchema.default('json'),
      },
    },
    async (parsed) => {
      return runTool(async () => {
        const built = await buildTransactions({
          sourceTokenAddress: requireText(parsed.sourceTokenAddress, 'sourceTokenAddress'),
          destinationTokenAddress: requireText(parsed.destinationTokenAddress, 'destinationTokenAddress'),
          senderAddress: requireText(parsed.senderAddress, 'senderAddress'),
          recipientAddress: requireText(parsed.recipientAddress, 'recipientAddress'),
          amount: requireText(parsed.amount, 'amount'),
          amountUnit: parsed.amountUnit,
          messenger: parsed.messenger,
          feePaymentMethod: parsed.feePaymentMethod,
          contractAddress: optionalText(parsed.contractAddress),
          outputFormat: parsed.outputFormat,
        });

        return {
          route: {
            source: summarizeToken(built.sourceToken),
            destination: summarizeToken(built.destinationToken),
            destinationTokenAddress: requireText(parsed.destinationTokenAddress, 'destinationTokenAddress'),
            messenger: parsed.messenger,
            feePaymentMethod: parsed.feePaymentMethod,
          },
          amount: built.normalizedAmount,
          balanceValidation: built.balanceValidation,
          approvalRequired: built.approvalRequired,
          approvalTxShape: built.approvalTx ? txShape(built.approvalTx) : null,
          bridgeTxShape: txShape(built.bridgeTx),
          approvalTx: built.approvalTx,
          bridgeTx: built.bridgeTx,
          destinationSetup: built.destinationSetup,
          nextAction: [
            built.balanceValidation.canProceed
              ? null
              : 'Balance preflight indicates a missing balance or fee requirement, but the bridge transaction was still built so you can inspect it or top up before signing.',
            built.approvalRequired
              ? 'Send the approval transaction to the signer or broadcaster first, then send the bridge transaction.'
              : 'Send the returned bridge transaction to the signer or broadcaster.',
            built.destinationSetup?.required
              ? `The destination account at ${built.destinationSetup.accountAddress} still needs a prerequisite transaction before it can receive the bridged asset. Use ${built.destinationSetup.checkTool} to confirm and ${built.destinationSetup.buildTool} to build it if needed.`
              : null,
          ].filter((part): part is string => Boolean(part)).join(' '),
        };
      });
    },
  );

  server.registerTool(
    'check_stellar_trustline',
    {
      title: 'Check Stellar Trustline',
      description:
        'Check whether a Stellar account already has a trustline for the given token.',
      inputSchema: {
        address: requiredTextSchema('Stellar account address. Do not pass null.'),
        tokenAddress: requiredTextSchema('Stellar token address. Do not pass null.'),
      },
    },
    async (parsed) => {
      return runTool(async () => {
        try {
          const address = requireText(parsed.address, 'address');
          const tokenAddress = requireText(parsed.tokenAddress, 'tokenAddress');
          const balanceLine = await client.checkStellarBalanceLine({
            address,
            token: tokenAddress,
          });

          return {
            address,
            tokenAddress,
            required: false,
            balanceLine,
            nextAction: 'The account already has a Stellar trustline for this token.',
          };
        } catch (error) {
          if (error instanceof AllbridgeApiError) {
            if (error.status === 400 || error.status === 404) {
              return {
                address: parsed.address ?? null,
                tokenAddress: parsed.tokenAddress ?? null,
                required: true,
                balanceLine: null,
                nextAction: 'Create a Stellar trustline before sending this token to the account.',
              };
            }

            throw new UserFacingToolError('validation_error', 'Unable to check the Stellar trustline.', {
              address: parsed.address ?? null,
              tokenAddress: parsed.tokenAddress ?? null,
              reason: error.message,
              status: error.status ?? null,
              details: error.details ?? null,
            });
          }

          throw error;
        }
      });
    },
  );

  server.registerTool(
    'build_stellar_trustline_transaction',
    {
      title: 'Build Stellar Trustline Transaction',
      description:
        'Build a Stellar change trustline transaction for a recipient account.',
      inputSchema: {
        accountAddress: requiredTextSchema('Stellar account address. Do not pass null.'),
        tokenAddress: requiredTextSchema('Stellar token address. Do not pass null.'),
        limit: optionalTextSchema('Optional trustline limit.'),
      },
    },
    async (parsed) => {
      return runTool(async () => {
        try {
          const accountAddress = requireText(parsed.accountAddress, 'accountAddress');
          const tokenAddress = requireText(parsed.tokenAddress, 'tokenAddress');
          const transaction = await client.buildStellarTrustlineTransaction({
            sender: accountAddress,
            tokenAddress,
            limit: optionalText(parsed.limit),
          });

          return {
            accountAddress,
            tokenAddress,
            transaction,
          };
        } catch (error) {
          if (error instanceof AllbridgeApiError) {
            throw new UserFacingToolError('validation_error', 'Unable to build the Stellar trustline transaction.', {
              accountAddress: parsed.accountAddress ?? null,
              tokenAddress: parsed.tokenAddress ?? null,
              limit: parsed.limit ?? null,
              reason: error.message,
              status: error.status ?? null,
              details: error.details ?? null,
            });
          }

          throw error;
        }
      });
    },
  );

  server.registerTool(
    'check_algorand_optin',
    {
      title: 'Check Algorand Opt-In',
      description:
        'Check whether an Algorand account is already opted into the given asset or app.',
      inputSchema: {
        accountAddress: requiredTextSchema('Algorand account address. Do not pass null.'),
        id: requiredTextSchema('Asset or app id. Do not pass null.'),
        type: z.enum(['asset', 'app']).default('asset'),
      },
    },
    async (parsed) => {
      return runTool(async () => {
        try {
          const accountAddress = requireText(parsed.accountAddress, 'accountAddress');
          const id = requireText(parsed.id, 'id');
          const optedIn = await client.checkAlgorandOptIn({
            sender: accountAddress,
            id,
            type: parsed.type,
          });

          return {
            accountAddress,
            id,
            type: parsed.type,
            required: !optedIn,
            nextAction: optedIn
              ? 'The account is already opted into this Algorand asset or app.'
              : 'Create an Algorand opt-in transaction before sending this asset to the account.',
          };
        } catch (error) {
          if (error instanceof AllbridgeApiError) {
            throw new UserFacingToolError('validation_error', 'Unable to check the Algorand opt-in state.', {
              accountAddress: parsed.accountAddress ?? null,
              id: parsed.id ?? null,
              type: parsed.type ?? null,
              reason: error.message,
              status: error.status ?? null,
              details: error.details ?? null,
            });
          }

          throw error;
        }
      });
    },
  );

  server.registerTool(
    'build_algorand_optin_transaction',
    {
      title: 'Build Algorand Opt-In Transaction',
      description:
        'Build an Algorand opt-in transaction for a recipient account.',
      inputSchema: {
        accountAddress: requiredTextSchema('Algorand account address. Do not pass null.'),
        id: requiredTextSchema('Asset or app id. Do not pass null.'),
        type: z.enum(['asset', 'app']).default('asset'),
      },
    },
    async (parsed) => {
      return runTool(async () => {
        try {
          const accountAddress = requireText(parsed.accountAddress, 'accountAddress');
          const id = requireText(parsed.id, 'id');
          const transaction = await client.buildAlgorandOptInTransaction({
            sender: accountAddress,
            id,
            type: parsed.type,
          });

          return {
            accountAddress,
            id,
            type: parsed.type,
            transaction,
          };
        } catch (error) {
          if (error instanceof AllbridgeApiError) {
            throw new UserFacingToolError('validation_error', 'Unable to build the Algorand opt-in transaction.', {
              accountAddress: parsed.accountAddress ?? null,
              id: parsed.id ?? null,
              type: parsed.type ?? null,
              reason: error.message,
              status: error.status ?? null,
              details: error.details ?? null,
            });
          }

          throw error;
        }
      });
    },
  );

  server.registerTool(
    'get_transfer_status',
    {
      title: 'Get Transfer Status',
      description:
        'Fetch the status of a bridge transfer from the source chain and transaction hash. Requires a concrete source chain and txId.',
      inputSchema: {
        sourceChain: requiredChainSchema(),
        txId: requiredTextSchema('Transaction hash. Do not pass null.'),
      },
    },
    async (parsed) => {
      return runTool(async () => {
        const catalog = await loadChainCatalog(client);
        const chain = resolveChainFromCatalog(catalog, optionalText(parsed.sourceChain) ?? parsed.sourceChain, 'sourceChain');
        const txId = requireText(parsed.txId, 'txId');

        const status = await client.getTransferStatus({
          chain: chain.chainSymbol,
          txId,
        });

        return summarizeTransferStatus(status);
      });
    },
  );

  server.registerTool(
    'search_allbridge_transfers',
    {
      title: 'Search Allbridge Transfers',
      description:
        'Search or list Allbridge transfers in the public explorer. Use query to resolve typed hits (Address or Transfer), or use list filters such as account, chain, from, to, status, minFromAmount, and maxFromAmount. Omit everything to list recent transfers.',
      inputSchema: {
        query: optionalTextSchema('Optional search query. Omit to list recent transfers.'),
        account: optionalTextSchema('Optional account address to list transfers for.'),
        chain: optionalTextSchema('Optional chain filter. Can be combined with account, status, or amount filters.'),
        from: optionalTextSchema('Optional source chain filter. Cannot be combined with chain.'),
        to: optionalTextSchema('Optional destination chain filter. Cannot be combined with chain.'),
        minFromAmount: z.number().min(0).optional().describe('Optional minimum source amount filter.'),
        maxFromAmount: z.number().positive().optional().describe('Optional maximum source amount filter.'),
        status: optionalTextSchema('Optional transfer status filter. Use Complete or Pending.'),
        page: z.number().int().positive().default(1).describe('Page number for list mode.'),
        limit: z.number().int().positive().max(20).default(10).describe('Maximum number of transfers to return.'),
      },
    },
    async (parsed) => {
      return runTool(async () => {
        try {
          const query = optionalText(parsed.query);
          const directFiltersExist = hasDirectTransferFilters(parsed);
          if (query && directFiltersExist) {
            throw new UserFacingToolError('validation_error', 'Query search cannot be combined with direct transfer filters.', {
              query,
              account: parsed.account ?? null,
              chain: parsed.chain ?? null,
              from: parsed.from ?? null,
              to: parsed.to ?? null,
              minFromAmount: parsed.minFromAmount ?? null,
              maxFromAmount: parsed.maxFromAmount ?? null,
              status: parsed.status ?? null,
            });
          }

          if (!query) {
            const chain = optionalText(parsed.chain);
            const from = optionalText(parsed.from);
            const to = optionalText(parsed.to);

            if (chain && (from || to)) {
              throw new UserFacingToolError('validation_error', "Parameter 'chain' cannot be combined with 'from' or 'to'.", {
                chain: parsed.chain ?? null,
                from: parsed.from ?? null,
                to: parsed.to ?? null,
              });
            }
          }

          if (!query) {
            const needsCatalog = Boolean(optionalText(parsed.chain) || optionalText(parsed.from) || optionalText(parsed.to));
            const catalog = needsCatalog ? await loadChainCatalog(client) : undefined;
            const listParams = buildExplorerTransferListParams(parsed, catalog);
            const response = await explorerClient.listTransfers({
              account: listParams.account,
              chain: listParams.chain,
              from: listParams.from,
              to: listParams.to,
              minFromAmount: listParams.minFromAmount,
              maxFromAmount: listParams.maxFromAmount,
              status: listParams.status,
              page: listParams.page ?? 1,
              limit: parsed.limit,
            });
            const transfers = normalizeExplorerTransfers(response, config.ALLBRIDGE_EXPLORER_API_BASE_URL).slice(0, parsed.limit);

            return {
              mode: 'recent',
              query: null,
              appliedFilters: directFiltersExist ? listParams : null,
              searchMatchCount: 0,
              searchMatches: [],
              resolvedBy: [],
              resultCount: transfers.length,
              results: transfers,
              nextAction: transfers.length > 0
                ? 'Use get_allbridge_transfer with a transferId to open a single transfer.'
                : 'Provide a query to narrow the explorer results by sender, recipient, transaction hash, or transfer ID.',
            };
          }

          const { searchMatches, resolvedTransfers, resolvedBy } = await resolveExplorerSearchTransfers(
            explorerClient,
            config.ALLBRIDGE_EXPLORER_API_BASE_URL,
            query,
            typeof parsed.page === 'number' ? parsed.page : 1,
            parsed.limit,
          );

          return {
            mode: 'search',
            query,
            appliedFilters: null,
            searchMatchCount: searchMatches.length,
            searchMatches,
            resolvedBy,
            resultCount: resolvedTransfers.length,
            results: resolvedTransfers,
            nextAction: resolvedTransfers.length > 0
              ? (() => {
                  const sourceChains = uniqueNonEmpty(resolvedTransfers.map((transfer) => transfer.sourceChainSymbol));
                  if (sourceChains.length > 1) {
                    return 'Use get_allbridge_transfer with a transferId to open one transfer, or rerun search_allbridge_transfers with a chain filter or from/to direction filters if you want to narrow the history to one network.';
                  }

                  return 'Use get_allbridge_transfer with a transferId to open one transfer, or follow the historyUrl for progress tracking.';
                })()
              : searchMatches.length > 0
                ? 'The query matched explorer entities, but no transfer records were returned. Try a sender address, recipient address, source transaction hash, messaging transaction hash, receive transaction hash, or transfer ID.'
                : 'Try a sender address, recipient address, source transaction hash, messaging transaction hash, receive transaction hash, or transfer ID.',
          };
        } catch (error) {
          if (error instanceof AllbridgeExplorerApiError) {
            throw new UserFacingToolError('validation_error', 'Unable to query the Allbridge explorer.', {
              query: parsed.query ?? null,
              limit: parsed.limit,
              reason: error.message,
              status: error.status ?? null,
              details: error.details ?? null,
            });
          }

          throw error;
        }
      });
    },
  );

  server.registerTool(
    'get_allbridge_transfer',
    {
      title: 'Get Allbridge Transfer',
      description:
        'Open a single transfer record from the public explorer by transfer ID.',
      inputSchema: {
        transferId: requiredTextSchema('Transfer ID to open. Do not pass null.'),
      },
    },
    async (parsed) => {
      return runTool(async () => {
        try {
          const transferId = requireText(parsed.transferId, 'transferId');
          const response = await explorerClient.getTransfer(transferId);
          const transfer = normalizeExplorerTransfer(response, config.ALLBRIDGE_EXPLORER_API_BASE_URL, transferId);

          return {
            transfer,
            nextAction: 'Use the returned transferId, transaction hashes, and addresses to orient the bridge lifecycle or continue investigation.',
          };
        } catch (error) {
          if (error instanceof AllbridgeExplorerApiError) {
            throw new UserFacingToolError('validation_error', 'Unable to open the requested Allbridge transfer.', {
              transferId: parsed.transferId ?? null,
              reason: error.message,
              status: error.status ?? null,
              details: error.details ?? null,
            });
          }

          if (error instanceof Error) {
            throw new UserFacingToolError('validation_error', 'Unable to parse the requested Allbridge transfer.', {
              transferId: parsed.transferId ?? null,
              reason: error.message,
            });
          }

          throw error;
        }
      });
    },
  );

  server.registerTool(
    'broadcast_signed_transaction',
    {
      title: 'Broadcast Signed Transaction',
      description:
        'Broadcast an already signed transaction for a supported chain family when the matching RPC is configured.',
      inputSchema: signedTransactionInputSchema,
    },
    async (parsed) => {
      const result = await dependencies.broadcastSignedTransactionByFamily(parsed as SignedTransaction);
      return textResult(result as unknown as Record<string, unknown>);
    },
  );
}
