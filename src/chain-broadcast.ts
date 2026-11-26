import { JsonRpcProvider, TransactionResponse } from 'ethers';
import { Connection, VersionedTransaction } from '@solana/web3.js';
import { BytesReader, broadcastTransaction, deserializeTransaction } from '@stacks/transactions';
import { STACKS_MAINNET, STACKS_TESTNET } from '@stacks/network';
import { TransactionBuilder, rpc as SorobanRpc, type Transaction as StellarTransaction } from '@stellar/stellar-sdk';
import { TronWeb } from 'tronweb';
import { SuiGrpcClient } from '@mysten/sui/grpc';

import { config } from './config.js';
import { evmChainSymbolById, resolveRpcUrl } from './rpc-config.js';
import type {
  BroadcastResult,
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

function resolveEvmRpcUrl(signedTransaction: SignedEvmTransaction): string {
  const chainSymbol = signedTransaction.chainSymbol?.trim().toUpperCase() || evmChainSymbolById(signedTransaction.chainId);
  if (!chainSymbol) {
    throw new Error(`Unknown EVM chain id ${signedTransaction.chainId}. Pass chainSymbol and set ALLBRIDGE_<CHAIN>_RPC_URL.`);
  }
  return resolveRpcUrl(chainSymbol);
}

function getSolanaConnection(): Connection {
  return new Connection(resolveRpcUrl('SOL'), 'confirmed');
}

function getTronWeb(): TronWeb {
  const rpcUrl = resolveRpcUrl('TRX');
  return new TronWeb(rpcUrl, rpcUrl, rpcUrl);
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

function getSorobanClient() {
  return new SorobanRpc.Server(resolveRpcUrl('SRB'));
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

async function broadcastStacks(signedTransactionHex: string): Promise<BroadcastResult> {
  const { network } = await resolveStacksNetworkForRpcUrl(resolveRpcUrl('STX'));
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
  const transaction = TransactionBuilder.fromXDR(signedTransactionXdr, config.ALLBRIDGE_SRB_NETWORK_PASSPHRASE) as StellarTransaction;
  const sent = await server.sendTransaction(transaction);
  if (sent.status === 'ERROR' || sent.status === 'TRY_AGAIN_LATER') {
    throw new Error(`Stellar RPC rejected the transaction ${sent.hash} with status ${sent.status}.`);
  }

  return {
    chainFamily: 'SRB',
    txHash: sent.hash,
    receipt: sent as unknown as Record<string, unknown>,
  };
}

/** Sui full nodes serve gRPC-web only (JSON-RPC was shut down), at the base URL of the node. */
function getSuiClient(): SuiGrpcClient {
  return new SuiGrpcClient({ network: 'mainnet', baseUrl: resolveRpcUrl('SUI').replace(/\/+$/, '') });
}

async function broadcastSui(signedTransaction: SignedSuiTransaction['signedTransaction']): Promise<BroadcastResult> {
  const result = await getSuiClient().executeTransaction({
    transaction: Buffer.from(signedTransaction.bytesBase64, 'base64'),
    signatures: [signedTransaction.signature],
  });
  const transaction = result.Transaction ?? result.FailedTransaction;
  if (result.$kind === 'FailedTransaction') {
    throw new Error(`Sui transaction ${transaction.digest} failed: ${JSON.stringify(transaction.status.error)}.`);
  }

  return {
    chainFamily: 'SUI',
    txHash: transaction.digest,
    receipt: { status: transaction.status, epoch: transaction.epoch },
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
