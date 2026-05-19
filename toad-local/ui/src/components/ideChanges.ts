export type IdeChangeStatus = 'M' | 'A' | 'D' | 'R' | '?' | string;

export interface IdeChangeEntry {
  relativePath: string;
  status: IdeChangeStatus;
  additions: number | null;
  deletions: number | null;
  binary: boolean;
}

export interface IdeChangesResult {
  source?: unknown;
  files: IdeChangeEntry[];
  error?: string;
}

export function statusGlyph(status: IdeChangeStatus): string {
  switch (status) {
    case 'M': return 'M';
    case 'A': return 'A';
    case 'D': return 'D';
    case 'R': return 'R';
    case '?': return '?';
    default: return status ? String(status).charAt(0) : '\u2022';
  }
}

export function formatChangeCounts(entry: IdeChangeEntry): string {
  if (entry.binary) return 'bin';
  if (entry.additions === null && entry.deletions === null) return '\u2014';
  const add = entry.additions ?? 0;
  const del = entry.deletions ?? 0;
  return '+' + add + ' \u2212' + del;
}

export function summarizeChanges(files: IdeChangeEntry[] | undefined | null): number {
  return Array.isArray(files) ? files.length : 0;
}
