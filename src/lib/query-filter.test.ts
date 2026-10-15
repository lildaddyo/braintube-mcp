import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseQueryFilter, queryTopic, applyFilterPrior, inDateWindow } from './query-filter.js';

const NOW = new Date(Date.UTC(2026, 9, 15, 12));
const win = (q: string) => {
  const f = parseQueryFilter(q, NOW);
  return f && { from: f.from?.slice(0, 10) ?? null, to: f.to?.slice(0, 10) ?? null, sources: f.sources };
};

test('month names resolve to the most recent past month, or the given year', () => {
  assert.deepEqual(win('what did I save back in July about jailbreaking AI models?'), { from: '2026-07-01', to: '2026-08-01', sources: [] });
  assert.deepEqual(win('какво запазих през юли за jailbreak на AI модели?'), { from: '2026-07-01', to: '2026-08-01', sources: [] });
  assert.deepEqual(win('the YouTube video from December about rust'), { from: '2025-12-01', to: '2026-01-01', sources: ['youtube'] });
  assert.deepEqual(win('what happened in May 2025'), { from: '2025-05-01', to: '2025-06-01', sources: [] });
  assert.deepEqual(win('хип-хоп миксейпове от YouTube Music в началото на март')?.from, '2026-03-01');
});

test('month words that are ordinary words need a date context', () => {
  assert.equal(win('I may need this'), null);
  assert.equal(win('march madness bracket'), null);
  assert.equal(win('май беше нещо за агенти'), null);
  assert.deepEqual(win('the web page I saved back in May about agent skills'), { from: '2026-05-01', to: '2026-06-01', sources: ['web', 'article'] });
});

test('relative windows', () => {
  assert.deepEqual(win('what did I save last week about agents'), { from: '2026-10-02', to: '2026-10-16', sources: [] });
  assert.deepEqual(win('what did I save yesterday'), { from: '2026-10-14', to: '2026-10-15', sources: [] });
  assert.deepEqual(win('notes from this month on pricing'), { from: '2026-10-01', to: '2026-11-01', sources: [] });
});

test('only explicit source containers count, not topical mentions', () => {
  assert.deepEqual(win('that reel about the AI that reads websites as screenshots')?.sources, ['instagram', 'screenshot']);
  assert.deepEqual(win('my claude chat from april where I tested the MCP tools')?.sources, ['claude']);
  assert.deepEqual(win('чатът ми с Claude от април')?.sources, ['claude']);
  assert.deepEqual(win('the PDF I saved in September about getting LinkedIn posts cited by AI')?.sources, ['pdf', 'document']);
  assert.equal(win('what research did I save about why people skip video ads on YouTube?'), null);
  assert.equal(win('what have I saved about making my website show up in AI search answers'), null);
});

test('queryTopic strips the date, the container and the boilerplate', () => {
  assert.equal(queryTopic('what did I save back in July about jailbreaking AI models?'), 'jailbreaking AI models');
  assert.equal(queryTopic('the web page I saved back in May about how Perplexity builds and maintains agent skills'), 'how Perplexity builds and maintains agent skills');
  assert.equal(queryTopic('the instagram post from early April about Google\'s new open model'), "Google's new open model");
  assert.equal(queryTopic('what did I save yesterday'), 'what did I save yesterday');   // nothing left -> the query itself
});

test('applyFilterPrior boosts relevant in-window rows only', () => {
  const f = parseQueryFilter('what did I save in July about jailbreaks', NOW);
  const rows = [
    { id: 'a', relevance_score: 0.7, created_at: '2026-04-03T10:00:00Z', source_type: 'instagram' },
    { id: 'b', relevance_score: 0.6, created_at: '2026-07-26T10:00:00Z', source_type: 'web' },
    { id: 'c', relevance_score: 0.2, created_at: '2026-07-02T10:00:00Z', source_type: 'web' },
  ];
  assert.deepEqual(applyFilterPrior(rows, f).map(r => r.id), ['b', 'a', 'c']);
  assert.deepEqual(applyFilterPrior(rows, null).map(r => r.id), ['a', 'b', 'c']);
  assert.equal(inDateWindow(f!, '2026-08-01T00:00:00Z'), false);
});

// Edge cases (code-health pass 2026-10-16).
test('year rollover: December windows end in January, "last month" in January is last December', () => {
  assert.deepEqual(win('notes from December 2025'), { from: '2025-12-01', to: '2026-01-01', sources: [] });
  const jan = new Date(Date.UTC(2026, 0, 10, 12));
  const f = parseQueryFilter('what did I save last month', jan);
  assert.equal(f?.from?.slice(0, 10), '2025-12-01');
  assert.equal(f?.to?.slice(0, 10), '2026-01-01');
});

test('the current month is this year, a later month is last year', () => {
  assert.equal(win('what did I save in October')?.from?.slice(0, 10), '2026-10-01');
  assert.equal(win('what did I save in November')?.from?.slice(0, 10), '2025-11-01');
  assert.equal(win('what did I save today')?.from?.slice(0, 10), '2026-10-15');
  assert.equal(win('what did I save today')?.to?.slice(0, 10), '2026-10-16');
});

test('a source-only query has no date window and keeps every row in the window', () => {
  const f = parseQueryFilter('the github repo for vector search', NOW)!;
  assert.deepEqual(f, { from: null, to: null, sources: ['github'] });
  assert.equal(inDateWindow(f, 'not a date'), true);
  assert.equal(inDateWindow({ from: '2026-07-01T00:00:00.000Z', to: '2026-08-01T00:00:00.000Z', sources: [] }, 'not a date'), false);
  assert.equal(inDateWindow({ from: '2026-07-01T00:00:00.000Z', to: '2026-08-01T00:00:00.000Z', sources: [] }, new Date(Date.UTC(2026, 6, 31, 23))), true);
});

test('applyFilterPrior: source boost, unscored rows leave the order alone, ties keep their order', () => {
  const f = parseQueryFilter('the PDF about pricing', NOW);
  const rows = [
    { id: 'a', relevance_score: 0.6, source_type: 'web' },
    { id: 'b', relevance_score: 0.55, source_type: 'pdf' },
    { id: 'c', relevance_score: 0.55, source_type: 'web' },
    { id: 'd', relevance_score: 0.55, source_type: 'web' },
  ];
  assert.deepEqual(applyFilterPrior(rows, f).map(r => r.id), ['b', 'a', 'c', 'd']);
  const partial = [{ id: 'x', relevance_score: 0.2 }, { id: 'y', relevance_score: null, source_type: 'pdf' }];
  assert.deepEqual(applyFilterPrior(partial, f).map(r => r.id), ['x', 'y']);
});

test('queryTopic handles Bulgarian date phrases and keeps the query when nothing is left', () => {
  assert.equal(queryTopic('какво запазих през юли за jailbreak на AI модели?'), 'какво запазих за jailbreak на AI модели');
  assert.equal(queryTopic('the PDF'), 'the PDF');
});
