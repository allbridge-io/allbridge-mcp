import { FeePaymentMethod, type AmountFormatted, type GasFeeOptions } from '@allbridge/bridge-core-sdk';

import type { CoreGateway, CoreToken } from './core-gateway.js';
import { nativeDecimals, nativeSymbol } from './native-currency.js';
import {
  type BridgeMessengerName,
  detectMessengers,
  type IntentMessengerName,
  isIntentMessenger,
  type MessengerName,
  toSdkMessenger,
} from './messengers.js';
import { toUserFacingError } from './sdk-errors.js';
import {
  baseUnitsToTokenAmount,
  type FeePaymentMethodName,
  floatToTokenAmount,
  type NormalizedAmount,
  type TokenAmount,
} from './tools/shared.js';
import { baseUnitsToDecimal } from './utils.js';

export type FeeAsset = 'native' | 'source_token' | 'abr';

export type FeePaymentOption = {
  feePaymentMethod: FeePaymentMethodName;
  /** The gas fee for the destination chain, charged on the source chain. */
  fee: TokenAmount & { asset: FeeAsset; symbol: string | null };
  /** What the recipient gets with this payment method; null when the fee exceeds the amount. */
  amountToReceive: TokenAmount | null;
};

/** A bridge messenger: deterministic Allbridge fee, gas fee paid with one of `feePaymentOptions`. */
export type BridgeMessengerQuote = {
  messenger: BridgeMessengerName;
  kind: 'bridge';
  estimatedTimeMs: number | null;
  /** Amount received with the default payment method (WITH_NATIVE_CURRENCY). */
  amountToReceive: TokenAmount;
  feePaymentOptions: FeePaymentOption[];
};

/**
 * An intent messenger: a market-priced quote from a solver network. There is no gas fee to choose;
 * the amounts already include every fee.
 */
export type IntentMessengerQuote = {
  messenger: IntentMessengerName;
  kind: 'intent';
  provider: 'NEAR Intents' | 'LI.FI Intents';
  estimatedTimeMs: number | null;
  /** Expected amount to receive. */
  amountToReceive: TokenAmount;
  /** NEAR Intents: the amount guaranteed after slippage. */
  minAmountToReceive: TokenAmount | null;
  /** LI.FI Intents: the Allbridge fee, a part of the sent amount, in source token units. */
  allbridgeFee: (TokenAmount & { symbol: string }) | null;
  /** True when the amounts come from a recent-quotes model rather than a live quote for this amount. */
  estimated: boolean;
  feePaymentOptions: [];
  notes: string[];
};

export type MessengerQuote = BridgeMessengerQuote | IntentMessengerQuote;

export type UnavailableQuote = {
  messenger: MessengerName;
  code: string;
  message: string;
  details: Record<string, unknown> | null;
};

export type RouteQuote = {
  options: MessengerQuote[];
  unavailable: UnavailableQuote[];
};

function amountFromFormatted(formatted: AmountFormatted, decimals: number): TokenAmount {
  const inBaseUnits = formatted.int;
  if (/^\d+$/.test(inBaseUnits)) {
    return baseUnitsToTokenAmount(inBaseUnits, decimals);
  }
  return floatToTokenAmount(formatted.float, decimals);
}

function subtractBaseUnits(left: string, right: string): string | null {
  const result = BigInt(left) - BigInt(right);
  return result > 0n ? result.toString() : null;
}

async function quoteBridgeMessenger(
  gateway: CoreGateway,
  sourceToken: CoreToken,
  destinationToken: CoreToken,
  amount: NormalizedAmount,
  messenger: BridgeMessengerName,
): Promise<BridgeMessengerQuote> {
  const sdkMessenger = toSdkMessenger(messenger);
  const result = await gateway.getAmountToBeReceivedAndGasFeeOptions(
    amount.amountInHumanUnits,
    sourceToken,
    destinationToken,
    sdkMessenger,
  );
  const amountToReceive = floatToTokenAmount(result.amountToBeReceivedFloat, destinationToken.decimals);
  const gasFeeOptions: GasFeeOptions = result.gasFeeOptions;
  const options: FeePaymentOption[] = [];

  const native = gasFeeOptions[FeePaymentMethod.WITH_NATIVE_CURRENCY];
  if (native) {
    const fee = amountFromFormatted(native, nativeDecimals(sourceToken));
    options.push({
      feePaymentMethod: 'WITH_NATIVE_CURRENCY',
      fee: { ...fee, asset: 'native', symbol: nativeSymbol(sourceToken) },
      amountToReceive,
    });
  }

  const stablecoin = gasFeeOptions[FeePaymentMethod.WITH_STABLECOIN];
  if (stablecoin) {
    const fee = amountFromFormatted(stablecoin, sourceToken.decimals);
    // The stablecoin fee is deducted from the transferred amount, so the recipient gets the quote for the rest.
    const remainder = subtractBaseUnits(amount.amountInBaseUnits, fee.inBaseUnits);
    const received = remainder === null
      ? null
      : fee.inBaseUnits === '0'
        ? amountToReceive
        : floatToTokenAmount(
            await gateway.getAmountToBeReceived(
              baseUnitsToDecimal(remainder, sourceToken.decimals),
              sourceToken,
              destinationToken,
              sdkMessenger,
            ),
            destinationToken.decimals,
          );
    options.push({
      feePaymentMethod: 'WITH_STABLECOIN',
      fee: { ...fee, asset: 'source_token', symbol: sourceToken.symbol },
      amountToReceive: received,
    });
  }

  const abr = gasFeeOptions[FeePaymentMethod.WITH_ABR];
  const abrToken = sourceToken.abrPayer?.abrToken;
  if (abr && abrToken) {
    options.push({
      feePaymentMethod: 'WITH_ABR',
      fee: { ...amountFromFormatted(abr, abrToken.decimals), asset: 'abr', symbol: 'ABR' },
      amountToReceive,
    });
  }

  return {
    messenger,
    kind: 'bridge',
    estimatedTimeMs: gateway.getAverageTransferTime(sourceToken, destinationToken, sdkMessenger),
    amountToReceive,
    feePaymentOptions: options,
  };
}

const INTENT_NOTES = {
  NEAR_INTENTS: [
    'Market-priced: the amounts are set when the deposit is created and may differ slightly from this quote.',
    'If the transfer cannot be completed, NEAR Intents refunds the deposit to the sender minus a refund fee.',
  ],
  LIFI_INTENTS: [
    'Market-priced: the order is priced when it is created, right before signing.',
    'An unfilled order is refunded to the sender by LI.FI; the Allbridge fee is not refunded.',
  ],
} as const;

/** Builds an intent quote from the float amounts of an SDK quote, deposit or order. */
export function intentQuote(
  messenger: IntentMessengerName,
  sourceToken: CoreToken,
  destinationToken: CoreToken,
  amounts: { amountOut: string; minAmountOut?: string; fee?: string; timeEstimate: number; estimated?: boolean },
): IntentMessengerQuote {
  return {
    messenger,
    kind: 'intent',
    provider: messenger === 'NEAR_INTENTS' ? 'NEAR Intents' : 'LI.FI Intents',
    estimatedTimeMs: Number.isFinite(amounts.timeEstimate) ? Math.round(amounts.timeEstimate * 1000) : null,
    amountToReceive: floatToTokenAmount(amounts.amountOut, destinationToken.decimals),
    minAmountToReceive: amounts.minAmountOut ? floatToTokenAmount(amounts.minAmountOut, destinationToken.decimals) : null,
    allbridgeFee: amounts.fee
      ? { ...floatToTokenAmount(amounts.fee, sourceToken.decimals), symbol: sourceToken.symbol }
      : null,
    estimated: amounts.estimated === true,
    feePaymentOptions: [],
    notes: [...INTENT_NOTES[messenger]],
  };
}

async function quoteIntentMessenger(
  gateway: CoreGateway,
  sourceToken: CoreToken,
  destinationToken: CoreToken,
  amount: NormalizedAmount,
  messenger: IntentMessengerName,
): Promise<IntentMessengerQuote> {
  const params = { amount: amount.amountInHumanUnits, sourceToken, destinationToken };

  if (messenger === 'NEAR_INTENTS') {
    return intentQuote(messenger, sourceToken, destinationToken, await gateway.getNearIntentsQuote(params));
  }

  return intentQuote(messenger, sourceToken, destinationToken, await gateway.getLifiIntentsQuote(params));
}

export async function quoteMessenger(
  gateway: CoreGateway,
  sourceToken: CoreToken,
  destinationToken: CoreToken,
  amount: NormalizedAmount,
  messenger: MessengerName,
): Promise<MessengerQuote> {
  return isIntentMessenger(messenger)
    ? quoteIntentMessenger(gateway, sourceToken, destinationToken, amount, messenger)
    : quoteBridgeMessenger(gateway, sourceToken, destinationToken, amount, messenger);
}

/**
 * Quotes every messenger available for the route. A messenger that cannot quote this amount
 * (amount limits, no liquidity) is reported in `unavailable` instead of failing the whole quote.
 */
export async function quoteRoute(
  gateway: CoreGateway,
  sourceToken: CoreToken,
  destinationToken: CoreToken,
  amount: NormalizedAmount,
  messengers: MessengerName[] = detectMessengers(sourceToken, destinationToken),
): Promise<RouteQuote> {
  const settled = await Promise.allSettled(
    messengers.map((messenger) => quoteMessenger(gateway, sourceToken, destinationToken, amount, messenger)),
  );

  const options: MessengerQuote[] = [];
  const unavailable: UnavailableQuote[] = [];

  settled.forEach((result, index) => {
    const messenger = messengers[index]!;
    if (result.status === 'fulfilled') {
      options.push(result.value);
      return;
    }

    const error = toUserFacingError(result.reason, { action: `Quote ${messenger}`, sourceToken });
    unavailable.push({ messenger, code: error.code, message: error.message, details: error.details ?? null });
  });

  options.sort((left, right) => {
    const diff = BigInt(right.amountToReceive.inBaseUnits) - BigInt(left.amountToReceive.inBaseUnits);
    return diff > 0n ? 1 : diff < 0n ? -1 : 0;
  });

  return { options, unavailable };
}
