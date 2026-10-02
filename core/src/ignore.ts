// Minimal gitignore-style matcher for .vdignore.

export const DEFAULT_IGNORE = `# Version Driver ignore file (gitignore syntax)
node_modules/
.DS_Store
Thumbs.db
desktop.ini
*.tmp
*.swp
`;

interface Rule {
  re: RegExp;
  negate: boolean;
  dirOnly: boolean;
}

function toRegex(pattern: string): RegExp {
  let p = pattern;
  const anchored = p.startsWith('/') || p.slice(0, -1).includes('/');
  p = p.replace(/^\//, '');
  let re = '';
  for (let i = 0; i < p.length; i++) {
    const c = p[i]!;
    if (c === '*') {
      if (p[i + 1] === '*') {
        i++;
        if (p[i + 1] === '/') {
          i++;
          re += '(?:.*/)?';
        } else re += '.*';
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if (c === '[') {
      // character class such as [Ll], [0-9] or [!x]
      const close = p.indexOf(']', i + 2);
      if (close > 0) {
        const cls = p.slice(i + 1, close);
        re += `[${cls.startsWith('!') ? '^' + cls.slice(1) : cls}]`;
        i = close;
      } else re += '\\[';
    } else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${anchored ? '' : '(?:.*/)?'}${re}$`);
}

export class Ignore {
  private rules: Rule[] = [];

  constructor(text = DEFAULT_IGNORE) {
    for (const raw of text.split(/\r?\n/)) {
      let line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const negate = line.startsWith('!');
      if (negate) line = line.slice(1);
      const dirOnly = line.endsWith('/');
      if (dirOnly) line = line.slice(0, -1);
      this.rules.push({ re: toRegex(line), negate, dirOnly });
    }
  }

  /** `path` is repo-relative with forward slashes. */
  ignores(path: string, isDir: boolean): boolean {
    if (path === '.vdriver' || path.startsWith('.vdriver/') || path === '.git' || path.startsWith('.git/')) return true;
    let ignored = false;
    for (const r of this.rules) {
      if (r.dirOnly && !isDir) continue;
      if (r.re.test(path)) ignored = !r.negate;
    }
    return ignored;
  }
}
