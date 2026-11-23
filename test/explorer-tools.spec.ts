import { beforeEach, describe, expect, test } from '@jest/globals';

import { createToken, setupTools } from './support/fixtures.js';

describe('explorer tools', () => {
  let server: ReturnType<typeof setupTools>['server'];
  let gateway: ReturnType<typeof setupTools>['gateway'];
  let explorer: ReturnType<typeof setupTools>['explorer'];

  beforeEach(() => {
    ({ server, gateway, explorer } = setupTools());
  });

  test('search_allbridge_transfers returns explorer matches for an address query', async () => {
    explorer.search.mockResolvedValue([
      {
        chainSymbol: 'SOL',
        itemType: 'Address',
        value: 'Dr7ZcDCLAFFsZkYJpzdKfQSb4r2sEiMKZLXCN4mqe92D',
      },
    ]);
    explorer.listTransfers.mockResolvedValue({
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

    const result = await server.handlers.get('search_allbridge_transfers')!({
      query: 'Dr7ZcDCLAFFsZkYJpzdKfQSb4r2sEiMKZLXCN4mqe92D',
      limit: 10,
    });

    expect(explorer.search).toHaveBeenCalledWith('Dr7ZcDCLAFFsZkYJpzdKfQSb4r2sEiMKZLXCN4mqe92D');
    expect(explorer.listTransfers).toHaveBeenCalledWith({
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
          explorerUrl: 'https://api.core.allbridge.io/transfers/0xde477a5db37e3cfeb35aaa7c3f68da3dfe5c5034966d19c89c5a7b10c981e76d',
        },
      ],
    });
    expect((result.structuredContent.results as Array<Record<string, unknown>>)[0]?.matchTypes).toContain('senderAddress');
  });

  test('search_allbridge_transfers lists transfers by direct filters without query search', async () => {
    gateway.getTokens.mockResolvedValue([
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
    explorer.listTransfers.mockResolvedValue({
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

    const result = await server.handlers.get('search_allbridge_transfers')!({
      account: '9solAddress',
      chain: 'Solana',
      from: undefined,
      to: undefined,
      status: 'complete',
      minFromAmount: 15000,
      limit: 10,
      page: 2,
    });

    expect(explorer.listTransfers).toHaveBeenCalledWith({
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
          explorerUrl: 'https://api.core.allbridge.io/transfers/0xtransfer',
        },
      ],
    });
  });

  test('search_allbridge_transfers lists transfers by direction filters', async () => {
    gateway.getTokens.mockResolvedValue([
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
    explorer.listTransfers.mockResolvedValue({
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

    const result = await server.handlers.get('search_allbridge_transfers')!({
      from: 'Solana',
      to: 'Arbitrum',
      limit: 10,
    });

    expect(explorer.listTransfers).toHaveBeenCalledWith({
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
          explorerUrl: 'https://api.core.allbridge.io/transfers/0xtransfer',
        },
      ],
    });
  });

  test('search_allbridge_transfers rejects query search combined with direct filters', async () => {
    const result = await server.handlers.get('search_allbridge_transfers')!({
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
    const result = await server.handlers.get('search_allbridge_transfers')!({
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
    explorer.listTransfers.mockResolvedValue({
      items: [
        {
          id: '0xde477a5db37e3cfeb35aaa7c3f68da3dfe5c5034966d19c89c5a7b10c981e76d',
          senderAddress: 'Dr7ZcDCLAFFsZkYJpzdKfQSb4r2sEiMKZLXCN4mqe92D',
          status: 'completed',
        },
      ],
    });

    const result = await server.handlers.get('search_allbridge_transfers')!({
      limit: 10,
    });

    expect(explorer.listTransfers).toHaveBeenCalledWith({
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
          explorerUrl: 'https://api.core.allbridge.io/transfers/0xde477a5db37e3cfeb35aaa7c3f68da3dfe5c5034966d19c89c5a7b10c981e76d',
        },
      ],
    });
  });

  test('search_allbridge_transfers resolves a transfer hash through the explorer search index', async () => {
    explorer.search.mockResolvedValue([
      {
        chainSymbol: '',
        itemType: 'Transfer',
        value: '0xde477a5db37e3cfeb35aaa7c3f68da3dfe5c5034966d19c89c5a7b10c981e76d',
      },
    ]);
    explorer.getTransfer.mockResolvedValue({
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

    const result = await server.handlers.get('search_allbridge_transfers')!({
      query: '3MjCur95HKzhud2ubxtumHn8HuQNwtPkVS9nyyMc8UyN5Md6T1tGMUwB3tfvWhiBT6YBDCJnvdGfznF8spxwRWS5',
      limit: 10,
    });

    expect(explorer.search).toHaveBeenCalledWith('3MjCur95HKzhud2ubxtumHn8HuQNwtPkVS9nyyMc8UyN5Md6T1tGMUwB3tfvWhiBT6YBDCJnvdGfznF8spxwRWS5');
    expect(explorer.getTransfer).toHaveBeenCalledWith('0xde477a5db37e3cfeb35aaa7c3f68da3dfe5c5034966d19c89c5a7b10c981e76d');
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
          explorerUrl: 'https://api.core.allbridge.io/transfers/0xde477a5db37e3cfeb35aaa7c3f68da3dfe5c5034966d19c89c5a7b10c981e76d',
        },
      ],
    });
    expect((result.structuredContent.results as Array<Record<string, unknown>>)[0]?.matchTypes).toContain('sourceTxId');
  });

  test('get_allbridge_transfer returns a single explorer transfer with raw details', async () => {
    explorer.getTransfer.mockResolvedValue({
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

    const result = await server.handlers.get('get_allbridge_transfer')!({
      transferId: '0xde477a5db37e3cfeb35aaa7c3f68da3dfe5c5034966d19c89c5a7b10c981e76d',
    });

    expect(explorer.getTransfer).toHaveBeenCalledWith('0xde477a5db37e3cfeb35aaa7c3f68da3dfe5c5034966d19c89c5a7b10c981e76d');
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
      explorerUrl: 'https://api.core.allbridge.io/transfers/0xde477a5db37e3cfeb35aaa7c3f68da3dfe5c5034966d19c89c5a7b10c981e76d',
    });
    expect((result.structuredContent.transfer as Record<string, unknown>).raw).toMatchObject({
      id: '0xde477a5db37e3cfeb35aaa7c3f68da3dfe5c5034966d19c89c5a7b10c981e76d',
    });
  });
});
