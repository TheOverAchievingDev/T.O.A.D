/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_TOAD_API_BASE_URL?: string;
  readonly VITE_TOAD_API_TOKEN?: string;
}

const env = (import.meta as unknown as { env: ImportMetaEnv }).env ?? {};

export const TOAD_API_BASE_URL = env.VITE_TOAD_API_BASE_URL ?? 'http://127.0.0.1:3001';
export const TOAD_API_TOKEN = env.VITE_TOAD_API_TOKEN ?? '';

export const TOAD_API_CALL_URL = `${TOAD_API_BASE_URL}/api/call`;
export const TOAD_EVENTS_URL = `${TOAD_API_BASE_URL}/events`;

export function toadApiHeaders(): Record<string, string> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (TOAD_API_TOKEN) headers['authorization'] = `Bearer ${TOAD_API_TOKEN}`;
  return headers;
}

export function toadEventsUrl(): string {
  if (!TOAD_API_TOKEN) return TOAD_EVENTS_URL;
  const url = new URL(TOAD_EVENTS_URL);
  url.searchParams.set('token', TOAD_API_TOKEN);
  return url.toString();
}
