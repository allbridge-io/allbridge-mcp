import { beforeEach, describe, expect, test } from '@jest/globals';

import { detectMessengers } from '../src/messengers.js';
import { createToken, setupTools } from './support/fixtures.js';

const ethUsdc = createToken({ tokenAddress: '0xeth-usdc', cctpV2Address: '0xeth-cctp', xReserve: { bridgeAddress: '0xx', feeConst: '0', feeShare: '0' } });
const arbUsdc = createToken({ tokenAddress: '0xarb-usdc', chainSymbol: 'ARB', chainName: 'Arbitrum', chainId: '0xa4b1', cctpV2Address: '0xarb-cctp' });
const ethNative = createToken({ symbol: 'ETH', name: 'Ether', decimals: 18, tokenAddress: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE', isNative: true });
const arbNative = createToken({ symbol: 'ETH', name: 'Ether', decimals: 18, tokenAddress: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE', isNative: true, chainSymbol: 'ARB', chainName: 'Arbitrum', chainId: '0xa4b1' });
const suiUsdc = createToken({ tokenAddress: '0x5d4b::usdc::USDC', chainSymbol: 'SUI', chainName: 'Sui', chainType: 'SUI' });
const baseUsdc = createToken({ tokenAddress: '0xbase-usdc', chainSymbol: 'BAS', chainName: 'Base', chainId: '0x2105' });

describe('catalog tools', () => {
  let setup: ReturnType<typeof setupTools>;

  beforeEach(() => {
    setup = setupTools();
    setup.gateway.getTokens.mockResolvedValue([ethUsdc, ethNative, arbUsdc, arbNative, suiUsdc, baseUsdc]);
  });

  test('list_supported_chains skips chain families this server cannot sign for', async () => {
    const result = await setup.server.call('list_supported_chains', {});
    const chains = result.structuredContent.chains as Array<{ chainSymbol: string; tokenCount: number }>;

    expect(chains.map((chain) => chain.chainSymbol)).toEqual(['ARB', 'BAS', 'ETH']);
    expect(chains.find((chain) => chain.chainSymbol === 'ETH')?.tokenCount).toBe(2);
  });

  test('list_supported_tokens resolves aliases such as Base and flags native currencies', async () => {
    const base = await setup.server.call('list_supported_tokens', { chain: 'base' });
    expect(base.structuredContent.chain).toMatchObject({ chainSymbol: 'BAS' });

    const eth = await setup.server.call('list_supported_tokens', { chain: 'Ethereum' });
    expect(eth.structuredContent.tokens).toEqual([
      expect.objectContaining({ symbol: 'USDC', isNative: false }),
      expect.objectContaining({ symbol: 'ETH', isNative: true }),
    ]);
  });

  test('find_bridge_routes lists the messengers both tokens support', async () => {
    const result = await setup.server.call('find_bridge_routes', {
      sourceChain: 'ETH',
      destinationChain: 'arbitrum',
      sourceTokenSymbol: 'usdc',
    });

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({
      route: { symbolPair: 'USDC -> USDC' },
      availableMessengers: ['CCTP_V2'],
    });
  });

  test('find_bridge_routes reports unsupported chains with the supported list', async () => {
    const result = await setup.server.call('find_bridge_routes', {
      sourceChain: 'SUI',
      destinationChain: 'ETH',
      sourceTokenSymbol: 'USDC',
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent.error).toMatchObject({
      code: 'unsupported_chain',
      details: { field: 'sourceChain', input: 'SUI' },
    });
  });

  test('find_bridge_routes reports the field name when the destination token is missing', async () => {
    const result = await setup.server.call('find_bridge_routes', {
      sourceChain: 'ETH',
      destinationChain: 'ARB',
      sourceTokenSymbol: 'USDC',
      destinationTokenSymbol: 'USDT',
    });

    expect(result.structuredContent.error).toMatchObject({
      code: 'unsupported_token',
      details: { field: 'destinationTokenSymbol', chainSymbol: 'ARB' },
    });
  });
});

describe('detectMessengers', () => {
  test('requires the same OFT id and an OFT bridge on both chains', () => {
    const source = createToken({ oftId: 'usdt0', oftBridgeAddress: '0xa' });
    const destination = createToken({ chainSymbol: 'ARB', oftId: 'usdt0', oftBridgeAddress: '0xb' });

    expect(detectMessengers(source, destination)).toEqual(['OFT']);
    expect(detectMessengers(source, createToken({ chainSymbol: 'ARB', oftId: 'other', oftBridgeAddress: '0xb' }))).toEqual([]);
    expect(detectMessengers(source, createToken({ chainSymbol: 'ARB', oftId: 'usdt0' }))).toEqual([]);
  });

  test('never routes a token to its own chain', () => {
    const token = createToken({ cctpV2Address: '0xa' });
    expect(detectMessengers(token, createToken({ cctpV2Address: '0xa', tokenAddress: '0xother' }))).toEqual([]);
  });
});
