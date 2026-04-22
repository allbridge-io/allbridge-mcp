import algosdk from 'algosdk';
import bs58 from 'bs58';
import { JsonRpcProvider, TransactionResponse } from 'ethers';
import { Connection, VersionedTransaction } from '@solana/web3.js';
import { SuiClient } from '@mysten/sui/client';
import { BytesReader, broadcastTransaction, deserializeTransaction } from '@stacks/transactions';
import { STACKS_MAINNET, STACKS_TESTNET } from '@stacks/network';
import { TransactionBuilder, rpc as SorobanRpc, type Transaction as StellarTransaction } from '@stellar/stellar-sdk';
import { TronWeb } from 'tronweb';

import { config } from './config.js';
import type {
  BroadcastResult,
  SignedAlgorandTransaction,
  SignedEvmTransaction,
  SignedSolanaTransaction,
  SignedSorobanTransaction,
  SignedStacksTransaction,
  SignedSuiTransaction,
  SignedTransaction,
  SignedTronTransaction,
} from './transaction-types.js';

function normalizeHex(value: string): string {
  const trimmed = value.trim();
  return trimmed.startsWith('0x') ? trimmed.slice(2) : trimmed;
}

type EvmBroadcastContext = {
  walletId?: string;
  chainId: number;
  chainSymbol?: string;
};

function normalizeScope(value: string | number | undefined | null): string | null {
  if (value === undefined || value === null) {
    return null;
  }

  const trimmed = String(value).trim();
  return trimmed === '' ? null : trimmed.toUpperCase();
}

function getScopedEnvValue(baseName: string, scope: string): string | null {
  const value = process.env[`${baseName}_${scope}`];
  if (!value) {
    return null;
  }

  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function resolveEvmRpcUrl(context: EvmBroadcastContext): string {
  const candidates = [
    normalizeScope(context.walletId),
    normalizeScope(context.chainSymbol),
    normalizeScope(context.chainId),
    'DEFAULT',
  ].filter((value): value is string => Boolean(value));

  for (const scope of candidates) {
    const resolved = scope === 'DEFAULT'
      ? config.ALLBRIDGE_EVM_RPC_URL
      : getScopedEnvValue('ALLBRIDGE_EVM_RPC_URL', scope);
    if (resolved) {
      return resolved;
    }
  }

  throw new Error('ALLBRIDGE_EVM_RPC_URL is not configured.');
}

function getSolanaConnection(): Connection {
  if (!config.ALLBRIDGE_SOL_RPC_URL) {
    throw new Error('ALLBRIDGE_SOL_RPC_URL is not configured.');
  }

  return new Connection(config.ALLBRIDGE_SOL_RPC_URL, 'confirmed');
}

function getTronWeb(): TronWeb {
  if (!config.ALLBRIDGE_TRX_RPC_URL) {
    throw new Error('ALLBRIDGE_TRX_RPC_URL is not configured.');
  }

  return new TronWeb(
    config.ALLBRIDGE_TRX_RPC_URL,
    config.ALLBRIDGE_TRX_RPC_URL,
    config.ALLBRIDGE_TRX_RPC_URL,
  );
}

function getAlgodClient() {
  if (!config.ALLBRIDGE_ALG_RPC_URL) {
    throw new Error('ALLBRIDGE_ALG_RPC_URL is not configured.');
  }

  return new algosdk.Algodv2('', config.ALLBRIDGE_ALG_RPC_URL);
}

async function resolveStacksNetworkForRpcUrl(rpcUrl: string) {
  const infoUrl = new URL('/v2/info', rpcUrl.endsWith('/') ? rpcUrl : `${rpcUrl}/`).toString();
  const response = await fetch(infoUrl, {
    signal: typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
      ? AbortSignal.timeout(5000)
      : undefined,
  });

  if (!response.ok) {
    throw new Error(`Unable to validate Stacks RPC network from ${infoUrl}: ${response.status} ${response.statusText}`);
  }

  const payload = await response.json() as Record<string, unknown>;
  const rawNetworkId = payload.network_id ?? payload.networkId ?? payload.chain_id ?? payload.chainId;

  if (rawNetworkId === STACKS_MAINNET.chainId || rawNetworkId === 0x00000001) {
    return {
      network: { ...STACKS_MAINNET, client: { baseUrl: rpcUrl } },
    };
  }

  if (rawNetworkId === STACKS_TESTNET.chainId || rawNetworkId === 0x80000000) {
    return {
      network: { ...STACKS_TESTNET, client: { baseUrl: rpcUrl } },
    };
  }

  throw new Error(
    `Unsupported Stacks network reported by ${infoUrl}: ${String(rawNetworkId)}. Only mainnet and testnet are supported.`,
  );
}

function getSorobanPassphrase(): string {
  if (config.ALLBRIDGE_SRB_NETWORK_PASSPHRASE) {
    return config.ALLBRIDGE_SRB_NETWORK_PASSPHRASE;
  }

  throw new Error('ALLBRIDGE_SRB_NETWORK_PASSPHRASE is not configured.');
}

function getSorobanClient() {
  if (!config.ALLBRIDGE_SRB_RPC_URL) {
    throw new Error('ALLBRIDGE_SRB_RPC_URL is not configured.');
  }

  return new SorobanRpc.Server(config.ALLBRIDGE_SRB_RPC_URL);
}

function getSuiClient(): SuiClient {
  if (!config.ALLBRIDGE_SUI_RPC_URL) {
    throw new Error('ALLBRIDGE_SUI_RPC_URL is not configured.');
  }

  return new SuiClient({ url: config.ALLBRIDGE_SUI_RPC_URL });
}

async function broadcastEvm(signedTransaction: SignedEvmTransaction): Promise<BroadcastResult> {
  const provider = new JsonRpcProvider(resolveEvmRpcUrl(signedTransaction));
  const response: TransactionResponse = await provider.broadcastTransaction(signedTransaction.signedTransaction);
  const receipt = await response.wait();

  return {
    chainFamily: 'EVM',
    txHash: response.hash,
    receipt: receipt
      ? {
          blockNumber: receipt.blockNumber,
          status: receipt.status,
          gasUsed: receipt.gasUsed.toString(),
        }
      : null,
  };
}

async function broadcastSolana(signedTransactionHex: string): Promise<BroadcastResult> {
  const connection = getSolanaConnection();
  const transaction = VersionedTransaction.deserialize(Buffer.from(normalizeHex(signedTransactionHex), 'hex'));
  const signature = await connection.sendRawTransaction(transaction.serialize(), { skipPreflight: false });
  await connection.confirmTransaction(signature, 'confirmed');

  return {
    chainFamily: 'SOLANA',
    txHash: signature,
    receipt: null,
  };
}

async function broadcastTron(signedTransaction: Record<string, unknown>): Promise<BroadcastResult> {
  const tronWeb = getTronWeb();
  const response = await tronWeb.trx.sendRawTransaction(signedTransaction as never);
  const txHash = (response as { txid?: string; txID?: string }).txid
    ?? (response as { txID?: string }).txID
    ?? '';

  return {
    chainFamily: 'TRX',
    txHash,
    receipt: { response },
  };
}

async function broadcastAlgorand(signedTransactionsBase64: string[]): Promise<BroadcastResult> {
  const algod = getAlgodClient();
  const signedTransactions = signedTransactionsBase64.map((value) => Buffer.from(value, 'base64'));
  const { txid } = await algod.sendRawTransaction(signedTransactions).do();

  return {
    chainFamily: 'ALG',
    txHash: txid,
    receipt: null,
  };
}

async function broadcastStacks(signedTransactionHex: string): Promise<BroadcastResult> {
  if (!config.ALLBRIDGE_STX_RPC_URL) {
    throw new Error('ALLBRIDGE_STX_RPC_URL is not configured.');
  }

  const { network } = await resolveStacksNetworkForRpcUrl(config.ALLBRIDGE_STX_RPC_URL);
  const tx = deserializeTransaction(new BytesReader(Buffer.from(normalizeHex(signedTransactionHex), 'hex')));
  const response = await broadcastTransaction({ transaction: tx, network });

  return {
    chainFamily: 'STX',
    txHash: response.txid,
    receipt: response as unknown as Record<string, unknown>,
  };
}

async function broadcastSoroban(signedTransactionXdr: string): Promise<BroadcastResult> {
  const server = getSorobanClient();
  const transaction = TransactionBuilder.fromXDR(signedTransactionXdr, getSorobanPassphrase()) as StellarTransaction;
  const sent = await server.sendTransaction(transaction);

  return {
    chainFamily: 'SRB',
    txHash: sent.hash,
    receipt: sent as unknown as Record<string, unknown>,
  };
}

async function broadcastSui(signedTransaction: { bytesBase64: string; signature: string }): Promise<BroadcastResult> {
  const client = getSuiClient();
  const result = await client.executeTransactionBlock({
    transactionBlock: Buffer.from(signedTransaction.bytesBase64, 'base64'),
    signature: signedTransaction.signature,
    options: {
      showEffects: true,
      showEvents: true,
      showObjectChanges: true,
    },
  });

  return {
    chainFamily: 'SUI',
    txHash: result.digest,
    receipt: result as unknown as Record<string, unknown>,
  };
}

export async function broadcastSignedTransactionByFamily(signedTransaction: SignedTransaction): Promise<BroadcastResult> {
  switch (signedTransaction.chainFamily) {
    case 'EVM':
      return broadcastEvm(signedTransaction as SignedEvmTransaction);
    case 'SOLANA':
      return broadcastSolana((signedTransaction as SignedSolanaTransaction).signedTransactionHex);
    case 'TRX':
      return broadcastTron((signedTransaction as SignedTronTransaction).signedTransaction);
    case 'ALG':
      return broadcastAlgorand((signedTransaction as SignedAlgorandTransaction).signedTransactionsBase64);
    case 'STX':
      return broadcastStacks((signedTransaction as SignedStacksTransaction).signedTransactionHex);
    case 'SRB':
      return broadcastSoroban((signedTransaction as SignedSorobanTransaction).signedTransactionXdr);
    case 'SUI':
      return broadcastSui((signedTransaction as SignedSuiTransaction).signedTransaction);
    default:
      throw new Error(`Unsupported chain family ${(signedTransaction as { chainFamily: string }).chainFamily}.`);
  }
}
