import { FeePaymentMethod, type AmountFormatted, type GasFeeOptions } from '@allbridge/bridge-core-sdk';

import type { CoreGateway, CoreToken } from './core-gateway.js';
import { nativeDecimals, nativeSymbol } from './native-currency.js';
import { detectMessengers, type MessengerName, toSdkMessenger } from './messengers.js';
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

export type MessengerQuote = {
  messenger: MessengerName;
  /** bridge: deterministic Allbridge fee; intent: market-priced quote from a solver network. */
  kind: 'bridge';
  estimatedTimeMs: number | null;
  /** Amount received with the default payment method (WITH_NATIVE_CURRENCY). */
  amountToReceive: TokenAmount;
  feePaymentOptions: FeePaymentOption[];
};

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
  messenger: MessengerName,
): Promise<MessengerQuote> {
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

export async function quoteMessenger(
  gateway: CoreGateway,
  sourceToken: CoreToken,
  destinationToken: CoreToken,
  amount: NormalizedAmount,
  messenger: MessengerName,
): Promise<MessengerQuote> {
  return quoteBridgeMessenger(gateway, sourceToken, destinationToken, amount, messenger);
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
