import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { COMMON_CHAIN_ALIASES } from './chain-catalog.js';
import { coreToNextChainSymbol } from './constants.js';
import {
  NextApiError,
  type NextApiClient,
  type NextCreateTxRequest,
  type NextRouteResponse,
  type NextToken,
} from './next-api-client.js';
import { createToolErrorResult, UserFacingToolError } from './tool-errors.js';
import { baseUnitsToDecimal, decimalToBaseUnits, formatJson } from './utils.js';

type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent: Record<string, unknown>;
  isError?: boolean;
};

function textResult(structuredContent: Record<string, unknown>): ToolResult {
  return {
    content: [{ type: 'text' as const, text: formatJson(structuredContent) }],
    structuredContent,
  };
}

async function runTool(operation: () => Promise<Record<string, unknown>>): Promise<ToolResult> {
  try {
    return textResult(await operation());
  } catch (error) {
    if (error instanceof UserFacingToolError) {
      return createToolErrorResult(error);
    }
    if (error instanceof NextApiError) {
      return createToolErrorResult(
        new UserFacingToolError('validation_error', error.message, {
          status: error.status ?? null,
          details: error.details ?? null,
        }),
      );
    }
    throw error;
  }
}

const baseUnitsSchema = z
  .string()
  .trim()
  .regex(/^\d+$/, 'amount must be a non-negative integer string in base units');

const relayerFeeSchema = z.object({
  tokenId: z.string().trim().min(1),
  amount: baseUnitsSchema,
  approvalSpender: z.string().trim().min(1).optional(),
});

// EVM addresses are 0x-prefixed hex; Solana/Tron/Stacks/Stellar are Base58/Base32 (case-sensitive).
// Compare hex addresses case-insensitively, everything else exactly.
function addressMatches(catalogAddress: string, userAddress: string): boolean {
  const isHex = userAddress.startsWith('0x') || userAddress.startsWith('0X');
  return isHex
    ? catalogAddress.toLowerCase() === userAddress.toLowerCase()
    : catalogAddress === userAddress;
}

/**
 * Resolve a user-supplied chain string ("Ethereum", "ETH", "ARBITRUM", …) to the
 * canonical NEXT chain symbol. Reuses Core's alias table so callers can pass the
 * same chain string to both Core and NEXT branches of plan_bridge_transfer.
 */
function resolveNextChainSymbol(input: string): string {
  const normalized = input.trim().toUpperCase().replace(/[^A-Z0-9]+/g, '');
  const coreCanonical = COMMON_CHAIN_ALIASES[normalized] ?? input;
  return coreToNextChainSymbol(coreCanonical);
}

function findNextToken(
  tokens: NextToken[],
  coreChainSymbol: string,
  tokenSymbol: string,
  tokenAddress: string | undefined,
): NextToken | undefined {
  const nextChain = resolveNextChainSymbol(coreChainSymbol).toLowerCase();
  const symbol = tokenSymbol.toLowerCase();

  const onChain = tokens.filter((t) => t.chain.toLowerCase() === nextChain);
  if (tokenAddress) {
    return onChain.find((t) => addressMatches(t.address, tokenAddress));
  }
  return onChain.find((t) => t.symbol.toLowerCase() === symbol);
}

export interface PlanNextTransferParams {
  sourceChain: string;
  destinationChain: string;
  sourceTokenSymbol: string;
  destinationTokenSymbol?: string;
  sourceTokenAddress?: string;
  destinationTokenAddress?: string;
  amount: string;
  amountUnit: 'human' | 'base';
}

export interface PlanNextTransferResult {
  summary: string;
  bridgePortalName: 'Allbridge NEXT';
  bridgePortalUrl: 'https://next.allbridge.io';
  amount: { amountInBaseUnits: string; amountInHumanUnits: string };
  route: {
    source: NextToken;
    destination: NextToken;
  };
  options: NextRouteResponse[];
}

/**
 * Resolve Core-style chain+symbol inputs against NEXT /tokens, then call /quote.
 * Used by plan_bridge_transfer when protocol is 'next' or 'auto'.
 */
export async function planNextTransfer(
  client: NextApiClient,
  params: PlanNextTransferParams,
): Promise<PlanNextTransferResult> {
  const tokens = await client.getTokens();
  const sourceToken = findNextToken(
    tokens,
    params.sourceChain,
    params.sourceTokenSymbol,
    params.sourceTokenAddress,
  );
  if (!sourceToken) {
    throw new UserFacingToolError(
      'unsupported_token',
      'Source token is not supported by Allbridge NEXT.',
      {
        sourceChain: params.sourceChain,
        sourceTokenSymbol: params.sourceTokenSymbol,
        sourceTokenAddress: params.sourceTokenAddress ?? null,
      },
    );
  }

  const destinationSymbol = params.destinationTokenSymbol ?? params.sourceTokenSymbol;
  const destinationToken = findNextToken(
    tokens,
    params.destinationChain,
    destinationSymbol,
    params.destinationTokenAddress,
  );
  if (!destinationToken) {
    throw new UserFacingToolError(
      'unsupported_token',
      'Destination token is not supported by Allbridge NEXT.',
      {
        destinationChain: params.destinationChain,
        destinationTokenSymbol: destinationSymbol,
        destinationTokenAddress: params.destinationTokenAddress ?? null,
      },
    );
  }

  let amountInBaseUnits: string;
  let amountInHumanUnits: string;
  try {
    if (params.amountUnit === 'base') {
      amountInBaseUnits = params.amount;
      amountInHumanUnits = baseUnitsToDecimal(params.amount, sourceToken.decimals);
    } else {
      amountInBaseUnits = decimalToBaseUnits(params.amount, sourceToken.decimals);
      amountInHumanUnits = params.amount;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid amount.';
    throw new UserFacingToolError('invalid_amount', message, {
      amount: params.amount,
      amountUnit: params.amountUnit,
      symbol: sourceToken.symbol,
      tokenAddress: sourceToken.address,
      decimals: sourceToken.decimals,
    });
  }

  const options = await client.postQuote({
    amount: amountInBaseUnits,
    sourceTokenId: sourceToken.tokenId,
    destinationTokenId: destinationToken.tokenId,
  });

  const summary = `Bridge ${amountInHumanUnits} ${sourceToken.symbol} from ${sourceToken.chain} to ${destinationToken.chain} via Allbridge NEXT (${options.length} route${options.length === 1 ? '' : 's'} available).`;

  return {
    summary,
    bridgePortalName: 'Allbridge NEXT',
    bridgePortalUrl: 'https://next.allbridge.io',
    amount: { amountInBaseUnits, amountInHumanUnits },
    route: { source: sourceToken, destination: destinationToken },
    options,
  };
}

export function registerNextTools(server: McpServer, client: NextApiClient): void {
  server.registerTool(
    'list_next_chains',
    {
      title: 'List Allbridge NEXT Chains',
      description:
        'List unique chain symbols supported by Allbridge NEXT, derived from the NEXT token catalog.',
      inputSchema: {},
    },
    async () =>
      runTool(async () => {
        const tokens = await client.getTokens();
        const chains = Array.from(new Set(tokens.map((token) => token.chain))).sort();
        return { chains };
      }),
  );

  server.registerTool(
    'list_next_tokens',
    {
      title: 'List Allbridge NEXT Tokens',
      description:
        'List tokens supported by Allbridge NEXT. Pass a chain filter when possible — the unfiltered list can include hundreds of entries.',
      inputSchema: {
        chain: z.string().trim().min(1).optional().describe('Optional chain symbol filter (case-insensitive). Recommended to keep responses small.'),
      },
    },
    async (parsed) =>
      runTool(async () => {
        const tokens = await client.getTokens();
        const chainFilter = parsed.chain?.toLowerCase();
        const filtered = chainFilter
          ? tokens.filter((token) => token.chain.toLowerCase() === chainFilter)
          : tokens;
        return { tokens: filtered };
      }),
  );

  server.registerTool(
    'quote_next_swap',
    {
      title: 'Quote Allbridge NEXT Swap',
      description:
        'Quote a cross-chain swap via Allbridge NEXT. Returns the array of available routes, each with amountOut and relayerFees. Amount must be in source token base units (integer string).',
      inputSchema: {
        sourceTokenId: z.string().trim().min(1).describe('Source token id (NEXT tokenId).'),
        destinationTokenId: z.string().trim().min(1).describe('Destination token id (NEXT tokenId).'),
        amount: baseUnitsSchema.describe('Amount in source token base units (integer string).'),
      },
    },
    async (parsed) =>
      runTool(async () => {
        const routes = await client.postQuote({
          sourceTokenId: parsed.sourceTokenId,
          destinationTokenId: parsed.destinationTokenId,
          amount: parsed.amount,
        });
        return { routes };
      }),
  );

  server.registerTool(
    'build_next_transaction',
    {
      title: 'Build Allbridge NEXT Transaction',
      description:
        'Build a NEXT swap transaction for a chosen route. Pass the full route returned by quote_next_swap (including amountOut), plus sourceAddress, destinationAddress, and the chosen relayerFee. For near-intents messenger, relayerFee is optional; refundTo defaults to sourceAddress when not supplied.',
      inputSchema: {
        sourceTokenId: z.string().trim().min(1),
        destinationTokenId: z.string().trim().min(1),
        sourceSwap: z.string().trim().min(1).optional(),
        sourceIntermediaryTokenId: z.string().trim().min(1).optional(),
        destinationIntermediaryTokenId: z.string().trim().min(1).optional(),
        destinationSwap: z.string().trim().min(1).optional(),
        estimatedTime: z.number().int().nonnegative().optional(),
        messenger: z.string().trim().min(1),
        amount: baseUnitsSchema.describe('Amount in source token base units (integer string).'),
        amountOut: baseUnitsSchema.describe('Quoted output amount echoed back from quote_next_swap (integer string in destination token base units).'),
        sourceAddress: z.string().trim().min(1),
        destinationAddress: z.string().trim().min(1),
        relayerFee: relayerFeeSchema.optional(),
        refundTo: z.string().trim().min(1).optional(),
        metadata: z.string().trim().min(1).optional(),
      },
    },
    async (parsed) =>
      runTool(async () => {
        const isNearIntents = parsed.messenger === 'near-intents';
        if (!isNearIntents && !parsed.relayerFee) {
          throw new UserFacingToolError(
            'missing_input',
            'relayerFee is required for non near-intents messengers.',
            { field: 'relayerFee' },
          );
        }

        const baseRequest = {
          sourceTokenId: parsed.sourceTokenId,
          destinationTokenId: parsed.destinationTokenId,
          sourceSwap: parsed.sourceSwap,
          sourceIntermediaryTokenId: parsed.sourceIntermediaryTokenId,
          destinationIntermediaryTokenId: parsed.destinationIntermediaryTokenId,
          destinationSwap: parsed.destinationSwap,
          estimatedTime: parsed.estimatedTime,
          amount: parsed.amount,
          amountOut: parsed.amountOut,
          sourceAddress: parsed.sourceAddress,
          destinationAddress: parsed.destinationAddress,
          ...(parsed.metadata ? { metadata: parsed.metadata } : {}),
        };

        const body: NextCreateTxRequest = isNearIntents
          ? {
              ...baseRequest,
              messenger: 'near-intents',
              // Default refundTo to sourceAddress to match UI behavior; allow user override.
              refundTo: parsed.refundTo ?? parsed.sourceAddress,
              ...(parsed.relayerFee ? { relayerFee: parsed.relayerFee } : {}),
            }
          : {
              ...baseRequest,
              messenger: parsed.messenger,
              // safe: required-when-non-near guard above
              relayerFee: parsed.relayerFee!,
            };

        const result = await client.postCreateTx(body);
        return { transaction: result };
      }),
  );
}
