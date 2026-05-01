const DEFAULT_TOAD_API_BASE_URL = 'http://127.0.0.1:3001';

function normalizeBaseUrl(value) {
  const raw = typeof value === 'string' && value.trim()
    ? value.trim()
    : DEFAULT_TOAD_API_BASE_URL;
  return raw.replace(/\/+$/, '');
}

function normalizeToken(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

export const TOAD_API_BASE_URL = normalizeBaseUrl(import.meta.env.VITE_TOAD_API_BASE_URL);
export const TOAD_API_TOKEN = normalizeToken(import.meta.env.VITE_TOAD_API_TOKEN);
export const TOAD_API_CALL_URL = `${TOAD_API_BASE_URL}/api/call`;
export const TOAD_EVENTS_URL = `${TOAD_API_BASE_URL}/events`;

export function toadApiHeaders() {
  const headers = { 'Content-Type': 'application/json' };
  if (TOAD_API_TOKEN) {
    headers.Authorization = `Bearer ${TOAD_API_TOKEN}`;
  }
  return headers;
}

export function toadEventsUrl() {
  if (!TOAD_API_TOKEN) return TOAD_EVENTS_URL;
  return `${TOAD_EVENTS_URL}?token=${encodeURIComponent(TOAD_API_TOKEN)}`;
}
