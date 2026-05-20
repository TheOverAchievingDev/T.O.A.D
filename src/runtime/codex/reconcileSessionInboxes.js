// SP1a Stage 2 — pure boot-reconciliation core. Given the live runtimes,
// an inbox reader, and a "was this message already delivered" predicate,
// return the (runtimeId, message) pairs that a session_turn agent still
// owes a resume turn. Pure / total: LocalToadRuntime does the I/O of
// re-invoking DeliveryWorker.deliverMessage for each.
export function computeUndeliveredSessionMessages({ runtimes, listInbox, isCommitted }) {
  if (!Array.isArray(runtimes)) return [];
  const out = [];
  for (const r of runtimes) {
    if (!r || r.deliveryMode !== 'session_turn' || r.status !== 'running') continue;
    let inbox;
    try { inbox = listInbox({ teamId: r.teamId, agentId: r.agentId }); } catch { inbox = []; }
    if (!Array.isArray(inbox)) continue;
    for (const m of inbox) {
      if (!m || typeof m.messageId !== 'string') continue;
      let done = false;
      try { done = isCommitted(m.messageId) === true; } catch { done = false; }
      if (!done) out.push({ runtimeId: r.runtimeId, teamId: r.teamId, agentId: r.agentId, messageId: m.messageId });
    }
  }
  return out;
}
