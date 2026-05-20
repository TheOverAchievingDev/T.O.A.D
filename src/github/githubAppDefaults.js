/**
 * Built-in defaults for the TOAD GitHub OAuth App.
 *
 * When this constant is non-empty, "Sign in with GitHub" works end-to-end
 * without the user pasting a Client ID — that's the one-click experience
 * VS Code/Cursor/etc. ship.
 *
 * To fill this in for your TOAD distribution:
 *   1. Register a GitHub OAuth App at https://github.com/settings/applications/new
 *      - Application name: TOAD (or whatever you want users to see)
 *      - Homepage URL: http://localhost (any URL — metadata only)
 *      - Authorization callback URL: http://localhost (required field, unused for Device Flow)
 *      - Tick "Enable Device Flow"
 *   2. Click Register application.
 *   3. Copy the Client ID (looks like Iv1.1234567890abcdef).
 *   4. Paste it below as the value of BUILT_IN_GITHUB_CLIENT_ID.
 *
 * The Client ID is a *public* identifier — it's safe to commit to git. The
 * client_secret (which we don't use for Device Flow) is what would need to
 * stay secret. This is the same model gh CLI uses.
 *
 * Resolution order in the orchestrator (first non-empty wins):
 *   1. args.clientId from a tool call (rare; advanced override)
 *   2. settings.github.clientId (user-pasted via UI)
 *   3. TOAD_GITHUB_CLIENT_ID env var
 *   4. BUILT_IN_GITHUB_CLIENT_ID below
 */
export const BUILT_IN_GITHUB_CLIENT_ID = 'Ov23liTzzbpPeb02ZYHa';
