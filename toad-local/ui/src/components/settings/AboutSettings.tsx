import { useState, useEffect } from 'react';
import { check, type Update } from '@tauri-apps/plugin-updater';
import { getVersion } from '@tauri-apps/api/app';
import { relaunch } from '@tauri-apps/plugin-process';
import { SettingsSectionHeader, SettingsCard } from './SettingsLayout';
import { Icon } from '../Icon';

export function AboutSettings() {
  const [version, setVersion] = useState<string>('...');
  const [checking, setChecking] = useState(false);
  const [update, setUpdate] = useState<Update | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [installing, setInstalling] = useState(false);
  const [progress, setProgress] = useState<{ downloaded: number; total?: number } | null>(null);
  const [hasChecked, setHasChecked] = useState(false);

  useEffect(() => {
    getVersion().then(setVersion).catch((e) => setError(String(e)));
  }, []);

  async function checkForUpdates() {
    setChecking(true);
    setError(null);
    setUpdate(null);
    try {
      const manifest = await check();
      setUpdate(manifest);
      setHasChecked(true);
    } catch (e) {
      console.error(e);
      setError('Failed to check for updates. Make sure you are online.');
    } finally {
      setChecking(false);
    }
  }

  async function installUpdate() {
    if (!update) return;
    setInstalling(true);
    setError(null);
    try {
      let downloaded = 0;
      await update.downloadAndInstall((event) => {
        switch (event.event) {
          case 'Started':
            setProgress({ downloaded: 0, total: event.data.contentLength });
            break;
          case 'Progress':
            downloaded += event.data.chunkLength;
            setProgress((p) => (p ? { ...p, downloaded } : { downloaded }));
            break;
          case 'Finished':
            setProgress(null);
            break;
        }
      });
      await relaunch();
    } catch (e) {
      console.error(e);
      setError('Failed to install update.');
      setInstalling(false);
    }
  }

  return (
    <div>
      <SettingsSectionHeader
        title="About Symphony AI"
        description="Software foundry and multi-agent workspace."
      />

      <SettingsCard title="Application">
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
          <div
            style={{
              width: 48,
              height: 48,
              background: 'var(--clay, #d97757)',
              borderRadius: 12,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: '#fff',
            }}
          >
            <Icon name="sparkle" size={24} />
          </div>
          <div>
            <div style={{ fontSize: 16, fontWeight: 700 }}>Symphony AI</div>
            <div className="dim" style={{ fontSize: 13 }}>
              Version {version}
            </div>
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {error && (
            <div
              style={{
                padding: '10px 12px',
                background: 'rgba(239, 68, 68, 0.1)',
                border: '1px solid rgba(239, 68, 68, 0.2)',
                borderRadius: 6,
                color: '#f87171',
                fontSize: 12,
              }}
            >
              {error}
            </div>
          )}

          {!update && !checking && (
            <button
              type="button"
              className="btn btn-sm"
              onClick={checkForUpdates}
              disabled={checking}
            >
              <Icon name="refresh" size={11} className={checking ? 'spin' : ''} />
              Check for updates
            </button>
          )}

          {checking && (
            <div className="dim" style={{ fontSize: 13, display: 'flex', alignItems: 'center', gap: 8 }}>
              <Icon name="refresh" size={12} className="spin" />
              Checking for updates...
            </div>
          )}

          {update && (
            <div
              style={{
                padding: '16px',
                background: 'rgba(217, 119, 87, 0.05)',
                border: '1px solid rgba(217, 119, 87, 0.2)',
                borderRadius: 8,
              }}
            >
              <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 4 }}>
                Update available: {update.version}
              </div>
              {update.body && (
                <div
                  className="dim"
                  style={{
                    fontSize: 12,
                    lineHeight: 1.5,
                    marginBottom: 16,
                    maxHeight: 100,
                    overflowY: 'auto',
                  }}
                >
                  {update.body}
                </div>
              )}

              {installing ? (
                <div>
                  <div style={{ fontSize: 12, marginBottom: 8, display: 'flex', justifyContent: 'space-between' }}>
                    <span>Installing update...</span>
                    {progress?.total && (
                      <span>
                        {Math.round((progress.downloaded / progress.total) * 100)}%
                      </span>
                    )}
                  </div>
                  <div
                    style={{
                      height: 4,
                      background: 'rgba(255,255,255,0.1)',
                      borderRadius: 2,
                      overflow: 'hidden',
                    }}
                  >
                    <div
                      style={{
                        height: '100%',
                        background: 'var(--clay, #d97757)',
                        width: progress?.total
                          ? `${(progress.downloaded / progress.total) * 100}%`
                          : '20%',
                      }}
                    />
                  </div>
                </div>
              ) : (
                <button type="button" className="btn btn-sm btn-primary" onClick={installUpdate}>
                  Download and install
                </button>
              )}
            </div>
          )}

          {!update && hasChecked && !checking && !error && version !== '...' && (
            <div className="dim" style={{ fontSize: 12 }}>
              Symphony AI is up to date.
            </div>
          )}
        </div>
      </SettingsCard>

      <SettingsCard title="License">
        <div className="dim" style={{ fontSize: 12, lineHeight: 1.6 }}>
          Copyright © 2026 The OverAchievingDev. All rights reserved.
          <br />
          Licensed under the MIT License.
        </div>
      </SettingsCard>
    </div>
  );
}
