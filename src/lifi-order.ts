import type { CoreGateway, CoreToken } from './core-gateway.js';
import { buildExecutionHandoff, linkSteps, type ExecutionStep } from './execution.js';
import { toSdkMessenger } from './messengers.js';
import { intentQuote, type IntentMessengerQuote } from './quotes.js';
import { UserFacingToolError } from './tool-errors.js';
import { buildBridgeSummary, buildHistoryUrlTemplate, type NormalizedAmount, type TokenAmount } from './tools/shared.js';
import { TRANSACTION_FORMATS, toUnsignedTransaction } from './unsigned-transaction.js';

export type LifiOrderRequest = {
  sourceToken: CoreToken;
  destinationToken: CoreToken;
  senderAddress: string;
  recipientAddress: string;
  walletId?: string;
  amount: NormalizedAmount;
  /** Stop with price_changed when the order pays less than this (destination base units). */
  minAmountToReceive?: TokenAmount;
};

export type LifiOrderResult = {
  order: {
    orderId: string;
    validUntil: string;
    fillDeadline: string;
    secondsToSign: number;
  };
  quote: IntentMessengerQuote;
  step: ExecutionStep;
  tracking: {
    sourceChain: string;
    transferStatusTool: 'get_transfer_status';
    transferStatusArguments: { sourceChain: string; txId: string };
    explorerTransferId: string;
    historyUrlTemplate: string;
  };
  nextAction: string;
};

function sameAddress(left: string | undefined, right: string | undefined): boolean {
  return Boolean(left && right && left.toLowerCase() === right.toLowerCase());
}

/**
 * Creates a LI.FI Intents order and returns its transaction as a signer-ready step. The order is
 * short-lived, so this runs right before signing. It refuses to continue when the allowance is
 * missing, when the order pays less than `minAmountToReceive`, or when the transaction does not
 * call the Allbridge LifiIntentsBridge contract on behalf of the sender.
 */
export async function createLifiOrderStep(gateway: CoreGateway, request: LifiOrderRequest, now: () => Date = () => new Date()): Promise<LifiOrderResult> {
  const { sourceToken, destinationToken, senderAddress, recipientAddress, walletId, amount } = request;
  const bridgeAddress = sourceToken.lifiIntents?.bridgeAddress;
  const isEvm = sourceToken.chainType === 'EVM';

  if (isEvm && !sourceToken.isNative) {
    const approved = await gateway.checkAllowance({
      token: sourceToken,
      owner: senderAddress,
      amount: amount.amountInHumanUnits,
      messenger: toSdkMessenger('LIFI_INTENTS'),
    });
    if (!approved) {
      throw new UserFacingToolError('approval_required', `The ${sourceToken.symbol} allowance for the LI.FI Intents bridge is not in place yet.`, {
        spender: bridgeAddress ?? null,
        owner: senderAddress,
        nextAction: 'Sign the approve step of the execution job and wait for it to confirm, then call create_lifi_intents_order again.',
      });
    }
  }

  const order = await gateway.createLifiIntentsOrder({
    amount: amount.amountInHumanUnits,
    sourceToken,
    destinationToken,
    fromAccountAddress: senderAddress,
    toAccountAddress: recipientAddress,
  });
  const quote = intentQuote('LIFI_INTENTS', sourceToken, destinationToken, order);

  if (request.minAmountToReceive && BigInt(quote.amountToReceive.inBaseUnits) < BigInt(request.minAmountToReceive.inBaseUnits)) {
    throw new UserFacingToolError('price_changed', `The LI.FI Intents order now pays ${quote.amountToReceive.inHumanUnits} ${destinationToken.symbol}, below the accepted minimum of ${request.minAmountToReceive.inHumanUnits}.`, {
      orderAmountToReceive: quote.amountToReceive,
      minAmountToReceive: request.minAmountToReceive,
      nextAction: `Ask the user to accept the new amount; to proceed, call create_lifi_intents_order again with minAmountToReceive ${quote.amountToReceive.inBaseUnits} (or lower).`,
    });
  }

  if (order.approval && bridgeAddress && !sameAddress(order.approval.spender, bridgeAddress)) {
    throw new UserFacingToolError('validation_error', 'The LI.FI Intents order asks for an approval to an unexpected spender; refusing to continue.', {
      expectedSpender: bridgeAddress,
      spender: order.approval.spender,
    });
  }

  const raw = await gateway.buildSendTransaction({
    amount: amount.amountInHumanUnits,
    fromAccountAddress: senderAddress,
    toAccountAddress: recipientAddress,
    sourceToken,
    destinationToken,
    messenger: toSdkMessenger('LIFI_INTENTS'),
    lifiIntentsOrder: order,
  });
  const transaction = toUnsignedTransaction(raw, sourceToken, walletId);

  if (transaction.chainFamily === 'EVM' && (!sameAddress(transaction.to, bridgeAddress) || !sameAddress(transaction.from, senderAddress))) {
    throw new UserFacingToolError('validation_error', 'The LI.FI Intents transaction does not call the Allbridge LifiIntentsBridge contract from the sender; refusing to return it.', {
      expectedContract: bridgeAddress ?? null,
      contract: transaction.to,
      from: transaction.from,
      senderAddress,
    });
  }

  const summary = `${buildBridgeSummary({ sourceToken, destinationToken, amount, recipientAddress })} via LI.FI Intents (order ${order.orderId})`;
  const [step] = linkSteps(
    [{ id: 'bridge', summary, transaction, transactionFormat: TRANSACTION_FORMATS[transaction.chainFamily], waitForConfirmation: false }],
    buildExecutionHandoff(sourceToken, senderAddress, walletId),
  );
  const validUntil = new Date(order.validUntil);
  const secondsToSign = Math.max(0, Math.floor((validUntil.getTime() - now().getTime()) / 1000));

  return {
    order: {
      orderId: order.orderId,
      validUntil: validUntil.toISOString(),
      fillDeadline: new Date(order.fillDeadline).toISOString(),
      secondsToSign,
    },
    quote,
    step: step!,
    tracking: {
      sourceChain: sourceToken.chainSymbol,
      transferStatusTool: 'get_transfer_status',
      transferStatusArguments: { sourceChain: sourceToken.chainSymbol, txId: '<bridge step transaction hash>' },
      explorerTransferId: order.orderId,
      historyUrlTemplate: buildHistoryUrlTemplate(sourceToken.chainSymbol),
    },
    nextAction: `Sign and broadcast the step now with local-signer-mcp sign_and_broadcast_transaction: the order is valid for about ${secondsToSign} more seconds. If it expires or the transaction fails, call create_lifi_intents_order again for a new order. Then track it with get_transfer_status.`,
  };
}
