import type { BranchesResult } from '../branches';

/** Plain-text table for `review-radar branches` and the review_branches tool. */
export function renderBranches(res: BranchesResult): string {
  if (res.branches.length === 0) return 'No open branches or uncommitted work: nothing to review.\n';
  const head = ['Branch', 'P0', 'P1', 'min', 'Trend', 'Top'];
  const body = res.branches.map((b) => {
    const n = (v: number) => (b.error ? '-' : String(v));
    const top = b.error ? `error: ${b.error}` : b.top ? `${b.top.file}:${b.top.line} — ${b.top.message}` : '';
    return [b.name + (b.dirty ? ' *' : ''), n(b.p0), n(b.p1), n(b.estMinutes), b.trend ?? '', top];
  });
  const width = head.map((h, i) => Math.max(h.length, ...body.map((r) => r[i]!.length)));
  const fmt = (r: string[]) =>
    r.map((c, i) => (i === r.length - 1 ? c : i >= 1 && i <= 3 ? c.padStart(width[i]!) : c.padEnd(width[i]!))).join('  ').trimEnd();
  const lines = [fmt(head), ...body.map(fmt)];
  if (res.branches.some((b) => b.dirty)) lines.push('* has uncommitted changes');
  if (res.skipped) lines.push(`${res.skipped} more branches not analysed (raise the limit to include them).`);
  return lines.join('\n') + '\n';
}
