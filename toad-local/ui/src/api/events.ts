import { useEffect, useRef, useState } from 'react';
import { toadEventsUrl } from '@/config/api';

export interface RuntimeEvent {
  type: string;
  teamId?: string;
  runtimeId?: string;
  agentId?: string;
  payload?: unknown;
  createdAt?: string;
  [key: string]: unknown;
}

export interface UseToadEventsOptions {
  onEvent?: (event: RuntimeEvent) => void;
  enabled?: boolean;
  maxBuffer?: number;
}

export function useToadEvents({ onEvent, enabled = true, maxBuffer = 100 }: UseToadEventsOptions = {}) {
  const [events, setEvents] = useState<RuntimeEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const sourceRef = useRef<EventSource | null>(null);
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;

    function connect() {
      if (cancelled) return;
      const es = new EventSource(toadEventsUrl());
      sourceRef.current = es;

      es.addEventListener('open', () => {
        attempt = 0;
        setConnected(true);
      });

      es.addEventListener('runtime_event', (msg: MessageEvent) => {
        let parsed: RuntimeEvent | null = null;
        try {
          parsed = JSON.parse(msg.data) as RuntimeEvent;
        } catch {
          parsed = null;
        }
        if (!parsed) return;
        onEventRef.current?.(parsed);
        setEvents((prev) => {
          const next = [...prev, parsed!];
          if (next.length > maxBuffer) next.splice(0, next.length - maxBuffer);
          return next;
        });
      });

      es.addEventListener('error', () => {
        setConnected(false);
        if (cancelled) return;
        es.close();
        attempt += 1;
        const delay = Math.min(15000, 500 * 2 ** attempt);
        retryTimer = setTimeout(connect, delay);
      });
    }

    connect();

    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
      sourceRef.current?.close();
      sourceRef.current = null;
      setConnected(false);
    };
  }, [enabled, maxBuffer]);

  return { events, connected };
}
