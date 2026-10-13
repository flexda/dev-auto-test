import { mkdir, readFile, readdir, lstat, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import path from 'node:path';
import type { Run, StageId } from './types.js';
import { artifact, getRun, listRuns, newRun, saveRun, safePath, workspace, writeProjectFile } from './store.js';
import { dockerAvailable, runDockerChecks, runQuickJS } from './sandbox.js';
import { parseRepository, prepareRepository } from './repository.js';
import { modelConfigured, reason, requirementsSchema, designSchema, patchSchema, reviewSchema } from './model.js';
import { deployStatic } from './deployment.js';
import { demoPrompt, demoSource, demoTests, demoHtml } from './demo.js';

const active = new Map<string, AbortController>();
const queued = new Set<string>();
let draining = false;
class Blocked extends Error {}
export const defaultRepository = process.env.AUTOFORGE_REPOSITORY || 'https://github.com/flexda/dev-auto-test';
export function selectChecks(planned: string[], existing: Record<string, string>, outputDir: string) {
  const checks = [...new Set([...planned, ...Object.keys(existing)])];
  if (outputDir !== 'public' && !checks.includes('build')) checks.push('build');
  return checks.sort((a, b) => (a === 'build' ? -1 : b === 'build' ? 1 : 0));
}
const digest = (s: string) => createHash('sha256').update(s).digest('hex');
export const publicRun = (run: Run) => { const { context, protectedScripts, protectedTests, ...publicFields } = run; return publicFields; };
export async function recoverRuns() {
  for (const run of await listRuns()) {
    if (run.status === 'running' || run.status === 'queued') {
      if (run.deploymentIntent && !run.deployment?.id) {
        run.status = 'blocked'; run.error = '외부 배포 요청 결과가 불확실해 자동 재개를 멈췄습니다. Vercel에서 배포 결과를 확인하세요.';
        await event(run, 'warning', run.error);
      } else {
        run.status = 'queued'; run.error = undefined; queued.add(run.id);
        await event(run, 'info', '서버 재시작 후 저장된 단계에서 자동으로 이어서 실행합니다.');
      }
    }
  }
}
export function startPendingRuns() { void drain(); }
export async function createRun(input: Parameters<typeof newRun>[0]) {
  if (input.mode === 'ai') parseRepository(input.repository);
  const run = newRun(input.mode === 'demo' ? { ...input, prompt: demoPrompt, repository: '', branch: '', deploymentTarget: 'local' } : input);
  await saveRun(run); queued.add(run.id); void drain(); return publicRun(run);
}
async function drain() {
  if (draining) return;
  draining = true;
  try { while (queued.size) { const id = queued.values().next().value!; queued.delete(id); await executeRun(id); } }
  finally { draining = false; }
}
export async function cancelRun(id: string) {
  queued.delete(id);
  const controller = active.get(id);
  if (controller) { controller.abort(new Error('사용자가 실행을 중단했습니다.')); return publicRun(await getRun(id)); }
  const run = await getRun(id);
  if (!['queued', 'running', 'blocked'].includes(run.status)) throw new Error('중단할 수 없는 상태입니다.');
  run.status = 'cancelled'; run.error = '사용자가 실행을 중단했습니다.'; await event(run, 'warning', run.error); return publicRun(run);
}
export async function resumeRun(id: string) {
  const run = await getRun(id);
  if (!['blocked', 'cancelled', 'failed'].includes(run.status)) throw new Error('재개할 수 없는 상태입니다.');
  if (active.has(id) || queued.has(id)) throw new Error('이미 실행 중입니다.');
  if (run.deploymentIntent && !run.deployment?.id) throw new Error('외부 배포 요청의 결과가 불확실합니다. Vercel에서 중복 배포 여부를 확인해야 합니다. 새 작업으로 시작하세요.');
  if (run.status === 'failed' && run.repairCount >= run.maxRepairs) throw new Error('수정 횟수 한도에 도달했습니다. 요구사항을 보완해 새 작업으로 시작하세요.');
  run.status = 'queued'; run.error = undefined; await event(run, 'info', '저장된 상태에서 실행을 재개합니다.'); queued.add(id); void drain(); return publicRun(run);
}
async function event(run: Run, type: string, message: string) { run.events.push({ timestamp: new Date().toISOString(), stage: run.stage, type, message }); await saveRun(run); }
async function begin(run: Run, id: StageId) { run.stage = id; const st = run.stages.find(s => s.id === id)!; st.status = 'running'; st.attempts++; await event(run, 'info', `${st.label} 시작`); }
async function finish(run: Run, id: StageId, summary: string) { const st = run.stages.find(s => s.id === id)!; st.status = 'completed'; st.summary = summary; await event(run, 'success', summary); }
const done = (run: Run, id: StageId) => run.stages.find(s => s.id === id)!.status === 'completed';
function checkAbort(signal: AbortSignal) { signal.throwIfAborted(); }

async function readContext(run: Run) {
  const names = run.files.filter(f => !f.startsWith('autoforge-artifacts/') && (run.outputDir === 'public' || !f.startsWith(run.outputDir + '/'))).slice(0, 40);
  let context = (run.context || '').slice(0, 35_000);
  for (const name of names) { try { context += `\nFILE ${name}\n${(await readFile(await safePath(workspace(run.id), name), 'utf8')).slice(0, 10_000)}\n`; } catch {} }
  return context.slice(-65_000);
}
async function listTestHashes(root: string, relative = '', result: Record<string, string> = {}) {
  for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
    if (entry.name.startsWith('.') || ['node_modules', 'dist', 'out', 'build', 'autoforge-artifacts'].includes(entry.name)) continue;
    const file = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) { if (file.split('/').length < 7) await listTestHashes(root, file, result); }
    else if (/(^|\/)(tests?|__tests__)\/|\.(test|spec)\.[cm]?[jt]sx?$/.test(file) && (await lstat(path.join(root, file))).size < 256_000) result[file] = digest(await readFile(path.join(root, file), 'utf8'));
    if (Object.keys(result).length > 250) break;
  }
  return result;
}
async function applyPatch(run: Run, files: { path: string; content: string }[]) {
  if (new Set(files.map(f => f.path)).size !== files.length) throw new Error('중복 파일 경로가 포함된 변경입니다.');
  if (files.reduce((n, f) => n + Buffer.byteLength(f.content), 0) > 1_500_000) throw new Error('한 번의 코드 변경은 1.5MB를 넘을 수 없습니다.');
  for (const file of files) {
    await safePath(workspace(run.id), file.path);
    if (file.path.startsWith('autoforge-artifacts/')) throw new Error('시스템의 검증 기록을 코드 변경으로 덮어쓸 수 없습니다.');
    if (run.protectedTests?.[file.path] && digest(file.content) !== run.protectedTests[file.path]) throw new Error(`기존 검증 파일 변경은 허용되지 않습니다: ${file.path}`);
    if (file.path === 'package.json') {
      const pkg = JSON.parse(file.content);
      for (const [name, command] of Object.entries(run.protectedScripts || {})) if (pkg.scripts?.[name] !== command) throw new Error(`기존 ${name} 검증 명령을 변경할 수 없습니다.`);
    }
  }
  for (const file of files) { await writeProjectFile(run.id, file.path, file.content); if (!run.files.includes(file.path)) run.files.push(file.path); }
  await saveRun(run);
}
async function freezeValidation(run: Run) {
  run.protectedTests = { ...run.protectedTests, ...await listTestHashes(workspace(run.id)) };
  const pkg = JSON.parse(await readFile(path.join(workspace(run.id), 'package.json'), 'utf8'));
  for (const name of run.scripts || []) {
    if (typeof pkg.scripts?.[name] !== 'string') throw new Error(`${name} 검증 스크립트가 없습니다.`);
    (run.protectedScripts ||= {})[name] = pkg.scripts[name];
    if (name === 'test') {
      for (const file of (pkg.scripts[name] as string).match(/[A-Za-z0-9_./-]+\.(?:[cm]?[jt]s|[jt]sx)\b/g) || []) {
        try { run.protectedTests[file] = digest(await readFile(await safePath(workspace(run.id), file), 'utf8')); }
        catch (error: any) { if (error.code !== 'ENOENT') throw error; }
      }
    }
  }
  await saveRun(run);
}
async function verifyValidation(run: Run) {
  for (const [name, hash] of Object.entries(run.protectedTests || {})) {
    if (digest(await readFile(await safePath(workspace(run.id), name), 'utf8')) !== hash) throw new Error(`보호된 테스트가 실행 중 변경되었습니다: ${name}`);
  }
  const pkg = JSON.parse(await readFile(path.join(workspace(run.id), 'package.json'), 'utf8'));
  for (const [name, command] of Object.entries(run.protectedScripts || {})) if (pkg.scripts?.[name] !== command) throw new Error(`보호된 ${name} 명령이 실행 중 변경되었습니다.`);
}
async function exportDiff(run: Run) {
  if (!run.baseCommit) return;
  const output = await new Promise<string>((resolve, reject) => {
    const child = spawn('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', 'diff', '--no-ext-diff', '--no-textconv', '--', '.', ':!autoforge-artifacts'], { cwd: workspace(run.id), env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; child.stdout.on('data', d => { if (out.length < 1_500_000) out += d; }); child.on('error', reject); child.on('close', code => code === 0 ? resolve(out) : reject(new Error('변경 내역 생성에 실패했습니다.')));
  });
  // Include newly created files in a standalone manifest; git diff omits untracked files.
  await artifact(run, 'changes.patch', output || '# 기존 추적 파일의 변경이 없습니다. 새 파일은 source-manifest.json을 확인하세요.\n');
  const sources: Record<string, string> = {};
  for (const name of run.files.filter(f => !f.startsWith('autoforge-artifacts/'))) sources[name] = await readFile(await safePath(workspace(run.id), name), 'utf8');
  await artifact(run, 'source-manifest.json', JSON.stringify({ baseCommit: run.baseCommit, repository: run.repository, files: sources }, null, 2));
}
async function executeRun(id: string) {
  const run = await getRun(id); const controller = new AbortController(); active.set(id, controller);
  const timeout = setTimeout(() => controller.abort(new Error('작업 실행 시간 20분을 초과했습니다.')), 20 * 60_000); timeout.unref();
  const signal = controller.signal;
  try {
    run.status = 'running'; run.error = undefined; await event(run, 'info', run.mode === 'demo' ? '내장 시나리오 실행 · AI 호출 없이 실제 코드를 테스트합니다.' : 'AI 자율 개발 작업을 시작합니다.');
    if (run.mode === 'ai') {
      if (!modelConfigured()) throw new Blocked('AI 인증정보가 없습니다. .env에 AI_GATEWAY_API_KEY를 설정하고 서버를 다시 시작한 뒤 재개하세요.');
      if (!await dockerAvailable()) throw new Blocked('Docker가 실행되지 않았습니다. Docker Desktop을 시작한 뒤 재개하세요.');
      if (!run.baseCommit) {
        await event(run, 'info', `${run.repository} 저장소를 작업 전용 공간에 복사합니다.`);
        // A clone interrupted before its checkpoint contains no completed implementation.
        await rm(workspace(id), { recursive: true, force: true });
        const repo = await prepareRepository(run.repository, run.branch, workspace(id), signal);
        run.context = repo.context; run.baseCommit = repo.baseCommit;
        try { const pkg = JSON.parse(await readFile(path.join(workspace(id), 'package.json'), 'utf8')); run.protectedScripts = Object.fromEntries(['test', 'build', 'lint', 'typecheck'].filter(n => pkg.scripts?.[n]).map(n => [n, pkg.scripts[n]])); } catch { run.protectedScripts = {}; }
        run.protectedTests = await listTestHashes(workspace(id)); await saveRun(run);
      }
    } else await mkdir(workspace(id), { recursive: true });
    checkAbort(signal);
    if (!done(run, 'requirements')) {
      await begin(run, 'requirements');
      const req = run.mode === 'demo' ? { summary: '가격·수량·세율을 받아 합계를 계산하는 웹 계산기', acceptanceCriteria: ['가격 × 수량의 합계를 계산한다.', '세금 10%를 합계에 더한다.', '빈 목록은 0원을 반환한다.', '여러 상품의 수량을 정확히 반영한다.'], assumptions: ['내장 예제는 사전에 작성된 코드와 오류 수정으로 동작합니다.'] } : await reason(requirementsSchema, `USER REQUEST:\n${run.prompt}\nREPOSITORY:\n${run.context}`, signal);
      run.acceptanceCriteria = req.acceptanceCriteria;
      run.documents.requirements = `# 요구사항\n\n${req.summary}\n\n## 완료 조건\n${req.acceptanceCriteria.map(x => '- ' + x).join('\n')}\n\n## 가정\n${req.assumptions.map(x => '- ' + x).join('\n')}`;
      await artifact(run, 'requirements.md', run.documents.requirements); await finish(run, 'requirements', `${req.acceptanceCriteria.length}개 완료 조건을 정의했습니다.`);
    }
    checkAbort(signal);
    if (!done(run, 'design')) {
      await begin(run, 'design');
      const design = run.mode === 'demo' ? { summary: '가격 계산 함수를 분리하고 4가지 동작을 검증합니다.', architecture: 'JavaScript 계산 함수 → QuickJS 테스트 → 정적 HTML 배포', files: ['src/pricing.js', 'test/pricing.test.js', 'dist/index.html'], testScripts: ['test'], outputDir: 'dist' } : await reason(designSchema, `REQUEST:\n${run.prompt}\nREQUIREMENTS:\n${run.documents.requirements}\nREPOSITORY:\n${run.context}\nExisting protected checks: ${JSON.stringify(run.protectedScripts)}\nPlan implementation and meaningful tests. Include test and build when creating an empty Node project. Only static output is currently deployable.`, signal);
      run.outputDir = design.outputDir;
      run.scripts = run.mode === 'demo' ? design.testScripts : selectChecks(design.testScripts, run.protectedScripts || {}, design.outputDir);
      if (run.mode === 'ai' && !run.scripts.includes('test')) throw new Blocked('테스트가 설계에 포함되지 않았습니다. 자동 완료를 위해 test 스크립트가 필요합니다.');
      run.documents.design = `# 설계\n\n${design.summary}\n\n${design.architecture}\n\n## 파일\n${design.files.map(f => '- ' + f).join('\n')}\n\n검증: ${run.scripts.join(', ')}\n배포 폴더: ${design.outputDir}`;
      await artifact(run, 'design.md', run.documents.design); await finish(run, 'design', design.summary);
    }
    checkAbort(signal);
    if (!done(run, 'coding')) {
      await begin(run, 'coding');
      if (run.mode === 'demo') {
        await applyPatch(run, [{ path: 'src/pricing.js', content: demoSource(false) }, { path: 'test/pricing.test.js', content: demoTests }]);
        await finish(run, 'coding', '내장 예제의 계산 함수와 4개 테스트를 작성했습니다. 세금 계산 오류가 있는 예제로 수정 흐름을 검증합니다.');
      } else {
        const patch = await reason(patchSchema, `USER REQUEST:\n${run.prompt}\nREQUIREMENTS:\n${run.documents.requirements}\nDESIGN:\n${run.documents.design}\nSOURCE:\n${await readContext(run)}\nReturn complete contents of every changed/new file. Preserve protected tests and scripts. Include meaningful acceptance tests, and build output ${run.outputDir}/index.html.`, signal);
        await applyPatch(run, patch.files); await freezeValidation(run); await finish(run, 'coding', patch.summary);
      }
    }
    if (!done(run, 'testing')) {
      while (true) {
        checkAbort(signal); await begin(run, 'testing');
        if (run.mode === 'ai') await verifyValidation(run);
        if (run.mode === 'ai' && run.scripts?.includes('build') && run.outputDir !== 'public') {
          await rm(await safePath(workspace(id), run.outputDir!), { recursive: true, force: true });
          await event(run, 'info', '이전 빌드 결과를 지우고 현재 코드에서 배포 파일을 새로 생성합니다.');
        }
        const checks = run.mode === 'demo' ? [await runQuickJS(await readFile(path.join(workspace(id), 'src/pricing.js'), 'utf8'), demoTests, signal)] : await runDockerChecks(workspace(id), run.scripts!, signal, message => { void event(run, 'info', message); });
        run.checks.push(...checks); await artifact(run, 'checks.json', JSON.stringify(run.checks, null, 2));
        if (run.mode === 'ai') await verifyValidation(run);
        let failure = checks.filter(c => c.exitCode !== 0).map(c => `${c.name}\n${c.stdout}\n${c.stderr}`).join('\n');
        if (!failure && run.mode === 'ai') {
          try { await readFile(await safePath(workspace(id), `${run.outputDir}/index.html`)); }
          catch { failure = `정적 배포 산출물 ${run.outputDir}/index.html이 없습니다. build 명령이 이 파일을 만들도록 수정하세요.`; }
        }
        if (!checks.length || !checks.some(c => c.name === 'test' || c.command.includes('QuickJS'))) failure += '\n실제로 수행된 테스트가 없습니다.';
        if (!failure && run.mode === 'ai') {
          const review = await reason(reviewSchema, `Review acceptance criteria against implemented code and real test results. Be critical, approve only if criteria are implemented and meaningfully tested. REQUEST:\n${run.prompt}\nCRITERIA:\n${run.documents.requirements}\nSOURCE:\n${await readContext(run)}\nCHECKS:\n${JSON.stringify(checks).slice(0, 20_000)}`, signal);
          run.review = review.summary; await artifact(run, 'review.md', `${review.summary}\n${review.missingCriteria.join('\n')}`);
          if (!review.approved) failure = `검토에서 발견한 미완료 조건: ${review.missingCriteria.join('; ')}\n${review.summary}`;
        }
        checkAbort(signal);
        if (!failure) { await finish(run, 'testing', '실제 코드 테스트와 완료 조건 검증을 통과했습니다.'); break; }
        const st = run.stages.find(s => s.id === 'testing')!; st.status = 'failed'; st.summary = failure.slice(0, 800);
        await event(run, 'warning', `검증 실패: ${failure.slice(0, 1200)}`);
        if (run.repairCount >= run.maxRepairs) throw new Error(`자동 수정 ${run.maxRepairs}회 한도 내에 검증을 통과하지 못했습니다.`);
        await begin(run, 'repair'); run.repairCount++; await saveRun(run);
        if (run.mode === 'demo') { await applyPatch(run, [{ path: 'src/pricing.js', content: demoSource(true) }]); await finish(run, 'repair', '세금 계산의 뺄셈을 덧셈으로 수정했습니다.'); }
        else {
          const patch = await reason(patchSchema, `Repair failures while preserving existing tests and commands. REQUEST:\n${run.prompt}\nCRITERIA:\n${run.documents.requirements}\nSOURCE:\n${await readContext(run)}\nREAL FAILURE:\n${failure.slice(0, 25_000)}\nReturn changed file full contents. Do not weaken tests.`, signal);
          await applyPatch(run, patch.files); await finish(run, 'repair', patch.summary);
        }
      }
    }
    if (!run.repairCount) { const st = run.stages.find(s => s.id === 'repair')!; st.status = 'skipped'; st.summary = '검증을 통과해 수정이 필요하지 않았습니다.'; }
    checkAbort(signal);
    if (!done(run, 'deploy')) {
      await begin(run, 'deploy');
      if (run.mode === 'demo') await applyPatch(run, [{ path: 'dist/index.html', content: demoHtml(await readFile(path.join(workspace(id), 'src/pricing.js'), 'utf8')) }]);
      await exportDiff(run);
      run.deployment = await deployStatic(run, signal); await finish(run, 'deploy', `${run.deployment!.kind === 'local' ? '로컬 미리보기' : 'Vercel Preview'} 응답을 확인했습니다.`);
    }
    checkAbort(signal); run.status = 'completed'; await event(run, 'success', '모든 개발 단계를 완료했습니다.');
  } catch (error: any) {
    run.error = (signal.aborted ? String(signal.reason?.message || '실행이 중단되었습니다.') : String(error.message || error)).slice(0, 3000);
    run.status = signal.aborted ? 'cancelled' : error instanceof Blocked || error.code === 'DEPLOYMENT_BLOCKED' || /설정|Docker|배포.*불확실|인증정보|토큰|정적|index.html|network|image|daemon/i.test(run.error) ? 'blocked' : 'failed';
    const st = run.stages.find(s => s.id === run.stage)!; if (st.status === 'running') { st.status = 'failed'; st.summary = run.error; }
    await event(run, 'error', run.error);
  } finally { clearTimeout(timeout); active.delete(id); }
}
