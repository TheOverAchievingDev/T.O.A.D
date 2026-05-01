import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Resolve the API bearer token from layered sources.
 *
 * Precedence:
 *   1. options.explicit                    — DI / constructor option
 *   2. process.env.TOAD_API_TOKEN          — per-shell override
 *   3. <projectCwd>/.toad/api-token        — persistent on-disk token
 *   4. null                                — auth disabled
 *
 * The file lookup is only attempted when projectCwd is set, so unit tests that
 * construct LocalToadRuntime without projectCwd never read from disk.
 */
export function resolveApiToken({ explicit, projectCwd } = {}) {
  if (typeof explicit === 'string' && explicit.trim().length > 0) {
    return explicit.trim();
  }
  const envValue = process.env.TOAD_API_TOKEN;
  if (typeof envValue === 'string' && envValue.trim().length > 0) {
    return envValue.trim();
  }
  if (typeof projectCwd === 'string' && projectCwd.length > 0) {
    const tokenPath = join(projectCwd, '.toad', 'api-token');
    if (existsSync(tokenPath)) {
      const raw = readFileSync(tokenPath, 'utf8').trim();
      if (raw.length > 0) return raw;
    }
  }
  return null;
}
