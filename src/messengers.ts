import { Messenger } from '@allbridge/bridge-core-sdk';

import type { CoreToken } from './core-gateway.js';

/** Messengers this server routes through, by their MCP-facing names. */
export const MESSENGERS = ['CCTP_V2', 'OFT', 'X_RESERVE'] as const;

export type MessengerName = (typeof MESSENGERS)[number];

const SDK_MESSENGERS: Record<MessengerName, Messenger> = {
  CCTP_V2: Messenger.CCTP_V2,
  OFT: Messenger.OFT,
  X_RESERVE: Messenger.X_RESERVE,
};

export function toSdkMessenger(messenger: MessengerName): Messenger {
  return SDK_MESSENGERS[messenger];
}

/**
 * Messengers that can carry a transfer from `sourceToken` to `destinationToken`,
 * following the route rules of the Allbridge Core SDK.
 */
export function detectMessengers(sourceToken: CoreToken, destinationToken: CoreToken): MessengerName[] {
  if (sourceToken.chainSymbol === destinationToken.chainSymbol) {
    return [];
  }

  const messengers: MessengerName[] = [];

  if (sourceToken.cctpV2Address && destinationToken.cctpV2Address) {
    messengers.push('CCTP_V2');
  }

  if (
    sourceToken.oftId
    && sourceToken.oftId === destinationToken.oftId
    && sourceToken.oftBridgeAddress
    && destinationToken.oftBridgeAddress
  ) {
    messengers.push('OFT');
  }

  if (sourceToken.xReserve && destinationToken.xReserve) {
    messengers.push('X_RESERVE');
  }

  return messengers;
}
