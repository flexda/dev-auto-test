import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { runQuickJS } from '../src/sandbox.js';
import type { Run } from '../src/types.js';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));

async function unusedPort(): Promise<number> {
  const socket = net.createServer();
  socket.listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const address = socket.address();
  assert.ok(address && typeof address !== 'string');
  const port = address.port;
  await new Promise<void>((resolve, reject) => socket.close(error => error ? reject(error) : resolve()));
  return port;
}

test('API는 실제 수정·검증·미리보기를 수행하고 실패/차단 상태와 결과를 영속 보존한다', {timeout: 60000}, async t => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'autoforge-api-test-'));
  const port = await unusedPort();
  const origin = `http://127.0.0.1:${port}`;
  const env: NodeJS.ProcessEnv = {...process.env, AUTOFORGE_DATA_DIR: dataDir, AUTOFORGE_PORT: String(port), AUTOFORGE_REPOSITORY: 'https://github.com/flexda/dev-auto-test'};
  for (const name of ['AI_GATEWAY_API_KEY', 'VERCEL_OIDC_TOKEN', 'OPENAI_API_KEY', 'GITHUB_TOKEN', 'VERCEL_TOKEN', 'VERCEL_PROJECT_ID', 'VERCEL_TEAM_ID', 'ANTHROPIC_API_KEY', 'NODE_OPTIONS']) delete env[name];
  let child: ChildProcess | undefined;
  let output = '';
  let completed: Run;

  async function start() {
    output = '';
    child = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {cwd: projectRoot, env, stdio: ['ignore', 'pipe', 'pipe']});
    const append = (chunk: Buffer) => { output = (output + chunk.toString()).slice(-8000); };
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error('테스트 서버가 종료되었습니다.\n' + output);
      try {
        const response = await fetch(origin + '/api/runs', {signal: AbortSignal.timeout(1000)});
        if (response.ok) return;
      } catch { /* Wait until listen() is ready. */ }
      await pause(100);
    }
    throw new Error('테스트 서버 시작 시간이 초과되었습니다.\n' + output);
  }
  async function stop() {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const stopped = once(child, 'exit');
    child.kill('SIGTERM');
    await Promise.race([stopped, pause(3000).then(() => child?.kill('SIGKILL'))]);
    if (child.exitCode === null && child.signalCode === null) await stopped;
  }
  async function request<T>(route: string, options: RequestInit = {}): Promise<T> {
    const response = await fetch(origin + route, {signal: AbortSignal.timeout(10000), ...options});
    const result = await response.json();
    assert.equal(response.ok, true, JSON.stringify(result));
    return result as T;
  }
  async function create(mode: 'demo' | 'ai', maxRepairs: number): Promise<Run> {
    return request<Run>('/api/runs', {
      method: 'POST', headers: {'Content-Type': 'application/json', Origin: origin},
      body: JSON.stringify({mode, prompt: '세금이 포함된 주문 금액을 계산하고 실제 테스트를 실행해주세요.', repository: mode === 'ai' ? 'https://github.com/flexda/dev-auto-test' : '', branch: '', deploymentTarget: 'local', maxRepairs}),
    });
  }
  async function settled(id: string): Promise<Run> {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const run = await request<Run>('/api/runs/' + id);
      if (!['queued', 'running'].includes(run.status)) return run;
      await pause(80);
    }
    throw new Error('실행 완료를 기다리는 시간이 초과되었습니다.\n' + output);
  }

  try {
    await start();
    await t.test('실제 실패를 한 번 수정한 뒤 모든 단계와 로컬 배포를 완료한다', async () => {
      const health = await request<{modelConfigured: boolean}>('/api/health');
      assert.equal(health.modelConfigured, false);
      completed = await settled((await create('demo', 2)).id);
      assert.equal(completed.status, 'completed', completed.error);
      assert.equal(completed.repairCount, 1);
      assert.equal(completed.checks.length, 2);
      assert.equal(completed.checks[0].exitCode, 1);
      assert.match(completed.checks[0].stdout, /FAIL 세금 10% 더하기/);
      assert.equal(completed.checks[1].exitCode, 0);
      assert.ok(completed.stages.every(stage => stage.status === 'completed'));
      assert.equal(completed.deployment?.status, 'ready');
      assert.equal(completed.deployment?.kind, 'local');
      assert.equal(completed.deployment?.url, origin + '/preview/' + completed.id + '/');
      assert.ok(completed.events.some(event => event.stage === 'repair'));
      assert.ok(completed.documents.requirements?.includes('세금'));
      assert.ok(completed.files.includes('src/pricing.js'));
      const source = await request<{content: string}>('/api/runs/' + completed.id + '/file?path=src%2Fpricing.js');
      assert.match(source.content, /1 \+ taxRate/);

      const preview = await fetch(completed.deployment!.url);
      assert.equal(preview.status, 200);
      assert.match(preview.headers.get('content-security-policy') || '', /sandbox allow-scripts/);
      assert.match(preview.headers.get('content-security-policy') || '', /connect-src 'none'/);
      const html = await preview.text();
      const script = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1];
      assert.ok(script, '실제로 배포된 HTML에 계산 스크립트가 없습니다.');
      const values: Record<string, string> = {};
      for (const name of ['price', 'quantity', 'tax']) {
        const value = new RegExp('<input id="' + name + '"[^>]*value="([^"]*)"').exec(html)?.[1];
        assert.ok(value !== undefined, name + ' 기본 입력값이 없습니다.');
        values[name] = value;
      }
      const dom = `const result = {textContent:''}; const calculate = {addEventListener(){}}; const price = {value:${JSON.stringify(values.price)}}; const quantity = {value:${JSON.stringify(values.quantity)}}; const tax = {value:${JSON.stringify(values.tax)}};\n`;
      const result = await runQuickJS(dom + script, `test('실제 미리보기 계산 결과', () => assertEqual(Number(result.textContent.replace(/[^0-9]/g, '')), 22000));`);
      assert.equal(result.exitCode, 0, result.stderr);
      assert.match(result.stdout, /PASS 실제 미리보기 계산 결과/);
    });

    await t.test('인증정보가 없는 AI 실행은 코드 변경 전에 차단된다', async () => {
      const blocked = await settled((await create('ai', 2)).id);
      assert.equal(blocked.status, 'blocked');
      assert.match(blocked.error || '', /AI_GATEWAY_API_KEY|인증정보/);
      assert.equal(blocked.files.length, 0);
      assert.equal(blocked.checks.length, 0);
      assert.equal(blocked.deployment, undefined);
    });

    await t.test('자동 수정 한도가 0이면 실패를 보존하고 미리보기를 제공하지 않는다', async () => {
      const failed = await settled((await create('demo', 0)).id);
      assert.equal(failed.status, 'failed');
      assert.equal(failed.repairCount, 0);
      assert.equal(failed.checks.length, 1);
      assert.equal(failed.checks[0].exitCode, 1);
      assert.equal(failed.stages.find(stage => stage.id === 'testing')?.status, 'failed');
      assert.equal(failed.deployment, undefined);
      assert.equal((await fetch(origin + '/preview/' + failed.id + '/')).status, 404);
    });

    await t.test('외부 웹 출처의 변경 요청은 실행을 생성하지 않고 거부한다', async () => {
      const before = await request<Run[]>('/api/runs');
      const rejected = await fetch(origin + '/api/runs', {
        method: 'POST', headers: {'Content-Type': 'application/json', Origin: 'https://evil.example'},
        body: JSON.stringify({mode: 'demo', prompt: '허용되지 않은 외부 요청', maxRepairs: 2}),
      });
      assert.equal(rejected.status, 403);
      const after = await request<Run[]>('/api/runs');
      assert.equal(after.length, before.length);
    });

    await t.test('서버 재시작 후 완료 상태, 검사 출력과 결과물이 유지된다', async () => {
      await stop();
      await start();
      const runs = await request<Run[]>('/api/runs');
      const restored = runs.find(run => run.id === completed.id);
      assert.ok(restored);
      assert.equal(restored.status, 'completed');
      assert.deepEqual(restored.checks, completed.checks);
      assert.deepEqual(restored.files, completed.files);
      assert.deepEqual(restored.deployment, completed.deployment);
      assert.equal((await fetch(completed.deployment!.url)).status, 200);
    });
    await t.test('중단된 단계는 재시작 후 자동 재개하며 완료한 코딩·수정을 반복하지 않는다', async () => {
      await stop();
      const stateFile = path.join(dataDir, 'runs', completed.id, 'state.json');
      const interrupted = JSON.parse(await readFile(stateFile, 'utf8')) as Run;
      interrupted.status = 'running'; interrupted.stage = 'testing';
      interrupted.stages.find(stage => stage.id === 'testing')!.status = 'running';
      interrupted.stages.find(stage => stage.id === 'deploy')!.status = 'pending';
      interrupted.deployment = undefined;
      await writeFile(stateFile, JSON.stringify(interrupted));
      await start();
      const resumed = await settled(completed.id);
      assert.equal(resumed.status, 'completed', resumed.error);
      assert.equal(resumed.repairCount, 1);
      assert.equal(resumed.checks.length, completed.checks.length + 1);
      assert.equal(resumed.stages.find(stage => stage.id === 'coding')!.attempts, 1);
      assert.ok(resumed.events.some(event => event.message.includes('자동으로 이어서')));
      assert.equal((await fetch(resumed.deployment!.url)).status, 200);
    });
  } finally {
    await stop();
    await rm(dataDir, {recursive: true, force: true});
  }
});
