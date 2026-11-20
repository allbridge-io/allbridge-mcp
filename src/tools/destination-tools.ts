import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { validateAddressForChainType } from '../chain-catalog.js';
import { checkStellarTrustline } from '../destination-setup.js';
import { toUnsignedTransaction } from '../unsigned-transaction.js';
import { resolveTokenByAddressFromCatalog } from '../chain-catalog.js';
import { UserFacingToolError } from '../tool-errors.js';
import {
  optionalText,
  optionalTextSchema,
  requireText,
  requiredTextSchema,
  runTool,
  type ToolContext,
} from './shared.js';

export function registerDestinationTools(server: McpServer, context: ToolContext): void {
  async function resolveStellarToken(tokenAddress: string) {
    const catalog = await context.loadCatalog();
    const token = resolveTokenByAddressFromCatalog(catalog, tokenAddress, 'tokenAddress');
    if (token.chainType !== 'SRB' || token.isNative) {
      throw new UserFacingToolError('validation_error', 'Trustlines apply only to non-native Stellar tokens.', {
        tokenAddress,
        chainSymbol: token.chainSymbol,
      });
    }
    return token;
  }

  server.registerTool(
    'check_stellar_trustline',
    {
      title: 'Check Stellar Trustline',
      description:
        'Check whether a Stellar account has a trustline for a Stellar token, which it needs before it can receive the token.',
      inputSchema: {
        address: requiredTextSchema('Stellar account address (G...). Do not pass null.'),
        tokenAddress: requiredTextSchema('Stellar token contract address as listed by list_supported_tokens. Do not pass null.'),
      },
    },
    async (parsed) => runTool('Check Stellar trustline', async () => {
      const address = requireText(parsed.address, 'address');
      validateAddressForChainType(address, 'SRB', 'address');
      const token = await resolveStellarToken(requireText(parsed.tokenAddress, 'tokenAddress'));
      const { hasTrustline, balanceLine } = await checkStellarTrustline(context.gateway, address, token.tokenAddress);

      return {
        address,
        tokenAddress: token.tokenAddress,
        symbol: token.symbol,
        required: !hasTrustline,
        balanceLine,
        nextAction: hasTrustline
          ? 'The account already has a trustline for this token.'
          : 'The account owner must sign the transaction from build_stellar_trustline_transaction before receiving this token.',
      };
    }),
  );

  server.registerTool(
    'build_stellar_trustline_transaction',
    {
      title: 'Build Stellar Trustline Transaction',
      description:
        'Build an unsigned Stellar changeTrust transaction that adds a trustline for a Stellar token. The recipient account must sign and submit it.',
      inputSchema: {
        accountAddress: requiredTextSchema('Stellar account address (G...) that will hold the trustline. Do not pass null.'),
        tokenAddress: requiredTextSchema('Stellar token contract address as listed by list_supported_tokens. Do not pass null.'),
        limit: optionalTextSchema('Optional trustline limit in token units. Defaults to the maximum.'),
        walletId: optionalTextSchema('Optional local-signer-mcp wallet id.'),
      },
    },
    async (parsed) => runTool('Build Stellar trustline transaction', async () => {
      const accountAddress = requireText(parsed.accountAddress, 'accountAddress');
      validateAddressForChainType(accountAddress, 'SRB', 'accountAddress');
      const token = await resolveStellarToken(requireText(parsed.tokenAddress, 'tokenAddress'));
      const xdr = await context.gateway.buildStellarTrustlineTransaction({
        sender: accountAddress,
        tokenAddress: token.tokenAddress,
        limit: optionalText(parsed.limit),
      });

      return {
        accountAddress,
        tokenAddress: token.tokenAddress,
        symbol: token.symbol,
        transactionFormat: 'stellarTransactionXdr',
        transaction: toUnsignedTransaction(xdr, token, optionalText(parsed.walletId)),
        nextAction: 'The account owner signs and submits this transaction (local-signer-mcp sign_and_broadcast_transaction), then the transfer can be delivered.',
      };
    }),
  );
}
