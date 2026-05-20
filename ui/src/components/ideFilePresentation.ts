interface IdeFileLike {
  kind?: string;
  editable?: boolean;
  content?: string;
  languageHint?: string | null;
  relativePath?: string;
}

const LANGUAGE_BY_EXTENSION = new Map<string, string>([
  ['js', 'javascript'],
  ['cjs', 'javascript'],
  ['mjs', 'javascript'],
  ['jsx', 'javascriptreact'],
  ['ts', 'typescript'],
  ['mts', 'typescript'],
  ['cts', 'typescript'],
  ['tsx', 'typescriptreact'],
  ['json', 'json'],
  ['jsonc', 'jsonc'],
  ['css', 'css'],
  ['scss', 'scss'],
  ['sass', 'scss'],
  ['less', 'less'],
  ['html', 'html'],
  ['htm', 'html'],
  ['vue', 'html'],
  ['svelte', 'html'],
  ['md', 'markdown'],
  ['markdown', 'markdown'],
  ['mdx', 'mdx'],
  ['py', 'python'],
  ['go', 'go'],
  ['rs', 'rust'],
  ['java', 'java'],
  ['kt', 'kotlin'],
  ['kts', 'kotlin'],
  ['c', 'c'],
  ['h', 'c'],
  ['cpp', 'cpp'],
  ['cc', 'cpp'],
  ['cxx', 'cpp'],
  ['hpp', 'cpp'],
  ['cs', 'csharp'],
  ['php', 'php'],
  ['rb', 'ruby'],
  ['swift', 'swift'],
  ['sql', 'sql'],
  ['sh', 'shell'],
  ['bash', 'shell'],
  ['zsh', 'shell'],
  ['ps1', 'powershell'],
  ['psm1', 'powershell'],
  ['yml', 'yaml'],
  ['yaml', 'yaml'],
  ['toml', 'toml'],
  ['xml', 'xml'],
  ['ini', 'ini'],
  ['cfg', 'ini'],
  ['conf', 'ini'],
  ['txt', 'plaintext'],
  ['log', 'plaintext'],
]);

const LANGUAGE_BY_BASENAME = new Map<string, string>([
  ['dockerfile', 'dockerfile'],
  ['makefile', 'makefile'],
  ['rakefile', 'ruby'],
  ['gemfile', 'ruby'],
  ['procfile', 'plaintext'],
  ['compose.yml', 'yaml'],
  ['compose.yaml', 'yaml'],
  ['docker-compose.yml', 'yaml'],
  ['docker-compose.yaml', 'yaml'],
  ['package-lock.json', 'json'],
  ['pnpm-lock.yaml', 'yaml'],
  ['yarn.lock', 'plaintext'],
  ['cargo.lock', 'toml'],
]);

export function languageForFile(path: string, languageHint?: string | null): string {
  if (languageHint) {
    return languageHint;
  }

  const basename = path.replace(/\\/g, '/').split('/').pop()?.toLowerCase() ?? '';
  if (basename.startsWith('.env')) {
    return 'dotenv';
  }

  const byName = LANGUAGE_BY_BASENAME.get(basename);
  if (byName) {
    return byName;
  }

  const ext = basename.includes('.') ? basename.slice(basename.lastIndexOf('.') + 1) : '';
  return LANGUAGE_BY_EXTENSION.get(ext) ?? 'plaintext';
}

export function isEditableIdeFile(
  file: IdeFileLike | null | undefined,
): file is IdeFileLike & { content: string } {
  if (!file) {
    return false;
  }
  if (file.kind === 'unsupported') {
    return false;
  }
  if (file.editable === false) {
    return false;
  }
  return typeof file.content === 'string';
}

export function unsupportedReason(file: IdeFileLike | null | undefined): string {
  const reason = (file as { reason?: unknown } | null | undefined)?.reason;
  return typeof reason === 'string' && reason.trim()
    ? reason
    : 'This file cannot be edited in Symphony yet.';
}
