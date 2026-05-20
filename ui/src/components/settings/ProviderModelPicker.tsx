import { useMemo } from 'react';
import { SEED_PROVIDERS } from '@/data/seed';

/** Reasoning-effort levels.
 *
 * The same Default/Low/Medium/High set works across all three providers
 * that support a thinking parameter:
 *   - Anthropic Claude: `thinking` mode
 *   - OpenAI Codex: `model_reasoning_effort` (also has minimal + xhigh, omitted here)
 *   - Google Gemini 3.x: `thinking_level` (also has Deep Think, omitted)
 *
 * OpenCode has no equivalent and the picker hides this row for it.
 */
export const EFFORT_LEVELS = ['Default', 'Low', 'Medium', 'High'] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];

const PROVIDERS_WITH_EFFORT = new Set(['anthropic', 'openai', 'gemini']);

export interface ProviderModelPickerProps {
  /** Stored as `provider/model` (back-compat) or `provider/model:effort`
   *  when an effort level is set. Empty string = use the team launch
   *  default. */
  value: string;
  onChange: (next: string) => void;
  disabled?: boolean;
  /** Compact spacing for dense forms (defaults to false). */
  compact?: boolean;
}

interface ParsedValue {
  providerId: string;
  model: string;
  effort: EffortLevel;
}

function parseValue(value: string): ParsedValue {
  const fallbackProvider = SEED_PROVIDERS[0]?.id ?? 'anthropic';
  if (typeof value !== 'string' || value.length === 0) {
    return { providerId: fallbackProvider, model: 'Default', effort: 'Default' };
  }

  // Strip the optional `:effort` suffix.
  const colon = value.lastIndexOf(':');
  let core = value;
  let effort: EffortLevel = 'Default';
  if (colon !== -1) {
    const tail = value.slice(colon + 1);
    if ((EFFORT_LEVELS as readonly string[]).includes(tail)) {
      effort = tail as EffortLevel;
      core = value.slice(0, colon);
    }
  }

  const slash = core.indexOf('/');
  if (slash === -1) {
    return { providerId: core, model: 'Default', effort };
  }
  return {
    providerId: core.slice(0, slash),
    model: core.slice(slash + 1) || 'Default',
    effort,
  };
}

function joinValue(providerId: string, model: string, effort: EffortLevel): string {
  const base = `${providerId}/${model}`;
  return effort === 'Default' ? base : `${base}:${effort}`;
}

/**
 * Two- or three-part picker matching the upstream Create-Team layout:
 *
 *   [ Anthropic ▾ ]   [ Default ] [Opus 4.7] [Opus 4.7 (1M)] [Sonnet 4.6] …
 *                     [ Effort:   Default ] [ Low ] [ Medium ] [ High ]   ← Anthropic only
 *
 * The provider dropdown swaps the model pill set when changed. Selecting
 * an Anthropic provider also reveals the effort row; switching to a
 * non-Anthropic provider hides it (and clears any stored effort level).
 */
export function ProviderModelPicker({ value, onChange, disabled, compact }: ProviderModelPickerProps) {
  const { providerId, model, effort } = parseValue(value);
  const provider = useMemo(
    () => SEED_PROVIDERS.find((p) => p.id === providerId) ?? SEED_PROVIDERS[0],
    [providerId],
  );
  const showEffort = PROVIDERS_WITH_EFFORT.has(providerId);

  function selectProvider(nextProviderId: string) {
    const next = SEED_PROVIDERS.find((p) => p.id === nextProviderId);
    // Reset to "Default" when switching providers — old model name
    // probably doesn't exist on the new provider. Also drop the effort
    // level since it's Anthropic-specific.
    onChange(joinValue(nextProviderId, next?.models?.[0] ?? 'Default', 'Default'));
  }

  function selectModel(nextModel: string) {
    onChange(joinValue(providerId, nextModel, effort));
  }

  function selectEffort(nextEffort: EffortLevel) {
    onChange(joinValue(providerId, model, nextEffort));
  }

  const fontSize = compact ? 11 : 12;
  // Native <select>s in Windows Chromium need a bit more vertical room than
  // 30px so descenders/ascenders aren't clipped — bumping to 34 gives the
  // browser enough headroom to render the option text without cutoff.
  const selectHeight = compact ? 30 : 34;
  const pillFontSize = compact ? 10.5 : 11.5;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          gap: 8,
        }}
      >
        <select
          className="field-input"
          value={providerId}
          onChange={(e) => selectProvider(e.target.value)}
          disabled={disabled}
          style={{
            fontSize,
            height: selectHeight,
            lineHeight: `${selectHeight - 4}px`,
            paddingTop: 0,
            paddingBottom: 0,
            paddingRight: 28,
            paddingLeft: 10,
            minWidth: 170,
            flexShrink: 0,
          }}
        >
          {SEED_PROVIDERS.map((p) => (
            <option key={p.id} value={p.id}>{p.label}</option>
          ))}
        </select>

        <div className="seg" style={{ flex: 1, minWidth: 0, flexWrap: 'wrap' }}>
          {(provider?.models ?? []).map((m) => {
            const active = m === model;
            return (
              <button
                key={m}
                type="button"
                className={active ? 'active' : ''}
                onClick={() => selectModel(m)}
                disabled={disabled}
                style={{
                  fontSize: pillFontSize,
                  fontFamily: m === 'Default' ? undefined : 'var(--mono-stack, monospace)',
                }}
                title={m === 'Default' ? 'Let the runtime / CLI pick its own default model' : m}
              >
                {m}
              </button>
            );
          })}
        </div>
      </div>

      {showEffort && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            paddingLeft: 4,
          }}
        >
          <span
            className="dim"
            style={{ fontSize: pillFontSize, minWidth: 50, textTransform: 'uppercase', letterSpacing: '0.04em' }}
          >
            Effort
          </span>
          <div className="seg" style={{ flex: 1, minWidth: 0, flexWrap: 'wrap' }}>
            {EFFORT_LEVELS.map((e) => (
              <button
                key={e}
                type="button"
                className={effort === e ? 'active' : ''}
                onClick={() => selectEffort(e)}
                disabled={disabled}
                style={{ fontSize: pillFontSize }}
                title={
                  e === 'Default'
                    ? "Let the model pick its own thinking depth"
                    : `${e} reasoning effort — ${e === 'Low' ? 'fastest, shallowest' : e === 'High' ? 'deepest, slowest' : 'balanced'}`
                }
              >
                {e}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
