import { useState, useEffect, useCallback } from 'react';
import { toadEventsUrl } from '../config/toadApi';

export function useToadEvents() {
  const [connected, setConnected] = useState(false);
  const [events, setEvents] = useState([]);
  const [lastEvent, setLastEvent] = useState(null);

  useEffect(() => {
    let eventSource;
    let reconnectTimeout;

    const connect = () => {
      console.log('Connecting to TOAD SSE...');
      eventSource = new EventSource(toadEventsUrl());

      eventSource.onopen = () => {
        console.log('Connected to TOAD SSE.');
        setConnected(true);
      };

      eventSource.addEventListener('runtime_event', (e) => {
        try {
          const payload = JSON.parse(e.data);
          console.log('Received runtime_event:', payload);
          setLastEvent(payload);
          setEvents((prev) => [payload, ...prev].slice(0, 100)); // keep last 100
        } catch (err) {
          console.error('Failed to parse SSE event', err);
        }
      });

      eventSource.onerror = (err) => {
        console.error('SSE connection error, retrying...', err);
        setConnected(false);
        eventSource.close();
        reconnectTimeout = setTimeout(connect, 2000);
      };
    };

    connect();

    return () => {
      if (eventSource) eventSource.close();
      if (reconnectTimeout) clearTimeout(reconnectTimeout);
    };
  }, []);

  const clearEvents = useCallback(() => {
    setEvents([]);
  }, []);

  return { connected, events, lastEvent, clearEvents };
}
