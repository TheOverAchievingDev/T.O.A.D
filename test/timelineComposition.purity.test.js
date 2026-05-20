import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { DOT } from '../src/runtime/timelineComposition/index.js';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'runtime', 'timelineComposition');

test('timelineComposition module imports no node:/fs/path/os/child_process/react and never touches process', () => {
  for (const f of ['composeTimeline.js', 'index.js']) {
    const src = readFileSync(join(dir, f), 'utf8');
    assert.ok(!/from\s+['"]node:/.test(src), `${f} imports node:`);
    assert.ok(!/from\s+['"](fs|path|os|child_process|react|react-dom)['"]/.test(src), `${f} imports a forbidden module`);
    assert.ok(!/\bprocess\.(env|cwd|platform)\b/.test(src), `${f} touches process`);
    // Controller-ratified: ban JSX *element* syntax specifically
    // (return <X / => <X / </X>) — a pure data module never has it —
    // while TS-style JSDoc generics (Record<string>, Array<{…}>) are fine.
    assert.ok(!/(return|=>)\s*<[A-Za-z]/.test(src) && !/<\/[A-Za-z]/.test(src), `${f} contains JSX element syntax`);
  }
});

test('DOT set EQUALS FlowTimeline.tsx TimelineDot union (guard-by-test, no import coupling)', () => {
  const fl = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'ui', 'src', 'components', 'cockpit', 'FlowTimeline.tsx'), 'utf8');
  const m = fl.match(/export type TimelineDot\s*=\s*([^;]+);/);
  assert.ok(m, 'TimelineDot union not found in FlowTimeline.tsx');
  const union = new Set(m[1].split('|').map((s) => s.trim().replace(/^['"]|['"]$/g, '')));
  assert.deepEqual([...DOT].sort(), [...union].sort());
});
