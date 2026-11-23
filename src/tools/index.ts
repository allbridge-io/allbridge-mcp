import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { registerBroadcastTools } from './broadcast-tools.js';
import { registerCatalogTools } from './catalog-tools.js';
import { registerDestinationTools } from './destination-tools.js';
import { registerExecutionTools } from './execution-tools.js';
import { registerIntentTools } from './intent-tools.js';
import { registerQuoteTools } from './quote-tools.js';
import type { ToolContext } from './shared.js';
import { registerTrackingTools } from './tracking-tools.js';

export { createToolContext, type ToolContext } from './shared.js';

export function registerAllbridgeTools(server: McpServer, context: ToolContext): void {
  registerCatalogTools(server, context);
  registerQuoteTools(server, context);
  registerExecutionTools(server, context);
  registerIntentTools(server, context);
  registerDestinationTools(server, context);
  registerTrackingTools(server, context);
  registerBroadcastTools(server, context);
}
