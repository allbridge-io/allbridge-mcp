import {
  AllbridgeCoreSdk,
  mainnet,
  type ActiveMessenger,
  type AmountFormatted,
  type AmountsAndGasFeeOptions,
  type BridgeApproveParams,
  type CheckAllowanceParams,
  type GetAllowanceParams,
  type LifiIntentsCreateOrderParams,
  type LifiIntentsOrder,
  type LifiIntentsQuote,
  type LifiIntentsQuoteParams,
  type Messenger,
  type NearIntentsCreateDepositParams,
  type NearIntentsDeposit,
  type NearIntentsQuote,
  type NearIntentsQuoteParams,
  type NearIntentsSubmitDepositParams,
  type RawTransaction,
  type SendParams,
  type TokenCoreFields,
  type TokenWithChainDetails,
  type TransferStatusResponse,
} from '@allbridge/bridge-core-sdk';

import { ALLBRIDGE_MCP_CLIENT_HEADERS } from './http-headers.js';
import { resolveRpcUrls } from './rpc-config.js';

export type CoreToken = TokenWithChainDetails;

/**
 * The Allbridge Core operations the MCP tools use. The production implementation delegates to the
 * Allbridge Core SDK; tests substitute a mock. Amounts follow the SDK: floats in token units unless
 * a method says otherwise.
 */
export interface CoreGateway {
  getTokens(): Promise<CoreToken[]>;
  getAmountToBeReceivedAndGasFeeOptions(
    amountFloat: string,
    sourceToken: CoreToken,
    destinationToken: CoreToken,
    messenger: Messenger,
  ): Promise<AmountsAndGasFeeOptions>;
  getAmountToBeReceived(
    amountFloat: string,
    sourceToken: CoreToken,
    destinationToken: CoreToken,
    messenger: Messenger,
  ): Promise<string>;
  getAverageTransferTime(sourceToken: CoreToken, destinationToken: CoreToken, messenger: Messenger): number | null;
  /** Float balance of the token. */
  getTokenBalance(account: string, token: TokenCoreFields): Promise<string>;
  getNativeTokenBalance(account: string, chainSymbol: string): Promise<AmountFormatted>;
  checkAllowance(params: CheckAllowanceParams): Promise<boolean>;
  /** Current allowance for the messenger's spender, integer in token base units. */
  getAllowance(params: GetAllowanceParams): Promise<string>;
  buildApproveTransaction(params: BridgeApproveParams): Promise<RawTransaction>;
  buildSendTransaction(params: SendParams): Promise<RawTransaction>;
  getNearIntentsQuote(params: NearIntentsQuoteParams): Promise<NearIntentsQuote>;
  createNearIntentsDeposit(params: NearIntentsCreateDepositParams): Promise<NearIntentsDeposit>;
  submitNearIntentsDeposit(params: NearIntentsSubmitDepositParams): Promise<void>;
  getLifiIntentsQuote(params: LifiIntentsQuoteParams): Promise<LifiIntentsQuote>;
  createLifiIntentsOrder(params: LifiIntentsCreateOrderParams): Promise<LifiIntentsOrder>;
  getTransferStatus(chainSymbol: string, txId: string): Promise<TransferStatusResponse>;
  /** The Stellar balance line (trustline) of the account for the token, or undefined if there is none. */
  getStellarBalanceLine(accountAddress: string, tokenAddress: string): Promise<unknown>;
  /** Unsigned Stellar `changeTrust` transaction XDR. */
  buildStellarTrustlineTransaction(params: { sender: string; tokenAddress: string; limit?: string }): Promise<string>;
  hasSolanaTokenAccount(accountAddress: string, token: CoreToken): Promise<boolean>;
}

export type SdkGatewayOptions = {
  coreApiUrl: string;
  sorobanNetworkPassphrase: string;
  rpcUrls?: Record<string, string>;
};

export function createSdkGateway(options: SdkGatewayOptions): CoreGateway {
  const sdk = new AllbridgeCoreSdk(options.rpcUrls ?? resolveRpcUrls(), {
    ...mainnet,
    coreApiUrl: options.coreApiUrl,
    coreApiHeaders: { ...mainnet.coreApiHeaders, ...ALLBRIDGE_MCP_CLIENT_HEADERS },
    sorobanNetworkPassphrase: options.sorobanNetworkPassphrase,
  });

  return {
    getTokens: () => sdk.tokens(),
    getAmountToBeReceivedAndGasFeeOptions: (amountFloat, sourceToken, destinationToken, messenger) =>
      sdk.getAmountToBeReceivedAndGasFeeOptions(amountFloat, sourceToken, destinationToken, messenger),
    getAmountToBeReceived: (amountFloat, sourceToken, destinationToken, messenger) =>
      sdk.getAmountToBeReceived(amountFloat, sourceToken, destinationToken, messenger as ActiveMessenger),
    getAverageTransferTime: (sourceToken, destinationToken, messenger) =>
      sdk.getAverageTransferTime(sourceToken, destinationToken, messenger),
    getTokenBalance: (account, token) => sdk.getTokenBalance({ account, token }),
    getNativeTokenBalance: (account, chainSymbol) => sdk.getNativeTokenBalance({ account, chainSymbol }),
    checkAllowance: (params) => sdk.bridge.checkAllowance(params),
    getAllowance: (params) => sdk.bridge.getAllowance(params),
    buildApproveTransaction: (params) => sdk.bridge.rawTxBuilder.approve(params),
    buildSendTransaction: (params) => sdk.bridge.rawTxBuilder.send(params),
    getNearIntentsQuote: (params) => sdk.nearIntents.getQuote(params),
    createNearIntentsDeposit: (params) => sdk.nearIntents.createDeposit(params),
    submitNearIntentsDeposit: (params) => sdk.nearIntents.submitDeposit(params),
    getLifiIntentsQuote: (params) => sdk.lifiIntents.getQuote(params),
    createLifiIntentsOrder: (params) => sdk.lifiIntents.createOrder(params),
    getTransferStatus: (chainSymbol, txId) => sdk.getTransferStatus(chainSymbol, txId),
    getStellarBalanceLine: (accountAddress, tokenAddress) => sdk.utils.srb.getBalanceLine(accountAddress, tokenAddress),
    buildStellarTrustlineTransaction: (params) => sdk.utils.srb.buildChangeTrustLineXdrTx(params),
    hasSolanaTokenAccount: (accountAddress, token) => sdk.utils.sol.hasTokenAccount(accountAddress, token),
  };
}
