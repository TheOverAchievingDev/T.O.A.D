export type FlowPanelState = 'collapsed' | 'expanded';

export const DEFAULT_FLOW_PANEL_STATE: FlowPanelState = 'collapsed';
export const FLOW_LEFT_PANEL_STORAGE_KEY = 'cockpit.forMe.flow.leftPanel';
export const FLOW_RIGHT_PANEL_STORAGE_KEY = 'cockpit.forMe.flow.rightPanel';

export function normalizeFlowPanelState(value: unknown): FlowPanelState {
  return value === 'expanded' || value === 'collapsed' ? value : DEFAULT_FLOW_PANEL_STATE;
}
