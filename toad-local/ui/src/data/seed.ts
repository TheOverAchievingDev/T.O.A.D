import type { Team, Message, UiTask, Provider, Runtime } from '@/types';

export const SEED_TEAM: Team = {
  name: 'signal-ops',
  description: 'Signal ops team — voice transcription pipeline',
  status: 'running',
  uptime: '00:14:32',
  project: 'ide-test',
  branch: 'feature/transcribe-v2',
  members: [
    { id: 'lead', name: 'lead', role: 'lead', avatar: 'L', status: 'thinking',
      task: 'Coordinating voice pipeline refactor — delegating chunks to dev + research',
      tokens: 14820, tokenLimit: 200000, provider: 'anthropic', model: 'Opus 4.6', tasksDone: 3 },
    { id: 'alice', name: 'alice', role: 'reviewer', avatar: 'A', status: 'live',
      task: 'Reviewing PR #42 — audio chunking edge cases',
      tokens: 8204, tokenLimit: 200000, provider: 'anthropic', model: 'Sonnet 4.6', tasksDone: 7 },
    { id: 'tom', name: 'tom', role: 'developer', avatar: 'T', status: 'live',
      task: 'Implementing streaming transcription buffer in src/audio/stream.ts',
      tokens: 22416, tokenLimit: 200000, provider: 'anthropic', model: 'Sonnet 4.6', tasksDone: 12 },
    { id: 'rex', name: 'rex', role: 'researcher', avatar: 'R', status: 'live',
      task: 'Comparing Whisper vs Deepgram latency for 16kHz streaming',
      tokens: 5100, tokenLimit: 200000, provider: 'openai', model: '5.4', tasksDone: 4 },
    { id: 'dee', name: 'dee', role: 'debugger', avatar: 'D', status: 'idle',
      task: null,
      tokens: 1840, tokenLimit: 200000, provider: 'anthropic', model: 'Haiku 4.5', tasksDone: 2 },
    { id: 'quinn', name: 'quinn', role: 'qa', avatar: 'Q', status: 'live',
      task: 'Writing integration tests for chunk-replay scenarios',
      tokens: 3200, tokenLimit: 200000, provider: 'opencode', model: 'GLM-4.6', tasksDone: 5 },
  ],
};

export const SEED_MESSAGES: Message[] = [
  { id: 1, from: 'lead', to: 'tom', time: '14:02', body: 'Tom — pull the chunking logic into src/audio/stream.ts and expose a `streamTranscribe()` async iterator. Keep buffer size tweakable via the existing config.' },
  { id: 2, from: 'tom', to: 'lead', time: '14:03', body: "On it. I'll preserve the current 4096-frame default and let it be overridden via `AUDIO_CHUNK_FRAMES`." },
  { id: 3, from: 'lead', to: 'rex', time: '14:04', body: 'Research: Whisper vs Deepgram for 16kHz streaming. Need p50/p95 latency numbers and cost-per-hour. Report back inline.' },
  { id: 4, from: 'rex', to: 'lead', time: '14:11', body: 'First pass — Deepgram nova-2 streams at ~340ms p50, Whisper-large-v3 ~620ms p50 on a single A100. Cost roughly comparable per hour. Pulling p95 next.' },
  { id: 5, from: 'lead', to: 'alice', time: '14:18', body: 'Alice — when tom finishes, please review the chunking PR. Specifically watch for the dual-reversal guard around stream pause/resume.' },
  { id: 6, from: 'tom', to: 'lead', time: '14:31', isToolCall: true, body: 'tool/edit · src/audio/stream.ts (+128 −41) · streamTranscribe added' },
  { id: 7, from: 'alice', to: 'tom', time: '14:33', body: 'Looks clean. Caught one thing — the buffer flush on pause needs to emit the partial frame, otherwise we drop the last <16ms of audio. Otherwise approved pending QA.' },
  { id: 8, from: 'quinn', to: 'lead', time: '14:35', body: 'Adding a chunk-replay test case for the pause-emit behavior alice flagged. Will run the full suite after.' },
];

export const SEED_TASKS: UiTask[] = [
  { id: 'T-481', title: 'Streaming buffer for transcription', status: 'in-progress', assignee: 'tom', project: 'ide-test' },
  { id: 'T-480', title: 'Bench Whisper vs Deepgram (16kHz)', status: 'in-progress', assignee: 'rex', project: 'ide-test' },
  { id: 'T-479', title: 'Review PR #42 — chunking edge cases', status: 'in-progress', assignee: 'alice', project: 'ide-test' },
  { id: 'T-478', title: 'Replay tests for pause/resume', status: 'todo', assignee: 'quinn', project: 'ide-test' },
  { id: 'T-477', title: 'Document AUDIO_CHUNK_FRAMES env', status: 'todo', assignee: 'tom', project: 'ide-test' },
  { id: 'T-476', title: 'Verify dual-reversal guard', status: 'review', assignee: 'alice', project: 'ide-test' },
  {
    id: 'T-475', title: 'Migrate config to zod schema', status: 'review', assignee: 'tom', project: 'ide-test',
    riskLevel: 'critical', requiresHumanApproval: true, humanApproved: false,
    matchedRules: [
      { pattern: '.env*', riskLevel: 'critical', requiresHumanApproval: true, appliesTo: 'files', reason: 'Touches secrets file pattern .env*' },
      { pattern: 'package.json', riskLevel: 'high', appliesTo: 'files', reason: 'Modifies dependency manifest' },
    ],
  },
  {
    id: 'T-474', title: 'Hello-world spike for OpenCode', status: 'done', assignee: 'quinn', project: 'ide-test',
    riskLevel: 'low',
  },
  { id: 'T-473', title: 'Build Snake game (HTML/CSS/JS)', status: 'done', assignee: 'tom', project: 'ide-test' },
];

export const SEED_PROVIDERS: Provider[] = [
  { id: 'anthropic', label: 'Anthropic', models: ['Default', 'Opus 4.6', 'Sonnet 4.6', 'Haiku 4.5'] },
  { id: 'openai', label: 'OpenAI Codex', models: ['Default', '5.4', '5.4-mini', '5.3-codex'] },
  { id: 'opencode', label: 'OpenCode', models: ['Default', 'GLM-4.6', 'Qwen3-Coder', 'Local'] },
];

export const SEED_RUNTIMES: Runtime[] = [
  { id: 'rt-1', provider: 'anthropic', model: 'Opus 4.6', agent: 'lead', pid: 32828, status: 'live', cpu: 4, mem: 412, uptime: '00:14:32', reqs: 142, tokensIn: 9820, tokensOut: 5000 },
  { id: 'rt-2', provider: 'anthropic', model: 'Sonnet 4.6', agent: 'alice', pid: 32841, status: 'live', cpu: 12, mem: 388, uptime: '00:14:18', reqs: 98, tokensIn: 5102, tokensOut: 3102 },
  { id: 'rt-3', provider: 'anthropic', model: 'Sonnet 4.6', agent: 'tom', pid: 32855, status: 'live', cpu: 22, mem: 502, uptime: '00:14:05', reqs: 211, tokensIn: 14820, tokensOut: 7596 },
  { id: 'rt-4', provider: 'openai', model: '5.4', agent: 'rex', pid: 32868, status: 'live', cpu: 7, mem: 296, uptime: '00:13:54', reqs: 44, tokensIn: 3200, tokensOut: 1900 },
  { id: 'rt-5', provider: 'anthropic', model: 'Haiku 4.5', agent: 'dee', pid: 32874, status: 'idle', cpu: 1, mem: 218, uptime: '00:13:42', reqs: 8, tokensIn: 1100, tokensOut: 740 },
  { id: 'rt-6', provider: 'opencode', model: 'GLM-4.6', agent: 'quinn', pid: 32881, status: 'live', cpu: 9, mem: 354, uptime: '00:13:22', reqs: 62, tokensIn: 2200, tokensOut: 1000 },
];
