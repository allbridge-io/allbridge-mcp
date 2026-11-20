import { beforeEach, describe, expect, test } from '@jest/globals';

import { applySlippage } from '../src/execution.js';
import { validateBridgeExecutionJobContract } from '../src/execution-job-contract.js';
import { detectMessengers } from '../src/messengers.js';
import { LifiIntentsAmountTooLowError } from './support/core-sdk-stub.js';
import { createToken, EVM_RECIPIENT, EVM_SENDER, setupTools, SOL_ADDRESS } from './support/fixtures.js';

const LIFI_BRIDGE = '0xf01C98b3BEf6cc96BD484E092Cc2A56016ac2eD6';
const ARB_USDC = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831';
const BAS_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const SOL_USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

const arbUsdc = createToken({
  tokenAddress: ARB_USDC,
  chainSymbol: 'ARB',
  chainName: 'Arbitrum',
  chainId: '0xa4b1',
  nearIntents: { assetId: 'nep141:arb-usdc' },
  lifiIntents: { bridgeAddress: LIFI_BRIDGE, destinations: { BAS: [BAS_USDC.toLowerCase()], SOL: [SOL_USDC] } },
});
const basUsdc = createToken({ tokenAddress: BAS_USDC, chainSymbol: 'BAS', chainName: 'Base', chainId: '0x2105', nearIntents: { assetId: 'nep141:base-usdc' } });
const solUsdc = createToken({
  tokenAddress: SOL_USDC,
  chainSymbol: 'SOL',
  chainName: 'Solana',
  chainType: 'SOLANA',
  nearIntents: { assetId: 'nep141:sol-usdc' },
  lifiIntents: { bridgeAddress: 'LifiBridgeProgram', destinations: { ARB: [ARB_USDC.toLowerCase()] } },
});
const stxUsdcx = createToken({ symbol: 'USDCx', tokenAddress: 'SP120SBRBQJ00MCWS7TM5R8WJNTTKD5K0HFRC2CNE.usdcx', chainSymbol: 'STX', chainType: 'STX', nearIntents: { assetId: 'x' } });

const nearDeposit = {
  depositAddress: '0xbC56Aa6E947148a63A617Df97090E1bEA9731e5D',
  amountIn: '20',
  amountOut: '19.975602',
  minAmountOut: '19.775845',
  deadline: new Date('2026-11-23T10:52:28.000Z'),
  timeEstimate: 27,
};

function lifiOrder(overrides: Record<string, unknown> = {}) {
  return {
    orderId: '0xorder',
    sender: EVM_SENDER,
    recipient: EVM_RECIPIENT,
    amountIn: '100',
    amountOut: '99.88',
    fee: '0.1',
    timeEstimate: 60,
    validUntil: new Date(Date.now() + 90_000),
    fillDeadline: new Date(Date.now() + 600_000),
    approval: { token: ARB_USDC, spender: LIFI_BRIDGE, amount: '100000000' },
    transaction: { contractAddress: LIFI_BRIDGE, value: '0', data: '0xorderdata' },
    ...overrides,
  };
}

describe('intent routes', () => {
  test('detectMessengers finds NEAR and LI.FI Intents from their token fields', () => {
    expect(detectMessengers(arbUsdc, basUsdc)).toEqual(['NEAR_INTENTS', 'LIFI_INTENTS']);
    expect(detectMessengers(basUsdc, arbUsdc)).toEqual(['NEAR_INTENTS']);
    expect(detectMessengers(stxUsdcx, arbUsdc)).toEqual([]);
  });

  test('applySlippage rounds the minimum down', () => {
    expect(applySlippage({ inBaseUnits: '99882582', inHumanUnits: '99.882582' }, 6, 0.5)).toEqual({ inBaseUnits: '99383169', inHumanUnits: '99.383169' });
    expect(applySlippage({ inBaseUnits: '1000', inHumanUnits: '1' }, 3, 0)).toEqual({ inBaseUnits: '1000', inHumanUnits: '1' });
  });
});

describe('intent quotes and jobs', () => {
  let setup: ReturnType<typeof setupTools>;

  beforeEach(() => {
    setup = setupTools();
    setup.gateway.getTokens.mockResolvedValue([arbUsdc, basUsdc, solUsdc, stxUsdcx]);
    setup.gateway.getTokenBalance.mockResolvedValue('500');
    setup.gateway.getNativeTokenBalance.mockResolvedValue({ int: '1000000000000000000', float: '1' });
    setup.gateway.getNearIntentsQuote.mockResolvedValue({ amountIn: '100', amountOut: '99.9', minAmountOut: '98.9', timeEstimate: 22, estimated: true });
    setup.gateway.getLifiIntentsQuote.mockResolvedValue({ amountIn: '100', amountOut: '99.882582', fee: '0.1', timeEstimate: 60 });
    setup.gateway.createNearIntentsDeposit.mockResolvedValue(nearDeposit);
    setup.gateway.checkAllowance.mockResolvedValue(false);
    setup.gateway.buildApproveTransaction.mockResolvedValue({ from: EVM_SENDER, to: ARB_USDC, value: '0', data: '0x095ea7b3' });
  });

  test('plan_bridge_transfer lists intent quotes with their minimum and Allbridge fee', async () => {
    setup.gateway.getLifiIntentsQuote.mockResolvedValueOnce({ amountIn: '100', amountOut: '99.95', fee: '0.1', timeEstimate: 60 });

    const result = await setup.server.call('plan_bridge_transfer', { sourceChain: 'ARB', destinationChain: 'BAS', sourceTokenSymbol: 'USDC', amount: '100' });

    expect(result.structuredContent.options).toEqual([
      expect.objectContaining({
        messenger: 'LIFI_INTENTS',
        kind: 'intent',
        amountToReceive: { inBaseUnits: '99950000', inHumanUnits: '99.95' },
        allbridgeFee: { inBaseUnits: '100000', inHumanUnits: '0.1', symbol: 'USDC' },
        minAmountToReceive: null,
        estimatedTimeMs: 60000,
        feePaymentOptions: [],
      }),
      expect.objectContaining({
        messenger: 'NEAR_INTENTS',
        minAmountToReceive: { inBaseUnits: '98900000', inHumanUnits: '98.9' },
        estimated: true,
        estimatedTimeMs: 22000,
      }),
    ]);
  });

  test('intent limit errors carry the minimum in token units', async () => {
    setup.gateway.getLifiIntentsQuote.mockRejectedValue(new LifiIntentsAmountTooLowError('too low', '5000000'));

    const result = await setup.server.call('plan_bridge_transfer', { sourceChain: 'ARB', destinationChain: 'BAS', sourceTokenSymbol: 'USDC', amount: '1' });

    expect(result.structuredContent.unavailableOptions).toEqual([
      expect.objectContaining({
        messenger: 'LIFI_INTENTS',
        code: 'amount_too_low',
        details: expect.objectContaining({ minAmount: { inBaseUnits: '5000000', inHumanUnits: '5' } }),
      }),
    ]);
  });

  test('a NEAR Intents job creates the deposit and transfers to it without approval', async () => {
    setup.gateway.buildSendTransaction.mockResolvedValue({ from: EVM_SENDER, to: ARB_USDC, value: '0', data: '0xa9059cbb' });

    const result = await setup.server.call('create_bridge_execution_job', {
      sourceTokenAddress: ARB_USDC,
      destinationTokenAddress: BAS_USDC,
      senderAddress: EVM_SENDER,
      recipientAddress: EVM_RECIPIENT,
      amount: '20',
      messenger: 'NEAR_INTENTS',
    });
    const job = result.structuredContent as Record<string, any>;

    expect(() => validateBridgeExecutionJobContract(job)).not.toThrow();
    expect(setup.gateway.checkAllowance).not.toHaveBeenCalled();
    expect(setup.gateway.createNearIntentsDeposit).toHaveBeenCalledWith(expect.objectContaining({
      amount: '20',
      fromAccountAddress: EVM_SENDER,
      toAccountAddress: EVM_RECIPIENT,
    }));
    expect(setup.gateway.buildSendTransaction).toHaveBeenCalledWith(expect.objectContaining({ messenger: 7, nearIntentsDeposit: nearDeposit }));
    expect(job.steps.map((step: { id: string }) => step.id)).toEqual(['bridge']);
    expect(job.route.feePaymentMethod).toBeNull();
    expect(job.intent).toEqual({
      provider: 'NEAR Intents',
      depositAddress: nearDeposit.depositAddress,
      depositMemo: null,
      deadline: '2026-11-23T10:52:28.000Z',
      amountToSend: { inBaseUnits: '20000000', inHumanUnits: '20' },
      amountToReceive: { inBaseUnits: '19975602', inHumanUnits: '19.975602' },
      minAmountToReceive: { inBaseUnits: '19775845', inHumanUnits: '19.775845' },
      submitDepositTool: 'submit_near_intents_deposit',
      submitDepositArguments: { depositAddress: nearDeposit.depositAddress, txId: '<bridge step transaction hash>' },
    });
    expect(job.balanceValidation.requiredBalances).toEqual([expect.objectContaining({ kind: 'source_token', requiredBaseUnits: '20000000' })]);
    expect(job.nextAction).toContain('submit_near_intents_deposit');
  });

  test('a LI.FI Intents job approves now and defers the order to create_lifi_intents_order', async () => {
    const result = await setup.server.call('create_bridge_execution_job', {
      sourceTokenAddress: ARB_USDC,
      destinationTokenAddress: BAS_USDC,
      senderAddress: EVM_SENDER,
      recipientAddress: EVM_RECIPIENT,
      amount: '100',
      messenger: 'LIFI_INTENTS',
      walletId: 'MAIN',
    });
    const job = result.structuredContent as Record<string, any>;

    expect(() => validateBridgeExecutionJobContract(job)).not.toThrow();
    expect(job.status).toBe('awaiting_signature');
    expect(setup.gateway.checkAllowance).toHaveBeenCalledWith({ token: arbUsdc, owner: EVM_SENDER, messenger: 8, amount: '100' });
    expect(setup.gateway.buildSendTransaction).not.toHaveBeenCalled();
    expect(job.steps[0]).toMatchObject({ id: 'approve', status: 'awaiting_signature', transaction: { to: ARB_USDC } });
    expect(job.steps[1]).toMatchObject({
      id: 'bridge',
      status: 'blocked',
      transaction: null,
      transactionFormat: 'unsignedEvmTransaction',
      build: {
        tool: 'create_lifi_intents_order',
        arguments: {
          sourceTokenAddress: ARB_USDC,
          sourceChain: 'ARB',
          destinationTokenAddress: BAS_USDC,
          destinationChain: 'BAS',
          senderAddress: EVM_SENDER,
          recipientAddress: EVM_RECIPIENT,
          amount: '100000000',
          amountUnit: 'base',
          minAmountToReceive: '99383169',
          walletId: 'MAIN',
        },
      },
    });
    expect(job.intent).toMatchObject({ provider: 'LI.FI Intents', maxSlippagePercent: 0.5, bridgeContract: LIFI_BRIDGE });
  });

  test('a LI.FI Intents job from Solana starts with the build step', async () => {
    const result = await setup.server.call('create_bridge_execution_job', {
      sourceTokenAddress: SOL_USDC,
      destinationTokenAddress: ARB_USDC,
      senderAddress: SOL_ADDRESS,
      recipientAddress: EVM_RECIPIENT,
      amount: '100',
      messenger: 'LIFI_INTENTS',
    });
    const job = result.structuredContent as Record<string, any>;

    expect(job.status).toBe('requires_build');
    expect(job.steps).toEqual([expect.objectContaining({ id: 'bridge', status: 'requires_build', transactionFormat: 'serializedSolanaTransactionHex' })]);
    expect(setup.gateway.checkAllowance).not.toHaveBeenCalled();
  });

  test('a LI.FI Intents job to Solana warns when the recipient has no token account', async () => {
    setup.gateway.hasSolanaTokenAccount.mockResolvedValue(false);

    const result = await setup.server.call('create_bridge_execution_job', {
      sourceTokenAddress: ARB_USDC,
      destinationTokenAddress: SOL_USDC,
      senderAddress: EVM_SENDER,
      recipientAddress: SOL_ADDRESS,
      amount: '100',
      messenger: 'LIFI_INTENTS',
    });

    expect(setup.gateway.hasSolanaTokenAccount).toHaveBeenCalledWith(SOL_ADDRESS, solUsdc);
    expect((result.structuredContent as Record<string, any>).destinationSetup).toMatchObject({
      required: true,
      type: 'solana_token_account',
      buildTool: null,
    });
  });
});

describe('create_lifi_intents_order', () => {
  let setup: ReturnType<typeof setupTools>;
  const args = {
    sourceTokenAddress: ARB_USDC,
    sourceChain: 'ARB',
    destinationTokenAddress: BAS_USDC,
    destinationChain: 'BAS',
    senderAddress: EVM_SENDER,
    recipientAddress: EVM_RECIPIENT,
    amount: '100000000',
    amountUnit: 'base',
    minAmountToReceive: '99383169',
  };

  beforeEach(() => {
    setup = setupTools();
    setup.gateway.getTokens.mockResolvedValue([arbUsdc, basUsdc, solUsdc]);
    setup.gateway.checkAllowance.mockResolvedValue(true);
    setup.gateway.createLifiIntentsOrder.mockResolvedValue(lifiOrder());
    setup.gateway.buildSendTransaction.mockResolvedValue({ from: EVM_SENDER, to: LIFI_BRIDGE, value: '0', data: '0xorderdata' });
  });

  test('creates the order and returns a signer-ready bridge step', async () => {
    const result = await setup.server.call('create_lifi_intents_order', args);
    const output = result.structuredContent as Record<string, any>;

    expect(result.isError).toBeUndefined();
    expect(setup.gateway.createLifiIntentsOrder).toHaveBeenCalledWith(expect.objectContaining({ amount: '100', fromAccountAddress: EVM_SENDER, toAccountAddress: EVM_RECIPIENT }));
    expect(setup.gateway.buildSendTransaction).toHaveBeenCalledWith(expect.objectContaining({ messenger: 8, lifiIntentsOrder: expect.objectContaining({ orderId: '0xorder' }) }));
    expect(output.step).toMatchObject({
      id: 'bridge',
      status: 'awaiting_signature',
      transaction: { chainFamily: 'EVM', chainId: 42161, to: LIFI_BRIDGE, data: '0xorderdata' },
    });
    expect(output.order.orderId).toBe('0xorder');
    expect(output.order.secondsToSign).toBeGreaterThan(80);
    expect(output.quote).toMatchObject({ amountToReceive: { inBaseUnits: '99880000' }, allbridgeFee: { inHumanUnits: '0.1' } });
    expect(output.tracking).toMatchObject({ explorerTransferId: '0xorder', transferStatusTool: 'get_transfer_status' });
  });

  test('stops with price_changed when the order pays less than the accepted minimum', async () => {
    setup.gateway.createLifiIntentsOrder.mockResolvedValue(lifiOrder({ amountOut: '99.1' }));

    const result = await setup.server.call('create_lifi_intents_order', args);

    expect(result.structuredContent.error).toMatchObject({
      code: 'price_changed',
      details: { orderAmountToReceive: { inBaseUnits: '99100000' }, minAmountToReceive: { inBaseUnits: '99383169' } },
    });
    expect(setup.gateway.buildSendTransaction).not.toHaveBeenCalled();
  });

  test('stops with approval_required before creating an order without allowance', async () => {
    setup.gateway.checkAllowance.mockResolvedValue(false);

    const result = await setup.server.call('create_lifi_intents_order', args);

    expect(result.structuredContent.error).toMatchObject({ code: 'approval_required', details: { spender: LIFI_BRIDGE } });
    expect(setup.gateway.createLifiIntentsOrder).not.toHaveBeenCalled();
  });

  test('refuses a transaction that does not call the LifiIntentsBridge contract', async () => {
    setup.gateway.buildSendTransaction.mockResolvedValue({ from: EVM_SENDER, to: '0x000000000000000000000000000000000000dEaD', value: '0', data: '0x' });

    const result = await setup.server.call('create_lifi_intents_order', args);

    expect(result.structuredContent.error).toMatchObject({ code: 'validation_error', details: { expectedContract: LIFI_BRIDGE } });
  });

  test('refuses an order asking for an approval to another spender', async () => {
    setup.gateway.createLifiIntentsOrder.mockResolvedValue(lifiOrder({ approval: { token: ARB_USDC, spender: '0xbad', amount: '1' } }));

    const result = await setup.server.call('create_lifi_intents_order', args);

    expect(result.structuredContent.error).toMatchObject({ code: 'validation_error', details: { spender: '0xbad' } });
  });

  test('rejects a route LI.FI Intents does not serve', async () => {
    const result = await setup.server.call('create_lifi_intents_order', {
      ...args,
      sourceTokenAddress: BAS_USDC,
      sourceChain: 'BAS',
      destinationTokenAddress: ARB_USDC,
      destinationChain: 'ARB',
    });

    expect(result.structuredContent.error).toMatchObject({ code: 'unsupported_route' });
  });
});

describe('submit_near_intents_deposit', () => {
  test('forwards the deposit transaction to NEAR Intents', async () => {
    const setup = setupTools();
    setup.gateway.submitNearIntentsDeposit.mockResolvedValue(undefined);

    const result = await setup.server.call('submit_near_intents_deposit', { depositAddress: '0xdeposit', depositMemo: '42', txId: '0xtx' });

    expect(setup.gateway.submitNearIntentsDeposit).toHaveBeenCalledWith({ depositAddress: '0xdeposit', depositMemo: '42', txId: '0xtx' });
    expect(result.structuredContent).toMatchObject({ submitted: true });
  });
});

