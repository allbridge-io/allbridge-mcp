import type { Request } from 'express';
import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';

import type { AppConfig } from './config.js';

const authModeSchema = z.enum(['none', 'bearer', 'oauth']);

const registerClientSchema = z.object({
  client_name: z.string().trim().optional(),
  redirect_uris: z.array(z.string().trim().url()).optional(),
  grant_types: z.array(z.string().trim().min(1)).optional(),
  response_types: z.array(z.string().trim().min(1)).optional(),
  token_endpoint_auth_method: z.enum(['none', 'client_secret_post', 'client_secret_basic']).optional(),
  scope: z.string().trim().optional(),
});

const authorizeRequestSchema = z.object({
  client_id: z.string().trim().min(1),
  redirect_uri: z.string().trim().url(),
  response_type: z.string().trim().default('code'),
  scope: z.string().trim().optional(),
  state: z.string().trim().optional(),
  code_challenge: z.string().trim().min(1),
  code_challenge_method: z.enum(['S256']).default('S256'),
});

const tokenRequestSchema = z.object({
  grant_type: z.enum(['authorization_code', 'refresh_token', 'client_credentials']),
  code: z.string().trim().optional(),
  redirect_uri: z.string().trim().url().optional(),
  client_id: z.string().trim().optional(),
  client_secret: z.string().trim().optional(),
  code_verifier: z.string().trim().optional(),
  refresh_token: z.string().trim().optional(),
  scope: z.string().trim().optional(),
});

type AuthMode = z.infer<typeof authModeSchema>;

interface RegisteredClient {
  clientId: string;
  clientName: string;
  redirectUris: string[];
  grantTypes: string[];
  responseTypes: string[];
  tokenEndpointAuthMethod: 'none' | 'client_secret_post' | 'client_secret_basic';
  clientSecret?: string;
  scope: string;
  createdAt: number;
}

interface AuthorizationCodeRecord {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: 'S256';
  scope: string;
  expiresAt: number;
}

interface AccessTokenRecord {
  clientId: string;
  scope: string;
  expiresAt: number;
  refreshToken: string;
}

interface RefreshTokenRecord {
  clientId: string;
  scope: string;
  expiresAt: number;
}

interface ParsedAuthorizationRequest {
  clientId: string;
  redirectUri: string;
  responseType: string;
  scope: string;
  state?: string;
  codeChallenge: string;
  codeChallengeMethod: 'S256';
}

interface ParsedTokenRequest {
  grantType: 'authorization_code' | 'refresh_token' | 'client_credentials';
  code?: string;
  redirectUri?: string;
  clientId?: string;
  clientSecret?: string;
  codeVerifier?: string;
  refreshToken?: string;
  scope?: string;
}

function base64Url(bytes: Buffer): string {
  return bytes.toString('base64url');
}

function createRandomToken(byteLength = 32): string {
  return base64Url(randomBytes(byteLength));
}

function normalizeString(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length === 0 ? undefined : trimmed;
  }

  if (Array.isArray(value) && value.length > 0) {
    return normalizeString(value[0]);
  }

  return undefined;
}

function flattenRecord(record: Record<string, unknown>): Record<string, unknown> {
  const flattened: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(record)) {
    flattened[key] = Array.isArray(value) ? value[0] : value;
  }

  return flattened;
}

function readStringArray(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    const filtered = value.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter((item) => item.length > 0);
    return filtered.length > 0 ? filtered : undefined;
  }

  const normalized = normalizeString(value);
  return normalized ? [normalized] : undefined;
}

function toUrlOrigin(value: string): string {
  const url = new URL(value);
  return url.origin;
}

function isLocalhostRedirect(redirectUri: string): boolean {
  try {
    const url = new URL(redirectUri);
    return url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  } catch {
    return false;
  }
}

function isAllowedRedirectUri(redirectUri: string): boolean {
  try {
    const url = new URL(redirectUri);
    return url.protocol === 'https:' || isLocalhostRedirect(url.toString());
  } catch {
    return false;
  }
}

function buildCodeChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

const defaultRedirectUris = [
  'http://127.0.0.1:3000/callback',
  'http://localhost:3000/callback',
];

export interface ProtectedResourceMetadata {
  resource: string;
  authorization_servers: string[];
  resource_name: string;
  resource_documentation: string;
}

export interface AuthorizationServerMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint: string;
  scopes_supported: string[];
  response_types_supported: string[];
  grant_types_supported: string[];
  code_challenge_methods_supported: string[];
  token_endpoint_auth_methods_supported: string[];
  client_id_metadata_document_supported: boolean;
}

export interface RegisterClientResponse {
  client_id: string;
  client_id_issued_at: number;
  client_secret?: string;
  client_secret_expires_at: number;
  redirect_uris: string[];
  grant_types: string[];
  response_types: string[];
  token_endpoint_auth_method: 'none' | 'client_secret_post' | 'client_secret_basic';
  scope: string;
}

export interface AuthorizationPageResponse {
  status: number;
  html: string;
}

export interface AuthorizationDecisionResponse {
  status: number;
  location: string;
}

export interface TokenResponse {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  refresh_token: string;
  scope: string;
}

export interface AuthChallenge {
  header: string;
  body: Record<string, unknown>;
}

export class McpAuthService {
  private readonly mode: AuthMode;

  private readonly scope: string;

  private readonly publicBaseUrl?: string;

  private readonly issuerName: string;

  private readonly accessTokenTtlSeconds: number;

  private readonly refreshTokenTtlSeconds: number;

  private readonly authorizationCodeTtlSeconds: number;

  private readonly bearerToken?: string;

  private readonly clients = new Map<string, RegisteredClient>();

  private readonly authorizationCodes = new Map<string, AuthorizationCodeRecord>();

  private readonly accessTokens = new Map<string, AccessTokenRecord>();

  private readonly refreshTokens = new Map<string, RefreshTokenRecord>();

  constructor(config: AppConfig) {
    this.mode = authModeSchema.parse(config.MCP_AUTH_MODE);
    this.scope = config.MCP_OAUTH_SCOPE;
    this.publicBaseUrl = config.MCP_PUBLIC_BASE_URL;
    this.issuerName = config.MCP_OAUTH_ISSUER_NAME;
    this.accessTokenTtlSeconds = config.MCP_OAUTH_ACCESS_TOKEN_TTL_SECONDS;
    this.refreshTokenTtlSeconds = config.MCP_OAUTH_REFRESH_TOKEN_TTL_SECONDS;
    this.authorizationCodeTtlSeconds = config.MCP_OAUTH_AUTH_CODE_TTL_SECONDS;
    this.bearerToken = config.MCP_BEARER_TOKEN;

    if (this.mode === 'bearer' && !this.bearerToken) {
      throw new Error('MCP_BEARER_TOKEN is required when MCP_AUTH_MODE=bearer.');
    }
  }

  getMode(): AuthMode {
    return this.mode;
  }

  getScope(): string {
    return this.scope;
  }

  getPublicBaseUrl(req?: Request): string {
    if (this.publicBaseUrl) {
      return this.publicBaseUrl;
    }

    if (!req) {
      throw new Error('Unable to determine public base URL.');
    }

    const host = normalizeString(req.get('host')) ?? normalizeString(req.headers.host);
    const protocol = normalizeString(req.get('x-forwarded-proto')) ?? req.protocol;

    if (!host) {
      throw new Error('Unable to determine public host.');
    }

    return `${protocol}://${host}`;
  }

  getProtectedResourceMetadata(baseUrl: string): ProtectedResourceMetadata {
    return {
      resource: baseUrl,
      authorization_servers: [baseUrl],
      resource_name: this.issuerName,
      resource_documentation: baseUrl,
    };
  }

  getAuthorizationServerMetadata(baseUrl: string): AuthorizationServerMetadata {
    return {
      issuer: baseUrl,
      authorization_endpoint: new URL('/authorize', baseUrl).toString(),
      token_endpoint: new URL('/token', baseUrl).toString(),
      registration_endpoint: new URL('/register', baseUrl).toString(),
      scopes_supported: [this.scope],
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token', 'client_credentials'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
      client_id_metadata_document_supported: false,
    };
  }

  getChallenge(baseUrl: string): AuthChallenge {
    const metadataUrl = new URL('/.well-known/oauth-protected-resource', baseUrl).toString();
    return {
      header: `Bearer realm="${this.issuerName}", resource_metadata="${metadataUrl}", scope="${this.scope}"`,
      body: {
        error: 'unauthorized',
        message: 'Authorization required',
        resource_metadata: metadataUrl,
      },
    };
  }

  isAuthorized(req: Request): boolean {
    if (this.mode === 'none') {
      return true;
    }

    const authorization = normalizeString(req.get('authorization'));
    if (!authorization?.toLowerCase().startsWith('bearer ')) {
      return false;
    }

    const token = authorization.slice('bearer '.length).trim();
    if (token.length === 0) {
      return false;
    }

    if (this.mode === 'bearer') {
      return token === this.bearerToken;
    }

    const record = this.accessTokens.get(token);
    if (!record) {
      return false;
    }

    if (record.expiresAt <= Date.now()) {
      this.accessTokens.delete(token);
      this.refreshTokens.delete(record.refreshToken);
      return false;
    }

    return true;
  }

  registerClient(input: unknown): RegisterClientResponse {
    this.sweepExpired();

    const raw = input as Record<string, unknown>;
    const parsed = registerClientSchema.parse({
      client_name: normalizeString(raw.client_name),
      redirect_uris: readStringArray(raw.redirect_uris),
      grant_types: readStringArray(raw.grant_types),
      response_types: readStringArray(raw.response_types),
      token_endpoint_auth_method: normalizeString(raw.token_endpoint_auth_method) as
        | 'none'
        | 'client_secret_post'
        | 'client_secret_basic'
        | undefined,
      scope: normalizeString(raw.scope),
    });
    const clientId = `allbridge-${createRandomToken(16)}`;
    const clientSecretMethod = parsed.token_endpoint_auth_method ?? 'none';
    const clientSecret = clientSecretMethod === 'none' ? undefined : createRandomToken(24);
    const registered: RegisteredClient = {
      clientId,
      clientName: parsed.client_name ?? 'MCP Client',
      redirectUris: parsed.redirect_uris ?? defaultRedirectUris,
      grantTypes: parsed.grant_types ?? ['authorization_code', 'refresh_token'],
      responseTypes: parsed.response_types ?? ['code'],
      tokenEndpointAuthMethod: clientSecretMethod,
      clientSecret,
      scope: parsed.scope ?? this.scope,
      createdAt: Date.now(),
    };

    this.clients.set(clientId, registered);

    return {
      client_id: registered.clientId,
      client_id_issued_at: Math.floor(registered.createdAt / 1000),
      ...(clientSecret ? { client_secret: clientSecret } : {}),
      client_secret_expires_at: 0,
      redirect_uris: registered.redirectUris,
      grant_types: registered.grantTypes,
      response_types: registered.responseTypes,
      token_endpoint_auth_method: registered.tokenEndpointAuthMethod,
      scope: registered.scope,
    };
  }

  renderAuthorizationPage(baseUrl: string, input: unknown): AuthorizationPageResponse {
    const parsed = this.parseAuthorizationRequest(input);
    this.validateRegisteredClient(parsed.clientId, parsed.redirectUri);

    const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${this.escapeHtml(this.issuerName)} authorization</title>
    <style>
      body { font-family: sans-serif; margin: 2rem; max-width: 42rem; line-height: 1.5; }
      code { background: #f3f4f6; padding: 0.125rem 0.25rem; border-radius: 0.25rem; }
      .box { border: 1px solid #d1d5db; border-radius: 0.75rem; padding: 1rem 1.25rem; }
      .actions { display: flex; gap: 0.75rem; margin-top: 1.25rem; }
      button { padding: 0.75rem 1rem; border-radius: 0.5rem; border: 0; cursor: pointer; }
      .primary { background: #111827; color: #fff; }
      .secondary { background: #e5e7eb; color: #111827; }
    </style>
  </head>
  <body>
    <h1>${this.escapeHtml(this.issuerName)}</h1>
    <div class="box">
      <p>This client is requesting access to <code>${this.escapeHtml(parsed.clientId)}</code>.</p>
      <p><strong>Scope:</strong> <code>${this.escapeHtml(parsed.scope)}</code></p>
      <p><strong>Redirect URI:</strong> <code>${this.escapeHtml(parsed.redirectUri)}</code></p>
      <form method="post" action="${new URL('/authorize', baseUrl).toString()}">
        <input type="hidden" name="client_id" value="${this.escapeHtml(parsed.clientId)}" />
        <input type="hidden" name="redirect_uri" value="${this.escapeHtml(parsed.redirectUri)}" />
        <input type="hidden" name="response_type" value="${this.escapeHtml(parsed.responseType)}" />
        <input type="hidden" name="scope" value="${this.escapeHtml(parsed.scope)}" />
        <input type="hidden" name="state" value="${this.escapeHtml(parsed.state ?? '')}" />
        <input type="hidden" name="code_challenge" value="${this.escapeHtml(parsed.codeChallenge)}" />
        <input type="hidden" name="code_challenge_method" value="${this.escapeHtml(parsed.codeChallengeMethod)}" />
        <div class="actions">
          <button class="primary" name="decision" value="allow" type="submit">Allow</button>
          <button class="secondary" name="decision" value="deny" type="submit">Deny</button>
        </div>
      </form>
    </div>
  </body>
</html>`;

    return {
      status: 200,
      html,
    };
  }

  approveAuthorization(input: unknown): AuthorizationDecisionResponse {
    const parsed = this.parseAuthorizationRequest(input);
    this.validateRegisteredClient(parsed.clientId, parsed.redirectUri);
    const code = createRandomToken(32);
    const record: AuthorizationCodeRecord = {
      clientId: parsed.clientId,
      redirectUri: parsed.redirectUri,
      codeChallenge: parsed.codeChallenge,
      codeChallengeMethod: parsed.codeChallengeMethod,
      scope: parsed.scope,
      expiresAt: Date.now() + this.authorizationCodeTtlSeconds * 1000,
    };

    this.authorizationCodes.set(code, record);

    const redirect = new URL(parsed.redirectUri);
    redirect.searchParams.set('code', code);
    if (parsed.state) {
      redirect.searchParams.set('state', parsed.state);
    }

    return {
      status: 302,
      location: redirect.toString(),
    };
  }

  denyAuthorization(input: unknown): AuthorizationDecisionResponse {
    const parsed = this.parseAuthorizationRequest(input);
    this.validateRegisteredClient(parsed.clientId, parsed.redirectUri);

    const redirect = new URL(parsed.redirectUri);
    redirect.searchParams.set('error', 'access_denied');
    redirect.searchParams.set('error_description', 'The user denied the request.');
    if (parsed.state) {
      redirect.searchParams.set('state', parsed.state);
    }

    return {
      status: 302,
      location: redirect.toString(),
    };
  }

  exchangeToken(input: unknown): TokenResponse {
    this.sweepExpired();

    const parsed = this.parseTokenRequest(input);

    if (parsed.grantType === 'authorization_code') {
      if (!parsed.code || !parsed.redirectUri || !parsed.clientId || !parsed.codeVerifier) {
        throw new Error('Missing authorization code grant parameters.');
      }

      const codeRecord = this.authorizationCodes.get(parsed.code);
      if (!codeRecord) {
        throw new Error('Invalid or expired authorization code.');
      }

      if (codeRecord.expiresAt <= Date.now()) {
        this.authorizationCodes.delete(parsed.code);
        throw new Error('Invalid or expired authorization code.');
      }

      if (codeRecord.clientId !== parsed.clientId) {
        throw new Error('Authorization code does not belong to the provided client.');
      }

      if (codeRecord.redirectUri !== parsed.redirectUri) {
        throw new Error('Redirect URI mismatch.');
      }

      const client = this.clients.get(parsed.clientId);
      if (!client) {
        throw new Error('Unknown client.');
      }

      this.verifyClientSecretIfNeeded(client, parsed.clientSecret);
      if (buildCodeChallenge(parsed.codeVerifier) !== codeRecord.codeChallenge) {
        throw new Error('Invalid PKCE code verifier.');
      }

      this.authorizationCodes.delete(parsed.code);
      return this.issueToken(client.clientId, codeRecord.scope);
    }

    if (parsed.grantType === 'refresh_token') {
      if (!parsed.refreshToken || !parsed.clientId) {
        throw new Error('Missing refresh token grant parameters.');
      }

      const refreshRecord = this.refreshTokens.get(parsed.refreshToken);
      if (!refreshRecord) {
        throw new Error('Invalid refresh token.');
      }

      if (refreshRecord.expiresAt <= Date.now()) {
        this.refreshTokens.delete(parsed.refreshToken);
        throw new Error('Expired refresh token.');
      }

      if (refreshRecord.clientId !== parsed.clientId) {
        throw new Error('Refresh token does not belong to the provided client.');
      }

      const client = this.clients.get(parsed.clientId);
      if (!client) {
        throw new Error('Unknown client.');
      }

      this.verifyClientSecretIfNeeded(client, parsed.clientSecret);
      return this.issueToken(client.clientId, refreshRecord.scope);
    }

    if (parsed.grantType === 'client_credentials') {
      if (!parsed.clientId) {
        throw new Error('Missing client credentials grant parameters.');
      }

      const client = this.clients.get(parsed.clientId);
      if (!client) {
        throw new Error('Unknown client.');
      }

      this.verifyClientSecretIfNeeded(client, parsed.clientSecret);
      return this.issueToken(client.clientId, parsed.scope ?? client.scope);
    }

    throw new Error('Unsupported grant type.');
  }

  verifyAuthorizationHeader(req: Request): { authorized: boolean; challenge?: AuthChallenge } {
    if (this.mode === 'none') {
      return { authorized: true };
    }

    const authorization = normalizeString(req.get('authorization'));
    if (!authorization?.toLowerCase().startsWith('bearer ')) {
      const baseUrl = this.getPublicBaseUrl(req);
      return {
        authorized: false,
        challenge: this.getChallenge(baseUrl),
      };
    }

    const token = authorization.slice('bearer '.length).trim();
    if (token.length === 0) {
      const baseUrl = this.getPublicBaseUrl(req);
      return {
        authorized: false,
        challenge: this.getChallenge(baseUrl),
      };
    }

    if (this.mode === 'bearer') {
      const authorized = token === this.bearerToken;
      return authorized
        ? { authorized: true }
        : { authorized: false, challenge: this.getChallenge(this.getPublicBaseUrl(req)) };
    }

    const record = this.accessTokens.get(token);
    if (!record) {
      return { authorized: false, challenge: this.getChallenge(this.getPublicBaseUrl(req)) };
    }

    if (record.expiresAt <= Date.now()) {
      this.accessTokens.delete(token);
      this.refreshTokens.delete(record.refreshToken);
      return { authorized: false, challenge: this.getChallenge(this.getPublicBaseUrl(req)) };
    }

    return { authorized: true };
  }

  private parseAuthorizationRequest(input: unknown): ParsedAuthorizationRequest {
    const parsed = authorizeRequestSchema.parse(flattenRecord(input as Record<string, unknown>));

    if (parsed.response_type !== 'code') {
      throw new Error('Only the authorization_code response type is supported.');
    }

    if (!isAllowedRedirectUri(parsed.redirect_uri)) {
      throw new Error('Redirect URI must use HTTPS or localhost.');
    }

    const client = this.clients.get(parsed.client_id);
    if (!client) {
      throw new Error('Unknown client.');
    }

    const scope = parsed.scope ?? client.scope;
    if (scope !== this.scope) {
      throw new Error(`Unsupported scope: ${scope}`);
    }

    return {
      clientId: parsed.client_id,
      redirectUri: parsed.redirect_uri,
      responseType: parsed.response_type,
      scope,
      state: parsed.state,
      codeChallenge: parsed.code_challenge,
      codeChallengeMethod: parsed.code_challenge_method,
    };
  }

  private parseTokenRequest(input: unknown): ParsedTokenRequest {
    const parsed = tokenRequestSchema.parse(flattenRecord(input as Record<string, unknown>));
    return {
      grantType: parsed.grant_type,
      code: parsed.code,
      redirectUri: parsed.redirect_uri,
      clientId: parsed.client_id,
      clientSecret: parsed.client_secret,
      codeVerifier: parsed.code_verifier,
      refreshToken: parsed.refresh_token,
      scope: parsed.scope,
    };
  }

  private verifyClientSecretIfNeeded(client: RegisteredClient, clientSecret?: string): void {
    if (client.tokenEndpointAuthMethod === 'none') {
      return;
    }

    if (!clientSecret || clientSecret !== client.clientSecret) {
      throw new Error('Invalid client secret.');
    }
  }

  private validateRegisteredClient(clientId: string, redirectUri: string): RegisteredClient {
    const client = this.clients.get(clientId);
    if (!client) {
      throw new Error('Unknown client.');
    }

    if (!client.redirectUris.includes(redirectUri)) {
      throw new Error('Redirect URI is not registered for this client.');
    }

    return client;
  }

  private issueToken(clientId: string, scope: string): TokenResponse {
    const accessToken = createRandomToken(32);
    const refreshToken = createRandomToken(32);
    const accessTokenRecord: AccessTokenRecord = {
      clientId,
      scope,
      expiresAt: Date.now() + this.accessTokenTtlSeconds * 1000,
      refreshToken,
    };
    const refreshTokenRecord: RefreshTokenRecord = {
      clientId,
      scope,
      expiresAt: Date.now() + this.refreshTokenTtlSeconds * 1000,
    };

    this.accessTokens.set(accessToken, accessTokenRecord);
    this.refreshTokens.set(refreshToken, refreshTokenRecord);

    return {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: this.accessTokenTtlSeconds,
      refresh_token: refreshToken,
      scope,
    };
  }

  private sweepExpired(): void {
    const now = Date.now();

    for (const [code, record] of this.authorizationCodes.entries()) {
      if (record.expiresAt <= now) {
        this.authorizationCodes.delete(code);
      }
    }

    for (const [token, record] of this.accessTokens.entries()) {
      if (record.expiresAt <= now) {
        this.accessTokens.delete(token);
      }
    }

    for (const [token, record] of this.refreshTokens.entries()) {
      if (record.expiresAt <= now) {
        this.refreshTokens.delete(token);
      }
    }
  }

  private escapeHtml(value: string): string {
    return value
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }
}

export function createMcpAuthService(config: AppConfig): McpAuthService {
  return new McpAuthService(config);
}

export function normalizePublicBaseUrl(value: string): string {
  return toUrlOrigin(value);
}

export function createPkceChallenge(verifier: string): string {
  return buildCodeChallenge(verifier);
}
