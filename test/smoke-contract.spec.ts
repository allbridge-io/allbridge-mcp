import { describe, expect, test } from '@jest/globals';

import { validateBridgeExecutionJobContract } from '../src/execution-job-contract.js';

const handoff = {
  executionTarget: 'local-signer-mcp',
  executionTool: 'sign_and_broadcast_transaction',
  executionAction: 'sign_and_broadcast',
  broadcastTarget: 'allbridge-mcp',
  broadcastTool: 'broadcast_signed_transaction',
  broadcastAction: 'broadcast',
  walletSelector: { walletId: null, senderAddress: '0xsender', chainFamily: 'EVM', chainSymbol: 'ETH' },
};

function job(overrides: Record<string, unknown> = {}, stepOverrides: Record<string, unknown> = {}) {
  return {
    jobId: 'job-123',
    kind: 'bridge_transfer',
    version: 'v2',
    mode: 'external_signer',
    status: 'awaiting_signature',
    summary: 'Bridge 1 USDC from ETH to ARB',
    route: { messenger: 'CCTP_V2' },
    participants: { senderAddress: '0xsender', recipientAddress: '0xrecipient' },
    amount: { amountInBaseUnits: '1000000', amountInHumanUnits: '1' },
    handoff: { ...handoff, stepId: 'bridge' },
    steps: [
      {
        id: 'bridge',
        order: 1,
        status: 'awaiting_signature',
        summary: 'Bridge 1 USDC',
        transactionFormat: 'unsignedEvmTransaction',
        transaction: { chainFamily: 'EVM', chainId: 1, from: '0xsender', to: '0xbridge', data: '0x', value: '0' },
        handoff: { ...handoff, stepId: 'bridge' },
        nextOnSuccess: 'track_transfer',
        ...stepOverrides,
      },
    ],
    tracking: {
      sourceChain: 'ETH',
      destinationChain: 'ARB',
      transferStatusTool: 'get_transfer_status',
      transferStatusArguments: { sourceChain: 'ETH', txId: '<bridge step transaction hash>' },
    },
    nextAction: 'Sign the bridge step.',
    ...overrides,
  };
}

describe('validateBridgeExecutionJobContract', () => {
  test('accepts a v2 job with a signer-ready step', () => {
    const validated = validateBridgeExecutionJobContract(job());

    expect(validated.steps[0]).toMatchObject({ id: 'bridge', transaction: { chainFamily: 'EVM' }, build: null });
    expect(validated.handoff.walletSelector.chainSymbol).toBe('ETH');
  });

  test('accepts a step that is built right before signing', () => {
    const validated = validateBridgeExecutionJobContract(job({}, {
      status: 'requires_build',
      transaction: null,
      build: { tool: 'create_lifi_intents_order', arguments: { sourceTokenAddress: '0x' } },
    }));

    expect(validated.steps[0]).toMatchObject({ transaction: null, build: { tool: 'create_lifi_intents_order' } });
  });

  test('rejects v1 jobs, unknown chain families and unbuildable steps', () => {
    expect(() => validateBridgeExecutionJobContract(job({ version: 'v1' }))).toThrow('Expected version to be v2');
    expect(() => validateBridgeExecutionJobContract(job({}, { transaction: { chainFamily: 'SUI' } }))).toThrow('chainFamily SUI');
    expect(() => validateBridgeExecutionJobContract(job({}, { status: 'requires_build', transaction: null }))).toThrow('steps[0].build');
    expect(() => validateBridgeExecutionJobContract(job({ handoff: { ...handoff } }))).toThrow('handoff.stepId');
  });
});
