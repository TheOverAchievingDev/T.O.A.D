import { useState } from 'react';
import { ROLES, roleStyle } from '@/data/roles';
import { Icon, type IconName } from '@/components/Icon';
import type { RoleId } from '@/types';

type OnboardingStep = 1 | 2 | 3 | 4;
type OnboardingProviderId = 'anthropic' | 'openai' | 'opencode';

interface OnboardingProvider {
  id: OnboardingProviderId;
  label: string;
  desc: string;
  connected: boolean;
  primary?: boolean;
  beta?: boolean;
}

interface OnboardingStepItem {
  n: OnboardingStep;
  label: string;
}

interface TeamTemplate {
  id: string;
  label: string;
  desc: string;
  icon: IconName;
  roles: RoleId[];
}

export interface OnboardingScreenProps {
  onDone: () => void;
}

const ONBOARDING_PROVIDERS: OnboardingProvider[] = [
  {
    id: 'anthropic',
    label: 'Anthropic',
    desc: 'Claude Code - Opus, Sonnet, Haiku',
    connected: false,
    primary: true,
  },
  {
    id: 'openai',
    label: 'OpenAI Codex',
    desc: 'ChatGPT-style runtime - 5.4 family',
    connected: false,
  },
  {
    id: 'opencode',
    label: 'OpenCode',
    desc: '75+ open models via local CLI',
    connected: false,
    beta: true,
  },
];

const ONBOARDING_STEPS: OnboardingStepItem[] = [
  { n: 1, label: 'Welcome' },
  { n: 2, label: 'Providers' },
  { n: 3, label: 'Workspace' },
  { n: 4, label: 'First team' },
];

const TEAM_TEMPLATES: TeamTemplate[] = [
  {
    id: 'feature',
    label: 'Feature squad',
    desc: 'Lead + Dev + Reviewer + QA',
    icon: 'users',
    roles: ['lead', 'developer', 'reviewer', 'qa'],
  },
  {
    id: 'research',
    label: 'Research pod',
    desc: 'Lead + 2 Researchers + Architect',
    icon: 'sparkle',
    roles: ['lead', 'researcher', 'researcher', 'architect'],
  },
  {
    id: 'bugfix',
    label: 'Bugfix duo',
    desc: 'Lead + Debugger',
    icon: 'terminal',
    roles: ['lead', 'debugger'],
  },
  {
    id: 'blank',
    label: 'Blank team',
    desc: 'Just a lead - add your own seats',
    icon: 'plus',
    roles: ['lead'],
  },
];

export function OnboardingScreen({ onDone }: OnboardingScreenProps) {
  const [step, setStep] = useState<OnboardingStep>(1);
  const [providers, setProviders] = useState<OnboardingProvider[]>(ONBOARDING_PROVIDERS);

  const connectedCount = providers.filter((provider) => provider.connected).length;
  const minConnected = providers.some((provider) => provider.connected);

  const connect = (id: OnboardingProviderId) => {
    setProviders((current) => (
      current.map((provider) => (
        provider.id === id ? { ...provider, connected: true } : provider
      ))
    ));
  };

  return (
    <div className="onboarding">
      <div className="onb-card">
        <div className="onb-rail">
          <div className="onb-logo">T</div>
          <div className="onb-rail-steps">
            {ONBOARDING_STEPS.map((item) => (
              <div
                key={item.n}
                className={`onb-step ${step === item.n ? 'active' : ''} ${step > item.n ? 'done' : ''}`}
                onClick={() => setStep(item.n)}
              >
                <span className="onb-step-n">{step > item.n ? <Icon name="check" size={11} /> : item.n}</span>
                <span>{item.label}</span>
              </div>
            ))}
          </div>
          <div className="onb-rail-foot dim mono">v0.4.2 - alpha</div>
        </div>

        <div className="onb-main">
          {step === 1 && (
            <>
              <div className="onb-eyebrow">Welcome</div>
              <h1>Run a real dev team, in software.</h1>
              <p className="onb-lede">
                Symphony AI spawns and coordinates CLI coding agents across providers into a structured
                team. A lead delegates, specialists execute, and you stay in the loop without
                drowning in terminals.
              </p>
              <div className="onb-feature-grid">
                <div className="onb-feature">
                  <div className="onb-feature-icon"><Icon name="users" size={16} /></div>
                  <div>
                    <div className="onb-feature-h">Compose teams</div>
                    <div className="onb-feature-p">
                      Mix devs, reviewers, debuggers, and researchers. Pick any role per seat.
                    </div>
                  </div>
                </div>
                <div className="onb-feature">
                  <div className="onb-feature-icon"><Icon name="cpu" size={16} /></div>
                  <div>
                    <div className="onb-feature-h">Multi-provider</div>
                    <div className="onb-feature-p">
                      Anthropic, OpenAI Codex, OpenCode. Same workspace, same delegation graph.
                    </div>
                  </div>
                </div>
                <div className="onb-feature">
                  <div className="onb-feature-icon"><Icon name="git" size={16} /></div>
                  <div>
                    <div className="onb-feature-h">Real coordination</div>
                    <div className="onb-feature-p">
                      Lead breaks work into tasks; reviewers gate the kanban; you watch the graph.
                    </div>
                  </div>
                </div>
                <div className="onb-feature">
                  <div className="onb-feature-icon"><Icon name="terminal" size={16} /></div>
                  <div>
                    <div className="onb-feature-h">Local-first</div>
                    <div className="onb-feature-p">
                      Runs your local CLI runtimes. Your code, your auth, your machine.
                    </div>
                  </div>
                </div>
              </div>
              <div className="onb-actions">
                <button className="btn btn-primary" onClick={() => setStep(2)}>
                  Get started <Icon name="chevronRight" size={12} />
                </button>
                <button className="btn btn-ghost" onClick={onDone}>Skip onboarding</button>
              </div>
            </>
          )}

          {step === 2 && (
            <>
              <div className="onb-eyebrow">Step 2 of 4 - Providers</div>
              <h1>Connect at least one CLI runtime.</h1>
              <p className="onb-lede">
                Each provider unlocks a set of models. You can mix them inside a team, for example
                an Opus lead delegating to a GPT developer.
              </p>
              <div className="onb-providers">
                {providers.map((provider) => (
                  <div key={provider.id} className={`onb-provider ${provider.connected ? 'connected' : ''}`}>
                    <div
                      className={`provider-glyph ${provider.id}`}
                      style={{ width: 28, height: 28, borderRadius: 7 }}
                    />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div className="onb-provider-h">
                        {provider.label}
                        {provider.beta && (
                          <span className="chip" style={{ marginLeft: 6, fontSize: 9.5 }}>BETA</span>
                        )}
                        {provider.connected && (
                          <span
                            className="chip"
                            style={{
                              marginLeft: 6,
                              background: 'oklch(0.72 0.15 145 / 0.14)',
                              color: 'oklch(0.82 0.15 145)',
                              borderColor: 'oklch(0.72 0.15 145 / 0.3)',
                            }}
                          >
                            <Icon name="check" size={9} /> Connected
                          </span>
                        )}
                      </div>
                      <div className="onb-provider-p">{provider.desc}</div>
                    </div>
                    {provider.connected ? (
                      <button className="btn btn-sm btn-ghost">Manage</button>
                    ) : (
                      <button
                        className={`btn btn-sm ${provider.primary ? 'btn-primary' : ''}`}
                        onClick={() => connect(provider.id)}
                      >
                        Connect
                      </button>
                    )}
                  </div>
                ))}
              </div>
              <div className="onb-actions">
                <button className="btn btn-primary" disabled={!minConnected} onClick={() => setStep(3)}>
                  Continue {connectedCount > 0 && `(${connectedCount} connected)`}{' '}
                  <Icon name="chevronRight" size={12} />
                </button>
                <button className="btn btn-ghost" onClick={() => setStep(1)}>Back</button>
              </div>
            </>
          )}

          {step === 3 && (
            <>
              <div className="onb-eyebrow">Step 3 of 4 - Workspace</div>
              <h1>Pick where the team works.</h1>
              <p className="onb-lede">
                Symphony AI points your agents at a project directory on your machine. They read, write,
                and run code there with optional auto-approval for tools.
              </p>
              <div className="field" style={{ maxWidth: 480 }}>
                <label>Default project path</label>
                <input className="field-input mono" placeholder="~/code" defaultValue="~/code" />
                <div className="field-hint">
                  Teams default to subfolders here. You can pick any path per-team.
                </div>
              </div>
              <div className="toggle-row" style={{ maxWidth: 480, marginTop: 8 }}>
                <div className="toggle on" />
                <div className="toggle-label-block" style={{ flex: 1 }}>
                  <div className="ti">Run agents in worktrees</div>
                  <div className="sub">Isolate each agent in its own git worktree. Recommended.</div>
                </div>
              </div>
              <div className="onb-actions">
                <button className="btn btn-primary" onClick={() => setStep(4)}>
                  Continue <Icon name="chevronRight" size={12} />
                </button>
                <button className="btn btn-ghost" onClick={() => setStep(2)}>Back</button>
              </div>
            </>
          )}

          {step === 4 && (
            <>
              <div className="onb-eyebrow">Step 4 of 4 - First team</div>
              <h1>Spin up your first team.</h1>
              <p className="onb-lede">
                Start with a recommended template, or build from scratch. You can always edit roles
                later.
              </p>
              <div className="onb-templates">
                {TEAM_TEMPLATES.map((template) => (
                  <div key={template.id} className="onb-template">
                    <div className="onb-template-icon"><Icon name={template.icon} size={16} /></div>
                    <div style={{ flex: 1 }}>
                      <div className="onb-template-h">{template.label}</div>
                      <div className="onb-template-p">{template.desc}</div>
                      <div className="onb-template-roles">
                        {template.roles.map((role, index) => (
                          <span
                            key={`${role}-${index}`}
                            className="onb-role-pip"
                            style={roleStyle(role)}
                            title={ROLES[role].label}
                          />
                        ))}
                      </div>
                    </div>
                    <button className="btn btn-sm">Use</button>
                  </div>
                ))}
              </div>
              <div className="onb-actions">
                <button className="btn btn-primary" onClick={onDone}>
                  Open workspace <Icon name="chevronRight" size={12} />
                </button>
                <button className="btn btn-ghost" onClick={() => setStep(3)}>Back</button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
