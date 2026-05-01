import { TeamTaskReader } from '../../TeamTaskReader';
import { TeamTranscriptSourceLocator } from '../discovery/TeamTranscriptSourceLocator';

import { BoardTaskActivityRecordBuilder } from './BoardTaskActivityRecordBuilder';
import { BoardTaskActivityTranscriptReader } from './BoardTaskActivityTranscriptReader';

import type { BoardTaskActivityRecord } from './BoardTaskActivityRecord';
import type { TeamTask } from '@shared/types';

const TASK_ACTIVITY_INDEX_CACHE_TTL_MS = 1_000;

interface TaskActivityIndex {
  expiresAt: number;
  tasksById: Map<string, TeamTask>;
  recordsByTaskId: Map<string, BoardTaskActivityRecord[]>;
}

export class BoardTaskActivityRecordSource {
  private readonly indexCache = new Map<string, TaskActivityIndex>();
  private readonly indexInFlight = new Map<string, Promise<TaskActivityIndex>>();

  constructor(
    private readonly transcriptSourceLocator: TeamTranscriptSourceLocator = new TeamTranscriptSourceLocator(),
    private readonly taskReader: TeamTaskReader = new TeamTaskReader(),
    private readonly transcriptReader: BoardTaskActivityTranscriptReader = new BoardTaskActivityTranscriptReader(),
    private readonly recordBuilder: Pick<
      BoardTaskActivityRecordBuilder,
      'buildForTasks'
    > = new BoardTaskActivityRecordBuilder()
  ) {}

  async getTaskRecords(teamName: string, taskId: string): Promise<BoardTaskActivityRecord[]> {
    const index = await this.getTaskActivityIndex(teamName);
    if (!index.tasksById.has(taskId)) {
      return [];
    }
    return [...(index.recordsByTaskId.get(taskId) ?? [])];
  }

  private async getTaskActivityIndex(teamName: string): Promise<TaskActivityIndex> {
    const cached = this.indexCache.get(teamName);
    if (cached && cached.expiresAt > Date.now()) {
      return cached;
    }

    const existingPromise = this.indexInFlight.get(teamName);
    if (existingPromise) {
      return await existingPromise;
    }

    const promise = this.buildTaskActivityIndex(teamName)
      .then((index) => {
        this.indexCache.set(teamName, index);
        return index;
      })
      .finally(() => {
        this.indexInFlight.delete(teamName);
      });
    this.indexInFlight.set(teamName, promise);
    return await promise;
  }

  private async buildTaskActivityIndex(teamName: string): Promise<TaskActivityIndex> {
    const [activeTasks, deletedTasks, transcriptFiles] = await Promise.all([
      this.taskReader.getTasks(teamName),
      this.taskReader.getDeletedTasks(teamName),
      this.transcriptSourceLocator.listTranscriptFiles(teamName),
    ]);

    const tasks = [...activeTasks, ...deletedTasks];
    const tasksById = new Map(tasks.map((task) => [task.id, task] as const));
    if (tasks.length === 0 || transcriptFiles.length === 0) {
      return {
        expiresAt: Date.now() + TASK_ACTIVITY_INDEX_CACHE_TTL_MS,
        tasksById,
        recordsByTaskId: new Map(),
      };
    }

    const messages = await this.transcriptReader.readFiles(transcriptFiles);
    const recordsByTaskId = this.recordBuilder.buildForTasks({
      teamName,
      tasks,
      messages,
    });
    return {
      expiresAt: Date.now() + TASK_ACTIVITY_INDEX_CACHE_TTL_MS,
      tasksById,
      recordsByTaskId,
    };
  }
}
