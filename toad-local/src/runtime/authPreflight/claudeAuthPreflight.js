// Pure decision core (design §4.2). All IO injected. NO spawn/fs here —
// the wiring layer supplies readCredsStatus/refreshOnce and owns the
// mutex + relaunch-guard map. `ok` ≜ a `claude --print` turn COMPLETED
// (the CLI had the opportunity to refresh) — NOT merely "no error".
import { TOKEN_STATUS } from '../../providers/providerAuth.js';

export const RELAUNCH_GUARD_MS = 60_000;

const BLOCK_REASON =
  'Claude token expired and the automatic refresh did not succeed. '
  + 'Re-login: run `claude` in a terminal, then `/login`, and relaunch.';

/**
 * @param {object} a
 * @param {() => {tokenStatus:string, reason?:string}} a.readCredsStatus
 * @param {() => Promise<{ok:boolean,authRejected:boolean,timedOut:boolean}>} a.refreshOnce
 * @param {() => number} a.now
 * @param {Map<string,{outcome:string,at:number}>} a.relaunchState
 * @param {string} a.credsPath
 * @returns {Promise<{decision:'proceed'|'block', warn?:boolean, tokenStatus:string, reason?:string}>}
 */
export async function claudeAuthPreflight({ readCredsStatus, refreshOnce, now, relaunchState, credsPath }) {
  const s1 = readCredsStatus();
  if (s1.tokenStatus === TOKEN_STATUS.FRESH) {
    return { decision: 'proceed', tokenStatus: s1.tokenStatus };
  }
  if (s1.tokenStatus === TOKEN_STATUS.UNRECOVERABLE) {
    return { decision: 'block', tokenStatus: s1.tokenStatus, reason: BLOCK_REASON };
  }
  // stale_refreshable
  const prev = relaunchState.get(credsPath);
  if (prev && prev.outcome === 'warn' && (now() - prev.at) < RELAUNCH_GUARD_MS) {
    return { decision: 'block', tokenStatus: s1.tokenStatus, reason: BLOCK_REASON };
  }
  const r = await refreshOnce();
  const s2 = readCredsStatus();
  if (s2.tokenStatus === TOKEN_STATUS.FRESH) {
    relaunchState.delete(credsPath);
    return { decision: 'proceed', tokenStatus: s2.tokenStatus };
  }
  if (r.authRejected === true) {
    return { decision: 'block', tokenStatus: s2.tokenStatus, reason: BLOCK_REASON };
  }
  if (s2.tokenStatus === TOKEN_STATUS.UNRECOVERABLE) {
    return { decision: 'block', tokenStatus: s2.tokenStatus, reason: BLOCK_REASON };
  }
  if (r.ok === true) {
    // A turn COMPLETED yet creds are still stale: the CLI was given a
    // real use and did NOT refresh; the spawned agent's first turn is
    // the same use → provably-doomed. (Design §4.2 finding-#1 ruling.)
    return { decision: 'block', tokenStatus: s2.tokenStatus, reason: BLOCK_REASON };
  }
  // r.ok === false: the refresh turn never completed (spawn-fail /
  // timeout / kill / non-auth transient). The CLI never got the chance
  // to refresh — the ONLY genuinely-uncertain case. Proceed+warn, and
  // record it so a relaunch within the window short-circuits to block.
  relaunchState.set(credsPath, { outcome: 'warn', at: now() });
  return { decision: 'proceed', warn: true, tokenStatus: s2.tokenStatus, reason: s2.reason };
}
