import type { CoreGateway, CoreToken } from './core-gateway.js';
import { toUserFacingError } from './sdk-errors.js';

/**
 * Something the recipient must have in place on the destination chain before the transfer can be
 * delivered. `buildTool` is set when this server can build the missing transaction for the recipient.
 */
export type DestinationSetupRequirement = {
  required: boolean | null;
  type: 'stellar_trustline';
  chainSymbol: string;
  accountAddress: string;
  tokenAddress: string;
  checkTool: 'check_stellar_trustline';
  buildTool: 'build_stellar_trustline_transaction';
  reason: string;
};

export async function checkStellarTrustline(
  gateway: CoreGateway,
  accountAddress: string,
  tokenAddress: string,
): Promise<{ hasTrustline: boolean; balanceLine: unknown }> {
  const balanceLine = await gateway.getStellarBalanceLine(accountAddress, tokenAddress);
  return { hasTrustline: balanceLine !== undefined && balanceLine !== null, balanceLine: balanceLine ?? null };
}

/** Detects what the recipient needs before receiving `destinationToken`; null when nothing is needed. */
export async function detectDestinationSetup(
  gateway: CoreGateway,
  destinationToken: CoreToken,
  recipientAddress: string,
): Promise<DestinationSetupRequirement | null> {
  if (destinationToken.chainType !== 'SRB' || destinationToken.isNative) {
    return null;
  }

  const base = {
    type: 'stellar_trustline' as const,
    chainSymbol: destinationToken.chainSymbol,
    accountAddress: recipientAddress,
    tokenAddress: destinationToken.tokenAddress,
    checkTool: 'check_stellar_trustline' as const,
    buildTool: 'build_stellar_trustline_transaction' as const,
  };

  try {
    const { hasTrustline } = await checkStellarTrustline(gateway, recipientAddress, destinationToken.tokenAddress);
    return {
      ...base,
      required: !hasTrustline,
      reason: hasTrustline
        ? 'The recipient already has a Stellar trustline for this token.'
        : `The recipient must add a Stellar trustline for ${destinationToken.symbol} before it can receive the transfer.`,
    };
  } catch (error) {
    return {
      ...base,
      required: null,
      reason: `Unable to check the recipient's Stellar trustline (${toUserFacingError(error, { action: 'Check trustline' }).message}). The account may not exist yet; it must exist and trust ${destinationToken.symbol} to receive the transfer.`,
    };
  }
}
