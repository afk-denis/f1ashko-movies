/** Pure catalog functions. No DOM, network calls, or third-party dependencies. */
export const FIELDS = ['genres', 'years', 'countries', 'actors', 'directors', 'types'];
export const FIELD_LABELS = { genres: 'Жанр', years: 'Год выпуска', countries: 'Страна', actors: 'Актёр', directors: 'Режиссёр', types: 'Формат' };
const GENRE_GROUPS = [
  ['боевик', 'боевики', 'action', 'экшен', 'экшн', 'экшены'],
  ['ужасы', 'ужастики', 'ужастик', 'хоррор', 'хорроры', 'horror'],
  ['комедия', 'комедии', 'comedy', 'комедийный'],
  ['драма', 'драмы', 'drama'],
  ['триллер', 'триллеры', 'thriller'],
  ['фантастика', 'sci-fi', 'sci fi', 'science fiction', 'sci-fi fiction', 'нф'],
  ['фэнтези', 'фентези', 'fantasy'],
  ['мелодрама', 'романтика', 'romance', 'romantic'],
  ['детектив', 'детективы', 'mystery'],
  ['криминал', 'crime', 'криминальный'],
  ['приключения', 'adventure', 'приключенческий'],
  ['мультфильм', 'мультфильмы', 'animation', 'анимация'],
  ['документальный', 'документалка', 'documentary', 'документальные'],
  ['военный', 'war', 'война'],
  ['история', 'исторический', 'history'],
  ['биография', 'биографический', 'biography', 'biopic'],
  ['семейный', 'семейное', 'family'],
  ['вестерн', 'western'], ['спорт', 'sport', 'sports'],
  ['мюзикл', 'musical'], ['музыка', 'music'],
  ['аниме', 'anime'], ['фильм-нуар', 'film noir', 'нуар'],
];
export function normalize(value) {
  return String(value ?? '').normalize('NFKC').toLocaleLowerCase('ru').replaceAll('ё', 'е').replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ');
}
const genreAliases = new Map();
for (const group of GENRE_GROUPS) for (const name of group) genreAliases.set(normalize(name), group);
export function genreInfo(label) {
  const group = genreAliases.get(normalize(label));
  return { key: normalize(group?.[0] || label), label: group?.[0] || String(label).trim(), aliases: group || [label] };
}
export function safeUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : '';
  } catch { return ''; }
}
export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
export function prepareRecords(records) {
  if (!Array.isArray(records)) throw new Error('Неверный формат каталога');
  return records.filter(r => r && typeof r.title === 'string' && r.title.trim()).map((r, index) => {
    const list = key => Array.isArray(r[key]) ? [...new Set(r[key].filter(v => typeof v === 'string').map(v => v.trim()).filter(Boolean))] : [];
    const record = { ...r, id: String(r.id || `row-${index}`), sourceRow: Number(r.sourceRow) || index + 2,
      title: r.title.trim(), type: String(r.type || 'Не указан'),
      year: Number.isInteger(r.year) && r.year >= 1800 && r.year < 2200 ? r.year : null,
      rating: typeof r.rating === 'number' && Number.isFinite(r.rating) && r.rating >= 0 && r.rating <= 10 ? r.rating : null,
      genres: list('genres'), countries: list('countries'), actors: list('actors'), directors: list('directors'),
      watchedAt: /^\d{4}-\d{2}-\d{2}$/.test(r.watchedAt || '') ? r.watchedAt : '',
      watchUrl: safeUrl(r.watchUrl), kinopoiskUrl: safeUrl(r.kinopoiskUrl), posterUrl: safeUrl(r.posterUrl),
    };
    record._values = {
      genres: [...new Map(record.genres.map(g => { const info = genreInfo(g); return [info.key, info]; })).values()],
      years: record.year ? [{ key: String(record.year), label: String(record.year), aliases: [] }] : [],
      types: [{ key: normalize(record.type), label: record.type, aliases: [] }],
    };
    for (const field of ['countries', 'actors', 'directors']) record._values[field] = record[field].map(label => ({ key: normalize(label), label, aliases: [] }));
    record._search = normalize(record.title);
    return record;
  });
}
export function defaultState() {
  return { q: '', filters: Object.fromEntries(FIELDS.map(f => [f, []])), sort: 'watched-desc', page: 1, pageSize: 24, linked: false, view: 'list' };
}
export function matches(record, state, excluded = '') {
  if (state.linked && !record.watchUrl) return false;
  const terms = normalize(state.q).split(' ').filter(Boolean);
  if (!terms.every(term => record._search.includes(term))) return false;
  return FIELDS.every(field => field === excluded || !state.filters[field]?.length || state.filters[field].some(selected => record._values[field].some(v => v.key === selected)));
}
export function filterRecords(records, state, excluded = '') {
  return records.filter(record => matches(record, state, excluded));
}
const collator = new Intl.Collator('ru', { numeric: true, sensitivity: 'base' });
export function sortRecords(records, sort) {
  const result = [...records];
  const descendingNumber = (a, b, field) => (b[field] ?? -Infinity) - (a[field] ?? -Infinity);
  result.sort((a, b) => {
    let value = 0;
    if (sort === 'rating-desc') value = descendingNumber(a, b, 'rating');
    else if (sort === 'year-desc') value = descendingNumber(a, b, 'year');
    else if (sort === 'title-asc') value = collator.compare(a.title, b.title);
    else if (sort === 'watched-asc') value = (a.watchedAt || '9999').localeCompare(b.watchedAt || '9999');
    else value = (b.watchedAt || '').localeCompare(a.watchedAt || '');
    return (Number.isNaN(value) ? 0 : value) || a.sourceRow - b.sourceRow;
  });
  return result;
}
export function buildFacets(records, state) {
  const result = {};
  for (const field of FIELDS) {
    const counts = new Map();
    for (const record of records) for (const value of record._values[field]) {
      if (!counts.has(value.key)) counts.set(value.key, { ...value, count: 0 });
    }
    for (const record of filterRecords(records, state, field)) for (const value of record._values[field]) counts.get(value.key).count++;
    for (const key of state.filters[field] || []) if (!counts.has(key)) counts.set(key, { key, label: key, aliases: [], count: 0, unavailable: true });
    result[field] = [...counts.values()].sort((a, b) => field === 'years' ? Number(b.label) - Number(a.label) : collator.compare(a.label, b.label));
  }
  return result;
}
export function searchOptions(options, query) {
  const terms = normalize(query).split(' ').filter(Boolean);
  return options.filter(option => {
    const text = normalize([option.label, ...(option.aliases || [])].join(' '));
    return terms.every(term => text.includes(term));
  });
}
export function paginate(records, page = 1, pageSize = 24) {
  pageSize = [12, 24, 48, 96].includes(Number(pageSize)) ? Number(pageSize) : 24;
  const totalPages = Math.max(1, Math.ceil(records.length / pageSize));
  page = Math.max(1, Math.min(totalPages, Math.floor(Number(page)) || 1));
  const start = (page - 1) * pageSize;
  return { items: records.slice(start, start + pageSize), page, totalPages, total: records.length, start: records.length ? start + 1 : 0, end: Math.min(start + pageSize, records.length) };
}
export function stateFromQuery(search) {
  const params = new URLSearchParams(search), state = defaultState();
  state.q = (params.get('q') || '').slice(0, 300);
  for (const field of FIELDS) state.filters[field] = [...new Set(params.getAll(field).slice(0, 50).map(v => field === 'genres' ? genreInfo(v).key : normalize(v)).filter(Boolean))];
  if (['watched-desc', 'watched-asc', 'rating-desc', 'year-desc', 'title-asc'].includes(params.get('sort'))) state.sort = params.get('sort');
  state.page = Math.max(1, Math.floor(Number(params.get('page'))) || 1);
  if ([12, 24, 48, 96].includes(Number(params.get('size')))) state.pageSize = Number(params.get('size'));
  state.linked = params.get('linked') === '1';
  state.view = params.get('view') === 'grid' ? 'grid' : 'list';
  return state;
}
export function stateToQuery(state) {
  const params = new URLSearchParams();
  if (state.q.trim()) params.set('q', state.q.trim());
  for (const field of FIELDS) for (const value of state.filters[field] || []) params.append(field, value);
  if (state.sort !== 'watched-desc') params.set('sort', state.sort);
  if (state.page > 1) params.set('page', String(state.page));
  if (state.pageSize !== 24) params.set('size', String(state.pageSize));
  if (state.linked) params.set('linked', '1');
  if (state.view === 'grid') params.set('view', 'grid');
  return params.toString();
}
