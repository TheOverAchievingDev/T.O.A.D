export interface CockpitFileSourceTaskLike {
  id: string;
  title: string;
  status: string;
  worktree?: {
    status?: string;
    path?: string;
    branch?: string | null;
  } | null;
}

export interface CockpitFileSourceOption {
  key: string;
  kind: 'project' | 'task';
  label: string;
  detail: string;
  taskId: string | null;
  isSelectedTask: boolean;
}

const TASK_STATUS_RANK: Record<string, number> = {
  'in-progress': 0,
  review: 1,
  testing: 2,
  planned: 3,
  ready: 4,
  todo: 5,
  blocked: 6,
  done: 7,
  rejected: 8,
};

export function buildCockpitFileSourceOptions({
  tasks,
  selectedTaskId,
  projectLabel = 'Project root',
}: {
  tasks: CockpitFileSourceTaskLike[];
  selectedTaskId: string | null;
  projectLabel?: string;
}): CockpitFileSourceOption[] {
  const taskOptions = tasks
    .filter((task) => task.worktree?.status === 'created' && Boolean(task.worktree.path))
    .map((task) => ({
      key: `task:${task.id}`,
      kind: 'task' as const,
      label: `${task.id} - ${task.title}`,
      detail: task.worktree?.branch || task.worktree?.path || 'Task worktree',
      taskId: task.id,
      isSelectedTask: task.id === selectedTaskId,
      status: task.status,
    }))
    .sort((a, b) => {
      if (a.isSelectedTask !== b.isSelectedTask) return a.isSelectedTask ? -1 : 1;
      const rankDelta = taskStatusRank(a.status) - taskStatusRank(b.status);
      if (rankDelta !== 0) return rankDelta;
      return a.label.localeCompare(b.label, undefined, { sensitivity: 'base' });
    })
    .map(({ status: _status, ...option }) => option);

  return [
    {
      key: 'project',
      kind: 'project',
      label: projectLabel,
      detail: 'Project root',
      taskId: null,
      isSelectedTask: false,
    },
    ...taskOptions,
  ];
}

export function selectedTaskWorktreeSourceKey(
  task: CockpitFileSourceTaskLike | null | undefined,
): string | null {
  if (!task?.worktree?.path || task.worktree.status !== 'created') return null;
  return `task:${task.id}`;
}

function taskStatusRank(status: string): number {
  return TASK_STATUS_RANK[status] ?? 99;
}
