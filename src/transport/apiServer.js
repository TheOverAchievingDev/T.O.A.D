import http from 'node:http';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { Buffer } from 'node:buffer';
import { timingSafeEqual, createHash, randomUUID } from 'node:crypto';
import { TerminalSession } from './terminalSession.js';

export class ApiServer {
  #server;
  #eventBus;
  #port;
  #maxBodyBytes;
  #clients = new Set();
  #unsubscribeBus;
  #token;
  #tokenBuf;

  #toolFacade;

  #allowedOrigins;

  #staticDir;

  #terminalSessions = null;

  constructor({ eventBus, toolFacade, port = 0, maxBodyBytes = 1024 * 1024, token = null, allowedOrigins, staticDir = null }) {
    if (!eventBus) {
      throw new Error('eventBus is required');
    }
    this.#eventBus = eventBus;
    this.#toolFacade = toolFacade;
    this.#port = port;
    this.#maxBodyBytes = maxBodyBytes;
    this.#token = typeof token === 'string' && token.trim().length > 0 ? token : null;
    this.#tokenBuf = this.#token ? Buffer.from(this.#token) : null;
    this.#allowedOrigins = normalizeAllowedOrigins(allowedOrigins);
    this.#staticDir = typeof staticDir === 'string' && staticDir.trim().length > 0
      ? path.resolve(staticDir)
      : null;

    this.#server = http.createServer((req, res) => {
      this.#handleRequest(req, res);
    });

    // WebSocket upgrade listener — the HTTP server's 'upgrade' event fires
    // BEFORE the regular request handler, giving us raw-socket access needed
    // for WebSocket handshake (RFC 6455). The regular request handler only
    // sees the ServerResponse object, not the underlying TCP socket.
    this.#server.on('upgrade', (req, socket, head) => {
      if (req.url && req.url.split('?')[0] === '/terminal') {
        this.#handleTerminalUpgrade(req, socket);
        return;
      }
      socket.destroy();
    });
  }

  start() {
    return new Promise((resolve) => {
      this.#server.listen(this.#port, '127.0.0.1', () => {
        this.#unsubscribeBus = this.#eventBus.subscribe('runtime_event', (event) => {
          this.#broadcast(event);
        });
        resolve();
      });
    });
  }

  stop() {
    return new Promise((resolve) => {
      if (this.#unsubscribeBus) {
        this.#unsubscribeBus();
      }
      for (const res of this.#clients) {
        res.end();
      }
      this.#clients.clear();
      this.#server.close(() => resolve());
      // SSE responses keep their underlying TCP sockets in keep-alive,
      // which would prevent server.close() from resolving. Force them shut.
      this.#server.closeAllConnections();
    });
  }

  getPort() {
    return this.#server.address().port;
  }

  getClientCount() {
    return this.#clients.size;
  }

  #handleRequest(req, res) {
    // Handle CORS preflight
    if (req.method === 'OPTIONS') {
      this.#setCorsHeaders(req, res);
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.url && req.url.split('?')[0] === '/events' && req.method === 'GET') {
      this.#handleEventsRequest(req, res);
      return;
    }

    if (req.url === '/api/call' && req.method === 'POST') {
      this.#handleApiCallRequest(req, res);
      return;
    }

    if (this.#staticDir && req.method === 'GET') {
      this.#handleStaticRequest(req, res).catch(() => {
        res.writeHead(500);
        res.end('Internal Server Error');
      });
      return;
    }

    res.writeHead(404);
    res.end('Not Found');
  }

  async #handleStaticRequest(req, res) {
    const urlPath = (req.url || '/').split('?')[0];
    const safe = sanitizeStaticPath(urlPath);
    if (safe == null) {
      res.writeHead(400);
      res.end('Bad Request');
      return;
    }

    const candidate = path.join(this.#staticDir, safe);
    if (!candidate.startsWith(this.#staticDir)) {
      res.writeHead(400);
      res.end('Bad Request');
      return;
    }

    try {
      const stat = await fs.stat(candidate);
      if (stat.isDirectory()) {
        return this.#sendStaticFile(res, path.join(candidate, 'index.html'));
      }
      return this.#sendStaticFile(res, candidate);
    } catch {
      // SPA fallback — serve index.html for unmatched paths
      try {
        await this.#sendStaticFile(res, path.join(this.#staticDir, 'index.html'));
      } catch {
        res.writeHead(404);
        res.end('Not Found');
      }
    }
  }

  async #sendStaticFile(res, filePath) {
    const data = await fs.readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': STATIC_MIME[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600',
    });
    res.end(data);
  }

  #setCorsHeaders(req, res) {
    const allowedOrigin = this.#resolveAllowedOrigin(req?.headers?.origin);
    if (allowedOrigin) {
      res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
      res.setHeader('Vary', 'Origin');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  }

  #resolveAllowedOrigin(origin) {
    if (typeof origin !== 'string' || origin.length === 0) return null;
    if (this.#allowedOrigins === '*') return origin;
    if (Array.isArray(this.#allowedOrigins) && this.#allowedOrigins.includes(origin)) return origin;
    return null;
  }

  #authenticate(req) {
    if (!this.#token) return true;
    const header = req.headers['authorization'];
    if (typeof header !== 'string') return false;
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    if (!match) return false;
    return safeStringEquals(match[1].trim(), this.#tokenBuf);
  }

  #authenticateEvents(req) {
    if (!this.#token) return true;
    if (this.#authenticate(req)) return true;
    const queryToken = parseQueryToken(req.url);
    return queryToken !== null && safeStringEquals(queryToken, this.#tokenBuf);
  }

  #handleEventsRequest(req, res) {
    this.#setCorsHeaders(req, res);

    if (!this.#authenticateEvents(req)) {
      writeJson(res, 401, { error: 'Unauthorized' });
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });

    // Send initial connection comment
    res.write(': connected\n\n');

    this.#clients.add(res);

    req.on('close', () => {
      this.#clients.delete(res);
    });
  }

  #handleApiCallRequest(req, res) {
    this.#setCorsHeaders(req, res);

    if (!this.#authenticate(req)) {
      writeJson(res, 401, { error: 'Unauthorized' });
      return;
    }

    if (!this.#toolFacade) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Tool facade is not configured' }));
      return;
    }

    let body = '';
    let receivedBytes = 0;
    let bodyTooLarge = false;
    req.on('data', (chunk) => {
      receivedBytes += chunk.length;
      if (receivedBytes > this.#maxBodyBytes) {
        bodyTooLarge = true;
        return;
      }
      body += chunk.toString();
    });

    req.on('end', async () => {
      if (bodyTooLarge) {
        writeJson(res, 413, { error: 'Request body too large' });
        return;
      }
      let payload;
      try {
        payload = JSON.parse(body);
      } catch {
        writeJson(res, 400, { error: 'Invalid JSON body' });
        return;
      }

      try {
        const validationError = validateApiCallPayload(payload);
        if (validationError) {
          writeJson(res, 400, { error: validationError });
          return;
        }

        const { actor, method, args } = payload;
        
        const command = {
          commandName: method,
          actor,
          args: args || {},
          idempotencyKey: payload.idempotencyKey
        };
        const result = await this.#toolFacade.execute(command);

        writeJson(res, 200, { result });
      } catch (error) {
        // Log the full error to stderr so the sidecar terminal shows a stack
        // trace — the JSON response only carries error.message which strips
        // stack/cause and makes debugging brutally opaque (see F.2 smoke).
        // eslint-disable-next-line no-console
        console.error('[api] /api/call command failed:', error);
        writeJson(res, 500, { error: error.message });
      }
    });
  }

  #broadcast(event) {
    const data = `event: runtime_event\ndata: ${JSON.stringify(event)}\n\n`;
    for (const res of this.#clients) {
      try { res.write(data); } catch { /* client disconnected */ }
    }
  }

  /**
   * Phase 3: WebSocket upgrade handler for the embedded terminal.
   * Each connection spawns a new TerminalSession (node-pty shell process).
   * Browser xterm.js ↔ WebSocket ↔ TerminalSession ↔ node-pty ↔ OS shell.
   */
  #handleTerminalUpgrade(req, socket) {
    // Authenticate via ?token= query param (same pattern as SSE /events).
    const token = parseQueryToken(req.url);
    if (this.#token && (!token || !safeStringEquals(token, this.#tokenBuf))) {
      // Send a 401 over the raw socket before destroying.
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    const key = req.headers['sec-websocket-key'];
    if (!key || typeof key !== 'string') {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      socket.destroy();
      return;
    }

    // WebSocket handshake per RFC 6455 §4.2.2.
    const accept = createHash('sha1')
      .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
      .digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );

    // Minimal WebSocket frame abstraction on top of the raw TCP socket.
    const sessionId = randomUUID();
    const cwd = this.#toolFacade?.projectCwd || process.cwd();
    const ws = createWebSocketBridge(socket);
    if (!this.#terminalSessions) this.#terminalSessions = new Map();
    const session = new TerminalSession({
      id: sessionId,
      cwd,
      ws,
      onExit: () => this.#terminalSessions?.delete(sessionId),
    });
    this.#terminalSessions.set(sessionId, session);
  }
}

function validateApiCallPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return 'payload must be an object';
  }
  if (!payload.actor || typeof payload.actor !== 'object' || Array.isArray(payload.actor)) {
    return 'actor must be an object';
  }
  if (!isNonEmptyString(payload.actor.teamId)) {
    return 'actor.teamId must be a non-empty string';
  }
  if (!isNonEmptyString(payload.actor.agentId)) {
    return 'actor.agentId must be a non-empty string';
  }
  if (!isNonEmptyString(payload.method)) {
    return 'method must be a non-empty string';
  }
  if (payload.args != null && (typeof payload.args !== 'object' || Array.isArray(payload.args))) {
    return 'args must be an object when provided';
  }
  if (payload.idempotencyKey != null && typeof payload.idempotencyKey !== 'string') {
    return 'idempotencyKey must be a string when provided';
  }
  return null;
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function writeJson(res, statusCode, body) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function safeStringEquals(candidate, expectedBuf) {
  const candidateBuf = Buffer.from(candidate);
  if (candidateBuf.length !== expectedBuf.length) return false;
  return timingSafeEqual(candidateBuf, expectedBuf);
}

function normalizeAllowedOrigins(value) {
  if (value === '*') return '*';
  if (Array.isArray(value)) {
    const cleaned = value
      .filter((entry) => typeof entry === 'string' && entry.trim().length > 0)
      .map((entry) => entry.trim());
    if (cleaned.length === 0) return [...DEFAULT_ALLOWED_ORIGINS];
    return cleaned;
  }
  return [...DEFAULT_ALLOWED_ORIGINS];
}

const DEFAULT_ALLOWED_ORIGINS = Object.freeze([
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://tauri.localhost',
]);

const STATIC_MIME = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
});

function sanitizeStaticPath(urlPath) {
  if (typeof urlPath !== 'string') return null;
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;
  if (!decoded.startsWith('/')) return null;
  // Reject any segment that is exactly '..' (path traversal attempt)
  const segments = decoded.split('/').filter((s) => s !== '');
  if (segments.some((s) => s === '..')) return null;
  const joined = segments.join('/');
  if (joined === '') return 'index.html';
  return joined;
}

function parseQueryToken(url) {
  if (typeof url !== 'string') return null;
  const queryStart = url.indexOf('?');
  if (queryStart < 0) return null;
  const params = new URLSearchParams(url.slice(queryStart + 1));
  const token = params.get('token');
  return token && token.length > 0 ? token : null;
}

/**
 * Minimal WebSocket frame encoder/decoder on top of a raw TCP socket.
 * Provides a send(message) and on('message', cb) interface matching
 * the subset of the `ws` package API that TerminalSession needs.
 *
 * RFC 6455 §5.2 base framing only — no extensions, no fragmentation
 * reassembly beyond concatenation. Sufficient for terminal I/O.
 */
function createWebSocketBridge(socket) {
  let buffer = Buffer.alloc(0);
  const listeners = { message: [], close: [] };

  function emit(ev, data) {
    for (const fn of listeners[ev] || []) {
      try { fn(data); } catch { /* swallow */ }
    }
  }

  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 2) {
      const b1 = buffer[0];
      const b2 = buffer[1];
      const opcode = b1 & 0x0f;
      const masked = (b2 & 0x80) !== 0;
      let payloadLen = b2 & 0x7f;
      let offset = 2;

      if (payloadLen === 126 && buffer.length >= 4) {
        payloadLen = buffer.readUInt16BE(2);
        offset = 4;
      } else if (payloadLen === 127 && buffer.length >= 10) {
        // 64-bit length (not expected for terminal frames).
        payloadLen = Number(buffer.readBigUInt64BE(2));
        offset = 10;
      }
      const maskLen = masked ? 4 : 0;
      const frameLen = offset + maskLen + payloadLen;
      if (buffer.length < frameLen) break;

      let payload;
      if (masked) {
        const mask = buffer.slice(offset, offset + 4);
        payload = Buffer.allocUnsafe(payloadLen);
        for (let i = 0; i < payloadLen; i += 1) {
          payload[i] = buffer[offset + 4 + i] ^ mask[i % 4];
        }
      } else {
        payload = buffer.slice(offset, offset + payloadLen);
      }
      buffer = buffer.slice(frameLen);

      if (opcode === 0x8) {
        // Close frame — acknowledge and destroy.
        try { socket.write(Buffer.from([0x88, 0x00])); } catch { /* ignore */ }
        try { socket.destroy(); } catch { /* ignore */ }
        emit('close');
        return;
      }
      if (opcode === 0x9) {
        // Ping → Pong.
        try { socket.write(Buffer.from([0x8a, payloadLen & 0x7f])); } catch { /* ignore */ }
        continue;
      }
      if (opcode === 0x1 || opcode === 0x2) {
        emit('message', payload);
      }
    }
  });

  socket.on('close', () => emit('close'));
  socket.on('error', () => {
    try { socket.destroy(); } catch { /* ignore */ }
    emit('close');
  });

  return {
    on(ev, fn) {
      if (listeners[ev]) listeners[ev].push(fn);
    },
    send(data) {
      const payload = typeof data === 'string' ? Buffer.from(data, 'utf-8') : Buffer.from(data);
      const len = payload.length;
      let header;
      if (len < 126) {
        header = Buffer.from([0x81, len]);
      } else if (len < 65536) {
        header = Buffer.alloc(4);
        header[0] = 0x81;
        header[1] = 126;
        header.writeUInt16BE(len, 2);
      } else {
        header = Buffer.alloc(10);
        header[0] = 0x81;
        header[1] = 127;
        header.writeBigUInt64BE(BigInt(len), 2);
      }
      try { socket.write(Buffer.concat([header, payload])); } catch { /* ignore */ }
    },
    get readyState() {
      return socket.writable ? 1 : 0;
    },
    close() {
      try { socket.write(Buffer.from([0x88, 0x00])); } catch { /* ignore */ }
      try { socket.destroy(); } catch { /* ignore */ }
    },
  };
}
