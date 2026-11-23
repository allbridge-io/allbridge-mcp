/**
 * Instructions the MCP client receives on initialize (most clients add them to the model context).
 * Keep them short: the full workflow lives in SKILL.md and in each tool result's nextAction.
 */
export const SERVER_INSTRUCTIONS = [
  'Allbridge Core cross-chain transfers: plan_bridge_transfer, then create_bridge_execution_job, then sign the steps in order, then get_transfer_status.',
  'This server never signs. Steps are unsigned transactions for a signer MCP such as local-signer-mcp (sign_and_broadcast_transaction), or for any wallet followed by broadcast_signed_transaction.',
  'Confirm the route, amount, recipient and fees with the user before anything is signed.',
  'If no signer is connected, or you do not sign transactions yourself, do not stop at a refusal: give the user bridgePortalDeepLink from the plan or the job.',
  'It opens the same transfer in the Allbridge Core web app, where the user connects their own wallet, checks the recipient (the link does not carry it) and the fee payment method, and signs.',
  'You can still track the transfer afterwards with get_transfer_status once the user shares the transaction hash.',
].join(' ');
