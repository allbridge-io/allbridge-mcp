import axios, { AxiosError, type AxiosInstance } from 'axios';

import { ALLBRIDGE_MCP_CLIENT_HEADERS } from './http-headers.js';

type RecordLike = Record<string, unknown>;

export class AllbridgeExplorerApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AllbridgeExplorerApiError';
  }
}

export type ExplorerTransferSummary = {
  transferId: string | null;
  sourceChainSymbol: string | null;
  destinationChainSymbol: string | null;
  senderAddress: string | null;
  recipientAddress: string | null;
  sourceTxId: string | null;
  messagingTxId: string | null;
  receiveTxId: string | null;
  amount: string | null;
  status: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  historyUrl: string | null;
  explorerUrl: string | null;
  matchTypes: string[];
};

export type ExplorerSearchResult = {
  chainSymbol: string;
  itemType: string | null;
  value: string | null;
};

export type ExplorerTransfersListParams = {
  account?: string;
  chain?: string;
  from?: string;
  to?: string;
  minFromAmount?: number;
  maxFromAmount?: number;
  status?: string;
  page?: number;
  limit?: number;
};

export type ExplorerTransferDetails = ExplorerTransferSummary & {
  raw: RecordLike;
};

function isRecord(value: unknown): value is RecordLike {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeText(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }

  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }

  return null;
}

function extractTextFromValue(value: unknown, seen = new Set<unknown>()): string | null {
  if (seen.has(value)) {
    return null;
  }

  const text = normalizeText(value);
  if (text !== null) {
    return text;
  }

  if (Array.isArray(value)) {
    seen.add(value);
    for (const entry of value) {
      const candidate = extractTextFromValue(entry, seen);
      if (candidate !== null) {
        return candidate;
      }
    }
    return null;
  }

  if (!isRecord(value)) {
    return null;
  }

  seen.add(value);

  for (const entry of Object.values(value)) {
    const candidate = extractTextFromValue(entry, seen);
    if (candidate !== null) {
      return candidate;
    }
  }

  return null;
}

function findFieldText(value: unknown, candidateKeys: string[], seen = new Set<unknown>()): string | null {
  if (seen.has(value)) {
    return null;
  }

  if (Array.isArray(value)) {
    seen.add(value);
    for (const entry of value) {
      const candidate = findFieldText(entry, candidateKeys, seen);
      if (candidate !== null) {
        return candidate;
      }
    }
    return null;
  }

  if (!isRecord(value)) {
    return null;
  }

  seen.add(value);

  for (const key of candidateKeys) {
    if (Object.prototype.hasOwnProperty.call(value, key)) {
      const candidate = extractTextFromValue(value[key]);
      if (candidate !== null) {
        return candidate;
      }
    }
  }

  for (const entry of Object.values(value)) {
    const candidate = findFieldText(entry, candidateKeys, seen);
    if (candidate !== null) {
      return candidate;
    }
  }

  return null;
}

function readFieldText(value: unknown, candidateKeys: string[]): string | null {
  return findFieldText(value, candidateKeys);
}

function normalizeQuery(query: string): string {
  return query.trim().toLowerCase();
}

function buildExplorerUrl(baseURL: string, transferId: string | null): string | null {
  if (!transferId) {
    return baseURL;
  }

  return new URL(`/transfers/${encodeURIComponent(transferId)}`, baseURL).toString();
}

function buildHistoryUrl(sourceChainSymbol: string | null, sourceTxId: string | null): string | null {
  if (!sourceChainSymbol || !sourceTxId) {
    return null;
  }

  return new URL(
    `${encodeURIComponent(sourceChainSymbol)}/${encodeURIComponent(sourceTxId)}`,
    'https://core.allbridge.io/history/',
  ).toString();
}

function transferCandidateFields() {
  return {
    transferId: ['transferId', 'transfer_id', 'id', '_id', 'txId'],
    sourceChainSymbol: ['sourceChainSymbol', 'source_chain_symbol', 'sourceChain', 'source_chain', 'fromChain', 'from_chain', 'fromChainSymbol', 'from_chain_symbol', 'chainFrom', 'chain_from'],
    destinationChainSymbol: ['destinationChainSymbol', 'destination_chain_symbol', 'destinationChain', 'destination_chain', 'toChain', 'to_chain', 'toChainSymbol', 'to_chain_symbol', 'chainTo', 'chain_to'],
    senderAddress: ['senderAddress', 'sender_address', 'fromAddress', 'from_address', 'sender', 'from', 'sourceAddress', 'source_address', 'srcAddress', 'src_address'],
    recipientAddress: ['recipientAddress', 'recipient_address', 'toAddress', 'to_address', 'recipient', 'to', 'destinationAddress', 'destination_address', 'dstAddress', 'dst_address'],
    sourceTxId: ['sourceTxId', 'source_tx_id', 'sourceTxHash', 'source_tx_hash', 'sendTxId', 'send_tx_id', 'sendTxHash', 'send_tx_hash', 'sendTransactionHash', 'send_transaction_hash', 'txId', 'transactionHash', 'txHash', 'hash'],
    messagingTxId: ['messagingTxId', 'messaging_tx_id', 'messageTxId', 'message_tx_id', 'messagingTxHash', 'messageTxHash', 'messagingTransactionHash', 'messageTransactionHash', 'messagingHash', 'messageHash'],
    receiveTxId: ['receiveTxId', 'receive_tx_id', 'receiveTxHash', 'receive_tx_hash', 'destinationTxId', 'destination_tx_id', 'destinationTxHash', 'destination_tx_hash', 'receiveTransactionHash', 'receive_transaction_hash'],
    amount: ['amount', 'fromAmount', 'from_amount', 'sendAmount', 'send_amount', 'value', 'amountFormatted', 'sendAmountFormatted'],
    status: ['status', 'state', 'transferStatus', 'transfer_status'],
    createdAt: ['createdAt', 'created_at', 'timestamp', 'time', 'created'],
    updatedAt: ['updatedAt', 'updated_at', 'modifiedAt', 'modified_at', 'updated'],
  } as const;
}

function searchCandidateFields() {
  return {
    chainSymbol: ['chainSymbol', 'chain_symbol'],
    itemType: ['itemType', 'item_type'],
    value: ['value'],
  } as const;
}

function looksLikeTransferRecord(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }

  const fields = transferCandidateFields();
  return Boolean(
    fields.transferId.some((key) => Object.prototype.hasOwnProperty.call(value, key))
    || fields.senderAddress.some((key) => Object.prototype.hasOwnProperty.call(value, key))
    || fields.recipientAddress.some((key) => Object.prototype.hasOwnProperty.call(value, key))
    || fields.sourceTxId.some((key) => Object.prototype.hasOwnProperty.call(value, key))
    || fields.receiveTxId.some((key) => Object.prototype.hasOwnProperty.call(value, key)),
  );
}

function extractTransferRecords(value: unknown): RecordLike[] {
  if (Array.isArray(value)) {
    return value.filter(isRecord);
  }

  if (!isRecord(value)) {
    return [];
  }

  for (const key of ['results', 'items', 'transfers', 'rows'] as const) {
    const candidate = value[key];
    if (Array.isArray(candidate)) {
      return candidate.filter(isRecord);
    }
  }

  for (const key of ['result', 'transfer', 'item'] as const) {
    const candidate = value[key];
    if (looksLikeTransferRecord(candidate)) {
      return [candidate as RecordLike];
    }
  }

  const data = value.data;
  if (Array.isArray(data)) {
    return data.filter(isRecord);
  }

  if (isRecord(data)) {
    const nested = extractTransferRecords(data);
    if (nested.length > 0) {
      return nested;
    }
  }

  if (looksLikeTransferRecord(data)) {
    return [data as RecordLike];
  }

  if (looksLikeTransferRecord(value)) {
    return [value];
  }

  return [];
}

function extractSearchRecords(value: unknown): RecordLike[] {
  if (Array.isArray(value)) {
    return value.filter(isRecord);
  }

  if (!isRecord(value)) {
    return [];
  }

  for (const key of ['results', 'items', 'searchResults', 'search_results', 'rows'] as const) {
    const candidate = value[key];
    if (Array.isArray(candidate)) {
      return candidate.filter(isRecord);
    }
  }

  for (const key of ['result', 'searchResult', 'item'] as const) {
    const candidate = value[key];
    if (isRecord(candidate)) {
      return [candidate];
    }
  }

  const data = value.data;
  if (Array.isArray(data)) {
    return data.filter(isRecord);
  }

  if (isRecord(data)) {
    const nested = extractSearchRecords(data);
    if (nested.length > 0) {
      return nested;
    }
  }

  if (isRecord(value)) {
    return [value];
  }

  return [];
}

function matchFields(query: string | undefined, record: RecordLike): string[] {
  if (!query) {
    return [];
  }

  const normalizedQuery = normalizeQuery(query);
  if (normalizedQuery.length === 0) {
    return [];
  }

  const fields = transferCandidateFields();
  const matches = new Set<string>();

  const checks: Array<[string, readonly string[]]> = [
    ['transferId', fields.transferId],
    ['sourceChainSymbol', fields.sourceChainSymbol],
    ['destinationChainSymbol', fields.destinationChainSymbol],
    ['senderAddress', fields.senderAddress],
    ['recipientAddress', fields.recipientAddress],
    ['sourceTxId', fields.sourceTxId],
    ['messagingTxId', fields.messagingTxId],
    ['receiveTxId', fields.receiveTxId],
  ];

  for (const [label, keys] of checks) {
    const value = readFieldText(record, [...keys]);
    if (!value) {
      continue;
    }

    const normalizedValue = normalizeQuery(value);
    if (normalizedValue === normalizedQuery || normalizedValue.includes(normalizedQuery) || normalizedQuery.includes(normalizedValue)) {
      matches.add(label);
    }
  }

  return [...matches];
}

function normalizeTransfer(
  record: RecordLike,
  baseURL: string,
  options: {
    query?: string;
    transferIdFallback?: string;
    includeRaw: boolean;
  },
): ExplorerTransferSummary | ExplorerTransferDetails {
  const fields = transferCandidateFields();
  const transferId = readFieldText(record, [...fields.transferId]) ?? options.transferIdFallback ?? null;
  const summary: ExplorerTransferSummary = {
    transferId,
    sourceChainSymbol: readFieldText(record, [...fields.sourceChainSymbol]),
    destinationChainSymbol: readFieldText(record, [...fields.destinationChainSymbol]),
    senderAddress: readFieldText(record, [...fields.senderAddress]),
    recipientAddress: readFieldText(record, [...fields.recipientAddress]),
    sourceTxId: readFieldText(record, [...fields.sourceTxId]),
    messagingTxId: readFieldText(record, [...fields.messagingTxId]),
    receiveTxId: readFieldText(record, [...fields.receiveTxId]),
    amount: readFieldText(record, [...fields.amount]),
    status: readFieldText(record, [...fields.status]),
    createdAt: readFieldText(record, [...fields.createdAt]),
    updatedAt: readFieldText(record, [...fields.updatedAt]),
    historyUrl: buildHistoryUrl(
      readFieldText(record, [...fields.sourceChainSymbol]),
      readFieldText(record, [...fields.sourceTxId]),
    ),
    explorerUrl: buildExplorerUrl(baseURL, transferId),
    matchTypes: matchFields(options.query, record),
  };

  if (!options.includeRaw) {
    return summary;
  }

  return {
    ...summary,
    raw: record,
  };
}

export function normalizeExplorerTransfers(
  response: unknown,
  baseURL: string,
  query?: string,
): ExplorerTransferSummary[] {
  return extractTransferRecords(response).map((record) => normalizeTransfer(record, baseURL, {
    query,
    includeRaw: false,
  })) as ExplorerTransferSummary[];
}

export function normalizeExplorerTransfer(
  response: unknown,
  baseURL: string,
  transferIdFallback?: string,
  query?: string,
): ExplorerTransferDetails {
  const record = extractTransferRecords(response)[0];
  if (!record) {
    throw new Error('Unable to locate a transfer record in the explorer response.');
  }

  return normalizeTransfer(record, baseURL, {
    transferIdFallback,
    query,
    includeRaw: true,
  }) as ExplorerTransferDetails;
}

function normalizeSearchResult(record: RecordLike): ExplorerSearchResult | null {
  const fields = searchCandidateFields();
  const itemType = readFieldText(record, [...fields.itemType]);
  const value = readFieldText(record, [...fields.value]);

  if (!itemType || !value) {
    return null;
  }

  const chainSymbol = readFieldText(record, [...fields.chainSymbol]);

  return {
    chainSymbol: chainSymbol ?? '',
    itemType,
    value,
  };
}

export function normalizeExplorerSearchResults(response: unknown): ExplorerSearchResult[] {
  return extractSearchRecords(response)
    .map((record) => normalizeSearchResult(record))
    .filter((item): item is ExplorerSearchResult => item !== null);
}

export class AllbridgeExplorerApiClient {
  private readonly http: AxiosInstance;

  constructor(baseURL: string, timeout: number) {
    this.http = axios.create({
      baseURL,
      timeout,
      headers: ALLBRIDGE_MCP_CLIENT_HEADERS,
    });
  }

  async search(query: string): Promise<unknown> {
    return this.get<unknown>('/search', { q: query.trim() });
  }

  async listTransfers(params: ExplorerTransfersListParams = {}): Promise<unknown> {
    const query: Record<string, string | boolean | undefined> = {};
    if (typeof params.account === 'string' && params.account.trim().length > 0) {
      query.account = params.account.trim();
    }
    if (typeof params.chain === 'string' && params.chain.trim().length > 0) {
      query.chain = params.chain.trim();
    }
    if (typeof params.from === 'string' && params.from.trim().length > 0) {
      query.from = params.from.trim();
    }
    if (typeof params.to === 'string' && params.to.trim().length > 0) {
      query.to = params.to.trim();
    }
    if (typeof params.minFromAmount === 'number' && Number.isFinite(params.minFromAmount)) {
      query.minFromAmount = String(params.minFromAmount);
    }
    if (typeof params.maxFromAmount === 'number' && Number.isFinite(params.maxFromAmount)) {
      query.maxFromAmount = String(params.maxFromAmount);
    }
    if (typeof params.status === 'string' && params.status.trim().length > 0) {
      query.status = params.status.trim();
    }
    if (typeof params.page === 'number' && Number.isFinite(params.page)) {
      query.page = String(params.page);
    }
    if (typeof params.limit === 'number' && Number.isFinite(params.limit)) {
      query.limit = String(params.limit);
    }

    return this.get<unknown>('/transfers', query);
  }

  async searchTransfers(query?: string): Promise<unknown> {
    if (typeof query === 'string' && query.trim().length > 0) {
      return this.search(query);
    }

    return this.listTransfers();
  }

  async getTransfer(transferId: string): Promise<unknown> {
    return this.get<unknown>(`/transfers/${encodeURIComponent(transferId)}`, {});
  }

  private async get<T>(path: string, params: Record<string, string | boolean | undefined>): Promise<T> {
    try {
      const response = await this.http.get<T>(path, {
        params,
      });
      return response.data;
    } catch (error) {
      if (error instanceof AxiosError) {
        throw new AllbridgeExplorerApiError(
          error.response?.data?.message || error.message,
          error.response?.status,
          error.response?.data,
        );
      }
      throw error;
    }
  }
}
