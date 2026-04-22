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
import { registerDevTools } from './dev-tools.js';
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
      'Before calling create_bridge_execution_job, ask for the sender address and recipient address, confirm the source and destination token symbols if they were not already pinned, and run check_bridge_balances. Proceed only if canProceed is true.',
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
  approvalRequired: boolean;
  approvalTx: unknown;
  bridgeTx: unknown;
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
    },
    nextAction: approveStep
      ? `Send the approve step to local-signer-mcp for ${sourceFamily} or broadcast the signed approve step with allbridge-mcp, then continue with the bridge step.`
      : `Send the bridge step to local-signer-mcp for ${sourceFamily} or broadcast the signed bridge step with allbridge-mcp.`,
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
    send: status.send ?? null,
    receive: status.receive ?? null,
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
  dependencies: ToolDependencies = defaultDependencies,
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

        const abrFeeKey = `abr:${abrTokenAddress.toLowerCase()}`;
        requirements.set(abrFeeKey, {
          key: abrFeeKey,
          kind: 'fee_abr',
          label: `${args.sourceToken.chainSymbol} ABR fee balance`,
          chainSymbol: args.sourceToken.chainSymbol,
          tokenAddress: abrTokenAddress,
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
        const availableHumanUnits = requirement.kind === 'fee_abr'
          ? null
          : baseUnitsToDecimal(balance.result, args.sourceToken.decimals);
        return {
          ...requirement,
          availableBaseUnits: balance.result,
          availableHumanUnits,
          satisfied: compareBaseUnits(balance.result, requirement.requiredBaseUnits),
        };
      }));

    const canProceed = checks.every((check) => check.satisfied === true);
    const nextAction = canProceed
      ? 'Balances are sufficient. You can call create_bridge_execution_job now.'
      : 'Top up the insufficient balance(s) and rerun check_bridge_balances before create_bridge_execution_job.';

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

    await validateBridgeBalances({
      sourceToken,
      destinationToken,
      senderAddress: args.senderAddress,
      amount: normalizedAmount,
      messenger: args.messenger,
      feePaymentMethod: args.feePaymentMethod,
      strict: true,
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

    return {
      sourceToken,
      destinationToken,
      normalizedAmount,
      approvalRequired,
      approvalTx,
      bridgeTx,
    };
  }

  server.registerTool(
    'plan_bridge_transfer',
    {
      title: 'Plan Stablecoin Bridge Transfer',
      description:
        'Primary tool for users who want to bridge stablecoins between chains. Requires sourceChain, destinationChain, sourceTokenSymbol, and amount. Use destinationTokenSymbol only when the destination chain uses a different symbol. Do not pass null for chain or token fields.',
      inputSchema: {
        sourceChain: requiredChainSchema(),
        destinationChain: requiredChainSchema(),
        amount: requiredTextSchema('Bridge amount. Do not pass null.'),
        amountUnit: amountUnitSchema.default('human'),
        tokenType: tokenTypeSchema.default('swap'),
        sourceTokenSymbol: requiredTextSchema('Source stablecoin symbol.'),
        destinationTokenSymbol: optionalTextSchema('Optional destination stablecoin symbol. Defaults to the source symbol.'),
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
          undefined,
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
          undefined,
          optionalText(parsed.destinationTokenSymbol) ?? sourceTokenSymbol,
          {
            chain: 'destinationChain',
            tokenAddress: 'destinationTokenAddress',
            tokenSymbol: 'destinationTokenSymbol',
          },
        );
        const amount = normalizeAmount(requireText(parsed.amount, 'amount'), parsed.amountUnit, source.token);
        const quote = await quoteTransfer(source.token, destination.token, amount.amountInBaseUnits);

        return summarizePlan(source.token, destination.token, amount, quote);
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
        destinationTokenSymbol: optionalTextSchema('Optional destination stablecoin symbol.'),
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
          undefined,
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
          undefined,
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
    'check_bridge_balances',
    {
      title: 'Check Bridge Balances',
      description:
        'Check whether the sender has enough source token balance and relayer fee balance to execute a bridge before building transactions. Use this before create_bridge_execution_job when the sender wallet is known.',
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
        'Create an ordered bridge execution job with explicit signing steps for an external wallet or signer. Use after the bridge route and quote are known. Balance validation is mandatory before execution. Works for all supported source chain families, including EVM, Solana, Tron, Algorand, Stacks, Soroban/Stellar, and Sui.',
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
          senderAddress: requireText(parsed.senderAddress, 'senderAddress'),
          walletId: optionalText(parsed.walletId),
          recipientAddress: requireText(parsed.recipientAddress, 'recipientAddress'),
          messenger: parsed.messenger,
          feePaymentMethod: parsed.feePaymentMethod,
          approvalRequired: built.approvalRequired,
          approvalTx: built.approvalTx,
          bridgeTx: built.bridgeTx,
        });
      });
    },
  );

  server.registerTool(
    'build_bridge_transactions',
    {
      title: 'Build Bridge Transactions',
      description:
        'Build raw approval and bridge transactions for an Allbridge transfer after the route, sender, recipient, and amount are known. Balance validation is mandatory before building transactions. Works for all supported source chain families.',
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
          approvalRequired: built.approvalRequired,
          approvalTxShape: built.approvalTx ? txShape(built.approvalTx) : null,
          bridgeTxShape: txShape(built.bridgeTx),
          approvalTx: built.approvalTx,
          bridgeTx: built.bridgeTx,
        };
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

  registerDevTools(server);

  server.registerTool(
    'broadcast_signed_transaction',
    {
      title: 'Broadcast Signed Transaction',
      description:
        'Broadcast an already signed transaction for a supported chain family when the matching RPC is configured.',
      inputSchema: signedTransactionSchema,
    },
    async (parsed) => {
      const result = await dependencies.broadcastSignedTransactionByFamily(parsed as SignedTransaction);
      return textResult(result as unknown as Record<string, unknown>);
    },
  );
}
