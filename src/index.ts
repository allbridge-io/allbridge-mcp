import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { AllbridgeApiClient } from './allbridge-api-client.js';
import { AllbridgeExplorerApiClient } from './explorer-api-client.js';
import { config } from './config.js';
import { startStreamableHttpServer } from './http-server.js';
import { NextApiClient } from './next-api-client.js';
import { registerNextTools } from './next-tools.js';
import { registerAllbridgeTools } from './tools.js';

function createServer(): McpServer {
  const server = new McpServer({
    name: 'allbridge-mcp',
    version: '0.1.0',
  });

  const apiClient = new AllbridgeApiClient(
    config.ALLBRIDGE_API_BASE_URL,
    config.ALLBRIDGE_API_TIMEOUT_MS,
  );
  const explorerClient = new AllbridgeExplorerApiClient(
    config.ALLBRIDGE_EXPLORER_API_BASE_URL,
    config.ALLBRIDGE_API_TIMEOUT_MS,
  );
  const nextClient = new NextApiClient(
    config.ALLBRIDGE_NEXT_API_BASE_URL,
    config.ALLBRIDGE_API_TIMEOUT_MS,
  );

  registerAllbridgeTools(server, apiClient, explorerClient, undefined, nextClient);
  registerNextTools(server, nextClient);

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
