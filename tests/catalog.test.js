import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { prepareRecords, defaultState, filterRecords, buildFacets, searchOptions, paginate, sortRecords, stateToQuery, stateFromQuery, safeUrl, escapeHtml, normalize } from '../site/catalog.js';
const raw = [
  { id: 'a', title: 'Матрица (1999)', year: 1999, genres: ['боевик', 'фантастика'], countries: ['США'], actors: ['Киану Ривз'], directors: ['Лана Вачовски'], type: 'Фильм', rating: 8.5, watchedAt: '2026-10-01', watchUrl: 'https://boosty.to/x/posts/a', sourceRow: 2 },
  { id: 'b', title: 'Чужой (1979)', year: 1979, genres: ['ужасы', 'фантастика'], countries: ['Великобритания'], actors: ['Сигурни Уивер'], directors: ['Ридли Скотт'], type: 'Фильм', rating: 8.1, watchedAt: '2026-10-02', sourceRow: 3 },
  { id: 'c', title: 'Матрица (1999), повторный просмотр', year: 1999, genres: ['Action', 'экшн'], countries: ['США'], actors: ['Киану Ривз'], directors: ['Лана Вачовски'], type: 'Фильм', rating: 8.5, watchedAt: '2026-10-03', watchUrl: 'https://boosty.to/x/posts/c', sourceRow: 4 },
  { id: 'd', title: '<img src=x onerror=alert(1)>', genres: [], type: 'Шоу', sourceRow: 5 },
];
const rows = prepareRecords(raw);
test('Russian normalization and ё', () => assert.equal(normalize('  Всё — КИНО! '), 'все кино'));
test('Action aliases collapse without duplicate genre options', () => {
  const options = buildFacets(rows, defaultState()).genres;
  assert.equal(options.filter(v => v.label === 'боевик').length, 1);
  assert.equal(options.find(v => v.label === 'боевик').count, 2);
  for (const query of ['acti', 'экшн', 'боев']) assert.equal(searchOptions(options, query)[0].label, 'боевик');
});
test('Horror aliases support partial Russian and English input', () => {
  const options = buildFacets(rows, defaultState()).genres;
  for (const query of ['хорр', 'ужа', 'horr']) assert.equal(searchOptions(options, query)[0].label, 'ужасы');
});
test('OR within a facet and AND between facets', () => {
  const state = defaultState();
  state.filters.genres = ['боевик', 'ужасы'];
  assert.equal(filterRecords(rows, state).length, 3);
  state.filters.years = ['1999'];
  assert.deepEqual(filterRecords(rows, state).map(r => r.id), ['a', 'c']);
  state.filters.actors = ['сигурни уивер'];
  assert.equal(filterRecords(rows, state).length, 0);
});
test('Facet counts exclude the facet itself, not other filters', () => {
  const state = defaultState(); state.filters.genres = ['боевик'];
  assert.equal(buildFacets(rows, state).genres.find(g => g.label === 'ужасы').count, 1);
  state.filters.years = ['1999'];
  assert.equal(buildFacets(rows, state).genres.find(g => g.label === 'ужасы').count, 0);
});
test('Filtering recording URLs and title words', () => {
  const state = defaultState(); state.q = 'МатРИЦА 1999'; state.linked = true;
  assert.equal(filterRecords(rows, state).length, 2);
});
test('Duplicate movies remain separate screenings', () => assert.equal(rows.filter(r => r.year === 1999).length, 2));
test('Absent metadata is not fabricated', () => {
  assert.deepEqual(rows[3].actors, []); assert.deepEqual(rows[3].countries, []); assert.equal(rows[3].year, null);
});
test('Nulls sort last for rating and release year', () => {
  assert.equal(sortRecords(rows, 'rating-desc').at(-1).id, 'd');
  assert.equal(sortRecords(rows, 'year-desc').at(-1).id, 'd');
  assert.equal(sortRecords(rows, 'watched-desc')[0].id, 'c');
});
test('Pagination bounds and empty results', () => {
  const many = Array.from({ length: 53 }, (_, i) => i);
  assert.equal(paginate(many, 99, 24).page, 3); assert.equal(paginate(many, -10, 24).page, 1);
  assert.deepEqual(paginate([], 77, 24), { items: [], page: 1, totalPages: 1, total: 0, start: 0, end: 0 });
});
test('URL state round-trips', () => {
  const state = defaultState(); state.filters.genres = ['боевик', 'ужасы']; state.q = 'Звёздные войны'; state.page = 2; state.pageSize = 48; state.linked = true; state.view = 'grid';
  assert.deepEqual(stateFromQuery(stateToQuery(state)), state);
});
test('URL aliases normalized and invalid parameters rejected', () => {
  const state = stateFromQuery('?genres=Action&genres=экшн&page=-2&size=10000&sort=evil');
  assert.deepEqual(state.filters.genres, ['боевик']); assert.equal(state.page, 1); assert.equal(state.pageSize, 24); assert.equal(state.sort, 'watched-desc');
});
test('Unknown URL selections can be removed', () => {
  const state = defaultState(); state.filters.genres = ['несуществующий жанр'];
  assert.equal(buildFacets(rows, state).genres.find(g => g.key === 'несуществующий жанр').unavailable, true);
});
test('URL and HTML injection are blocked', () => {
  for (const link of ['javascript:alert(1)', 'data:text/html,pwn', 'file:///etc/passwd', 'https://key:secret@example.org/']) assert.equal(safeUrl(link), '');
  assert.equal(safeUrl('https://example.org/x'), 'https://example.org/x');
  assert.equal(escapeHtml('<script>"&\''), '&lt;script&gt;&quot;&amp;&#39;');
});
test('Published dataset has unique screening IDs and safe recording URLs', () => {
  const actual = JSON.parse(readFileSync(new URL('../site/data/catalog.json', import.meta.url), 'utf8'));
  assert.equal(actual.records.length > 0, true);
  for (const row of actual.records) if (row.watchUrl) assert.equal(safeUrl(row.watchUrl), row.watchUrl);
  assert.equal(new Set(actual.records.map(r => r.id)).size, actual.records.length);
});
test('No credentials in public runtime files', () => {
  for (const filename of ['app.js', 'catalog.js', 'index.html', 'data/catalog.json']) {
    const text = readFileSync(new URL(`../site/${filename}`, import.meta.url), 'utf8');
    assert.doesNotMatch(text, /X-API-KEY|KINOPOISK_API_KEY/);
  }
});
