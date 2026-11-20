/**
 * Runtime validator for the bridge execution job (v2) returned by create_bridge_execution_job.
 * Used by the smoke test and by clients that want to check the handoff contract before signing.
 */
type RecordLike = Record<string, unknown>;

const CHAIN_FAMILIES = new Set(['EVM', 'SOLANA', 'TRX', 'STX', 'SRB']);
const STEP_STATUSES = new Set(['awaiting_signature', 'blocked', 'requires_build']);

export type WalletSelectorContract = {
  walletId: string | null;
  senderAddress: string;
  chainFamily: string | null;
  chainSymbol: string;
};

export type ExecutionHandoffContract = {
  executionTarget: string;
  executionTool: string;
  executionAction: string;
  broadcastTarget: string;
  broadcastTool: string;
  broadcastAction: string;
  walletSelector: WalletSelectorContract;
  stepId: string;
};

export type BridgeExecutionStepContract = {
  id: string;
  order: number;
  status: string;
  summary: string;
  transactionFormat: string;
  /** Signer-ready unsigned transaction; null while the step still has to be built (`requires_build`). */
  transaction: RecordLike | null;
  /** How to build a `requires_build` step right before signing. */
  build: { tool: string; arguments: RecordLike } | null;
  handoff: ExecutionHandoffContract;
  nextOnSuccess: string;
};

export type BridgeExecutionJobContract = {
  jobId: string;
  kind: 'bridge_transfer';
  version: 'v2';
  mode: 'external_signer';
  status: string;
  summary: string;
  route: RecordLike;
  participants: { senderAddress: string; recipientAddress: string };
  amount: { amountInBaseUnits: string; amountInHumanUnits: string };
  handoff: ExecutionHandoffContract;
  steps: BridgeExecutionStepContract[];
  tracking: {
    sourceChain: string;
    destinationChain: string;
    transferStatusTool: string;
    transferStatusArguments: RecordLike;
  };
  nextAction: string;
};

function isRecord(value: unknown): value is RecordLike {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readString(value: unknown, fieldName: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Expected ${fieldName} to be a non-empty string.`);
  }
  return value;
}

function readNumber(value: unknown, fieldName: string): number {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    throw new Error(`Expected ${fieldName} to be a number.`);
  }
  return value;
}

function readRecord(value: unknown, fieldName: string): RecordLike {
  if (!isRecord(value)) {
    throw new Error(`Expected ${fieldName} to be an object.`);
  }
  return value;
}

function readNullableString(value: unknown, fieldName: string): string | null {
  return value === null ? null : readString(value, fieldName);
}

function readHandoff(value: unknown, fieldName: string): ExecutionHandoffContract {
  const handoff = readRecord(value, fieldName);
  const walletSelector = readRecord(handoff.walletSelector, `${fieldName}.walletSelector`);

  return {
    executionTarget: readString(handoff.executionTarget, `${fieldName}.executionTarget`),
    executionTool: readString(handoff.executionTool, `${fieldName}.executionTool`),
    executionAction: readString(handoff.executionAction, `${fieldName}.executionAction`),
    broadcastTarget: readString(handoff.broadcastTarget, `${fieldName}.broadcastTarget`),
    broadcastTool: readString(handoff.broadcastTool, `${fieldName}.broadcastTool`),
    broadcastAction: readString(handoff.broadcastAction, `${fieldName}.broadcastAction`),
    walletSelector: {
      walletId: readNullableString(walletSelector.walletId ?? null, `${fieldName}.walletSelector.walletId`),
      senderAddress: readString(walletSelector.senderAddress, `${fieldName}.walletSelector.senderAddress`),
      chainFamily: readNullableString(walletSelector.chainFamily ?? null, `${fieldName}.walletSelector.chainFamily`),
      chainSymbol: readString(walletSelector.chainSymbol, `${fieldName}.walletSelector.chainSymbol`),
    },
    stepId: readString(handoff.stepId, `${fieldName}.stepId`),
  };
}

function readStep(value: unknown, index: number): BridgeExecutionStepContract {
  const field = `steps[${index}]`;
  const step = readRecord(value, field);
  const status = readString(step.status, `${field}.status`);
  if (!STEP_STATUSES.has(status)) {
    throw new Error(`Unexpected ${field}.status ${status}.`);
  }

  let transaction: RecordLike | null = null;
  let build: BridgeExecutionStepContract['build'] = null;
  if (status === 'requires_build') {
    const buildRecord = readRecord(step.build, `${field}.build`);
    build = {
      tool: readString(buildRecord.tool, `${field}.build.tool`),
      arguments: readRecord(buildRecord.arguments, `${field}.build.arguments`),
    };
  } else {
    transaction = readRecord(step.transaction, `${field}.transaction`);
    const family = readString(transaction.chainFamily, `${field}.transaction.chainFamily`);
    if (!CHAIN_FAMILIES.has(family)) {
      throw new Error(`Unexpected ${field}.transaction.chainFamily ${family}.`);
    }
  }

  return {
    id: readString(step.id, `${field}.id`),
    order: readNumber(step.order, `${field}.order`),
    status,
    summary: readString(step.summary, `${field}.summary`),
    transactionFormat: readString(step.transactionFormat, `${field}.transactionFormat`),
    transaction,
    build,
    handoff: readHandoff(step.handoff, `${field}.handoff`),
    nextOnSuccess: readString(step.nextOnSuccess, `${field}.nextOnSuccess`),
  };
}

export function validateBridgeExecutionJobContract(value: unknown): BridgeExecutionJobContract {
  const job = readRecord(value, 'bridge execution job');
  const kind = readString(job.kind, 'kind');
  const version = readString(job.version, 'version');
  const mode = readString(job.mode, 'mode');

  if (kind !== 'bridge_transfer') {
    throw new Error(`Expected kind to be bridge_transfer, got ${kind}.`);
  }
  if (version !== 'v2') {
    throw new Error(`Expected version to be v2, got ${version}.`);
  }
  if (mode !== 'external_signer') {
    throw new Error(`Expected mode to be external_signer, got ${mode}.`);
  }
  if (!Array.isArray(job.steps) || job.steps.length === 0) {
    throw new Error('Expected steps to be a non-empty array.');
  }

  const participants = readRecord(job.participants, 'participants');
  const amount = readRecord(job.amount, 'amount');
  const tracking = readRecord(job.tracking, 'tracking');

  return {
    jobId: readString(job.jobId, 'jobId'),
    kind,
    version,
    mode,
    status: readString(job.status, 'status'),
    summary: readString(job.summary, 'summary'),
    route: readRecord(job.route, 'route'),
    participants: {
      senderAddress: readString(participants.senderAddress, 'participants.senderAddress'),
      recipientAddress: readString(participants.recipientAddress, 'participants.recipientAddress'),
    },
    amount: {
      amountInBaseUnits: readString(amount.amountInBaseUnits, 'amount.amountInBaseUnits'),
      amountInHumanUnits: readString(amount.amountInHumanUnits, 'amount.amountInHumanUnits'),
    },
    handoff: readHandoff(job.handoff, 'handoff'),
    steps: job.steps.map(readStep),
    tracking: {
      sourceChain: readString(tracking.sourceChain, 'tracking.sourceChain'),
      destinationChain: readString(tracking.destinationChain, 'tracking.destinationChain'),
      transferStatusTool: readString(tracking.transferStatusTool, 'tracking.transferStatusTool'),
      transferStatusArguments: readRecord(tracking.transferStatusArguments, 'tracking.transferStatusArguments'),
    },
    nextAction: readString(job.nextAction, 'nextAction'),
  };
}
