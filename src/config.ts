import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const configSchema = z.object({
  ALLBRIDGE_API_BASE_URL: z.string().url().default('http://127.0.0.1:3000'),
  ALLBRIDGE_API_TIMEOUT_MS: z.coerce.number().int().positive().default(20_000),
  MCP_AUTH_MODE: z.enum(['none', 'bearer', 'oauth']).default('none'),
  MCP_TRANSPORT: z.enum(['stdio', 'streamable-http']).default('stdio'),
  MCP_HOST: z.string().trim().min(1).default('0.0.0.0'),
  MCP_PUBLIC_BASE_URL: z
    .string()
    .url()
    .transform((value) => new URL(value).origin)
    .optional(),
  MCP_BEARER_TOKEN: z.preprocess(
    (value) => {
      if (typeof value !== 'string') {
        return undefined;
      }
      const trimmed = value.trim();
      return trimmed === '' ? undefined : trimmed;
    },
    z.string().min(16).optional(),
  ),
  MCP_OAUTH_ISSUER_NAME: z.string().trim().min(1).default('Allbridge MCP'),
  MCP_OAUTH_SCOPE: z.string().trim().min(1).default('allbridge.mcp'),
  MCP_OAUTH_ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(3600),
  MCP_OAUTH_REFRESH_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(60 * 60 * 24 * 30),
  MCP_OAUTH_AUTH_CODE_TTL_SECONDS: z.coerce.number().int().positive().default(600),
  MCP_PORT: z.coerce.number().int().positive().default(3000),
  PORT: z.coerce.number().int().positive().optional(),
  ALLBRIDGE_EVM_RPC_URL: z.preprocess(
    (value) => {
      if (typeof value !== 'string') {
        return undefined;
      }
      const trimmed = value.trim();
      return trimmed === '' ? undefined : trimmed;
    },
    z.string().url().optional(),
  ),
  ALLBRIDGE_SOL_RPC_URL: z.preprocess(
    (value) => {
      if (typeof value !== 'string') {
        return undefined;
      }
      const trimmed = value.trim();
      return trimmed === '' ? undefined : trimmed;
    },
    z.string().url().optional(),
  ),
  ALLBRIDGE_TRX_RPC_URL: z.preprocess(
    (value) => {
      if (typeof value !== 'string') {
        return undefined;
      }
      const trimmed = value.trim();
      return trimmed === '' ? undefined : trimmed;
    },
    z.string().url().optional(),
  ),
  ALLBRIDGE_ALG_RPC_URL: z.preprocess(
    (value) => {
      if (typeof value !== 'string') {
        return undefined;
      }
      const trimmed = value.trim();
      return trimmed === '' ? undefined : trimmed;
    },
    z.string().url().optional(),
  ),
  ALLBRIDGE_STX_RPC_URL: z.preprocess(
    (value) => {
      if (typeof value !== 'string') {
        return undefined;
      }
      const trimmed = value.trim();
      return trimmed === '' ? undefined : trimmed;
    },
    z.string().url().optional(),
  ),
  ALLBRIDGE_SRB_RPC_URL: z.preprocess(
    (value) => {
      if (typeof value !== 'string') {
        return undefined;
      }
      const trimmed = value.trim();
      return trimmed === '' ? undefined : trimmed;
    },
    z.string().url().optional(),
  ),
  ALLBRIDGE_SRB_NETWORK_PASSPHRASE: z.string().optional(),
  ALLBRIDGE_SUI_RPC_URL: z.preprocess(
    (value) => {
      if (typeof value !== 'string') {
        return undefined;
      }
      const trimmed = value.trim();
      return trimmed === '' ? undefined : trimmed;
    },
    z.string().url().optional(),
  ),
});

export type AppConfig = z.infer<typeof configSchema>;

export const config = configSchema.parse(process.env);
