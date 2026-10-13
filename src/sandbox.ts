import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstat, realpath, readdir } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import { Worker } from 'node:worker_threads';

export type Check = {
  name: string;
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
};

const allowedScripts = new Set(['test', 'build', 'lint', 'typecheck']);
const outputLimit = 32_000;

function redact(value: string): string {
  let text = value;
  for (const key of ['GITHUB_TOKEN', 'OPENAI_API_KEY', 'AI_GATEWAY_API_KEY', 'VERCEL_TOKEN', 'ANTHROPIC_API_KEY']) {
    const secret = process.env[key];
    if (secret) text = text.split(secret).join('[REDACTED]');
  }
  return text.replace(/(?:github_pat_|gh[pousr]_)[A-Za-z0-9_]{16,}/g, '[REDACTED]');
}

function dockerEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  // These configure the Docker client only; none is passed into the container.
  for (const key of ['PATH', 'HOME', 'TMPDIR', 'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return env;
}

function executeDocker(
  args: string[], name: string, command: string, timeoutMs: number,
  signal?: AbortSignal, containerName?: string, onLog?: (message: string) => void,
): Promise<Check> {
  const start = Date.now();
  if (signal?.aborted) return Promise.resolve({ name, command, exitCode: 130, stdout: '', stderr: '작업이 취소되었습니다.', durationMs: 0 });
  return new Promise((resolve) => {
    let stdout = '', stderr = '', reason = '';
    let settled = false;
    const child = spawn('docker', args, { env: dockerEnv(), stdio: ['ignore', 'pipe', 'pipe'], shell: false });
    const stop = (message: string) => {
      reason ||= message;
      child.kill('SIGKILL');
      if (containerName) {
        // Killing the Docker CLI alone does not stop the container.
        const cleanup = spawn('docker', ['rm', '--force', containerName], { env: dockerEnv(), stdio: 'ignore', shell: false });
        cleanup.on('error', () => {});
        const killCleanup = setTimeout(() => cleanup.kill('SIGKILL'), 5_000);
        killCleanup.unref();
        cleanup.on('close', () => clearTimeout(killCleanup));
      }
    };
    const abort = () => stop('작업이 취소되었습니다.');
    const timer = setTimeout(() => stop('격리 실행의 제한 시간을 초과했습니다.'), timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    const append = (chunk: Buffer, stream: 'stdout' | 'stderr') => {
      const clean = redact(chunk.toString());
      if (stream === 'stdout') stdout = (stdout + clean).slice(0, outputLimit);
      else stderr = (stderr + clean).slice(0, outputLimit);
    };
    child.stdout.on('data', (chunk: Buffer) => append(chunk, 'stdout'));
    child.stderr.on('data', (chunk: Buffer) => append(chunk, 'stderr'));
    const finish = (exitCode: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      stdout = redact(stdout);
      stderr = redact(stderr);
      // Emit complete output only: a secret split across stream chunks must still be redacted.
      if (stdout) onLog?.(stdout.slice(0, 2_000));
      if (stderr) onLog?.(stderr.slice(0, 2_000));
      resolve({ name, command, exitCode: reason ? (signal?.aborted ? 130 : 124) : exitCode,
        stdout, stderr: reason ? `${stderr}\n${reason}`.trim() : stderr, durationMs: Date.now() - start });
    };
    child.once('error', (error) => { stderr = redact(error.message); finish(127); });
    child.once('close', (code) => finish(code ?? 1));
  });
}

export async function dockerAvailable(): Promise<boolean> {
  const result = await executeDocker(['info', '--format', '{{.ServerVersion}}'], 'docker', 'docker info', 4_000);
  return result.exitCode === 0 && result.stdout.trim().length > 0;
}

async function safeWorkspace(workspace: string): Promise<string> {
  if (!isAbsolute(workspace) || workspace.includes(',') || workspace.includes('\n')) throw new Error('격리 작업 폴더 경로가 올바르지 않습니다.');
  const root = await realpath(workspace);
  if (!(await lstat(root)).isDirectory()) throw new Error('격리 작업 폴더가 없습니다.');
  let examined = 0;
  async function inspect(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (++examined > 30_000) throw new Error('저장소 파일 수가 격리 검사 한도를 초과했습니다.');
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        let target: string;
        try { target = await realpath(path); } catch { throw new Error('저장소에 연결 대상이 없는 심볼릭 링크가 있습니다.'); }
        const offset = relative(root, target);
        if (offset === '..' || offset.startsWith('../') || isAbsolute(offset)) throw new Error('저장소 밖을 가리키는 심볼릭 링크는 실행할 수 없습니다.');
      } else if (entry.isDirectory() && entry.name !== '.git' && entry.name !== 'node_modules') await inspect(path);
    }
  }
  await inspect(root);
  return root;
}

export async function runDockerChecks(
  workspace: string, scripts: string[], signal: AbortSignal, onLog?: (message: string) => void,
): Promise<Check[]> {
  const root = await safeWorkspace(workspace);
  const requested = [...new Set(scripts)];
  if (requested.some((script) => !allowedScripts.has(script))) throw new Error('test, build, lint, typecheck 검사만 실행할 수 있습니다.');
  if (!requested.length) throw new Error('저장소에 실행할 검사 스크립트가 없습니다. package.json에 test 또는 build를 추가하세요.');
  if (!await dockerAvailable()) throw new Error('Docker 실행 환경이 준비되지 않았습니다. Docker Desktop을 실행한 뒤 다시 시도하세요.');
  if (signal.aborted) throw new Error('작업이 취소되었습니다.');
  const image = process.env.SANDBOX_IMAGE || 'node:24-alpine';
  if (!/^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,199}$/.test(image)) throw new Error('SANDBOX_IMAGE 설정이 올바르지 않습니다.');
  // Repository commands never run on the host. The only mount is this run's workspace.
  const base = ['run', '--rm', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--cpus', '1', '--memory', '512m', '--memory-swap', '512m', '--pids-limit', '128',
    '--tmpfs', '/tmp:rw,nosuid,nodev,size=128m', '--env', 'HOME=/tmp', '--env', 'CI=true',
    '--env', 'npm_config_update_notifier=false', '--workdir', '/workspace',
    '--mount', `type=bind,source=${root},target=/workspace`];
  if (process.getuid) base.push('--user', `${process.getuid()}:${process.getgid?.() ?? process.getuid()}`);
  try {
    const gitDirectory = join(root, '.git');
    if ((await lstat(gitDirectory)).isDirectory()) base.push('--mount', `type=bind,source=${gitDirectory},target=/workspace/.git,readonly`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const checks: Check[] = [];
  const lockContainer = `autoforge-lock-${randomUUID()}`;
  onLog?.('격리 컨테이너에서 의존성 잠금 파일을 생성하거나 갱신합니다. 설치 스크립트는 비활성화합니다.');
  const lockfile = await executeDocker(
    [...base, '--name', lockContainer, '--network', 'bridge', image, 'npm', 'install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund', '--cache=/tmp/npm-cache'],
    'lockfile', 'npm install --package-lock-only --ignore-scripts', 180_000, signal, lockContainer, onLog,
  );
  checks.push(lockfile);
  if (lockfile.exitCode !== 0) return checks;
  await safeWorkspace(root);
  const dependencyContainer = `autoforge-deps-${randomUUID()}`;
  onLog?.('격리 컨테이너에서 잠금 파일에 따라 의존성을 설치합니다. 설치 스크립트는 비활성화합니다.');
  const dependencies = await executeDocker(
    [...base, '--name', dependencyContainer, '--network', 'bridge', image, 'npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund', '--cache=/tmp/npm-cache'],
    'dependencies', 'npm ci --ignore-scripts', 180_000, signal, dependencyContainer, onLog,
  );
  checks.push(dependencies);
  if (dependencies.exitCode !== 0) return checks;
  await safeWorkspace(root);
  for (const script of requested) {
    if (signal.aborted) {
      checks.push({ name: script, command: `npm run ${script}`, exitCode: 130, stdout: '', stderr: '작업이 취소되었습니다.', durationMs: 0 });
      break;
    }
    const container = `autoforge-check-${randomUUID()}`;
    onLog?.(`네트워크가 차단된 컨테이너에서 ${script} 검사를 실행합니다.`);
    checks.push(await executeDocker([...base, '--name', container, '--network', 'none', image, 'npm', 'run', script],
      script, `npm run ${script}`, 120_000, signal, container, onLog));
    await safeWorkspace(root);
  }
  return checks;
}

const quickJSHarness = `(() => {
  const count = __autoforgeAssert, record = __autoforgeResult, log = __autoforgeLog;
  const stringify = JSON.stringify, same = Object.is, string = String, bool = Boolean, ErrorType = Error;
  const assert = (condition, message = 'Assertion failed') => count(bool(condition), string(message));
  const assertEqual = (actual, expected, message = 'Values differ') => assert(same(actual, expected), message);
  const assertDeepEqual = (actual, expected, message = 'Values differ') => assert(stringify(actual) === stringify(expected), message);
  const test = (name, fn) => {
    try { const value = fn(); if (value && typeof value.then === 'function') throw new ErrorType('비동기 테스트는 지원되지 않습니다.'); record(string(name), true, ''); }
    catch (error) { record(string(name), false, string(error)); }
  };
  for (const [name, value] of Object.entries({ assert, assertEqual, assertDeepEqual, test, console: Object.freeze({log}) }))
    Object.defineProperty(globalThis, name, {value, writable:false, configurable:false});
  delete globalThis.__autoforgeAssert; delete globalThis.__autoforgeResult; delete globalThis.__autoforgeLog;
})()`;

// This worker is trusted runtime code. Generated code is passed as data and
// evaluated exclusively by QuickJS, never by Node's eval/Function/vm APIs.
const quickJSWorker = `
import { parentPort, workerData } from 'node:worker_threads';
(async () => {
  const { getQuickJS } = await import(workerData.quickjsUrl);
  const QuickJS = await getQuickJS();
  const runtime = QuickJS.newRuntime();
  runtime.setMemoryLimit(32 * 1024 * 1024);
  runtime.setMaxStackSize(512 * 1024);
  const deadline = Date.now() + 2000;
  runtime.setInterruptHandler(() => Date.now() >= deadline);
  const vm = runtime.newContext();
  let assertions = 0;
  const failures = [], results = [], logs = [];
  const report = {exitCode:1, stdout:'', stderr:''};
  try {
    const nativeAssert = vm.newFunction('__assert', (condition, message) => {
      assertions++;
      if (!vm.dump(condition)) {
        const text = message ? String(vm.dump(message)).slice(0,2000) : 'Assertion failed';
        if (failures.length < 200) failures.push(text);
        return {error:vm.newError(text)};
      }
    });
    const nativeResult = vm.newFunction('__result', (name, passed, error) => {
      const label = String(vm.dump(name)).slice(0,300), ok = Boolean(vm.dump(passed));
      const message = error ? String(vm.dump(error)).slice(0,2000) : '';
      if (results.length < 200) results.push((ok ? 'PASS ' : 'FAIL ') + label + (message ? ': ' + message : ''));
      if (!ok && failures.length < 200) failures.push(message || label);
    });
    const nativeLog = vm.newFunction('__log', (...values) => {
      if (logs.join('').length < 16000) logs.push(values.map(value => String(vm.dump(value)).slice(0,2000)).join(' ').slice(0,2000));
    });
    vm.setProp(vm.global, '__autoforgeAssert', nativeAssert);
    vm.setProp(vm.global, '__autoforgeResult', nativeResult);
    vm.setProp(vm.global, '__autoforgeLog', nativeLog);
    nativeAssert.dispose(); nativeResult.dispose(); nativeLog.dispose();
    const evaluate = (code, filename) => {
      const result = vm.evalCode(code, filename, {type:'global'});
      if (result.error) {
        const value = vm.dump(result.error);
        result.error.dispose();
        throw new Error(typeof value === 'string' ? value : JSON.stringify(value));
      }
      result.value.dispose();
    };
    evaluate(workerData.harness, 'test-harness.js');
    evaluate(workerData.source, 'generated-source.js');
    const beforeTests = assertions;
    evaluate(workerData.tests, 'generated-tests.js');
    const testAssertions = assertions - beforeTests;
    if (!testAssertions) throw new Error('검증 문장이 없는 테스트는 통과로 처리할 수 없습니다.');
    report.exitCode = failures.length ? 1 : 0;
    report.stdout = (testAssertions + ' assertions\\n' + results.join('\\n') + '\\n' + logs.join('\\n')).trim().slice(0,32000);
    report.stderr = failures.join('\\n').slice(0,32000);
  } catch (error) {
    report.stderr = (error instanceof Error ? error.message : String(error)).slice(0,32000);
    report.exitCode = report.stderr.includes('interrupted') ? 124 : 1;
  }
  // Send the result before cleanup: pathological guest heaps can make GC slow.
  parentPort.postMessage(report);
  vm.dispose(); runtime.dispose();
})().catch(error => parentPort.postMessage({exitCode:1, stdout:'', stderr:String(error).slice(0,32000)}));
`;

export async function runQuickJS(source: string, tests: string, signal?: AbortSignal): Promise<Check> {
  const start = Date.now();
  const check: Check = { name: 'unit-tests', command: 'QuickJS isolated unit tests', exitCode: 1, stdout: '', stderr: '', durationMs: 0 };
  if (source.length + tests.length > 300_000) return { ...check, stderr: '코드 크기가 격리 검사 한도를 초과했습니다.' };
  if (signal?.aborted) return { ...check, exitCode: 130, stderr: '작업이 취소되었습니다.' };
  return new Promise((resolveResult) => {
    const worker = new Worker(quickJSWorker, { eval: true, execArgv: ['--input-type=module'], env: {},
      workerData: { source, tests, harness: quickJSHarness, quickjsUrl: import.meta.resolve('quickjs-emscripten') },
      resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 },
    });
    let settled = false;
    const finish = (result: Pick<Check, 'exitCode' | 'stdout' | 'stderr'>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
      void worker.terminate().catch(() => {});
      resolveResult({ ...check, ...result, stdout: redact(result.stdout).slice(0, outputLimit),
        stderr: redact(result.stderr).slice(0, outputLimit), durationMs: Date.now() - start });
    };
    const abort = () => finish({ exitCode: 130, stdout: '', stderr: '작업이 취소되었습니다.' });
    // External deadline also covers non-interruptible WASM operations and GC.
    const timeout = setTimeout(() => finish({ exitCode: 124, stdout: '', stderr: '격리 실행의 제한 시간을 초과했습니다.' }), 3_500);
    signal?.addEventListener('abort', abort, { once: true });
    worker.once('message', (result: Pick<Check, 'exitCode' | 'stdout' | 'stderr'>) => finish(result));
    worker.once('error', (error) => finish({ exitCode: 1, stdout: '', stderr: error.message }));
    worker.once('exit', () => { if (!settled) finish({ exitCode: 1, stdout: '', stderr: '격리 실행이 결과 없이 종료되었습니다.' }); });
  });
}
