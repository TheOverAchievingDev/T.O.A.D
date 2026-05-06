export type CockpitTaskStatus = 'todo' | 'in-progress' | 'review' | 'blocked' | 'done' | 'rejected';

export interface CockpitTaskLike {
  id: string;
  status: CockpitTaskStatus;
}

export interface CockpitTaskGroup<T extends CockpitTaskLike> {
  status: CockpitTaskStatus;
  label: string;
  count: number;
  tasks: T[];
}

const BOARD_STATUSES: Array<{ status: CockpitTaskStatus; label: string }> = [
  { status: 'todo', label: 'Ready' },
  { status: 'in-progress', label: 'In progress' },
  { status: 'review', label: 'Review' },
  { status: 'blocked', label: 'Blocked' },
];

export function buildCockpitTaskGroups<T extends CockpitTaskLike>(tasks: T[]): CockpitTaskGroup<T>[] {
  return BOARD_STATUSES.map(({ status, label }) => {
    const groupTasks = tasks.filter((task) => task.status === status);
    return {
      status,
      label,
      count: groupTasks.length,
      tasks: groupTasks,
    };
  });
}
