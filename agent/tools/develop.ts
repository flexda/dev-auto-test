import { defineTool } from 'eve/tools';
import { z } from 'zod';
export default defineTool({
  description: 'Start an autonomous development job on GitHub: requirements, design, code, isolated tests, repair and verified preview. Returns job ID. Dashboard server must be running.',
  inputSchema: z.object({ prompt: z.string().min(3).max(12000), repository: z.string().default('https://github.com/flexda/dev-auto-test'), branch: z.string().default(''), deploymentTarget: z.enum(['local', 'vercel']).default('local'), maxRepairs: z.number().int().min(0).max(8).default(3) }),
  async execute(input, ctx) {
    const response = await fetch(`http://127.0.0.1:${Number(process.env.AUTOFORGE_PORT || 4317)}/api/runs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...input, mode: 'ai' }), signal: ctx.abortSignal });
    const result = await response.json(); if (!response.ok) throw new Error(result.error); return result;
  },
});
