import { useState } from 'react';
import type { Tweaks } from '@/types';
import type { SetTweak } from '../TweaksPanel';
import { SettingsLayout, type SettingsSectionKey } from './SettingsLayout';
import { GeneralSettings } from './GeneralSettings';
import { GitHubSettings } from './GitHubSettings';
import { RiskPolicySettings } from './RiskPolicySettings';
import { WorkspaceSettings } from './WorkspaceSettings';
import { ProvidersSettings } from './ProvidersSettings';
import { McpServersSettings } from './McpServersSettings';
import { NotificationsSettings } from './NotificationsSettings';
import { AdvancedSettings } from './AdvancedSettings';

interface SettingsScreenProps {
  tweaks: Tweaks;
  setTweak: SetTweak;
  onClose: () => void;
}

export function SettingsScreen({ tweaks, setTweak, onClose }: SettingsScreenProps) {
  const [active, setActive] = useState<SettingsSectionKey>('general');

  return (
    <SettingsLayout active={active} onSelect={setActive} onClose={onClose}>
      {active === 'general' && <GeneralSettings tweaks={tweaks} setTweak={setTweak} />}
      {active === 'providers' && <ProvidersSettings />}
      {active === 'github' && <GitHubSettings />}
      {active === 'workspace' && <WorkspaceSettings />}
      {active === 'risk' && <RiskPolicySettings />}
      {active === 'mcp' && <McpServersSettings />}
      {active === 'notifications' && <NotificationsSettings />}
      {active === 'advanced' && <AdvancedSettings />}
    </SettingsLayout>
  );
}
