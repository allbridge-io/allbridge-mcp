import axios, { AxiosError, type AxiosInstance } from 'axios';

import { ALLBRIDGE_MCP_CLIENT_HEADERS } from './http-headers.js';

export interface NextToken {
  tokenId: string;
  chain: string;
  symbol: string;
  address: string;
  decimals: number;
  isNative?: boolean;
}

export interface NextRelayerFee {
  tokenId: 'native' | string;
  amount: string;
  approvalSpender?: string;
}

export interface NextRoute {
  sourceTokenId: string;
  sourceSwap?: string;
  sourceIntermediaryTokenId?: string;
  messenger: string;
  destinationIntermediaryTokenId?: string;
  destinationSwap?: string;
  destinationTokenId: string;
  estimatedTime?: number;
}

export interface NextRouteResponse extends NextRoute {
  amount: string;
  amountOut: string;
  relayerFees: NextRelayerFee[];
}

export interface NextQuoteRequest {
  amount: string;
  sourceTokenId: string;
  destinationTokenId: string;
}

export type NextQuoteResponse = NextRouteResponse[];

export interface NextBaseTx {
  contractAddress: string;
  value: string;
}

export interface NextStandardTx extends NextBaseTx {
  tx: string;
}

export interface NextNearIntentsTx extends NextBaseTx {
  tx?: never;
}

export type NextTx = NextStandardTx | NextNearIntentsTx;

export interface NextCreateTxResponse {
  amountOut: string;
  amountMin: string;
  tx: NextTx;
}

export type NextBaseTxRequest = Omit<NextRoute, 'messenger'> & {
  amount: string;
  /**
   * Quoted output amount echoed back from `/quote` so the API can verify the
   * agent is building the same route it priced. Match the UI's behavior of
   * spreading the full RouteResponse minus `relayerFees`.
   */
  amountOut: string;
  sourceAddress: string;
  destinationAddress: string;
  metadata?: string;
};

export interface NextNearIntentsTxRequest extends NextBaseTxRequest {
  messenger: 'near-intents';
  refundTo?: string;
  relayerFee?: NextRelayerFee;
}

export interface NextStandardTxRequest extends NextBaseTxRequest {
  messenger: string;
  relayerFee: NextRelayerFee;
}

export type NextCreateTxRequest = NextNearIntentsTxRequest | NextStandardTxRequest;

export class NextApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'NextApiError';
  }
}

export class NextApiClient {
  private readonly http: AxiosInstance;

  constructor(baseURL: string, timeout: number) {
    this.http = axios.create({
      baseURL,
      timeout,
      headers: ALLBRIDGE_MCP_CLIENT_HEADERS,
    });
  }

  async getTokens(): Promise<NextToken[]> {
    return this.request<NextToken[]>('get', '/tokens');
  }

  async postQuote(body: NextQuoteRequest): Promise<NextQuoteResponse> {
    return this.request<NextQuoteResponse>('post', '/quote', body);
  }

  async postCreateTx(body: NextCreateTxRequest): Promise<NextCreateTxResponse> {
    return this.request<NextCreateTxResponse>('post', '/tx/create', body);
  }

  private async request<T>(method: 'get' | 'post', path: string, body?: unknown): Promise<T> {
    try {
      const response =
        method === 'get'
          ? await this.http.get<T>(path)
          : await this.http.post<T>(path, body);
      return response.data;
    } catch (error) {
      if (error instanceof AxiosError) {
        throw new NextApiError(
          error.response?.data?.message || error.message,
          error.response?.status,
          error.response?.data,
        );
      }
      throw error;
    }
  }
}
