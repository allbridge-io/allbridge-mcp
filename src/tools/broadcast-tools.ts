import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { UserFacingToolError } from '../tool-errors.js';
import type { SignedTransaction } from '../transaction-types.js';
import { runTool, type ToolContext } from './shared.js';

const evmSignedTransactionSchema = z.object({
  chainFamily: z.literal('EVM'),
  chainId: z.number().int().positive(),
  chainSymbol: z.string().trim().min(1).optional(),
  walletId: z.string().trim().min(1).optional(),
  signedTransaction: z.string().trim().min(1),
});

const solanaSignedTransactionSchema = z.object({
  chainFamily: z.literal('SOLANA'),
  walletId: z.string().trim().min(1).optional(),
  signedTransactionHex: z.string().trim().min(1),
});

const tronSignedTransactionSchema = z.object({
  chainFamily: z.literal('TRX'),
  walletId: z.string().trim().min(1).optional(),
  signedTransaction: z.record(z.unknown()),
});

const stxSignedTransactionSchema = z.object({
  chainFamily: z.literal('STX'),
  walletId: z.string().trim().min(1).optional(),
  signedTransactionHex: z.string().trim().min(1),
});

const srbSignedTransactionSchema = z.object({
  chainFamily: z.literal('SRB'),
  walletId: z.string().trim().min(1).optional(),
  signedTransactionXdr: z.string().trim().min(1),
});

export const signedTransactionSchema = z.discriminatedUnion('chainFamily', [
  evmSignedTransactionSchema,
  solanaSignedTransactionSchema,
  tronSignedTransactionSchema,
  stxSignedTransactionSchema,
  srbSignedTransactionSchema,
]);

export const signedTransactionInputSchema = {
  chainFamily: z.enum(['EVM', 'SOLANA', 'TRX', 'STX', 'SRB']).describe('Chain family for the signed transaction.'),
  chainId: z.number().int().positive().optional().describe('Required for EVM transactions.'),
  chainSymbol: z.string().trim().min(1).optional().describe('Optional EVM chain symbol.'),
  walletId: z.string().trim().min(1).optional().describe('Optional wallet selector.'),
  signedTransaction: z.unknown().optional().describe('Signed transaction payload for EVM or Tron.'),
  signedTransactionHex: z.string().trim().min(1).optional().describe('Signed transaction hex payload for Solana, Stacks, or Soroban.'),
  signedTransactionXdr: z.string().trim().min(1).optional().describe('Signed transaction XDR payload for Soroban / Stellar.'),
};

export function registerBroadcastTools(server: McpServer, context: ToolContext): void {
  server.registerTool(
    'broadcast_signed_transaction',
    {
      title: 'Broadcast Signed Transaction',
      description:
        'Broadcast an already signed transaction (EVM, Solana, Tron, Stacks or Stellar) through the configured RPC for its chain.',
      inputSchema: signedTransactionInputSchema,
    },
    async (parsed) => runTool('Broadcast signed transaction', async () => {
      const validated = signedTransactionSchema.safeParse(parsed);
      if (!validated.success) {
        throw new UserFacingToolError('validation_error', 'The signed transaction payload does not match its chain family.', {
          chainFamily: parsed.chainFamily,
          issues: validated.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
        });
      }
      const signed = validated.data as SignedTransaction;
      const result = await context.broadcastSignedTransactionByFamily(signed);
      return result as unknown as Record<string, unknown>;
    }),
  );
}
