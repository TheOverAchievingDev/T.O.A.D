import { Icon } from '../Icon';
import { SettingsSectionHeader, SettingsCard } from './SettingsLayout';
import { useSectionDraft } from './useSectionDraft';
import { SaveBar, SectionMeta } from './SectionShell';

interface McpServer {
  id: string;
  name: string;
  command: string;
  args: string;
  env: string;
  enabled: boolean;
}

interface McpDraft {
  toadEnabled: boolean;
  servers: McpServer[];
}

const DEFAULTS: McpDraft = {
  toadEnabled: true,
  servers: [],
};

let nextServerId = 1;
function makeServerId() {
  return `srv_${Date.now()}_${nextServerId++}`;
}

export function McpServersSettings() {
  const draft = useSectionDraft<McpDraft>({ section: 'mcp', scope: 'global', defaults: DEFAULTS });

  function patchServer(id: string, partial: Partial<McpServer>) {
    draft.patch({
      servers: draft.draft.servers.map((s) => (s.id === id ? { ...s, ...partial } : s)),
    });
  }
  function removeServer(id: string) {
    draft.patch({ servers: draft.draft.servers.filter((s) => s.id !== id) });
  }
  function addServer() {
    draft.patch({
      servers: [
        ...draft.draft.servers,
        { id: makeServerId(), name: 'new-server', command: '', args: '', env: '', enabled: true },
      ],
    });
  }

  return (
    <div>
      <SettingsSectionHeader
        title="MCP servers"
        description="The MCP servers TOAD injects into each launched Claude. TOAD's own stdio server is auto-managed; everything else is yours."
      />
      <SectionMeta draft={draft} />

      <SettingsCard
        title="TOAD's stdio MCP server"
        description="The orchestrator's tool surface (task_*, review_*, validation_run, etc.). Disabling this means launched agents can't talk to TOAD — usually only desired for debugging."
      >
        <div
          className="toggle-row"
          onClick={() => !draft.saving && draft.patch({ toadEnabled: !draft.draft.toadEnabled })}
        >
          <div className={`toggle ${draft.draft.toadEnabled ? 'on' : ''}`} />
          <div className="toggle-label-block" style={{ flex: 1 }}>
            <div className="ti">Inject toad-local MCP into Claude launches</div>
            <div className="sub">Recommended. Each runtime gets its own --mcp-config pointing at src/mcp/stdioServer.js.</div>
          </div>
        </div>
      </SettingsCard>

      <SettingsCard
        title="Custom MCP servers"
        description="Stdio servers added to every Claude launch alongside toad-local. Each entry maps to one entry in the generated --mcp-config."
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {draft.draft.servers.length === 0 && (
            <div className="dim" style={{ fontSize: 12 }}>No custom servers. Click below to add one.</div>
          )}
          {draft.draft.servers.map((s) => (
            <div
              key={s.id}
              style={{
                padding: '10px 12px',
                background: 'rgba(255,255,255,0.02)',
                border: '1px solid var(--border-soft, rgba(255,255,255,0.06))',
                borderRadius: 8,
                display: 'flex',
                flexDirection: 'column',
                gap: 6,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <input
                  className="field-input mono"
                  value={s.name}
                  onChange={(e) => patchServer(s.id, { name: e.target.value })}
                  placeholder="server name"
                  disabled={draft.saving}
                  style={{ flex: 1, fontSize: 12 }}
                />
                <label
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, color: 'var(--fg-muted)', cursor: 'pointer' }}
                >
                  <input
                    type="checkbox"
                    checked={s.enabled}
                    onChange={(e) => patchServer(s.id, { enabled: e.target.checked })}
                    disabled={draft.saving}
                  />
                  enabled
                </label>
                <button type="button" className="icon-btn" onClick={() => removeServer(s.id)} disabled={draft.saving}>
                  <Icon name="trash" size={12} />
                </button>
              </div>
              <input
                className="field-input mono"
                value={s.command}
                onChange={(e) => patchServer(s.id, { command: e.target.value })}
                placeholder="command (e.g. node, python, /usr/local/bin/my-mcp)"
                disabled={draft.saving}
                style={{ fontSize: 11 }}
              />
              <input
                className="field-input mono"
                value={s.args}
                onChange={(e) => patchServer(s.id, { args: e.target.value })}
                placeholder="args (space-separated)"
                disabled={draft.saving}
                style={{ fontSize: 11 }}
              />
              <input
                className="field-input mono"
                value={s.env}
                onChange={(e) => patchServer(s.id, { env: e.target.value })}
                placeholder="env (KEY=value, comma-separated)"
                disabled={draft.saving}
                style={{ fontSize: 11 }}
              />
            </div>
          ))}
          <button type="button" className="btn btn-sm btn-ghost" onClick={addServer} disabled={draft.saving}>
            <Icon name="plus" size={11} /> Add server
          </button>
        </div>
      </SettingsCard>

      <SaveBar draft={draft} />
    </div>
  );
}
