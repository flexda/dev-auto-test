import http from 'node:http';
import path from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import { z } from 'zod';
import { createRun, cancelRun, resumeRun, recoverRuns, startPendingRuns, publicRun, defaultRepository } from './engine.js';
import { initStore, getRun, listRuns, safePath, workspace } from './store.js';
import { model, modelConfigured } from './model.js';
import { dockerAvailable } from './sandbox.js';

const port = Number(process.env.AUTOFORGE_PORT || 4317);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('AUTOFORGE_PORT 값이 잘못되었습니다.');
const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
const allowedOrigins = new Set([...allowedHosts].map(h => `http://${h}`));
const inputSchema = z.object({ prompt: z.string().trim().min(3).max(12000), title: z.string().max(100).optional(), mode: z.enum(['demo', 'ai']).default('ai'), repository: z.string().max(300).default(defaultRepository), branch: z.string().max(200).default(''), maxRepairs: z.number().int().min(0).max(8).default(3), deploymentTarget: z.enum(['local', 'vercel']).default('local') });
const mime: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8' };
function json(res: http.ServerResponse, status: number, value: unknown) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); }
async function body(req: http.IncomingMessage) { let raw = ''; for await (const part of req) { raw += part.toString(); if (Buffer.byteLength(raw) > 25000) throw new Error('요청 크기가 한도를 초과했습니다.'); } return JSON.parse(raw); }
async function staticFile(res: http.ServerResponse, root: string, relative: string, preview = false) {
  const filename = await safePath(root, relative); const info = await stat(filename);
  if (!info.isFile() || info.size > 3_000_000) throw new Error('파일을 표시할 수 없습니다.');
  const headers: Record<string, string> = { 'Content-Type': mime[path.extname(filename)] || 'application/octet-stream', 'Cache-Control': 'no-store' };
  if (preview) headers['Access-Control-Allow-Origin'] = '*';
  headers['Content-Security-Policy'] = preview ? "sandbox allow-scripts; default-src 'self' data: blob:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'none'; form-action 'none'; base-uri 'none'" : "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
  res.writeHead(200, headers); res.end(await readFile(filename));
}
let healthCache: { value: unknown; at: number } | undefined;
const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer');
  try {
    if (!allowedHosts.has(req.headers.host || '')) return json(res, 403, { error: '로컬 주소로만 접속할 수 있습니다.' });
    const url = new URL(req.url || '/', `http://127.0.0.1:${port}`);
    const previewAsset = req.method === 'GET' && /^\/preview\/[a-f0-9-]{36}\//.test(url.pathname);
    if (req.headers.origin && !allowedOrigins.has(req.headers.origin) && !previewAsset) return json(res, 403, { error: '허용되지 않은 요청 출처입니다.' });
    if (req.method === 'GET' && url.pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }
    if (req.method === 'GET' && url.pathname === '/api/health') {
      if (!healthCache || Date.now() - healthCache.at > 10000) healthCache = { at: Date.now(), value: { modelConfigured: modelConfigured(), dockerAvailable: await dockerAvailable(), githubConfigured: Boolean(process.env.GITHUB_TOKEN), vercelConfigured: Boolean(process.env.VERCEL_TOKEN && process.env.VERCEL_PROJECT_ID), model, defaultRepository, supported: 'Node.js 정적 웹 프로젝트', localOnly: true } };
      return json(res, 200, healthCache.value);
    }
    if (url.pathname === '/api/runs') {
      if (req.method === 'GET') return json(res, 200, (await listRuns()).map(publicRun));
      if (req.method === 'POST') { if (!req.headers['content-type']?.startsWith('application/json')) return json(res, 415, { error: 'JSON 요청이 필요합니다.' }); return json(res, 201, await createRun(inputSchema.parse(await body(req)))); }
    }
    const route = /^\/api\/runs\/([a-f0-9-]{36})(?:\/(cancel|resume|file))?$/.exec(url.pathname);
    if (route) {
      const [, id, action] = route;
      if (req.method === 'GET' && !action) return json(res, 200, publicRun(await getRun(id)));
      if (req.method === 'POST' && (action === 'cancel' || action === 'resume')) {
        if (!req.headers['content-type']?.startsWith('application/json')) return json(res, 415, { error: 'JSON 요청이 필요합니다.' });
        return json(res, 200, action === 'cancel' ? await cancelRun(id) : await resumeRun(id));
      }
      if (req.method === 'GET' && action === 'file') {
        const run = await getRun(id); const relative = url.searchParams.get('path') || '';
        if (!run.files.includes(relative)) return json(res, 404, { error: '실행 산출물 목록에 없는 파일입니다.' });
        const filename = await safePath(workspace(id), relative);
        if ((await stat(filename)).size > 4_000_000) return json(res, 413, { error: '파일 크기가 표시 한도를 초과했습니다.' });
        return json(res, 200, { path: relative, content: await readFile(filename, 'utf8') });
      }
    }
    const preview = /^\/preview\/([a-f0-9-]{36})\/(.*)$/.exec(url.pathname);
    if (req.method === 'GET' && preview) {
      const run = await getRun(preview[1]);
      if (!run.outputDir || !['dist', 'out', 'build', 'public'].includes(run.outputDir) || !run.stages.some(s => s.id === 'testing' && s.status === 'completed') || run.deployment?.kind !== 'local' || !['verifying', 'ready'].includes(run.deployment.status)) return json(res, 404, { error: '검증된 배포 결과가 없습니다.' });
      return await staticFile(res, await safePath(workspace(run.id), run.outputDir), decodeURIComponent(preview[2] || 'index.html'), true);
    }
    if (req.method === 'GET' && ['/', '/app.js', '/styles.css'].includes(url.pathname)) return await staticFile(res, path.resolve('public'), url.pathname === '/' ? 'index.html' : url.pathname.slice(1));
    return json(res, 404, { error: '주소를 찾을 수 없습니다.' });
  } catch (error: any) { const status = error.code === 'ENOENT' ? 404 : 400; json(res, status, { error: error instanceof z.ZodError ? '입력값을 확인하세요: ' + error.issues.map(i => i.path.join('.') + ': ' + i.message).join(', ') : String(error.message || error).slice(0, 2000) }); }
});
await initStore(); await recoverRuns();
server.listen(port, '127.0.0.1', () => { console.log(`AutoForge dashboard: http://127.0.0.1:${port}`); startPendingRuns(); });
server.on('error', error => { console.error(error.message); process.exitCode = 1; });
