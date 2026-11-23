import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { validateAddressForChainType } from '../chain-catalog.js';
import { createBridgeExecutionJob } from '../execution.js';
import { detectMessengers } from '../messengers.js';
import { UserFacingToolError } from '../tool-errors.js';
import { resolveTokenPairByAddress, tokenPairByAddressSchema } from './quote-tools.js';
import {
  amountUnitSchema,
  feePaymentMethodSchema,
  messengerSchema,
  normalizeAmount,
  optionalText,
  optionalTextSchema,
  requireText,
  requiredTextSchema,
  runTool,
  type ToolContext,
} from './shared.js';

export function registerExecutionTools(server: McpServer, context: ToolContext): void {
  server.registerTool(
    'create_bridge_execution_job',
    {
      title: 'Create Bridge Execution Job',
      description:
        'Build an ordered execution job for a transfer: the quote, an advisory balance check, destination prerequisites, and signer-ready transactions (allowance reset when needed, approve when needed, bridge). Each step transaction can be passed as is to local-signer-mcp sign_and_broadcast_transaction. NEAR_INTENTS: the job creates a one-time deposit and the bridge step transfers to it. LIFI_INTENTS: the bridge step has no transaction yet; call its build.tool (create_lifi_intents_order) right before signing. Source chains: EVM, Solana, Tron, Stacks, Stellar.',
      inputSchema: {
        ...tokenPairByAddressSchema,
        senderAddress: requiredTextSchema('Sender address on the source chain. Do not pass null.'),
        recipientAddress: requiredTextSchema('Recipient address on the destination chain. Do not pass null.'),
        walletId: optionalTextSchema('Optional local-signer-mcp wallet id to pin the steps to.'),
        amount: requiredTextSchema('Amount to send. Do not pass null.'),
        amountUnit: amountUnitSchema,
        messenger: messengerSchema,
        feePaymentMethod: feePaymentMethodSchema,
        maxSlippagePercent: z
          .number()
          .min(0)
          .max(5)
          .optional()
          .describe('LIFI_INTENTS only: how far (percent) below the quote the order may price before create_lifi_intents_order stops with price_changed. Default 0.5.'),
      },
    },
    async (parsed) => runTool('Create bridge execution job', async () => {
      const catalog = await context.loadCatalog();
      const { sourceToken, destinationToken } = resolveTokenPairByAddress(catalog, parsed);
      const senderAddress = requireText(parsed.senderAddress, 'senderAddress');
      const recipientAddress = requireText(parsed.recipientAddress, 'recipientAddress');
      validateAddressForChainType(senderAddress, sourceToken.chainType, 'senderAddress');
      validateAddressForChainType(recipientAddress, destinationToken.chainType, 'recipientAddress');

      const availableMessengers = detectMessengers(sourceToken, destinationToken);
      if (!availableMessengers.includes(parsed.messenger)) {
        throw new UserFacingToolError('unsupported_route', `${parsed.messenger} does not support this route.`, {
          messenger: parsed.messenger,
          availableMessengers,
        });
      }

      return createBridgeExecutionJob(context.gateway, {
        sourceToken,
        destinationToken,
        senderAddress,
        recipientAddress,
        walletId: optionalText(parsed.walletId),
        amount: normalizeAmount(requireText(parsed.amount, 'amount'), parsed.amountUnit, sourceToken),
        messenger: parsed.messenger,
        feePaymentMethod: parsed.feePaymentMethod ?? 'WITH_NATIVE_CURRENCY',
        maxSlippagePercent: parsed.maxSlippagePercent,
      });
    }),
  );
}
