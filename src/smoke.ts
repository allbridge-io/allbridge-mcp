/**
 * Smoke test against the live Allbridge Core API: starts the built server over stdio, plans a
 * transfer, builds an execution job and validates it against the job contract. Never signs or sends.
 *
 * Defaults: 10 USDC from Ethereum to Arbitrum through CCTP_V2. Override with SMOKE_* variables:
 * SMOKE_SOURCE_CHAIN, SMOKE_DESTINATION_CHAIN, SMOKE_TOKEN_SYMBOL, SMOKE_DESTINATION_TOKEN_SYMBOL,
 * SMOKE_AMOUNT, SMOKE_MESSENGER, SMOKE_FEE_PAYMENT_METHOD, SMOKE_SENDER_ADDRESS,
 * SMOKE_RECIPIENT_ADDRESS, and SMOKE_TX_ID (with SMOKE_SOURCE_CHAIN) to also check a transfer status.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import { validateBridgeExecutionJobContract } from './execution-job-contract.js';

type ToolOutput = Record<string, unknown>;

const env = (name: string, fallback: string) => process.env[name]?.trim() || fallback;

const settings = {
  sourceChain: env('SMOKE_SOURCE_CHAIN', 'ETH'),
  destinationChain: env('SMOKE_DESTINATION_CHAIN', 'ARB'),
  tokenSymbol: env('SMOKE_TOKEN_SYMBOL', 'USDC'),
  destinationTokenSymbol: process.env.SMOKE_DESTINATION_TOKEN_SYMBOL?.trim(),
  amount: env('SMOKE_AMOUNT', '10'),
  messenger: env('SMOKE_MESSENGER', 'CCTP_V2'),
  feePaymentMethod: env('SMOKE_FEE_PAYMENT_METHOD', 'WITH_NATIVE_CURRENCY'),
  senderAddress: env('SMOKE_SENDER_ADDRESS', '0x1111111111111111111111111111111111111111'),
  recipientAddress: env('SMOKE_RECIPIENT_ADDRESS', '0x1111111111111111111111111111111111111111'),
  txId: process.env.SMOKE_TX_ID?.trim(),
};

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<ToolOutput> {
  const result = await client.callTool({ name, arguments: args });
  const output = (result.structuredContent ?? {}) as ToolOutput;
  if (result.isError) {
    throw new Error(`${name} failed: ${JSON.stringify(output.error ?? output)}`);
  }
  return output;
}

async function main(): Promise<void> {
  const transport = new StdioClientTransport({
    command: 'node',
    args: ['dist/index.js'],
    cwd: process.cwd(),
    stderr: 'inherit',
    env: { ...process.env, MCP_TRANSPORT: 'stdio' } as Record<string, string>,
  });
  const client = new Client({ name: 'allbridge-mcp-smoke', version: '0.2.0' }, { capabilities: {} });
  await client.connect(transport);

  try {
    const tools = (await client.listTools()).tools.map((tool) => tool.name).sort();
    const chains = await call(client, 'list_supported_chains', {});

    const plan = await call(client, 'plan_bridge_transfer', {
      sourceChain: settings.sourceChain,
      destinationChain: settings.destinationChain,
      sourceTokenSymbol: settings.tokenSymbol,
      ...(settings.destinationTokenSymbol ? { destinationTokenSymbol: settings.destinationTokenSymbol } : {}),
      amount: settings.amount,
    });
    const route = plan.route as { source: { tokenAddress: string; chainSymbol: string }; destination: { tokenAddress: string; chainSymbol: string } };

    const job = validateBridgeExecutionJobContract(await call(client, 'create_bridge_execution_job', {
      sourceTokenAddress: route.source.tokenAddress,
      sourceChain: route.source.chainSymbol,
      destinationTokenAddress: route.destination.tokenAddress,
      destinationChain: route.destination.chainSymbol,
      senderAddress: settings.senderAddress,
      recipientAddress: settings.recipientAddress,
      amount: settings.amount,
      messenger: settings.messenger,
      feePaymentMethod: settings.feePaymentMethod,
    }));

    const status = settings.txId
      ? await call(client, 'get_transfer_status', { sourceChain: settings.sourceChain, txId: settings.txId })
      : null;

    process.stdout.write(`${JSON.stringify({
      tools,
      chains: (chains.chains as Array<{ chainSymbol: string }>).map((chain) => chain.chainSymbol),
      plan: { options: plan.options, unavailableOptions: plan.unavailableOptions },
      job: { status: job.status, steps: job.steps.map((step) => ({ id: step.id, status: step.status, format: step.transactionFormat, built: step.transaction !== null })) },
      status,
    }, null, 2)}\n`);
  } finally {
    await client.close();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
