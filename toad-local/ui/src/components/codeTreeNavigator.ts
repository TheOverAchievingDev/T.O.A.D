export interface CodeTreeEntry {
  path: string;
  name: string;
  kind: 'file' | 'directory';
  sizeBytes?: number;
  gitStatus?: string;
  category?: 'text' | 'readonly_text' | 'binary' | 'unsupported';
  editable?: boolean;
  previewable?: boolean;
  binary?: boolean;
  reason?: string | null;
  languageHint?: string | null;
}

export interface CodeTreeNode {
  path: string;
  name: string;
  kind: 'file' | 'directory';
  sizeBytes?: number;
  children: CodeTreeNode[];
  depth: number;
  gitStatus?: string;
  category?: 'text' | 'readonly_text' | 'binary' | 'unsupported';
  editable?: boolean;
  previewable?: boolean;
  binary?: boolean;
  reason?: string | null;
  languageHint?: string | null;
}

export interface CodeTreeFilterResult {
  nodes: CodeTreeNode[];
  expandedPaths: string[];
}

export function buildCodeTree(entries: CodeTreeEntry[]): CodeTreeNode[] {
  const nodeByPath = new Map<string, CodeTreeNode>();
  const rootNodes: CodeTreeNode[] = [];

  for (const entry of entries) {
    ensureNode(entry);
  }

  for (const node of nodeByPath.values()) {
    const parentPath = parentOf(node.path);
    if (!parentPath) {
      rootNodes.push(node);
      continue;
    }
    const parent = nodeByPath.get(parentPath) ?? ensureNode({ path: parentPath, kind: 'directory', name: basename(parentPath) });
    if (!parent.children.some((child) => child.path === node.path)) {
      parent.children.push(node);
    }
  }

  assignDepthAndSort(rootNodes, 0);
  return rootNodes;

  function ensureNode(entry: CodeTreeEntry): CodeTreeNode {
    const normalizedPath = normalizeTreePath(entry.path);
    const existing = nodeByPath.get(normalizedPath);
    if (existing) {
      if (entry.kind === 'directory' && existing.kind !== 'directory') existing.kind = 'directory';
      applyMetadata(existing, entry);
      return existing;
    }
    const node: CodeTreeNode = {
      path: normalizedPath,
      name: entry.name || basename(normalizedPath),
      kind: entry.kind,
      children: [],
      depth: 0,
    };
    applyMetadata(node, entry);
    nodeByPath.set(normalizedPath, node);

    const parentPath = parentOf(normalizedPath);
    if (parentPath && !nodeByPath.has(parentPath)) {
      ensureNode({ path: parentPath, kind: 'directory', name: basename(parentPath) });
    }
    return node;
  }
}

function applyMetadata(node: CodeTreeNode, entry: CodeTreeEntry): void {
  if (entry.sizeBytes !== undefined) node.sizeBytes = entry.sizeBytes;
  if (entry.gitStatus !== undefined) node.gitStatus = entry.gitStatus;
  if (entry.category !== undefined) node.category = entry.category;
  if (entry.editable !== undefined) node.editable = entry.editable;
  if (entry.previewable !== undefined) node.previewable = entry.previewable;
  if (entry.binary !== undefined) node.binary = entry.binary;
  if (entry.reason !== undefined) node.reason = entry.reason;
  if (entry.languageHint !== undefined) node.languageHint = entry.languageHint;
}

export function flattenVisibleCodeTree(nodes: CodeTreeNode[], expandedPaths: ReadonlySet<string>): CodeTreeNode[] {
  const visible: CodeTreeNode[] = [];
  for (const node of nodes) {
    visible.push(node);
    if (node.kind === 'directory' && expandedPaths.has(node.path)) {
      visible.push(...flattenVisibleCodeTree(node.children, expandedPaths));
    }
  }
  return visible;
}

export function filterCodeTree(nodes: CodeTreeNode[], query: string): CodeTreeFilterResult {
  const normalizedQuery = normalizeSearch(query);
  if (!normalizedQuery) {
    return { nodes, expandedPaths: [] };
  }

  const expandedPaths = new Set<string>();
  const filtered = filterNodes(nodes, normalizedQuery, [], expandedPaths);
  return {
    nodes: filtered,
    expandedPaths: Array.from(expandedPaths).sort((a, b) => a.localeCompare(b)),
  };
}

export function collectDirectoryPaths(nodes: CodeTreeNode[]): string[] {
  const paths: string[] = [];
  for (const node of nodes) {
    if (node.kind === 'directory') {
      paths.push(node.path, ...collectDirectoryPaths(node.children));
    }
  }
  return paths;
}

function filterNodes(
  nodes: CodeTreeNode[],
  query: string,
  ancestors: CodeTreeNode[],
  expandedPaths: Set<string>,
): CodeTreeNode[] {
  const matches: CodeTreeNode[] = [];
  for (const node of nodes) {
    const childMatches = filterNodes(node.children, query, [...ancestors, node], expandedPaths);
    const selfMatches = nodeMatches(node, query);
    if (!selfMatches && childMatches.length === 0) continue;

    if (childMatches.length > 0) {
      expandedPaths.add(node.path);
    }
    for (const ancestor of ancestors) {
      if (ancestor.kind === 'directory') expandedPaths.add(ancestor.path);
    }
    matches.push({
      ...node,
      children: childMatches,
    });
  }
  return matches;
}

function assignDepthAndSort(nodes: CodeTreeNode[], depth: number): void {
  nodes.sort(compareNodes);
  for (const node of nodes) {
    node.depth = depth;
    assignDepthAndSort(node.children, depth + 1);
  }
}

function compareNodes(a: CodeTreeNode, b: CodeTreeNode): number {
  if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1;
  return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
}

function nodeMatches(node: CodeTreeNode, query: string): boolean {
  return normalizeSearch(node.path).includes(query) || normalizeSearch(node.name).includes(query);
}

function normalizeSearch(value: string): string {
  return value.trim().toLowerCase().replace(/[\s_-]+/g, '');
}

function normalizeTreePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
}

function parentOf(value: string): string | null {
  const normalized = normalizeTreePath(value);
  const index = normalized.lastIndexOf('/');
  return index > 0 ? normalized.slice(0, index) : null;
}

function basename(value: string): string {
  const normalized = normalizeTreePath(value);
  return normalized.slice(normalized.lastIndexOf('/') + 1);
}
