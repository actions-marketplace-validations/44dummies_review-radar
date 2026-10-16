import type { RiskMap } from '../types';
import { renderTerminal } from './terminal';
import { renderMarkdown, COMMENT_MARKER } from './markdown';
import { renderJson } from './json';
import { renderSarif } from './sarif';
import { renderPrGuide } from './guide';
import { renderBranches } from './branches';

export type Format = 'terminal' | 'md' | 'json' | 'sarif';
export const FORMATS: Format[] = ['terminal', 'md', 'json', 'sarif'];

export function render(map: RiskMap, format: Format, opts: { color?: boolean } = {}): string {
  switch (format) {
    case 'terminal': return renderTerminal(map, opts);
    case 'md': return renderMarkdown(map);
    case 'json': return renderJson(map);
    case 'sarif': return renderSarif(map);
  }
}

export { renderTerminal, renderMarkdown, renderJson, renderSarif, renderPrGuide, renderBranches, COMMENT_MARKER };
