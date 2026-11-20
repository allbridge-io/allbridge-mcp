import type { TokenCoreFields } from '@allbridge/bridge-core-sdk';

import type { CoreGateway, CoreToken } from './core-gateway.js';
import type { MessengerName } from './messengers.js';
import { nativeDecimals, nativeSymbol } from './native-currency.js';
import type { MessengerQuote } from './quotes.js';
import { toUserFacingError } from './sdk-errors.js';
import { UserFacingToolError } from './tool-errors.js';
import {
  type FeePaymentMethodName,
  floatToTokenAmount,
  type NormalizedAmount,
  summarizeToken,
} from './tools/shared.js';

export type BalanceRequirementKind = 'source_token' | 'source_native' | 'fee_native' | 'fee_abr';

export type BalanceRequirement = {
  kind: BalanceRequirementKind;
  label: string;
  chainSymbol: string;
  tokenAddress: string | null;
  requiredBaseUnits: string;
  availableBaseUnits: string | null;
  availableHumanUnits: string | null;
  satisfied: boolean | null;
  error?: string;
};

export type BalanceValidation = {
  sourceToken: ReturnType<typeof summarizeToken>;
  destinationToken: ReturnType<typeof summarizeToken>;
  amount: NormalizedAmount;
  messenger: MessengerName;
  feePaymentMethod: FeePaymentMethodName | null;
  requiredBalances: BalanceRequirement[];
  canProceed: boolean;
  notes: string[];
  nextAction: string;
};

type PendingRequirement = Omit<BalanceRequirement, 'availableBaseUnits' | 'availableHumanUnits' | 'satisfied'> & {
  read: () => Promise<{ inBaseUnits: string; inHumanUnits: string }>;
};

function add(left: string, right: string): string {
  return (BigInt(left) + BigInt(right)).toString();
}

/**
 * Checks that the sender holds what the transfer needs on the source chain: the amount, plus the
 * destination gas fee when it is paid in the native currency or in ABR. A fee paid in the source
 * token is deducted from the amount, so it needs no extra balance. Network transaction fees are not
 * included; they are reported in `notes`.
 */
export async function validateSenderBalances(params: {
  gateway: CoreGateway;
  sourceToken: CoreToken;
  destinationToken: CoreToken;
  senderAddress: string;
  amount: NormalizedAmount;
  quote: MessengerQuote;
  feePaymentMethod: FeePaymentMethodName;
}): Promise<BalanceValidation> {
  const { gateway, sourceToken, senderAddress, amount, quote } = params;
  const feePaymentMethod = params.feePaymentMethod;
  const notes: string[] = [];

  const feeOption = quote.feePaymentOptions.find((option) => option.feePaymentMethod === feePaymentMethod);
  if (!feeOption) {
    throw new UserFacingToolError('validation_error', `${feePaymentMethod} is not available for ${quote.messenger} on this route.`, {
      messenger: quote.messenger,
      feePaymentMethod,
      availableFeePaymentMethods: quote.feePaymentOptions.map((option) => option.feePaymentMethod),
    });
  }

  const readNative = async () => {
    const balance = await gateway.getNativeTokenBalance(senderAddress, sourceToken.chainSymbol);
    return floatToTokenAmount(balance.float, nativeDecimals(sourceToken));
  };
  const readToken = (token: TokenCoreFields) => async () =>
    floatToTokenAmount(await gateway.getTokenBalance(senderAddress, token), token.decimals);
  const nativeLabel = `${nativeSymbol(sourceToken) ?? sourceToken.chainSymbol} balance on ${sourceToken.chainSymbol}`;

  const pending: PendingRequirement[] = [];
  const sourceRequirement: PendingRequirement = sourceToken.isNative
    ? {
        kind: 'source_native',
        label: nativeLabel,
        chainSymbol: sourceToken.chainSymbol,
        tokenAddress: null,
        requiredBaseUnits: amount.amountInBaseUnits,
        read: readNative,
      }
    : {
        kind: 'source_token',
        label: `${sourceToken.symbol} balance on ${sourceToken.chainSymbol}`,
        chainSymbol: sourceToken.chainSymbol,
        tokenAddress: sourceToken.tokenAddress,
        requiredBaseUnits: amount.amountInBaseUnits,
        read: readToken(sourceToken),
      };
  pending.push(sourceRequirement);

  if (feePaymentMethod === 'WITH_NATIVE_CURRENCY' && feeOption.fee.inBaseUnits !== '0') {
    if (sourceToken.isNative) {
      sourceRequirement.requiredBaseUnits = add(sourceRequirement.requiredBaseUnits, feeOption.fee.inBaseUnits);
      sourceRequirement.label = `${sourceRequirement.label} (amount + gas fee)`;
    } else {
      pending.push({
        kind: 'fee_native',
        label: `${nativeLabel} for the gas fee`,
        chainSymbol: sourceToken.chainSymbol,
        tokenAddress: null,
        requiredBaseUnits: feeOption.fee.inBaseUnits,
        read: readNative,
      });
    }
  }

  if (feePaymentMethod === 'WITH_STABLECOIN') {
    notes.push(`The ${feeOption.fee.inHumanUnits} ${sourceToken.symbol} gas fee is deducted from the transferred amount.`);
    if (feeOption.amountToReceive === null) {
      notes.push('The gas fee is larger than the amount: increase the amount or pay the fee in the native currency.');
    }
  }

  if (feePaymentMethod === 'WITH_ABR' && feeOption.fee.inBaseUnits !== '0') {
    const abrToken = sourceToken.abrPayer?.abrToken;
    if (abrToken) {
      pending.push({
        kind: 'fee_abr',
        label: `ABR balance on ${sourceToken.chainSymbol} for the gas fee`,
        chainSymbol: sourceToken.chainSymbol,
        tokenAddress: abrToken.tokenAddress,
        requiredBaseUnits: feeOption.fee.inBaseUnits,
        read: readToken(abrToken),
      });
    }
  }

  notes.push(`Network transaction fees on ${sourceToken.chainSymbol} are paid in ${nativeSymbol(sourceToken) ?? 'the native currency'} on top of these amounts.`);

  const requiredBalances = await Promise.all(pending.map(async ({ read, ...requirement }): Promise<BalanceRequirement> => {
    try {
      const available = await read();
      return {
        ...requirement,
        availableBaseUnits: available.inBaseUnits,
        availableHumanUnits: available.inHumanUnits,
        satisfied: BigInt(available.inBaseUnits) >= BigInt(requirement.requiredBaseUnits),
      };
    } catch (error) {
      return {
        ...requirement,
        availableBaseUnits: null,
        availableHumanUnits: null,
        satisfied: null,
        error: toUserFacingError(error, { action: `Read ${requirement.label}` }).message,
      };
    }
  }));

  const unreadable = requiredBalances.some((requirement) => requirement.satisfied === null);
  const canProceed = requiredBalances.every((requirement) => requirement.satisfied === true)
    && (feePaymentMethod !== 'WITH_STABLECOIN' || feeOption.amountToReceive !== null);

  return {
    sourceToken: summarizeToken(sourceToken),
    destinationToken: summarizeToken(params.destinationToken),
    amount,
    messenger: quote.messenger,
    feePaymentMethod,
    requiredBalances,
    canProceed,
    notes,
    nextAction: canProceed
      ? 'Balances are sufficient. You can call create_bridge_execution_job now.'
      : unreadable
        ? 'Some balances could not be read (see requiredBalances[].error). Check the RPC configuration or retry before building the job.'
        : 'Top up the insufficient balance(s) and rerun check_sender_balances before create_bridge_execution_job.',
  };
}
