import { httpJson } from '@/lib/httpClient';

export interface RunReview { shortlist: string[]; hidden: string[]; notes: Record<string, string>; keep: boolean; updatedAt: string | null; }
const empty = (): RunReview => ({ shortlist: [], hidden: [], notes: {}, keep: false, updatedAt: null });
export async function getRunReview(runId: string): Promise<RunReview> {
  try { return await httpJson<RunReview>(`/api/runs/${encodeURIComponent(runId)}/review`); } catch { return empty(); }
}
export function saveRunReview(runId: string, review: Partial<RunReview>): Promise<RunReview> {
  return httpJson<RunReview>(`/api/runs/${encodeURIComponent(runId)}/review`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(review) });
}
