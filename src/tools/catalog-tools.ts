import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import {
  type ChainCatalog,
  resolveChainFromCatalog,
  resolveTokenForChain,
  summarizeSupportedChains,
  summarizeSupportedTokens,
  type ResolvedTokenSelection,
} from '../chain-catalog.js';
import { detectMessengers } from '../messengers.js';
import {
  optionalChainSchema,
  optionalText,
  optionalTextSchema,
  requireText,
  requiredChainSchema,
  requiredTextSchema,
  runTool,
  summarizeToken,
  type ToolContext,
} from './shared.js';

export type RouteSelectionInput = {
  sourceChain?: string | null;
  destinationChain?: string | null;
  sourceTokenSymbol?: string | null;
  sourceTokenAddress?: string | null;
  destinationTokenSymbol?: string | null;
  destinationTokenAddress?: string | null;
};

export const routeSelectionSchema = {
  sourceChain: requiredChainSchema(),
  destinationChain: requiredChainSchema(),
  sourceTokenSymbol: requiredTextSchema('Source token symbol (e.g. USDC, USDT, ETH).'),
  sourceTokenAddress: optionalTextSchema('Optional exact source token address. Use when the source chain has several tokens with the same symbol.'),
  destinationTokenSymbol: optionalTextSchema('Optional destination token symbol. Defaults to the source symbol. Intent messengers can deliver a different token (e.g. USDC to USDT).'),
  destinationTokenAddress: optionalTextSchema('Optional exact destination token address. Use when the destination chain has several tokens with the same symbol.'),
};

export function resolveRouteSelection(
  catalog: ChainCatalog,
  input: RouteSelectionInput,
): { source: ResolvedTokenSelection; destination: ResolvedTokenSelection } {
  const sourceTokenSymbol = requireText(input.sourceTokenSymbol, 'sourceTokenSymbol');
  const source = resolveTokenForChain(
    catalog,
    optionalText(input.sourceChain),
    optionalText(input.sourceTokenAddress),
    sourceTokenSymbol,
    { chain: 'sourceChain', tokenAddress: 'sourceTokenAddress', tokenSymbol: 'sourceTokenSymbol' },
  );
  const destination = resolveTokenForChain(
    catalog,
    optionalText(input.destinationChain),
    optionalText(input.destinationTokenAddress),
    optionalText(input.destinationTokenSymbol) ?? sourceTokenSymbol,
    { chain: 'destinationChain', tokenAddress: 'destinationTokenAddress', tokenSymbol: 'destinationTokenSymbol' },
  );

  return { source, destination };
}

export function registerCatalogTools(server: McpServer, context: ToolContext): void {
  server.registerTool(
    'list_supported_chains',
    {
      title: 'List Supported Chains',
      description:
        'List the chains and chain aliases supported by Allbridge Core. Use this first when the user has not chosen the chains yet.',
      inputSchema: {},
    },
    async () => runTool('List supported chains', async () => {
      const catalog = await context.loadCatalog();

      return {
        chains: summarizeSupportedChains(catalog),
        nextAction: 'Use one of the returned chainSymbol values or aliases in plan_bridge_transfer and find_bridge_routes.',
      };
    }),
  );

  server.registerTool(
    'list_supported_tokens',
    {
      title: 'List Supported Tokens',
      description:
        'List the tokens supported on a chain (stablecoins and native currencies). Omit chain to list every chain.',
      inputSchema: {
        chain: optionalChainSchema(),
      },
    },
    async (parsed) => runTool('List supported tokens', async () => {
      const catalog = await context.loadCatalog();
      const chainInput = optionalText(parsed.chain);

      if (!chainInput) {
        return {
          chains: catalog.chains.map((chain) => ({
            chainSymbol: chain.chainSymbol,
            chainName: chain.chainName,
            chainType: chain.chainType,
            tokens: summarizeSupportedTokens(chain.tokens),
          })),
        };
      }

      const chain = resolveChainFromCatalog(catalog, chainInput, 'chain');
      return {
        chain: {
          chainSymbol: chain.chainSymbol,
          chainName: chain.chainName,
          chainType: chain.chainType,
          aliases: chain.aliases,
        },
        tokens: summarizeSupportedTokens(chain.tokens),
      };
    }),
  );

  server.registerTool(
    'find_bridge_routes',
    {
      title: 'Find Bridge Routes',
      description:
        'List the messengers that can carry a token pair between two chains, without quoting. For a normal transfer request prefer plan_bridge_transfer, which also quotes every route.',
      inputSchema: routeSelectionSchema,
    },
    async (parsed) => runTool('Find bridge routes', async () => {
      const catalog = await context.loadCatalog();
      const { source, destination } = resolveRouteSelection(catalog, parsed);
      const availableMessengers = detectMessengers(source.token, destination.token);

      return {
        route: {
          source: summarizeToken(source.token),
          destination: summarizeToken(destination.token),
          symbolPair: `${source.token.symbol} -> ${destination.token.symbol}`,
        },
        availableMessengers,
        nextAction: availableMessengers.length > 0
          ? 'Call plan_bridge_transfer with an amount to compare the routes.'
          : 'No messenger supports this pair. Try another destination token or chain.',
      };
    }),
  );
}
