import { constants } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';
import type { Run } from './types.js';
import { workspace, safePath, saveRun } from './store.js';

const MAX_FILES = 500;
const MAX_FILE_BYTES = 2_000_000;
const MAX_TOTAL_BYTES = 2_500_000;
const MAX_DIRECTORIES = 500;
const OUTPUT_DIRS = new Set(['dist', 'out', 'build', 'public']);
const STATIC_EXTENSIONS = new Set(['.html', '.htm', '.css', '.js', '.mjs', '.json', '.txt', '.xml', '.webmanifest', '.svg', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.ico', '.woff', '.woff2', '.ttf', '.otf', '.mp3', '.mp4', '.ogg', '.wav', '.pdf']);

type StaticFile = { file: string; data: Buffer };
type RemoteDeployment = { id?: string; url?: string; readyState?: string; target?: string | null; projectId?: string; errorMessage?: string; errorCode?: string };

export class DeploymentBlockedError extends Error {
  readonly code = 'DEPLOYMENT_BLOCKED';
  constructor(message: string) { super(message); this.name = 'DeploymentBlockedError'; }
}

function assertActive(signal: AbortSignal) { signal.throwIfAborted(); }

function rejectSecrets(file: string, data: Buffer) {
  // Also check credential values known to the trusted runtime, without including them in errors.
  const text = data.toString('utf8');
  const knownSecrets = Object.entries(process.env)
    .filter(([key, value]) => /(?:TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY)$/.test(key) && value && value.length >= 12)
    .map(([, value]) => value!);
  if (knownSecrets.some(secret => text.includes(secret)) || /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----|\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|\bgh[pousr]_[A-Za-z0-9]{30,}\b|\bgithub_pat_[A-Za-z0-9_]{30,}\b|\bxox[baprs]-[A-Za-z0-9-]{20,}\b|\bsk-(?:proj-)?[A-Za-z0-9_-]{24,}\b/i.test(text)) {
    throw new DeploymentBlockedError(`배포 파일 ${file}에서 인증정보로 보이는 내용이 발견되었습니다. 제거한 뒤 다시 실행하세요.`);
  }
}

async function staticFiles(run: Run, signal: AbortSignal): Promise<StaticFile[]> {
  if (!run.outputDir || !OUTPUT_DIRS.has(run.outputDir)) {
    throw new DeploymentBlockedError('정적 배포 폴더는 dist, out, build, public 중 하나여야 합니다.');
  }
  const root = await safePath(workspace(run.id), run.outputDir);
  if (!(await lstat(root)).isDirectory()) throw new DeploymentBlockedError('정적 배포 폴더를 찾을 수 없습니다.');
  const result: StaticFile[] = [];
  let totalBytes = 0;
  let directoryCount = 0;

  async function visit(relative: string) {
    assertActive(signal);
    if (++directoryCount > MAX_DIRECTORIES) throw new DeploymentBlockedError('배포 폴더 수가 500개 한도를 초과했습니다.');
    const directory = relative ? await safePath(root, relative) : root;
    const entries = await readdir(directory, { withFileTypes: true });
    if (entries.length > MAX_FILES + MAX_DIRECTORIES) throw new DeploymentBlockedError('배포 폴더에 파일이 너무 많습니다.');
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      assertActive(signal);
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.name.startsWith('.') || /^(?:api|functions)$/i.test(entry.name) || /^(?:package(?:-lock)?\.json|vercel\.(?:json|ts)|credentials(?:\..+)?|secrets?(?:\..+)?|id_rsa|id_ed25519)$/i.test(entry.name) || /\.(?:pem|key|p12|pfx|env)$/i.test(entry.name)) {
        throw new DeploymentBlockedError(`배포 폴더의 ${name}은 공개 정적 파일로 허용되지 않습니다.`);
      }
      const location = await safePath(root, name);
      const stat = await lstat(location);
      if (stat.isSymbolicLink()) throw new DeploymentBlockedError('배포 폴더에 심볼릭 링크가 있습니다.');
      if (stat.isDirectory()) { await visit(name); continue; }
      if (!stat.isFile()) throw new DeploymentBlockedError('배포 폴더에는 일반 파일과 폴더만 허용됩니다.');
      if (!STATIC_EXTENSIONS.has(path.extname(name).toLowerCase())) throw new DeploymentBlockedError(`배포 파일 ${name}의 형식은 정적 배포에서 지원하지 않습니다.`);
      if (stat.size > MAX_FILE_BYTES || totalBytes + stat.size > MAX_TOTAL_BYTES || result.length >= MAX_FILES) {
        throw new DeploymentBlockedError('정적 배포 한도를 초과했습니다. 최대 500개 파일, 파일당 2MB, 전체 2.5MB까지 지원합니다.');
      }
      // O_NOFOLLOW prevents swapping the final path to a symlink between validation and reading.
      const handle = await open(location, constants.O_RDONLY | constants.O_NOFOLLOW);
      let data: Buffer;
      try {
        const opened = await handle.stat();
        if (!opened.isFile() || opened.size > MAX_FILE_BYTES) throw new DeploymentBlockedError('배포 중 파일이 변경되었거나 크기 한도를 초과했습니다.');
        const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
        let offset = 0;
        while (offset < buffer.length) {
          const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
          if (!bytesRead) break;
          offset += bytesRead;
        }
        data = buffer.subarray(0, offset);
      } finally { await handle.close(); }
      if (data.length > MAX_FILE_BYTES || totalBytes + data.length > MAX_TOTAL_BYTES) throw new DeploymentBlockedError('정적 배포 전체 크기 한도를 초과했습니다.');
      rejectSecrets(name, data);
      result.push({ file: name, data });
      totalBytes += data.length;
    }
  }

  await visit('');
  const index = result.find(file => file.file === 'index.html');
  if (!index || index.data.length === 0) throw new DeploymentBlockedError('배포 폴더에 비어 있지 않은 index.html이 필요합니다.');
  return result;
}

async function limitedBody(response: Response, limit: number): Promise<Buffer> {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); throw new DeploymentBlockedError('배포 응답이 크기 한도를 초과했습니다.'); }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks);
}

function requestSignal(signal: AbortSignal, timeoutMs: number) {
  return AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
}

function hash(data: Buffer) { return createHash('sha256').update(data).digest('hex'); }

async function localPreview(run: Run, files: StaticFile[], signal: AbortSignal): Promise<Run['deployment']> {
  const port = Number(process.env.AUTOFORGE_PORT || 4317);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new DeploymentBlockedError('AUTOFORGE_PORT 값이 유효하지 않습니다.');
  const url = `http://127.0.0.1:${port}/preview/${run.id}/`;
  run.deployment = { kind: 'local', url, status: 'verifying' };
  await saveRun(run);
  const index = files.find(file => file.file === 'index.html')!;
  let lastFailure = '미리보기 서버에 연결할 수 없습니다.';
  for (let attempt = 0; attempt < 3; attempt++) {
    assertActive(signal);
    try {
      const response = await fetch(url, { signal: requestSignal(signal, 4_000), redirect: 'manual', headers: { 'Cache-Control': 'no-cache' } });
      if (!response.ok) { lastFailure = `미리보기 주소가 HTTP ${response.status}를 반환했습니다.`; await response.body?.cancel(); }
      else {
        const body = await limitedBody(response, MAX_FILE_BYTES);
        if (hash(body) !== hash(index.data)) lastFailure = '미리보기 주소가 검증한 index.html과 다른 내용을 반환했습니다.';
        else {
          run.deployment = { kind: 'local', url, status: 'ready' };
          await saveRun(run);
          return run.deployment;
        }
      }
    } catch (error) {
      assertActive(signal);
      lastFailure = error instanceof DeploymentBlockedError ? error.message : '미리보기 서버에 연결할 수 없습니다.';
    }
    if (attempt < 2) await pause(300, undefined, { signal });
  }
  run.deployment.status = 'blocked';
  await saveRun(run);
  throw new DeploymentBlockedError(`${lastFailure} AutoForge 서버를 실행한 뒤 다시 시도하세요.`);
}

function remoteUrl(value: unknown): string {
  if (typeof value !== 'string' || !value) throw new DeploymentBlockedError('Vercel 응답에 배포 URL이 없습니다.');
  let url: URL;
  try { url = new URL(value.startsWith('https://') ? value : `https://${value}`); }
  catch { throw new DeploymentBlockedError('Vercel 응답의 배포 URL이 유효하지 않습니다.'); }
  if (url.protocol !== 'https:' || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.vercel\.app$/i.test(url.hostname) || url.port || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new DeploymentBlockedError('Vercel 응답의 배포 URL이 유효하지 않습니다.');
  }
  return url.origin;
}

async function vercelRequest(endpoint: string, token: string, teamId: string | undefined, signal: AbortSignal, body?: object): Promise<RemoteDeployment> {
  const url = new URL(`https://api.vercel.com${endpoint}`);
  if (teamId) url.searchParams.set('teamId', teamId);
  const response = await fetch(url, {
    method: body ? 'POST' : 'GET', signal: requestSignal(signal, 20_000), redirect: 'error',
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) {
    await response.body?.cancel();
    // Never surface remote error bodies, which may echo credentials or submitted file contents.
    const error = new DeploymentBlockedError(`Vercel API가 HTTP ${response.status}를 반환했습니다. 프로젝트 권한과 설정을 확인하세요.`);
    Object.assign(error, { statusCode: response.status });
    throw error;
  }
  return JSON.parse((await limitedBody(response, 1_000_000)).toString('utf8')) as RemoteDeployment;
}

function assertPreview(remote: RemoteDeployment, projectId: string) {
  if (remote.target != null && remote.target !== 'preview') throw new DeploymentBlockedError('Preview 이외의 배포 대상으로 응답했습니다. 자동 배포를 중단합니다.');
  if (remote.projectId && remote.projectId !== projectId) throw new DeploymentBlockedError('배포 프로젝트가 설정한 VERCEL_PROJECT_ID와 다릅니다.');
}

async function verifyRemote(url: string, signal: AbortSignal) {
  let response: Response;
  try { response = await fetch(url, { signal: requestSignal(signal, 15_000), redirect: 'manual', headers: { 'Cache-Control': 'no-cache' } }); }
  catch { assertActive(signal); throw new DeploymentBlockedError('Vercel Preview 주소에 연결하지 못해 앱 동작을 확인하지 못했습니다. 기존 배포 ID를 저장했으므로 재개하면 다시 확인합니다.'); }
  if ([301, 302, 303, 307, 308, 401, 403].includes(response.status) || response.headers.get('x-vercel-mitigated')) {
    await response.body?.cancel();
    throw new DeploymentBlockedError('Vercel Preview가 배포되었지만 인증 또는 보호 화면으로 연결되어 실제 앱을 확인하지 못했습니다. Vercel에서 해당 배포 주소를 확인한 뒤 재개하세요.');
  }
  if (!response.ok) { await response.body?.cancel(); throw new DeploymentBlockedError(`Vercel Preview가 HTTP ${response.status}를 반환하여 앱 동작을 확인하지 못했습니다.`); }
  const body = await limitedBody(response, MAX_FILE_BYTES);
  const html = body.toString('utf8');
  if (!body.length || !response.headers.get('content-type')?.includes('text/html') || /<title[^>]*>\s*(?:Authentication Required|Vercel Security Checkpoint)|vercel\.com\/(?:login|sso-api)/i.test(html)) {
    throw new DeploymentBlockedError('Vercel Preview의 실제 앱 화면을 확인하지 못했습니다. 인증 화면과 배포 설정을 확인하세요.');
  }
}

async function vercelPreview(run: Run, files: StaticFile[], signal: AbortSignal): Promise<Run['deployment']> {
  const token = process.env.VERCEL_TOKEN;
  const projectId = process.env.VERCEL_PROJECT_ID;
  const teamId = process.env.VERCEL_TEAM_ID;
  if (!token || !projectId) throw new DeploymentBlockedError('Vercel 배포에는 서버 환경변수 VERCEL_TOKEN과 VERCEL_PROJECT_ID가 필요합니다. 팀 프로젝트는 VERCEL_TEAM_ID도 설정하세요.');
  if (!/^prj_[a-zA-Z0-9]+$/.test(projectId) || (teamId && !/^team_[a-zA-Z0-9]+$/.test(teamId))) throw new DeploymentBlockedError('Vercel 프로젝트 또는 팀 ID 형식이 유효하지 않습니다.');
  const deadline = Date.now() + 180_000;
  let id = run.deployment?.kind === 'vercel' ? run.deployment.id : undefined;
  if (!id && run.deploymentIntent) throw new DeploymentBlockedError(`이 실행은 이전 배포 요청의 결과가 불확실합니다. 중복 배포를 막기 위해 중단했습니다. Vercel에서 AutoForge 실행 ${run.id} 메타데이터를 가진 배포를 확인하고 연결하세요.`);
  if (!id) {
    assertActive(signal);
    run.deploymentIntent = true;
    run.deployment = { kind: 'vercel', url: '', status: 'submitting' };
    await saveRun(run);
    let remote: RemoteDeployment;
    try {
      // Omitting target explicitly selects Preview per the Vercel REST API.
      // Only audited static assets are sent; build/install commands are disabled.
      remote = await vercelRequest('/v13/deployments', token, teamId, signal, {
        name: `autoforge-${run.id.slice(0, 8)}`, project: projectId,
        files: files.map(file => ({ file: file.file, data: file.data.toString('base64'), encoding: 'base64' })),
        projectSettings: { framework: null, buildCommand: '', installCommand: '', commandForIgnoringBuildStep: '', outputDirectory: '.', rootDirectory: null },
        meta: { autoforgeRunId: run.id, autoforgeMode: run.mode },
      });
    } catch (error) {
      const status = (error as { statusCode?: number }).statusCode;
      if (status && status >= 400 && status < 500) run.deploymentIntent = false;
      run.deployment.status = status && status < 500 ? 'blocked' : 'uncertain';
      await saveRun(run);
      assertActive(signal);
      if (error instanceof DeploymentBlockedError) throw error;
      throw new DeploymentBlockedError('Vercel 배포 요청의 결과를 확인하지 못했습니다. 중복 요청을 보내지 않고 중단했습니다. Vercel 대시보드에서 이 실행의 배포를 확인하세요.');
    }
    if (typeof remote.id !== 'string' || !/^dpl_[a-zA-Z0-9]+$/.test(remote.id)) throw new DeploymentBlockedError('Vercel 배포 요청 후 ID를 확인하지 못했습니다. 재요청하지 않고 대시보드 확인을 기다립니다.');
    id = remote.id;
    // Persist the ID before URL validation or polling so even a malformed reply cannot trigger a duplicate POST.
    run.deployment = { kind: 'vercel', id, url: '', status: remote.readyState || 'QUEUED' };
    await saveRun(run);
    if (remote.url) { run.deployment.url = remoteUrl(remote.url); await saveRun(run); }
    assertPreview(remote, projectId);
  }
  if (!/^dpl_[a-zA-Z0-9]+$/.test(id)) throw new DeploymentBlockedError('저장된 Vercel 배포 ID가 유효하지 않습니다.');
  while (Date.now() < deadline) {
    assertActive(signal);
    let remote: RemoteDeployment;
    try { remote = await vercelRequest(`/v13/deployments/${encodeURIComponent(id)}`, token, teamId, signal); }
    catch (error) {
      assertActive(signal);
      if (error instanceof DeploymentBlockedError) throw error;
      throw new DeploymentBlockedError(`Vercel 배포 ${id}의 상태를 확인하지 못했습니다. 기존 배포 ID를 저장했으므로 재개하면 다시 확인합니다.`);
    }
    assertPreview(remote, projectId);
    const url = remote.url ? remoteUrl(remote.url) : run.deployment?.url || '';
    run.deployment = { kind: 'vercel', id, url, status: remote.readyState || 'UNKNOWN' };
    await saveRun(run);
    if (remote.readyState === 'READY') {
      if (!url) throw new DeploymentBlockedError('Vercel 배포가 READY 상태이지만 URL을 확인하지 못했습니다.');
      run.deployment.status = 'verifying';
      await saveRun(run);
      try { await verifyRemote(url, signal); }
      catch (error) { run.deployment.status = 'blocked'; await saveRun(run); assertActive(signal); throw error; }
      run.deployment.status = 'ready';
      await saveRun(run);
      return run.deployment;
    }
    if (['ERROR', 'CANCELED', 'BLOCKED'].includes(remote.readyState || '')) throw new DeploymentBlockedError(`Vercel 배포가 ${remote.readyState} 상태입니다. 배포 ID ${id}의 로그를 Vercel에서 확인하세요.`);
    await pause(2_000, undefined, { signal });
  }
  if (run.deployment) { run.deployment.status = 'waiting'; await saveRun(run); }
  throw new DeploymentBlockedError('Vercel 배포 상태 확인 시간이 3분을 초과했습니다. 배포 ID를 저장했으므로 재개하면 기존 배포를 확인합니다.');
}

export async function deployStatic(run: Run, signal: AbortSignal): Promise<Run['deployment']> {
  assertActive(signal);
  const files = await staticFiles(run, signal);
  return run.deploymentTarget === 'vercel' ? vercelPreview(run, files, signal) : localPreview(run, files, signal);
}
