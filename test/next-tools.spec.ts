import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { beforeEach, describe, expect, jest, test } from '@jest/globals';

import {
  type NextApiClient,
  type NextCreateTxResponse,
  type NextRouteResponse,
  type NextToken,
} from '../src/next-api-client.js';
import { planNextTransfer, registerNextTools } from '../src/next-tools.js';

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  structuredContent: Record<string, unknown>;
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}>;

class FakeMcpServer {
  readonly handlers = new Map<string, ToolHandler>();
  registerTool(name: string, _definition: unknown, handler: unknown): void {
    this.handlers.set(name, handler as ToolHandler);
  }
  getHandler(name: string): ToolHandler {
    const handler = this.handlers.get(name);
    if (!handler) throw new Error(`Tool ${name} is not registered.`);
    return handler;
  }
}

function createNextClientMock(): jest.Mocked<NextApiClient> {
  return {
    getTokens: jest.fn(),
    postQuote: jest.fn(),
    postCreateTx: jest.fn(),
  } as unknown as jest.Mocked<NextApiClient>;
}

const TOKENS: NextToken[] = [
  { tokenId: 'eth-usdc', chain: 'ETH', symbol: 'USDC', address: '0xEthUsdc', decimals: 6 },
  { tokenId: 'sol-usdc', chain: 'SOL', symbol: 'USDC', address: 'SoLuSdC', decimals: 6 },
  { tokenId: 'arb-usdc', chain: 'ARB', symbol: 'USDC', address: '0xArbUsdc', decimals: 6 },
  { tokenId: 'eth-eth', chain: 'ETH', symbol: 'ETH', address: '0x0', decimals: 18, isNative: true },
];

const QUOTE_RESPONSE: NextRouteResponse[] = [
  {
    sourceTokenId: 'eth-usdc',
    destinationTokenId: 'sol-usdc',
    messenger: 'allbridge',
    estimatedTime: 60,
    amount: '1000000',
    amountOut: '999000',
    relayerFees: [{ tokenId: 'native', amount: '5000' }],
  },
];

const CREATE_TX_RESPONSE: NextCreateTxResponse = {
  amountOut: '999000',
  amountMin: '990000',
  tx: { contractAddress: '0xRouter', value: '0', tx: '0xCAFE' },
};

describe('registerNextTools', () => {
  let server: FakeMcpServer;
  let client: jest.Mocked<NextApiClient>;

  beforeEach(() => {
    server = new FakeMcpServer();
    client = createNextClientMock();
    registerNextTools(server as unknown as McpServer, client);
  });

  test('list_next_chains returns sorted unique chains', async () => {
    client.getTokens.mockResolvedValue(TOKENS);
    const result = await server.getHandler('list_next_chains')({});
    expect(result.structuredContent).toEqual({ chains: ['ARB', 'ETH', 'SOL'] });
  });

  test('list_next_tokens filters by chain (case-insensitive)', async () => {
    client.getTokens.mockResolvedValue(TOKENS);
    const result = await server.getHandler('list_next_tokens')({ chain: 'eth' });
    expect((result.structuredContent.tokens as NextToken[]).map((t) => t.tokenId)).toEqual([
      'eth-usdc',
      'eth-eth',
    ]);
  });

  test('list_next_tokens returns all tokens when no filter passed', async () => {
    client.getTokens.mockResolvedValue(TOKENS);
    const result = await server.getHandler('list_next_tokens')({});
    expect((result.structuredContent.tokens as NextToken[]).length).toBe(TOKENS.length);
  });

  test('quote_next_swap forwards body to /quote and returns routes', async () => {
    client.postQuote.mockResolvedValue(QUOTE_RESPONSE);
    const result = await server.getHandler('quote_next_swap')({
      sourceTokenId: 'eth-usdc',
      destinationTokenId: 'sol-usdc',
      amount: '1000000',
    });
    expect(client.postQuote).toHaveBeenCalledWith({
      sourceTokenId: 'eth-usdc',
      destinationTokenId: 'sol-usdc',
      amount: '1000000',
    });
    expect(result.structuredContent).toEqual({ routes: QUOTE_RESPONSE });
  });

  test('build_next_transaction requires relayerFee for non-near-intents messenger', async () => {
    const result = await server.getHandler('build_next_transaction')({
      sourceTokenId: 'eth-usdc',
      destinationTokenId: 'sol-usdc',
      messenger: 'allbridge',
      amount: '1000000',
      amountOut: '999000',
      sourceAddress: '0xSender',
      destinationAddress: 'SoLrEcIp',
    });
    expect(result.isError).toBe(true);
    expect((result.structuredContent.error as { code: string }).code).toBe('missing_input');
  });

  test('build_next_transaction sends standard request including amountOut', async () => {
    client.postCreateTx.mockResolvedValue(CREATE_TX_RESPONSE);
    await server.getHandler('build_next_transaction')({
      sourceTokenId: 'eth-usdc',
      destinationTokenId: 'sol-usdc',
      messenger: 'allbridge',
      amount: '1000000',
      amountOut: '999000',
      sourceAddress: '0xSender',
      destinationAddress: 'SoLrEcIp',
      relayerFee: { tokenId: 'native', amount: '5000' },
    });
    const sentBody = client.postCreateTx.mock.calls[0]?.[0];
    expect(sentBody).toMatchObject({
      sourceTokenId: 'eth-usdc',
      destinationTokenId: 'sol-usdc',
      messenger: 'allbridge',
      amount: '1000000',
      amountOut: '999000',
      sourceAddress: '0xSender',
      destinationAddress: 'SoLrEcIp',
      relayerFee: { tokenId: 'native', amount: '5000' },
    });
  });

  test('build_next_transaction defaults refundTo to sourceAddress for near-intents', async () => {
    client.postCreateTx.mockResolvedValue(CREATE_TX_RESPONSE);
    await server.getHandler('build_next_transaction')({
      sourceTokenId: 'eth-usdc',
      destinationTokenId: 'sol-usdc',
      messenger: 'near-intents',
      amount: '1000000',
      amountOut: '999000',
      sourceAddress: '0xSender',
      destinationAddress: 'SoLrEcIp',
    });
    const sentBody = client.postCreateTx.mock.calls[0]?.[0];
    expect(sentBody).toMatchObject({
      messenger: 'near-intents',
      refundTo: '0xSender',
    });
    // relayerFee must NOT be present when not supplied
    expect(sentBody && 'relayerFee' in sentBody).toBe(false);
  });

  test('build_next_transaction respects an explicit refundTo override', async () => {
    client.postCreateTx.mockResolvedValue(CREATE_TX_RESPONSE);
    await server.getHandler('build_next_transaction')({
      sourceTokenId: 'eth-usdc',
      destinationTokenId: 'sol-usdc',
      messenger: 'near-intents',
      amount: '1000000',
      amountOut: '999000',
      sourceAddress: '0xSender',
      destinationAddress: 'SoLrEcIp',
      refundTo: '0xRefund',
    });
    const sentBody = client.postCreateTx.mock.calls[0]?.[0];
    expect(sentBody).toMatchObject({
      messenger: 'near-intents',
      refundTo: '0xRefund',
    });
  });

});

describe('planNextTransfer', () => {
  let client: jest.Mocked<NextApiClient>;

  beforeEach(() => {
    client = createNextClientMock();
    client.getTokens.mockResolvedValue(TOKENS);
    client.postQuote.mockResolvedValue(QUOTE_RESPONSE);
  });

  test('resolves Core-style chain+symbol input and quotes', async () => {
    const result = await planNextTransfer(client, {
      sourceChain: 'ETH',
      destinationChain: 'SOL',
      sourceTokenSymbol: 'USDC',
      amount: '1',
      amountUnit: 'human',
    });
    expect(client.postQuote).toHaveBeenCalledWith({
      sourceTokenId: 'eth-usdc',
      destinationTokenId: 'sol-usdc',
      amount: '1000000',
    });
    expect(result.amount).toEqual({ amountInBaseUnits: '1000000', amountInHumanUnits: '1' });
    expect(result.bridgePortalName).toBe('Allbridge NEXT');
    expect(result.options).toEqual(QUOTE_RESPONSE);
    expect(result.summary).toContain('Allbridge NEXT');
  });

  test('matches Solana address case-sensitively (Base58)', async () => {
    // Lowercased Solana address must NOT match.
    await expect(
      planNextTransfer(client, {
        sourceChain: 'SOL',
        destinationChain: 'ETH',
        sourceTokenSymbol: 'USDC',
        sourceTokenAddress: 'solusdc', // wrong case for Base58
        amount: '1',
        amountUnit: 'human',
      }),
    ).rejects.toMatchObject({ code: 'unsupported_token' });
  });

  test('resolves chain aliases (Ethereum -> ETH, Solana -> SOL)', async () => {
    const result = await planNextTransfer(client, {
      sourceChain: 'Ethereum',
      destinationChain: 'Solana',
      sourceTokenSymbol: 'USDC',
      amount: '1',
      amountUnit: 'human',
    });
    expect(result.route.source.tokenId).toBe('eth-usdc');
    expect(result.route.destination.tokenId).toBe('sol-usdc');
  });

  test('matches EVM address case-insensitively (hex)', async () => {
    const result = await planNextTransfer(client, {
      sourceChain: 'ETH',
      destinationChain: 'SOL',
      sourceTokenSymbol: 'USDC',
      sourceTokenAddress: '0xethusdc', // different hex case is fine
      amount: '1',
      amountUnit: 'human',
    });
    expect(result.route.source.tokenId).toBe('eth-usdc');
  });

  test('throws unsupported_token when destination is missing', async () => {
    await expect(
      planNextTransfer(client, {
        sourceChain: 'ETH',
        destinationChain: 'TRX', // not in catalog
        sourceTokenSymbol: 'USDC',
        amount: '1',
        amountUnit: 'human',
      }),
    ).rejects.toMatchObject({ code: 'unsupported_token' });
  });

  test('throws invalid_amount when amount is malformed', async () => {
    await expect(
      planNextTransfer(client, {
        sourceChain: 'ETH',
        destinationChain: 'SOL',
        sourceTokenSymbol: 'USDC',
        amount: 'abc',
        amountUnit: 'human',
      }),
    ).rejects.toMatchObject({ code: 'invalid_amount' });
  });

  test('passes through base-unit amounts', async () => {
    await planNextTransfer(client, {
      sourceChain: 'ETH',
      destinationChain: 'SOL',
      sourceTokenSymbol: 'USDC',
      amount: '2500000',
      amountUnit: 'base',
    });
    expect(client.postQuote).toHaveBeenCalledWith({
      sourceTokenId: 'eth-usdc',
      destinationTokenId: 'sol-usdc',
      amount: '2500000',
    });
  });
});
