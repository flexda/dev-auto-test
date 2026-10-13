import { defineTool } from 'eve/tools';
import { z } from 'zod';
export default defineTool({
  description: 'Cancel or resume an existing development job when the user requests it. Completed jobs cannot be resumed. Interrupted safe stages also resume automatically after a dashboard restart.',
  inputSchema: z.object({ id: z.string().uuid(), action: z.enum(['cancel', 'resume']) }),
  async execute({ id, action }, ctx) {
    const response = await fetch(`http://127.0.0.1:${Number(process.env.AUTOFORGE_PORT || 4317)}/api/runs/${id}/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', signal: ctx.abortSignal });
    const result = await response.json(); if (!response.ok) throw new Error(result.error); return result;
  },
});
