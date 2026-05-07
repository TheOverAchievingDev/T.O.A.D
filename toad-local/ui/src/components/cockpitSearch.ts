export interface CockpitSearchMatch {
  relativePath: string;
  lineNumber: number;
  content: string;
}

export interface CockpitSearchRow {
  id: string;
  relativePath: string;
  lineNumber: number;
  title: string;
  snippet: string;
}

export interface CockpitSearchSummary {
  rows: CockpitSearchRow[];
  totalCount: number;
  overflowCount: number;
}

export function buildCockpitSearchSummary(
  matches: CockpitSearchMatch[],
  limit = 30,
): CockpitSearchSummary {
  const normalizedLimit = Math.max(0, limit);
  const rows = matches.slice(0, normalizedLimit).map((match) => ({
    id: `${match.relativePath}:${match.lineNumber}:${match.content}`,
    relativePath: match.relativePath,
    lineNumber: match.lineNumber,
    title: `${match.relativePath}:${match.lineNumber}`,
    snippet: compactSnippet(match.content),
  }));

  return {
    rows,
    totalCount: matches.length,
    overflowCount: Math.max(0, matches.length - rows.length),
  };
}

function compactSnippet(content: string): string {
  return content.replace(/\s+/g, ' ').trim();
}
