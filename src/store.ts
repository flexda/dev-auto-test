import { mkdir, readFile, writeFile, rename, readdir, lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { stageLabels, type Run } from './types.js';

export const dataRoot = path.resolve(process.env.AUTOFORGE_DATA_DIR || '.autoforge');
export const runRoot = (id: string) => path.join(dataRoot, 'runs', validId(id));
export const workspace = (id: string) => path.join(runRoot(id), 'workspace');
export function validId(id: string) { if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('잘못된 실행 ID입니다.'); return id; }
export async function initStore() { await mkdir(path.join(dataRoot, 'runs'), { recursive: true }); }
const writes = new Map<string, Promise<void>>();
export async function saveRun(run: Run) {
  run.updatedAt = new Date().toISOString();
  const snapshot = JSON.stringify(run, null, 2);
  const next = (writes.get(run.id) || Promise.resolve()).catch(() => {}).then(async () => {
    await mkdir(runRoot(run.id), { recursive: true });
    const temp = path.join(runRoot(run.id), `state-${randomUUID()}.tmp`);
    await writeFile(temp, snapshot, { mode: 0o600 });
    await rename(temp, path.join(runRoot(run.id), 'state.json'));
  });
  writes.set(run.id, next);
  try { await next; } finally { if (writes.get(run.id) === next) writes.delete(run.id); }
}
export async function getRun(id: string): Promise<Run> { return JSON.parse(await readFile(path.join(runRoot(id), 'state.json'), 'utf8')); }
export async function listRuns(): Promise<Run[]> {
  await initStore();
  const names = await readdir(path.join(dataRoot, 'runs'));
  const results = await Promise.allSettled(names.filter(n => /^[a-f0-9-]{36}$/.test(n)).map(getRun));
  return results.flatMap(r => r.status === 'fulfilled' ? [r.value] : []).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
export function newRun(input: { prompt: string; title?: string; mode: 'demo' | 'ai'; repository: string; branch: string; maxRepairs: number; deploymentTarget: 'local' | 'vercel' }): Run {
  const now = new Date().toISOString();
  return { ...input, id: randomUUID(), title: input.title || (input.mode === 'demo' ? '가격 계산기 · 자동 수정 예제' : input.prompt.slice(0, 48)), status: 'queued', stage: 'requirements', createdAt: now, updatedAt: now, repairCount: 0,
    stages: Object.entries(stageLabels).map(([id, label]) => ({ id: id as keyof typeof stageLabels, label, status: 'pending', attempts: 0, summary: '' })), events: [], files: [], documents: {}, checks: [] };
}
export function safeRelative(input: string) {
  if (!input || input.includes('\\') || input.includes('\0') || input.startsWith('/') || input.split('/').some(p => p === '..' || p === '.' || p === '')) throw new Error('안전하지 않은 파일 경로입니다.');
  if (input.split('/').some(p => p === '.git' || p === 'node_modules' || p === '.autoforge' || p.startsWith('.env') || /^(id_rsa|id_ed25519|\.npmrc|\.yarnrc.*|\.pypirc|\.netrc)$/i.test(p) || /(?:^|[._-])(?:credentials?|secrets?)(?:[._-]|$)/i.test(p) || /\.(pem|key|p12|pfx|keystore)$/i.test(p))) throw new Error('보호된 파일에는 접근할 수 없습니다.');
  return input;
}
export async function safePath(root: string, relative: string) {
  safeRelative(relative);
  const base = await realpath(root);
  let cursor = root;
  for (const part of relative.split('/')) {
    cursor = path.join(cursor, part);
    try { const st = await lstat(cursor); if (st.isSymbolicLink()) throw new Error('심볼릭 링크에는 접근할 수 없습니다.'); }
    catch (error: any) { if (error.code !== 'ENOENT') throw error; }
  }
  const result = path.resolve(base, relative);
  if (!result.startsWith(base + path.sep)) throw new Error('작업 공간 밖의 경로입니다.');
  return result;
}
export async function writeProjectFile(id: string, relative: string, content: string) {
  if (Buffer.byteLength(content) > 256_000) throw new Error('파일당 256KB 한도를 초과했습니다.');
  const destination = await safePath(workspace(id), relative);
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, content);
}
export async function artifact(run: Run, name: string, content: string) {
  await mkdir(workspace(run.id), { recursive: true });
  const relative = `autoforge-artifacts/${name}`;
  if (Buffer.byteLength(content) > 4_000_000) throw new Error('실행 기록 파일이 4MB 한도를 초과했습니다.');
  const destination = await safePath(workspace(run.id), relative);
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, content);
  if (!run.files.includes(relative)) run.files.push(relative);
}
