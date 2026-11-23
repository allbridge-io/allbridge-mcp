import type { RawTransaction } from '@allbridge/bridge-core-sdk';

import type { CoreToken } from './core-gateway.js';

/**
 * Unsigned transactions in the shape `local-signer-mcp` accepts in `sign_transaction` and
 * `sign_and_broadcast_transaction`, so a step can be forwarded as is.
 */
export type UnsignedEvmTransaction = {
  chainFamily: 'EVM';
  chainId: number;
  chainSymbol: string;
  walletId?: string;
  from: string;
  to: string;
  data: string;
  value: string;
};

export type UnsignedSolanaTransaction = {
  chainFamily: 'SOLANA';
  walletId?: string;
  serializedTransactionHex: string;
};

export type UnsignedTronTransaction = {
  chainFamily: 'TRX';
  walletId?: string;
  rawTransaction: Record<string, unknown>;
};

export type UnsignedStacksTransaction = {
  chainFamily: 'STX';
  walletId?: string;
  serializedTransactionHex: string;
};

export type UnsignedStellarTransaction = {
  chainFamily: 'SRB';
  walletId?: string;
  serializedTransactionXdr: string;
};

export type UnsignedTransaction =
  | UnsignedEvmTransaction
  | UnsignedSolanaTransaction
  | UnsignedTronTransaction
  | UnsignedStacksTransaction
  | UnsignedStellarTransaction;

export type TransactionFormat =
  | 'unsignedEvmTransaction'
  | 'serializedSolanaTransactionHex'
  | 'tronRawTransaction'
  | 'serializedStacksTransactionHex'
  | 'stellarTransactionXdr';

export const TRANSACTION_FORMATS: Record<UnsignedTransaction['chainFamily'], TransactionFormat> = {
  EVM: 'unsignedEvmTransaction',
  SOLANA: 'serializedSolanaTransactionHex',
  TRX: 'tronRawTransaction',
  STX: 'serializedStacksTransactionHex',
  SRB: 'stellarTransactionXdr',
};

type Serializable = { serialize: (config?: { requireAllSignatures?: boolean; verifySignatures?: boolean }) => Uint8Array };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function requireString(value: unknown, what: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Expected ${what} to be a non-empty string.`);
  }
  return value;
}

function evmChainId(token: CoreToken): number {
  const raw = (token as { chainId?: unknown }).chainId;
  if (typeof raw === 'number' && Number.isInteger(raw)) {
    return raw;
  }
  if (typeof raw === 'string' && raw.trim() !== '') {
    return Number(BigInt(raw.trim()));
  }
  throw new Error(`Token on ${token.chainSymbol} has no EVM chain id.`);
}

/** Converts a raw SDK transaction of the token's chain into the signer-ready shape. */
export function toUnsignedTransaction(raw: RawTransaction, token: CoreToken, walletId?: string): UnsignedTransaction {
  const wallet = walletId ? { walletId } : {};

  switch (token.chainType) {
    case 'EVM': {
      if (!isRecord(raw)) {
        throw new Error('Expected an EVM transaction object.');
      }
      return {
        chainFamily: 'EVM',
        chainId: evmChainId(token),
        chainSymbol: token.chainSymbol,
        ...wallet,
        from: requireString(raw.from, 'EVM transaction from'),
        to: requireString(raw.to, 'EVM transaction to'),
        data: typeof raw.data === 'string' ? raw.data : '0x',
        value: raw.value === undefined || raw.value === null ? '0' : String(raw.value),
      };
    }
    case 'SOLANA': {
      if (!raw || typeof (raw as Partial<Serializable>).serialize !== 'function') {
        throw new Error('Expected a Solana transaction.');
      }
      const bytes = (raw as Serializable).serialize({ requireAllSignatures: false, verifySignatures: false });
      return {
        chainFamily: 'SOLANA',
        ...wallet,
        serializedTransactionHex: Buffer.from(bytes).toString('hex'),
      };
    }
    case 'TRX': {
      if (!isRecord(raw)) {
        throw new Error('Expected a Tron transaction object.');
      }
      return {
        chainFamily: 'TRX',
        ...wallet,
        rawTransaction: JSON.parse(JSON.stringify(raw)) as Record<string, unknown>,
      };
    }
    case 'STX':
      return {
        chainFamily: 'STX',
        ...wallet,
        serializedTransactionHex: requireString(raw, 'Stacks transaction hex'),
      };
    case 'SRB':
      return {
        chainFamily: 'SRB',
        ...wallet,
        serializedTransactionXdr: requireString(raw, 'Stellar transaction XDR'),
      };
    default:
      throw new Error(`Chain type ${String(token.chainType)} is not supported by this server.`);
  }
}
