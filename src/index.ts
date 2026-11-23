import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { broadcastSignedTransactionByFamily } from './chain-broadcast.js';
import { config } from './config.js';
import { createSdkGateway } from './core-gateway.js';
import { AllbridgeExplorerApiClient } from './explorer-api-client.js';
import { startStreamableHttpServer } from './http-server.js';
import { SERVER_INSTRUCTIONS } from './server-instructions.js';
import { createToolContext, registerAllbridgeTools } from './tools/index.js';

const toolContext = createToolContext({
  gateway: createSdkGateway({
    coreApiUrl: config.ALLBRIDGE_CORE_API_URL,
    sorobanNetworkPassphrase: config.ALLBRIDGE_SRB_NETWORK_PASSPHRASE,
  }),
  explorer: new AllbridgeExplorerApiClient(config.ALLBRIDGE_CORE_API_URL, config.ALLBRIDGE_API_TIMEOUT_MS),
  explorerBaseUrl: config.ALLBRIDGE_CORE_API_URL,
  broadcastSignedTransactionByFamily,
});

function createServer(): McpServer {
  const server = new McpServer(
    { name: 'allbridge-mcp', version: '0.2.0' },
    { instructions: SERVER_INSTRUCTIONS },
  );

  registerAllbridgeTools(server, toolContext);

  return server;
}

async function runStdioServer(server: McpServer): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

async function runHttpServer(): Promise<void> {
  const host = config.MCP_HOST;
  const port = config.PORT ?? config.MCP_PORT;
  await startStreamableHttpServer(createServer, host, port);
}

async function main(): Promise<void> {
  if (config.MCP_TRANSPORT === 'streamable-http') {
    await runHttpServer();
    return;
  }

  const server = createServer();
  await runStdioServer(server);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
