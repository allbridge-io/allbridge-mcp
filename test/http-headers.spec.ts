import http from 'node:http';

import { describe, expect, test } from '@jest/globals';

import { AllbridgeApiClient } from '../src/allbridge-api-client.js';
import { AllbridgeExplorerApiClient } from '../src/explorer-api-client.js';
import { ALLBRIDGE_MCP_CLIENT_HEADER_NAME, ALLBRIDGE_MCP_CLIENT_HEADER_VALUE } from '../src/http-headers.js';

function createServer(
  handler: (req: http.IncomingMessage) => Promise<unknown> | unknown,
): Promise<{ server: http.Server; url: string }> {
  return new Promise((resolve) => {
    const server = http.createServer(async (req, res) => {
      const body = await handler(req);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    });

    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        throw new Error('Unable to bind test server.');
      }

      resolve({ server, url: `http://127.0.0.1:${address.port}` });
    });
  });
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

describe('Allbridge HTTP headers', () => {
  test('attaches the MCP client header to rest api requests', async () => {
    let clientHeader: string | string[] | undefined;
    const { server, url } = await createServer((req) => {
      clientHeader = req.headers[ALLBRIDGE_MCP_CLIENT_HEADER_NAME.toLowerCase()];
      return { result: '1' };
    });

    try {
      const client = new AllbridgeApiClient(url, 5_000);
      const response = await client.getTokenBalance({ address: '0xabc', token: '0xdef' });

      expect(clientHeader).toBe(ALLBRIDGE_MCP_CLIENT_HEADER_VALUE);
      expect(response).toEqual({ result: '1' });
    } finally {
      await closeServer(server);
    }
  });

  test('attaches the MCP client header to explorer requests', async () => {
    let clientHeader: string | string[] | undefined;
    const { server, url } = await createServer((req) => {
      clientHeader = req.headers[ALLBRIDGE_MCP_CLIENT_HEADER_NAME.toLowerCase()];
      return [];
    });

    try {
      const client = new AllbridgeExplorerApiClient(url, 5_000);
      const response = await client.search('test');

      expect(clientHeader).toBe(ALLBRIDGE_MCP_CLIENT_HEADER_VALUE);
      expect(response).toEqual([]);
    } finally {
      await closeServer(server);
    }
  });
});
