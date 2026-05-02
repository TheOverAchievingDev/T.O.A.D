import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Tweaks } from '@/types';

const TWEAKS_STYLE = `
  .twk-panel{position:fixed;right:16px;bottom:16px;z-index:2147483646;width:280px;
    max-height:calc(100vh - 32px);display:flex;flex-direction:column;
    background:rgba(250,249,247,.78);color:#29261b;
    -webkit-backdrop-filter:blur(24px) saturate(160%);backdrop-filter:blur(24px) saturate(160%);
    border:.5px solid rgba(255,255,255,.6);border-radius:14px;
    box-shadow:0 1px 0 rgba(255,255,255,.5) inset,0 12px 40px rgba(0,0,0,.18);
    font:11.5px/1.4 ui-sans-serif,system-ui,-apple-system,sans-serif;overflow:hidden}
  .twk-hd{display:flex;align-items:center;justify-content:space-between;
    padding:10px 8px 10px 14px;cursor:move;user-select:none}
  .twk-hd b{font-size:12px;font-weight:600;letter-spacing:.01em}
  .twk-x{appearance:none;border:0;background:transparent;color:rgba(41,38,27,.55);
    width:22px;height:22px;border-radius:6px;cursor:default;font-size:13px;line-height:1}
  .twk-x:hover{background:rgba(0,0,0,.06);color:#29261b}
  .twk-body{padding:2px 14px 14px;display:flex;flex-direction:column;gap:10px;
    overflow-y:auto;overflow-x:hidden;min-height:0;
    scrollbar-width:thin;scrollbar-color:rgba(0,0,0,.15) transparent}
  .twk-body::-webkit-scrollbar{width:8px}
  .twk-body::-webkit-scrollbar-track{background:transparent;margin:2px}
  .twk-body::-webkit-scrollbar-thumb{background:rgba(0,0,0,.15);border-radius:4px;
    border:2px solid transparent;background-clip:content-box}
  .twk-body::-webkit-scrollbar-thumb:hover{background:rgba(0,0,0,.25);
    border:2px solid transparent;background-clip:content-box}
  .twk-row{display:flex;flex-direction:column;gap:5px}
  .twk-row-h{flex-direction:row;align-items:center;justify-content:space-between;gap:10px}
  .twk-lbl{display:flex;justify-content:space-between;align-items:baseline;
    color:rgba(41,38,27,.72)}
  .twk-lbl>span:first-child{font-weight:500}
  .twk-val{color:rgba(41,38,27,.5);font-variant-numeric:tabular-nums}
  .twk-sect{font-size:10px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;
    color:rgba(41,38,27,.45);padding:10px 0 0}
  .twk-sect:first-child{padding-top:0}
  .twk-field{appearance:none;width:100%;height:26px;padding:0 8px;
    border:.5px solid rgba(0,0,0,.1);border-radius:7px;
    background:rgba(255,255,255,.6);color:inherit;font:inherit;outline:none}
  .twk-field:focus{border-color:rgba(0,0,0,.25);background:rgba(255,255,255,.85)}
  select.twk-field{padding-right:22px}
  .twk-slider{appearance:none;-webkit-appearance:none;width:100%;height:4px;margin:6px 0;
    border-radius:999px;background:rgba(0,0,0,.12);outline:none}
  .twk-slider::-webkit-slider-thumb{-webkit-appearance:none;appearance:none;
    width:14px;height:14px;border-radius:50%;background:#fff;
    border:.5px solid rgba(0,0,0,.12);box-shadow:0 1px 3px rgba(0,0,0,.2);cursor:default}
  .twk-slider::-moz-range-thumb{width:14px;height:14px;border-radius:50%;
    background:#fff;border:.5px solid rgba(0,0,0,.12);box-shadow:0 1px 3px rgba(0,0,0,.2);cursor:default}
  .twk-seg{position:relative;display:flex;padding:2px;border-radius:8px;
    background:rgba(0,0,0,.06);user-select:none}
  .twk-seg-thumb{position:absolute;top:2px;bottom:2px;border-radius:6px;
    background:rgba(255,255,255,.9);box-shadow:0 1px 2px rgba(0,0,0,.12);
    transition:left .15s cubic-bezier(.3,.7,.4,1),width .15s}
  .twk-seg.dragging .twk-seg-thumb{transition:none}
  .twk-seg button{appearance:none;position:relative;z-index:1;flex:1;border:0;
    background:transparent;color:inherit;font:inherit;font-weight:500;min-height:22px;
    border-radius:6px;cursor:default;padding:4px 6px;line-height:1.2;overflow-wrap:anywhere}
  .twk-toggle{position:relative;width:32px;height:18px;border:0;border-radius:999px;
    background:rgba(0,0,0,.15);transition:background .15s;cursor:default;padding:0}
  .twk-toggle[data-on="1"]{background:#34c759}
  .twk-toggle i{position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;
    background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.25);transition:transform .15s}
  .twk-toggle[data-on="1"] i{transform:translateX(14px)}
  .twk-num{display:flex;align-items:center;height:26px;padding:0 0 0 8px;
    border:.5px solid rgba(0,0,0,.1);border-radius:7px;background:rgba(255,255,255,.6)}
  .twk-num-lbl{font-weight:500;color:rgba(41,38,27,.6);cursor:ew-resize;
    user-select:none;padding-right:8px}
  .twk-num input{flex:1;min-width:0;height:100%;border:0;background:transparent;
    font:inherit;font-variant-numeric:tabular-nums;text-align:right;padding:0 8px 0 0;
    outline:none;color:inherit;-moz-appearance:textfield}
  .twk-num input::-webkit-inner-spin-button,.twk-num input::-webkit-outer-spin-button{
    -webkit-appearance:none;margin:0}
  .twk-num-unit{padding-right:8px;color:rgba(41,38,27,.45)}
  .twk-btn{appearance:none;height:26px;padding:0 12px;border:0;border-radius:7px;
    background:rgba(0,0,0,.78);color:#fff;font:inherit;font-weight:500;cursor:default}
  .twk-btn:hover{background:rgba(0,0,0,.88)}
  .twk-btn.secondary{background:rgba(0,0,0,.06);color:inherit}
  .twk-btn.secondary:hover{background:rgba(0,0,0,.1)}
  .twk-swatch{appearance:none;-webkit-appearance:none;width:56px;height:22px;
    border:.5px solid rgba(0,0,0,.1);border-radius:6px;padding:0;cursor:default;
    background:transparent;flex-shrink:0}
  .twk-swatch::-webkit-color-swatch-wrapper{padding:0}
  .twk-swatch::-webkit-color-swatch{border:0;border-radius:5.5px}
  .twk-swatch::-moz-color-swatch{border:0;border-radius:5.5px}
`;

export type SetTweak = <K extends keyof Tweaks>(key: K, value: Tweaks[K]) => void;

export interface TweaksPanelProps {
  tweaks: Tweaks;
  setTweak: SetTweak;
  title?: string;
  children?: ReactNode;
  defaultOpen?: boolean;
}

interface TweakSectionProps {
  label: string;
  children?: ReactNode;
}

interface TweakRowProps {
  label: string;
  value?: ReactNode;
  children?: ReactNode;
  inline?: boolean;
}

interface TweakSliderProps {
  label: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  onChange: (value: number) => void;
}

interface TweakToggleProps {
  label: string;
  value: boolean;
  onChange: (value: boolean) => void;
}

type TweakOption<T extends string> = T | { value: T; label: string };

interface TweakRadioProps<T extends string> {
  label: string;
  value: T;
  options: readonly TweakOption<T>[];
  onChange: (value: T) => void;
}

interface TweakSelectProps<T extends string> {
  label: string;
  value: T;
  options: readonly TweakOption<T>[];
  onChange: (value: T) => void;
}

interface TweakTextProps {
  label: string;
  value: string;
  placeholder?: string;
  onChange: (value: string) => void;
}

interface TweakNumberProps {
  label: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  onChange: (value: number) => void;
}

interface TweakColorProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
}

interface TweakButtonProps {
  label: string;
  onClick: () => void;
  secondary?: boolean;
}

const PAD = 16;

function normalizeOptions<T extends string>(options: readonly TweakOption<T>[]) {
  return options.map((option) => (
    typeof option === 'string' ? { value: option, label: option } : option
  ));
}

function postHostMessage(message: Record<string, unknown>) {
  if (typeof window !== 'undefined' && window.parent) {
    window.parent.postMessage(message, '*');
  }
}

export function TweaksPanel({
  tweaks,
  setTweak,
  title = 'Tweaks',
  children,
  defaultOpen = true,
}: TweaksPanelProps) {
  const [open, setOpen] = useState(defaultOpen);
  const dragRef = useRef<HTMLDivElement | null>(null);
  const offsetRef = useRef({ x: PAD, y: PAD });

  const clampToViewport = useCallback(() => {
    const panel = dragRef.current;
    if (!panel) return;
    const maxRight = Math.max(PAD, window.innerWidth - panel.offsetWidth - PAD);
    const maxBottom = Math.max(PAD, window.innerHeight - panel.offsetHeight - PAD);
    offsetRef.current = {
      x: Math.min(maxRight, Math.max(PAD, offsetRef.current.x)),
      y: Math.min(maxBottom, Math.max(PAD, offsetRef.current.y)),
    };
    panel.style.right = `${offsetRef.current.x}px`;
    panel.style.bottom = `${offsetRef.current.y}px`;
  }, []);

  useEffect(() => {
    if (!open) return undefined;
    clampToViewport();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', clampToViewport);
      return () => window.removeEventListener('resize', clampToViewport);
    }
    const observer = new ResizeObserver(clampToViewport);
    observer.observe(document.documentElement);
    return () => observer.disconnect();
  }, [clampToViewport, open]);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { type?: unknown } | null;
      if (data?.type === '__activate_edit_mode') setOpen(true);
      if (data?.type === '__deactivate_edit_mode') setOpen(false);
    };

    window.addEventListener('message', onMessage);
    postHostMessage({ type: '__edit_mode_available' });
    return () => window.removeEventListener('message', onMessage);
  }, []);

  const dismiss = () => {
    setOpen(false);
    postHostMessage({ type: '__edit_mode_dismissed' });
  };

  const onDragStart = (event: React.MouseEvent<HTMLDivElement>) => {
    const panel = dragRef.current;
    if (!panel) return;
    const rect = panel.getBoundingClientRect();
    const startX = event.clientX;
    const startY = event.clientY;
    const startRight = window.innerWidth - rect.right;
    const startBottom = window.innerHeight - rect.bottom;

    const move = (moveEvent: MouseEvent) => {
      offsetRef.current = {
        x: startRight - (moveEvent.clientX - startX),
        y: startBottom - (moveEvent.clientY - startY),
      };
      clampToViewport();
    };

    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };

    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  const defaultControls = useMemo(() => (
    <>
      <TweakSection label="Appearance" />
      <TweakRadio
        label="Theme"
        value={tweaks.theme}
        options={['dark', 'light'] as const}
        onChange={(value) => setTweak('theme', value)}
      />
      <TweakRadio
        label="Density"
        value={tweaks.density}
        options={['comfy', 'compact'] as const}
        onChange={(value) => setTweak('density', value)}
      />
      <TweakSelect
        label="Layout"
        value={tweaks.layout}
        options={[
          { value: 'org', label: 'Org' },
          { value: 'chat', label: 'Chat' },
          { value: 'kanban', label: 'Kanban' },
        ] as const}
        onChange={(value) => setTweak('layout', value)}
      />
      <TweakSelect
        label="Card"
        value={tweaks.cardVariant}
        options={[
          { value: 'detail', label: 'Detail' },
          { value: 'compact', label: 'Compact' },
          { value: 'terminal', label: 'Terminal' },
        ] as const}
        onChange={(value) => setTweak('cardVariant', value)}
      />

      <TweakSection label="Screen" />
      <TweakSelect
        label="Active"
        value={tweaks.screen}
        options={[
          { value: 'workspace', label: 'Workspace' },
          { value: 'picker', label: 'Picker' },
          { value: 'empty', label: 'Empty' },
          { value: 'onboarding', label: 'Onboarding' },
          { value: 'create', label: 'Create' },
          { value: 'task', label: 'Task' },
        ] as const}
        onChange={(value) => setTweak('screen', value)}
      />
      <TweakText
        label="Agent inbox"
        value={tweaks.agentInbox}
        placeholder="agent id"
        onChange={(value) => setTweak('agentInbox', value)}
      />

      <TweakSection label="Drawers" />
      <TweakToggle
        label="Providers"
        value={tweaks.showProviders}
        onChange={(value) => setTweak('showProviders', value)}
      />
      <TweakToggle
        label="Notifications"
        value={tweaks.showNotifs}
        onChange={(value) => setTweak('showNotifs', value)}
      />
    </>
  ), [setTweak, tweaks]);

  if (!open) return null;

  return (
    <>
      <style>{TWEAKS_STYLE}</style>
      <div
        ref={dragRef}
        className="twk-panel"
        data-noncommentable=""
        style={{ right: offsetRef.current.x, bottom: offsetRef.current.y }}
      >
        <div className="twk-hd" onMouseDown={onDragStart}>
          <b>{title}</b>
          <button
            className="twk-x"
            aria-label="Close tweaks"
            onMouseDown={(event) => event.stopPropagation()}
            onClick={dismiss}
          >
            x
          </button>
        </div>
        <div className="twk-body">{children ?? defaultControls}</div>
      </div>
    </>
  );
}

export function TweakSection({ label, children }: TweakSectionProps) {
  return (
    <>
      <div className="twk-sect">{label}</div>
      {children}
    </>
  );
}

export function TweakRow({ label, value, children, inline = false }: TweakRowProps) {
  return (
    <div className={inline ? 'twk-row twk-row-h' : 'twk-row'}>
      <div className="twk-lbl">
        <span>{label}</span>
        {value != null && <span className="twk-val">{value}</span>}
      </div>
      {children}
    </div>
  );
}

export function TweakSlider({
  label,
  value,
  min = 0,
  max = 100,
  step = 1,
  unit = '',
  onChange,
}: TweakSliderProps) {
  return (
    <TweakRow label={label} value={`${value}${unit}`}>
      <input
        type="range"
        className="twk-slider"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </TweakRow>
  );
}

export function TweakToggle({ label, value, onChange }: TweakToggleProps) {
  return (
    <div className="twk-row twk-row-h">
      <div className="twk-lbl"><span>{label}</span></div>
      <button
        type="button"
        className="twk-toggle"
        data-on={value ? '1' : '0'}
        role="switch"
        aria-checked={value}
        onClick={() => onChange(!value)}
      >
        <i />
      </button>
    </div>
  );
}

export function TweakRadio<T extends string>({
  label,
  value,
  options,
  onChange,
}: TweakRadioProps<T>) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const [dragging, setDragging] = useState(false);
  const opts = normalizeOptions(options);
  const idx = Math.max(0, opts.findIndex((option) => option.value === value));
  const count = opts.length;
  const valueRef = useRef(value);
  valueRef.current = value;

  const segAt = (clientX: number) => {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect) return valueRef.current;
    const inner = Math.max(1, rect.width - 4);
    const index = Math.floor(((clientX - rect.left - 2) / inner) * count);
    return opts[Math.max(0, Math.min(count - 1, index))].value;
  };

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    setDragging(true);
    const firstValue = segAt(event.clientX);
    if (firstValue !== valueRef.current) onChange(firstValue);

    const move = (moveEvent: PointerEvent) => {
      const nextValue = segAt(moveEvent.clientX);
      if (nextValue !== valueRef.current) onChange(nextValue);
    };

    const up = () => {
      setDragging(false);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };

    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  return (
    <TweakRow label={label}>
      <div
        ref={trackRef}
        role="radiogroup"
        onPointerDown={onPointerDown}
        className={dragging ? 'twk-seg dragging' : 'twk-seg'}
      >
        <div
          className="twk-seg-thumb"
          style={{
            left: `calc(2px + ${idx} * (100% - 4px) / ${count})`,
            width: `calc((100% - 4px) / ${count})`,
          }}
        />
        {opts.map((option) => (
          <button key={option.value} type="button" role="radio" aria-checked={option.value === value}>
            {option.label}
          </button>
        ))}
      </div>
    </TweakRow>
  );
}

export function TweakSelect<T extends string>({
  label,
  value,
  options,
  onChange,
}: TweakSelectProps<T>) {
  const opts = normalizeOptions(options);

  return (
    <TweakRow label={label}>
      <select className="twk-field" value={value} onChange={(event) => onChange(event.target.value as T)}>
        {opts.map((option) => (
          <option key={option.value} value={option.value}>{option.label}</option>
        ))}
      </select>
    </TweakRow>
  );
}

export function TweakText({ label, value, placeholder, onChange }: TweakTextProps) {
  return (
    <TweakRow label={label}>
      <input
        className="twk-field"
        type="text"
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
      />
    </TweakRow>
  );
}

export function TweakNumber({
  label,
  value,
  min,
  max,
  step = 1,
  unit = '',
  onChange,
}: TweakNumberProps) {
  const startRef = useRef({ x: 0, value: 0 });

  const clamp = (number: number) => {
    if (Number.isNaN(number)) return value;
    if (min != null && number < min) return min;
    if (max != null && number > max) return max;
    return number;
  };

  const onScrubStart = (event: React.PointerEvent<HTMLSpanElement>) => {
    event.preventDefault();
    startRef.current = { x: event.clientX, value };
    const decimals = (String(step).split('.')[1] ?? '').length;

    const move = (moveEvent: PointerEvent) => {
      const dx = moveEvent.clientX - startRef.current.x;
      const raw = startRef.current.value + dx * step;
      const snapped = Math.round(raw / step) * step;
      onChange(clamp(Number(snapped.toFixed(decimals))));
    };

    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };

    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  return (
    <div className="twk-num">
      <span className="twk-num-lbl" onPointerDown={onScrubStart}>{label}</span>
      <input
        type="number"
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(event) => onChange(clamp(Number(event.target.value)))}
      />
      {unit && <span className="twk-num-unit">{unit}</span>}
    </div>
  );
}

export function TweakColor({ label, value, onChange }: TweakColorProps) {
  return (
    <div className="twk-row twk-row-h">
      <div className="twk-lbl"><span>{label}</span></div>
      <input
        type="color"
        className="twk-swatch"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}

export function TweakButton({ label, onClick, secondary = false }: TweakButtonProps) {
  return (
    <button
      type="button"
      className={secondary ? 'twk-btn secondary' : 'twk-btn'}
      onClick={onClick}
    >
      {label}
    </button>
  );
}
