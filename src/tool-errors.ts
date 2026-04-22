export type ToolErrorCode =
  | 'missing_input'
  | 'unsupported_chain'
  | 'unsupported_token'
  | 'invalid_amount'
  | 'invalid_address'
  | 'unsupported_route'
  | 'insufficient_balance'
  | 'validation_error';

export type ToolErrorDetails = Record<string, unknown>;

export class UserFacingToolError extends Error {
  constructor(
    readonly code: ToolErrorCode,
    message: string,
    readonly details?: ToolErrorDetails,
  ) {
    super(message);
    this.name = 'UserFacingToolError';
  }
}

export function createToolErrorResult(error: UserFacingToolError) {
  const structuredContent = {
    ok: false,
    error: {
      code: error.code,
      message: error.message,
      details: error.details ?? null,
    },
  };

  return {
    isError: true,
    content: [{
      type: 'text' as const,
      text: JSON.stringify(structuredContent, null, 2),
    }],
    structuredContent,
  };
}
