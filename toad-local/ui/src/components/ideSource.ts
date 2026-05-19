export type IdeSource =
  | { kind: 'project' }
  | { kind: 'task_worktree'; taskId: string };

export interface IdeTreeEntry {
  path: string;
  name: string;
  kind: 'file' | 'directory';
  sizeBytes?: number;
  gitStatus?: string;
  category?: IdeFileCategory;
  editable?: boolean;
  previewable?: boolean;
  binary?: boolean;
  reason?: string | null;
  languageHint?: string | null;
}

export interface IdeTreeResult {
  source: IdeSource;
  rootLabel: string;
  entries: IdeTreeEntry[];
  truncated: boolean;
}

export interface IdeStatusEntry {
  relativePath: string;
  status: string;
}

export interface IdeStatusResult {
  source: IdeSource;
  entries: IdeStatusEntry[];
}

export type IdeFileCategory = 'text' | 'readonly_text' | 'binary' | 'unsupported';

export interface IdeCompatibilityMeta {
  category?: IdeFileCategory;
  editable?: boolean;
  previewable?: boolean;
  binary?: boolean;
  reason?: string | null;
}

export interface IdeTextFileResult extends IdeCompatibilityMeta {
  kind?: 'text';
  source: IdeSource;
  relativePath: string;
  content: string;
  encoding: 'utf8';
  sizeBytes: number;
  sha256: string;
  languageHint?: string | null;
  editable?: true;
}

export interface IdeUnsupportedFileResult extends IdeCompatibilityMeta {
  kind: 'unsupported';
  source: IdeSource;
  relativePath: string;
  sizeBytes: number;
  languageHint?: string | null;
  editable: false;
  reason: string;
}

export type IdeFileResult = IdeTextFileResult | IdeUnsupportedFileResult;

export function sourceKeyToIdeSource(sourceKey: string): IdeSource {
  if (sourceKey.startsWith('task:')) {
    return { kind: 'task_worktree', taskId: sourceKey.slice(5) };
  }
  return { kind: 'project' };
}

export function ideSourceToKey(source: IdeSource): string {
  return source.kind === 'task_worktree' ? `task:${source.taskId}` : 'project';
}
