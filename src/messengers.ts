import { isLifiIntentsRouteSupported, Messenger } from '@allbridge/bridge-core-sdk';

import type { CoreToken } from './core-gateway.js';

export const BRIDGE_MESSENGERS = ['CCTP_V2', 'OFT', 'X_RESERVE'] as const;
export const INTENT_MESSENGERS = ['NEAR_INTENTS', 'LIFI_INTENTS'] as const;

/** Messengers this server routes through, by their MCP-facing names. */
export const MESSENGERS = [...BRIDGE_MESSENGERS, ...INTENT_MESSENGERS] as const;

export type BridgeMessengerName = (typeof BRIDGE_MESSENGERS)[number];
export type IntentMessengerName = (typeof INTENT_MESSENGERS)[number];
export type MessengerName = (typeof MESSENGERS)[number];

const SDK_MESSENGERS: Record<MessengerName, Messenger> = {
  CCTP_V2: Messenger.CCTP_V2,
  OFT: Messenger.OFT,
  X_RESERVE: Messenger.X_RESERVE,
  NEAR_INTENTS: Messenger.NEAR_INTENTS,
  LIFI_INTENTS: Messenger.LIFI_INTENTS,
};

export function toSdkMessenger(messenger: MessengerName): Messenger {
  return SDK_MESSENGERS[messenger];
}

export function isIntentMessenger(messenger: MessengerName): messenger is IntentMessengerName {
  return (INTENT_MESSENGERS as readonly string[]).includes(messenger);
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

  // NEAR Intents cannot be sent from Stacks.
  if (sourceToken.nearIntents && destinationToken.nearIntents && sourceToken.chainType !== 'STX') {
    messengers.push('NEAR_INTENTS');
  }

  if (isLifiIntentsRouteSupported(sourceToken, destinationToken)) {
    messengers.push('LIFI_INTENTS');
  }

  return messengers;
}
