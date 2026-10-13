'use strict';

const $ = id => document.getElementById(id);
const STAGES = [
  {id: 'requirements', label: '요구사항', detail: '분석과 정리'},
  {id: 'design', label: '설계', detail: '구조와 계획'},
  {id: 'coding', label: '코딩', detail: '기능 구현'},
  {id: 'testing', label: '테스트', detail: '결과 검증'},
  {id: 'repair', label: '버그 수정', detail: '실패 해결'},
  {id: 'deploy', label: '배포', detail: '결과 전달'},
];
const STATUS = {
  queued: ['실행 대기', 'neutral'], running: ['실행 중', 'running'],
  blocked: ['연결 필요', 'blocked'], failed: ['실행 실패', 'failed'],
  completed: ['완료', 'completed'], cancelled: ['중지됨', 'neutral'],
};
const STAGE_STATUS = {pending: '대기', running: '진행 중', completed: '완료', skipped: '건너뜀', failed: '실패'};
const state = {runs: [], selectedId: null, run: null, health: null, tab: 'activity', fetching: false, timer: null, file: null, fileRequest: 0};

function el(tag, className, text) {
  const result = document.createElement(tag);
  if (className) result.className = className;
  if (text !== undefined && text !== null) result.textContent = String(text);
  return result;
}
function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', '#icon-' + name);
  svg.append(use);
  return svg;
}
function badge(status) {
  const [label, style] = STATUS[status] || [status || '대기', 'neutral'];
  return el('span', 'badge badge-' + style, label);
}
function stageLabel(id) { return STAGES.find(stage => stage.id === id)?.label || id || '작업'; }
function clock(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('ko-KR', {timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false}).format(date);
}
function dateLabel(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('ko-KR', {timeZone: 'Asia/Seoul', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false}).format(date);
}
function safeUrl(value) {
  try { const url = new URL(value, location.origin); return ['http:', 'https:'].includes(url.protocol) ? url.href : null; } catch { return null; }
}
async function api(path, options = {}) {
  const response = await fetch(path, {headers: {'Content-Type': 'application/json'}, ...options});
  const type = response.headers.get('content-type') || '';
  let body;
  try { body = type.includes('json') ? await response.json() : await response.text(); } catch { throw new Error('서버의 응답을 읽을 수 없습니다. 잠시 후 다시 시도해주세요.'); }
  if (!response.ok) {
    const message = typeof body === 'object' && body ? body.error || body.message : body;
    throw new Error(typeof message === 'string' && message ? message : '요청을 처리하지 못했습니다. (' + response.status + ')');
  }
  return body;
}
function notice(message) {
  $('globalNotice').textContent = message || '';
  $('globalNotice').hidden = !message;
}
function updateConnection(prefix, ready, positive, negative, hint) {
  $(prefix + 'State').textContent = ready ? positive : negative;
  $(prefix + 'Dot').className = 'connection-dot ' + (ready ? 'ready' : 'missing');
  $(prefix + 'Hint').textContent = hint;
}
async function loadHealth() {
  try {
    const health = await api('/api/health');
    state.health = health;
    $('serverStatus').textContent = '로컬 서버 연결됨';
    $('serverDot').className = 'status-dot ready';
    updateConnection('model', health.modelConfigured, '연결됨', '연결 필요', health.modelConfigured ? health.model || 'AI 모델 준비 완료' : 'AI API 키를 연결하면 실행할 수 있습니다');
    updateConnection('github', health.githubConfigured, '토큰 연결됨', '공개 저장소 사용', health.githubConfigured ? '설정된 토큰으로 저장소에 접근합니다' : '비공개 저장소 접근에는 GitHub 토큰 필요');
    updateConnection('docker', health.dockerAvailable, '실행 가능', 'Docker 실행 필요', health.dockerAvailable ? '저장소 코드를 격리 환경에서 실행합니다' : 'Docker를 실행한 뒤 새로고침하세요');
    updateConnection('vercel', health.vercelConfigured, '연결됨', '연결 필요', health.vercelConfigured ? '정적 웹 결과물을 배포할 수 있습니다' : '배포 토큰을 연결하면 사용할 수 있습니다');
    if (health.defaultRepository && !$('repository').dataset.edited) $('repository').value = health.defaultRepository;
    updateMode();
  } catch (error) {
    $('serverStatus').textContent = '서버 연결 확인 필요';
    $('serverDot').className = 'status-dot';
    for (const prefix of ['model', 'github', 'docker', 'vercel']) { $(prefix + 'State').textContent = '확인 불가'; $(prefix + 'Hint').textContent = '서버 연결 후 다시 확인하세요'; $(prefix + 'Dot').className = 'connection-dot'; }
    notice('로컬 서버에 연결할 수 없습니다. 서버가 실행 중인지 확인한 뒤 새로고침해주세요.');
  }
}
function updateMode() {
  const demo = new FormData($('taskForm')).get('mode') === 'demo';
  $('repository').required = !demo;
  $('repository').disabled = demo;
  $('branch').disabled = demo;
  $('repositoryRequired').hidden = demo;
  $('modeHelp').textContent = demo ? '내장 예제의 테스트와 자동 수정을 실행합니다. AI는 사용하지 않습니다.' : '실제 AI가 저장소를 분석하고 코드를 작성합니다.';
  $('repositoryHelp').textContent = demo ? '데모는 내장 예제를 사용하며 GitHub 저장소에 접근하지 않습니다.' : '별도 작업 공간에 저장소를 복제해 실행합니다.';
  const vercelOption = $('deploymentTarget').querySelector('option[value="vercel"]');
  vercelOption.disabled = demo;
  if (demo) $('deploymentTarget').value = 'local';
  $('submitLabel').textContent = demo ? '내장 데모 실행' : 'AI 개발 시작';
  $('submitNote').textContent = demo ? 'AI 미사용 · 실제 테스트와 예제 수정 결과를 확인하세요.' : 'AI 모델 연결과 Docker 실행 환경이 필요합니다.';
  updateDeployment();
}
function updateDeployment() {
  $('deploymentHelp').textContent = $('deploymentTarget').value === 'vercel' ? '빌드된 정적 웹 결과물을 배포합니다. Vercel 연결이 필요합니다.' : '실행 결과와 변경 파일을 저장하고 로컬 미리보기를 제공합니다.';
}
function renderPipeline(run) {
  const stages = Array.isArray(run?.stages) ? run.stages : [];
  const result = STAGES.map((stage, index) => {
    const current = stages.find(item => item.id === stage.id);
    const status = current?.status || 'pending';
    const item = el('div', 'stage ' + status);
    item.title = current?.summary || stage.detail;
    item.setAttribute('aria-label', stage.label + ': ' + (STAGE_STATUS[status] || status));
    const number = el('span', 'stage-number');
    if (status === 'completed') number.append(icon('check')); else number.textContent = status === 'failed' ? '!' : String(index + 1).padStart(2, '0');
    item.append(number, el('div', 'stage-name', stage.label), el('div', 'stage-detail', run ? STAGE_STATUS[status] || status : stage.detail));
    return item;
  });
  $('pipeline').replaceChildren(...result);
}
function renderEvents(run) {
  const events = Array.isArray(run?.events) ? run.events : [];
  $('eventCount').textContent = events.length;
  $('activityEmpty').hidden = Boolean(run);
  if (!run) { $('eventList').replaceChildren(); return; }
  if (!events.length) {
    $('eventList').replaceChildren(el('div', 'content-empty', '실행이 준비되면 로그가 여기에 표시됩니다.'));
    return;
  }
  $('eventList').replaceChildren(...events.slice().reverse().map(event => {
    const type = ['error', 'warning'].includes(event.type) ? event.type : 'info';
    const item = el('div', 'event-item ' + type);
    const body = el('div', 'event-body');
    body.append(el('span', 'event-stage', stageLabel(event.stage)), el('p', 'event-message', event.message || ''));
    item.append(el('span', 'event-dot'), body, el('time', 'event-time', clock(event.timestamp)));
    return item;
  }));
}
function emptyContent(message, glyph) {
  const empty = el('div', 'content-empty');
  empty.append(icon(glyph || 'file'), el('p', '', message));
  return empty;
}
function artifactEntries(run) {
  const docs = [];
  if (run?.documents?.requirements) docs.push({path: '__requirements', name: '요구사항 분석', content: run.documents.requirements, kind: '계획 문서'});
  if (run?.documents?.design) docs.push({path: '__design', name: '설계 및 구현 계획', content: run.documents.design, kind: '계획 문서'});
  const files = Array.isArray(run?.files) ? run.files : [];
  return [...docs, ...files.map(path => ({path, name: path, kind: '생성 파일'}))];
}
function renderArtifacts(run) {
  const entries = artifactEntries(run);
  $('fileCount').textContent = entries.length;
  const container = $('artifactContent');
  if (!entries.length) {
    container.replaceChildren(emptyContent('작업에서 생성한 문서와 코드가 여기에 표시됩니다.', 'file'));
    return;
  }
  const list = el('div', 'artifact-list');
  entries.forEach(entry => {
    const button = el('button', 'artifact-button' + (state.file?.path === entry.path ? ' active' : ''));
    button.type = 'button';
    button.append(icon('file'), el('span', '', entry.name), el('small', '', entry.kind));
    button.addEventListener('click', () => openFile(entry));
    list.append(button);
  });
  container.replaceChildren(list);
  if (state.file) {
    const view = el('div', 'file-view');
    view.append(el('div', 'file-view-heading', state.file.name || state.file.path));
    if (state.file.loading) view.append(el('div', 'file-loading', '파일을 불러오는 중입니다…'));
    else view.append(el('pre', 'file-content', state.file.error || state.file.content || '빈 파일입니다.'));
    container.append(view);
  }
}
async function openFile(entry) {
  const request = ++state.fileRequest;
  const id = state.selectedId;
  state.file = {...entry, loading: !entry.content};
  renderArtifacts(state.run);
  if (entry.content) return;
  try {
    const result = await api('/api/runs/' + encodeURIComponent(id) + '/file?path=' + encodeURIComponent(entry.path));
    if (state.selectedId !== id || request !== state.fileRequest) return;
    state.file = {...entry, content: result.content, loading: false};
  } catch (error) {
    if (state.selectedId !== id || request !== state.fileRequest) return;
    state.file = {...entry, error: error.message, loading: false};
  }
  renderArtifacts(state.run);
}
function renderChecks(run) {
  const checks = Array.isArray(run?.checks) ? run.checks : [];
  $('checkCount').textContent = checks.length;
  if (!checks.length) {
    $('checkContent').replaceChildren(emptyContent('실행한 검증 명령과 테스트 결과가 여기에 표시됩니다.', 'terminal'));
    return;
  }
  const list = el('div', 'check-list');
  checks.forEach((check, index) => {
    const item = el('details', 'check-card');
    const summary = el('summary');
    const passed = check.exitCode === 0;
    summary.append(icon('chevron'), el('span', '', check.name || '검증 ' + (index + 1)), el('span', 'badge ' + (passed ? 'badge-completed' : 'badge-failed'), passed ? '통과' : '실패'));
    const duration = Number.isFinite(check.durationMs) ? ' · ' + (check.durationMs / 1000).toFixed(2) + '초' : '';
    const command = el('div', 'check-command', (check.command || '') + ' · 종료 코드 ' + String(check.exitCode ?? '—') + duration);
    const output = el('div', 'check-output');
    const stdout = check.stdout || '';
    const stderr = check.stderr || '';
    output.append(el('pre', '', [stdout, stderr ? '오류 출력\n' + stderr : ''].filter(Boolean).join('\n\n') || '출력 없음'));
    item.append(summary, command, output);
    if (index === checks.length - 1) item.open = true;
    list.append(item);
  });
  $('checkContent').replaceChildren(list);
}
function renderRun() {
  const run = state.run;
  $('runTitle').textContent = run?.title || '실행 워크스페이스';
  const [statusLabel, statusStyle] = run ? STATUS[run.status] || [run.status, 'neutral'] : ['대기 중', 'neutral'];
  $('runStatus').textContent = statusLabel;
  $('runStatus').className = 'badge badge-' + statusStyle;
  const meta = $('runMeta');
  if (run) {
    const mode = el('span', 'badge ' + (run.mode === 'demo' ? 'badge-demo' : 'badge-neutral'), run.mode === 'demo' ? '내장 데모 · AI 미사용' : 'AI 개발');
    const repo = el('span', '', run.mode === 'demo' ? '내장 예제 프로젝트' : run.repository || '저장소');
    repo.prepend(icon(run.mode === 'demo' ? 'terminal' : 'branch'));
    meta.replaceChildren(mode, repo);
  } else {
    const hint = el('span', '', '작업을 시작하면 진행 과정이 표시됩니다');
    hint.prepend(icon('branch'));
    meta.replaceChildren(hint);
  }
  renderPipeline(run);
  const current = run?.stages?.find(stage => stage.id === run.stage);
  $('runSummary').textContent = current?.summary || '';
  $('runSummary').hidden = !current?.summary;
  $('runError').textContent = run?.error || '';
  $('runError').hidden = !run?.error;
  const active = Boolean(run && ['queued', 'running'].includes(run.status));
  const resumable = Boolean(run && ['blocked', 'failed', 'cancelled'].includes(run.status));
  $('runActions').hidden = !run;
  $('cancelButton').hidden = !active;
  $('resumeButton').hidden = !resumable;
  $('repairInfo').textContent = run ? '자동 수정 ' + (run.repairCount || 0) + ' / ' + (run.maxRepairs ?? 0) + '회' : '';
  $('runFooter').textContent = run ? '최근 업데이트 ' + dateLabel(run.updatedAt || run.createdAt) + ' · KST' : '모든 실행 기록은 로컬에 저장됩니다.';
  $('refreshLabel').textContent = active ? '1.5초마다 업데이트' : '실행 기록 저장됨';
  renderEvents(run);
  renderArtifacts(run);
  renderChecks(run);
  document.querySelector('.deployment-result')?.remove();
  if (run?.deployment) {
    const deployment = run.deployment;
    const result = el('div', 'deployment-result');
    result.append(icon('cloud'), el('span', '', deployment.kind === 'vercel' ? 'Vercel 배포 결과' : '로컬 실행 결과'));
    const url = deployment.url && safeUrl(deployment.url);
    if (url) {
      const link = el('a', '', '미리보기 열기 ↗');
      link.href = url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      result.append(link);
    } else if (deployment.status) result.append(el('span', '', deployment.status));
    $('runSummary').after(result);
  }
}
function renderHistory() {
  $('historyCount').textContent = state.runs.length;
  $('navRunCount').textContent = state.runs.length;
  $('historyEmpty').hidden = state.runs.length > 0;
  $('historyList').replaceChildren(...state.runs.map(run => {
    const button = el('button', 'history-item' + (run.id === state.selectedId ? ' selected' : ''));
    button.type = 'button';
    button.setAttribute('aria-label', (run.title || '개발 작업') + ', ' + (STATUS[run.status]?.[0] || run.status));
    const glyph = el('span', 'history-icon');
    glyph.append(icon(run.mode === 'demo' ? 'play' : 'spark'));
    const name = el('div', 'history-name');
    name.append(el('strong', '', run.title || '개발 작업'), el('small', '', (run.mode === 'demo' ? '내장 데모 · AI 미사용' : run.repository || 'AI 개발') + ' · ' + stageLabel(run.stage)));
    button.append(glyph, name, el('time', 'history-date', dateLabel(run.createdAt)), badge(run.status));
    button.addEventListener('click', () => selectRun(run.id, true));
    return button;
  }));
}
async function selectRun(id, scroll = false) {
  state.selectedId = id;
  state.file = null;
  state.fileRequest++;
  state.run = state.runs.find(run => run.id === id) || null;
  renderRun();
  renderHistory();
  if (scroll) document.querySelector('.run-card').scrollIntoView({behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start'});
  try {
    const run = await api('/api/runs/' + encodeURIComponent(id));
    if (state.selectedId !== id) return;
    state.run = run;
    renderRun();
  } catch (error) { notice('실행 정보를 불러오지 못했습니다. ' + error.message); }
  schedulePoll();
}
function schedulePoll() {
  clearTimeout(state.timer);
  const active = state.runs.some(run => ['queued', 'running'].includes(run.status)) || ['queued', 'running'].includes(state.run?.status);
  if (active) state.timer = setTimeout(() => loadRuns(), 1500);
}
async function loadRuns() {
  if (state.fetching) return;
  state.fetching = true;
  const selectedId = state.selectedId;
  try {
    const results = await Promise.allSettled([api('/api/runs'), selectedId ? api('/api/runs/' + encodeURIComponent(selectedId)) : Promise.resolve(null)]);
    if (results[0].status === 'rejected') throw results[0].reason;
    const runs = results[0].value;
    if (!Array.isArray(runs)) throw new Error('실행 목록의 응답 형식이 올바르지 않습니다.');
    state.runs = runs.slice().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    if (selectedId === state.selectedId && results[1].status === 'fulfilled' && results[1].value) state.run = results[1].value;
    if (selectedId === state.selectedId && results[1].status === 'rejected') notice('선택한 실행의 상세 정보를 갱신하지 못했습니다. ' + results[1].reason.message);
    else notice('');
    if (!state.selectedId && state.runs.length) await selectRun(state.runs[0].id);
    renderHistory();
    renderRun();
  } catch (error) { notice('실행 기록을 불러오지 못했습니다. ' + error.message); }
  finally { state.fetching = false; schedulePoll(); }
}
function switchTab(name, focus = false) {
  if (!['activity', 'artifacts', 'checks'].includes(name)) return;
  state.tab = name;
  document.querySelectorAll('.run-tab').forEach(button => {
    const active = button.dataset.tab === name;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', String(active));
    button.tabIndex = active ? 0 : -1;
    $('panel-' + button.dataset.tab).hidden = !active;
    if (focus && active) button.focus();
  });
}
async function runAction(action) {
  if (!state.selectedId) return;
  const button = $(action === 'cancel' ? 'cancelButton' : 'resumeButton');
  const id = state.selectedId;
  button.disabled = true;
  try {
    const run = await api('/api/runs/' + encodeURIComponent(id) + '/' + action, {method: 'POST', body: '{}'});
    if (state.selectedId === id) state.run = run;
    state.runs = state.runs.map(item => item.id === id ? run : item);
    renderRun();
    renderHistory();
    notice('');
    schedulePoll();
    await loadHealth();
  } catch (error) { notice((action === 'cancel' ? '실행 중지' : '이어 실행') + ' 요청을 처리하지 못했습니다. ' + error.message); }
  finally { button.disabled = false; }
}

$('taskForm').addEventListener('submit', async event => {
  event.preventDefault();
  $('formError').hidden = true;
  const data = new FormData(event.currentTarget);
  const demo = data.get('mode') === 'demo';
  const payload = {
    prompt: String(data.get('prompt') || '').trim(), mode: demo ? 'demo' : 'ai',
    repository: demo ? '' : String(data.get('repository') || '').trim(),
    branch: demo ? '' : String(data.get('branch') || '').trim(),
    deploymentTarget: String(data.get('deploymentTarget') || 'local'), maxRepairs: Number(data.get('maxRepairs')),
  };
  if (!payload.prompt || payload.prompt.length < 8) {
    $('formError').textContent = '요구사항을 8자 이상 입력해주세요.';
    $('formError').hidden = false;
    $('prompt').focus();
    return;
  }
  if (!demo && !/^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/?$/i.test(payload.repository)) {
    $('formError').textContent = 'GitHub 저장소 주소를 입력해주세요. 예: https://github.com/owner/repo';
    $('formError').hidden = false;
    $('repository').focus();
    return;
  }
  const button = $('submitButton');
  button.disabled = true;
  button.classList.add('loading');
  $('submitLabel').textContent = '작업을 준비하는 중…';
  try {
    const run = await api('/api/runs', {method: 'POST', body: JSON.stringify(payload)});
    state.selectedId = run.id;
    state.run = run;
    state.file = null;
    state.fileRequest++;
    state.runs = [run, ...state.runs.filter(item => item.id !== run.id)];
    renderRun();
    renderHistory();
    switchTab('activity');
    notice('');
    schedulePoll();
    if (window.innerWidth < 1000) document.querySelector('.run-card').scrollIntoView({behavior: 'smooth', block: 'start'});
  } catch (error) {
    $('formError').textContent = error.message;
    $('formError').hidden = false;
  } finally {
    button.disabled = false;
    button.classList.remove('loading');
    updateMode();
  }
});
$('prompt').addEventListener('input', () => { $('promptCount').textContent = $('prompt').value.length.toLocaleString('ko-KR') + ' / 12,000'; });
$('repository').addEventListener('input', () => { $('repository').dataset.edited = 'true'; });
document.querySelectorAll('input[name="mode"]').forEach(input => input.addEventListener('change', updateMode));
$('deploymentTarget').addEventListener('change', updateDeployment);
$('newTaskButton').addEventListener('click', () => { $('prompt').scrollIntoView({behavior: 'smooth', block: 'center'}); $('prompt').focus({preventScroll: true}); });
$('exampleButton').addEventListener('click', () => {
  const demo = new FormData($('taskForm')).get('mode') === 'demo';
  $('prompt').value = demo ? '내장 주문 금액 계산 예제의 요구사항과 설계를 확인하고, 테스트를 실행해 세금 계산 버그를 자동 수정한 뒤 결과를 검증해주세요.' : '이 저장소에 할 일 관리 웹 앱을 만들어주세요. 할 일 추가, 완료 표시, 삭제와 우선순위 설정이 가능해야 합니다. 모바일에서도 사용하기 편해야 합니다. 핵심 기능의 테스트를 작성하고 로컬 미리보기를 제공해주세요.';
  $('prompt').dispatchEvent(new Event('input'));
  $('prompt').focus();
});
$('cancelButton').addEventListener('click', () => runAction('cancel'));
$('resumeButton').addEventListener('click', () => runAction('resume'));
$('refreshButton').addEventListener('click', async () => {
  $('refreshButton').disabled = true;
  await Promise.allSettled([loadHealth(), loadRuns()]);
  $('refreshButton').disabled = false;
});
document.querySelectorAll('.run-tab').forEach(button => {
  button.addEventListener('click', () => switchTab(button.dataset.tab));
  button.addEventListener('keydown', event => {
    const names = ['activity', 'artifacts', 'checks'];
    let index = names.indexOf(state.tab);
    if (event.key === 'ArrowRight') index = (index + 1) % names.length;
    else if (event.key === 'ArrowLeft') index = (index + names.length - 1) % names.length;
    else if (event.key === 'Home') index = 0;
    else if (event.key === 'End') index = names.length - 1;
    else return;
    event.preventDefault();
    switchTab(names[index], true);
  });
});
document.querySelectorAll('.nav-link').forEach(link => link.addEventListener('click', () => {
  document.querySelectorAll('.nav-link').forEach(item => item.classList.toggle('active', item === link));
}));
document.addEventListener('visibilitychange', () => { if (!document.hidden) loadRuns(); });
window.addEventListener('beforeunload', () => clearTimeout(state.timer));
renderRun();
updateMode();
Promise.allSettled([loadHealth(), loadRuns()]);
