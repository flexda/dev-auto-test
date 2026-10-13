import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { demoSource, demoTests } from '../src/demo.js';
import { parseRepository } from '../src/repository.js';
import { runQuickJS } from '../src/sandbox.js';
import { safePath } from '../src/store.js';
import { selectChecks } from '../src/engine.js';

test('저장소의 기존 검사와 배포 빌드를 생략할 수 없다', () => {
  assert.deepEqual(selectChecks(['test'], {test: 'node --test', build: 'node build.js', lint: 'eslint .'}, 'dist'), ['build', 'test', 'lint']);
  assert.deepEqual(selectChecks(['test'], {}, 'dist'), ['build', 'test']);
  assert.deepEqual(selectChecks(['test'], {}, 'public'), ['test']);
});

test('실제 세금 계산 테스트는 잘못된 코드를 실패시키고 수정된 코드를 통과시킨다', async () => {
  const broken = await runQuickJS(demoSource(false), demoTests);
  assert.equal(broken.exitCode, 1);
  assert.match(broken.stdout, /FAIL 세금 10% 더하기/);
  assert.match(broken.stdout, /PASS 상품 합계/);
  const repaired = await runQuickJS(demoSource(true), demoTests);
  assert.equal(repaired.exitCode, 0, repaired.stderr);
  assert.match(repaired.stdout, /4 assertions/);
  assert.match(repaired.stdout, /PASS 세금 10% 더하기/);
  assert.doesNotMatch(repaired.stdout, /FAIL/);
});

test('생성 코드는 호스트 프로세스, 모듈 로더, 네트워크에 접근할 수 없다', async () => {
  const result = await runQuickJS('', `test('host boundary', () => {
    assertEqual(typeof process, 'undefined');
    assertEqual(typeof require, 'undefined');
    assertEqual(typeof Buffer, 'undefined');
    assertEqual(typeof fetch, 'undefined');
    assertEqual((() => {}).constructor('return typeof process')(), 'undefined');
  });`);
  assert.equal(result.exitCode, 0, result.stderr);
  assert.match(result.stdout, /5 assertions/);
});

test('무한 루프는 격리 실행 제한 시간 내에 종료된다', {timeout: 8000}, async () => {
  const started = Date.now();
  const result = await runQuickJS('while (true) {}', 'assert(true);');
  assert.equal(result.exitCode, 124, result.stderr);
  assert.ok(Date.now() - started < 7000, '무한 루프가 실행 제한 시간을 지나 계속 실행되었습니다.');
});

test('검증 문장이 없거나 이미 취소된 코드는 통과로 처리되지 않는다', async () => {
  const empty = await runQuickJS(demoSource(true), 'console.log("success");');
  assert.notEqual(empty.exitCode, 0);
  assert.match(empty.stderr, /검증|assert/i);
  const cancelled = await runQuickJS(demoSource(true), demoTests, AbortSignal.abort());
  assert.equal(cancelled.exitCode, 130);
});

test('저장소 URL은 명시적인 GitHub HTTPS 주소만 허용한다', () => {
  assert.deepEqual(parseRepository('https://github.com/flexda/dev-auto-test'), {
    owner: 'flexda', repo: 'dev-auto-test', url: 'https://github.com/flexda/dev-auto-test.git',
  });
  assert.equal(parseRepository('https://github.com/flexda/dev-auto-test.git/').repo, 'dev-auto-test');
  const rejected = [
    'http://github.com/owner/repo', 'https://gitlab.com/owner/repo',
    'https://github.com.evil.example/owner/repo', 'https://user:secret@github.com/owner/repo',
    'https://github.com:444/owner/repo', 'https://github.com/owner/repo?token=secret',
    'https://github.com/owner/repo#main', 'https://github.com/owner/repo/tree/main',
    'https://github.com/owner/repo/../other', 'https://github.com\\owner\\repo',
    'file:///tmp/repo', 'git@github.com:owner/repo.git',
    'https://github.com/-owner/repo', 'https://github.com/owner/%2frepo',
  ];
  for (const url of rejected) assert.throws(() => parseRepository(url), url);
});

test('파일 경로는 작업 공간 안의 일반 파일만 허용하고 인증 파일을 보호한다', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'autoforge-path-test-'));
  try {
    await mkdir(path.join(root, 'src'));
    await writeFile(path.join(root, 'src', 'app.js'), 'export const ready = true;');
    const canonicalRoot = await realpath(root);
    assert.equal(await safePath(root, 'src/app.js'), path.join(canonicalRoot, 'src', 'app.js'));
    assert.equal(await safePath(root, 'new/file.ts'), path.join(canonicalRoot, 'new', 'file.ts'));
    const rejected = [
      '../state.json', 'src/../../outside', '/etc/passwd', 'src\\app.js', 'src/./app.js',
      'src//app.js', '.git/config', 'node_modules/pkg/index.js', '.autoforge/state.json',
      '.env', 'config/.env.local', 'credentials', 'id_rsa', 'id_ed25519',
      '.npmrc', '.netrc', 'config/secrets.json', 'keys/private.pem', 'keys/private.key',
    ];
    for (const relative of rejected) await assert.rejects(safePath(root, relative), relative);
    await symlink(os.tmpdir(), path.join(root, 'outside'));
    await assert.rejects(safePath(root, 'outside/host-file'), /심볼릭|symlink/i);
    await symlink(path.join(root, 'src', 'app.js'), path.join(root, 'linked.js'));
    await assert.rejects(safePath(root, 'linked.js'), /심볼릭|symlink/i);
  } finally { await rm(root, {recursive: true, force: true}); }
});
