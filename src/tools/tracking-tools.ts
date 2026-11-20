import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import axios from 'axios';
import { z } from 'zod';

import { resolveChainFromCatalog, type ChainCatalog } from '../chain-catalog.js';
import {
  AllbridgeExplorerApiError,
  type AllbridgeExplorerApiClient,
  type ExplorerSearchResult,
  type ExplorerTransferSummary,
  type ExplorerTransfersListParams,
  normalizeExplorerSearchResults,
  normalizeExplorerTransfer,
  normalizeExplorerTransfers,
} from '../explorer-api-client.js';
import { UserFacingToolError } from '../tool-errors.js';
import {
  buildHistoryUrl,
  optionalText,
  optionalTextSchema,
  requireText,
  requiredChainSchema,
  requiredTextSchema,
  runTool,
  type ToolContext,
} from './shared.js';

function normalizeExplorerStatus(status: unknown): string | undefined {
  if (typeof status !== 'string') {
    return undefined;
  }

  const trimmed = status.trim();
  if (!trimmed) {
    return undefined;
  }

  const normalized = trimmed.toLowerCase();
  if (normalized === 'complete') {
    return 'Complete';
  }

  if (normalized === 'pending') {
    return 'Pending';
  }

  throw new UserFacingToolError('validation_error', "Parameter 'status' must be 'Complete' or 'Pending'.", {
    status,
  });
}

function optionalTextValue(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function hasDirectTransferFilters(params: Record<string, unknown>): boolean {
  return [
    params.account,
    params.chain,
    params.from,
    params.to,
    params.minFromAmount,
    params.maxFromAmount,
    params.status,
  ].some((value) => value !== undefined && value !== null && value !== '');
}

function buildExplorerTransferListParams(
  params: {
    account?: unknown;
    chain?: unknown;
    from?: unknown;
    to?: unknown;
    minFromAmount?: unknown;
    maxFromAmount?: unknown;
    status?: unknown;
    page?: unknown;
    limit?: unknown;
  },
  catalog?: ChainCatalog,
): ExplorerTransfersListParams {
  const chain = optionalTextValue(params.chain);
  const from = optionalTextValue(params.from);
  const to = optionalTextValue(params.to);

  if (chain && (from || to)) {
    throw new UserFacingToolError('validation_error', "Parameter 'chain' cannot be combined with 'from' or 'to'.", {
      chain: params.chain ?? null,
      from: params.from ?? null,
      to: params.to ?? null,
    });
  }

  if ((chain || from || to) && !catalog) {
    throw new UserFacingToolError('validation_error', 'Chain filters require the token catalog to be loaded first.', {
      chain: params.chain ?? null,
      from: params.from ?? null,
      to: params.to ?? null,
    });
  }

  if (params.page !== undefined && params.page !== null && typeof params.page !== 'number') {
    throw new UserFacingToolError('validation_error', "Parameter 'page' must be a number.", {
      page: params.page,
    });
  }

  const resolvedChain = chain ? resolveChainFromCatalog(catalog!, chain, 'chain').chainSymbol : undefined;
  const resolvedFrom = from ? resolveChainFromCatalog(catalog!, from, 'from').chainSymbol : undefined;
  const resolvedTo = to ? resolveChainFromCatalog(catalog!, to, 'to').chainSymbol : undefined;
  const minFromAmount = typeof params.minFromAmount === 'number' ? params.minFromAmount : undefined;
  const maxFromAmount = typeof params.maxFromAmount === 'number' ? params.maxFromAmount : undefined;
  const status = normalizeExplorerStatus(params.status);
  const page = typeof params.page === 'number' ? params.page : 1;
  const limit = typeof params.limit === 'number' ? params.limit : undefined;
  const account = optionalTextValue(params.account);

  return {
    account,
    chain: resolvedChain,
    from: resolvedFrom,
    to: resolvedTo,
    minFromAmount,
    maxFromAmount,
    status,
    page,
    limit,
  };
}

function transferKey(transfer: ExplorerTransferSummary): string | null {
  return transfer.transferId
    ?? transfer.sourceTxId
    ?? transfer.messagingTxId
    ?? transfer.receiveTxId
    ?? null;
}

function dedupeTransfers(transfers: ExplorerTransferSummary[]): ExplorerTransferSummary[] {
  const seen = new Set<string>();
  const result: ExplorerTransferSummary[] = [];

  for (const transfer of transfers) {
    const key = transferKey(transfer);
    if (!key || seen.has(key)) {
      continue;
    }

    seen.add(key);
    result.push(transfer);
  }

  return result;
}

function uniqueNonEmpty(values: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const value of values) {
    const trimmed = typeof value === 'string' ? value.trim() : '';
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }

    seen.add(trimmed);
    result.push(trimmed);
  }

  return result;
}

async function resolveExplorerSearchTransfers(
  explorerClient: AllbridgeExplorerApiClient,
  baseURL: string,
  query: string,
  page: number,
  limit: number,
): Promise<{
  searchMatches: ExplorerSearchResult[];
  resolvedTransfers: ExplorerTransferSummary[];
  resolvedBy: Array<'address' | 'transfer'>;
}> {
  const searchMatches = normalizeExplorerSearchResults(await explorerClient.search(query));
  const resolvedBy = new Set<'address' | 'transfer'>();
  const resolvedTransfers: ExplorerTransferSummary[] = [];

  const lookupTasks = searchMatches.map(async (match) => {
    if (match.itemType === 'Address' && match.value) {
      resolvedBy.add('address');
      const response = await explorerClient.listTransfers({
        account: match.value,
        page,
        limit,
      });
      return normalizeExplorerTransfers(response, baseURL, query);
    }

    if (match.itemType === 'Transfer' && match.value) {
      resolvedBy.add('transfer');
      const response = await explorerClient.getTransfer(match.value);
      return [normalizeExplorerTransfer(response, baseURL, match.value, query)];
    }

    return [];
  });

  for (const batch of await Promise.all(lookupTasks)) {
    resolvedTransfers.push(...batch);
  }

  return {
    searchMatches,
    resolvedTransfers: dedupeTransfers(resolvedTransfers).slice(0, limit),
    resolvedBy: [...resolvedBy],
  };
}

function summarizeTransferStatus(status: Record<string, unknown>) {
  const refunded = status.refunded === true;
  const received = Boolean(status.receive);

  return {
    state: refunded ? 'refunded' : received ? 'completed' : 'pending',
    txId: status.txId ?? null,
    sourceChainSymbol: status.sourceChainSymbol ?? null,
    destinationChainSymbol: status.destinationChainSymbol ?? null,
    senderAddress: status.senderAddress ?? null,
    recipientAddress: status.recipientAddress ?? null,
    sendAmount: status.sendAmount ?? null,
    sendAmountFormatted: status.sendAmountFormatted ?? null,
    signaturesCount: status.signaturesCount ?? null,
    signaturesNeeded: status.signaturesNeeded ?? null,
    refunded,
    refundTxId: status.refundTxId ?? null,
    refundedAmount: status.refundedAmount ?? null,
    refundedAmountFormatted: status.refundedAmountFormatted ?? null,
    responseTime: status.responseTime ?? null,
    historyUrl: buildHistoryUrl(
      typeof status.sourceChainSymbol === 'string' ? status.sourceChainSymbol : null,
      typeof status.txId === 'string' ? status.txId : null,
    ),
    send: status.send ?? null,
    receive: status.receive ?? null,
  };
}

export function registerTrackingTools(server: McpServer, context: ToolContext): void {
  server.registerTool(
    'get_transfer_status',
    {
      title: 'Get Transfer Status',
      description:
        'Fetch the status of a transfer from its source chain and source transaction hash (the hash of the bridge step). Returns state pending, completed or refunded; intent transfers that could not be filled are refunded to the sender. The Core API needs a short while to index a new transaction: retry on not found.',
      inputSchema: {
        sourceChain: requiredChainSchema(),
        txId: requiredTextSchema('Source chain transaction hash. Do not pass null.'),
      },
    },
    async (parsed) => runTool('Get transfer status', async () => {
      const catalog = await context.loadCatalog();
      const chain = resolveChainFromCatalog(catalog, optionalText(parsed.sourceChain), 'sourceChain');
      const txId = requireText(parsed.txId, 'txId');
      try {
        const status = await context.gateway.getTransferStatus(chain.chainSymbol, txId);
        return summarizeTransferStatus(status as unknown as Record<string, unknown>);
      } catch (error) {
        if (axios.isAxiosError(error) && error.response?.status === 404) {
          return {
            state: 'not_found',
            txId,
            sourceChainSymbol: chain.chainSymbol,
            historyUrl: buildHistoryUrl(chain.chainSymbol, txId),
            nextAction: 'The Core API has not indexed this transaction yet. Check that the hash is the bridge step transaction on the source chain and retry in 30-60 seconds.',
          };
        }
        throw error;
      }
    }),
  );

  server.registerTool(
    'search_allbridge_transfers',
    {
      title: 'Search Allbridge Transfers',
      description:
        'Search or list Allbridge transfers in the public explorer. Use query to resolve typed hits (Address or Transfer), or use list filters such as account, chain, from, to, status, minFromAmount, and maxFromAmount. Omit everything to list recent transfers.',
      inputSchema: {
        query: optionalTextSchema('Optional search query. Omit to list recent transfers.'),
        account: optionalTextSchema('Optional account address to list transfers for.'),
        chain: optionalTextSchema('Optional chain filter. Can be combined with account, status, or amount filters.'),
        from: optionalTextSchema('Optional source chain filter. Cannot be combined with chain.'),
        to: optionalTextSchema('Optional destination chain filter. Cannot be combined with chain.'),
        minFromAmount: z.number().min(0).optional().describe('Optional minimum source amount filter.'),
        maxFromAmount: z.number().positive().optional().describe('Optional maximum source amount filter.'),
        status: optionalTextSchema('Optional transfer status filter. Use Complete or Pending.'),
        page: z.number().int().positive().default(1).describe('Page number for list mode.'),
        limit: z.number().int().positive().max(20).default(10).describe('Maximum number of transfers to return.'),
      },
    },
    async (parsed) => {
      return runTool('Search Allbridge transfers', async () => {
        try {
          const query = optionalText(parsed.query);
          const directFiltersExist = hasDirectTransferFilters(parsed);
          if (query && directFiltersExist) {
            throw new UserFacingToolError('validation_error', 'Query search cannot be combined with direct transfer filters.', {
              query,
              account: parsed.account ?? null,
              chain: parsed.chain ?? null,
              from: parsed.from ?? null,
              to: parsed.to ?? null,
              minFromAmount: parsed.minFromAmount ?? null,
              maxFromAmount: parsed.maxFromAmount ?? null,
              status: parsed.status ?? null,
            });
          }

          if (!query) {
            const chain = optionalText(parsed.chain);
            const from = optionalText(parsed.from);
            const to = optionalText(parsed.to);

            if (chain && (from || to)) {
              throw new UserFacingToolError('validation_error', "Parameter 'chain' cannot be combined with 'from' or 'to'.", {
                chain: parsed.chain ?? null,
                from: parsed.from ?? null,
                to: parsed.to ?? null,
              });
            }
          }

          if (!query) {
            const needsCatalog = Boolean(optionalText(parsed.chain) || optionalText(parsed.from) || optionalText(parsed.to));
            const catalog = needsCatalog ? await context.loadCatalog() : undefined;
            const listParams = buildExplorerTransferListParams(parsed, catalog);
            const response = await context.explorer.listTransfers({
              account: listParams.account,
              chain: listParams.chain,
              from: listParams.from,
              to: listParams.to,
              minFromAmount: listParams.minFromAmount,
              maxFromAmount: listParams.maxFromAmount,
              status: listParams.status,
              page: listParams.page ?? 1,
              limit: parsed.limit,
            });
            const transfers = normalizeExplorerTransfers(response, context.explorerBaseUrl).slice(0, parsed.limit);

            return {
              mode: 'recent',
              query: null,
              appliedFilters: directFiltersExist ? listParams : null,
              searchMatchCount: 0,
              searchMatches: [],
              resolvedBy: [],
              resultCount: transfers.length,
              results: transfers,
              nextAction: transfers.length > 0
                ? 'Use get_allbridge_transfer with a transferId to open a single transfer.'
                : 'Provide a query to narrow the explorer results by sender, recipient, transaction hash, or transfer ID.',
            };
          }

          const { searchMatches, resolvedTransfers, resolvedBy } = await resolveExplorerSearchTransfers(
            context.explorer,
            context.explorerBaseUrl,
            query,
            typeof parsed.page === 'number' ? parsed.page : 1,
            parsed.limit,
          );

          return {
            mode: 'search',
            query,
            appliedFilters: null,
            searchMatchCount: searchMatches.length,
            searchMatches,
            resolvedBy,
            resultCount: resolvedTransfers.length,
            results: resolvedTransfers,
            nextAction: resolvedTransfers.length > 0
              ? (() => {
                  const sourceChains = uniqueNonEmpty(resolvedTransfers.map((transfer) => transfer.sourceChainSymbol));
                  if (sourceChains.length > 1) {
                    return 'Use get_allbridge_transfer with a transferId to open one transfer, or rerun search_allbridge_transfers with a chain filter or from/to direction filters if you want to narrow the history to one network.';
                  }

                  return 'Use get_allbridge_transfer with a transferId to open one transfer, or follow the historyUrl for progress tracking.';
                })()
              : searchMatches.length > 0
                ? 'The query matched explorer entities, but no transfer records were returned. Try a sender address, recipient address, source transaction hash, messaging transaction hash, receive transaction hash, or transfer ID.'
                : 'Try a sender address, recipient address, source transaction hash, messaging transaction hash, receive transaction hash, or transfer ID.',
          };
        } catch (error) {
          if (error instanceof AllbridgeExplorerApiError) {
            throw new UserFacingToolError('validation_error', 'Unable to query the Allbridge explorer.', {
              query: parsed.query ?? null,
              limit: parsed.limit,
              reason: error.message,
              status: error.status ?? null,
              details: error.details ?? null,
            });
          }

          throw error;
        }
      });
    },
  );

  server.registerTool(
    'get_allbridge_transfer',
    {
      title: 'Get Allbridge Transfer',
      description:
        'Open a single transfer record from the public explorer by transfer ID.',
      inputSchema: {
        transferId: requiredTextSchema('Transfer ID to open. Do not pass null.'),
      },
    },
    async (parsed) => {
      return runTool('Open Allbridge transfer', async () => {
        try {
          const transferId = requireText(parsed.transferId, 'transferId');
          const response = await context.explorer.getTransfer(transferId);
          const transfer = normalizeExplorerTransfer(response, context.explorerBaseUrl, transferId);

          return {
            transfer,
            nextAction: 'Use the returned transferId, transaction hashes, and addresses to orient the bridge lifecycle or continue investigation.',
          };
        } catch (error) {
          if (error instanceof AllbridgeExplorerApiError) {
            throw new UserFacingToolError('validation_error', 'Unable to open the requested Allbridge transfer.', {
              transferId: parsed.transferId ?? null,
              reason: error.message,
              status: error.status ?? null,
              details: error.details ?? null,
            });
          }

          if (error instanceof Error) {
            throw new UserFacingToolError('validation_error', 'Unable to parse the requested Allbridge transfer.', {
              transferId: parsed.transferId ?? null,
              reason: error.message,
            });
          }

          throw error;
        }
      });
    },
  );

}
