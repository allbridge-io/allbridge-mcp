import type { CoreGateway, CoreToken } from './core-gateway.js';
import type { MessengerName } from './messengers.js';
import { toUserFacingError } from './sdk-errors.js';

/**
 * Something the recipient must have in place on the destination chain before the transfer can be
 * delivered. `buildTool` is set when this server can build the missing transaction for the recipient;
 * `required` is null when the check itself failed.
 */
export type DestinationSetupRequirement = {
  required: boolean | null;
  type: 'stellar_trustline' | 'solana_token_account';
  chainSymbol: string;
  accountAddress: string;
  tokenAddress: string;
  checkTool: 'check_stellar_trustline' | null;
  buildTool: 'build_stellar_trustline_transaction' | null;
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

function checkFailed(error: unknown): string {
  return toUserFacingError(error, { action: 'Check recipient' }).message;
}

async function stellarTrustline(
  gateway: CoreGateway,
  destinationToken: CoreToken,
  recipientAddress: string,
): Promise<DestinationSetupRequirement> {
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
      reason: `Unable to check the recipient's Stellar trustline (${checkFailed(error)}). The account must exist and trust ${destinationToken.symbol} to receive the transfer.`,
    };
  }
}

/** LI.FI Intents solvers pay the recipient's associated token account on Solana but do not create it. */
async function solanaTokenAccount(
  gateway: CoreGateway,
  destinationToken: CoreToken,
  recipientAddress: string,
): Promise<DestinationSetupRequirement> {
  const base = {
    type: 'solana_token_account' as const,
    chainSymbol: destinationToken.chainSymbol,
    accountAddress: recipientAddress,
    tokenAddress: destinationToken.tokenAddress,
    checkTool: null,
    buildTool: null,
  };

  try {
    const hasAccount = await gateway.hasSolanaTokenAccount(recipientAddress, destinationToken);
    return {
      ...base,
      required: !hasAccount,
      reason: hasAccount
        ? `The recipient has a ${destinationToken.symbol} token account on Solana.`
        : `The recipient has no ${destinationToken.symbol} token account on Solana. A LI.FI Intents order to it is not filled and is refunded: the recipient must create the account first (any wallet does it on the first receipt), or choose another messenger.`,
    };
  } catch (error) {
    return {
      ...base,
      required: null,
      reason: `Unable to check the recipient's ${destinationToken.symbol} token account on Solana (${checkFailed(error)}). Without it a LI.FI Intents order is refunded.`,
    };
  }
}

/** Detects what the recipient needs before receiving `destinationToken`; null when nothing is needed. */
export async function detectDestinationSetup(
  gateway: CoreGateway,
  destinationToken: CoreToken,
  recipientAddress: string,
  messenger: MessengerName,
): Promise<DestinationSetupRequirement | null> {
  if (destinationToken.isNative) {
    return null;
  }

  if (destinationToken.chainType === 'SRB') {
    return stellarTrustline(gateway, destinationToken, recipientAddress);
  }

  if (destinationToken.chainType === 'SOLANA' && messenger === 'LIFI_INTENTS') {
    return solanaTokenAccount(gateway, destinationToken, recipientAddress);
  }

  return null;
}
