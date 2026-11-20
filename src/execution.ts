import { randomUUID } from 'node:crypto';

import { Interface } from 'ethers';

import { validateSenderBalances, type BalanceValidation } from './balances.js';
import type { CoreGateway, CoreToken } from './core-gateway.js';
import { detectDestinationSetup, type DestinationSetupRequirement } from './destination-setup.js';
import { type MessengerName, toSdkMessenger } from './messengers.js';
import { quoteMessenger, type MessengerQuote } from './quotes.js';
import {
  BRIDGE_PORTAL_NAME,
  BRIDGE_PORTAL_URL,
  buildBridgePortalDeepLink,
  buildBridgeSummary,
  buildHistoryUrlTemplate,
  type FeePaymentMethodName,
  type NormalizedAmount,
  summarizeToken,
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

export type ExecutionStep = {
  id: ExecutionStepId;
  order: number;
  type: 'sign_and_submit_transaction';
  status: 'awaiting_signature' | 'blocked';
  required: true;
  summary: string;
  transactionFormat: TransactionFormat;
  transaction: UnsignedTransaction;
  handoff: ExecutionHandoff & { stepId: ExecutionStepId; transactionFormat: TransactionFormat; nextStepId: string };
  waitForConfirmation: boolean;
  nextOnSuccess: string;
};

export type BridgeExecutionJob = {
  jobId: string;
  kind: 'bridge_transfer';
  version: 'v2';
  mode: 'external_signer';
  status: 'awaiting_signature';
  summary: string;
  bridgePortalName: string;
  bridgePortalUrl: string;
  bridgePortalDeepLink: string;
  route: {
    source: ReturnType<typeof summarizeToken>;
    destination: ReturnType<typeof summarizeToken>;
    messenger: MessengerName;
    feePaymentMethod: FeePaymentMethodName;
  };
  participants: { senderAddress: string; recipientAddress: string };
  amount: NormalizedAmount;
  quote: MessengerQuote;
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
};

/** Ethereum USDT reverts `approve` from a non-zero allowance to another non-zero value. */
const RESET_ALLOWANCE_TOKENS = new Set(['ETH:0xdac17f958d2ee523a2206206994597c13d831ec7']);

const erc20 = new Interface(['function approve(address spender, uint256 amount)']);

function needsApproval(token: CoreToken): boolean {
  return !token.isNative && (token.chainType === 'EVM' || token.chainType === 'TRX');
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

function linkSteps(
  steps: Array<Omit<ExecutionStep, 'order' | 'status' | 'handoff' | 'nextOnSuccess' | 'type' | 'required' | 'transactionFormat'>>,
  handoff: ExecutionHandoff,
): ExecutionStep[] {
  return steps.map((step, index) => {
    const next = steps[index + 1]?.id ?? 'track_transfer';
    const transactionFormat = TRANSACTION_FORMATS[step.transaction.chainFamily];
    return {
      ...step,
      order: index + 1,
      type: 'sign_and_submit_transaction',
      status: index === 0 ? 'awaiting_signature' : 'blocked',
      required: true,
      transactionFormat,
      handoff: { ...handoff, stepId: step.id, transactionFormat, nextStepId: next },
      nextOnSuccess: next,
    };
  });
}

/**
 * Builds a bridge execution job: the quote, an advisory balance check, the destination
 * prerequisites, and the ordered signer-ready transactions (allowance reset, approve, bridge).
 */
export async function createBridgeExecutionJob(gateway: CoreGateway, request: ExecutionRequest): Promise<BridgeExecutionJob> {
  const { sourceToken, destinationToken, senderAddress, recipientAddress, walletId, amount, messenger, feePaymentMethod } = request;
  const sdkMessenger = toSdkMessenger(messenger);
  const gasFeePaymentMethod = toSdkFeePaymentMethod(feePaymentMethod);

  const quote = await quoteMessenger(gateway, sourceToken, destinationToken, amount, messenger);
  const [balanceValidation, destinationSetup] = await Promise.all([
    validateSenderBalances({ gateway, sourceToken, destinationToken, senderAddress, amount, quote, feePaymentMethod }),
    detectDestinationSetup(gateway, destinationToken, recipientAddress),
  ]);

  const steps: Array<Omit<ExecutionStep, 'order' | 'status' | 'handoff' | 'nextOnSuccess' | 'type' | 'required' | 'transactionFormat'>> = [];

  if (needsApproval(sourceToken)) {
    const allowanceParams = { token: sourceToken, owner: senderAddress, messenger: sdkMessenger, gasFeePaymentMethod };
    const approved = await gateway.checkAllowance({ ...allowanceParams, amount: amount.amountInHumanUnits });
    if (!approved) {
      const approval = toUnsignedTransaction(await gateway.buildApproveTransaction(allowanceParams), sourceToken, walletId);

      if (needsAllowanceReset(sourceToken) && BigInt(await gateway.getAllowance(allowanceParams)) > 0n) {
        steps.push({
          id: 'reset_allowance',
          summary: `Reset the ${sourceToken.symbol} allowance on ${sourceToken.chainSymbol} to 0 (required by this token before a new approval).`,
          transaction: toZeroApproval(approval),
          waitForConfirmation: true,
        });
      }

      steps.push({
        id: 'approve',
        summary: `Approve ${sourceToken.symbol} spending on ${sourceToken.chainSymbol} for ${messenger}.`,
        transaction: approval,
        waitForConfirmation: true,
      });
    }
  }

  const bridgeTransaction = await gateway.buildSendTransaction({
    amount: amount.amountInHumanUnits,
    fromAccountAddress: senderAddress,
    toAccountAddress: recipientAddress,
    sourceToken,
    destinationToken,
    messenger: sdkMessenger,
    gasFeePaymentMethod,
  });
  const summary = buildBridgeSummary({ sourceToken, destinationToken, amount, recipientAddress });
  steps.push({
    id: 'bridge',
    summary,
    transaction: toUnsignedTransaction(bridgeTransaction, sourceToken, walletId),
    waitForConfirmation: false,
  });

  const handoff = buildExecutionHandoff(sourceToken, senderAddress, walletId);
  const linked = linkSteps(steps, handoff);
  const first = linked[0]!;

  return {
    jobId: randomUUID(),
    kind: 'bridge_transfer',
    version: 'v2',
    mode: 'external_signer',
    status: 'awaiting_signature',
    summary,
    bridgePortalName: BRIDGE_PORTAL_NAME,
    bridgePortalUrl: BRIDGE_PORTAL_URL,
    bridgePortalDeepLink: buildBridgePortalDeepLink({ sourceToken, destinationToken, amount, messenger }),
    route: {
      source: summarizeToken(sourceToken),
      destination: summarizeToken(destinationToken),
      messenger,
      feePaymentMethod,
    },
    participants: { senderAddress, recipientAddress },
    amount,
    quote,
    balanceValidation,
    handoff: {
      ...handoff,
      stepId: first.id,
      transactionFormat: first.transactionFormat,
      stepCount: linked.length,
      stepIds: linked.map((step) => step.id),
    },
    steps: linked,
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
    nextAction: buildNextAction(linked, balanceValidation, destinationSetup, sourceToken),
  };
}

function buildNextAction(
  steps: ExecutionStep[],
  balanceValidation: BalanceValidation,
  destinationSetup: DestinationSetupRequirement | null,
  sourceToken: CoreToken,
): string {
  const family = sourceToken.chainType ?? 'the source chain';
  const parts: string[] = [];

  if (!balanceValidation.canProceed) {
    parts.push('The balance check did not pass (see balanceValidation); top up or fix it before signing.');
  }

  if (destinationSetup?.required === true) {
    parts.push(`Before the bridge step, the recipient must complete destination setup: ${destinationSetup.reason} Use ${destinationSetup.buildTool} to build it.`);
  } else if (destinationSetup?.required === null) {
    parts.push(destinationSetup.reason);
  }

  parts.push(
    steps.length > 1
      ? `Execute the steps in order with local-signer-mcp sign_and_broadcast_transaction (${family}), waiting for each step marked waitForConfirmation to confirm before the next one.`
      : `Send the bridge step to local-signer-mcp sign_and_broadcast_transaction (${family}), or sign it elsewhere and call broadcast_signed_transaction.`,
  );
  parts.push('Then call get_transfer_status with the bridge transaction hash.');

  return parts.join(' ');
}
