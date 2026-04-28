import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { beforeEach, describe, expect, jest, test } from '@jest/globals';

import { AllbridgeApiError, type AllbridgeApiClient } from '../src/allbridge-api-client.js';
import { type AllbridgeExplorerApiClient } from '../src/explorer-api-client.js';
import { registerAllbridgeTools } from '../src/tools.js';
import type { TokenWithChainDetails } from '../src/types.js';

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  structuredContent: Record<string, unknown>;
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}>;

class FakeMcpServer {
  readonly handlers = new Map<string, ToolHandler>();

  registerTool(_name: string, _definition: unknown, _handler: unknown): void {
    this.handlers.set(_name, _handler as ToolHandler);
  }

  getHandler(name: string): ToolHandler {
    const handler = this.handlers.get(name);
    if (!handler) {
      throw new Error(`Tool ${name} is not registered.`);
    }
    return handler;
  }
}

function createToken(overrides: Partial<TokenWithChainDetails>): TokenWithChainDetails {
  return {
    symbol: 'USDC',
    name: 'USD Coin',
    decimals: 6,
    tokenAddress: '0xsource',
    chainSymbol: 'ETH',
    chainName: 'Ethereum',
    chainType: 'EVM',
    ...overrides,
  };
}

function createClientMock(): jest.Mocked<AllbridgeApiClient> {
  return {
    getTokens: jest.fn(),
    getTokenDetails: jest.fn(),
    getTokenBalance: jest.fn(),
    getTokenNativeBalance: jest.fn(),
    getBridgeQuote: jest.fn(),
    getAmountToBeReceived: jest.fn(),
    getTransferTime: jest.fn(),
    checkBridgeAllowance: jest.fn(),
    buildBridgeApproveTx: jest.fn(),
    buildBridgeTx: jest.fn(),
    getTransferStatus: jest.fn(),
    checkStellarBalanceLine: jest.fn(),
    checkAlgorandOptIn: jest.fn(),
    buildStellarTrustlineTransaction: jest.fn(),
    buildAlgorandOptInTransaction: jest.fn(),
  } as unknown as jest.Mocked<AllbridgeApiClient>;
}

function createExplorerClientMock(): jest.Mocked<AllbridgeExplorerApiClient> {
  return {
    search: jest.fn(),
    listTransfers: jest.fn(),
    searchTransfers: jest.fn(),
    getTransfer: jest.fn(),
  } as unknown as jest.Mocked<AllbridgeExplorerApiClient>;
}

describe('registerAllbridgeTools', () => {
  let server: FakeMcpServer;
  let client: jest.Mocked<AllbridgeApiClient>;
  let explorerClient: jest.Mocked<AllbridgeExplorerApiClient>;
  let dependencies: {
    broadcastSignedTransactionByFamily: jest.Mock;
  };

  beforeEach(() => {
    server = new FakeMcpServer();
    client = createClientMock();
    explorerClient = createExplorerClientMock();
    dependencies = {
      broadcastSignedTransactionByFamily: jest.fn(),
    };

    registerAllbridgeTools(server as unknown as McpServer, client, explorerClient, dependencies);

    client.getBridgeQuote.mockResolvedValue({
      amountInt: '1000000',
      amountFloat: '1',
      sourceTokenAddress: '0xsource',
      destinationTokenAddress: '0xdestination',
      options: [
        {
          messenger: 'ALLBRIDGE',
          estimatedTimeMs: 120000,
          paymentMethods: [
            {
              feePaymentMethod: 'WITH_NATIVE_CURRENCY',
              fee: '1000',
              estimatedAmount: {
                min: '1000000',
                max: '1000000',
              },
            },
          ],
        },
      ],
    });
    client.getTokenBalance.mockResolvedValue({ result: '1000000000000000000' });
    client.getTokenNativeBalance.mockResolvedValue({
      int: '1000000000000000000',
      float: '1',
    });
  });

  test('find_bridge_routes resolves tokens by chain and symbol and exposes messengers', async () => {
    client.getTokens.mockResolvedValue([
      createToken({
        symbol: 'USDC',
        tokenAddress: '0xeth-usdc',
        chainSymbol: 'ETH',
        cctpAddress: '0xeth-cctp',
      }),
      createToken({
        symbol: 'USDC',
        tokenAddress: 'sol-usdc',
        chainSymbol: 'SOL',
        chainName: 'Solana',
        chainType: 'SOLANA',
        cctpAddress: 'sol-cctp',
      }),
    ]);

    const result = await server.getHandler('find_bridge_routes')({
      sourceChain: 'Ethereum',
      destinationChain: 'Solana',
      tokenType: 'swap',
      sourceTokenSymbol: 'USDC',
    });

    expect(client.getTokens).toHaveBeenCalledWith({ type: 'swap' });
    expect(result.structuredContent).toEqual({
      route: {
        source: {
          symbol: 'USDC',
          name: 'USD Coin',
          tokenAddress: '0xeth-usdc',
          decimals: 6,
          chainSymbol: 'ETH',
          chainName: 'Ethereum',
          chainType: 'EVM',
        },
        destination: {
          symbol: 'USDC',
          name: 'USD Coin',
          tokenAddress: 'sol-usdc',
          decimals: 6,
          chainSymbol: 'SOL',
          chainName: 'Solana',
          chainType: 'SOLANA',
        },
        symbolPair: 'USDC -> USDC',
      },
      availableMessengers: ['ALLBRIDGE', 'CCTP'],
    });
  });

  test('plan_bridge_transfer returns an agent-friendly plan with summary and next action', async () => {
    client.getTokens.mockResolvedValue([
      createToken({
        symbol: 'USDC',
        tokenAddress: '0xeth-usdc',
        chainSymbol: 'ETH',
        cctpAddress: '0xeth-cctp',
      }),
      createToken({
        symbol: 'USDC',
        tokenAddress: 'sol-usdc',
        chainSymbol: 'SOL',
        chainName: 'Solana',
        chainType: 'SOLANA',
        cctpAddress: 'sol-cctp',
      }),
    ]);
    client.getBridgeQuote.mockResolvedValue({
      amountInt: '1000000',
      amountFloat: '1',
      sourceTokenAddress: '0xeth-usdc',
      destinationTokenAddress: 'sol-usdc',
      options: [
        {
          messenger: 'CCTP',
          estimatedTimeMs: 600000,
          paymentMethods: [
            {
              feePaymentMethod: 'WITH_NATIVE_CURRENCY',
              fee: '1000',
              estimatedAmount: {
                min: '1000000',
                max: '1000000',
              },
            },
          ],
        },
      ],
    });

    const result = await server.getHandler('plan_bridge_transfer')({
      sourceChain: 'Ethereum',
      destinationChain: 'Solana',
      amount: '1',
      amountUnit: 'human',
      tokenType: 'swap',
      sourceTokenSymbol: 'USDC',
    });

    expect(result.structuredContent).toEqual({
      summary: 'Bridge 1 USDC from ETH to SOL',
      route: {
        source: {
          symbol: 'USDC',
          name: 'USD Coin',
          tokenAddress: '0xeth-usdc',
          decimals: 6,
          chainSymbol: 'ETH',
          chainName: 'Ethereum',
          chainType: 'EVM',
        },
        destination: {
          symbol: 'USDC',
          name: 'USD Coin',
          tokenAddress: 'sol-usdc',
          decimals: 6,
          chainSymbol: 'SOL',
          chainName: 'Solana',
          chainType: 'SOLANA',
        },
      },
      amount: {
        amountInBaseUnits: '1000000',
        amountInHumanUnits: '1',
      },
      availableMessengers: ['ALLBRIDGE', 'CCTP'],
      quoteMode: 'direct',
      recommendedOption: {
        messenger: 'CCTP',
        estimatedTimeMs: 600000,
        paymentMethods: [
          {
            feePaymentMethod: 'WITH_NATIVE_CURRENCY',
            feeInBaseUnits: '1000',
            estimatedReceive: {
              minInBaseUnits: '1000000',
              maxInBaseUnits: '1000000',
              minInHumanUnits: '1',
              maxInHumanUnits: '1',
            },
            transferFeeInBaseUnits: null,
            relayerFeeInNative: null,
            relayerFeeInStable: null,
            relayerFeeInAbr: null,
          },
        ],
      },
      options: [
        {
          messenger: 'CCTP',
          estimatedTimeMs: 600000,
          paymentMethods: [
            {
              feePaymentMethod: 'WITH_NATIVE_CURRENCY',
              feeInBaseUnits: '1000',
              estimatedReceive: {
                minInBaseUnits: '1000000',
                maxInBaseUnits: '1000000',
                minInHumanUnits: '1',
                maxInHumanUnits: '1',
              },
              transferFeeInBaseUnits: null,
              relayerFeeInNative: null,
              relayerFeeInStable: null,
              relayerFeeInAbr: null,
            },
          ],
        },
      ],
      bridgePortalName: 'Allbridge Core',
      bridgePortalUrl: 'https://core.allbridge.io',
      bridgePortalDeepLink: 'https://core.allbridge.io/?f=ETH&t=SOL&ft=USDC&tt=USDC&send=1&messenger=CCTP',
      nextAction:
        'Before calling create_bridge_execution_job, ask for the sender address and recipient address, confirm the source and destination token symbols if they were not already pinned, and run check_sender_balances. Proceed only if canProceed is true.',
    });
  });

  test('quote_bridge_transfer returns normalized direct quote output', async () => {
    const sourceToken = createToken({
      symbol: 'YARO',
      decimals: 18,
      tokenAddress: '0xyaro-eth',
      feeShare: '0.003',
    });
    const destinationToken = createToken({
      symbol: 'YARO',
      decimals: 9,
      tokenAddress: 'yaro-sol',
      chainSymbol: 'SOL',
      chainName: 'Solana',
      chainType: 'SOLANA',
    });

    client.getTokens.mockResolvedValue([sourceToken, destinationToken]);
    client.getBridgeQuote.mockResolvedValue({
      amountInt: '1000000000000000000',
      amountFloat: '1',
      sourceTokenAddress: sourceToken.tokenAddress,
      destinationTokenAddress: destinationToken.tokenAddress,
      options: [
        {
          messenger: 'ALLBRIDGE',
          estimatedTimeMs: 360000,
          paymentMethods: [
            {
              feePaymentMethod: 'WITH_NATIVE_CURRENCY',
              fee: '1000',
              estimatedAmount: {
                min: '1040868000',
                max: '1040868000',
              },
              relayerFeeInNative: '1000',
            },
          ],
        },
      ],
    });

    const result = await server.getHandler('quote_bridge_transfer')({
      sourceTokenAddress: sourceToken.tokenAddress,
      destinationTokenAddress: destinationToken.tokenAddress,
      amount: '1',
      amountUnit: 'human',
    });

    expect(client.getBridgeQuote).toHaveBeenCalledWith({
      sourceToken: sourceToken.tokenAddress,
      destinationToken: destinationToken.tokenAddress,
      amount: '1000000000000000000',
    });
    expect(result.structuredContent).toEqual({
      route: {
        source: {
          symbol: 'YARO',
          name: 'USD Coin',
          tokenAddress: '0xyaro-eth',
          decimals: 18,
          chainSymbol: 'ETH',
          chainName: 'Ethereum',
          chainType: 'EVM',
        },
        destination: {
          symbol: 'YARO',
          name: 'USD Coin',
          tokenAddress: 'yaro-sol',
          decimals: 9,
          chainSymbol: 'SOL',
          chainName: 'Solana',
          chainType: 'SOLANA',
        },
      },
      amount: {
        amountInBaseUnits: '1000000000000000000',
        amountInHumanUnits: '1',
      },
      quoteMode: 'direct',
      options: [
        {
          messenger: 'ALLBRIDGE',
          estimatedTimeMs: 360000,
          paymentMethods: [
            {
              feePaymentMethod: 'WITH_NATIVE_CURRENCY',
              feeInBaseUnits: '1000',
              estimatedReceive: {
                minInBaseUnits: '1040868000',
                maxInBaseUnits: '1040868000',
                minInHumanUnits: '1.040868',
                maxInHumanUnits: '1.040868',
              },
              transferFeeInBaseUnits: null,
              relayerFeeInNative: '1000',
              relayerFeeInStable: null,
              relayerFeeInAbr: null,
            },
          ],
        },
      ],
      bridgePortalName: 'Allbridge Core',
      bridgePortalUrl: 'https://core.allbridge.io',
      bridgePortalDeepLink: 'https://core.allbridge.io/?f=ETH&t=SOL&ft=YARO&tt=YARO&send=1&messenger=ALLBRIDGE',
    });
  });

  test('quote_bridge_transfer falls back to route endpoints when aggregate quote fails', async () => {
    const sourceToken = createToken({
      symbol: 'USDC',
      tokenAddress: '0xeth-usdc',
      chainSymbol: 'ETH',
      cctpAddress: '0xeth-cctp',
    });
    const destinationToken = createToken({
      symbol: 'USDC',
      tokenAddress: 'sol-usdc',
      chainSymbol: 'SOL',
      chainName: 'Solana',
      chainType: 'SOLANA',
      cctpAddress: 'sol-cctp',
    });

    client.getTokens.mockResolvedValue([sourceToken, destinationToken]);
    client.getBridgeQuote.mockRejectedValue(
      new AllbridgeApiError('[big.js] Invalid number', 400),
    );
    client.getAmountToBeReceived
      .mockResolvedValueOnce({
        amountInFloat: '1',
        amountReceivedInFloat: '0.997997',
      })
      .mockResolvedValueOnce({
        amountInFloat: '1',
        amountReceivedInFloat: '1',
      });
    client.getTransferTime.mockResolvedValueOnce(300000).mockResolvedValueOnce(600000);

    const result = await server.getHandler('quote_bridge_transfer')({
      sourceTokenAddress: sourceToken.tokenAddress,
      destinationTokenAddress: destinationToken.tokenAddress,
      amount: '1000000',
      amountUnit: 'base',
    });

    expect(client.getAmountToBeReceived).toHaveBeenNthCalledWith(1, {
      amount: '1000000',
      sourceToken: '0xeth-usdc',
      destinationToken: 'sol-usdc',
      messenger: 'ALLBRIDGE',
    });
    expect(client.getAmountToBeReceived).toHaveBeenNthCalledWith(2, {
      amount: '1000000',
      sourceToken: '0xeth-usdc',
      destinationToken: 'sol-usdc',
      messenger: 'CCTP',
    });
    expect(result.structuredContent).toMatchObject({
      amount: {
        amountInBaseUnits: '1000000',
        amountInHumanUnits: '1',
      },
      quoteMode: 'fallback',
      options: [
        {
          messenger: 'ALLBRIDGE',
          estimatedTimeMs: 300000,
          paymentMethods: [
            {
              estimatedReceive: {
                minInBaseUnits: '997997',
                maxInBaseUnits: '997997',
              },
            },
          ],
        },
        {
          messenger: 'CCTP',
          estimatedTimeMs: 600000,
          paymentMethods: [
            {
              estimatedReceive: {
                minInBaseUnits: '1000000',
                maxInBaseUnits: '1000000',
              },
            },
          ],
        },
      ],
    });
  });

  test('build_bridge_transactions returns normalized tx summary and raw transactions', async () => {
    const sourceToken = createToken({
      symbol: 'YARO',
      decimals: 18,
      tokenAddress: '0xyaro-eth',
    });

    client.getTokens.mockResolvedValue([
      sourceToken,
      createToken({
        symbol: 'YARO',
        name: 'YARO',
        decimals: 9,
        tokenAddress: 'yaro-sol',
        chainSymbol: 'SOL',
        chainName: 'Solana',
        chainType: 'SOLANA',
      }),
    ]);
    client.checkBridgeAllowance.mockResolvedValue(false);
    client.buildBridgeApproveTx.mockResolvedValue({
      from: '0x1111111111111111111111111111111111111111',
      to: sourceToken.tokenAddress,
      data: '0xapprove',
      value: '0',
    });
    client.buildBridgeTx.mockResolvedValue({
      from: '0x1111111111111111111111111111111111111111',
      to: '0xbridge',
      data: '0xbridge-data',
      value: '123',
    });

    const result = await server.getHandler('build_bridge_transactions')({
      sourceTokenAddress: sourceToken.tokenAddress,
      destinationTokenAddress: 'yaro-sol',
      senderAddress: '0x1111111111111111111111111111111111111111',
      recipientAddress: '11111111111111111111111111111111',
      amount: '1',
      amountUnit: 'human',
      messenger: 'ALLBRIDGE',
      feePaymentMethod: 'WITH_NATIVE_CURRENCY',
      outputFormat: 'json',
    });

    expect(client.checkBridgeAllowance).toHaveBeenCalledWith({
      amount: '1000000000000000000',
      ownerAddress: '0x1111111111111111111111111111111111111111',
      tokenAddress: '0xyaro-eth',
      feePaymentMethod: 'WITH_NATIVE_CURRENCY',
      contractAddress: undefined,
    });
    expect(result.structuredContent).toEqual({
      balanceValidation: {
        sourceToken: {
          symbol: 'YARO',
          name: 'USD Coin',
          tokenAddress: '0xyaro-eth',
          decimals: 18,
          chainSymbol: 'ETH',
          chainName: 'Ethereum',
          chainType: 'EVM',
        },
        destinationToken: {
          symbol: 'YARO',
          name: 'YARO',
          tokenAddress: 'yaro-sol',
          decimals: 9,
          chainSymbol: 'SOL',
          chainName: 'Solana',
          chainType: 'SOLANA',
        },
        amount: {
          amountInBaseUnits: '1000000000000000000',
          amountInHumanUnits: '1',
        },
        messenger: 'ALLBRIDGE',
        feePaymentMethod: 'WITH_NATIVE_CURRENCY',
        requiredBalances: [
          {
            key: 'token:0xyaro-eth',
            kind: 'source_token',
            label: 'YARO balance',
            chainSymbol: 'ETH',
            tokenAddress: '0xyaro-eth',
            requiredBaseUnits: '1000000000000000000',
            availableBaseUnits: '1000000000000000000',
            availableHumanUnits: '1',
            satisfied: true,
          },
          {
            key: 'native:ETH',
            kind: 'fee_native',
            label: 'ETH native fee balance',
            chainSymbol: 'ETH',
            tokenAddress: null,
            requiredBaseUnits: '1000',
            availableBaseUnits: '1000000000000000000',
            availableHumanUnits: '1',
            satisfied: true,
          },
        ],
        canProceed: true,
        nextAction: 'Balances are sufficient. You can call create_bridge_execution_job now.',
      },
      route: {
        source: {
          symbol: 'YARO',
          name: 'USD Coin',
          tokenAddress: '0xyaro-eth',
          decimals: 18,
          chainSymbol: 'ETH',
          chainName: 'Ethereum',
          chainType: 'EVM',
        },
        destination: {
          symbol: 'YARO',
          name: 'YARO',
          tokenAddress: 'yaro-sol',
          decimals: 9,
          chainSymbol: 'SOL',
          chainName: 'Solana',
          chainType: 'SOLANA',
        },
        destinationTokenAddress: 'yaro-sol',
        messenger: 'ALLBRIDGE',
        feePaymentMethod: 'WITH_NATIVE_CURRENCY',
      },
      amount: {
        amountInBaseUnits: '1000000000000000000',
        amountInHumanUnits: '1',
      },
      approvalRequired: true,
      approvalTxShape: 'object',
      bridgeTxShape: 'object',
      approvalTx: {
        from: '0x1111111111111111111111111111111111111111',
        to: '0xyaro-eth',
        data: '0xapprove',
        value: '0',
      },
      bridgeTx: {
        from: '0x1111111111111111111111111111111111111111',
        to: '0xbridge',
        data: '0xbridge-data',
        value: '123',
      },
      destinationSetup: null,
      nextAction: 'Send the approval transaction to the signer or broadcaster first, then send the bridge transaction.',
    });
  });

  test('check_sender_balances reports insufficient fee balance without blocking the check tool', async () => {
    const sourceToken = createToken({
      symbol: 'USDC',
      tokenAddress: 'sol-usdc',
      chainSymbol: 'SOL',
      chainName: 'Solana',
      chainType: 'SOLANA',
    });
    const destinationToken = createToken({
      symbol: 'USDC',
      tokenAddress: 'bsc-usdc',
      chainSymbol: 'BSC',
      chainName: 'BNB Chain',
      chainType: 'EVM',
    });

    client.getTokens.mockResolvedValue([sourceToken, destinationToken]);
    client.getBridgeQuote.mockResolvedValue({
      amountInt: '500000',
      amountFloat: '0.5',
      sourceTokenAddress: sourceToken.tokenAddress,
      destinationTokenAddress: destinationToken.tokenAddress,
      options: [
        {
          messenger: 'ALLBRIDGE',
          estimatedTimeMs: 120000,
          paymentMethods: [
            {
              feePaymentMethod: 'WITH_NATIVE_CURRENCY',
              fee: '4392659',
              estimatedAmount: {
                min: '4990982000000000000',
                max: '4990982000000000000',
              },
            },
          ],
        },
      ],
    });
    client.getTokenBalance.mockResolvedValue({ result: '1000000' });
    client.getTokenNativeBalance.mockResolvedValue({
      int: '1000',
      float: '0.000001',
    });

    const result = await server.getHandler('check_sender_balances')({
      sourceTokenAddress: sourceToken.tokenAddress,
      destinationTokenAddress: destinationToken.tokenAddress,
      senderAddress: '4CvAkvPUQyo6RHMXr8KsYnXxMiPtgqoWm3wZHYyNpzY7',
      amount: '0.5',
      amountUnit: 'human',
      messenger: 'ALLBRIDGE',
      feePaymentMethod: 'WITH_NATIVE_CURRENCY',
    });

    expect(result.structuredContent).toEqual({
      sourceToken: {
        symbol: 'USDC',
        name: 'USD Coin',
        tokenAddress: 'sol-usdc',
        decimals: 6,
        chainSymbol: 'SOL',
        chainName: 'Solana',
        chainType: 'SOLANA',
      },
      destinationToken: {
        symbol: 'USDC',
        name: 'USD Coin',
        tokenAddress: 'bsc-usdc',
        decimals: 6,
        chainSymbol: 'BSC',
        chainName: 'BNB Chain',
        chainType: 'EVM',
      },
      amount: {
        amountInBaseUnits: '500000',
        amountInHumanUnits: '0.5',
      },
      messenger: 'ALLBRIDGE',
      feePaymentMethod: 'WITH_NATIVE_CURRENCY',
      requiredBalances: [
        {
          key: 'token:sol-usdc',
          kind: 'source_token',
          label: 'USDC balance',
          chainSymbol: 'SOL',
          tokenAddress: 'sol-usdc',
          requiredBaseUnits: '500000',
          availableBaseUnits: '1000000',
          availableHumanUnits: '1',
          satisfied: true,
        },
        {
          key: 'native:SOL',
          kind: 'fee_native',
          label: 'SOL native fee balance',
          chainSymbol: 'SOL',
          tokenAddress: null,
          requiredBaseUnits: '4392659',
          availableBaseUnits: '1000',
          availableHumanUnits: '0.000001',
          satisfied: false,
        },
      ],
      canProceed: false,
      nextAction: 'Top up the insufficient balance(s) and rerun check_sender_balances before create_bridge_execution_job.',
    });
  });

  test('build_bridge_transactions returns advisory balance validation when balances are insufficient', async () => {
    const sourceToken = createToken({
      symbol: 'USDC',
      tokenAddress: 'sol-usdc',
      chainSymbol: 'SOL',
      chainName: 'Solana',
      chainType: 'SOLANA',
    });
    const destinationToken = createToken({
      symbol: 'USDC',
      tokenAddress: 'bsc-usdc',
      chainSymbol: 'BSC',
      chainName: 'BNB Chain',
      chainType: 'EVM',
    });

    client.getTokens.mockResolvedValue([sourceToken, destinationToken]);
    client.getBridgeQuote.mockResolvedValue({
      amountInt: '500000',
      amountFloat: '0.5',
      sourceTokenAddress: sourceToken.tokenAddress,
      destinationTokenAddress: destinationToken.tokenAddress,
      options: [
        {
          messenger: 'ALLBRIDGE',
          estimatedTimeMs: 120000,
          paymentMethods: [
            {
              feePaymentMethod: 'WITH_NATIVE_CURRENCY',
              fee: '4392659',
              estimatedAmount: {
                min: '4990982000000000000',
                max: '4990982000000000000',
              },
            },
          ],
        },
      ],
    });
    client.getTokenBalance.mockResolvedValue({ result: '1000000' });
    client.getTokenNativeBalance.mockResolvedValue({
      int: '1000',
      float: '0.000001',
    });

    const result = await server.getHandler('build_bridge_transactions')({
      sourceTokenAddress: sourceToken.tokenAddress,
      destinationTokenAddress: destinationToken.tokenAddress,
      senderAddress: '4CvAkvPUQyo6RHMXr8KsYnXxMiPtgqoWm3wZHYyNpzY7',
      recipientAddress: '0xFCF08FA44b4d8Ca416c65409F93ce114faAA87BF',
      amount: '0.5',
      amountUnit: 'human',
      messenger: 'ALLBRIDGE',
      feePaymentMethod: 'WITH_NATIVE_CURRENCY',
      outputFormat: 'json',
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      balanceValidation: {
        canProceed: false,
        nextAction: 'Top up the insufficient balance(s) and rerun check_sender_balances before create_bridge_execution_job.',
      },
      nextAction: expect.stringContaining('Balance preflight indicates a missing balance or fee requirement'),
    });
    expect(client.buildBridgeTx).toHaveBeenCalled();
  });

  test.each([
    {
      label: 'Stellar',
      destinationToken: createToken({
        symbol: 'USDC',
        name: 'USD Coin',
        decimals: 7,
        tokenAddress: 'stellar-usdc',
        chainSymbol: 'XLM',
        chainName: 'Stellar',
        chainType: 'SRB',
      }),
      recipientAddress: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
      setupMock: () => client.checkStellarBalanceLine.mockRejectedValueOnce(new AllbridgeApiError('missing trustline', 404)),
      expectedSetup: {
        required: true,
        chainFamily: 'SRB',
        chainSymbol: 'XLM',
        accountAddress: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
        checkTool: 'check_stellar_trustline',
        buildTool: 'build_stellar_trustline_transaction',
      },
    },
    {
      label: 'Algorand',
      destinationToken: createToken({
        symbol: 'USDC',
        name: 'USD Coin',
        decimals: 6,
        tokenAddress: 'alg-usdc',
        chainSymbol: 'ALGO',
        chainName: 'Algorand',
        chainType: 'ALG',
      }),
      recipientAddress: 'VF6Y2AUGWTWZK7EF2K7A6ZN6TBVAEUCVPA6HQBHENLOXZXHPFWFNYKF2YQ',
      setupMock: () => client.checkAlgorandOptIn.mockResolvedValueOnce(false),
      expectedSetup: {
        required: true,
        chainFamily: 'ALG',
        chainSymbol: 'ALGO',
        accountAddress: 'VF6Y2AUGWTWZK7EF2K7A6ZN6TBVAEUCVPA6HQBHENLOXZXHPFWFNYKF2YQ',
        checkTool: 'check_algorand_optin',
        buildTool: 'build_algorand_optin_transaction',
      },
    },
  ])('build_bridge_transactions detects $label destination setup requirements', async ({
    destinationToken,
    recipientAddress,
    setupMock,
    expectedSetup,
  }) => {
    const sourceToken = createToken({
      symbol: 'USDC',
      name: 'USD Coin',
      decimals: 6,
      tokenAddress: 'eth-usdc',
    });

    client.getTokens.mockResolvedValue([sourceToken, destinationToken]);
    client.checkBridgeAllowance.mockResolvedValue(true);
    client.buildBridgeTx.mockResolvedValue({
      from: '0x1111111111111111111111111111111111111111',
      to: '0xbridge',
      data: '0xbridge-data',
      value: '0',
    });
    setupMock();

    const result = await server.getHandler('build_bridge_transactions')({
      sourceTokenAddress: sourceToken.tokenAddress,
      destinationTokenAddress: destinationToken.tokenAddress,
      senderAddress: '0x1111111111111111111111111111111111111111',
      recipientAddress,
      amount: '1',
      amountUnit: 'human',
      messenger: 'ALLBRIDGE',
      feePaymentMethod: 'WITH_NATIVE_CURRENCY',
      outputFormat: 'json',
    });

    expect(result.structuredContent.destinationSetup).toMatchObject(expectedSetup);
    expect(result.structuredContent.destinationSetup.required).toBe(true);
    expect(result.structuredContent.nextAction).toContain(expectedSetup.checkTool);
    expect(result.structuredContent.nextAction).toContain(expectedSetup.buildTool);
  });

  test('check_sender_balances combines source amount and stable fee on the source token', async () => {
    const sourceToken = createToken({
      symbol: 'USDC',
      tokenAddress: 'sol-usdc',
      chainSymbol: 'SOL',
      chainName: 'Solana',
      chainType: 'SOLANA',
    });
    const destinationToken = createToken({
      symbol: 'USDC',
      tokenAddress: 'bsc-usdc',
      chainSymbol: 'BSC',
      chainName: 'BNB Chain',
      chainType: 'EVM',
    });

    client.getTokens.mockResolvedValue([sourceToken, destinationToken]);
    client.getBridgeQuote.mockResolvedValue({
      amountInt: '500000',
      amountFloat: '0.5',
      sourceTokenAddress: sourceToken.tokenAddress,
      destinationTokenAddress: destinationToken.tokenAddress,
      options: [
        {
          messenger: 'ALLBRIDGE',
          estimatedTimeMs: 120000,
          paymentMethods: [
            {
              feePaymentMethod: 'WITH_STABLECOIN',
              fee: '381810',
              estimatedAmount: {
                min: '4609131000000000000',
                max: '4609131000000000000',
              },
            },
          ],
        },
      ],
    });
    client.getTokenBalance.mockResolvedValue({ result: '500000' });
    client.getTokenNativeBalance.mockResolvedValue({
      int: '1000',
      float: '0.000001',
    });

    const result = await server.getHandler('check_sender_balances')({
      sourceTokenAddress: sourceToken.tokenAddress,
      destinationTokenAddress: destinationToken.tokenAddress,
      senderAddress: '4CvAkvPUQyo6RHMXr8KsYnXxMiPtgqoWm3wZHYyNpzY7',
      amount: '0.5',
      amountUnit: 'human',
      messenger: 'ALLBRIDGE',
      feePaymentMethod: 'WITH_STABLECOIN',
    });

    expect(result.structuredContent).toEqual({
      sourceToken: {
        symbol: 'USDC',
        name: 'USD Coin',
        tokenAddress: 'sol-usdc',
        decimals: 6,
        chainSymbol: 'SOL',
        chainName: 'Solana',
        chainType: 'SOLANA',
      },
      destinationToken: {
        symbol: 'USDC',
        name: 'USD Coin',
        tokenAddress: 'bsc-usdc',
        decimals: 6,
        chainSymbol: 'BSC',
        chainName: 'BNB Chain',
        chainType: 'EVM',
      },
      amount: {
        amountInBaseUnits: '500000',
        amountInHumanUnits: '0.5',
      },
      messenger: 'ALLBRIDGE',
      feePaymentMethod: 'WITH_STABLECOIN',
      requiredBalances: [
        {
          key: 'token:sol-usdc',
          kind: 'source_token',
          label: 'USDC balance (amount + relayer fee)',
          chainSymbol: 'SOL',
          tokenAddress: 'sol-usdc',
          requiredBaseUnits: '881810',
          availableBaseUnits: '500000',
          availableHumanUnits: '0.5',
          satisfied: false,
        },
      ],
      canProceed: false,
      nextAction: 'Top up the insufficient balance(s) and rerun check_sender_balances before create_bridge_execution_job.',
    });
  });

  test('create_bridge_execution_job returns ordered signing steps and tracking metadata', async () => {
    const sourceToken = createToken({
      symbol: 'YARO',
      name: 'YARO',
      decimals: 18,
      tokenAddress: '0xyaro-eth',
    });
    const destinationToken = createToken({
      symbol: 'YARO',
      name: 'YARO',
      decimals: 9,
      tokenAddress: 'yaro-sol',
      chainSymbol: 'SOL',
      chainName: 'Solana',
      chainType: 'SOLANA',
    });

    client.getTokens.mockResolvedValue([sourceToken, destinationToken]);
    client.checkBridgeAllowance.mockResolvedValue(false);
    client.buildBridgeApproveTx.mockResolvedValue({
      from: '0x1111111111111111111111111111111111111111',
      to: sourceToken.tokenAddress,
      data: '0xapprove',
      value: '0',
    });
    client.buildBridgeTx.mockResolvedValue({
      from: '0x1111111111111111111111111111111111111111',
      to: '0xbridge',
      data: '0xbridge-data',
      value: '123',
    });

    const result = await server.getHandler('create_bridge_execution_job')({
      sourceTokenAddress: sourceToken.tokenAddress,
      destinationTokenAddress: destinationToken.tokenAddress,
      senderAddress: '0x1111111111111111111111111111111111111111',
      recipientAddress: '11111111111111111111111111111111',
      amount: '1',
      amountUnit: 'human',
      messenger: 'ALLBRIDGE',
      feePaymentMethod: 'WITH_NATIVE_CURRENCY',
      outputFormat: 'json',
    });

    expect(result.structuredContent).toMatchObject({
      kind: 'bridge_transfer',
      version: 'v1',
      mode: 'external_signer',
      status: 'awaiting_signature',
      summary: 'Bridge 1 YARO from ETH to SOL to 11111111111111111111111111111111',
      bridgePortalName: 'Allbridge Core',
      bridgePortalUrl: 'https://core.allbridge.io',
      bridgePortalDeepLink: 'https://core.allbridge.io/?f=ETH&t=SOL&ft=YARO&tt=YARO&send=1&messenger=ALLBRIDGE',
      balanceValidation: {
      sourceToken: {
        symbol: 'YARO',
        name: 'YARO',
        tokenAddress: '0xyaro-eth',
        decimals: 18,
        chainSymbol: 'ETH',
          chainName: 'Ethereum',
          chainType: 'EVM',
        },
        destinationToken: {
          symbol: 'YARO',
          name: 'YARO',
          tokenAddress: 'yaro-sol',
          decimals: 9,
          chainSymbol: 'SOL',
          chainName: 'Solana',
          chainType: 'SOLANA',
        },
        amount: {
          amountInBaseUnits: '1000000000000000000',
          amountInHumanUnits: '1',
        },
        messenger: 'ALLBRIDGE',
        feePaymentMethod: 'WITH_NATIVE_CURRENCY',
        requiredBalances: [
          {
            key: 'token:0xyaro-eth',
            kind: 'source_token',
            label: 'YARO balance',
            chainSymbol: 'ETH',
            tokenAddress: '0xyaro-eth',
            requiredBaseUnits: '1000000000000000000',
            availableBaseUnits: '1000000000000000000',
            availableHumanUnits: '1',
            satisfied: true,
          },
          {
            key: 'native:ETH',
            kind: 'fee_native',
            label: 'ETH native fee balance',
            chainSymbol: 'ETH',
            tokenAddress: null,
            requiredBaseUnits: '1000',
            availableBaseUnits: '1000000000000000000',
            availableHumanUnits: '1',
            satisfied: true,
          },
        ],
        canProceed: true,
        nextAction: 'Balances are sufficient. You can call create_bridge_execution_job now.',
      },
      route: {
        source: {
          symbol: 'YARO',
          name: 'YARO',
          tokenAddress: '0xyaro-eth',
          decimals: 18,
          chainSymbol: 'ETH',
          chainName: 'Ethereum',
          chainType: 'EVM',
        },
        destination: {
          symbol: 'YARO',
          name: 'YARO',
          tokenAddress: 'yaro-sol',
          decimals: 9,
          chainSymbol: 'SOL',
          chainName: 'Solana',
          chainType: 'SOLANA',
        },
        messenger: 'ALLBRIDGE',
        feePaymentMethod: 'WITH_NATIVE_CURRENCY',
      },
      participants: {
        senderAddress: '0x1111111111111111111111111111111111111111',
        recipientAddress: '11111111111111111111111111111111',
      },
      amount: {
        amountInBaseUnits: '1000000000000000000',
        amountInHumanUnits: '1',
      },
      handoff: {
        executionTarget: 'local-signer-mcp',
        executionTool: 'sign_and_broadcast_transaction',
        executionAction: 'sign_and_broadcast',
        broadcastTarget: 'allbridge-mcp',
        broadcastTool: 'broadcast_signed_transaction',
        broadcastAction: 'broadcast',
        walletSelector: {
          walletId: null,
          senderAddress: '0x1111111111111111111111111111111111111111',
          chainFamily: 'EVM',
          chainSymbol: 'ETH',
        },
        stepId: 'approve',
        transactionShape: 'object',
        stepCount: 2,
        stepIds: ['approve', 'bridge'],
      },
      steps: [
        {
          id: 'approve',
          order: 1,
          type: 'sign_and_submit_transaction',
          status: 'awaiting_signature',
          required: true,
          summary: 'Approve YARO spending on ETH.',
          transactionShape: 'object',
          transaction: {
            from: '0x1111111111111111111111111111111111111111',
            to: '0xyaro-eth',
            data: '0xapprove',
            value: '0',
          },
          handoff: {
            executionTarget: 'local-signer-mcp',
            executionTool: 'sign_and_broadcast_transaction',
            executionAction: 'sign_and_broadcast',
            broadcastTarget: 'allbridge-mcp',
            broadcastTool: 'broadcast_signed_transaction',
            broadcastAction: 'broadcast',
            walletSelector: {
              walletId: null,
              senderAddress: '0x1111111111111111111111111111111111111111',
              chainFamily: 'EVM',
              chainSymbol: 'ETH',
            },
            stepId: 'approve',
            transactionShape: 'object',
            nextStepId: 'bridge',
          },
          nextOnSuccess: 'bridge',
        },
        {
          id: 'bridge',
          order: 2,
          type: 'sign_and_submit_transaction',
          status: 'blocked',
          required: true,
          summary: 'Bridge 1 YARO from ETH to SOL to 11111111111111111111111111111111',
          transactionShape: 'object',
          transaction: {
            from: '0x1111111111111111111111111111111111111111',
            to: '0xbridge',
            data: '0xbridge-data',
            value: '123',
          },
          handoff: {
            executionTarget: 'local-signer-mcp',
            executionTool: 'sign_and_broadcast_transaction',
            executionAction: 'sign_and_broadcast',
            broadcastTarget: 'allbridge-mcp',
            broadcastTool: 'broadcast_signed_transaction',
            broadcastAction: 'broadcast',
            walletSelector: {
              walletId: null,
              senderAddress: '0x1111111111111111111111111111111111111111',
              chainFamily: 'EVM',
              chainSymbol: 'ETH',
            },
            stepId: 'bridge',
            transactionShape: 'object',
            nextStepId: 'track_transfer',
          },
          nextOnSuccess: 'track_transfer',
        },
      ],
      tracking: {
        sourceChain: 'ETH',
        destinationChain: 'SOL',
        sourceTokenAddress: '0xyaro-eth',
        destinationTokenAddress: 'yaro-sol',
        transferStatusTool: 'get_transfer_status',
        transferStatusArguments: {
          sourceChain: 'ETH',
          txId: '<source transaction hash>',
        },
        historyUrlTemplate: 'https://core.allbridge.io/history/ETH/{txId}',
      },
      destinationSetup: null,
      nextAction: 'Send the approve step to local-signer-mcp for EVM or broadcast the signed approve step with allbridge-mcp, then continue with the bridge step.',
    });
    expect(typeof result.structuredContent.jobId).toBe('string');
    expect((result.structuredContent.jobId as string).length).toBeGreaterThan(0);
  });

  test('create_bridge_execution_job accepts a Tron recipient address', async () => {
    const sourceToken = createToken({
      symbol: 'USDT',
      name: 'Tether USD',
      decimals: 6,
      tokenAddress: '0xusdt-eth',
    });
    const destinationToken = createToken({
      symbol: 'USDT',
      name: 'Tether USD',
      decimals: 6,
      tokenAddress: 'trx-usdt',
      chainSymbol: 'TRX',
      chainName: 'Tron',
      chainType: 'TRX',
    });

    client.getTokens.mockResolvedValue([sourceToken, destinationToken]);
    client.checkBridgeAllowance.mockResolvedValue(true);
    client.buildBridgeTx.mockResolvedValue({
      from: '0x1111111111111111111111111111111111111111',
      to: '0xbridge',
      data: '0xbridge-data',
      value: '0',
    });

    const result = await server.getHandler('create_bridge_execution_job')({
      sourceTokenAddress: sourceToken.tokenAddress,
      destinationTokenAddress: destinationToken.tokenAddress,
      senderAddress: '0x1111111111111111111111111111111111111111',
      walletId: 'MAINNET',
      recipientAddress: 'TMx9GbR6VZ5zYbNzs28ZzaYffSN916nEXA',
      amount: '1',
      amountUnit: 'human',
      messenger: 'ALLBRIDGE',
      feePaymentMethod: 'WITH_NATIVE_CURRENCY',
      outputFormat: 'json',
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent.participants).toMatchObject({
      recipientAddress: 'TMx9GbR6VZ5zYbNzs28ZzaYffSN916nEXA',
    });
  });

  test('create_bridge_execution_job supports a Solana source chain', async () => {
    const sourceToken = createToken({
      symbol: 'USDC',
      name: 'USD Coin',
      decimals: 6,
      tokenAddress: 'sol-usdc',
      chainSymbol: 'SOL',
      chainName: 'Solana',
      chainType: 'SOLANA',
    });
    const destinationToken = createToken({
      symbol: 'USDC',
      name: 'USD Coin',
      decimals: 18,
      tokenAddress: '0xusdc-bsc',
      chainSymbol: 'BSC',
      chainName: 'BNB Chain',
      chainType: 'EVM',
    });

    client.getTokens.mockResolvedValue([sourceToken, destinationToken]);
    client.buildBridgeTx.mockResolvedValue({
      from: '4CvAkvPUQyo6RHMXr8KsYnXxMiPtgqoWm3wZHYyNpzY7',
      to: '0xbridge',
      data: '0xbridge-data',
      value: '0',
    });

    const result = await server.getHandler('create_bridge_execution_job')({
      sourceTokenAddress: sourceToken.tokenAddress,
      destinationTokenAddress: destinationToken.tokenAddress,
      senderAddress: '4CvAkvPUQyo6RHMXr8KsYnXxMiPtgqoWm3wZHYyNpzY7',
      recipientAddress: '0xFCF08FA44b4d8Ca416c65409F93ce114faAA87BF',
      amount: '5',
      amountUnit: 'human',
      messenger: 'ALLBRIDGE',
      feePaymentMethod: 'WITH_NATIVE_CURRENCY',
      outputFormat: 'json',
    });

    expect(result.isError).not.toBe(true);
    expect(client.checkBridgeAllowance).not.toHaveBeenCalled();
    expect(client.buildBridgeApproveTx).not.toHaveBeenCalled();
    expect(result.structuredContent).toMatchObject({
      route: {
        source: {
          chainSymbol: 'SOL',
          chainType: 'SOLANA',
        },
        destination: {
          chainSymbol: 'BSC',
          chainType: 'EVM',
        },
      },
      handoff: {
        walletSelector: {
          chainFamily: 'SOLANA',
          chainSymbol: 'SOL',
        },
      },
    });
    expect(result.structuredContent.nextAction as string).toContain('SOLANA');
  });

  test('create_bridge_execution_job propagates walletId into the execution handoff', async () => {
    const sourceToken = createToken({
      symbol: 'USDC',
      name: 'USD Coin',
      decimals: 6,
      tokenAddress: '0xusdc-eth',
    });
    const destinationToken = createToken({
      symbol: 'USDC',
      name: 'USD Coin',
      decimals: 6,
      tokenAddress: '0xusdc-sol',
      chainSymbol: 'SOL',
      chainName: 'Solana',
      chainType: 'SOLANA',
    });

    client.getTokens.mockResolvedValue([sourceToken, destinationToken]);
    client.checkBridgeAllowance.mockResolvedValue(true);
    client.buildBridgeTx.mockResolvedValue({
      from: '0x1111111111111111111111111111111111111111',
      to: '0xbridge',
      data: '0xbridge-data',
      value: '0',
    });

    const result = await server.getHandler('create_bridge_execution_job')({
      sourceTokenAddress: sourceToken.tokenAddress,
      destinationTokenAddress: destinationToken.tokenAddress,
      senderAddress: '0x1111111111111111111111111111111111111111',
      walletId: 'MAINNET',
      recipientAddress: '11111111111111111111111111111111',
      amount: '1',
      amountUnit: 'human',
      messenger: 'ALLBRIDGE',
      feePaymentMethod: 'WITH_NATIVE_CURRENCY',
      outputFormat: 'json',
    });

    expect(result.structuredContent.handoff).toMatchObject({
      walletSelector: {
        walletId: 'MAINNET',
        senderAddress: '0x1111111111111111111111111111111111111111',
        chainFamily: 'EVM',
        chainSymbol: 'ETH',
      },
    });
  });

  test('create_bridge_execution_job without approval returns a single step with explicit handoff metadata', async () => {
    const sourceToken = createToken({
      symbol: 'USDC',
      name: 'USD Coin',
      decimals: 6,
      tokenAddress: '0xusdc-eth',
    });
    const destinationToken = createToken({
      symbol: 'USDC',
      name: 'USD Coin',
      decimals: 6,
      tokenAddress: '0xusdc-sol',
      chainSymbol: 'SOL',
      chainName: 'Solana',
      chainType: 'SOLANA',
    });

    client.getTokens.mockResolvedValue([sourceToken, destinationToken]);
    client.checkBridgeAllowance.mockResolvedValue(true);
    client.buildBridgeTx.mockResolvedValue({
      from: '0x1111111111111111111111111111111111111111',
      to: '0xbridge',
      data: '0xbridge-data',
      value: '0',
    });

    const result = await server.getHandler('create_bridge_execution_job')({
      sourceTokenAddress: sourceToken.tokenAddress,
      destinationTokenAddress: destinationToken.tokenAddress,
      senderAddress: '0x1111111111111111111111111111111111111111',
      recipientAddress: '11111111111111111111111111111111',
      amount: '1',
      amountUnit: 'human',
      messenger: 'ALLBRIDGE',
      feePaymentMethod: 'WITH_NATIVE_CURRENCY',
      outputFormat: 'json',
    });

    expect(client.buildBridgeApproveTx).not.toHaveBeenCalled();
    expect(result.structuredContent).toMatchObject({
      kind: 'bridge_transfer',
      version: 'v1',
      mode: 'external_signer',
      status: 'awaiting_signature',
      handoff: {
        executionTarget: 'local-signer-mcp',
        executionTool: 'sign_and_broadcast_transaction',
        executionAction: 'sign_and_broadcast',
        broadcastTarget: 'allbridge-mcp',
        broadcastTool: 'broadcast_signed_transaction',
        broadcastAction: 'broadcast',
        walletSelector: {
          walletId: null,
          senderAddress: '0x1111111111111111111111111111111111111111',
          chainFamily: 'EVM',
          chainSymbol: 'ETH',
        },
        stepId: 'bridge',
        transactionShape: 'object',
        stepCount: 1,
        stepIds: ['bridge'],
      },
      steps: [
        {
          id: 'bridge',
          order: 1,
          type: 'sign_and_submit_transaction',
          status: 'awaiting_signature',
          required: true,
          handoff: {
            executionTarget: 'local-signer-mcp',
            executionTool: 'sign_and_broadcast_transaction',
            executionAction: 'sign_and_broadcast',
            broadcastTarget: 'allbridge-mcp',
            broadcastTool: 'broadcast_signed_transaction',
            broadcastAction: 'broadcast',
            walletSelector: {
              walletId: null,
              senderAddress: '0x1111111111111111111111111111111111111111',
              chainFamily: 'EVM',
              chainSymbol: 'ETH',
            },
            stepId: 'bridge',
            transactionShape: 'object',
            nextStepId: 'track_transfer',
          },
          nextOnSuccess: 'track_transfer',
        },
      ],
      nextAction: 'Send the bridge step to local-signer-mcp for EVM or broadcast the signed bridge step with allbridge-mcp.',
    });
  });

  test('get_transfer_status returns summarized transfer fields', async () => {
    client.getTokens.mockResolvedValue([
      createToken({
        symbol: 'USDC',
        tokenAddress: '0xeth-usdc',
        chainSymbol: 'ETH',
      }),
      createToken({
        symbol: 'USDC',
        tokenAddress: 'sol-usdc',
        chainSymbol: 'SOL',
        chainName: 'Solana',
        chainType: 'SOLANA',
      }),
    ]);
    client.getTransferStatus.mockResolvedValue({
      txId: '0xtx',
      sourceChainSymbol: 'ETH',
      destinationChainSymbol: 'SOL',
      sendAmount: '1000000',
      sendAmountFormatted: 1,
      signaturesCount: 2,
      signaturesNeeded: 5,
      responseTime: 300000,
      send: {
        txId: '0xtx',
      },
      receive: {
        txId: '0xreceive',
      },
      extraField: 'ignored',
    });

    const result = await server.getHandler('get_transfer_status')({
      sourceChain: 'ETH',
      txId: '0xtx',
    });

    expect(client.getTransferStatus).toHaveBeenCalledWith({
      chain: 'ETH',
      txId: '0xtx',
    });
    expect(result.structuredContent).toEqual({
      txId: '0xtx',
      sourceChainSymbol: 'ETH',
      destinationChainSymbol: 'SOL',
      sendAmount: '1000000',
      sendAmountFormatted: 1,
      signaturesCount: 2,
      signaturesNeeded: 5,
      responseTime: 300000,
      send: {
        txId: '0xtx',
      },
      receive: {
        txId: '0xreceive',
      },
      historyUrl: 'https://core.allbridge.io/history/ETH/0xtx',
    });
  });

  test('search_allbridge_transfers returns explorer matches for an address query', async () => {
    explorerClient.search.mockResolvedValue([
      {
        chainSymbol: 'SOL',
        itemType: 'Address',
        value: 'Dr7ZcDCLAFFsZkYJpzdKfQSb4r2sEiMKZLXCN4mqe92D',
      },
    ]);
    explorerClient.listTransfers.mockResolvedValue({
      items: [
        {
          transferId: '0xde477a5db37e3cfeb35aaa7c3f68da3dfe5c5034966d19c89c5a7b10c981e76d',
          fromChainSymbol: 'SOL',
          toChainSymbol: 'ARB',
          fromAddress: 'Dr7ZcDCLAFFsZkYJpzdKfQSb4r2sEiMKZLXCN4mqe92D',
          toAddress: '7Qb5cT5E4Nw7iTg4W4k5m9d3x1Yy2Zz3AaBbCcDdEeF',
          fromAmount: '15551.476689',
          sendTransactionHash: '0xsource',
          messagingTransactionHash: '0xmessage',
          receiveTransactionHash: '0xreceive',
          status: 'complete',
          timestamp: 1776637313000,
        },
      ],
    });

    const result = await server.getHandler('search_allbridge_transfers')({
      query: 'Dr7ZcDCLAFFsZkYJpzdKfQSb4r2sEiMKZLXCN4mqe92D',
      limit: 10,
    });

    expect(explorerClient.search).toHaveBeenCalledWith('Dr7ZcDCLAFFsZkYJpzdKfQSb4r2sEiMKZLXCN4mqe92D');
    expect(explorerClient.listTransfers).toHaveBeenCalledWith({
      account: 'Dr7ZcDCLAFFsZkYJpzdKfQSb4r2sEiMKZLXCN4mqe92D',
      page: 1,
      limit: 10,
    });
    expect(result.structuredContent).toMatchObject({
      mode: 'search',
      query: 'Dr7ZcDCLAFFsZkYJpzdKfQSb4r2sEiMKZLXCN4mqe92D',
      searchMatchCount: 1,
      searchMatches: [
        {
          chainSymbol: 'SOL',
          itemType: 'Address',
          value: 'Dr7ZcDCLAFFsZkYJpzdKfQSb4r2sEiMKZLXCN4mqe92D',
        },
      ],
      resolvedBy: ['address'],
      resultCount: 1,
      results: [
        {
          transferId: '0xde477a5db37e3cfeb35aaa7c3f68da3dfe5c5034966d19c89c5a7b10c981e76d',
          sourceChainSymbol: 'SOL',
          destinationChainSymbol: 'ARB',
          senderAddress: 'Dr7ZcDCLAFFsZkYJpzdKfQSb4r2sEiMKZLXCN4mqe92D',
          recipientAddress: '7Qb5cT5E4Nw7iTg4W4k5m9d3x1Yy2Zz3AaBbCcDdEeF',
          sourceTxId: '0xsource',
          messagingTxId: '0xmessage',
          receiveTxId: '0xreceive',
          amount: '15551.476689',
          status: 'complete',
          createdAt: '1776637313000',
          historyUrl: 'https://core.allbridge.io/history/SOL/0xsource',
          explorerUrl: 'https://explorer.api.allbridgecoreapi.net/transfers/0xde477a5db37e3cfeb35aaa7c3f68da3dfe5c5034966d19c89c5a7b10c981e76d',
        },
      ],
    });
    expect((result.structuredContent.results as Array<Record<string, unknown>>)[0].matchTypes).toContain('senderAddress');
  });

  test('search_allbridge_transfers lists transfers by direct filters without query search', async () => {
    client.getTokens.mockResolvedValue([
      createToken({
        symbol: 'USDC',
        chainSymbol: 'SOL',
        chainName: 'Solana',
        chainType: 'SOLANA',
      }),
      createToken({
        symbol: 'USDC',
        chainSymbol: 'ARB',
        chainName: 'Arbitrum',
        chainType: 'EVM',
      }),
    ]);
    explorerClient.listTransfers.mockResolvedValue({
      items: [
        {
          transferId: '0xtransfer',
          fromChainSymbol: 'SOL',
          toChainSymbol: 'ARB',
          fromAddress: '9solAddress',
          toAddress: '0xarbAddress',
          fromAmount: '15551.476689',
          sendTransactionHash: '0xsource',
          status: 'complete',
        },
      ],
    });

    const result = await server.getHandler('search_allbridge_transfers')({
      account: '9solAddress',
      chain: 'Solana',
      from: undefined,
      to: undefined,
      status: 'complete',
      minFromAmount: 15000,
      limit: 10,
      page: 2,
    });

    expect(explorerClient.listTransfers).toHaveBeenCalledWith({
      account: '9solAddress',
      chain: 'SOL',
      from: undefined,
      to: undefined,
      minFromAmount: 15000,
      maxFromAmount: undefined,
      status: 'Complete',
      page: 2,
      limit: 10,
    });
    expect(result.structuredContent).toMatchObject({
      mode: 'recent',
      query: null,
      appliedFilters: {
        account: '9solAddress',
        chain: 'SOL',
        minFromAmount: 15000,
        status: 'Complete',
        page: 2,
        limit: 10,
      },
      searchMatchCount: 0,
      resultCount: 1,
      results: [
        {
          transferId: '0xtransfer',
          sourceChainSymbol: 'SOL',
          destinationChainSymbol: 'ARB',
          senderAddress: '9solAddress',
          recipientAddress: '0xarbAddress',
          sourceTxId: '0xsource',
          amount: '15551.476689',
          status: 'complete',
          explorerUrl: 'https://explorer.api.allbridgecoreapi.net/transfers/0xtransfer',
        },
      ],
    });
  });

  test('search_allbridge_transfers lists transfers by direction filters', async () => {
    client.getTokens.mockResolvedValue([
      createToken({
        symbol: 'USDC',
        chainSymbol: 'SOL',
        chainName: 'Solana',
        chainType: 'SOLANA',
      }),
      createToken({
        symbol: 'USDC',
        chainSymbol: 'ARB',
        chainName: 'Arbitrum',
        chainType: 'EVM',
      }),
    ]);
    explorerClient.listTransfers.mockResolvedValue({
      items: [
        {
          transferId: '0xtransfer',
          fromChainSymbol: 'SOL',
          toChainSymbol: 'ARB',
          fromAddress: '9solAddress',
          toAddress: '0xarbAddress',
          fromAmount: '15551.476689',
          sendTransactionHash: '0xsource',
          receiveTransactionHash: '0xreceive',
          status: 'complete',
        },
      ],
    });

    const result = await server.getHandler('search_allbridge_transfers')({
      from: 'Solana',
      to: 'Arbitrum',
      limit: 10,
    });

    expect(explorerClient.listTransfers).toHaveBeenCalledWith({
      account: undefined,
      chain: undefined,
      from: 'SOL',
      to: 'ARB',
      minFromAmount: undefined,
      maxFromAmount: undefined,
      status: undefined,
      page: 1,
      limit: 10,
    });
    expect(result.structuredContent).toMatchObject({
      mode: 'recent',
      query: null,
      appliedFilters: {
        from: 'SOL',
        to: 'ARB',
        page: 1,
        limit: 10,
      },
      searchMatchCount: 0,
      resultCount: 1,
      results: [
        {
          transferId: '0xtransfer',
          sourceChainSymbol: 'SOL',
          destinationChainSymbol: 'ARB',
          senderAddress: '9solAddress',
          recipientAddress: '0xarbAddress',
          sourceTxId: '0xsource',
          receiveTxId: '0xreceive',
          amount: '15551.476689',
          status: 'complete',
          explorerUrl: 'https://explorer.api.allbridgecoreapi.net/transfers/0xtransfer',
        },
      ],
    });
  });

  test('search_allbridge_transfers rejects query search combined with direct filters', async () => {
    const result = await server.getHandler('search_allbridge_transfers')({
      query: 'Dr7ZcDCLAFFsZkYJpzdKfQSb4r2sEiMKZLXCN4mqe92D',
      account: '9solAddress',
      limit: 10,
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      ok: false,
      error: {
        code: 'validation_error',
      },
    });
  });

  test('search_allbridge_transfers rejects chain combined with from or to', async () => {
    const result = await server.getHandler('search_allbridge_transfers')({
      chain: 'ETH',
      from: 'SOL',
      limit: 10,
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      ok: false,
      error: {
        code: 'validation_error',
      },
    });
  });

  test('search_allbridge_transfers lists recent transfers when query is omitted', async () => {
    explorerClient.listTransfers.mockResolvedValue({
      items: [
        {
          id: '0xde477a5db37e3cfeb35aaa7c3f68da3dfe5c5034966d19c89c5a7b10c981e76d',
          senderAddress: 'Dr7ZcDCLAFFsZkYJpzdKfQSb4r2sEiMKZLXCN4mqe92D',
          status: 'completed',
        },
      ],
    });

    const result = await server.getHandler('search_allbridge_transfers')({
      limit: 10,
    });

    expect(explorerClient.listTransfers).toHaveBeenCalledWith({
      page: 1,
      limit: 10,
    });
    expect(result.structuredContent).toMatchObject({
      mode: 'recent',
      query: null,
      searchMatchCount: 0,
      searchMatches: [],
      resolvedBy: [],
      resultCount: 1,
      results: [
        {
          transferId: '0xde477a5db37e3cfeb35aaa7c3f68da3dfe5c5034966d19c89c5a7b10c981e76d',
          senderAddress: 'Dr7ZcDCLAFFsZkYJpzdKfQSb4r2sEiMKZLXCN4mqe92D',
          status: 'completed',
          explorerUrl: 'https://explorer.api.allbridgecoreapi.net/transfers/0xde477a5db37e3cfeb35aaa7c3f68da3dfe5c5034966d19c89c5a7b10c981e76d',
        },
      ],
    });
  });

  test('search_allbridge_transfers resolves a transfer hash through the explorer search index', async () => {
    explorerClient.search.mockResolvedValue([
      {
        chainSymbol: '',
        itemType: 'Transfer',
        value: '0xde477a5db37e3cfeb35aaa7c3f68da3dfe5c5034966d19c89c5a7b10c981e76d',
      },
    ]);
    explorerClient.getTransfer.mockResolvedValue({
      transfer: {
        id: '0xde477a5db37e3cfeb35aaa7c3f68da3dfe5c5034966d19c89c5a7b10c981e76d',
        fromChainSymbol: 'SOL',
        toChainSymbol: 'ARB',
        fromAddress: 'Dr7ZcDCLAFFsZkYJpzdKfQSb4r2sEiMKZLXCN4mqe92D',
        toAddress: '7Qb5cT5E4Nw7iTg4W4k5m9d3x1Yy2Zz3AaBbCcDdEeF',
        fromAmount: '15551.476689',
        sendTransactionHash: '3MjCur95HKzhud2ubxtumHn8HuQNwtPkVS9nyyMc8UyN5Md6T1tGMUwB3tfvWhiBT6YBDCJnvdGfznF8spxwRWS5',
        receiveTransactionHash: '0xreceive',
        status: 'completed',
      },
    });

    const result = await server.getHandler('search_allbridge_transfers')({
      query: '3MjCur95HKzhud2ubxtumHn8HuQNwtPkVS9nyyMc8UyN5Md6T1tGMUwB3tfvWhiBT6YBDCJnvdGfznF8spxwRWS5',
      limit: 10,
    });

    expect(explorerClient.search).toHaveBeenCalledWith('3MjCur95HKzhud2ubxtumHn8HuQNwtPkVS9nyyMc8UyN5Md6T1tGMUwB3tfvWhiBT6YBDCJnvdGfznF8spxwRWS5');
    expect(explorerClient.getTransfer).toHaveBeenCalledWith('0xde477a5db37e3cfeb35aaa7c3f68da3dfe5c5034966d19c89c5a7b10c981e76d');
    expect(result.structuredContent).toMatchObject({
      mode: 'search',
      query: '3MjCur95HKzhud2ubxtumHn8HuQNwtPkVS9nyyMc8UyN5Md6T1tGMUwB3tfvWhiBT6YBDCJnvdGfznF8spxwRWS5',
      searchMatchCount: 1,
      searchMatches: [
        {
          chainSymbol: '',
          itemType: 'Transfer',
          value: '0xde477a5db37e3cfeb35aaa7c3f68da3dfe5c5034966d19c89c5a7b10c981e76d',
        },
      ],
      resolvedBy: ['transfer'],
      resultCount: 1,
      results: [
        {
          transferId: '0xde477a5db37e3cfeb35aaa7c3f68da3dfe5c5034966d19c89c5a7b10c981e76d',
          sourceChainSymbol: 'SOL',
          destinationChainSymbol: 'ARB',
          senderAddress: 'Dr7ZcDCLAFFsZkYJpzdKfQSb4r2sEiMKZLXCN4mqe92D',
          recipientAddress: '7Qb5cT5E4Nw7iTg4W4k5m9d3x1Yy2Zz3AaBbCcDdEeF',
          sourceTxId: '3MjCur95HKzhud2ubxtumHn8HuQNwtPkVS9nyyMc8UyN5Md6T1tGMUwB3tfvWhiBT6YBDCJnvdGfznF8spxwRWS5',
          receiveTxId: '0xreceive',
          amount: '15551.476689',
          status: 'completed',
          historyUrl: 'https://core.allbridge.io/history/SOL/3MjCur95HKzhud2ubxtumHn8HuQNwtPkVS9nyyMc8UyN5Md6T1tGMUwB3tfvWhiBT6YBDCJnvdGfznF8spxwRWS5',
          explorerUrl: 'https://explorer.api.allbridgecoreapi.net/transfers/0xde477a5db37e3cfeb35aaa7c3f68da3dfe5c5034966d19c89c5a7b10c981e76d',
        },
      ],
    });
    expect((result.structuredContent.results as Array<Record<string, unknown>>)[0].matchTypes).toContain('sourceTxId');
  });

  test('get_allbridge_transfer returns a single explorer transfer with raw details', async () => {
    explorerClient.getTransfer.mockResolvedValue({
      transfer: {
        id: '0xde477a5db37e3cfeb35aaa7c3f68da3dfe5c5034966d19c89c5a7b10c981e76d',
        fromChainSymbol: 'ETH',
        toChainSymbol: 'ARB',
        fromAddress: 'Dr7ZcDCLAFFsZkYJpzdKfQSb4r2sEiMKZLXCN4mqe92D',
        toAddress: '7Qb5cT5E4Nw7iTg4W4k5m9d3x1Yy2Zz3AaBbCcDdEeF',
        fromAmount: '1',
        sendTransactionHash: '0xsource',
        receiveTransactionHash: '0xreceive',
        status: 'completed',
      },
    });

    const result = await server.getHandler('get_allbridge_transfer')({
      transferId: '0xde477a5db37e3cfeb35aaa7c3f68da3dfe5c5034966d19c89c5a7b10c981e76d',
    });

    expect(explorerClient.getTransfer).toHaveBeenCalledWith('0xde477a5db37e3cfeb35aaa7c3f68da3dfe5c5034966d19c89c5a7b10c981e76d');
    expect(result.structuredContent.transfer).toMatchObject({
      transferId: '0xde477a5db37e3cfeb35aaa7c3f68da3dfe5c5034966d19c89c5a7b10c981e76d',
      sourceChainSymbol: 'ETH',
      destinationChainSymbol: 'ARB',
      senderAddress: 'Dr7ZcDCLAFFsZkYJpzdKfQSb4r2sEiMKZLXCN4mqe92D',
      recipientAddress: '7Qb5cT5E4Nw7iTg4W4k5m9d3x1Yy2Zz3AaBbCcDdEeF',
      sourceTxId: '0xsource',
      receiveTxId: '0xreceive',
      amount: '1',
      status: 'completed',
      historyUrl: 'https://core.allbridge.io/history/ETH/0xsource',
      explorerUrl: 'https://explorer.api.allbridgecoreapi.net/transfers/0xde477a5db37e3cfeb35aaa7c3f68da3dfe5c5034966d19c89c5a7b10c981e76d',
    });
    expect((result.structuredContent.transfer as Record<string, unknown>).raw).toMatchObject({
      id: '0xde477a5db37e3cfeb35aaa7c3f68da3dfe5c5034966d19c89c5a7b10c981e76d',
    });
  });

  test('list_supported_chains returns normalized chain aliases', async () => {
    client.getTokens.mockResolvedValue([
      createToken({
        symbol: 'USDT',
        tokenAddress: '0xeth-usdt',
        chainSymbol: 'ETH',
        chainName: 'Ethereum',
      }),
      createToken({
        symbol: 'USDT',
        tokenAddress: 'trx-usdt',
        chainSymbol: 'TRX',
        chainName: 'Tron',
        chainType: 'TRX',
      }),
    ]);

    const result = await server.getHandler('list_supported_chains')({
      tokenType: 'swap',
    });

    expect(result.structuredContent).toEqual({
      tokenType: 'swap',
      chains: [
        {
          chainSymbol: 'ETH',
          chainName: 'Ethereum',
          chainType: 'EVM',
          tokenCount: 1,
          aliases: ['ETH', 'Ethereum', 'EVM'],
        },
        {
          chainSymbol: 'TRX',
          chainName: 'Tron',
          chainType: 'TRX',
          tokenCount: 1,
          aliases: ['TRX', 'Tron'],
        },
      ],
      nextAction: 'Use one of the returned chainSymbol values or aliases in plan_bridge_transfer and find_bridge_routes.',
    });
  });

  test('plan_bridge_transfer accepts common chain aliases like Tron and Ethereum', async () => {
    client.getTokens.mockResolvedValue([
      createToken({
        symbol: 'USDT',
        name: 'Tether USD',
        tokenAddress: 'trx-usdt',
        chainSymbol: 'TRX',
        chainName: 'Tron',
        chainType: 'TRX',
      }),
      createToken({
        symbol: 'USDT',
        name: 'Tether USD',
        tokenAddress: 'eth-usdt',
        chainSymbol: 'ETH',
        chainName: 'Ethereum',
        chainType: 'EVM',
        cctpAddress: 'eth-cctp',
      }),
    ]);
    client.getBridgeQuote.mockResolvedValue({
      amountInt: '100000000',
      amountFloat: '100',
      sourceTokenAddress: 'trx-usdt',
      destinationTokenAddress: 'eth-usdt',
      options: [],
    });

    const result = await server.getHandler('plan_bridge_transfer')({
      sourceChain: 'Tron',
      destinationChain: 'Ethereum',
      amount: '100',
      amountUnit: 'human',
      tokenType: 'swap',
      sourceTokenSymbol: 'USDT',
      destinationTokenSymbol: 'USDT',
    });

    expect(result.structuredContent).toMatchObject({
      route: {
        source: {
          chainSymbol: 'TRX',
        },
        destination: {
          chainSymbol: 'ETH',
        },
      },
      amount: {
        amountInBaseUnits: '100000000',
        amountInHumanUnits: '100',
      },
    });
  });

  test('plan_bridge_transfer returns a structured error when destination chain is missing', async () => {
    client.getTokens.mockResolvedValue([
      createToken({
        symbol: 'USDT',
        tokenAddress: 'trx-usdt',
        chainSymbol: 'TRX',
        chainName: 'Tron',
        chainType: 'TRX',
      }),
    ]);

    const result = await server.getHandler('plan_bridge_transfer')({
      sourceChain: 'Tron',
      destinationChain: null,
      amount: '100',
      amountUnit: 'human',
      tokenType: 'swap',
      sourceTokenSymbol: 'USDT',
      destinationTokenSymbol: 'USDT',
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      ok: false,
      error: {
        code: 'missing_input',
      },
    });
  });

  test('plan_bridge_transfer reports symbol field names in missing-input errors', async () => {
    client.getTokens.mockResolvedValue([
      createToken({
        symbol: 'USDT',
        tokenAddress: 'eth-usdt',
        chainSymbol: 'ETH',
        chainName: 'Ethereum',
        chainType: 'EVM',
      }),
    ]);

    const result = await server.getHandler('plan_bridge_transfer')({
      sourceChain: 'Ethereum',
      destinationChain: 'Tron',
      amount: '100',
      amountUnit: 'human',
      tokenType: 'swap',
      destinationTokenSymbol: 'USDT',
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      ok: false,
      error: {
        code: 'missing_input',
        message: 'sourceTokenSymbol is required.',
        details: {
          field: 'sourceTokenSymbol',
        },
        },
      });
  });

  test('find_bridge_routes reports symbol field names for destination token lookup errors', async () => {
    client.getTokens.mockResolvedValue([
      createToken({
        symbol: 'USDT',
        tokenAddress: 'eth-usdt',
        chainSymbol: 'ETH',
        chainName: 'Ethereum',
        chainType: 'EVM',
      }),
      createToken({
        symbol: 'USDT',
        tokenAddress: 'trx-usdt',
        chainSymbol: 'TRX',
        chainName: 'Tron',
        chainType: 'TRX',
      }),
    ]);

    const result = await server.getHandler('find_bridge_routes')({
      sourceChain: 'Ethereum',
      destinationChain: 'Tron',
      sourceTokenSymbol: 'USDT',
      destinationTokenSymbol: 'USDC',
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      ok: false,
      error: {
        code: 'unsupported_token',
        message: 'Token USDC is not available on TRX.',
        details: {
          field: 'destinationTokenSymbol',
        },
      },
    });
  });

  test('quote_bridge_transfer reports symbol in invalid amount errors', async () => {
    const sourceToken = createToken({
      symbol: 'USDC',
      tokenAddress: '0xeth-usdc',
      chainSymbol: 'ETH',
      chainName: 'Ethereum',
      chainType: 'EVM',
    });
    const destinationToken = createToken({
      symbol: 'USDC',
      tokenAddress: '0xsol-usdc',
      chainSymbol: 'SOL',
      chainName: 'Solana',
      chainType: 'SOLANA',
    });

    client.getTokens.mockResolvedValue([sourceToken, destinationToken]);

    const result = await server.getHandler('quote_bridge_transfer')({
      sourceTokenAddress: sourceToken.tokenAddress,
      destinationTokenAddress: destinationToken.tokenAddress,
      amount: 'not-a-number',
      amountUnit: 'human',
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      ok: false,
      error: {
        code: 'invalid_amount',
        details: {
          symbol: 'USDC',
          tokenAddress: '0xeth-usdc',
        },
      },
    });
  });

  test('plan_bridge_transfer reports symbol in invalid amount errors', async () => {
    const sourceToken = createToken({
      symbol: 'USDT',
      tokenAddress: 'eth-usdt',
      chainSymbol: 'ETH',
      chainName: 'Ethereum',
      chainType: 'EVM',
    });
    const destinationToken = createToken({
      symbol: 'USDT',
      tokenAddress: 'trx-usdt',
      chainSymbol: 'TRX',
      chainName: 'Tron',
      chainType: 'TRX',
    });

    client.getTokens.mockResolvedValue([sourceToken, destinationToken]);

    const result = await server.getHandler('plan_bridge_transfer')({
      sourceChain: 'Ethereum',
      destinationChain: 'Tron',
      amount: 'not-a-number',
      amountUnit: 'human',
      tokenType: 'swap',
      sourceTokenSymbol: 'USDT',
      destinationTokenSymbol: 'USDT',
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      ok: false,
      error: {
        code: 'invalid_amount',
        details: {
          symbol: 'USDT',
          tokenAddress: 'eth-usdt',
        },
      },
    });
  });

  test.each([
    {
      chainFamily: 'EVM' as const,
      payload: {
        chainFamily: 'EVM' as const,
        chainId: 11155111,
        chainSymbol: 'ETH',
        walletId: 'MAINNET',
        signedTransaction: '0xdeadbeef',
      },
      receipt: {
        blockNumber: 12,
        status: 1,
        gasUsed: '21000',
      },
    },
    {
      chainFamily: 'SOLANA' as const,
      payload: {
        chainFamily: 'SOLANA' as const,
        walletId: 'ALPHA',
        signedTransactionHex: 'abcdef',
      },
      receipt: null,
    },
    {
      chainFamily: 'TRX' as const,
      payload: {
        chainFamily: 'TRX' as const,
        walletId: 'BETA',
        signedTransaction: { signature: ['sig'] },
      },
      receipt: null,
    },
    {
      chainFamily: 'ALG' as const,
      payload: {
        chainFamily: 'ALG' as const,
        walletId: 'GAMMA',
        signedTransactionsBase64: ['c2lnbmVkLWFsZw=='],
      },
      receipt: null,
    },
    {
      chainFamily: 'STX' as const,
      payload: {
        chainFamily: 'STX' as const,
        walletId: 'DELTA',
        signedTransactionHex: 'abcdef',
      },
      receipt: null,
    },
    {
      chainFamily: 'SRB' as const,
      payload: {
        chainFamily: 'SRB' as const,
        walletId: 'EPSILON',
        signedTransactionXdr: 'AAAA',
      },
      receipt: null,
    },
    {
      chainFamily: 'SUI' as const,
      payload: {
        chainFamily: 'SUI' as const,
        walletId: 'ZETA',
        signedTransaction: {
          bytesBase64: 'Ynll',
          signature: 'signature',
        },
      },
      receipt: {
        digest: 'sui-digest',
      },
    },
  ])('broadcast_signed_transaction returns the broadcast result for $chainFamily', async ({ payload, chainFamily, receipt }) => {
    dependencies.broadcastSignedTransactionByFamily.mockResolvedValue({
      chainFamily,
      txHash: `${chainFamily.toLowerCase()}-tx`,
      receipt,
    });

    const result = await server.getHandler('broadcast_signed_transaction')(payload as Record<string, unknown>);

    expect(dependencies.broadcastSignedTransactionByFamily).toHaveBeenCalledWith(payload);
    expect(result.structuredContent).toEqual({
      chainFamily,
      txHash: `${chainFamily.toLowerCase()}-tx`,
      receipt,
    });
  });
});
