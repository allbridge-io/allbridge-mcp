import {
  CCTPDoesNotSupportedError,
  LifiIntentsAmountTooHighError,
  LifiIntentsAmountTooLowError,
  LifiIntentsDoesNotSupportedError,
  LifiIntentsNoQuoteError,
  LifiIntentsQuoteError,
  NearIntentsAmountTooLowError,
  NearIntentsDoesNotSupportedError,
  NearIntentsNoLiquidityError,
  NearIntentsQuoteError,
  NodeRpcUrlNotInitializedError,
  OFTDoesNotSupportedError,
  SdkRootError,
} from '@allbridge/bridge-core-sdk';
import axios, { type AxiosError } from 'axios';

import type { CoreToken } from './core-gateway.js';
import { type ToolErrorDetails, UserFacingToolError } from './tool-errors.js';
import { baseUnitsToDecimal } from './utils.js';

function amountLimit(value: string | undefined, token: CoreToken | undefined) {
  if (!value || !/^\d+$/.test(value)) {
    return null;
  }

  return {
    inBaseUnits: value,
    inHumanUnits: token ? baseUnitsToDecimal(value, token.decimals) : null,
  };
}

function axiosDetails(error: AxiosError): ToolErrorDetails {
  return {
    status: error.response?.status ?? null,
    response: error.response?.data ?? null,
  };
}

/**
 * Turns an error thrown by the Allbridge Core SDK (or its HTTP and RPC calls) into a
 * structured tool error. Returns the error unchanged when it is already user-facing.
 */
export function toUserFacingError(
  error: unknown,
  context: { action: string; sourceToken?: CoreToken; details?: ToolErrorDetails },
): UserFacingToolError {
  if (error instanceof UserFacingToolError) {
    return error;
  }

  const details: ToolErrorDetails = { ...context.details };
  const reason = error instanceof Error ? error.message : String(error);

  if (error instanceof NearIntentsAmountTooLowError || error instanceof LifiIntentsAmountTooLowError) {
    return new UserFacingToolError('amount_too_low', `${context.action}: the amount is below the minimum for this route.`, {
      ...details,
      reason,
      minAmount: amountLimit(error.minAmount, context.sourceToken),
      ...(error instanceof NearIntentsAmountTooLowError && error.minAmountUsd ? { minAmountUsd: error.minAmountUsd } : {}),
    });
  }

  if (error instanceof LifiIntentsAmountTooHighError) {
    return new UserFacingToolError('amount_too_high', `${context.action}: the amount is above the maximum for this route.`, {
      ...details,
      reason,
      maxAmount: amountLimit(error.maxAmount, context.sourceToken),
    });
  }

  if (
    error instanceof NearIntentsNoLiquidityError
    || error instanceof NearIntentsQuoteError
    || error instanceof LifiIntentsNoQuoteError
    || error instanceof LifiIntentsQuoteError
  ) {
    return new UserFacingToolError('quote_unavailable', `${context.action}: no quote is available for this route right now.`, {
      ...details,
      reason,
    });
  }

  if (
    error instanceof CCTPDoesNotSupportedError
    || error instanceof OFTDoesNotSupportedError
    || error instanceof NearIntentsDoesNotSupportedError
    || error instanceof LifiIntentsDoesNotSupportedError
  ) {
    return new UserFacingToolError('unsupported_route', `${context.action}: the messenger does not support this route.`, {
      ...details,
      reason,
    });
  }

  if (error instanceof NodeRpcUrlNotInitializedError) {
    return new UserFacingToolError('rpc_unavailable', `${context.action}: no RPC is configured for the chain.`, {
      ...details,
      reason,
      hint: 'Set ALLBRIDGE_<CHAIN>_RPC_URL for the chain, for example ALLBRIDGE_ETH_RPC_URL.',
    });
  }

  if (error instanceof SdkRootError) {
    return new UserFacingToolError('validation_error', `${context.action}: ${reason}`, {
      ...details,
      reason,
      sdkErrorCode: error.errorCode,
    });
  }

  if (axios.isAxiosError(error)) {
    return new UserFacingToolError('upstream_error', `${context.action}: the upstream request failed.`, {
      ...details,
      reason,
      ...axiosDetails(error),
    });
  }

  return new UserFacingToolError('upstream_error', `${context.action}: ${reason}`, {
    ...details,
    reason,
  });
}
