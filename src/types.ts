export interface TokenWithChainDetails {
  symbol: string;
  name: string;
  decimals: number;
  tokenAddress: string;
  chainSymbol: string;
  chainName?: string;
  chainType?: string;
  transferTime?: Record<string, number>;
  txCostAmount?: Record<string, string>;
  [key: string]: unknown;
}

export interface BridgeQuotePaymentMethod {
  feePaymentMethod: string;
  fee: string;
  pendingTxs?: number;
  pendingAmount?: string;
  estimatedAmount?: {
    min?: string;
    max?: string;
  };
  poolImpact?: Record<string, string>;
  lpFeeTotal?: string;
  [key: string]: unknown;
}

export interface BridgeQuoteOption {
  messenger: string;
  messengerIndex?: number;
  estimatedTimeMs?: number | null;
  paymentMethods: BridgeQuotePaymentMethod[];
  [key: string]: unknown;
}

export interface BridgeQuoteResponse {
  amountInt: string;
  amountFloat: string;
  sourceTokenAddress: string;
  destinationTokenAddress: string;
  options: BridgeQuoteOption[];
}

export interface AmountFormattedResponse {
  int: string;
  float: string;
}

export interface TransferStatusResponse {
  txId: string;
  sourceChainSymbol: string;
  destinationChainSymbol: string;
  sendAmount?: string;
  sendAmountFormatted?: number;
  signaturesCount?: number;
  signaturesNeeded?: number;
  responseTime?: number;
  [key: string]: unknown;
}
