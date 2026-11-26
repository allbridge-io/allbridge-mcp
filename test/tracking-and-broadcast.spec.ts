import { beforeEach, describe, expect, test } from '@jest/globals';
import { AxiosError, AxiosHeaders } from 'axios';

import { createToken, setupTools, SRB_ADDRESS } from './support/fixtures.js';

const bscUsdt = createToken({ symbol: 'USDT', tokenAddress: '0xbsc-usdt', chainSymbol: 'BSC', chainName: 'BNB Chain', chainId: '0x38' });
const srbUsdc = createToken({ tokenAddress: 'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75', chainSymbol: 'SRB', chainName: 'Stellar', chainType: 'SRB' });
const srbXlm = createToken({ symbol: 'XLM', decimals: 7, tokenAddress: 'CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA', chainSymbol: 'SRB', chainName: 'Stellar', chainType: 'SRB', isNative: true });

function notFound(): AxiosError {
  const config = { headers: new AxiosHeaders() };
  return new AxiosError('Request failed with status code 404', 'ERR_BAD_REQUEST', config, null, {
    status: 404,
    statusText: 'Not Found',
    headers: {},
    config,
    data: { message: 'Not found' },
  });
}

describe('get_transfer_status', () => {
  let setup: ReturnType<typeof setupTools>;

  beforeEach(() => {
    setup = setupTools();
    setup.gateway.getTokens.mockResolvedValue([bscUsdt, srbUsdc, srbXlm]);
  });

  test('reports a delivered transfer as completed', async () => {
    setup.gateway.getTransferStatus.mockResolvedValue({
      txId: '0xsend',
      sourceChainSymbol: 'BSC',
      destinationChainSymbol: 'TRX',
      send: { txId: '0xsend' },
      receive: { txId: 'receive' },
    });

    const result = await setup.server.call('get_transfer_status', { sourceChain: 'bnb', txId: '0xsend' });

    expect(setup.gateway.getTransferStatus).toHaveBeenCalledWith('BSC', '0xsend');
    expect(result.structuredContent).toMatchObject({
      state: 'completed',
      refunded: false,
      historyUrl: 'https://core.allbridge.io/history/BSC/0xsend',
    });
  });

  test('reports a refunded intent transfer with the refund details', async () => {
    setup.gateway.getTransferStatus.mockResolvedValue({
      txId: '0xsend',
      sourceChainSymbol: 'BSC',
      destinationChainSymbol: 'SOL',
      send: { txId: '0xsend' },
      refunded: true,
      refundTxId: '0xrefund',
      refundedAmount: '9900000',
      refundedAmountFormatted: 9.9,
    });

    const result = await setup.server.call('get_transfer_status', { sourceChain: 'BSC', txId: '0xsend' });

    expect(result.structuredContent).toMatchObject({
      state: 'refunded',
      refundTxId: '0xrefund',
      refundedAmount: '9900000',
      refundedAmountFormatted: 9.9,
    });
  });

  test('reports a transaction the Core API has not indexed yet as not_found', async () => {
    setup.gateway.getTransferStatus.mockRejectedValue(notFound());

    const result = await setup.server.call('get_transfer_status', { sourceChain: 'BSC', txId: '0xnew' });

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({ state: 'not_found', txId: '0xnew' });
  });
});

describe('Stellar trustline tools', () => {
  let setup: ReturnType<typeof setupTools>;

  beforeEach(() => {
    setup = setupTools();
    setup.gateway.getTokens.mockResolvedValue([bscUsdt, srbUsdc, srbXlm]);
  });

  test('check_stellar_trustline reports a missing trustline', async () => {
    setup.gateway.getStellarBalanceLine.mockResolvedValue(undefined);

    const result = await setup.server.call('check_stellar_trustline', { address: SRB_ADDRESS, tokenAddress: srbUsdc.tokenAddress });

    expect(setup.gateway.getStellarBalanceLine).toHaveBeenCalledWith(SRB_ADDRESS, srbUsdc.tokenAddress);
    expect(result.structuredContent).toMatchObject({ required: true, symbol: 'USDC' });
  });

  test('build_stellar_trustline_transaction returns a signer-ready XDR', async () => {
    setup.gateway.buildStellarTrustlineTransaction.mockResolvedValue('AAAAtrust');

    const result = await setup.server.call('build_stellar_trustline_transaction', {
      accountAddress: SRB_ADDRESS,
      tokenAddress: srbUsdc.tokenAddress,
      walletId: 'XLM1',
    });

    expect(result.structuredContent.transaction).toEqual({ chainFamily: 'SRB', walletId: 'XLM1', serializedTransactionXdr: 'AAAAtrust' });
  });

  test('rejects native XLM, which needs no trustline', async () => {
    const result = await setup.server.call('check_stellar_trustline', { address: SRB_ADDRESS, tokenAddress: srbXlm.tokenAddress });

    expect(result.structuredContent.error).toMatchObject({ code: 'validation_error' });
  });
});

describe('broadcast_signed_transaction', () => {
  let setup: ReturnType<typeof setupTools>;

  beforeEach(() => {
    setup = setupTools();
  });

  test.each([
    { chainFamily: 'EVM', chainId: 1, walletId: 'ALPHA', signedTransaction: '0xsigned' },
    { chainFamily: 'SOLANA', signedTransactionHex: 'abcd' },
    { chainFamily: 'TRX', signedTransaction: { signature: ['sig'] } },
    { chainFamily: 'STX', signedTransactionHex: 'abcdef' },
    { chainFamily: 'SRB', signedTransactionXdr: 'AAAA' },
    { chainFamily: 'SUI', signedTransaction: { bytesBase64: 'AAAA', signature: 'AQID' } },
  ])('broadcasts a signed $chainFamily transaction', async (payload) => {
    setup.broadcastSignedTransactionByFamily.mockResolvedValue({ chainFamily: payload.chainFamily, txHash: 'hash', receipt: null });

    const result = await setup.server.call('broadcast_signed_transaction', payload);

    expect(setup.broadcastSignedTransactionByFamily).toHaveBeenCalledWith(payload);
    expect(result.structuredContent).toEqual({ chainFamily: payload.chainFamily, txHash: 'hash', receipt: null });
  });

  test('rejects a payload that does not match its chain family', async () => {
    const result = await setup.server.call('broadcast_signed_transaction', { chainFamily: 'EVM', signedTransaction: '0xsigned' });

    expect(result.structuredContent.error).toMatchObject({ code: 'validation_error' });
    expect(setup.broadcastSignedTransactionByFamily).not.toHaveBeenCalled();
  });

  test('turns RPC failures into structured errors', async () => {
    setup.broadcastSignedTransactionByFamily.mockRejectedValue(new Error('nonce too low'));

    const result = await setup.server.call('broadcast_signed_transaction', { chainFamily: 'SRB', signedTransactionXdr: 'AAAA' });

    expect(result.isError).toBe(true);
    expect(result.structuredContent.error).toMatchObject({ code: 'upstream_error', details: { reason: 'nonce too low' } });
  });
});
