export const COMMANDS = Object.freeze({
  MESSAGE_SEND: 'message_send',
  TASK_CREATE: 'task_create',
  TASK_UPDATE: 'task_update',
  TASK_COMMENT: 'task_comment',
  TASK_LIST: 'task_list',
  REVIEW_REQUEST: 'review_request',
  REVIEW_DECIDE: 'review_decide',
  AGENT_STATUS: 'agent_status',
  APPROVAL_LIST: 'approval_list',
  APPROVAL_RESPOND: 'approval_respond',
  RUNTIME_EVENTS: 'runtime_events',
  TOOL_ACTIVITY: 'tool_activity',
  HEALTH_STATUS: 'health_status',
  CROSS_TEAM_MESSAGES: 'cross_team_messages',
  CROSS_TEAM_SEND: 'cross_team_send',
});

export const MUTATING_COMMANDS = Object.freeze([
  COMMANDS.MESSAGE_SEND,
  COMMANDS.TASK_CREATE,
  COMMANDS.TASK_UPDATE,
  COMMANDS.TASK_COMMENT,
  COMMANDS.REVIEW_REQUEST,
  COMMANDS.REVIEW_DECIDE,
  COMMANDS.APPROVAL_RESPOND,
  COMMANDS.CROSS_TEAM_SEND,
]);

export function commandRequiresIdempotency(commandName) {
  return MUTATING_COMMANDS.includes(commandName);
}
