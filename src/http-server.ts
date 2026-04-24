import type { Server as HttpServer } from 'node:http';
import { randomUUID } from 'node:crypto';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Request, Response } from 'express';
import express from 'express';

import { createMcpAuthService } from './auth.js';
import { config } from './config.js';

export interface ManagedMcpSession {
  readonly sessionId: string | undefined;
  handleRequest(req: Request, res: Response, parsedBody?: unknown): Promise<void>;
  close(): Promise<void>;
  onClose?: () => Promise<void> | void;
}

export type CreateMcpSession = () => Promise<ManagedMcpSession>;

export interface StreamableHttpAppOptions {
  readonly maxSessions?: number;
  readonly sessionIdleTtlMs?: number;
}

interface SessionRecord {
  readonly session: ManagedMcpSession;
  inFlight: number;
  expiresAt: number;
  timeout: ReturnType<typeof setTimeout>;
}

const DEFAULT_MAX_SESSIONS = 1_000;
const DEFAULT_SESSION_IDLE_TTL_MS = 60 * 60 * 1_000;

function isInitializationRequestBody(body: unknown): boolean {
  if (!body) {
    return false;
  }

  const messages = Array.isArray(body) ? body : [body];
  return messages.some((message) => {
    if (!message || typeof message !== 'object') {
      return false;
    }

    return 'method' in message && (message as { method?: unknown }).method === 'initialize';
  });
}

function getSessionId(req: Request): string | undefined {
  const headerValue = req.get('mcp-session-id') ?? req.headers['mcp-session-id'];
  const value = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function createStreamableHttpApp(
  host: string,
  createSession: CreateMcpSession,
  options: StreamableHttpAppOptions = {},
) {
  const app = express();
  const authService = createMcpAuthService(config);
  const sessions = new Map<string, SessionRecord>();
  const maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS;
  const sessionIdleTtlMs = options.sessionIdleTtlMs ?? DEFAULT_SESSION_IDLE_TTL_MS;
  let pendingSessions = 0;

  app.set('trust proxy', true);
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));

  function withPublicBaseUrl(req: Request): string {
    return authService.getPublicBaseUrl(req);
  }

  function requireAuthorization(req: Request, res: Response): boolean {
    const authorization = authService.verifyAuthorizationHeader(req);
    if (authorization.authorized) {
      return true;
    }

    if (authorization.challenge) {
      res.setHeader('WWW-Authenticate', authorization.challenge.header);
      res.status(401).json({
        error: authorization.challenge.body,
      });
      return false;
    }

    res.status(401).json({
      error: {
        message: 'Unauthorized',
      },
    });
    return false;
  }

  function writeMetadataResponse(res: Response, payload: unknown): void {
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json(payload);
  }

  function clearSessionTimeout(record: SessionRecord): void {
    clearTimeout(record.timeout);
  }

  function removeSession(sessionId: string): SessionRecord | undefined {
    const record = sessions.get(sessionId);
    if (!record) {
      return undefined;
    }

    clearSessionTimeout(record);
    sessions.delete(sessionId);
    return record;
  }

  function scheduleSessionExpiry(sessionId: string): void {
    const record = sessions.get(sessionId);
    if (!record) {
      return;
    }

    clearSessionTimeout(record);
    record.expiresAt = Date.now() + sessionIdleTtlMs;
    record.timeout = setTimeout(() => {
      void expireSession(sessionId);
    }, sessionIdleTtlMs);
    record.timeout.unref?.();
  }

  async function closeSessionRecord(record: SessionRecord, reason: 'expiry' | 'termination' | 'cleanup'): Promise<void> {
    try {
      await record.session.close();
    } catch {
      // Session close errors are tolerated during cleanup paths.
    }
  }

  async function expireSession(sessionId: string): Promise<void> {
    const record = sessions.get(sessionId);
    if (!record) {
      return;
    }

    if (record.inFlight > 0) {
      scheduleSessionExpiry(sessionId);
      return;
    }

    if (record.expiresAt > Date.now()) {
      scheduleSessionExpiry(sessionId);
      return;
    }

    removeSession(sessionId);
    await closeSessionRecord(record, 'expiry');
  }

  function registerSession(sessionId: string, session: ManagedMcpSession): void {
    const timeout = setTimeout(() => {
      void expireSession(sessionId);
    }, sessionIdleTtlMs);
    timeout.unref?.();

    sessions.set(sessionId, {
      session,
      inFlight: 0,
      expiresAt: Date.now() + sessionIdleTtlMs,
      timeout,
    });
  }

  function cleanupExpiredSessions(): void {
    const now = Date.now();

    for (const [sessionId, record] of sessions) {
      if (record.inFlight > 0 || record.expiresAt > now) {
        continue;
      }

      removeSession(sessionId);
      void closeSessionRecord(record, 'cleanup');
    }
  }

  async function withSessionActivity<T>(
    sessionId: string,
    callback: (session: ManagedMcpSession) => Promise<T>,
  ): Promise<T> {
    const record = sessions.get(sessionId);
    if (!record) {
      throw new Error('Session not found');
    }

    record.inFlight += 1;
    scheduleSessionExpiry(sessionId);

    try {
      return await callback(record.session);
    } finally {
      const current = sessions.get(sessionId);
      if (current) {
        current.inFlight = Math.max(0, current.inFlight - 1);
        scheduleSessionExpiry(sessionId);
      }
    }
  }

  async function createAndStoreSession(req: Request, res: Response): Promise<void> {
    cleanupExpiredSessions();

    if (sessions.size + pendingSessions >= maxSessions) {
      res.status(503).json({
        jsonrpc: '2.0',
        error: {
          code: -32000,
          message: 'Too many active sessions',
        },
        id: null,
      });
      return;
    }

    pendingSessions += 1;
    let closedBeforeRegistration = false;
    let session: ManagedMcpSession | undefined;

    try {
      session = await createSession();
      const createdSession = session;
      session.onClose = () => {
        const sessionId = createdSession.sessionId;
        if (sessionId && sessions.has(sessionId)) {
          removeSession(sessionId);
          return;
        }

        closedBeforeRegistration = true;
      };

      await session.handleRequest(req, res, req.body);

      const sessionId = session.sessionId;
      if (!sessionId || closedBeforeRegistration) {
        try {
          await session.close();
        } catch {
          // Session may already be closed by the transport callback.
        }
        return;
      }

      registerSession(sessionId, session);
    } catch (error) {
      if (session) {
        try {
          await session.close();
        } catch {
          // Ignore cleanup failures so the original transport error can surface.
        }
      }
      throw error;
    } finally {
      pendingSessions = Math.max(0, pendingSessions - 1);
    }
  }

  async function routeMcpRequest(req: Request, res: Response): Promise<void> {
    if (isInitializationRequestBody(req.body)) {
      await createAndStoreSession(req, res);
      return;
    }

    const sessionId = getSessionId(req);
    if (!sessionId) {
      res.status(400).json({
        jsonrpc: '2.0',
        error: {
          code: -32000,
          message: 'Bad Request: Mcp-Session-Id header is required',
        },
        id: null,
      });
      return;
    }

    if (!sessions.has(sessionId)) {
      res.status(404).json({
        jsonrpc: '2.0',
        error: {
          code: -32001,
          message: 'Session not found',
        },
        id: null,
      });
      return;
    }

    await withSessionActivity(sessionId, async (session) => {
      await session.handleRequest(req, res, req.body);
    });
  }

  async function routeMcpTermination(req: Request, res: Response): Promise<void> {
    const sessionId = getSessionId(req);
    if (!sessionId) {
      res.status(400).json({
        jsonrpc: '2.0',
        error: {
          code: -32000,
          message: 'Bad Request: Mcp-Session-Id header is required',
        },
        id: null,
      });
      return;
    }

    const record = removeSession(sessionId);
    if (!record) {
      res.status(404).json({
        jsonrpc: '2.0',
        error: {
          code: -32001,
          message: 'Session not found',
        },
        id: null,
      });
      return;
    }

    try {
      await record.session.handleRequest(req, res);
    } finally {
      await closeSessionRecord(record, 'termination');
    }
  }

  app.get('/healthz', (_req: Request, res: Response) => {
    res.status(200).json({
      ok: true,
      transport: 'streamable-http',
    });
  });

  app.get('/.well-known/oauth-protected-resource', (req: Request, res: Response) => {
    writeMetadataResponse(res, authService.getProtectedResourceMetadata(withPublicBaseUrl(req)));
  });

  app.get('/.well-known/oauth-protected-resource/mcp', (req: Request, res: Response) => {
    writeMetadataResponse(res, authService.getProtectedResourceMetadata(withPublicBaseUrl(req)));
  });

  app.get('/.well-known/oauth-authorization-server', (req: Request, res: Response) => {
    writeMetadataResponse(res, authService.getAuthorizationServerMetadata(withPublicBaseUrl(req)));
  });

  app.get('/mcp/.well-known/oauth-protected-resource', (req: Request, res: Response) => {
    writeMetadataResponse(res, authService.getProtectedResourceMetadata(withPublicBaseUrl(req)));
  });

  app.get('/mcp/.well-known/oauth-authorization-server', (req: Request, res: Response) => {
    writeMetadataResponse(res, authService.getAuthorizationServerMetadata(withPublicBaseUrl(req)));
  });

  app.post('/register', (req: Request, res: Response) => {
    try {
      const result = authService.registerClient(req.body);
      res.status(201).json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(400).json({
        error: 'invalid_client_metadata',
        error_description: message,
      });
    }
  });

  app.get('/authorize', (req: Request, res: Response) => {
    try {
      const page = authService.renderAuthorizationPage(withPublicBaseUrl(req), req.query);
      res.status(page.status).type('html').send(page.html);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(400).json({
        error: 'invalid_request',
        error_description: message,
      });
    }
  });

  app.post('/authorize', (req: Request, res: Response) => {
    try {
      const decision = typeof req.body?.decision === 'string' ? req.body.decision : undefined;
      const response =
        decision === 'deny'
          ? authService.denyAuthorization(req.body)
          : authService.approveAuthorization(req.body);

      res.status(response.status).setHeader('Location', response.location).end();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(400).json({
        error: 'invalid_request',
        error_description: message,
      });
    }
  });

  app.post('/token', (req: Request, res: Response) => {
    try {
      const result = authService.exchangeToken(req.body);
      res.status(200).json({
        access_token: result.access_token,
        token_type: result.token_type,
        expires_in: result.expires_in,
        refresh_token: result.refresh_token,
        scope: result.scope,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(400).json({
        error: 'invalid_grant',
        error_description: message,
      });
    }
  });

  for (const path of ['/', '/mcp']) {
    app.post(path, async (req: Request, res: Response) => {
      try {
        if (!requireAuthorization(req, res)) {
          return;
        }

        await routeMcpRequest(req, res);
      } catch (error) {
        const message = error instanceof Error ? error.stack || error.message : String(error);
        process.stderr.write(`${message}\n`);

        if (!res.headersSent) {
          res.status(500).json({
            jsonrpc: '2.0',
            error: {
              code: -32603,
              message: 'Internal server error',
            },
            id: null,
          });
        }
      }
    });

    app.get(path, async (req: Request, res: Response) => {
      try {
        if (!requireAuthorization(req, res)) {
          return;
        }

        await routeMcpRequest(req, res);
      } catch (error) {
        const message = error instanceof Error ? error.stack || error.message : String(error);
        process.stderr.write(`${message}\n`);

        if (!res.headersSent) {
          res.status(500).send('Internal server error');
        }
      }
    });

    app.delete(path, async (req: Request, res: Response) => {
      try {
        if (!requireAuthorization(req, res)) {
          return;
        }

        await routeMcpTermination(req, res);
      } catch (error) {
        const message = error instanceof Error ? error.stack || error.message : String(error);
        process.stderr.write(`${message}\n`);

        if (!res.headersSent) {
          res.status(500).send('Error processing session termination');
        }
      }
    });
  }

  return app;
}

export async function startStreamableHttpServer(
  createServer: () => McpServer,
  host: string,
  port: number,
): Promise<HttpServer> {
  const app = createStreamableHttpApp(host, async () => {
    const server = createServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
    });

    let session: ManagedMcpSession;

    transport.onclose = async () => {
      await session?.onClose?.();
    };

    await server.connect(transport);

    session = {
      get sessionId() {
        return transport.sessionId;
      },
      async handleRequest(req: Request, res: Response, parsedBody?: unknown) {
        await transport.handleRequest(req, res, parsedBody);
      },
      async close() {
        await server.close();
      },
      onClose: undefined,
    };

    return session;
  });

  const listener = await new Promise<HttpServer>((resolve, reject) => {
    const currentListener = app.listen(port, host, () => {
      resolve(currentListener);
    });
    currentListener.on('error', reject);
  });

  return listener;
}
