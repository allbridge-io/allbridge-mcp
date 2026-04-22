export type ChainFamily = 'EVM' | 'SOLANA' | 'TRX' | 'ALG' | 'STX' | 'SRB' | 'SUI';

export interface SignedEvmTransaction {
  chainFamily: 'EVM';
  chainId: number;
  chainSymbol?: string;
  walletId?: string;
  signedTransaction: string;
}

export interface SignedSolanaTransaction {
  chainFamily: 'SOLANA';
  walletId?: string;
  signedTransactionHex: string;
}

export interface SignedTronTransaction {
  chainFamily: 'TRX';
  walletId?: string;
  signedTransaction: Record<string, unknown>;
}

export interface SignedAlgorandTransaction {
  chainFamily: 'ALG';
  walletId?: string;
  signedTransactionsBase64: string[];
}

export interface SignedStacksTransaction {
  chainFamily: 'STX';
  walletId?: string;
  signedTransactionHex: string;
}

export interface SignedSorobanTransaction {
  chainFamily: 'SRB';
  walletId?: string;
  signedTransactionXdr: string;
}

export interface SignedSuiTransaction {
  chainFamily: 'SUI';
  walletId?: string;
  signedTransaction: {
    bytesBase64: string;
    signature: string;
  };
}

export type SignedTransaction =
  | SignedEvmTransaction
  | SignedSolanaTransaction
  | SignedTronTransaction
  | SignedAlgorandTransaction
  | SignedStacksTransaction
  | SignedSorobanTransaction
  | SignedSuiTransaction;

export interface BroadcastResult {
  chainFamily: ChainFamily;
  txHash: string;
  receipt: Record<string, unknown> | null;
}
