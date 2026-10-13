import { defineTool } from 'eve/tools';
import { z } from 'zod';
export default defineTool({
  description: 'Read recorded job state, real checks and verified preview URL. Never infer completion from narration.',
  inputSchema: z.object({ id: z.string().uuid() }),
  async execute({ id }, ctx) {
    const response = await fetch(`http://127.0.0.1:${Number(process.env.AUTOFORGE_PORT || 4317)}/api/runs/${id}`, { signal: ctx.abortSignal });
    const result = await response.json(); if (!response.ok) throw new Error(result.error); return result;
  },
});
