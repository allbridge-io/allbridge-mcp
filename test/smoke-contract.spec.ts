import { describe, expect, test } from '@jest/globals';

import { validateBridgeExecutionJobContract } from '../src/execution-job-contract.js';

describe('validateBridgeExecutionJobContract', () => {
  test('accepts the current bridge execution job handoff contract', () => {
    const job = validateBridgeExecutionJobContract({
      jobId: 'job-123',
      kind: 'bridge_transfer',
      version: 'v1',
      mode: 'external_signer',
      status: 'awaiting_signature',
      summary: 'Bridge 1 USDC from ETH to SOL',
      route: {
        source: { symbol: 'USDC' },
        destination: { symbol: 'USDC' },
        messenger: 'CCTP',
        feePaymentMethod: 'WITH_NATIVE_CURRENCY',
      },
      participants: {
        senderAddress: '0xsender',
        recipientAddress: 'recipient',
      },
      amount: {
        amountInBaseUnits: '1000000',
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
          senderAddress: '0xsender',
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
          summary: 'Approve USDC spending on ETH.',
          transactionShape: 'object',
          transaction: { to: '0xbridge' },
          handoff: {
            executionTarget: 'local-signer-mcp',
            executionTool: 'sign_and_broadcast_transaction',
            executionAction: 'sign_and_broadcast',
            broadcastTarget: 'allbridge-mcp',
            broadcastTool: 'broadcast_signed_transaction',
            broadcastAction: 'broadcast',
            walletSelector: {
              walletId: null,
              senderAddress: '0xsender',
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
          summary: 'Bridge 1 USDC from ETH to SOL',
          transactionShape: 'object',
          transaction: { to: '0xbridge' },
          handoff: {
            executionTarget: 'local-signer-mcp',
            executionTool: 'sign_and_broadcast_transaction',
            executionAction: 'sign_and_broadcast',
            broadcastTarget: 'allbridge-mcp',
            broadcastTool: 'broadcast_signed_transaction',
            broadcastAction: 'broadcast',
            walletSelector: {
              walletId: null,
              senderAddress: '0xsender',
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
        sourceTokenAddress: '0xsource',
        destinationTokenAddress: '0xdestination',
        transferStatusTool: 'get_transfer_status',
        transferStatusArguments: {
          sourceChain: 'ETH',
          txId: '<source transaction hash>',
        },
      },
      nextAction: 'Request an external wallet to sign and submit the approve step first. After it is confirmed, request signature for the bridge step.',
    });

    expect(job.kind).toBe('bridge_transfer');
    expect(job.mode).toBe('external_signer');
    expect(job.steps).toHaveLength(2);
    expect(job.tracking.transferStatusTool).toBe('get_transfer_status');
    expect(job.nextAction).toContain('approve step');
  });

  test('rejects execution jobs missing the handoff summary fields', () => {
    expect(() => validateBridgeExecutionJobContract({
      jobId: 'job-123',
      kind: 'bridge_transfer',
      version: 'v1',
      mode: 'external_signer',
      status: 'awaiting_signature',
      route: {},
      participants: {
        senderAddress: '0xsender',
        recipientAddress: 'recipient',
      },
      amount: {
        amountInBaseUnits: '1000000',
        amountInHumanUnits: '1',
      },
      steps: [],
      tracking: {
        sourceChain: 'ETH',
        destinationChain: 'SOL',
        sourceTokenAddress: '0xsource',
        destinationTokenAddress: '0xdestination',
        transferStatusTool: 'get_transfer_status',
        transferStatusArguments: {},
      },
      nextAction: 'Request an external wallet to sign and submit the bridge step.',
    })).toThrow('Expected handoff to be an object.');
  });
});
