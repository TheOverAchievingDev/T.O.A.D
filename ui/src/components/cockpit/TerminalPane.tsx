import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { TOAD_API_BASE_URL, TOAD_API_TOKEN } from '../../config/api';

/**
 * Phase 3 embedded terminal (Cursor-style). Renders an xterm.js instance
 * connected to the Node sidecar via WebSocket. The sidecar bridges WS ↔
 * node-pty ↔ OS shell.
 *
 * Each TerminalPane instance opens its own WebSocket → new shell session.
 * Resize events are forwarded to the PTY so line-wrapping works correctly.
 */
export function TerminalPane() {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const fitRef = useRef<FitAddon | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: 'Consolas, "Courier New", monospace',
      theme: {
        background: '#1e1e1e',
        foreground: '#d4d4d4',
        cursor: '#d4d4d4',
        selectionBackground: '#264f78',
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(containerRef.current);
    fit.fit();

    termRef.current = term;
    fitRef.current = fit;

    // Build WebSocket URL with optional auth token.
    const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsHost = TOAD_API_BASE_URL.replace(/^https?:\/\//, '');
    const tokenParam = TOAD_API_TOKEN ? `?token=${encodeURIComponent(TOAD_API_TOKEN)}` : '';
    const wsUrl = `${wsProtocol}//${wsHost}/terminal${tokenParam}`;

    let ws: WebSocket;
    try {
      ws = new WebSocket(wsUrl);
    } catch {
      term.writeln('Failed to connect to terminal server.');
      return;
    }
    wsRef.current = ws;
    ws.binaryType = 'arraybuffer';

    ws.onopen = () => {
      term.writeln('Terminal connected.');
    };

    ws.onmessage = (event) => {
      if (typeof event.data === 'string') {
        term.write(event.data);
      } else if (event.data instanceof ArrayBuffer) {
        term.write(new Uint8Array(event.data));
      }
    };

    ws.onerror = () => {
      term.writeln('\r\n\x1b[31mTerminal connection error.\x1b[0m');
    };

    ws.onclose = () => {
      term.writeln('\r\n\x1b[33mTerminal disconnected.\x1b[0m');
    };

    // Forward typed input to the PTY.
    term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(data);
      }
    });

    // Forward resize events so the PTY matches the visible terminal size.
    const onResize = () => {
      if (fitRef.current) {
        try { fitRef.current.fit(); } catch { /* ignore */ }
      }
      if (termRef.current && wsRef.current?.readyState === WebSocket.OPEN) {
        const dims = { cols: termRef.current.cols, rows: termRef.current.rows };
        wsRef.current.send(JSON.stringify(dims));
      }
    };
    const observer = new ResizeObserver(onResize);
    observer.observe(containerRef.current);
    onResize();

    return () => {
      observer.disconnect();
      term.dispose();
      try { ws.close(); } catch { /* ignore */ }
    };
  }, []);

  return (
    <div
      ref={containerRef}
      style={{
        width: '100%',
        height: '100%',
        overflow: 'hidden',
      }}
    />
  );
}
