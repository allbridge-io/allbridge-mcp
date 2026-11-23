import { jest } from '@jest/globals';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { CoreGateway, CoreToken } from '../../src/core-gateway.js';
import type { AllbridgeExplorerApiClient } from '../../src/explorer-api-client.js';
import { createToolContext, registerAllbridgeTools } from '../../src/tools/index.js';

export const EXPLORER_BASE_URL = 'https://api.core.allbridge.io';

export type ToolHandler = (args: Record<string, unknown>) => Promise<{
  structuredContent: Record<string, unknown>;
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}>;

export class FakeMcpServer {
  readonly handlers = new Map<string, ToolHandler>();
  readonly definitions = new Map<string, { inputSchema?: Record<string, unknown> }>();

  registerTool(name: string, definition: unknown, handler: unknown): void {
    this.definitions.set(name, definition as { inputSchema?: Record<string, unknown> });
    this.handlers.set(name, handler as ToolHandler);
  }

  call(name: string, args: Record<string, unknown>) {
    const handler = this.handlers.get(name);
    if (!handler) {
      throw new Error(`Tool ${name} is not registered.`);
    }
    return handler(args);
  }
}

export function createToken(overrides: Partial<CoreToken> & Record<string, unknown> = {}): CoreToken {
  return {
    symbol: 'USDC',
    name: 'USD Coin',
    decimals: 6,
    tokenAddress: '0x' + 'a'.repeat(40),
    chainSymbol: 'ETH',
    chainName: 'Ethereum',
    chainType: 'EVM',
    chainId: '0x1',
    feeShare: '0',
    poolAddress: '',
    apr: '0',
    apr7d: '0',
    apr30d: '0',
    lpRate: '0',
    allbridgeChainId: 1,
    bridgeAddress: '',
    transferTime: {},
    txCostAmount: { maxAmount: '0', swap: '0', transfer: '0' },
    confirmations: 1,
    ...overrides,
  } as unknown as CoreToken;
}

export type GatewayMock = { [K in keyof CoreGateway]: jest.Mock<any> };

export function createGatewayMock(): GatewayMock {
  return {
    getTokens: jest.fn(),
    getAmountToBeReceivedAndGasFeeOptions: jest.fn(),
    getAmountToBeReceived: jest.fn(),
    getAverageTransferTime: jest.fn(() => 120000),
    getTokenBalance: jest.fn(),
    getNativeTokenBalance: jest.fn(),
    checkAllowance: jest.fn(),
    getAllowance: jest.fn(),
    buildApproveTransaction: jest.fn(),
    buildSendTransaction: jest.fn(),
    getNearIntentsQuote: jest.fn(),
    createNearIntentsDeposit: jest.fn(),
    submitNearIntentsDeposit: jest.fn(),
    getLifiIntentsQuote: jest.fn(),
    createLifiIntentsOrder: jest.fn(),
    getTransferStatus: jest.fn(),
    getStellarBalanceLine: jest.fn(),
    buildStellarTrustlineTransaction: jest.fn(),
    hasSolanaTokenAccount: jest.fn(),
  };
}

export type ExplorerMock = { [K in 'search' | 'listTransfers' | 'searchTransfers' | 'getTransfer']: jest.Mock<any> };

export function createExplorerMock(): ExplorerMock {
  return {
    search: jest.fn(),
    listTransfers: jest.fn(),
    searchTransfers: jest.fn(),
    getTransfer: jest.fn(),
  };
}

export function setupTools() {
  const server = new FakeMcpServer();
  const gateway = createGatewayMock();
  const explorer = createExplorerMock();
  const broadcastSignedTransactionByFamily = jest.fn<any>();

  registerAllbridgeTools(server as unknown as McpServer, createToolContext({
    gateway: gateway as unknown as CoreGateway,
    explorer: explorer as unknown as AllbridgeExplorerApiClient,
    explorerBaseUrl: EXPLORER_BASE_URL,
    broadcastSignedTransactionByFamily,
  }));

  return { server, gateway, explorer, broadcastSignedTransactionByFamily };
}

/** `getAmountToBeReceivedAndGasFeeOptions` result with fees given as [int, float] pairs. */
export function amountsAndFees(params: {
  send: string;
  receive: string;
  native?: [string, string];
  stablecoin?: [string, string];
  abr?: [string, string];
}) {
  const format = (pair?: [string, string]) => (pair ? { int: pair[0], float: pair[1] } : undefined);
  return {
    amountToSendFloat: params.send,
    amountToBeReceivedFloat: params.receive,
    gasFeeOptions: {
      native: format(params.native ?? ['1000000000000000', '0.001']),
      ...(params.stablecoin ? { stablecoin: format(params.stablecoin) } : {}),
      ...(params.abr ? { abr: format(params.abr) } : {}),
    },
  };
}

export const EVM_SENDER = '0x1111111111111111111111111111111111111111';
export const EVM_RECIPIENT = '0x2222222222222222222222222222222222222222';
export const SOL_ADDRESS = 'Dr7ZcDCLAFFsZkYJpzdKfQSb4r2sEiMKZLXCN4mqe92D';
export const TRX_ADDRESS = 'TQWBZNujuCrmXgDfdywwfaeUL14wKsrPQA';
export const STX_ADDRESS = 'SP2J6ZY48GV1EZ5V2V5RB9MP66SW86PYKKNRV9EJ7';
export const SRB_ADDRESS = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
