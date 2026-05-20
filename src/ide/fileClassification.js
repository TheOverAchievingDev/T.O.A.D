import path from 'node:path';

const LANGUAGE_BY_EXTENSION = new Map([
  ['.js', 'javascript'],
  ['.cjs', 'javascript'],
  ['.mjs', 'javascript'],
  ['.jsx', 'javascriptreact'],
  ['.ts', 'typescript'],
  ['.mts', 'typescript'],
  ['.cts', 'typescript'],
  ['.tsx', 'typescriptreact'],
  ['.json', 'json'],
  ['.jsonc', 'jsonc'],
  ['.css', 'css'],
  ['.scss', 'scss'],
  ['.sass', 'scss'],
  ['.less', 'less'],
  ['.html', 'html'],
  ['.htm', 'html'],
  ['.vue', 'html'],
  ['.svelte', 'html'],
  ['.md', 'markdown'],
  ['.markdown', 'markdown'],
  ['.mdx', 'mdx'],
  ['.py', 'python'],
  ['.go', 'go'],
  ['.rs', 'rust'],
  ['.java', 'java'],
  ['.kt', 'kotlin'],
  ['.kts', 'kotlin'],
  ['.c', 'c'],
  ['.h', 'c'],
  ['.cpp', 'cpp'],
  ['.cc', 'cpp'],
  ['.cxx', 'cpp'],
  ['.hpp', 'cpp'],
  ['.cs', 'csharp'],
  ['.php', 'php'],
  ['.rb', 'ruby'],
  ['.swift', 'swift'],
  ['.sql', 'sql'],
  ['.sh', 'shell'],
  ['.bash', 'shell'],
  ['.zsh', 'shell'],
  ['.ps1', 'powershell'],
  ['.psm1', 'powershell'],
  ['.yml', 'yaml'],
  ['.yaml', 'yaml'],
  ['.toml', 'toml'],
  ['.xml', 'xml'],
  ['.ini', 'ini'],
  ['.cfg', 'ini'],
  ['.conf', 'ini'],
  ['.txt', 'plaintext'],
  ['.log', 'plaintext'],
]);

const LANGUAGE_BY_BASENAME = new Map([
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

const UNSUPPORTED_BINARY_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.bmp',
  '.ico',
  '.avif',
  '.pdf',
  '.zip',
  '.tar',
  '.gz',
  '.tgz',
  '.rar',
  '.7z',
  '.woff',
  '.woff2',
  '.ttf',
  '.otf',
  '.eot',
  '.mp3',
  '.wav',
  '.ogg',
  '.mp4',
  '.mov',
  '.webm',
  '.exe',
  '.dll',
  '.so',
  '.dylib',
  '.bin',
]);

export function classifyFilePath(relativePath) {
  const basename = path.basename(String(relativePath || ''));
  const lowerName = basename.toLowerCase();
  const ext = path.extname(lowerName);

  if (UNSUPPORTED_BINARY_EXTENSIONS.has(ext)) {
    return metadata({
      category: 'unsupported',
      editable: false,
      binary: true,
      languageHint: null,
      reason: `${basename || 'File'} is not editable in Symphony yet.`,
    });
  }

  return metadata({
    category: 'text',
    editable: true,
    binary: false,
    languageHint: languageForName(lowerName, ext),
    reason: null,
  });
}

export function classifyReadBuffer({ relativePath, bytes, maxBytes }) {
  if (isBinaryBuffer(bytes)) {
    return metadata({
      category: 'binary',
      editable: false,
      binary: true,
      languageHint: null,
      reason: 'Binary file is not editable in Symphony.',
    });
  }

  const base = classifyFilePath(relativePath);
  if (base.category === 'unsupported') {
    return base;
  }

  const content = bytes.toString('utf8');
  if (content.includes('\uFFFD')) {
    return metadata({
      category: 'binary',
      editable: false,
      binary: true,
      languageHint: null,
      reason: 'File is not valid UTF-8 text.',
    });
  }

  if (Number.isFinite(maxBytes) && bytes.length > maxBytes) {
    return metadata({
      category: 'readonly_text',
      editable: false,
      binary: false,
      languageHint: base.languageHint || 'plaintext',
      reason: `File is too large to edit (${bytes.length} bytes).`,
    });
  }

  return metadata({
    category: 'text',
    editable: true,
    binary: false,
    languageHint: base.languageHint || 'plaintext',
    reason: null,
  });
}

export function isBinaryBuffer(bytes) {
  if (!bytes || typeof bytes.includes !== 'function') {
    return false;
  }
  if (bytes.includes(0)) {
    return true;
  }

  const sampleLength = Math.min(bytes.length, 512);
  if (sampleLength === 0) {
    return false;
  }

  let controlCount = 0;
  for (let i = 0; i < sampleLength; i += 1) {
    const byte = bytes[i];
    if (byte < 7 || (byte > 14 && byte < 32)) {
      controlCount += 1;
    }
  }
  return controlCount / sampleLength > 0.18;
}

function languageForName(lowerName, ext) {
  if (lowerName.startsWith('.env')) {
    return 'dotenv';
  }
  if (LANGUAGE_BY_BASENAME.has(lowerName)) {
    return LANGUAGE_BY_BASENAME.get(lowerName);
  }
  return LANGUAGE_BY_EXTENSION.get(ext) || 'plaintext';
}

function metadata({ category, editable, binary, languageHint, reason }) {
  return {
    category,
    editable,
    previewable: false,
    binary,
    languageHint,
    reason,
  };
}
