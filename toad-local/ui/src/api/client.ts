import { TOAD_API_CALL_URL, toadApiHeaders } from '@/config/api';

export interface Actor {
  teamId: string;
  agentId: string;
  agentName?: string;
  role?: string;
}

export interface ApiCallOptions {
  actor: Actor;
  method: string;
  args?: Record<string, unknown>;
  idempotencyKey?: string;
  signal?: AbortSignal;
}

export interface ApiCallEnvelope<T> {
  result?: T;
  error?: string;
}

export class ToadApiError extends Error {
  status: number;
  payload: unknown;
  constructor(message: string, status: number, payload: unknown) {
    super(message);
    this.name = 'ToadApiError';
    this.status = status;
    this.payload = payload;
  }
}

export async function callTool<T = unknown>({
  actor, method, args, idempotencyKey, signal,
}: ApiCallOptions): Promise<T> {
  const body: Record<string, unknown> = { actor, method };
  if (args !== undefined) body.args = args;
  if (idempotencyKey !== undefined) body.idempotencyKey = idempotencyKey;

  const response = await fetch(TOAD_API_CALL_URL, {
    method: 'POST',
    headers: toadApiHeaders(),
    body: JSON.stringify(body),
    signal,
  });

  let envelope: ApiCallEnvelope<T> | null = null;
  try {
    envelope = (await response.json()) as ApiCallEnvelope<T>;
  } catch {
    envelope = null;
  }

  if (!response.ok) {
    const message = envelope?.error ?? response.statusText ?? 'Request failed';
    throw new ToadApiError(message, response.status, envelope);
  }

  if (!envelope || envelope.result === undefined) {
    throw new ToadApiError('Empty response envelope', response.status, envelope);
  }

  return envelope.result;
}
