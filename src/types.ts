export const stageLabels = { requirements: '요구사항 분석', design: '설계', coding: '코딩', testing: '테스트', repair: '버그 수정', deploy: '배포' } as const;
export type StageId = keyof typeof stageLabels;
export type Check = { name: string; command: string; exitCode: number; stdout: string; stderr: string; durationMs: number };
export type Run = {
  id: string; title: string; prompt: string; mode: 'demo' | 'ai'; repository: string; branch: string;
  status: 'queued' | 'running' | 'blocked' | 'failed' | 'completed' | 'cancelled'; stage: StageId;
  createdAt: string; updatedAt: string; repairCount: number; maxRepairs: number;
  deploymentTarget: 'local' | 'vercel';
  stages: { id: StageId; label: string; status: 'pending' | 'running' | 'completed' | 'skipped' | 'failed'; attempts: number; summary: string }[];
  events: { timestamp: string; stage: StageId; type: string; message: string }[];
  files: string[]; documents: { requirements?: string; design?: string }; checks: Check[];
  deployment?: { kind: 'local' | 'vercel'; url: string; status: string; id?: string };
  error?: string; outputDir?: string; baseCommit?: string; scripts?: string[];
  protectedScripts?: Record<string, string>; protectedTests?: Record<string, string>;
  acceptanceCriteria?: string[]; context?: string; deploymentIntent?: boolean; review?: string;
};
