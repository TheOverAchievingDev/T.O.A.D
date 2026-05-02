import type { RoleId, RoleMeta } from '@/types';

export const ROLES: Record<RoleId, RoleMeta> = {
  lead: { label: 'Team Lead', short: 'Lead', var: '--role-lead', bg: '--role-lead-bg' },
  developer: { label: 'Developer', short: 'Developer', var: '--role-developer', bg: '--role-developer-bg' },
  reviewer: { label: 'Reviewer', short: 'Reviewer', var: '--role-reviewer', bg: '--role-reviewer-bg' },
  researcher: { label: 'Researcher', short: 'Researcher', var: '--role-researcher', bg: '--role-researcher-bg' },
  debugger: { label: 'Debugger', short: 'Debugger', var: '--role-debugger', bg: '--role-debugger-bg' },
  qa: { label: 'QA / Tester', short: 'QA', var: '--role-qa', bg: '--role-qa-bg' },
  architect: { label: 'Architect', short: 'Architect', var: '--role-architect', bg: '--role-architect-bg' },
  designer: { label: 'Designer', short: 'Designer', var: '--role-designer', bg: '--role-designer-bg' },
};

export const ROLE_KEYS: RoleId[] = Object.keys(ROLES) as RoleId[];

export function roleStyle(role: RoleId): React.CSSProperties {
  const r = ROLES[role] ?? ROLES.developer;
  return {
    ['--accent' as any]: `var(${r.var})`,
    ['--accent-bg' as any]: `var(${r.bg})`,
  };
}
