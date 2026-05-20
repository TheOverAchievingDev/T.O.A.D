// ── Cross-Team Message Protocol ──────────────────────────────────────────────
// Single source of truth for the cross-team message prefix format.
// Ported from the legacy crossTeam.ts shared constants.

const CROSS_TEAM_TAG_NAME = 'cross-team';
const CROSS_TEAM_ATTR_FROM = 'from';
const CROSS_TEAM_ATTR_DEPTH = 'depth';
const CROSS_TEAM_ATTR_CONVERSATION_ID = 'conversationId';
const CROSS_TEAM_ATTR_REPLY_TO_CONVERSATION_ID = 'replyToConversationId';

/** Incoming cross-team message (written to target team's inbox). */
export const CROSS_TEAM_SOURCE = 'cross_team';

/** Outgoing cross-team message copy (written to sender team's inbox). */
export const CROSS_TEAM_SENT_SOURCE = 'cross_team_sent';

// ── Escaping ─────────────────────────────────────────────────────────────────

function escapeAttr(value) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function unescapeAttr(value) {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

// ── Attribute parsing ────────────────────────────────────────────────────────

function parseAttributes(raw) {
  const attrs = new Map();
  const re = /([A-Za-z][A-Za-z0-9]*)="([^"]*)"/g;
  let match;
  while ((match = re.exec(raw)) !== null) {
    const key = match[1]?.trim();
    const value = match[2];
    if (!key || value == null) continue;
    attrs.set(key, unescapeAttr(value));
  }
  return attrs;
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Build the full prefix line:
 * `<cross-team from="team.member" depth="0" conversationId="abc" replyToConversationId="def" />`
 */
export function formatCrossTeamPrefix(from, chainDepth, meta = {}) {
  const attrs = [
    `${CROSS_TEAM_ATTR_FROM}="${escapeAttr(from)}"`,
    `${CROSS_TEAM_ATTR_DEPTH}="${String(chainDepth)}"`,
  ];
  if (meta.conversationId) {
    attrs.push(`${CROSS_TEAM_ATTR_CONVERSATION_ID}="${escapeAttr(meta.conversationId)}"`);
  }
  if (meta.replyToConversationId) {
    attrs.push(`${CROSS_TEAM_ATTR_REPLY_TO_CONVERSATION_ID}="${escapeAttr(meta.replyToConversationId)}"`);
  }
  return `<${CROSS_TEAM_TAG_NAME} ${attrs.join(' ')} />`;
}

/** Format the full message text with prefix + body. */
export function formatCrossTeamText(from, chainDepth, text, meta = {}) {
  return `${formatCrossTeamPrefix(from, chainDepth, meta)}\n${text}`;
}

/**
 * Regex that matches the canonical cross-team metadata tag at the start of a message.
 */
const CROSS_TEAM_PREFIX_RE = new RegExp(
  `^<${CROSS_TEAM_TAG_NAME}\\s+(?<attrs>[^>]*?)\\s*/>\\n?`
);

/** Parse metadata from a cross-team prefix line. Returns null if not a cross-team message. */
export function parseCrossTeamPrefix(text) {
  const match = CROSS_TEAM_PREFIX_RE.exec(text);
  if (!match?.groups) return null;

  const attrs = parseAttributes(match.groups.attrs ?? '');
  const from = attrs.get(CROSS_TEAM_ATTR_FROM)?.trim();
  const chainDepth = Number.parseInt(attrs.get(CROSS_TEAM_ATTR_DEPTH) ?? '', 10);
  if (!from || !Number.isFinite(chainDepth)) return null;

  return {
    from,
    chainDepth,
    conversationId: attrs.get(CROSS_TEAM_ATTR_CONVERSATION_ID)?.trim() || undefined,
    replyToConversationId: attrs.get(CROSS_TEAM_ATTR_REPLY_TO_CONVERSATION_ID)?.trim() || undefined,
  };
}

/** Strip the cross-team prefix from message text (for UI display). */
export function stripCrossTeamPrefix(text) {
  return text.replace(CROSS_TEAM_PREFIX_RE, '');
}
