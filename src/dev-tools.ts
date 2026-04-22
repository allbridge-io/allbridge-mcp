import { promises as fs } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { createToolErrorResult, UserFacingToolError } from './tool-errors.js';
import { formatJson } from './utils.js';

const DEV_PRODUCTS = ['bridge', 'dev', 'broadcast'] as const;
type DevProduct = (typeof DEV_PRODUCTS)[number];

const DEV_DOC_SCOPES = ['project-docs', 'sdk-integration', 'rest-api-integration', 'examples'] as const;
type DevDocScope = (typeof DEV_DOC_SCOPES)[number];

const RESOURCE_TYPES = ['DOC', 'CODE_SNIPPET'] as const;
type ResourceType = (typeof RESOURCE_TYPES)[number];

const REMOTE_DOC_ORIGINS = [
  'https://docs-core.allbridge.io/',
  'https://docs-core.allbridge.io/product',
  'https://docs-core.allbridge.io/product/how-does-allbridge-core-work',
  'https://docs-core.allbridge.io/product/how-does-allbridge-core-work/liquidity-provision',
  'https://docs-core.allbridge.io/product/deposit-addresses',
  'https://docs-core.allbridge.io/product/faq',
  'https://docs-core.allbridge.io/product/faq/how-to-transfer-assets',
  'https://docs-core.allbridge.io/product/faq/how-to-provide-liquidity',
  'https://docs-core.allbridge.io/product/faq/what-is-an-approve-transaction',
  'https://docs-core.allbridge.io/product/security-audits',
  'https://docs-core.allbridge.io/product/abr0-token',
  'https://docs-core.allbridge.io/product/leaderboard',
  'https://docs-core.allbridge.io/product/allbridge-core-yield',
  'https://docs-core.allbridge.io/allbridge-ecosystem/allbridge-classic',
  'https://docs-core.allbridge.io/sdk/get-started',
  'https://docs-core.allbridge.io/sdk/guides',
  'https://docs-core.allbridge.io/sdk/guides/general',
  'https://docs-core.allbridge.io/sdk/guides/general/token-info',
  'https://docs-core.allbridge.io/sdk/guides/general/send',
  'https://docs-core.allbridge.io/sdk/guides/general/swap',
  'https://docs-core.allbridge.io/sdk/guides/general/paying-fees-with-stables',
  'https://docs-core.allbridge.io/sdk/guides/evm',
  'https://docs-core.allbridge.io/sdk/guides/evm/transfer',
  'https://docs-core.allbridge.io/sdk/guides/evm/allowance-and-approve',
  'https://docs-core.allbridge.io/sdk/guides/sui',
  'https://docs-core.allbridge.io/sdk/guides/sui/transfer',
  'https://docs-core.allbridge.io/sdk/guides/solana',
  'https://docs-core.allbridge.io/sdk/guides/solana/transfer',
  'https://docs-core.allbridge.io/sdk/guides/solana/swap',
  'https://docs-core.allbridge.io/sdk/guides/tron',
  'https://docs-core.allbridge.io/sdk/guides/stellar',
  'https://docs-core.allbridge.io/sdk/guides/stellar/transfer',
  'https://docs-core.allbridge.io/sdk/guides/algorand',
  'https://docs-core.allbridge.io/sdk/guides/utilities',
  'https://docs-core.allbridge.io/sdk/guides/utilities/amount-and-fee-calculations',
  'https://docs-core.allbridge.io/sdk/guides/utilities/transfer-time',
  'https://docs-core.allbridge.io/sdk/guides/utilities/extra-gas-limits',
  'https://docs-core.allbridge.io/sdk/allbridge-core-rest-api',
  'https://bridge-core-sdk.web.app',
  'https://bridge-core-sdk.web.app/',
  'https://kudelskisecurity.com/blockchain-archive/allbridge-core-security-assessment',
  'https://allbridge.io/assets/docs/reports/24-01-1500-REP-Allbridge%20Soroban%20Bridge-v1.2.pdf',
  'https://allbridge.io/assets/docs/reports/allbridge-public-audit-contest-report.pdf',
  'https://docs.allbridge.io/',
  'https://t.me/allbridge_official',
  'https://discord.com/invite/ASuPY8d3E6',
  'https://twitter.com/Allbridge_io',
  'https://t.me/allbridge_announcements',
  'https://allbridge.medium.com/',
  'https://www.reddit.com/r/allbridge/',
] as const;

type DevResource = {
  name: string;
  description: string;
  collection: DevDocScope;
  resourceType: ResourceType;
  source: 'local-file' | 'remote-url';
  location: string;
  contentHint?: string;
};

type DevGroup = {
  summary: string;
  capabilities: string[];
  boundaries: string[];
  recommendedTools: string[];
  resources: DevResource[];
};

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function resourcePath(relativePath: string): string {
  return resolve(packageRoot, relativePath);
}

function localDocResource(
  collection: DevDocScope,
  name: string,
  description: string,
  relativePath: string,
  contentHint?: string,
): DevResource {
  return {
    name,
    description,
    collection,
    resourceType: 'DOC',
    source: 'local-file',
    location: resourcePath(relativePath),
    contentHint,
  };
}

function remoteDocResource(
  collection: DevDocScope,
  name: string,
  description: string,
  url: string,
  contentHint?: string,
): DevResource {
  if (!REMOTE_DOC_ORIGINS.some((origin) => url.startsWith(origin))) {
    throw new Error(`Remote documentation URL must stay within the allowlisted origins: ${url}`);
  }

  return {
    name,
    description,
    collection,
    resourceType: 'DOC',
    source: 'remote-url',
    location: url,
    contentHint,
  };
}

function codeResource(
  collection: DevDocScope,
  name: string,
  description: string,
  relativePath: string,
  contentHint?: string,
): DevResource {
  return {
    name,
    description,
    collection,
    resourceType: 'CODE_SNIPPET',
    source: 'local-file',
    location: resourcePath(relativePath),
    contentHint,
  };
}

const DEV_GROUPS: Record<DevProduct, DevGroup> = {
  bridge: {
    summary: 'Bridge route planning and execution surface for quotes, balance checks, and execution jobs.',
    capabilities: [
      'list supported chains and tokens',
      'resolve bridge routes',
      'quote bridge transfers',
      'validate sender and fee balances before execution',
      'build execution jobs and raw transaction payloads',
      'broadcast already signed transactions',
      'track transfer status',
    ],
    boundaries: [
      'does not sign transactions',
      'does not hold private keys',
      'does not guess network gas before build or simulation',
    ],
    recommendedTools: [
      'list_supported_chains',
      'list_supported_tokens',
      'find_bridge_routes',
      'quote_bridge_transfer',
      'plan_bridge_transfer',
      'check_bridge_balances',
      'create_bridge_execution_job',
      'build_bridge_transactions',
    ],
    resources: [
      localDocResource('rest-api-integration', 'bridge-workflow', 'Bridge workflow guide and execution order.', 'docs/gitbook/ai/allbridge-mcp/bridge-workflow.md'),
      localDocResource('rest-api-integration', 'tool-reference', 'Tool reference for bridge planning and execution.', 'docs/gitbook/ai/allbridge-mcp/tool-reference.md'),
      localDocResource('rest-api-integration', 'usage', 'Operational usage guide for bridge flows.', 'docs/usage.md'),
      codeResource('rest-api-integration', 'execution-job-contract', 'Validation contract for bridge execution jobs.', 'src/execution-job-contract.ts'),
      codeResource('rest-api-integration', 'allbridge-api-client', 'API client used for catalog, quotes, balance checks, and transaction building.', 'src/allbridge-api-client.ts'),
      codeResource('rest-api-integration', 'chain-catalog', 'Chain and token resolution logic.', 'src/chain-catalog.ts'),
    ],
  },
  dev: {
    summary: 'Read-only developer assistant for project docs, SDK integration guidance, REST API integration guidance, and local implementation references.',
    capabilities: [
      'search project docs, SDK docs, REST API docs, and examples',
      'summarize the bridge, dev, and broadcast tool groups',
      'list implementation resources by documentation scope',
      'return the full content of selected docs or code references',
    ],
    boundaries: [
      'read-only only',
      'does not execute bridge jobs',
      'does not sign or broadcast transactions',
    ],
    recommendedTools: [
      'search_allbridge_documentation',
      'get_allbridge_product_summary',
      'list_available_coding_resources',
      'get_coding_resource_details',
    ],
    resources: [
      remoteDocResource('project-docs', 'docs-core-home', 'Project overview and stablecoin bridge concept summary.', 'https://docs-core.allbridge.io/', 'Allbridge Core docs home: product overview, getting started, SDK guides, and integration references.'),
      remoteDocResource('project-docs', 'docs-core-product', 'Core product overview and supported chain families.', 'https://docs-core.allbridge.io/product', 'Product docs for Allbridge Core, including supported chains, balances, and transfer behavior.'),
      remoteDocResource('project-docs', 'docs-core-how-core-works', 'How Allbridge Core works and the transfer model.', 'https://docs-core.allbridge.io/product/how-does-allbridge-core-work', 'How Core transfers work, including bridge flow and transfer lifecycle.'),
      remoteDocResource('project-docs', 'docs-core-fees', 'Core fees and fee payment behavior.', 'https://docs-core.allbridge.io/product/how-does-allbridge-core-work/fees', 'Fee model for Core transfers, including how fees are paid and surfaced.'),
      remoteDocResource('project-docs', 'docs-core-messaging-protocols', 'Core messaging protocols and transfer transport behavior.', 'https://docs-core.allbridge.io/product/how-does-allbridge-core-work/messaging-protocols', 'Messaging protocol behavior for Core transfers and transport selection.'),
      remoteDocResource('project-docs', 'docs-core-contracts', 'Core contracts and onchain components.', 'https://docs-core.allbridge.io/product/how-does-allbridge-core-work/allbridge-core-contracts', 'Contract addresses and onchain components used by Core transfers.'),
      remoteDocResource('project-docs', 'docs-core-liquidity-provision', 'Liquidity provisioning and pool behavior.', 'https://docs-core.allbridge.io/product/how-does-allbridge-core-work/liquidity-provision', 'Liquidity provisioning and pool behavior for Core.'),
      remoteDocResource('project-docs', 'docs-core-deposit-addresses', 'Deposit addresses and non-custodial entry points.', 'https://docs-core.allbridge.io/product/deposit-addresses', 'Deposit address guidance and non-custodial entry points.'),
      remoteDocResource('project-docs', 'docs-core-faq', 'Core FAQ landing page.', 'https://docs-core.allbridge.io/product/faq', 'FAQ for common bridge, liquidity, approve, and transfer questions.'),
      remoteDocResource('project-docs', 'docs-core-faq-transfer-assets', 'FAQ for transferring assets.', 'https://docs-core.allbridge.io/product/faq/how-to-transfer-assets', 'FAQ guidance for transferring assets through Allbridge Core.'),
      remoteDocResource('project-docs', 'docs-core-faq-provide-liquidity', 'FAQ for providing liquidity.', 'https://docs-core.allbridge.io/product/faq/how-to-provide-liquidity', 'FAQ guidance for liquidity provider flows and expectations.'),
      remoteDocResource('project-docs', 'docs-core-faq-approve-transaction', 'FAQ for approve transactions.', 'https://docs-core.allbridge.io/product/faq/what-is-an-approve-transaction', 'FAQ explanation of approve transactions and allowance behavior.'),
      remoteDocResource('project-docs', 'docs-core-security-audits', 'Security audits landing page.', 'https://docs-core.allbridge.io/product/security-audits', 'Landing page for published security audit reports and contest reports.'),
      remoteDocResource('project-docs', 'docs-core-kudelski-security-assessment', 'Kudelski Security assessment summary page.', 'https://kudelskisecurity.com/blockchain-archive/allbridge-core-security-assessment', 'Kudelski Security assessment archive entry for Allbridge Core.'),
      remoteDocResource('project-docs', 'docs-core-quarkslab-soroban-report', 'Quarkslab Soroban bridge audit PDF.', 'https://allbridge.io/assets/docs/reports/24-01-1500-REP-Allbridge%20Soroban%20Bridge-v1.2.pdf', 'Quarkslab audit report for the Soroban bridge contracts.'),
      remoteDocResource('project-docs', 'docs-core-public-audit-contest-report', 'Public audit contest report PDF.', 'https://allbridge.io/assets/docs/reports/allbridge-public-audit-contest-report.pdf', 'Public audit contest report covering core contract findings.'),
      remoteDocResource('project-docs', 'docs-core-abr0-token', 'ABR0 token documentation.', 'https://docs-core.allbridge.io/product/abr0-token', 'ABR0 token overview and product documentation.'),
      remoteDocResource('project-docs', 'docs-core-leaderboard', 'Leaderboard documentation.', 'https://docs-core.allbridge.io/product/leaderboard', 'Leaderboard product page and participation details.'),
      remoteDocResource('project-docs', 'docs-core-yield', 'Allbridge Core Yield documentation.', 'https://docs-core.allbridge.io/product/allbridge-core-yield', 'Yield product overview and related documentation.'),
      remoteDocResource('project-docs', 'docs-core-ecosystem-classic', 'Allbridge Classic ecosystem entry.', 'https://docs-core.allbridge.io/allbridge-ecosystem/allbridge-classic', 'Ecosystem docs for Allbridge Classic.'),
      remoteDocResource('project-docs', 'docs-allbridge-main', 'Legacy Allbridge documentation site.', 'https://docs.allbridge.io/', 'Legacy Allbridge documentation site and historical references.'),
      remoteDocResource('project-docs', 'official-support-telegram', 'Official support Telegram contact.', 'https://t.me/allbridge_official', 'Official support Telegram channel for Allbridge.'),
      remoteDocResource('project-docs', 'official-support-discord', 'Official support Discord invite.', 'https://discord.com/invite/ASuPY8d3E6', 'Official support Discord for Allbridge.'),
      remoteDocResource('project-docs', 'social-twitter', 'Allbridge Twitter account.', 'https://twitter.com/Allbridge_io', 'Official Twitter/X account for Allbridge.'),
      remoteDocResource('project-docs', 'social-telegram-announcements', 'Telegram announcements channel.', 'https://t.me/allbridge_announcements', 'Official announcement channel for Allbridge.'),
      remoteDocResource('project-docs', 'social-telegram-group', 'Telegram group.', 'https://t.me/allbridge_official', 'Official Telegram group for Allbridge.'),
      remoteDocResource('project-docs', 'social-medium', 'Allbridge Medium publication.', 'https://allbridge.medium.com/', 'Official Medium publication for Allbridge.'),
      remoteDocResource('project-docs', 'social-reddit', 'Allbridge Reddit community.', 'https://www.reddit.com/r/allbridge/', 'Official Reddit community for Allbridge.'),
      remoteDocResource('sdk-integration', 'sdk-get-started', 'SDK installation and initialization guide.', 'https://docs-core.allbridge.io/sdk/get-started', 'How to install and initialize the Allbridge Core SDK.'),
      remoteDocResource('sdk-integration', 'sdk-guides', 'SDK guides landing page.', 'https://docs-core.allbridge.io/sdk/guides', 'SDK guides landing page for Allbridge Core.'),
      remoteDocResource('sdk-integration', 'sdk-guides-general', 'General SDK guides landing page.', 'https://docs-core.allbridge.io/sdk/guides/general', 'General SDK guidance for tokens, send, swap, and fees.'),
      remoteDocResource('sdk-integration', 'sdk-allbridge-core-rest-api', 'REST API integration guide in the docs portal.', 'https://docs-core.allbridge.io/sdk/allbridge-core-rest-api', 'SDK-facing REST API integration guide for Core.'),
      remoteDocResource('sdk-integration', 'sdk-token-info', 'Token info and chainDetailsMap usage.', 'https://docs-core.allbridge.io/sdk/guides/general/token-info', 'Token info guide, including chainDetailsMap usage and token metadata patterns.'),
      remoteDocResource('sdk-integration', 'sdk-send', 'SDK send guide.', 'https://docs-core.allbridge.io/sdk/guides/general/send', 'General send flow and payload examples.'),
      remoteDocResource('sdk-integration', 'sdk-swap', 'SDK swap guide.', 'https://docs-core.allbridge.io/sdk/guides/general/swap', 'General swap flow and payload examples.'),
      remoteDocResource('sdk-integration', 'sdk-paying-fees-with-stables', 'SDK fee payment with stables guide.', 'https://docs-core.allbridge.io/sdk/guides/general/paying-fees-with-stables', 'How to pay bridge fees with stablecoins.'),
      remoteDocResource('sdk-integration', 'sdk-evm', 'EVM SDK guides landing page.', 'https://docs-core.allbridge.io/sdk/guides/evm', 'EVM-specific SDK guidance.'),
      remoteDocResource('sdk-integration', 'sdk-evm-transfer', 'EVM transfer guide.', 'https://docs-core.allbridge.io/sdk/guides/evm/transfer', 'EVM transfer implementation guide.'),
      remoteDocResource('sdk-integration', 'sdk-evm-allowance-and-approve', 'EVM allowance and approve guide.', 'https://docs-core.allbridge.io/sdk/guides/evm/allowance-and-approve', 'Allowance and approve handling for EVM transfers.'),
      remoteDocResource('sdk-integration', 'sdk-sui', 'Sui SDK guides landing page.', 'https://docs-core.allbridge.io/sdk/guides/sui', 'Sui-specific SDK guidance.'),
      remoteDocResource('sdk-integration', 'sdk-sui-transfer', 'Sui transfer guide.', 'https://docs-core.allbridge.io/sdk/guides/sui/transfer', 'Sui transfer implementation guide.'),
      remoteDocResource('sdk-integration', 'sdk-solana', 'Solana SDK guides landing page.', 'https://docs-core.allbridge.io/sdk/guides/solana', 'Solana-specific SDK guidance.'),
      remoteDocResource('sdk-integration', 'sdk-solana-transfer', 'Solana transfer guide.', 'https://docs-core.allbridge.io/sdk/guides/solana/transfer', 'Solana transfer implementation guide.'),
      remoteDocResource('sdk-integration', 'sdk-solana-swap', 'Solana swap guide.', 'https://docs-core.allbridge.io/sdk/guides/solana/swap', 'Solana swap implementation guide.'),
      remoteDocResource('sdk-integration', 'sdk-tron', 'Tron SDK guides landing page.', 'https://docs-core.allbridge.io/sdk/guides/tron', 'Tron-specific SDK guidance.'),
      remoteDocResource('sdk-integration', 'sdk-stellar', 'Stellar SDK guides landing page.', 'https://docs-core.allbridge.io/sdk/guides/stellar', 'Stellar-specific SDK guidance.'),
      remoteDocResource('sdk-integration', 'sdk-stellar-transfer', 'Stellar transfer guide.', 'https://docs-core.allbridge.io/sdk/guides/stellar/transfer', 'Stellar transfer implementation guide.'),
      remoteDocResource('sdk-integration', 'sdk-algorand', 'Algorand SDK integration guide.', 'https://docs-core.allbridge.io/sdk/guides/algorand', 'Algorand SDK integration guide.'),
      remoteDocResource('sdk-integration', 'sdk-utilities', 'SDK utilities landing page.', 'https://docs-core.allbridge.io/sdk/guides/utilities', 'Utility helpers for SDK integrations.'),
      remoteDocResource('sdk-integration', 'sdk-utilities-amount-and-fee-calculations', 'SDK amount and fee calculations guide.', 'https://docs-core.allbridge.io/sdk/guides/utilities/amount-and-fee-calculations', 'Amount and fee calculation helpers.'),
      remoteDocResource('sdk-integration', 'sdk-utilities-transfer-time', 'SDK transfer time guide.', 'https://docs-core.allbridge.io/sdk/guides/utilities/transfer-time', 'Transfer time estimation helpers.'),
      remoteDocResource('sdk-integration', 'sdk-utilities-extra-gas-limits', 'SDK extra gas limits guide.', 'https://docs-core.allbridge.io/sdk/guides/utilities/extra-gas-limits', 'Extra gas limit helpers and guidance.'),
      remoteDocResource('sdk-integration', 'sdk-rest-api-docs', 'SDK documentation landing page.', 'https://bridge-core-sdk.web.app', 'Allbridge Core SDK reference landing page.'),
      localDocResource('rest-api-integration', 'rest-api-readme', 'Top-level REST API integration guide in this repository.', '../README.md'),
      localDocResource('rest-api-integration', 'mcp-readme', 'MCP server overview and capability boundary.', 'README.md'),
      localDocResource('rest-api-integration', 'developer-assistant', 'Developer-assistant workflow and tool groups.', 'docs/gitbook/ai/allbridge-mcp/developer-assistant.md'),
      localDocResource('rest-api-integration', 'mcp-usage', 'Operational usage guide for bridge and broadcast flows.', 'docs/usage.md'),
      localDocResource('rest-api-integration', 'mcp-tool-reference', 'Bridge and broadcast tool reference.', 'docs/gitbook/ai/allbridge-mcp/tool-reference.md'),
      localDocResource('rest-api-integration', 'mcp-bridge-workflow', 'Bridge workflow and execution handoff notes.', 'docs/gitbook/ai/allbridge-mcp/bridge-workflow.md'),
      localDocResource('rest-api-integration', 'mcp-public-boundary', 'Public boundary and trust model notes.', 'docs/gitbook/ai/allbridge-mcp/public-boundary.md'),
      localDocResource('rest-api-integration', 'mcp-http-and-auth', 'HTTP transport and auth model notes.', 'docs/gitbook/ai/allbridge-mcp/http-and-auth.md'),
      localDocResource('rest-api-integration', 'mcp-local-signing', 'Local signing companion workflow notes.', 'docs/gitbook/ai/allbridge-mcp/local-signing.md'),
      localDocResource('examples', 'claude-code-example', 'Claude Code stdio setup example.', 'examples/claude-code.md'),
      localDocResource('examples', 'cursor-example', 'Cursor MCP configuration example.', 'examples/cursor.mcp.json'),
      localDocResource('examples', 'tool-usage-example', 'Agent-oriented tool usage example.', 'examples/tool-usage.md'),
      codeResource('rest-api-integration', 'index', 'Server entrypoint for stdio and HTTP transports.', 'src/index.ts'),
      codeResource('rest-api-integration', 'http-server', 'Streamable HTTP transport server implementation.', 'src/http-server.ts'),
      codeResource('rest-api-integration', 'auth', 'HTTP auth and OAuth plumbing.', 'src/auth.ts'),
      codeResource('rest-api-integration', 'config', 'Runtime configuration and transport settings.', 'src/config.ts'),
    ],
  },
  broadcast: {
    summary: 'Broadcast path for already signed transactions across supported chain families.',
    capabilities: [
      'broadcast signed payloads for EVM, Solana, Tron, Algorand, Stacks, Soroban/Stellar, and Sui',
      'select RPCs by family and wallet hint',
      'return broadcast receipts and hashes',
    ],
    boundaries: [
      'does not sign transactions',
      'requires a signed payload',
      'requires matching RPC configuration for the target family',
    ],
    recommendedTools: [
      'broadcast_signed_transaction',
    ],
    resources: [
      localDocResource('rest-api-integration', 'public-boundary', 'Public boundary and signed-payload handoff rules.', 'docs/gitbook/ai/allbridge-mcp/public-boundary.md'),
      localDocResource('rest-api-integration', 'local-signing', 'Local signing and broadcast handoff flow.', 'docs/gitbook/ai/allbridge-mcp/local-signing.md'),
      codeResource('rest-api-integration', 'chain-broadcast', 'Chain-family specific broadcast dispatch.', 'src/chain-broadcast.ts'),
    ],
  },
};

const SEARCHABLE_RESOURCES = [...new Set(
  DEV_GROUPS.dev.resources.filter((resource) => resource.resourceType === 'DOC'),
)];

const contentCache = new Map<string, string>();

function stripHtml(html: string): string {
  const withoutScripts = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ');

  const withBreaks = withoutScripts
    .replace(/<\/(p|div|li|h[1-6]|section|article|pre|code|br|tr|table|blockquote)>/gi, '\n')
    .replace(/<li>/gi, '\n- ');

  return withBreaks
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

async function readResourceContent(resource: DevResource): Promise<string> {
  const { source, location, contentHint } = resource;
  const cacheKey = `${source}:${location}`;
  const cached = contentCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  if (source === 'local-file') {
    const content = await fs.readFile(location, 'utf8');
    contentCache.set(cacheKey, content);
    return content;
  }

  try {
    const response = await fetch(location, {
      headers: {
        accept: 'text/html,application/xhtml+xml,application/json,text/plain;q=0.9,*/*;q=0.8',
      },
      redirect: 'follow',
    });

    if (!response.ok) {
      throw new Error(`Unable to fetch remote documentation resource: ${location}`);
    }

    const contentType = response.headers.get('content-type') ?? '';
    const raw = await response.text();
    const content = contentType.includes('html') ? stripHtml(raw) : raw;
    contentCache.set(cacheKey, content);
    return content;
  } catch (error) {
    if (contentHint) {
      contentCache.set(cacheKey, contentHint);
      return contentHint;
    }

    throw error;
  }
}

function filterResources(collection?: DevDocScope) {
  return collection
    ? DEV_GROUPS.dev.resources.filter((resource) => resource.collection === collection)
    : DEV_GROUPS.dev.resources;
}

function getResourceCollectionSummary(collection: DevDocScope) {
  const resources = filterResources(collection);
  return {
    collection,
    resourceCount: resources.length,
    resourceTypes: [...new Set(resources.map((resource) => resource.resourceType))],
    resourceNames: resources.map((resource) => resource.name),
  };
}

function normalizeQuery(query: string): string[] {
  return query
    .trim()
    .toLowerCase()
    .match(/[a-z0-9]+/g) ?? [];
}

function trimExcerpt(line: string): string {
  const compact = line.trim().replace(/\s+/g, ' ');
  if (compact.length <= 180) {
    return compact;
  }

  return `${compact.slice(0, 177)}...`;
}

function createToolResult(structuredContent: Record<string, unknown>) {
  return {
    content: [{ type: 'text' as const, text: formatJson(structuredContent) }],
    structuredContent,
  };
}

function createErrorResult(error: UserFacingToolError) {
  return createToolErrorResult(error);
}

function getProductGroup(product: DevProduct): DevGroup {
  return DEV_GROUPS[product];
}

async function searchDocumentation(query: string, limit: number, collection?: DevDocScope) {
  const tokens = normalizeQuery(query);
  if (tokens.length === 0) {
    throw new UserFacingToolError('missing_input', 'query is required.', { field: 'query' });
  }

  const matches: Array<{
    name: string;
    description: string;
    collection: DevDocScope;
    resourceType: ResourceType;
    source: DevResource['source'];
    location: string;
    score: number;
    snippets: Array<{
      line: number;
      excerpt: string;
    }>;
  }> = [];

  const resources = collection
    ? SEARCHABLE_RESOURCES.filter((resource) => resource.collection === collection)
    : SEARCHABLE_RESOURCES;

  for (const resource of resources) {
    try {
      const content = await readResourceContent(resource);
      const lines = content.split(/\r?\n/);
      const snippets: Array<{
        line: number;
        excerpt: string;
      }> = [];
      let score = 0;

      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index] ?? '';
        const lower = line.toLowerCase();
        const matchedTokens = tokens.filter((token) => lower.includes(token));
        if (matchedTokens.length === 0) {
          continue;
        }

        score += matchedTokens.length;
        if (snippets.length < 3) {
          snippets.push({
            line: index + 1,
            excerpt: trimExcerpt(line),
          });
        }
      }

      if (score > 0) {
        matches.push({
          name: resource.name,
          description: resource.description,
          collection: resource.collection,
          resourceType: resource.resourceType,
          source: resource.source,
          location: resource.location,
          score,
          snippets,
        });
      }
    } catch {
      continue;
    }
  }

  matches.sort((left, right) => right.score - left.score || left.name.localeCompare(right.name));

  return {
    query,
    collection: collection ?? null,
    resultCount: matches.length,
    results: matches.slice(0, limit),
    nextAction: 'Use get_allbridge_product_summary to narrow the scope, then list_available_coding_resources for the relevant collection.',
  };
}

export function registerDevTools(server: McpServer): void {
  server.registerTool(
    'search_allbridge_documentation',
    {
      title: 'Search Allbridge Documentation',
      description:
        'Search the allowlisted Allbridge project docs, SDK docs, REST API docs, and examples. Use this first when you need integration guidance or implementation context.',
      inputSchema: {
        query: z.string().trim().min(1).describe('Search query for Allbridge docs and examples.'),
        limit: z.number().int().positive().max(10).default(5).describe('Maximum number of results to return.'),
        collection: z.enum(DEV_DOC_SCOPES).optional().describe('Optional doc scope to search within. Omit to search all allowlisted docs.'),
      },
    },
    async (parsed) => {
      try {
        return createToolResult(await searchDocumentation(parsed.query, parsed.limit, parsed.collection));
      } catch (error) {
        if (error instanceof UserFacingToolError) {
          return createErrorResult(error);
        }

        throw error;
      }
    },
  );

  server.registerTool(
    'get_allbridge_product_summary',
    {
      title: 'Get Allbridge Product Summary',
      description:
        'Summarize one of the Allbridge tool groups: bridge, dev, or broadcast. Use this after searching documentation to narrow the workflow boundary.',
      inputSchema: {
        product: z.enum(DEV_PRODUCTS).describe('Tool group to summarize.'),
      },
    },
    async (parsed) => {
      const group = getProductGroup(parsed.product);
      return createToolResult({
        product: parsed.product,
        summary: group.summary,
        capabilities: group.capabilities,
        boundaries: group.boundaries,
        recommendedTools: group.recommendedTools,
        collections:
          parsed.product === 'dev'
            ? DEV_DOC_SCOPES.map((collection) => getResourceCollectionSummary(collection))
            : [],
        nextAction: 'Use list_available_coding_resources for this product group to inspect the relevant docs and code references.',
      });
    },
  );

  server.registerTool(
    'list_available_coding_resources',
    {
      title: 'List Available Coding Resources',
      description:
        'List the docs and code references available for a specific Allbridge tool group. Use this after the product summary.',
      inputSchema: {
        product: z.enum(DEV_PRODUCTS).describe('Tool group whose resources should be listed.'),
        collection: z.enum(DEV_DOC_SCOPES).optional().describe('Optional doc scope filter. Relevant only for the dev product group.'),
      },
    },
    async (parsed) => {
      const group = getProductGroup(parsed.product);
      const resources = parsed.product === 'dev' && parsed.collection
        ? group.resources.filter((resource) => resource.collection === parsed.collection)
        : group.resources;

      return createToolResult({
        product: parsed.product,
        collection: parsed.product === 'dev' ? parsed.collection ?? null : null,
        summary: group.summary,
        resources: resources.map((resource) => ({
          name: resource.name,
          description: resource.description,
          collection: resource.collection,
          resourceType: resource.resourceType,
          source: resource.source,
          location: resource.location,
          contentHint: resource.contentHint ?? null,
        })),
        nextAction: 'Use get_coding_resource_details with one or more resource names from this list.',
      });
    },
  );

  server.registerTool(
    'get_coding_resource_details',
    {
      title: 'Get Coding Resource Details',
      description:
        'Fetch the full content of one or more Allbridge docs or code references. Use this last after listing the available resources.',
      inputSchema: {
        product: z.enum(DEV_PRODUCTS).describe('Tool group that owns the requested resources.'),
        collection: z.enum(DEV_DOC_SCOPES).optional().describe('Optional doc scope filter. Relevant only for the dev product group.'),
        resource_names: z.array(z.string().trim().min(1)).min(1).describe('Resource names returned by list_available_coding_resources.'),
      },
    },
    async (parsed) => {
      const group = getProductGroup(parsed.product);
      const requested = parsed.resource_names.map((name) => name.trim());
      const requestedSet = new Set(requested);
      const scopedResources = parsed.product === 'dev' && parsed.collection
        ? group.resources.filter((resource) => resource.collection === parsed.collection)
        : group.resources;
      const resources = scopedResources.filter((resource) => requestedSet.has(resource.name));
      const missing = requested.filter((name) => !scopedResources.some((resource) => resource.name === name));

      if (missing.length > 0) {
        throw new UserFacingToolError('validation_error', 'Unknown coding resource name(s).', {
          product: parsed.product,
          collection: parsed.product === 'dev' ? parsed.collection ?? null : null,
          requested,
          missing,
          availableResources: scopedResources.map((resource) => resource.name),
        });
      }

      const details: Array<{
        name: string;
        description: string;
        collection: DevDocScope;
        resourceType: ResourceType;
        source: DevResource['source'];
        location: string;
        contentHint: string | null;
        content: string;
      }> = [];
      for (const resource of resources) {
        details.push({
          name: resource.name,
          description: resource.description,
          collection: resource.collection,
          resourceType: resource.resourceType,
          source: resource.source,
          location: resource.location,
          contentHint: resource.contentHint ?? null,
          content: await readResourceContent(resource),
        });
      }

      return createToolResult({
        product: parsed.product,
        collection: parsed.product === 'dev' ? parsed.collection ?? null : null,
        resources: details,
      });
    },
  );
}
