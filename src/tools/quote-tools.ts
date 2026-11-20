import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { validateSenderBalances } from '../balances.js';
import { type ChainCatalog, resolveTokenByAddressFromCatalog, validateAddressForChainType } from '../chain-catalog.js';
import type { CoreToken } from '../core-gateway.js';
import { detectMessengers } from '../messengers.js';
import { quoteMessenger, quoteRoute, type RouteQuote } from '../quotes.js';
import { UserFacingToolError } from '../tool-errors.js';
import { resolveRouteSelection, routeSelectionSchema } from './catalog-tools.js';
import {
  amountUnitSchema,
  BRIDGE_PORTAL_NAME,
  BRIDGE_PORTAL_URL,
  buildBridgePortalDeepLink,
  buildBridgeSummary,
  feePaymentMethodSchema,
  messengerSchema,
  type NormalizedAmount,
  normalizeAmount,
  optionalText,
  optionalTextSchema,
  requireText,
  requiredTextSchema,
  runTool,
  summarizeToken,
  type ToolContext,
} from './shared.js';

export const tokenPairByAddressSchema = {
  sourceTokenAddress: requiredTextSchema('Source token address. Do not pass null.'),
  sourceChain: optionalTextSchema('Source chain. Required when the address exists on several chains (native EVM currencies).'),
  destinationTokenAddress: requiredTextSchema('Destination token address. Do not pass null.'),
  destinationChain: optionalTextSchema('Destination chain. Required when the address exists on several chains (native EVM currencies).'),
};

export function resolveTokenPairByAddress(
  catalog: ChainCatalog,
  input: { sourceTokenAddress: string; sourceChain?: string | null; destinationTokenAddress: string; destinationChain?: string | null },
): { sourceToken: CoreToken; destinationToken: CoreToken } {
  return {
    sourceToken: resolveTokenByAddressFromCatalog(
      catalog,
      requireText(input.sourceTokenAddress, 'sourceTokenAddress'),
      'sourceTokenAddress',
      optionalText(input.sourceChain),
      'sourceChain',
    ),
    destinationToken: resolveTokenByAddressFromCatalog(
      catalog,
      requireText(input.destinationTokenAddress, 'destinationTokenAddress'),
      'destinationTokenAddress',
      optionalText(input.destinationChain),
      'destinationChain',
    ),
  };
}

function presentRouteQuote(
  sourceToken: CoreToken,
  destinationToken: CoreToken,
  amount: NormalizedAmount,
  quote: RouteQuote,
) {
  const availableMessengers = detectMessengers(sourceToken, destinationToken);
  const recommendedOption = quote.options[0] ?? null;

  return {
    summary: buildBridgeSummary({ sourceToken, destinationToken, amount }),
    route: {
      source: summarizeToken(sourceToken),
      destination: summarizeToken(destinationToken),
    },
    amount,
    availableMessengers,
    recommendedOption,
    options: quote.options,
    unavailableOptions: quote.unavailable,
    bridgePortalName: BRIDGE_PORTAL_NAME,
    bridgePortalUrl: BRIDGE_PORTAL_URL,
    bridgePortalDeepLink: recommendedOption
      ? buildBridgePortalDeepLink({ sourceToken, destinationToken, amount, messenger: recommendedOption.messenger })
      : null,
    nextAction: recommendedOption
      ? 'Options are sorted by the amount received. Ask for the sender and recipient addresses, confirm the messenger and fee payment method with the user, run check_sender_balances, then create_bridge_execution_job.'
      : availableMessengers.length === 0
        ? 'No messenger supports this pair. Try another destination token or chain.'
        : 'No messenger can quote this amount right now (see unavailableOptions for limits).',
  };
}

export function registerQuoteTools(server: McpServer, context: ToolContext): void {
  server.registerTool(
    'plan_bridge_transfer',
    {
      title: 'Plan Bridge Transfer',
      description:
        'Primary planning tool. Resolves the tokens by chain and symbol and quotes every available messenger for the amount, sorted by the amount received. Bridge messengers (CCTP_V2, OFT, X_RESERVE) list the gas fee for each fee payment method; intent messengers (NEAR_INTENTS, LIFI_INTENTS) are market-priced, can deliver a different token or native currency, and include every fee in the quote. Use token addresses when a chain has several tokens with the same symbol.',
      inputSchema: {
        ...routeSelectionSchema,
        amount: requiredTextSchema('Amount to send. Do not pass null.'),
        amountUnit: amountUnitSchema,
      },
    },
    async (parsed) => runTool('Plan bridge transfer', async () => {
      const catalog = await context.loadCatalog();
      const { source, destination } = resolveRouteSelection(catalog, parsed);
      const amount = normalizeAmount(requireText(parsed.amount, 'amount'), parsed.amountUnit, source.token);
      const quote = await quoteRoute(context.gateway, source.token, destination.token, amount);

      return presentRouteQuote(source.token, destination.token, amount, quote);
    }),
  );

  server.registerTool(
    'quote_bridge_transfer',
    {
      title: 'Quote Bridge Transfer',
      description:
        'Quote every available messenger for a transfer between two known token addresses. Same output as plan_bridge_transfer.',
      inputSchema: {
        ...tokenPairByAddressSchema,
        amount: requiredTextSchema('Amount to send. Do not pass null.'),
        amountUnit: amountUnitSchema,
      },
    },
    async (parsed) => runTool('Quote bridge transfer', async () => {
      const catalog = await context.loadCatalog();
      const { sourceToken, destinationToken } = resolveTokenPairByAddress(catalog, parsed);
      const amount = normalizeAmount(requireText(parsed.amount, 'amount'), parsed.amountUnit, sourceToken);
      const quote = await quoteRoute(context.gateway, sourceToken, destinationToken, amount);

      return presentRouteQuote(sourceToken, destinationToken, amount, quote);
    }),
  );

  server.registerTool(
    'check_sender_balances',
    {
      title: 'Check Sender Balances',
      description:
        'Check that the sender holds the amount and the gas fee for the chosen messenger and fee payment method on the source chain. Advisory: create_bridge_execution_job runs the same check and still builds the job.',
      inputSchema: {
        ...tokenPairByAddressSchema,
        senderAddress: requiredTextSchema('Sender address on the source chain. Do not pass null.'),
        amount: requiredTextSchema('Amount to send. Do not pass null.'),
        amountUnit: amountUnitSchema,
        messenger: messengerSchema,
        feePaymentMethod: feePaymentMethodSchema,
      },
    },
    async (parsed) => runTool('Check sender balances', async () => {
      const catalog = await context.loadCatalog();
      const { sourceToken, destinationToken } = resolveTokenPairByAddress(catalog, parsed);
      const senderAddress = requireText(parsed.senderAddress, 'senderAddress');
      validateAddressForChainType(senderAddress, sourceToken.chainType, 'senderAddress');
      const amount = normalizeAmount(requireText(parsed.amount, 'amount'), parsed.amountUnit, sourceToken);

      if (!detectMessengers(sourceToken, destinationToken).includes(parsed.messenger)) {
        throw new UserFacingToolError('unsupported_route', `${parsed.messenger} does not support this route.`, {
          messenger: parsed.messenger,
          availableMessengers: detectMessengers(sourceToken, destinationToken),
        });
      }

      const quote = await quoteMessenger(context.gateway, sourceToken, destinationToken, amount, parsed.messenger);
      return validateSenderBalances({
        gateway: context.gateway,
        sourceToken,
        destinationToken,
        senderAddress,
        amount,
        quote,
        feePaymentMethod: parsed.feePaymentMethod ?? 'WITH_NATIVE_CURRENCY',
      });
    }),
  );
}
