import { RuntimeAdapter, RuntimeAdapterError } from './RuntimeAdapter.js';

export class ClaudeStreamJsonAdapter extends RuntimeAdapter {
  constructor({ runtimeId, teamId, agentId, child }) {
    super('claude');
    this.runtimeId = requireString(runtimeId, 'runtimeId');
    this.teamId = requireString(teamId, 'teamId');
    this.agentId = requireString(agentId, 'agentId');
    if (!child || typeof child !== 'object') {
      throw new TypeError('child is required');
    }
    this.child = child;
  }

  async sendTurn(input) {
    const text = requireString(input?.message?.text, 'message.text');
    const payload = {
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'text', text }],
      },
    };

    await this.#writeJsonLine(payload);

    return {
      accepted: true,
      responseState: 'accepted_by_runtime',
      receipt: {
        written: true,
        runtimeId: this.runtimeId,
      },
    };
  }

  async sendToolResult(input) {
    const toolUseId = requireString(input?.toolUseId, 'toolUseId');
    const payload = {
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: toolUseId,
            content: JSON.stringify(input.result ?? null),
          },
        ],
      },
    };

    await this.#writeJsonLine(payload);

    return {
      accepted: true,
      responseState: 'tool_result_returned',
      receipt: {
        written: true,
        runtimeId: this.runtimeId,
        toolUseId,
      },
    };
  }

  approve(input) {
    const approvalId = requireString(input?.approvalId, 'approvalId');
    const decision = requireString(input?.decision, 'decision');
    const reason = typeof input?.reason === 'string' ? input.reason : '';
    const behavior = decisionToBehavior(decision);
    const response =
      behavior === 'allow'
        ? { behavior, updatedInput: {} }
        : { behavior, message: reason || 'Denied by operator.' };
    const payload = {
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: approvalId,
        response,
      },
    };

    this.#writeJsonLineNow(payload);

    return {
      accepted: true,
      responseState: 'approval_response_returned',
      receipt: {
        written: true,
        runtimeId: this.runtimeId,
        approvalId,
        decision,
      },
    };
  }

  events() {
    const stdout = this.child.stdout;
    if (!stdout || typeof stdout.on !== 'function') {
      throw new RuntimeAdapterError('Claude stream-json stdout is not readable', {
        runtimeId: this.runtimeId,
      });
    }
    return createRuntimeEventIterable({
      stream: stdout,
      runtimeId: this.runtimeId,
      teamId: this.teamId,
      agentId: this.agentId,
    });
  }

  async #writeJsonLine(payload) {
    const stdin = this.#requireWritableStdin();
    await new Promise((resolve, reject) => {
      stdin.write(`${JSON.stringify(payload)}\n`, (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }

  #writeJsonLineNow(payload) {
    this.#requireWritableStdin().write(`${JSON.stringify(payload)}\n`, () => {});
  }

  #requireWritableStdin() {
    const stdin = this.child.stdin;
    if (!stdin || stdin.writable === false || stdin.destroyed === true) {
      throw new RuntimeAdapterError('Claude stream-json stdin is not writable', {
        runtimeId: this.runtimeId,
      });
    }
    return stdin;
  }
}

function createRuntimeEventIterable({ stream, runtimeId, teamId, agentId }) {
  const queue = [];
  const waiters = [];
  let buffer = '';
  let ended = false;

  const push = (event) => {
    const waiter = waiters.shift();
    if (waiter) waiter({ value: event, done: false });
    else queue.push(event);
  };

  stream.on('data', (chunk) => {
    buffer += Buffer.from(chunk).toString('utf8');
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      for (const event of normalizeStreamJsonLine(line, { runtimeId, teamId, agentId })) {
        push(event);
      }
    }
  });

  stream.on('end', () => {
    ended = true;
    while (waiters.length) {
      waiters.shift()({ value: undefined, done: true });
    }
  });

  return {
    [Symbol.asyncIterator]() {
      return {
        next() {
          if (queue.length) return Promise.resolve({ value: queue.shift(), done: false });
          if (ended) return Promise.resolve({ value: undefined, done: true });
          return new Promise((resolve) => waiters.push(resolve));
        },
      };
    },
  };
}

function normalizeStreamJsonLine(line, context) {
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch (error) {
    return [
      {
        type: 'parse_error',
        runtimeId: context.runtimeId,
        teamId: context.teamId,
        agentId: context.agentId,
        error: error instanceof Error ? error.message : String(error),
        raw: line,
      },
    ];
  }
  return normalizeStreamJsonEvent(parsed, context);
}

function normalizeStreamJsonEvent(parsed, context) {
  const base = {
    runtimeId: context.runtimeId,
    teamId: context.teamId,
    agentId: context.agentId,
    sessionId: typeof parsed.session_id === 'string' ? parsed.session_id : null,
    raw: parsed,
  };

  if (parsed.type === 'assistant') {
    const events = [];
    const text = extractAssistantText(parsed);
    if (text) events.push({ ...base, type: 'assistant_text', text });
    for (const toolUse of extractToolUses(parsed)) {
      events.push({ ...base, type: 'tool_use', ...toolUse });
    }
    if (events.length) return events;
    return [{ ...base, type: 'assistant_event' }];
  }
  if (parsed.type === 'result' && parsed.subtype === 'success') {
    return [{ ...base, type: 'turn_completed' }];
  }
  if (parsed.type === 'result' && parsed.subtype === 'error') {
    return [
      {
        ...base,
        type: 'turn_failed',
        error: typeof parsed.error === 'string' ? parsed.error : 'Claude stream-json turn failed',
      },
    ];
  }
  if (parsed.type === 'system' && parsed.subtype === 'compact_boundary') {
    const meta =
      parsed.compact_metadata && typeof parsed.compact_metadata === 'object'
        ? parsed.compact_metadata
        : {};
    return [
      {
        ...base,
        type: 'compact_boundary',
        trigger: typeof meta.trigger === 'string' ? meta.trigger : 'auto',
        preTokens: typeof meta.pre_tokens === 'number' ? meta.pre_tokens : null,
      },
    ];
  }
  if (parsed.type === 'system' && parsed.subtype === 'api_retry') {
    return [
      {
        ...base,
        type: 'api_retry',
        attempt: typeof parsed.attempt === 'number' ? parsed.attempt : null,
        maxRetries: typeof parsed.max_retries === 'number' ? parsed.max_retries : null,
        errorStatus: typeof parsed.error_status === 'number' ? parsed.error_status : null,
        error: typeof parsed.error === 'string' ? parsed.error : null,
        errorMessage: typeof parsed.error_message === 'string' ? parsed.error_message : null,
        retryDelayMs: typeof parsed.retry_delay_ms === 'number' ? parsed.retry_delay_ms : null,
      },
    ];
  }
  if (parsed.type === 'control_request') {
    const approvalRequest = normalizeControlRequest(parsed, base);
    if (approvalRequest) return [approvalRequest];
  }
  return [{ ...base, type: 'runtime_event' }];
}

function extractAssistantText(parsed) {
  const content = parsed?.message?.content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((part) => part && typeof part === 'object' && part.type === 'text')
    .map((part) => (typeof part.text === 'string' ? part.text : ''))
    .filter(Boolean)
    .join('');
}

function extractToolUses(parsed) {
  const content = parsed?.message?.content;
  if (!Array.isArray(content)) return [];
  return content
    .filter((part) => part && typeof part === 'object' && part.type === 'tool_use')
    .map((part) => ({
      toolUseId: typeof part.id === 'string' ? part.id : null,
      toolName: typeof part.name === 'string' ? part.name : 'unknown',
      input: part.input && typeof part.input === 'object' ? { ...part.input } : {},
    }));
}

function normalizeControlRequest(parsed, base) {
  const request = parsed.request && typeof parsed.request === 'object' ? parsed.request : null;
  if (!request || request.subtype !== 'can_use_tool') return null;
  const approvalId = typeof parsed.request_id === 'string' && parsed.request_id.trim()
    ? parsed.request_id.trim()
    : null;
  if (!approvalId) return null;
  const toolName = typeof request.tool_name === 'string' && request.tool_name.trim()
    ? request.tool_name.trim()
    : 'Unknown';
  return {
    ...base,
    type: 'approval_request',
    approvalId,
    prompt: `Approve ${toolName}`,
    toolName,
    input: request.input && typeof request.input === 'object' ? { ...request.input } : {},
  };
}

function requireString(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function decisionToBehavior(decision) {
  if (decision === 'approved') return 'allow';
  if (decision === 'denied') return 'deny';
  throw new Error(`unsupported approval decision: ${decision}`);
}
