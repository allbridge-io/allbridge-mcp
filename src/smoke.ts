import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { readFileSync } from 'node:fs';

import { validateBridgeExecutionJobContract } from './execution-job-contract.js';

type SmokeConfig = {
  apiBaseUrl: string;
  sourceTokenAddress: string;
  destinationTokenAddress: string;
  senderAddress: string;
  recipientAddress: string;
  amount: string;
  amountUnit: 'human' | 'base';
  messenger: string;
  feePaymentMethod: string;
  outputFormat: 'json' | 'base64' | 'hex';
  sourceChain?: string;
  txId?: string;
  validateHandoff: boolean;
  handoffFixturePath?: string;
};

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function loadConfig(): SmokeConfig {
  return {
    apiBaseUrl: process.env.ALLBRIDGE_API_BASE_URL ?? 'http://127.0.0.1:3000',
    sourceTokenAddress: requireEnv('SMOKE_SOURCE_TOKEN_ADDRESS'),
    destinationTokenAddress: requireEnv('SMOKE_DESTINATION_TOKEN_ADDRESS'),
    senderAddress: requireEnv('SMOKE_SENDER_ADDRESS'),
    recipientAddress: requireEnv('SMOKE_RECIPIENT_ADDRESS'),
    amount: process.env.SMOKE_AMOUNT ?? '1',
    amountUnit: (process.env.SMOKE_AMOUNT_UNIT as SmokeConfig['amountUnit'] | undefined) ?? 'human',
    messenger: requireEnv('SMOKE_MESSENGER'),
    feePaymentMethod: requireEnv('SMOKE_FEE_PAYMENT_METHOD'),
    outputFormat: (process.env.SMOKE_OUTPUT_FORMAT as SmokeConfig['outputFormat'] | undefined) ?? 'json',
    sourceChain: process.env.SMOKE_SOURCE_CHAIN,
    txId: process.env.SMOKE_TX_ID,
    validateHandoff: process.env.SMOKE_VALIDATE_HANDOFF === '1',
    handoffFixturePath: process.env.SMOKE_HANDOFF_FIXTURE,
  };
}

function loadJsonFixture(filePath: string): unknown {
  return JSON.parse(readFileSync(filePath, 'utf8')) as unknown;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const transport = new StdioClientTransport({
    command: 'node',
    args: ['dist/index.js'],
    cwd: process.cwd(),
    stderr: 'inherit',
    env: {
      ...process.env,
      ALLBRIDGE_API_BASE_URL: config.apiBaseUrl,
    } as Record<string, string>,
  });

  const client = new Client(
    { name: 'allbridge-mcp-smoke', version: '0.1.0' },
    { capabilities: {} },
  );

  await client.connect(transport);

  const quote = await client.callTool({
    name: 'quote_bridge_transfer',
    arguments: {
      sourceTokenAddress: config.sourceTokenAddress,
      destinationTokenAddress: config.destinationTokenAddress,
      amount: config.amount,
      amountUnit: config.amountUnit,
    },
  });

  const transactions = await client.callTool({
    name: 'build_bridge_transactions',
    arguments: {
      sourceTokenAddress: config.sourceTokenAddress,
      destinationTokenAddress: config.destinationTokenAddress,
      senderAddress: config.senderAddress,
      recipientAddress: config.recipientAddress,
      amount: config.amount,
      amountUnit: config.amountUnit,
      messenger: config.messenger,
      feePaymentMethod: config.feePaymentMethod,
      outputFormat: config.outputFormat,
    },
  });

  const status = config.sourceChain && config.txId
    ? await client.callTool({
        name: 'get_transfer_status',
        arguments: {
          sourceChain: config.sourceChain,
          txId: config.txId,
        },
      })
    : null;

  const handoff = config.validateHandoff
    ? validateBridgeExecutionJobContract(
        (await client.callTool({
          name: 'create_bridge_execution_job',
          arguments: {
            sourceTokenAddress: config.sourceTokenAddress,
            destinationTokenAddress: config.destinationTokenAddress,
            senderAddress: config.senderAddress,
            recipientAddress: config.recipientAddress,
            amount: config.amount,
            amountUnit: config.amountUnit,
            messenger: config.messenger,
            feePaymentMethod: config.feePaymentMethod,
            outputFormat: config.outputFormat,
          },
        })).structuredContent ?? {},
      )
    : null;

  const handoffFixture = config.handoffFixturePath
    ? validateBridgeExecutionJobContract(loadJsonFixture(config.handoffFixturePath))
    : null;

  const result: Record<string, unknown> = {
    quote: quote.structuredContent ?? quote.content,
    transactions: transactions.structuredContent ?? transactions.content,
    status: status ? status.structuredContent ?? status.content : null,
  };

  if (handoff) {
    result.handoff = handoff;
  }

  if (handoffFixture) {
    result.handoffFixture = handoffFixture;
  }

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);

  await client.close();
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
