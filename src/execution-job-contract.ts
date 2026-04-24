type RecordLike = Record<string, unknown>;

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
  transactionShape: string;
  nextStepId?: string;
  stepCount?: number;
  stepIds?: string[];
};

export type BridgeExecutionStepContract = {
  id: string;
  order: number;
  type: string;
  status: string;
  required: boolean;
  summary: string;
  transactionShape: string;
  transaction: unknown;
  handoff: ExecutionHandoffContract;
  nextOnSuccess: string;
};

export type DestinationSetupContract = {
  required: boolean;
  chainFamily: 'ALG' | 'SRB' | null;
  chainSymbol: string | null;
  accountAddress: string;
  checkTool: string;
  buildTool: string;
  reason: string | null;
};

export type BridgeExecutionJobContract = {
  jobId: string;
  kind: 'bridge_transfer';
  version: 'v1';
  mode: string;
  status: string;
  summary: string;
  route: RecordLike;
  participants: {
    senderAddress: string;
    recipientAddress: string;
  };
  amount: {
    amountInBaseUnits: string;
    amountInHumanUnits: string;
  };
  handoff: ExecutionHandoffContract;
  steps: BridgeExecutionStepContract[];
  tracking: {
    sourceChain: string;
    destinationChain: string;
    sourceTokenAddress: string;
    destinationTokenAddress: string;
    transferStatusTool: string;
    transferStatusArguments: RecordLike;
    historyUrlTemplate?: string;
  };
  destinationSetup?: DestinationSetupContract | null;
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

function readBoolean(value: unknown, fieldName: string): boolean {
  if (typeof value !== 'boolean') {
    throw new Error(`Expected ${fieldName} to be a boolean.`);
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
  if (value === null) {
    return null;
  }

  return readString(value, fieldName);
}

function readOptionalNumber(value: unknown, fieldName: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  return readNumber(value, fieldName);
}

function readOptionalStringArray(value: unknown, fieldName: string): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`Expected ${fieldName} to be a non-empty array.`);
  }

  return value.map((entry, index) => readString(entry, `${fieldName}[${index}]`));
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
      walletId: readNullableString(walletSelector.walletId, `${fieldName}.walletSelector.walletId`),
      senderAddress: readString(walletSelector.senderAddress, `${fieldName}.walletSelector.senderAddress`),
      chainFamily: readNullableString(walletSelector.chainFamily, `${fieldName}.walletSelector.chainFamily`),
      chainSymbol: readString(walletSelector.chainSymbol, `${fieldName}.walletSelector.chainSymbol`),
    },
    stepId: readString(handoff.stepId, `${fieldName}.stepId`),
    transactionShape: readString(handoff.transactionShape, `${fieldName}.transactionShape`),
    ...(handoff.nextStepId !== undefined ? { nextStepId: readString(handoff.nextStepId, `${fieldName}.nextStepId`) } : {}),
    ...(handoff.stepCount !== undefined ? { stepCount: readNumber(handoff.stepCount, `${fieldName}.stepCount`) } : {}),
    ...(handoff.stepIds !== undefined ? { stepIds: readOptionalStringArray(handoff.stepIds, `${fieldName}.stepIds`) } : {}),
  };
}

function readSteps(value: unknown): BridgeExecutionStepContract[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('Expected steps to be a non-empty array.');
  }

  return value.map((step, index) => {
    const record = readRecord(step, `steps[${index}]`);

    return {
      id: readString(record.id, `steps[${index}].id`),
      order: readNumber(record.order, `steps[${index}].order`),
      type: readString(record.type, `steps[${index}].type`),
      status: readString(record.status, `steps[${index}].status`),
      required: readBoolean(record.required, `steps[${index}].required`),
      summary: readString(record.summary, `steps[${index}].summary`),
      transactionShape: readString(record.transactionShape, `steps[${index}].transactionShape`),
      transaction: record.transaction,
      handoff: readHandoff(record.handoff, `steps[${index}].handoff`),
      nextOnSuccess: readString(record.nextOnSuccess, `steps[${index}].nextOnSuccess`),
    };
  });
}

export function validateBridgeExecutionJobContract(value: unknown): BridgeExecutionJobContract {
  const job = readRecord(value, 'bridge execution job');
  const route = readRecord(job.route, 'route');
  const participants = readRecord(job.participants, 'participants');
  const amount = readRecord(job.amount, 'amount');
  const handoff = readRecord(job.handoff, 'handoff');
  const tracking = readRecord(job.tracking, 'tracking');
  const kind = readString(job.kind, 'kind');
  const version = readString(job.version, 'version');
  const mode = readString(job.mode, 'mode');

  if (kind !== 'bridge_transfer') {
    throw new Error(`Expected kind to be bridge_transfer, got ${kind}.`);
  }

  if (version !== 'v1') {
    throw new Error(`Expected version to be v1, got ${version}.`);
  }

  if (mode !== 'external_signer') {
    throw new Error(`Expected mode to be external_signer, got ${mode}.`);
  }

  const validated: BridgeExecutionJobContract = {
    jobId: readString(job.jobId, 'jobId'),
    kind,
    version,
    mode,
    status: readString(job.status, 'status'),
    summary: readString(job.summary, 'summary'),
    route,
    participants: {
      senderAddress: readString(participants.senderAddress, 'participants.senderAddress'),
      recipientAddress: readString(participants.recipientAddress, 'participants.recipientAddress'),
    },
    amount: {
      amountInBaseUnits: readString(amount.amountInBaseUnits, 'amount.amountInBaseUnits'),
      amountInHumanUnits: readString(amount.amountInHumanUnits, 'amount.amountInHumanUnits'),
    },
    handoff: readHandoff(handoff, 'handoff'),
    steps: readSteps(job.steps),
    tracking: {
      sourceChain: readString(tracking.sourceChain, 'tracking.sourceChain'),
      destinationChain: readString(tracking.destinationChain, 'tracking.destinationChain'),
      sourceTokenAddress: readString(tracking.sourceTokenAddress, 'tracking.sourceTokenAddress'),
      destinationTokenAddress: readString(tracking.destinationTokenAddress, 'tracking.destinationTokenAddress'),
      transferStatusTool: readString(tracking.transferStatusTool, 'tracking.transferStatusTool'),
      transferStatusArguments: readRecord(tracking.transferStatusArguments, 'tracking.transferStatusArguments'),
    },
    nextAction: readString(job.nextAction, 'nextAction'),
  };

  return validated;
}
