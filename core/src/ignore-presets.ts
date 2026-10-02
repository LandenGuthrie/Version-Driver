// Ready-made ignore rules for common engines, IDEs and languages. A preset lives in
// .vdignore between marker comments, so it can be switched on/off later without
// touching anything the user wrote by hand.
import { readdir } from 'node:fs/promises';

export interface IgnorePreset {
  id: string;
  name: string;
  description: string;
  patterns: string[];
}

export const IGNORE_PRESETS: IgnorePreset[] = [
  {
    id: 'unity', name: 'Unity', description: 'Library, Temp, Logs, builds and generated project files',
    patterns: [
      '[Ll]ibrary/', '[Tt]emp/', '[Oo]bj/', '[Bb]uild/', '[Bb]uilds/', '[Ll]ogs/', '[Uu]ser[Ss]ettings/',
      '[Mm]emoryCaptures/', '[Rr]ecordings/', 'ExportedObj/', '.consulo/', '.gradle/', '.vs/',
      '*.csproj', '*.unityproj', '*.sln', '*.suo', '*.tmp', '*.user', '*.userprefs', '*.pidb', '*.booproj', '*.svd',
      '*.pdb', '*.mdb', '*.opendb', '*.VC.db', '*.pidb.meta', '*.pdb.meta', '*.mdb.meta',
      '/[Aa]ssets/AssetStoreTools*', 'sysinfo.txt', 'crashlytics-build.properties',
      '*.apk', '*.aab', '*.unitypackage', '*.app',
    ],
  },
  {
    id: 'unreal', name: 'Unreal Engine', description: 'Binaries, Intermediate, Saved, DerivedDataCache and IDE files',
    patterns: [
      'Binaries/', 'DerivedDataCache/', 'Intermediate/', 'Saved/', '.vs/',
      '*.VC.db', '*.VC.opendb', '*.opensdf', '*.sdf', '*.sln', '*.suo', '*.xcodeproj', '*.xcworkspace',
    ],
  },
  {
    id: 'godot', name: 'Godot', description: 'Imported assets cache and export settings',
    patterns: ['.godot/', '.import/', '.mono/', 'data_*/', '*.translation', 'export.cfg', 'export_presets.cfg', 'mono_crash.*.json'],
  },
  {
    id: 'visualstudio', name: 'Visual Studio', description: 'bin, obj, .vs, user files and build output',
    patterns: [
      '.vs/', '[Bb]in/', '[Oo]bj/', '[Dd]ebug/', '[Rr]elease/', 'x64/', 'x86/', '[Ll]og/', '[Ll]ogs/',
      '*.suo', '*.user', '*.userosscache', '*.sln.docstates', '*.userprefs', '*.pdb', '*.ilk', '*.obj', '*.pch',
      '*.tlog', '*.vspscc', '*.nupkg', 'packages/', 'ipch/', '*.aps', '*.ncb', '*.opendb', '*.opensdf', '*.sdf',
      '*.cachefile', '*.VC.db', '*.VC.VC.opendb', '_ReSharper*/', '*.[Rr]e[Ss]harper', '*.DotSettings.user',
      'TestResults/', '[Tt]est[Rr]esult*/', '*.coverage', 'BenchmarkDotNet.Artifacts/',
    ],
  },
  {
    id: 'rider', name: 'JetBrains Rider / IDEA', description: '.idea folder and IDE module files',
    patterns: ['.idea/', '.idea.*/', '.idea_modules/', '*.iml', '*.iws', '*.ipr', '*.sln.iml', 'cmake-build-*/', '.fleet/', 'fabric.properties'],
  },
  {
    id: 'vscode', name: 'VS Code / Cursor', description: 'Editor state; keeps shared settings, tasks and launch configs',
    patterns: [
      '.vscode/*', '!.vscode/settings.json', '!.vscode/tasks.json', '!.vscode/launch.json', '!.vscode/extensions.json',
      '.cursor/', '.cursorindexingignore', '.history/', '*.vsix',
    ],
  },
  {
    id: 'android', name: 'Android Studio', description: 'Gradle caches, local.properties and build output',
    patterns: ['.gradle/', 'build/', 'local.properties', '.idea/', '*.iml', 'captures/', '.cxx/', '.externalNativeBuild/', '*.apk', '*.aab', '*.ap_'],
  },
  {
    id: 'xcode', name: 'Xcode', description: 'DerivedData, user state and build output',
    patterns: ['xcuserdata/', 'DerivedData/', '*.xcuserstate', '*.moved-aside', '.build/', 'build/', '*.hmap', '*.ipa', '*.dSYM.zip', '*.dSYM'],
  },
  {
    id: 'node', name: 'Node.js / Web', description: 'node_modules, build output, logs and .env files',
    patterns: ['node_modules/', 'dist/', 'build/', 'out/', '.next/', '.nuxt/', '.cache/', '.parcel-cache/', 'coverage/', '*.log', '.env', '.env.*', '!.env.example'],
  },
  {
    id: 'python', name: 'Python', description: 'Bytecode, virtual environments and packaging output',
    patterns: ['__pycache__/', '*.py[cod]', '.venv/', 'venv/', 'env/', '.pytest_cache/', '.mypy_cache/', '*.egg-info/', 'dist/', 'build/', '.ipynb_checkpoints/'],
  },
  {
    id: 'blender', name: 'Blender', description: 'Autosave backups (.blend1, .blend2)',
    patterns: ['*.blend1', '*.blend2', '*.blend@', '__pycache__/'],
  },
  {
    id: 'ableton', name: 'Ableton Live', description: 'Backups and audio analysis files',
    patterns: ['Backup/', '*.asd'],
  },
  {
    id: 'os', name: 'Operating system files', description: 'macOS and Windows junk like .DS_Store and Thumbs.db',
    patterns: ['.DS_Store', '.AppleDouble', '.LSOverride', '._*', '.Spotlight-V100', '.Trashes', 'Thumbs.db', 'ehthumbs.db', 'Desktop.ini', '$RECYCLE.BIN/'],
  },
];

const byId = new Map(IGNORE_PRESETS.map((p) => [p.id, p]));
const START = (id: string) => `# >>> vd-preset:${id}`;
const END = (id: string) => `# <<< vd-preset:${id}`;

/** Which presets are currently switched on in this .vdignore text. */
export function appliedPresets(text: string): string[] {
  return [...text.matchAll(/^# >>> vd-preset:([\w-]+)/gm)].map((m) => m[1]!).filter((id) => byId.has(id));
}

/** Switch a preset on (adds its block) or off (removes it). Everything else in the file is left alone. */
export function setPreset(text: string, id: string, on: boolean): string {
  const preset = byId.get(id);
  if (!preset) throw new Error(`Unknown ignore preset: ${id}`);
  const block = new RegExp(`(^|\\n)${START(id).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${END(id).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\r?\\n?`, 'g');
  const cleaned = text.replace(block, '$1').replace(/\n{3,}/g, '\n\n');
  if (!on) return cleaned.replace(/\s+$/, '') + '\n';
  const body = `${START(id)}  (${preset.name})\n${preset.patterns.join('\n')}\n${END(id)}\n`;
  return cleaned.replace(/\s+$/, '') + '\n\n' + body;
}

/** Append one rule (e.g. "*.wav" or "Renders/") unless it is already there. */
export function addPattern(text: string, pattern: string): string {
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  if (lines.includes(pattern.trim())) return text;
  return text.replace(/\s+$/, '') + `\n${pattern.trim()}\n`;
}

/** Guess which presets suit a project folder from the files in its top level. */
export async function detectPresets(dir: string): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const has = (re: RegExp) => names.some((n) => re.test(n));
  const found: string[] = [];
  if (names.includes('ProjectSettings') && names.includes('Assets')) found.push('unity');
  if (has(/\.uproject$/i)) found.push('unreal');
  if (names.includes('project.godot')) found.push('godot');
  if (has(/\.(sln|csproj|vcxproj)$/i)) found.push('visualstudio');
  if (names.includes('.idea') || has(/\.sln\.iml$/i)) found.push('rider');
  if (names.includes('.vscode') || names.includes('.cursor')) found.push('vscode');
  if (names.includes('gradlew') || names.includes('build.gradle') || names.includes('build.gradle.kts')) found.push('android');
  if (has(/\.xcodeproj$/i) || has(/\.xcworkspace$/i)) found.push('xcode');
  if (names.includes('package.json')) found.push('node');
  if (has(/^(pyproject\.toml|requirements\.txt|setup\.py)$/)) found.push('python');
  if (has(/\.blend$/i)) found.push('blender');
  if (has(/\.als$/i)) found.push('ableton');
  found.push('os');
  return found;
}
