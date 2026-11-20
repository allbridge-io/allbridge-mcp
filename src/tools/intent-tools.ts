import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { validateAddressForChainType } from '../chain-catalog.js';
import { createLifiOrderStep } from '../lifi-order.js';
import { detectMessengers } from '../messengers.js';
import { UserFacingToolError } from '../tool-errors.js';
import { resolveTokenPairByAddress, tokenPairByAddressSchema } from './quote-tools.js';
import {
  amountUnitSchema,
  baseUnitsToTokenAmount,
  normalizeAmount,
  optionalText,
  optionalTextSchema,
  requireText,
  requiredTextSchema,
  runTool,
  type ToolContext,
} from './shared.js';

export function registerIntentTools(server: McpServer, context: ToolContext): void {
  server.registerTool(
    'create_lifi_intents_order',
    {
      title: 'Create LI.FI Intents Order',
      description:
        'Build step for LI.FI Intents transfers: creates the order and returns the bridge step with a signer-ready transaction. Call it with the build.arguments of the job bridge step, after any approval is confirmed, and sign the result at once: the order is valid for 40-120 seconds. Stops with price_changed when the order pays less than minAmountToReceive and with approval_required when the allowance is missing.',
      inputSchema: {
        ...tokenPairByAddressSchema,
        senderAddress: requiredTextSchema('Sender address on the source chain. Do not pass null.'),
        recipientAddress: requiredTextSchema('Recipient address on the destination chain. Do not pass null.'),
        walletId: optionalTextSchema('Optional local-signer-mcp wallet id.'),
        amount: requiredTextSchema('Amount to send. Do not pass null.'),
        amountUnit: amountUnitSchema,
        minAmountToReceive: optionalTextSchema('Minimum amount to receive in destination token base units; the job bridge step provides it.'),
      },
    },
    async (parsed) => runTool('Create LI.FI Intents order', async () => {
      const catalog = await context.loadCatalog();
      const { sourceToken, destinationToken } = resolveTokenPairByAddress(catalog, parsed);
      const senderAddress = requireText(parsed.senderAddress, 'senderAddress');
      const recipientAddress = requireText(parsed.recipientAddress, 'recipientAddress');
      validateAddressForChainType(senderAddress, sourceToken.chainType, 'senderAddress');
      validateAddressForChainType(recipientAddress, destinationToken.chainType, 'recipientAddress');

      if (!detectMessengers(sourceToken, destinationToken).includes('LIFI_INTENTS')) {
        throw new UserFacingToolError('unsupported_route', 'LI.FI Intents does not support this route.', {
          availableMessengers: detectMessengers(sourceToken, destinationToken),
        });
      }

      const minAmount = optionalText(parsed.minAmountToReceive);
      if (minAmount !== undefined && !/^\d+$/.test(minAmount)) {
        throw new UserFacingToolError('validation_error', 'minAmountToReceive must be an integer in destination token base units.', {
          minAmountToReceive: minAmount,
        });
      }

      return createLifiOrderStep(context.gateway, {
        sourceToken,
        destinationToken,
        senderAddress,
        recipientAddress,
        walletId: optionalText(parsed.walletId),
        amount: normalizeAmount(requireText(parsed.amount, 'amount'), parsed.amountUnit, sourceToken),
        minAmountToReceive: minAmount === undefined ? undefined : baseUnitsToTokenAmount(minAmount, destinationToken.decimals),
      });
    }),
  );

  server.registerTool(
    'submit_near_intents_deposit',
    {
      title: 'Submit NEAR Intents Deposit',
      description:
        'Optional, after a NEAR Intents bridge step is broadcast: tells NEAR Intents the deposit transaction hash so it detects the deposit sooner. Use the intent.submitDepositArguments of the job with the real hash.',
      inputSchema: {
        depositAddress: requiredTextSchema('Deposit address from the job intent. Do not pass null.'),
        depositMemo: optionalTextSchema('Deposit memo from the job intent, when it has one (Stellar).'),
        txId: requiredTextSchema('Hash of the broadcast deposit transaction. Do not pass null.'),
      },
    },
    async (parsed) => runTool('Submit NEAR Intents deposit', async () => {
      const depositAddress = requireText(parsed.depositAddress, 'depositAddress');
      const txId = requireText(parsed.txId, 'txId');
      const depositMemo = optionalText(parsed.depositMemo);
      await context.gateway.submitNearIntentsDeposit({ depositAddress, txId, ...(depositMemo ? { depositMemo } : {}) });

      return {
        submitted: true,
        depositAddress,
        txId,
        nextAction: 'Track the transfer with get_transfer_status using the source chain and this transaction hash.',
      };
    }),
  );
}
