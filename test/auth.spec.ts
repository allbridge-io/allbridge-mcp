import { describe, expect, it } from '@jest/globals';
import type { Request } from 'express';
import type { AppConfig } from '../src/config.js';
import {
  createMcpAuthService,
  createPkceChallenge,
  normalizePublicBaseUrl,
} from '../src/auth.js';

function createOauthConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    ALLBRIDGE_API_BASE_URL: 'http://127.0.0.1:3000',
    ALLBRIDGE_API_TIMEOUT_MS: 20_000,
    ALLBRIDGE_EXPLORER_API_BASE_URL: 'https://explorer.api.allbridgecoreapi.net',
    MCP_AUTH_MODE: 'oauth',
    MCP_TRANSPORT: 'streamable-http',
    MCP_HOST: '0.0.0.0',
    MCP_PORT: 3000,
    PORT: undefined,
    MCP_PUBLIC_BASE_URL: 'https://mcp.example.com',
    MCP_BEARER_TOKEN: undefined,
    MCP_OAUTH_ISSUER_NAME: 'Allbridge MCP',
    MCP_OAUTH_SCOPE: 'allbridge.mcp',
    MCP_OAUTH_ACCESS_TOKEN_TTL_SECONDS: 3600,
    MCP_OAUTH_REFRESH_TOKEN_TTL_SECONDS: 60 * 60 * 24 * 30,
    MCP_OAUTH_AUTH_CODE_TTL_SECONDS: 600,
    ALLBRIDGE_EVM_RPC_URL: undefined,
    ALLBRIDGE_SOL_RPC_URL: undefined,
    ALLBRIDGE_TRX_RPC_URL: undefined,
    ALLBRIDGE_ALG_RPC_URL: undefined,
    ALLBRIDGE_STX_RPC_URL: undefined,
    ALLBRIDGE_SRB_RPC_URL: undefined,
    ALLBRIDGE_SRB_NETWORK_PASSPHRASE: undefined,
    ALLBRIDGE_SUI_RPC_URL: undefined,
    ...overrides,
  };
}

function createBearerConfig(token: string): AppConfig {
  return createOauthConfig({
    MCP_AUTH_MODE: 'bearer',
    MCP_BEARER_TOKEN: token,
  });
}

function createRequest(authorization?: string): Request {
  return {
    protocol: 'https',
    headers: { host: 'mcp.example.com' },
    get(name: string) {
      const normalized = name.toLowerCase();
      if (normalized === 'authorization') {
        return authorization;
      }
      if (normalized === 'host') {
        return 'mcp.example.com';
      }
      if (normalized === 'x-forwarded-proto') {
        return 'https';
      }
      return undefined;
    },
  } as Request;
}

describe('McpAuthService', () => {
  it('issues metadata and completes an oauth authorization code flow', () => {
    const auth = createMcpAuthService(createOauthConfig());
    const baseUrl = 'https://mcp.example.com';

    expect(normalizePublicBaseUrl('https://mcp.example.com/mcp')).toBe(baseUrl);

    expect(auth.getProtectedResourceMetadata(baseUrl)).toMatchObject({
      resource: 'https://mcp.example.com',
      authorization_servers: ['https://mcp.example.com'],
      resource_name: 'Allbridge MCP',
    });

    expect(auth.getAuthorizationServerMetadata(baseUrl)).toMatchObject({
      issuer: 'https://mcp.example.com',
      authorization_endpoint: 'https://mcp.example.com/authorize',
      token_endpoint: 'https://mcp.example.com/token',
      registration_endpoint: 'https://mcp.example.com/register',
      scopes_supported: ['allbridge.mcp'],
    });

    const client = auth.registerClient({
      client_name: 'Test Client',
      redirect_uris: ['https://client.example/callback'],
      token_endpoint_auth_method: 'none',
    });

    const codeVerifier = 'test-code-verifier-123456789';
    const authorization = auth.approveAuthorization({
      client_id: client.client_id,
      redirect_uri: 'https://client.example/callback',
      response_type: 'code',
      scope: 'allbridge.mcp',
      code_challenge: createPkceChallenge(codeVerifier),
      code_challenge_method: 'S256',
    });

    const authorizationUrl = new URL(authorization.location);
    const code = authorizationUrl.searchParams.get('code');

    expect(code).toBeTruthy();

    const token = auth.exchangeToken({
      grant_type: 'authorization_code',
      code: code ?? undefined,
      redirect_uri: 'https://client.example/callback',
      client_id: client.client_id,
      code_verifier: codeVerifier,
    });

    expect(token.token_type).toBe('Bearer');
    expect(token.scope).toBe('allbridge.mcp');

    expect(auth.verifyAuthorizationHeader(createRequest(`Bearer ${token.access_token}`))).toEqual({
      authorized: true,
    });
  });

  it('defaults redirect URIs for dynamic client registration when omitted', () => {
    const auth = createMcpAuthService(createOauthConfig());

    const client = auth.registerClient({
      client_name: 'Test Client',
      token_endpoint_auth_method: 'none',
    });

    expect(client.redirect_uris).toEqual([
      'http://127.0.0.1:3000/callback',
      'http://localhost:3000/callback',
    ]);
  });

  it('supports bearer token authorization', () => {
    const auth = createMcpAuthService(createBearerConfig('super-secret-static-token'));

    expect(auth.verifyAuthorizationHeader(createRequest('Bearer super-secret-static-token'))).toEqual({
      authorized: true,
    });

    expect(auth.verifyAuthorizationHeader(createRequest('Bearer wrong-token'))).toMatchObject({
      authorized: false,
    });
  });
});
