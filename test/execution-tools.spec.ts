import { beforeEach, describe, expect, test } from '@jest/globals';
import { Interface } from 'ethers';

import { validateBridgeExecutionJobContract } from '../src/execution-job-contract.js';
import {
  amountsAndFees,
  createToken,
  EVM_RECIPIENT,
  EVM_SENDER,
  setupTools,
  SOL_ADDRESS,
  SRB_ADDRESS,
  STX_ADDRESS,
  TRX_ADDRESS,
} from './support/fixtures.js';

const erc20 = new Interface(['function approve(address spender, uint256 amount)']);
const SPENDER = '0x7972d6907739593C00e6284c53C83dB3ECd15c33';
const ETH_USDT = '0xdAC17F958D2ee523a2206206994597C13D831ec7';

const ethUsdc = createToken({ tokenAddress: '0xeth-usdc', cctpV2Address: '0xeth-cctp', xReserve: { bridgeAddress: '0xx', feeConst: '0', feeShare: '0' } });
const ethUsdt = createToken({ symbol: 'USDT', tokenAddress: ETH_USDT, oftId: 'usdt', oftBridgeAddress: '0xeth-oft' });
const arbUsdc = createToken({ tokenAddress: '0xarb-usdc', chainSymbol: 'ARB', chainName: 'Arbitrum', chainId: '0xa4b1', cctpV2Address: '0xarb-cctp' });
const trxUsdt = createToken({ symbol: 'USDT', tokenAddress: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', chainSymbol: 'TRX', chainName: 'Tron', chainType: 'TRX', oftId: 'usdt', oftBridgeAddress: 'Toft' });
const solUsdc = createToken({ tokenAddress: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', chainSymbol: 'SOL', chainName: 'Solana', chainType: 'SOLANA', cctpV2Address: 'sol-cctp' });
const stxUsdcx = createToken({ symbol: 'USDCx', tokenAddress: 'SP120SBRBQJ00MCWS7TM5R8WJNTTKD5K0HFRC2CNE.usdcx', chainSymbol: 'STX', chainName: 'Stacks', chainType: 'STX', xReserve: { bridgeAddress: 'x', feeConst: '0', feeShare: '0' } });
const srbUsdc = createToken({ tokenAddress: 'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75', chainSymbol: 'SRB', chainName: 'Stellar', chainType: 'SRB', cctpV2Address: 'srb-cctp' });

function evmRaw(data: string, value = '0') {
  return { from: EVM_SENDER, to: SPENDER, data, value };
}

describe('create_bridge_execution_job', () => {
  let setup: ReturnType<typeof setupTools>;

  beforeEach(() => {
    setup = setupTools();
    setup.gateway.getTokens.mockResolvedValue([ethUsdc, ethUsdt, arbUsdc, trxUsdt, solUsdc, stxUsdcx, srbUsdc]);
    setup.gateway.getAmountToBeReceivedAndGasFeeOptions.mockResolvedValue(
      amountsAndFees({ send: '10', receive: '9.99', native: ['1000000000000000', '0.001'], stablecoin: ['240000', '0.24'] }),
    );
    setup.gateway.getAmountToBeReceived.mockResolvedValue('9.75');
    setup.gateway.getTokenBalance.mockResolvedValue('100');
    setup.gateway.getNativeTokenBalance.mockResolvedValue({ int: '1000000000000000000', float: '1' });
    setup.gateway.checkAllowance.mockResolvedValue(true);
    setup.gateway.buildSendTransaction.mockResolvedValue(evmRaw('0xbridge', '1000000000000000'));
  });

  const request = {
    sourceTokenAddress: '0xeth-usdc',
    destinationTokenAddress: '0xarb-usdc',
    senderAddress: EVM_SENDER,
    recipientAddress: EVM_RECIPIENT,
    amount: '10',
    messenger: 'CCTP_V2',
  };

  test('returns approve and bridge steps as signer-ready EVM transactions', async () => {
    setup.gateway.checkAllowance.mockResolvedValue(false);
    setup.gateway.buildApproveTransaction.mockResolvedValue(evmRaw(erc20.encodeFunctionData('approve', [SPENDER, 2n ** 256n - 1n])));

    const result = await setup.server.call('create_bridge_execution_job', { ...request, walletId: 'MAIN' });
    const job = result.structuredContent as Record<string, any>;

    expect(result.isError).toBeUndefined();
    expect(() => validateBridgeExecutionJobContract(job)).not.toThrow();
    expect(job.steps.map((step: { id: string; status: string }) => [step.id, step.status])).toEqual([
      ['approve', 'awaiting_signature'],
      ['bridge', 'blocked'],
    ]);
    expect(job.steps[1].transaction).toEqual({
      chainFamily: 'EVM',
      chainId: 1,
      chainSymbol: 'ETH',
      walletId: 'MAIN',
      from: EVM_SENDER,
      to: SPENDER,
      data: '0xbridge',
      value: '1000000000000000',
    });
    expect(job.steps[0]).toMatchObject({
      transactionFormat: 'unsignedEvmTransaction',
      waitForConfirmation: true,
      handoff: { executionTool: 'sign_and_broadcast_transaction', nextStepId: 'bridge', walletSelector: { walletId: 'MAIN', chainSymbol: 'ETH' } },
    });
    expect(job.handoff).toMatchObject({ stepId: 'approve', stepCount: 2, stepIds: ['approve', 'bridge'] });
    expect(job.tracking).toMatchObject({ transferStatusTool: 'get_transfer_status', transferStatusArguments: { sourceChain: 'ETH' } });
    expect(setup.gateway.checkAllowance).toHaveBeenCalledWith(expect.objectContaining({ owner: EVM_SENDER, amount: '10', messenger: 4, gasFeePaymentMethod: 'native' }));
    expect(setup.gateway.buildSendTransaction).toHaveBeenCalledWith(expect.objectContaining({
      amount: '10',
      fromAccountAddress: EVM_SENDER,
      toAccountAddress: EVM_RECIPIENT,
      messenger: 4,
      gasFeePaymentMethod: 'native',
    }));
  });

  test('skips the approval when the allowance already covers the amount', async () => {
    const result = await setup.server.call('create_bridge_execution_job', { ...request, feePaymentMethod: 'WITH_STABLECOIN' });
    const job = result.structuredContent as Record<string, any>;

    expect(job.steps.map((step: { id: string }) => step.id)).toEqual(['bridge']);
    expect(job.steps[0].status).toBe('awaiting_signature');
    expect(job.route.feePaymentMethod).toBe('WITH_STABLECOIN');
    expect(setup.gateway.buildSendTransaction).toHaveBeenCalledWith(expect.objectContaining({ gasFeePaymentMethod: 'stablecoin' }));
  });

  test('resets a non-zero Ethereum USDT allowance before approving', async () => {
    setup.gateway.checkAllowance.mockResolvedValue(false);
    setup.gateway.getAllowance.mockResolvedValue('5');
    setup.gateway.buildApproveTransaction.mockResolvedValue(evmRaw(erc20.encodeFunctionData('approve', [SPENDER, 2n ** 256n - 1n])));

    const result = await setup.server.call('create_bridge_execution_job', {
      ...request,
      sourceTokenAddress: ETH_USDT,
      destinationTokenAddress: trxUsdt.tokenAddress,
      recipientAddress: TRX_ADDRESS,
      messenger: 'OFT',
    });
    const steps = (result.structuredContent as Record<string, any>).steps;

    expect(steps.map((step: { id: string }) => step.id)).toEqual(['reset_allowance', 'approve', 'bridge']);
    const [spender, amount] = erc20.decodeFunctionData('approve', steps[0].transaction.data);
    expect(spender).toBe(SPENDER);
    expect(amount).toBe(0n);
  });

  test('does not reset a zero Ethereum USDT allowance', async () => {
    setup.gateway.checkAllowance.mockResolvedValue(false);
    setup.gateway.getAllowance.mockResolvedValue('0');
    setup.gateway.buildApproveTransaction.mockResolvedValue(evmRaw(erc20.encodeFunctionData('approve', [SPENDER, 1n])));

    const result = await setup.server.call('create_bridge_execution_job', {
      ...request,
      sourceTokenAddress: ETH_USDT,
      destinationTokenAddress: trxUsdt.tokenAddress,
      recipientAddress: TRX_ADDRESS,
      messenger: 'OFT',
    });

    expect((result.structuredContent as Record<string, any>).steps.map((step: { id: string }) => step.id)).toEqual(['approve', 'bridge']);
  });

  test('serializes a Solana source transaction to hex without approval', async () => {
    setup.gateway.buildSendTransaction.mockResolvedValue({ serialize: () => Uint8Array.from([1, 2, 255]) });

    const result = await setup.server.call('create_bridge_execution_job', {
      ...request,
      sourceTokenAddress: solUsdc.tokenAddress,
      senderAddress: SOL_ADDRESS,
    });
    const job = result.structuredContent as Record<string, any>;

    expect(job.steps).toHaveLength(1);
    expect(job.steps[0]).toMatchObject({
      transactionFormat: 'serializedSolanaTransactionHex',
      transaction: { chainFamily: 'SOLANA', serializedTransactionHex: '0102ff' },
    });
    expect(setup.gateway.checkAllowance).not.toHaveBeenCalled();
  });

  test('passes Tron, Stacks and Stellar transactions in the signer shapes', async () => {
    setup.gateway.buildSendTransaction.mockResolvedValueOnce({ raw_data: { contract: [] }, txID: 'abc' });
    const tron = await setup.server.call('create_bridge_execution_job', {
      ...request,
      sourceTokenAddress: trxUsdt.tokenAddress,
      destinationTokenAddress: ETH_USDT,
      senderAddress: TRX_ADDRESS,
      messenger: 'OFT',
    });
    expect((tron.structuredContent as any).steps[0].transaction).toEqual({ chainFamily: 'TRX', rawTransaction: { raw_data: { contract: [] }, txID: 'abc' } });

    setup.gateway.buildSendTransaction.mockResolvedValueOnce('0000abcd');
    const stacks = await setup.server.call('create_bridge_execution_job', {
      ...request,
      sourceTokenAddress: stxUsdcx.tokenAddress,
      destinationTokenAddress: '0xeth-usdc',
      senderAddress: STX_ADDRESS,
      messenger: 'X_RESERVE',
    });
    expect((stacks.structuredContent as any).steps[0].transaction).toEqual({ chainFamily: 'STX', serializedTransactionHex: '0000abcd' });

    setup.gateway.buildSendTransaction.mockResolvedValueOnce('AAAAxdr');
    const stellar = await setup.server.call('create_bridge_execution_job', {
      ...request,
      sourceTokenAddress: srbUsdc.tokenAddress,
      senderAddress: SRB_ADDRESS,
    });
    expect((stellar.structuredContent as any).steps[0].transaction).toEqual({ chainFamily: 'SRB', serializedTransactionXdr: 'AAAAxdr' });
  });

  test('reports a missing Stellar trustline of the recipient', async () => {
    setup.gateway.getStellarBalanceLine.mockResolvedValue(undefined);

    const result = await setup.server.call('create_bridge_execution_job', {
      ...request,
      destinationTokenAddress: srbUsdc.tokenAddress,
      recipientAddress: SRB_ADDRESS,
    });
    const job = result.structuredContent as Record<string, any>;

    expect(job.destinationSetup).toMatchObject({
      required: true,
      type: 'stellar_trustline',
      accountAddress: SRB_ADDRESS,
      buildTool: 'build_stellar_trustline_transaction',
    });
    expect(job.nextAction).toContain('build_stellar_trustline_transaction');
  });

  test('rejects a messenger that does not serve the route', async () => {
    const result = await setup.server.call('create_bridge_execution_job', { ...request, messenger: 'OFT' });

    expect(result.structuredContent.error).toMatchObject({ code: 'unsupported_route', details: { availableMessengers: ['CCTP_V2'] } });
    expect(setup.gateway.buildSendTransaction).not.toHaveBeenCalled();
  });

  test('validates the recipient address for the destination chain', async () => {
    const result = await setup.server.call('create_bridge_execution_job', { ...request, recipientAddress: TRX_ADDRESS });

    expect(result.structuredContent.error).toMatchObject({ code: 'invalid_address', details: { field: 'recipientAddress' } });
  });
});
