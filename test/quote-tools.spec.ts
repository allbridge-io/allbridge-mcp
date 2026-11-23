import { beforeEach, describe, expect, test } from '@jest/globals';

import { NodeRpcUrlNotInitializedError, OFTDoesNotSupportedError } from './support/core-sdk-stub.js';
import { amountsAndFees, createToken, EVM_SENDER, setupTools } from './support/fixtures.js';

const abrToken = { tokenAddress: '0xabr', chainSymbol: 'ETH', decimals: 18 };
const ethUsdc = createToken({
  tokenAddress: '0xeth-usdc',
  cctpV2Address: '0xeth-cctp',
  oftId: 'usdc',
  oftBridgeAddress: '0xeth-oft',
  abrPayer: { payerAddress: '0xpayer', abrToken, payerAvailability: {} },
});
const arbUsdc = createToken({
  tokenAddress: '0xarb-usdc',
  chainSymbol: 'ARB',
  chainName: 'Arbitrum',
  chainId: '0xa4b1',
  cctpV2Address: '0xarb-cctp',
  oftId: 'usdc',
  oftBridgeAddress: '0xarb-oft',
});
const ethNative = createToken({ symbol: 'ETH', decimals: 18, tokenAddress: '0xeeee', isNative: true, cctpV2Address: '0xeth-cctp' });

const base = {
  sourceTokenAddress: '0xeth-usdc',
  destinationTokenAddress: '0xarb-usdc',
  amount: '100',
};

describe('quote tools', () => {
  let setup: ReturnType<typeof setupTools>;

  beforeEach(() => {
    setup = setupTools();
    setup.gateway.getTokens.mockResolvedValue([ethUsdc, arbUsdc, ethNative]);
  });

  test('plan_bridge_transfer quotes every messenger and each fee payment method', async () => {
    setup.gateway.getAmountToBeReceivedAndGasFeeOptions.mockImplementation(async (...args: unknown[]) => {
      const messenger = args[3];
      return messenger === 4
        ? amountsAndFees({ send: '100', receive: '99.9', native: ['1000000000000000', '0.001'], stablecoin: ['250000', '0.25'], abr: ['2000000000000000000', '2'] })
        : amountsAndFees({ send: '100', receive: '99.95', native: ['3000000000000000', '0.003'] });
    });
    setup.gateway.getAmountToBeReceived.mockResolvedValue('99.65');

    const result = await setup.server.call('plan_bridge_transfer', {
      sourceChain: 'ETH',
      destinationChain: 'ARB',
      sourceTokenSymbol: 'USDC',
      amount: '100',
    });

    expect(result.isError).toBeUndefined();
    const options = result.structuredContent.options as Array<Record<string, any>>;
    expect(options.map((option) => option.messenger)).toEqual(['OFT', 'CCTP_V2']);
    expect(result.structuredContent.recommendedOption).toMatchObject({ messenger: 'OFT' });

    const cctp = options[1]!;
    expect(cctp.amountToReceive).toEqual({ inBaseUnits: '99900000', inHumanUnits: '99.9' });
    expect(cctp.feePaymentOptions).toEqual([
      {
        feePaymentMethod: 'WITH_NATIVE_CURRENCY',
        fee: { inBaseUnits: '1000000000000000', inHumanUnits: '0.001', asset: 'native', symbol: 'ETH' },
        amountToReceive: { inBaseUnits: '99900000', inHumanUnits: '99.9' },
      },
      {
        feePaymentMethod: 'WITH_STABLECOIN',
        fee: { inBaseUnits: '250000', inHumanUnits: '0.25', asset: 'source_token', symbol: 'USDC' },
        amountToReceive: { inBaseUnits: '99650000', inHumanUnits: '99.65' },
      },
      {
        feePaymentMethod: 'WITH_ABR',
        fee: { inBaseUnits: '2000000000000000000', inHumanUnits: '2', asset: 'abr', symbol: 'ABR' },
        amountToReceive: { inBaseUnits: '99900000', inHumanUnits: '99.9' },
      },
    ]);
    // The stablecoin fee is deducted before bridging, so the received amount is quoted for 100 - 0.25.
    expect(setup.gateway.getAmountToBeReceived).toHaveBeenCalledWith('99.75', ethUsdc, arbUsdc, 4);
    expect(result.structuredContent.bridgePortalDeepLink).toBe(
      'https://core.allbridge.io/?f=ETH&t=ARB&ft=USDC&tt=USDC&send=100&messenger=OFT',
    );
  });

  test('a messenger that cannot quote is listed in unavailableOptions instead of failing the plan', async () => {
    setup.gateway.getAmountToBeReceivedAndGasFeeOptions.mockImplementation(async (...args: unknown[]) => {
      if (args[3] === 5) {
        throw new OFTDoesNotSupportedError('Such route does not support OFT protocol');
      }
      return amountsAndFees({ send: '100', receive: '99.9' });
    });

    const result = await setup.server.call('quote_bridge_transfer', base);

    expect(result.structuredContent.options).toEqual([expect.objectContaining({ messenger: 'CCTP_V2' })]);
    expect(result.structuredContent.unavailableOptions).toEqual([
      expect.objectContaining({ messenger: 'OFT', code: 'unsupported_route' }),
    ]);
  });

  test('quote_bridge_transfer reports the token symbol in invalid amount errors', async () => {
    const result = await setup.server.call('quote_bridge_transfer', { ...base, amount: '1.0000001' });

    expect(result.structuredContent.error).toMatchObject({
      code: 'invalid_amount',
      details: { symbol: 'USDC', decimals: 6 },
    });
  });

  test('quote_bridge_transfer rejects a zero amount', async () => {
    const result = await setup.server.call('quote_bridge_transfer', { ...base, amount: '0' });
    expect(result.structuredContent.error).toMatchObject({ code: 'invalid_amount' });
  });
});

describe('check_sender_balances', () => {
  let setup: ReturnType<typeof setupTools>;
  const request = { ...base, senderAddress: EVM_SENDER, messenger: 'CCTP_V2' };

  beforeEach(() => {
    setup = setupTools();
    setup.gateway.getTokens.mockResolvedValue([ethUsdc, arbUsdc, ethNative]);
    setup.gateway.getAmountToBeReceivedAndGasFeeOptions.mockResolvedValue(
      amountsAndFees({ send: '100', receive: '99.9', native: ['1000000000000000', '0.001'], stablecoin: ['250000', '0.25'], abr: ['2000000000000000000', '2'] }),
    );
    setup.gateway.getAmountToBeReceived.mockResolvedValue('99.65');
    setup.gateway.getTokenBalance.mockResolvedValue('150');
    setup.gateway.getNativeTokenBalance.mockResolvedValue({ int: '500000000000000', float: '0.0005' });
  });

  test('WITH_NATIVE_CURRENCY needs the token amount and the gas fee in the native currency', async () => {
    const result = await setup.server.call('check_sender_balances', { ...request, feePaymentMethod: 'WITH_NATIVE_CURRENCY' });

    expect(result.structuredContent).toMatchObject({
      canProceed: false,
      requiredBalances: [
        { kind: 'source_token', requiredBaseUnits: '100000000', availableBaseUnits: '150000000', satisfied: true },
        { kind: 'fee_native', requiredBaseUnits: '1000000000000000', availableBaseUnits: '500000000000000', satisfied: false },
      ],
    });
  });

  test('WITH_STABLECOIN needs only the amount because the fee is deducted from it', async () => {
    const result = await setup.server.call('check_sender_balances', { ...request, feePaymentMethod: 'WITH_STABLECOIN' });

    expect(result.structuredContent.canProceed).toBe(true);
    expect(result.structuredContent.requiredBalances).toEqual([
      expect.objectContaining({ kind: 'source_token', requiredBaseUnits: '100000000' }),
    ]);
    expect(setup.gateway.getNativeTokenBalance).not.toHaveBeenCalled();
  });

  test('WITH_ABR checks the ABR token of the chain', async () => {
    setup.gateway.getTokenBalance.mockImplementation(async (...args: unknown[]) =>
      (args[1] as { tokenAddress: string }).tokenAddress === '0xabr' ? '1.5' : '150',
    );

    const result = await setup.server.call('check_sender_balances', { ...request, feePaymentMethod: 'WITH_ABR' });

    expect(result.structuredContent.requiredBalances).toEqual([
      expect.objectContaining({ kind: 'source_token', satisfied: true }),
      expect.objectContaining({ kind: 'fee_abr', tokenAddress: '0xabr', requiredBaseUnits: '2000000000000000000', availableBaseUnits: '1500000000000000000', satisfied: false }),
    ]);
  });

  test('a native source token needs the amount plus the gas fee in one balance', async () => {
    setup.gateway.getNativeTokenBalance.mockResolvedValue({ int: '2000000000000000000', float: '2' });

    const result = await setup.server.call('check_sender_balances', {
      ...request,
      sourceTokenAddress: '0xeeee',
      sourceChain: 'ETH',
      amount: '1',
      feePaymentMethod: 'WITH_NATIVE_CURRENCY',
    });

    expect(result.structuredContent.requiredBalances).toEqual([
      expect.objectContaining({ kind: 'source_native', requiredBaseUnits: '1001000000000000000', satisfied: true }),
    ]);
  });

  test('an unreadable balance is reported without failing the check', async () => {
    setup.gateway.getNativeTokenBalance.mockRejectedValue(new NodeRpcUrlNotInitializedError("For chain 'ETH' Node RPC URL not initialized"));

    const result = await setup.server.call('check_sender_balances', { ...request, feePaymentMethod: 'WITH_NATIVE_CURRENCY' });

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent.canProceed).toBe(false);
    expect(result.structuredContent.requiredBalances).toEqual([
      expect.objectContaining({ kind: 'source_token', satisfied: true }),
      expect.objectContaining({ kind: 'fee_native', satisfied: null, error: expect.stringContaining('no RPC is configured') }),
    ]);
    expect(String(result.structuredContent.nextAction)).toContain('could not be read');
  });

  test('rejects a messenger that does not serve the route', async () => {
    const result = await setup.server.call('check_sender_balances', { ...request, messenger: 'X_RESERVE' });

    expect(result.structuredContent.error).toMatchObject({
      code: 'unsupported_route',
      details: { availableMessengers: ['CCTP_V2', 'OFT'] },
    });
  });
});
