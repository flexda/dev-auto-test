import { spawn } from 'node:child_process';
import { lstat, mkdir, readdir, readFile, realpath } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';

export function parseRepository(input: string): { owner: string; repo: string; url: string } {
  // Validate raw spelling first. URL parsers normalize dot segments and backslashes.
  const match = /^https:\/\/github\.com\/([^/?#\s\\]+)\/([^/?#\s\\]+)\/?$/.exec(input.trim());
  if (!match) {
    throw new Error('https://github.com/소유자/저장소 형식의 주소만 연결할 수 있습니다.');
  }
  const owner = match[1];
  const repo = match[2].replace(/\.git$/, '');
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(owner) || !/^[A-Za-z0-9_.-]{1,100}$/.test(repo) || repo === '.' || repo === '..') {
    throw new Error('GitHub 소유자 또는 저장소 이름이 올바르지 않습니다.');
  }
  return { owner, repo, url: `https://github.com/${owner}/${repo}.git` };
}

function redact(value: string): string {
  let text = value;
  for (const name of ['GITHUB_TOKEN', 'OPENAI_API_KEY', 'AI_GATEWAY_API_KEY', 'VERCEL_TOKEN', 'ANTHROPIC_API_KEY']) {
    const secret = process.env[name];
    if (secret) {
      text = text.split(secret).join('[REDACTED]');
      if (name === 'GITHUB_TOKEN') text = text.split(Buffer.from(`x-access-token:${secret}`).toString('base64')).join('[REDACTED]');
    }
  }
  return text.replace(/(?:github_pat_|gh[pousr]_)[A-Za-z0-9_]{16,}/g, '[REDACTED]')
    .replace(/((?:api[_-]?key|access[_-]?token|password|secret)\s*[:=]\s*)['"][^'"\n]{8,}['"]/gi, '$1"[REDACTED]"');
}

function gitEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '/usr/bin/false',
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  // Ignore host Git configuration, hooks, helpers, and external protocols.
  const config: [string, string][] = [['core.hooksPath', '/dev/null'], ['credential.helper', ''],
    ['protocol.file.allow', 'never'], ['protocol.ext.allow', 'never'], ['core.autocrlf', 'false']];
  if (process.env.GITHUB_TOKEN) config.push(['http.https://github.com/.extraheader', `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${process.env.GITHUB_TOKEN}`).toString('base64')}`]);
  env.GIT_CONFIG_COUNT = String(config.length);
  config.forEach(([key, value], index) => { env[`GIT_CONFIG_KEY_${index}`] = key; env[`GIT_CONFIG_VALUE_${index}`] = value; });
  return env;
}

async function git(args: string[], signal: AbortSignal): Promise<string> {
  if (signal.aborted) throw new Error('작업이 취소되었습니다.');
  return new Promise((resolveResult, reject) => {
    const child = spawn('git', args, { env: gitEnvironment(), stdio: ['ignore', 'pipe', 'pipe'], shell: false, detached: process.platform !== 'win32' });
    let stdout = '', stderr = '', timedOut = false;
    const stop = () => {
      // Git's HTTPS helper must stop too, rather than continuing after cancellation.
      if (process.platform !== 'win32' && child.pid) {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
      } else child.kill('SIGKILL');
    };
    const timeout = setTimeout(() => { timedOut = true; stop(); }, 90_000);
    const abort = () => stop();
    signal.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', (chunk: Buffer) => { stdout = (stdout + chunk.toString()).slice(0, 100_000); });
    child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(0, 20_000); });
    const cleanup = () => { clearTimeout(timeout); signal.removeEventListener('abort', abort); };
    child.once('error', (error) => { cleanup(); reject(new Error(`Git 실행에 실패했습니다: ${redact(error.message)}`)); });
    child.once('close', (code) => {
      cleanup();
      if (signal.aborted) reject(new Error('작업이 취소되었습니다.'));
      else if (timedOut) reject(new Error('GitHub 저장소 연결 시간이 초과되었습니다.'));
      else if (code !== 0) reject(new Error(`GitHub 저장소 연결에 실패했습니다. 주소와 접근 권한을 확인하세요. ${redact(stderr).slice(0, 2_000)}`));
      else resolveResult(redact(stdout));
    });
  });
}

const excludedDirectories = new Set(['.git', 'node_modules', '.next', '.eve', '.vercel', 'dist', 'build', 'coverage', 'out', 'vendor', '.cache', '.venv', '__pycache__']);
const sourceExtensions = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.md', '.mdx', '.css', '.scss', '.html', '.yaml', '.yml', '.py', '.go', '.rs', '.sql', '.sh']);
function sensitiveName(name: string): boolean {
  return /^\.env(?:\.|$)/i.test(name) || /(?:^|[._-])(?:credentials?|secrets?)(?:[._-]|$)/i.test(name)
    || /\.(?:pem|key|p12|pfx|keystore)$/i.test(name) || /^(?:id_rsa|id_ed25519|\.npmrc|\.yarnrc.*|\.pypirc|\.netrc)$/i.test(name);
}

export async function prepareRepository(
  url: string, branch: string, workspace: string, signal: AbortSignal,
): Promise<{ context: string; baseCommit: string; scripts: string[] }> {
  const repository = parseRepository(url);
  if (branch && (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(branch) || branch.includes('..') || branch.includes('//') || branch.endsWith('/') || branch.endsWith('.') || /(?:^|\/)\.|\.lock(?:\/|$)/.test(branch))) {
    throw new Error('브랜치 이름이 올바르지 않습니다.');
  }
  if (!isAbsolute(workspace) || basename(workspace) === '.' || basename(workspace) === '..') throw new Error('새 작업 폴더의 절대 경로가 필요합니다.');
  const destination = resolve(workspace);
  await mkdir(dirname(destination), { recursive: true });
  try {
    const stat = await lstat(destination);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (await readdir(destination)).length) throw new Error('저장소 복제에는 비어 있는 새 작업 폴더가 필요합니다.');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const args = ['clone', '--depth=1', '--single-branch', '--no-tags'];
  if (branch) args.push('--branch', branch);
  args.push('--', repository.url, destination);
  await git(args, signal);
  const root = await realpath(destination);
  const baseCommit = (await git(['-C', root, 'rev-parse', '--verify', 'HEAD'], signal)).trim();
  const files: { path: string; fullPath: string; size: number }[] = [];
  let examined = 0;
  async function inspect(directory: string): Promise<void> {
    const entries = (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (signal.aborted) throw new Error('작업이 취소되었습니다.');
      if (++examined > 30_000) throw new Error('저장소 파일 수가 분석 한도를 초과했습니다.');
      const fullPath = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        let target: string;
        try { target = await realpath(fullPath); } catch { throw new Error('저장소에 연결 대상이 없는 심볼릭 링크가 있습니다.'); }
        const offset = relative(root, target);
        if (offset === '..' || offset.startsWith('../') || isAbsolute(offset)) throw new Error('저장소 밖을 가리키는 심볼릭 링크는 허용되지 않습니다.');
        continue;
      }
      if (entry.isDirectory()) {
        if (!excludedDirectories.has(entry.name) && !sensitiveName(entry.name)) await inspect(fullPath);
      } else if (entry.isFile() && !sensitiveName(entry.name) && sourceExtensions.has(extname(entry.name))) {
        const stat = await lstat(fullPath);
        if (stat.size <= 80_000 && !/^(?:package-lock|yarn-lock|pnpm-lock)\./.test(entry.name)) files.push({ path: relative(root, fullPath), fullPath, size: stat.size });
      }
    }
  }
  await inspect(root);
  let scripts: string[] = [];
  try {
    const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as { scripts?: Record<string, unknown> };
    scripts = ['test', 'build', 'lint', 'typecheck'].filter((name) => typeof packageJson.scripts?.[name] === 'string');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('package.json을 읽을 수 없습니다. 올바른 JSON인지 확인하세요.');
  }
  files.sort((a, b) => {
    const priority = (name: string) => /^(?:README\.md|AGENTS\.md|package\.json|tsconfig\.json)$/i.test(name) ? 0 : 1;
    return priority(a.path) - priority(b.path) || a.path.localeCompare(b.path);
  });
  const context: string[] = [`Repository: ${repository.owner}/${repository.repo}\nBase commit: ${baseCommit}\nChecks: ${scripts.join(', ') || 'none'}\nFiles (bounded):\n${files.slice(0, 400).map((file) => file.path).join('\n')}`];
  let remaining = 120_000;
  for (const file of files.slice(0, 100)) {
    if (remaining <= 0) break;
    const contents = await readFile(file.fullPath, 'utf8');
    if (contents.includes('\u0000')) continue;
    const text = redact(contents).slice(0, Math.min(16_000, remaining));
    context.push(`\n--- FILE ${file.path} ---\n${text}${text.length < contents.length ? '\n[truncated]' : ''}`);
    remaining -= text.length;
  }
  return { context: context.join('\n'), baseCommit, scripts };
}
