#!/usr/bin/env node

import { setTimeout as sleep } from 'node:timers/promises';
import {
  buildStreamJsonFrames,
  loadScenario,
  parseCliArgs,
} from './demoVideoTools.mjs';

async function main() {
  const args = parseCliArgs(process.argv.slice(2));
  const scenarioPath = typeof args.scenario === 'string' ? args.scenario : null;
  const agentId = typeof args.agent === 'string' ? args.agent : null;
  const speed = parseSpeed(args.speed);
  const once = args.once === true;

  if (!scenarioPath || !agentId) {
    console.error('Usage: node scripts/demo-agent-runtime.mjs --scenario <file> --agent <agentId> [--speed 1] [--once]');
    process.exit(2);
  }

  const scenario = await loadScenario(scenarioPath);
  const member = scenario.team.members.find((item) => item.agentId === agentId);
  if (!member) {
    throw new Error(`No demo agent "${agentId}" in ${scenarioPath}`);
  }

  const events = Array.isArray(scenario.runtimeScripts?.[agentId])
    ? scenario.runtimeScripts[agentId]
    : [{ type: 'text', text: `${agentId} is online and waiting for work.` }];

  const frames = buildStreamJsonFrames({
    agentId,
    model: process.env.SYMPHONY_DEMO_MODEL || member.model || member.providerId,
    events,
  });

  for (let index = 0; index < frames.length; index += 1) {
    const frame = frames[index];
    const sourceEvent = events[Math.min(index, events.length - 1)];
    const delayMs = Number.isFinite(sourceEvent?.delayMs) ? sourceEvent.delayMs : 750;
    if (speed > 0) await sleep(Math.max(0, Math.round(delayMs * speed)));
    process.stdout.write(`${frame}\n`);
  }

  if (once) return;

  const heartbeat = setInterval(() => {
    process.stdout.write(JSON.stringify({
      type: 'assistant',
      session_id: `demo-${agentId}-heartbeat`,
      message: {
        role: 'assistant',
        model: process.env.SYMPHONY_DEMO_MODEL || member.model || member.providerId,
        content: [{ type: 'text', text: `${agentId} is monitoring the board.` }],
      },
    }) + '\n');
  }, 30_000);

  process.on('SIGTERM', () => {
    clearInterval(heartbeat);
    process.exit(0);
  });
  process.on('SIGINT', () => {
    clearInterval(heartbeat);
    process.exit(0);
  });

  await new Promise(() => {});
}

function parseSpeed(value) {
  if (value === true || value == null) return 1;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 1;
}

main().catch((err) => {
  console.error(err?.stack || err?.message || String(err));
  process.exit(1);
});
