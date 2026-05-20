import { LocalToadRuntime } from '../app/LocalToadRuntime.js';
import { callLocalMcpTool, listLocalMcpTools } from './localToolDefinitions.js';

const SERVER_INFO = Object.freeze({
  name: 'toad-local',
  version: '0.1.0',
});

export function createLocalMcpHandler({
  runtime = new LocalToadRuntime(),
  actor = { teamId: 'local', agentId: 'operator' },
} = {}) {
  return (request) => handleLocalMcpRequest(request, { runtime, actor });
}

export async function handleLocalMcpRequest(request, { runtime, actor }) {
  const id = request && Object.hasOwn(request, 'id') ? request.id : null;
  try {
    if (!request || typeof request !== 'object') {
      return errorResponse(id, -32600, 'invalid request');
    }

    switch (request.method) {
      case 'initialize':
        return successResponse(id, {
          protocolVersion: '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
        });
      case 'tools/list':
        return successResponse(id, { tools: listLocalMcpTools() });
      case 'tools/call':
        return successResponse(
          id,
          await callLocalMcpTool({
            toolFacade: runtime.toolFacade,
            actor,
            name: request.params?.name,
            arguments: request.params?.arguments || {},
          })
        );
      default:
        return errorResponse(id, -32601, `method not found: ${request.method}`);
    }
  } catch (error) {
    return errorResponse(id, -32603, error instanceof Error ? error.message : String(error));
  }
}

function successResponse(id, result) {
  return {
    jsonrpc: '2.0',
    id,
    result,
  };
}

function errorResponse(id, code, message) {
  return {
    jsonrpc: '2.0',
    id,
    error: {
      code,
      message,
    },
  };
}
