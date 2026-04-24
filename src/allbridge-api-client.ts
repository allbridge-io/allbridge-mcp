import axios, { AxiosError, type AxiosInstance } from 'axios';

import type {
  AmountFormattedResponse,
  BridgeQuoteResponse,
  TokenWithChainDetails,
  TransferStatusResponse,
} from './types.js';

export class AllbridgeApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AllbridgeApiError';
  }
}

export class AllbridgeApiClient {
  private readonly http: AxiosInstance;

  constructor(baseURL: string, timeout: number) {
    this.http = axios.create({
      baseURL,
      timeout,
    });
  }

  async getTokens(params: { chain?: string; type?: string }): Promise<TokenWithChainDetails[]> {
    return this.get<TokenWithChainDetails[]>('/tokens', params);
  }

  async getTokenDetails(address: string): Promise<TokenWithChainDetails> {
    return this.get<TokenWithChainDetails>('/token/details', { address });
  }

  async getTokenBalance(params: { address: string; token: string }): Promise<{ result: string }> {
    return this.get<{ result: string }>('/token/balance', params);
  }

  async getTokenNativeBalance(params: { address: string; chain: string }): Promise<AmountFormattedResponse> {
    return this.get<AmountFormattedResponse>('/token/native/balance', params);
  }

  async getBridgeQuote(params: Record<string, string | boolean | undefined>): Promise<BridgeQuoteResponse> {
    return this.get<BridgeQuoteResponse>('/bridge/quote', params);
  }

  async getAmountToBeReceived(params: Record<string, string | boolean | undefined>): Promise<{
    amountInFloat: string;
    amountReceivedInFloat: string;
  }> {
    return this.get<{
      amountInFloat: string;
      amountReceivedInFloat: string;
    }>('/bridge/receive/calculate', params);
  }

  async getTransferTime(params: Record<string, string | boolean | undefined>): Promise<number | null> {
    return this.get<number | null>('/transfer/time', params);
  }

  async checkBridgeAllowance(params: Record<string, string | undefined>): Promise<boolean> {
    return this.get<boolean>('/check/bridge/allowance', params);
  }

  async buildBridgeApproveTx(params: Record<string, string | undefined>): Promise<unknown> {
    return this.get<unknown>('/raw/bridge/approve', params);
  }

  async buildBridgeTx(params: Record<string, string | boolean | undefined>): Promise<unknown> {
    return this.get<unknown>('/raw/bridge', params);
  }

  async getTransferStatus(params: Record<string, string>): Promise<TransferStatusResponse> {
    return this.get<TransferStatusResponse>('/transfer/status', params);
  }

  async checkStellarBalanceLine(params: { address: string; token: string }): Promise<unknown> {
    return this.get<unknown>('/check/stellar/balanceline', params);
  }

  async checkAlgorandOptIn(params: { sender: string; id: string; type?: 'asset' | 'app' }): Promise<boolean> {
    return this.get<boolean>('/check/algorand/optin', params);
  }

  async buildStellarTrustlineTransaction(params: { sender: string; tokenAddress: string; limit?: string }): Promise<string> {
    return this.get<string>('/raw/stellar/trustline', params);
  }

  async buildAlgorandOptInTransaction(params: { sender: string; id: string; type?: 'asset' | 'app' }): Promise<unknown> {
    return this.get<unknown>('/raw/algorand/optin', params);
  }

  private async get<T>(path: string, params: Record<string, string | boolean | undefined>): Promise<T> {
    try {
      const response = await this.http.get<T>(path, {
        params,
      });
      return response.data;
    } catch (error) {
      if (error instanceof AxiosError) {
        throw new AllbridgeApiError(
          error.response?.data?.message || error.message,
          error.response?.status,
          error.response?.data,
        );
      }
      throw error;
    }
  }
}
