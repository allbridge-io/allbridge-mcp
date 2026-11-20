import { randomUUID } from 'node:crypto';

import { Interface } from 'ethers';

import { validateSenderBalances, type BalanceValidation } from './balances.js';
import type { CoreGateway, CoreToken } from './core-gateway.js';
import { detectDestinationSetup, type DestinationSetupRequirement } from './destination-setup.js';
import { type MessengerName, toSdkMessenger } from './messengers.js';
import { intentQuote, quoteMessenger, type MessengerQuote } from './quotes.js';
import {
  BRIDGE_PORTAL_NAME,
  BRIDGE_PORTAL_URL,
  buildBridgePortalDeepLink,
  buildBridgeSummary,
  buildHistoryUrlTemplate,
  type FeePaymentMethodName,
  floatToTokenAmount,
  type NormalizedAmount,
  summarizeToken,
  type TokenAmount,
  toSdkFeePaymentMethod,
} from './tools/shared.js';
import { TRANSACTION_FORMATS, toUnsignedTransaction, type TransactionFormat, type UnsignedTransaction } from './unsigned-transaction.js';

export type WalletSelector = {
  walletId: string | null;
  senderAddress: string;
  chainFamily: string | null;
  chainSymbol: string;
};

export type ExecutionHandoff = {
  executionTarget: 'local-signer-mcp';
  executionTool: 'sign_and_broadcast_transaction';
  executionAction: 'sign_and_broadcast';
  broadcastTarget: 'allbridge-mcp';
  broadcastTool: 'broadcast_signed_transaction';
  broadcastAction: 'broadcast';
  walletSelector: WalletSelector;
};

export type ExecutionStepId = 'reset_allowance' | 'approve' | 'bridge';

export type StepBuild = {
  /** Tool that returns this step's transaction; call it right before signing. */
  tool: 'create_lifi_intents_order';
  arguments: Record<string, unknown>;
  reason: string;
};

export type ExecutionStep = {
  id: ExecutionStepId;
  order: number;
  type: 'sign_and_submit_transaction';
  status: 'awaiting_signature' | 'blocked' | 'requires_build';
  required: true;
  summary: string;
  transactionFormat: TransactionFormat;
  /** Signer-ready unsigned transaction; null while the step must still be built with `build`. */
  transaction: UnsignedTransaction | null;
  build: StepBuild | null;
  handoff: ExecutionHandoff & { stepId: ExecutionStepId; transactionFormat: TransactionFormat; nextStepId: string };
  waitForConfirmation: boolean;
  nextOnSuccess: string;
};

type DraftStep = Pick<ExecutionStep, 'id' | 'summary' | 'transaction' | 'waitForConfirmation'> & {
  transactionFormat: TransactionFormat;
  build?: StepBuild;
};

export type NearIntentsDepositInfo = {
  provider: 'NEAR Intents';
  depositAddress: string;
  depositMemo: string | null;
  /** The deposit must arrive before this time; funds arriving later may be lost. */
  deadline: string;
  amountToSend: TokenAmount;
  amountToReceive: TokenAmount;
  minAmountToReceive: TokenAmount;
  submitDepositTool: 'submit_near_intents_deposit';
  submitDepositArguments: { depositAddress: string; depositMemo?: string; txId: string };
};

export type LifiIntentsOrderPlan = {
  provider: 'LI.FI Intents';
  buildTool: 'create_lifi_intents_order';
  /** The order must pay at least this much, or create_lifi_intents_order stops with price_changed. */
  minAmountToReceive: TokenAmount;
  maxSlippagePercent: number;
  bridgeContract: string | null;
};

export type BridgeExecutionJob = {
  jobId: string;
  kind: 'bridge_transfer';
  version: 'v2';
  mode: 'external_signer';
  status: 'awaiting_signature' | 'requires_build';
  summary: string;
  bridgePortalName: string;
  bridgePortalUrl: string;
  bridgePortalDeepLink: string;
  route: {
    source: ReturnType<typeof summarizeToken>;
    destination: ReturnType<typeof summarizeToken>;
    messenger: MessengerName;
    feePaymentMethod: FeePaymentMethodName | null;
  };
  participants: { senderAddress: string; recipientAddress: string };
  amount: NormalizedAmount;
  quote: MessengerQuote;
  intent: NearIntentsDepositInfo | LifiIntentsOrderPlan | null;
  balanceValidation: BalanceValidation;
  handoff: ExecutionHandoff & { stepId: ExecutionStepId; transactionFormat: TransactionFormat; stepCount: number; stepIds: ExecutionStepId[] };
  steps: ExecutionStep[];
  tracking: {
    sourceChain: string;
    destinationChain: string;
    sourceTokenAddress: string;
    destinationTokenAddress: string;
    transferStatusTool: 'get_transfer_status';
    transferStatusArguments: { sourceChain: string; txId: string };
    historyUrlTemplate: string;
  };
  destinationSetup: DestinationSetupRequirement | null;
  nextAction: string;
};

export type ExecutionRequest = {
  sourceToken: CoreToken;
  destinationToken: CoreToken;
  senderAddress: string;
  recipientAddress: string;
  walletId?: string;
  amount: NormalizedAmount;
  messenger: MessengerName;
  feePaymentMethod: FeePaymentMethodName;
  /** LI.FI Intents: how far below the quote the order may price before create_lifi_intents_order stops. */
  maxSlippagePercent?: number;
};

export const DEFAULT_MAX_SLIPPAGE_PERCENT = 0.5;

/** Ethereum USDT reverts `approve` from a non-zero allowance to another non-zero value. */
const RESET_ALLOWANCE_TOKENS = new Set(['ETH:0xdac17f958d2ee523a2206206994597c13d831ec7']);

const erc20 = new Interface(['function approve(address spender, uint256 amount)']);

function needsApproval(token: CoreToken, messenger: MessengerName): boolean {
  if (token.isNative || messenger === 'NEAR_INTENTS') {
    return false;
  }
  if (messenger === 'LIFI_INTENTS') {
    return token.chainType === 'EVM';
  }
  return token.chainType === 'EVM' || token.chainType === 'TRX';
}

function needsAllowanceReset(token: CoreToken): boolean {
  return RESET_ALLOWANCE_TOKENS.has(`${token.chainSymbol}:${token.tokenAddress.toLowerCase()}`);
}

/** Builds `approve(spender, 0)` from an approve transaction to the same spender. */
function toZeroApproval(approval: UnsignedTransaction): UnsignedTransaction {
  if (approval.chainFamily !== 'EVM') {
    throw new Error('Allowance reset is only built for EVM tokens.');
  }
  const [spender] = erc20.decodeFunctionData('approve', approval.data);
  return { ...approval, data: erc20.encodeFunctionData('approve', [spender, 0n]), value: '0' };
}

/** `amount` reduced by `percent`, rounded down. */
export function applySlippage(amount: TokenAmount, decimals: number, percent: number): TokenAmount {
  const basisPoints = BigInt(Math.round(percent * 100));
  const value = (BigInt(amount.inBaseUnits) * (10_000n - basisPoints)) / 10_000n;
  const inBaseUnits = value.toString();
  const padded = inBaseUnits.padStart(decimals + 1, '0');
  const fraction = decimals > 0 ? padded.slice(-decimals).replace(/0+$/, '') : '';
  const whole = decimals > 0 ? padded.slice(0, -decimals) : padded;
  return { inBaseUnits, inHumanUnits: fraction ? `${whole}.${fraction}` : whole };
}

export function buildExecutionHandoff(sourceToken: CoreToken, senderAddress: string, walletId?: string): ExecutionHandoff {
  return {
    executionTarget: 'local-signer-mcp',
    executionTool: 'sign_and_broadcast_transaction',
    executionAction: 'sign_and_broadcast',
    broadcastTarget: 'allbridge-mcp',
    broadcastTool: 'broadcast_signed_transaction',
    broadcastAction: 'broadcast',
    walletSelector: {
      walletId: walletId ?? null,
      senderAddress,
      chainFamily: sourceToken.chainType ?? null,
      chainSymbol: sourceToken.chainSymbol,
    },
  };
}

export function linkSteps(steps: DraftStep[], handoff: ExecutionHandoff): ExecutionStep[] {
  return steps.map((step, index) => {
    const next = steps[index + 1]?.id ?? 'track_transfer';
    const status: ExecutionStep['status'] = index > 0 ? 'blocked' : step.transaction ? 'awaiting_signature' : 'requires_build';
    return {
      id: step.id,
      order: index + 1,
      type: 'sign_and_submit_transaction',
      status,
      required: true,
      summary: step.summary,
      transactionFormat: step.transactionFormat,
      transaction: step.transaction,
      build: step.build ?? null,
      handoff: { ...handoff, stepId: step.id, transactionFormat: step.transactionFormat, nextStepId: next },
      waitForConfirmation: step.waitForConfirmation,
      nextOnSuccess: next,
    };
  });
}

function formatFor(token: CoreToken): TransactionFormat {
  const format = TRANSACTION_FORMATS[token.chainType as UnsignedTransaction['chainFamily']];
  if (!format) {
    throw new Error(`Chain type ${String(token.chainType)} is not supported by this server.`);
  }
  return format;
}

function txStep(id: ExecutionStepId, summary: string, transaction: UnsignedTransaction, waitForConfirmation: boolean): DraftStep {
  return { id, summary, transaction, transactionFormat: TRANSACTION_FORMATS[transaction.chainFamily], waitForConfirmation };
}

async function approvalSteps(gateway: CoreGateway, request: ExecutionRequest): Promise<DraftStep[]> {
  const { sourceToken, senderAddress, walletId, amount, messenger } = request;
  if (!needsApproval(sourceToken, messenger)) {
    return [];
  }

  const allowanceParams = {
    token: sourceToken,
    owner: senderAddress,
    messenger: toSdkMessenger(messenger),
    ...(messenger === 'LIFI_INTENTS' ? {} : { gasFeePaymentMethod: toSdkFeePaymentMethod(request.feePaymentMethod) }),
  };
  if (await gateway.checkAllowance({ ...allowanceParams, amount: amount.amountInHumanUnits })) {
    return [];
  }

  const approval = toUnsignedTransaction(await gateway.buildApproveTransaction(allowanceParams), sourceToken, walletId);
  const steps: DraftStep[] = [];

  if (needsAllowanceReset(sourceToken) && BigInt(await gateway.getAllowance(allowanceParams)) > 0n) {
    steps.push(txStep(
      'reset_allowance',
      `Reset the ${sourceToken.symbol} allowance on ${sourceToken.chainSymbol} to 0 (this token requires it before a new approval).`,
      toZeroApproval(approval),
      true,
    ));
  }

  steps.push(txStep('approve', `Approve ${sourceToken.symbol} spending on ${sourceToken.chainSymbol} for ${messenger}.`, approval, true));
  return steps;
}

/** Arguments for create_lifi_intents_order that rebuild the LI.FI order of this job. */
export function lifiOrderArguments(request: ExecutionRequest, minAmountToReceive: TokenAmount): Record<string, unknown> {
  return {
    sourceTokenAddress: request.sourceToken.tokenAddress,
    sourceChain: request.sourceToken.chainSymbol,
    destinationTokenAddress: request.destinationToken.tokenAddress,
    destinationChain: request.destinationToken.chainSymbol,
    senderAddress: request.senderAddress,
    recipientAddress: request.recipientAddress,
    amount: request.amount.amountInBaseUnits,
    amountUnit: 'base',
    minAmountToReceive: minAmountToReceive.inBaseUnits,
    ...(request.walletId ? { walletId: request.walletId } : {}),
  };
}

type MessengerPlan = {
  quote: MessengerQuote;
  intent: BridgeExecutionJob['intent'];
  bridgeStep: (summary: string) => Promise<DraftStep>;
};

async function planBridgeMessenger(gateway: CoreGateway, request: ExecutionRequest): Promise<MessengerPlan> {
  const { sourceToken, destinationToken, senderAddress, recipientAddress, walletId, amount, messenger } = request;
  const quote = await quoteMessenger(gateway, sourceToken, destinationToken, amount, messenger);

  return {
    quote,
    intent: null,
    bridgeStep: async (summary) => {
      const raw = await gateway.buildSendTransaction({
        amount: amount.amountInHumanUnits,
        fromAccountAddress: senderAddress,
        toAccountAddress: recipientAddress,
        sourceToken,
        destinationToken,
        messenger: toSdkMessenger(messenger),
        gasFeePaymentMethod: toSdkFeePaymentMethod(request.feePaymentMethod),
      });
      return txStep('bridge', summary, toUnsignedTransaction(raw, sourceToken, walletId), false);
    },
  };
}

/**
 * NEAR Intents: the deposit is created now and the bridge step is a plain transfer to its one-time
 * deposit address, valid until the deposit deadline.
 */
async function planNearIntents(gateway: CoreGateway, request: ExecutionRequest): Promise<MessengerPlan> {
  const { sourceToken, destinationToken, senderAddress, recipientAddress, walletId, amount } = request;
  const deposit = await gateway.createNearIntentsDeposit({
    amount: amount.amountInHumanUnits,
    sourceToken,
    destinationToken,
    fromAccountAddress: senderAddress,
    toAccountAddress: recipientAddress,
  });
  const quote = intentQuote('NEAR_INTENTS', sourceToken, destinationToken, deposit);
  const depositMemo = deposit.depositMemo ?? null;

  return {
    quote,
    intent: {
      provider: 'NEAR Intents',
      depositAddress: deposit.depositAddress,
      depositMemo,
      deadline: new Date(deposit.deadline).toISOString(),
      amountToSend: floatToTokenAmount(deposit.amountIn, sourceToken.decimals),
      amountToReceive: quote.amountToReceive,
      minAmountToReceive: quote.minAmountToReceive ?? quote.amountToReceive,
      submitDepositTool: 'submit_near_intents_deposit',
      submitDepositArguments: {
        depositAddress: deposit.depositAddress,
        ...(depositMemo ? { depositMemo } : {}),
        txId: '<bridge step transaction hash>',
      },
    },
    bridgeStep: async (summary) => {
      const raw = await gateway.buildSendTransaction({
        amount: amount.amountInHumanUnits,
        fromAccountAddress: senderAddress,
        toAccountAddress: recipientAddress,
        sourceToken,
        destinationToken,
        messenger: toSdkMessenger('NEAR_INTENTS'),
        nearIntentsDeposit: deposit,
      });
      return txStep(
        'bridge',
        `${summary} via NEAR Intents (transfer to deposit address ${deposit.depositAddress})`,
        toUnsignedTransaction(raw, sourceToken, walletId),
        false,
      );
    },
  };
}

/**
 * LI.FI Intents: the order lives for 40-120 s, so the bridge step is not built here. The job carries
 * the approval (if any) and the arguments of create_lifi_intents_order, which creates the order and
 * returns the transaction right before signing.
 */
async function planLifiIntents(gateway: CoreGateway, request: ExecutionRequest): Promise<MessengerPlan> {
  const { sourceToken, destinationToken, amount } = request;
  const quote = intentQuote(
    'LIFI_INTENTS',
    sourceToken,
    destinationToken,
    await gateway.getLifiIntentsQuote({ amount: amount.amountInHumanUnits, sourceToken, destinationToken }),
  );
  const maxSlippagePercent = request.maxSlippagePercent ?? DEFAULT_MAX_SLIPPAGE_PERCENT;
  const minAmountToReceive = applySlippage(quote.amountToReceive, destinationToken.decimals, maxSlippagePercent);
  const args = lifiOrderArguments(request, minAmountToReceive);

  return {
    quote,
    intent: {
      provider: 'LI.FI Intents',
      buildTool: 'create_lifi_intents_order',
      minAmountToReceive,
      maxSlippagePercent,
      bridgeContract: sourceToken.lifiIntents?.bridgeAddress ?? null,
    },
    bridgeStep: async (summary) => ({
      id: 'bridge',
      summary: `${summary} via LI.FI Intents`,
      transaction: null,
      transactionFormat: formatFor(sourceToken),
      waitForConfirmation: false,
      build: {
        tool: 'create_lifi_intents_order',
        arguments: args,
        reason: 'A LI.FI Intents order is valid for 40-120 seconds: create it right before signing, after any approval is confirmed.',
      },
    }),
  };
}

/**
 * Builds a bridge execution job: the quote, an advisory balance check, the destination
 * prerequisites, and the ordered steps (allowance reset, approve, bridge) with signer-ready
 * transactions. A LI.FI Intents bridge step is built later by create_lifi_intents_order.
 */
export async function createBridgeExecutionJob(gateway: CoreGateway, request: ExecutionRequest): Promise<BridgeExecutionJob> {
  const { sourceToken, destinationToken, senderAddress, recipientAddress, walletId, amount, messenger } = request;

  const plan = messenger === 'NEAR_INTENTS'
    ? await planNearIntents(gateway, request)
    : messenger === 'LIFI_INTENTS'
      ? await planLifiIntents(gateway, request)
      : await planBridgeMessenger(gateway, request);

  const [balanceValidation, destinationSetup, approvals] = await Promise.all([
    validateSenderBalances({ gateway, sourceToken, destinationToken, senderAddress, amount, quote: plan.quote, feePaymentMethod: request.feePaymentMethod }),
    detectDestinationSetup(gateway, destinationToken, recipientAddress, messenger),
    approvalSteps(gateway, request),
  ]);

  const summary = buildBridgeSummary({ sourceToken, destinationToken, amount, recipientAddress });
  const handoff = buildExecutionHandoff(sourceToken, senderAddress, walletId);
  const steps = linkSteps([...approvals, await plan.bridgeStep(summary)], handoff);
  const first = steps[0]!;

  return {
    jobId: randomUUID(),
    kind: 'bridge_transfer',
    version: 'v2',
    mode: 'external_signer',
    status: first.status === 'requires_build' ? 'requires_build' : 'awaiting_signature',
    summary,
    bridgePortalName: BRIDGE_PORTAL_NAME,
    bridgePortalUrl: BRIDGE_PORTAL_URL,
    bridgePortalDeepLink: buildBridgePortalDeepLink({ sourceToken, destinationToken, amount, messenger }),
    route: {
      source: summarizeToken(sourceToken),
      destination: summarizeToken(destinationToken),
      messenger,
      feePaymentMethod: plan.quote.kind === 'bridge' ? request.feePaymentMethod : null,
    },
    participants: { senderAddress, recipientAddress },
    amount,
    quote: plan.quote,
    intent: plan.intent,
    balanceValidation,
    handoff: {
      ...handoff,
      stepId: first.id,
      transactionFormat: first.transactionFormat,
      stepCount: steps.length,
      stepIds: steps.map((step) => step.id),
    },
    steps,
    tracking: {
      sourceChain: sourceToken.chainSymbol,
      destinationChain: destinationToken.chainSymbol,
      sourceTokenAddress: sourceToken.tokenAddress,
      destinationTokenAddress: destinationToken.tokenAddress,
      transferStatusTool: 'get_transfer_status',
      transferStatusArguments: { sourceChain: sourceToken.chainSymbol, txId: '<bridge step transaction hash>' },
      historyUrlTemplate: buildHistoryUrlTemplate(sourceToken.chainSymbol),
    },
    destinationSetup,
    nextAction: buildNextAction(steps, balanceValidation, destinationSetup, sourceToken, plan.intent),
  };
}

function buildNextAction(
  steps: ExecutionStep[],
  balanceValidation: BalanceValidation,
  destinationSetup: DestinationSetupRequirement | null,
  sourceToken: CoreToken,
  intent: BridgeExecutionJob['intent'],
): string {
  const family = sourceToken.chainType ?? 'the source chain';
  const parts: string[] = [];

  if (!balanceValidation.canProceed) {
    parts.push('The balance check did not pass (see balanceValidation); top up or fix it before signing.');
  }

  if (destinationSetup?.required === true) {
    parts.push(destinationSetup.buildTool
      ? `Before the bridge step, the recipient must complete destination setup: ${destinationSetup.reason} Use ${destinationSetup.buildTool} to build it.`
      : `Before the bridge step: ${destinationSetup.reason}`);
  } else if (destinationSetup?.required === null) {
    parts.push(destinationSetup.reason);
  }

  const signed = steps.filter((step) => step.transaction);
  if (signed.length > 0) {
    parts.push(signed.length > 1 || steps.length > signed.length
      ? `Execute the steps in order with local-signer-mcp sign_and_broadcast_transaction (${family}), waiting for each step marked waitForConfirmation to confirm before the next one.`
      : `Send the bridge step to local-signer-mcp sign_and_broadcast_transaction (${family}), or sign it elsewhere and call broadcast_signed_transaction.`);
  }

  if (intent?.provider === 'LI.FI Intents') {
    parts.push('Then call create_lifi_intents_order with the bridge step build.arguments and sign the returned transaction at once (the order is valid for 40-120 seconds).');
  }

  if (sourceToken.chainType === 'SOLANA' || sourceToken.chainType === 'TRX') {
    parts.push(`${sourceToken.chainType === 'SOLANA' ? 'Solana' : 'Tron'} transactions expire about a minute after they are built: sign them right away, or create the job again.`);
  }

  if (intent?.provider === 'NEAR Intents') {
    parts.push(`Send the deposit before ${intent.deadline}. After broadcasting, optionally call submit_near_intents_deposit with the transaction hash to speed it up.`);
  }

  parts.push('Track the transfer with get_transfer_status and the bridge transaction hash.');
  return parts.join(' ');
}
