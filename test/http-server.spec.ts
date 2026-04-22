import { EventEmitter } from 'node:events';

import { afterEach, describe, expect, jest, test } from '@jest/globals';
import type { Request, Response } from 'express';

import { createStreamableHttpApp, type ManagedMcpSession } from '../src/http-server.js';

type MockResponse = EventEmitter & {
  statusCode: number;
  headersSent: boolean;
  body?: unknown;
  setHeader: (name: string, value: string) => void;
  getHeader: (name: string) => string | undefined;
  status: (code: number) => MockResponse;
  json: (body: unknown) => MockResponse;
  send: (body: unknown) => MockResponse;
  type: (_contentType: string) => MockResponse;
  end: (body?: unknown) => MockResponse;
};

function createMockResponse(): MockResponse {
  const headers = new Map<string, string>();
  const response = new EventEmitter() as MockResponse;

  response.statusCode = 200;
  response.headersSent = false;
  response.setHeader = (name: string, value: string) => {
    headers.set(name.toLowerCase(), value);
  };
  response.getHeader = (name: string) => headers.get(name.toLowerCase());
  response.status = (code: number) => {
    response.statusCode = code;
    return response;
  };
  response.json = (body: unknown) => {
    response.body = body;
    response.headersSent = true;
    response.emit('finish');
    return response;
  };
  response.send = (body: unknown) => {
    response.body = body;
    response.headersSent = true;
    response.emit('finish');
    return response;
  };
  response.type = () => response;
  response.end = (body?: unknown) => {
    if (body !== undefined) {
      response.body = body;
    }
    response.headersSent = true;
    response.emit('finish');
    return response;
  };

  return response;
}

function createMockRequest(method: string, url: string, body?: unknown, sessionId?: string): Request {
  const headers: Record<string, string> = {
    host: '127.0.0.1',
    'x-forwarded-proto': 'https',
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
  };

  if (sessionId) {
    headers['mcp-session-id'] = sessionId;
  }

  return {
    method,
    url,
    body,
    headers,
    path: url,
    protocol: 'https',
    get(name: string) {
      return headers[name.toLowerCase()];
    },
  } as Request;
}

function dispatch(
  app: { handle: (req: Request, res: Response, next?: (error?: unknown) => void) => void },
  method: string,
  url: string,
  body?: unknown,
  sessionId?: string,
): Promise<MockResponse> {
  const request = createMockRequest(method, url, body, sessionId);
  const response = createMockResponse();

  return new Promise((resolve, reject) => {
    response.once('finish', () => resolve(response));
    response.once('error', reject);

    try {
      app.handle(request, response as unknown as Response);
    } catch (error) {
      reject(error);
    }
  });
}

function createSessionFactory(): {
  createSession: () => Promise<ManagedMcpSession>;
  sessionIds: Array<string>;
} {
  const sessionIds: Array<string> = [];
  let counter = 0;

  return {
    sessionIds,
    createSession: async () => {
      counter += 1;
      const sessionId = `session-${counter}`;
      sessionIds.push(sessionId);
      return {
        sessionId,
        handleRequest: async (req: Request, res: Response) => {
          res.status(200).json({
            sessionId,
            path: req.path,
            method: req.method,
            body: req.body ?? null,
          });
        },
        close: async () => {},
      };
    },
  };
}

describe('createStreamableHttpApp', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  test('routes streamable HTTP requests at the root path', async () => {
    const factory = createSessionFactory();
    const app = createStreamableHttpApp('127.0.0.1', factory.createSession);

    const response = await dispatch(app, 'POST', '/', {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {},
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({
      sessionId: 'session-1',
      path: '/',
      method: 'POST',
    });
  });

  test('keeps /mcp as a compatibility alias and supports parallel sessions', async () => {
    const factory = createSessionFactory();
    const app = createStreamableHttpApp('127.0.0.1', factory.createSession);

    const firstInit = await dispatch(app, 'POST', '/', {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {},
    });

    const secondInit = await dispatch(app, 'POST', '/mcp', {
      jsonrpc: '2.0',
      id: 2,
      method: 'initialize',
      params: {},
    });

    expect(firstInit.body).toMatchObject({ sessionId: 'session-1' });
    expect(secondInit.body).toMatchObject({ sessionId: 'session-2' });

    const firstCall = await dispatch(
      app,
      'POST',
      '/',
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/list',
        params: {},
      },
      'session-1',
    );

    const secondCall = await dispatch(
      app,
      'POST',
      '/mcp',
      {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/list',
        params: {},
      },
      'session-2',
    );

    expect(firstCall.statusCode).toBe(200);
    expect(firstCall.body).toMatchObject({
      sessionId: 'session-1',
      method: 'POST',
    });
    expect(secondCall.statusCode).toBe(200);
    expect(secondCall.body).toMatchObject({
      sessionId: 'session-2',
      method: 'POST',
    });
  });

  test('does not keep a session if it closes during initialization', async () => {
    const app = createStreamableHttpApp(
      '127.0.0.1',
      async () => {
        const session: ManagedMcpSession = {
          sessionId: 'session-early-close',
          handleRequest: async (_req: Request, res: Response) => {
            await session.onClose?.();
            res.status(200).json({ sessionId: session.sessionId });
          },
          close: async () => {},
        };

        return session;
      },
    );

    const initResponse = await dispatch(app, 'POST', '/', {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {},
    });

    expect(initResponse.statusCode).toBe(200);

    const followUp = await dispatch(
      app,
      'POST',
      '/',
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list',
        params: {},
      },
      'session-early-close',
    );

    expect(followUp.statusCode).toBe(404);
    expect(followUp.body).toMatchObject({
      error: {
        code: -32001,
        message: 'Session not found',
      },
    });
  });

  test('releases session capacity if initialization fails', async () => {
    let createCount = 0;
    const app = createStreamableHttpApp(
      '127.0.0.1',
      async () => {
        createCount += 1;
        const sessionId = `session-${createCount}`;

        return {
          sessionId,
          handleRequest: async (req: Request, res: Response) => {
            if (createCount === 1) {
              throw new Error('initialize failed');
            }

            res.status(200).json({ sessionId, method: req.method });
          },
          close: async () => {},
        };
      },
      {
        maxSessions: 1,
      },
    );

    const firstInit = await dispatch(app, 'POST', '/', {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {},
    });

    expect(firstInit.statusCode).toBe(500);

    const secondInit = await dispatch(app, 'POST', '/', {
      jsonrpc: '2.0',
      id: 2,
      method: 'initialize',
      params: {},
    });

    expect(secondInit.statusCode).toBe(200);
    expect(secondInit.body).toMatchObject({
      sessionId: 'session-2',
    });
  });

  test('removes a session even if DELETE handling fails', async () => {
    const app = createStreamableHttpApp('127.0.0.1', async () => {
      const session: ManagedMcpSession = {
        sessionId: 'session-delete-fail',
        handleRequest: async (req: Request, res: Response) => {
          if (req.method === 'DELETE') {
            throw new Error('delete failed');
          }

          res.status(200).json({
            sessionId: session.sessionId,
            method: req.method,
          });
        },
        close: async () => {},
      };

      return session;
    });

    const initResponse = await dispatch(app, 'POST', '/', {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {},
    });

    const sessionId = (initResponse.body as { sessionId?: string }).sessionId;
    expect(sessionId).toBe('session-delete-fail');

    await Promise.resolve();

    const beforeDelete = await dispatch(
      app,
      'POST',
      '/',
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list',
        params: {},
      },
      sessionId,
    );

    expect(beforeDelete.statusCode).toBe(200);

    const deleteResponse = await dispatch(
      app,
      'DELETE',
      '/',
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'shutdown',
        params: {},
      },
      sessionId,
    );

    expect(deleteResponse.statusCode).toBe(500);

    const followUp = await dispatch(
      app,
      'POST',
      '/',
      {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/list',
        params: {},
      },
      sessionId,
    );

    expect(followUp.statusCode).toBe(404);
  });

  test('expires idle sessions and enforces the session cap', async () => {
    jest.useFakeTimers();

    const factory = createSessionFactory();
    const app = createStreamableHttpApp('127.0.0.1', factory.createSession, {
      maxSessions: 1,
      sessionIdleTtlMs: 10,
    });

    const initResponse = await dispatch(app, 'POST', '/', {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {},
    });

    const sessionId = (initResponse.body as { sessionId?: string }).sessionId;
    expect(sessionId).toBe('session-1');

    const secondInit = await dispatch(app, 'POST', '/', {
      jsonrpc: '2.0',
      id: 2,
      method: 'initialize',
      params: {},
    });

    expect(secondInit.statusCode).toBe(503);
    expect(secondInit.body).toMatchObject({
      error: {
        message: 'Too many active sessions',
      },
    });

    await jest.advanceTimersByTimeAsync(11);
    await Promise.resolve();

    const afterExpiry = await dispatch(
      app,
      'POST',
      '/',
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/list',
        params: {},
      },
      sessionId,
    );

    expect(afterExpiry.statusCode).toBe(404);
  });
});
