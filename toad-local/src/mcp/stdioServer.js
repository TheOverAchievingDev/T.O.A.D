#!/usr/bin/env node
import { createLocalMcpHandler } from './localMcpServer.js';
import { createMcpActorFromEnv, createMcpRuntimeFromEnv } from './stdioRuntime.js';

const runtime = createMcpRuntimeFromEnv(process.env);
const handler = createLocalMcpHandler({
  runtime,
  actor: createMcpActorFromEnv(process.env),
});

let buffer = '';

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  const lines = buffer.split(/\r?\n/);
  buffer = lines.pop() ?? '';
  for (const line of lines) {
    void handleLine(line);
  }
});

process.stdin.on('end', () => {
  if (buffer.trim()) {
    void handleLine(buffer);
  }
});

async function handleLine(line) {
  if (!line.trim()) return;
  let request;
  try {
    request = JSON.parse(line);
  } catch (error) {
    writeResponse({
      jsonrpc: '2.0',
      id: null,
      error: {
        code: -32700,
        message: error instanceof Error ? error.message : String(error),
      },
    });
    return;
  }

  writeResponse(await handler(request));
}

function writeResponse(response) {
  process.stdout.write(`${JSON.stringify(response)}\n`);
}
