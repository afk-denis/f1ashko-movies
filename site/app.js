import { FIELDS, FIELD_LABELS, prepareRecords, filterRecords, sortRecords, buildFacets, searchOptions, paginate, stateFromQuery, stateToQuery, defaultState, escapeHtml as e, safeUrl } from './catalog.js';

const $ = selector => document.querySelector(selector);
const number = value => new Intl.NumberFormat('ru-RU').format(value);
const plural = (n, forms) => forms[n % 100 >= 11 && n % 100 <= 14 ? 2 : n % 10 === 1 ? 0 : n % 10 >= 2 && n % 10 <= 4 ? 1 : 2];
const dateLabel = value => {
  const date = new Date(`${value}T12:00:00`);
  return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat('ru', { day: 'numeric', month: 'short', year: 'numeric' }).format(date).replace(' г.', '') : 'Дата не указана';
};
const timestampLabel = value => {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat('ru', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(date) : 'неизвестная дата';
};
// Ignore old ?linked=1 links: the recording-only control has been removed.
let state = { ...stateFromQuery(location.search), linked: false };
let records = [], payload = null, facets = {}, filtered = [], loaded = false;
let requestCounter = 0;
const widgets = new Map();
const CACHE_KEY = 'f1ashko-public-catalog-v1';
let toastTimer;
function toast(message) {
  clearTimeout(toastTimer);
  $('#toast').textContent = message;
  $('#toast').hidden = false;
  toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 3500);
}
function commit(push = true) {
  const query = stateToQuery(state);
  const url = `${location.pathname}${query ? `?${query}` : ''}${location.hash}`;
  if (url !== `${location.pathname}${location.search}${location.hash}`) history[push ? 'pushState' : 'replaceState']({}, '', url);
}

class Facet {
  constructor(field) {
    this.field = field;
    this.options = [];
    this.visible = [];
    this.selected = [];
    this.active = -1;
    this.opened = false;
    this.root = document.createElement('div');
    this.root.className = 'facet';
    this.root.innerHTML = `<span class="facet-label" id="${field}-label">${e(FIELD_LABELS[field])}</span>
      <button class="facet-button" id="${field}-button" aria-haspopup="listbox" aria-expanded="false" aria-labelledby="${field}-label ${field}-selection" type="button"><span class="selection-label" id="${field}-selection">Все</span><span class="chevron" aria-hidden="true"></span></button>
      <div class="facet-popover" hidden><input class="facet-input" type="search" id="${field}-search" role="combobox" aria-expanded="false" aria-autocomplete="list" aria-controls="${field}-options" aria-label="Поиск вариантов: ${e(FIELD_LABELS[field])}" placeholder="${field === 'genres' ? 'Жанр или синоним…' : field === 'years' ? 'Например, 1997…' : 'Начните вводить…'}" autocomplete="off">
      <div class="facet-options" id="${field}-options" role="listbox" aria-multiselectable="true" aria-labelledby="${field}-label"></div><div class="facet-limit" hidden></div></div>
      <div class="facet-hint" hidden>Пока не заполнено в таблице</div>`;
    this.button = this.root.querySelector('.facet-button');
    this.selection = this.root.querySelector('.selection-label');
    this.popover = this.root.querySelector('.facet-popover');
    this.input = this.root.querySelector('.facet-input');
    this.list = this.root.querySelector('.facet-options');
    this.limit = this.root.querySelector('.facet-limit');
    this.hint = this.root.querySelector('.facet-hint');
    this.button.addEventListener('click', () => this.opened ? this.close() : this.open());
    this.button.addEventListener('keydown', event => {
      if (['ArrowDown', 'ArrowUp'].includes(event.key) && !this.button.disabled) { event.preventDefault(); this.open(); this.activate(event.key === 'ArrowDown' ? 0 : this.visible.length - 1); }
    });
    this.input.addEventListener('input', () => { this.active = -1; this.renderOptions(); });
    this.input.addEventListener('keydown', event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); this.close(true); }
      else if (['ArrowDown', 'ArrowUp'].includes(event.key)) {
        event.preventDefault();
        this.activate(Math.max(0, Math.min(this.visible.length - 1, this.active + (event.key === 'ArrowDown' ? 1 : -1))));
      } else if (event.key === 'Enter') {
        event.preventDefault();
        const option = this.visible[this.active >= 0 ? this.active : 0];
        if (option) this.toggle(option);
      }
    });
    this.list.addEventListener('click', event => {
      const button = event.target.closest('[data-option]');
      if (!button || button.disabled) return;
      this.active = Number(button.dataset.option);
      this.toggle(this.visible[this.active]);
      this.input.focus({ preventScroll: true });
    });
    this.root.addEventListener('focusout', () => setTimeout(() => { if (this.opened && !this.root.contains(document.activeElement)) this.close(); }, 0));
    document.addEventListener('pointerdown', event => { if (this.opened && !this.root.contains(event.target)) this.close(); });
    $('#filters').append(this.root);
  }
  update(options, selected) {
    this.options = options;
    this.selected = selected;
    this.button.disabled = options.length === 0;
    this.selection.textContent = !options.length ? 'Нет данных' : selected.length === 0 ? 'Все' : selected.length === 1 ? (options.find(o => o.key === selected[0])?.label || selected[0]) : `Выбрано: ${selected.length}`;
    this.selection.title = selected.map(key => options.find(o => o.key === key)?.label || key).join(', ');
    this.hint.hidden = options.length > 0;
    if (this.button.disabled) this.close();
    if (this.opened) this.renderOptions();
  }
  open() {
    if (this.button.disabled) return;
    for (const widget of widgets.values()) if (widget !== this) widget.close();
    this.opened = true;
    this.button.setAttribute('aria-expanded', 'true');
    this.input.setAttribute('aria-expanded', 'true');
    this.popover.hidden = false;
    this.input.value = '';
    this.active = -1;
    this.renderOptions();
    this.input.focus({ preventScroll: true });
  }
  close(focus = false) {
    this.opened = false;
    this.popover.hidden = true;
    this.button.setAttribute('aria-expanded', 'false');
    this.input.setAttribute('aria-expanded', 'false');
    this.input.removeAttribute('aria-activedescendant');
    if (focus) this.button.focus({ preventScroll: true });
  }
  renderOptions() {
    const matches = searchOptions(this.options, this.input.value);
    this.visible = matches.slice(0, 120);
    if (this.active >= this.visible.length) this.active = this.visible.length - 1;
    this.list.innerHTML = this.visible.length ? this.visible.map((option, index) => {
      const selected = this.selected.includes(option.key), disabled = option.count === 0 && !selected;
      return `<button type="button" role="option" tabindex="-1" id="${this.field}-option-${index}" class="facet-option${selected ? ' selected' : ''}${index === this.active ? ' focused' : ''}" data-option="${index}" aria-selected="${selected}"${disabled ? ' disabled aria-disabled="true"' : ''}><span class="option-box" aria-hidden="true">${selected ? '✓' : ''}</span><span class="option-name">${e(option.label)}</span><span class="option-count">${number(option.count)}</span></button>`;
    }).join('') : '<div class="facet-empty">Совпадений нет. Попробуйте другое написание.</div>';
    this.limit.hidden = matches.length <= 120;
    this.limit.textContent = `Показаны первые 120 из ${number(matches.length)}. Уточните запрос.`;
    this.setActiveDescendant();
  }
  setActiveDescendant() {
    if (this.active >= 0 && this.visible[this.active]) this.input.setAttribute('aria-activedescendant', `${this.field}-option-${this.active}`);
    else this.input.removeAttribute('aria-activedescendant');
  }
  activate(index) {
    this.active = index;
    this.list.querySelectorAll('[data-option]').forEach((option, i) => option.classList.toggle('focused', i === index));
    this.setActiveDescendant();
    this.list.children[index]?.scrollIntoView({ block: 'nearest' });
  }
  toggle(option) {
    if (!option || (!option.count && !this.selected.includes(option.key))) return;
    const selected = state.filters[this.field];
    state.filters[this.field] = selected.includes(option.key) ? selected.filter(key => key !== option.key) : [...selected, option.key];
    state.page = 1;
    render(); commit();
  }
}
for (const field of FIELDS) widgets.set(field, new Facet(field));

function genreMarkup(record) {
  const genres = record._values.genres;
  if (!genres.length) return '<span class="missing-genres">Жанры пока не заполнены</span>';
  const shown = genres.slice(0, state.view === 'grid' ? 2 : 3);
  return shown.map(value => `<button class="genre-tag" data-genre="${e(value.key)}" title="Фильтр: ${e(value.label)}">${e(value.label)}</button>`).join('') + (genres.length > shown.length ? `<button class="genre-tag more" data-film="${e(record.id)}" title="Все жанры">+${genres.length - shown.length}</button>` : '');
}
function movieMarkup(record) {
  const meta = [record.type, record.year, record.countries.slice(0, 2).join(', ')].filter(Boolean);
  return `<article class="movie-card" data-record="${e(record.id)}">
    <div class="movie-art" aria-hidden="true"><span class="art-symbol">▶</span><span class="art-year">${record.year || 'КИНО'}</span>${record.posterUrl ? `<img src="${e(record.posterUrl)}" loading="lazy" alt="" referrerpolicy="no-referrer">` : ''}</div>
    <div class="movie-main"><button class="movie-title" data-film="${e(record.id)}">${e(record.title)}</button>
      <div class="movie-meta">${meta.map((item, index) => `${index ? '<span class="dot" aria-hidden="true">·</span>' : ''}<span>${e(item)}</span>`).join('')}<span class="dot" aria-hidden="true">/</span><span title="Дата просмотра на стриме">${e(dateLabel(record.watchedAt))}</span></div>
      <div class="genre-tags">${genreMarkup(record)}</div>
    </div>
    <div class="movie-action"><div class="rating" aria-label="${record.rating === null ? 'Рейтинг не указан' : `Рейтинг Кинопоиска ${record.rating}`}" title="Рейтинг Кинопоиска из таблицы"><strong>${record.rating === null ? '—' : record.rating.toFixed(1)}</strong><span>КП</span></div>
    ${record.watchUrl ? `<a class="watch-link" href="${e(record.watchUrl)}" target="_blank" rel="noopener noreferrer"><span class="play-small" aria-hidden="true">▶</span> Запись <span aria-hidden="true">↗</span></a>` : '<span class="no-recording">Нет ссылки</span>'}</div>
  </article>`;
}
function renderPagination(page) {
  if (page.totalPages < 2) { $('#pagination').innerHTML = ''; return; }
  const candidates = new Set([1, page.totalPages, page.page - 1, page.page, page.page + 1]);
  if (page.page <= 3) [2, 3, 4].forEach(p => candidates.add(p));
  if (page.page >= page.totalPages - 2) [page.totalPages - 1, page.totalPages - 2, page.totalPages - 3].forEach(p => candidates.add(p));
  const pages = [...candidates].filter(p => p >= 1 && p <= page.totalPages).sort((a, b) => a - b);
  let previous = 0;
  let markup = `<button data-page="${page.page - 1}" aria-label="Предыдущая страница" ${page.page === 1 ? 'disabled' : ''}>←</button>`;
  for (const p of pages) {
    if (previous && p - previous > 1) markup += '<span class="ellipsis" aria-hidden="true">…</span>';
    markup += `<button data-page="${p}" aria-label="Страница ${p}"${p === page.page ? ' aria-current="page"' : ''}>${p}</button>`;
    previous = p;
  }
  markup += `<button data-page="${page.page + 1}" aria-label="Следующая страница" ${page.page === page.totalPages ? 'disabled' : ''}>→</button>`;
  $('#pagination').innerHTML = markup;
}
function render() {
  if (!loaded) return;
  facets = buildFacets(records, state);
  for (const field of FIELDS) widgets.get(field).update(facets[field], state.filters[field]);
  filtered = sortRecords(filterRecords(records, state), state.sort);
  const page = paginate(filtered, state.page, state.pageSize);
  state.page = page.page;
  $('#results').className = state.view === 'grid' ? 'results-grid' : 'results-list';
  $('#results').innerHTML = page.items.length ? page.items.map(movieMarkup).join('') : `<div class="empty-state"><div class="empty-symbol" aria-hidden="true">⌕</div><h3>Ничего не нашлось</h3><p>Попробуйте убрать часть фильтров или изменить название. У некоторых просмотров метаданные ещё не заполнены.</p><button class="button secondary" data-reset>Сбросить фильтры</button></div>`;
  $('#results').setAttribute('aria-busy', 'false');
  $('#result-count').innerHTML = `<strong>${number(filtered.length)}</strong> ${plural(filtered.length, ['просмотр', 'просмотра', 'просмотров'])} <span>из ${number(records.length)}</span>`;
  $('#page-range').textContent = `${number(page.start)}–${number(page.end)} из ${number(page.total)}`;
  renderPagination(page);
  let chips = '';
  for (const field of FIELDS) for (const key of state.filters[field]) {
    const label = facets[field].find(option => option.key === key)?.label || key;
    chips += `<button class="active-chip" data-remove-field="${field}" data-remove-key="${e(key)}" aria-label="Убрать фильтр ${e(FIELD_LABELS[field])}: ${e(label)}">${e(label)}<span class="chip-cross" aria-hidden="true">×</span></button>`;
  }
  if (state.q.trim()) chips += `<button class="active-chip" data-clear-query aria-label="Очистить поиск">Поиск: ${e(state.q)}<span class="chip-cross" aria-hidden="true">×</span></button>`;
  $('#active-filters').innerHTML = chips;
  const count = Object.values(state.filters).reduce((sum, list) => sum + list.length, 0);
  $('#mobile-filter-count').textContent = count ? String(count) : '';
  syncControls();
}
function syncControls() {
  if (document.activeElement !== $('#title-search')) $('#title-search').value = state.q;
  $('#sort').value = state.sort;
  $('#page-size').value = String(state.pageSize);
  document.querySelectorAll('[data-view]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.view === state.view)));
}
function reset() {
  clearTimeout(searchTimer);
  const { view, pageSize } = state;
  state = { ...defaultState(), view, pageSize };
  $('#title-search').value = '';
  render(); commit();
}
function renderSourceInformation() {
  const unique = new Set(records.map(r => r.filmId || r.title)).size;
  $('#hero-stats').innerHTML = `<span>Всего в каталоге: <strong>${number(unique)}</strong></span>`;
  const genreCount = records.filter(r => r.genres.length).length;
  const verified = records.filter(r => r.filmVerified).length;
  const missingStaff = records.every(r => !r.actors.length && !r.directors.length && !r.countries.length);
  $('#data-coverage').innerHTML = `<strong>Данные из таблицы</strong>Жанры: ${number(genreCount)} из ${number(records.length)}<progress class="coverage-progress" value="${genreCount}" max="${records.length}" aria-label="Доля просмотров с жанрами"></progress>${missingStaff ? '<p>Страны и участники ещё не загружены. Эти фильтры появятся после заполнения листа «Метаданные».</p>' : '<p>Фильтры учитывают только заполненные значения.</p>'}<p>С отметкой проверки API: ${number(verified)}.</p>`;
  $('#sync-status').textContent = `Данные от ${timestampLabel(payload.generatedAt)} · обновляются автоматически`;
  $('#sync-status').title = 'Таблица публикуется автоматически каждые 10 минут. Возможна задержка GitHub Actions. Открытая вкладка проверяет обновления каждые 5 минут.';
}
function sourceRowUrl(record) {
  const source = safeUrl(payload?.source?.url);
  if (!source) return '';
  const url = new URL(source);
  url.hash = `gid=0&range=B${record.sourceRow}:G${record.sourceRow}`;
  return url.href;
}
function creditMarkup(values) {
  if (!values.length) return '<span class="missing-genres">Пока не заполнено в таблице</span>';
  const first = e(values.slice(0, 12).join(', '));
  return first + (values.length > 12 ? `<details><summary>Ещё ${values.length - 12}</summary><p>${e(values.slice(12).join(', '))}</p></details>` : '');
}
function openRecord(id) {
  const record = records.find(r => r.id === id);
  if (!record) return;
  const source = sourceRowUrl(record);
  $('#dialog-content').innerHTML = `<p class="dialog-eyebrow">${e(record.type.toUpperCase())} / ПРОСМОТР НА СТРИМЕ</p><h2 class="dialog-title" id="dialog-title">${e(record.title)}</h2>
    <p class="dialog-subtitle">Смотрели ${e(dateLabel(record.watchedAt))}${record.rating !== null ? ` · Кинопоиск ${record.rating.toFixed(1)}` : ''}</p>
    <div class="dialog-tags">${record._values.genres.map(g => `<span>${e(g.label)}</span>`).join('') || '<span>Жанры ещё не заполнены</span>'}</div>
    <dl class="dialog-details"><dt>Год выпуска</dt><dd>${record.year || 'Не указан'}</dd><dt>Страны</dt><dd>${creditMarkup(record.countries)}</dd><dt>Режиссёры</dt><dd>${creditMarkup(record.directors)}</dd><dt>Актёры</dt><dd>${creditMarkup(record.actors)}</dd></dl>
    <div class="dialog-actions">${record.watchUrl ? `<a class="button primary" href="${e(record.watchUrl)}" target="_blank" rel="noopener noreferrer">▶ Открыть запись ↗</a>` : '<span class="no-recording">В таблице нет ссылки на запись</span>'}${record.kinopoiskUrl ? `<a class="button secondary" href="${e(record.kinopoiskUrl)}" target="_blank" rel="noopener noreferrer">Кинопоиск ↗</a>` : ''}${source ? `<a class="button secondary" href="${e(source)}" target="_blank" rel="noopener noreferrer">Строка таблицы ↗</a>` : ''}</div>
    <p class="dialog-note">${record.filmVerified ? 'Метаданные фильма получены через API.' : 'Жанры показаны как в таблице; проверка через API ещё не подтверждена.'} Запись открывается на исходной площадке, где может требоваться подписка.</p>`;
  if (!$('#film-dialog').open) $('#film-dialog').showModal();
}

const AUTO_REFRESH_MS = 5 * 60 * 1000;
let lastCheckedAt = 0;
let refreshInFlight = false;
function validCatalog(data) {
  return data?.schemaVersion === 1 && Array.isArray(data.records) && data.records.length > 0 && data.records.length <= 100000 && Number.isFinite(Date.parse(data.generatedAt));
}
async function loadCatalog(force = false, background = false) {
  if (refreshInFlight) return;
  refreshInFlight = true;
  const requestId = ++requestCounter;
  $('#refresh-button').disabled = true;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const url = new URL('./data/catalog.json', import.meta.url);
    // A changing URL prevents an intermediate cache from repeatedly serving an old snapshot.
    url.searchParams.set('refresh', String(Date.now()));
    const response = await fetch(url, { cache: 'no-store', signal: controller.signal, credentials: 'omit' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    if (!validCatalog(data)) throw new Error('Некорректные данные каталога');
    if (requestId !== requestCounter) return;
    if (loaded && Date.parse(data.generatedAt) < Date.parse(payload.generatedAt)) throw new Error('Сервер вернул устаревший снимок');
    const changed = !loaded || data.generatedAt !== payload.generatedAt;
    if (changed) {
      const prepared = prepareRecords(data.records);
      if (!prepared.length) throw new Error('В каталоге нет корректных строк');
      // Preserve a query whose debounce has not fired yet, along with all other controls.
      clearTimeout(searchTimer);
      if (loaded) state.q = $('#title-search').value;
      records = prepared; payload = data; loaded = true;
      try { localStorage.setItem(CACHE_KEY, JSON.stringify(data)); } catch { /* Private mode/quota does not block the catalog. */ }
      renderSourceInformation(); render(); commit(false);
    }
    $('#load-notice').hidden = true;
    if (force) toast(changed ? 'Каталог обновлён' : 'Это последняя опубликованная версия. Изменения таблицы появятся автоматически.');
    document.dispatchEvent(new CustomEvent('catalog:checked', { detail: { changed, generatedAt: data.generatedAt } }));
  } catch (error) {
    if (requestId !== requestCounter) return;
    if (!loaded) {
      try {
        const cached = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
        if (validCatalog(cached)) {
          records = prepareRecords(cached.records); payload = cached; loaded = records.length > 0;
          if (loaded) { renderSourceInformation(); render(); commit(false); }
        }
      } catch { /* Ignore a corrupt cache. */ }
    }
    if (loaded) {
      $('#load-notice').textContent = `Не удалось проверить обновления. Показаны данные от ${timestampLabel(payload.generatedAt)}. Повторим автоматически; фильтры сохранены.`;
      $('#load-notice').hidden = false;
    } else {
      $('#results').setAttribute('aria-busy', 'false');
      $('#results').innerHTML = '<div class="empty-state"><h3>Не удалось загрузить каталог</h3><p>Проверьте подключение или откройте исходную таблицу. Фильмы не заменяются демонстрационными данными.</p><button class="button secondary" data-retry>Повторить</button></div>';
      $('#result-count').textContent = 'Каталог недоступен';
      $('#hero-stats').textContent = 'Каталог временно недоступен';
    }
    if (!background) console.warn('Catalog load failed:', error instanceof Error ? error.message : 'unknown error');
  } finally {
    clearTimeout(timer);
    lastCheckedAt = Date.now();
    refreshInFlight = false;
    if (requestId === requestCounter) $('#refresh-button').disabled = false;
  }
}
function refreshWhenIdle() {
  if (document.hidden || refreshInFlight || Date.now() - lastCheckedAt < AUTO_REFRESH_MS) return;
  // Do not replace a focused result, open dialog, or dropdown while it is being used.
  if ($('#film-dialog').open || [...widgets.values()].some(widget => widget.opened)) return;
  if (document.activeElement && $('#results').contains(document.activeElement)) return;
  void loadCatalog(false, true);
}
setInterval(refreshWhenIdle, AUTO_REFRESH_MS);
document.addEventListener('visibilitychange', refreshWhenIdle);
window.addEventListener('focus', refreshWhenIdle);

let searchTimer;
$('#title-search').addEventListener('input', event => {
  clearTimeout(searchTimer);
  const value = event.target.value;
  searchTimer = setTimeout(() => { state.q = value; state.page = 1; render(); commit(false); }, 130);
});
$('#title-search').addEventListener('keydown', event => { if (event.key === 'Escape') { clearTimeout(searchTimer); state.q = ''; event.target.value = ''; state.page = 1; render(); commit(false); } });
$('#sort').addEventListener('change', event => { state.sort = event.target.value; state.page = 1; render(); commit(); });
$('#page-size').addEventListener('change', event => { state.pageSize = Number(event.target.value); state.page = 1; render(); commit(); });
$('#reset-filters').addEventListener('click', reset);
$('#refresh-button').addEventListener('click', () => loadCatalog(true));
$('#mobile-filters').addEventListener('click', () => {
  const open = $('#filter-panel').classList.toggle('mobile-open');
  $('#mobile-filters').setAttribute('aria-expanded', String(open));
});
$('.view-switch').addEventListener('click', event => { const button = event.target.closest('[data-view]'); if (button) { state.view = button.dataset.view; render(); commit(); } });
$('#active-filters').addEventListener('click', event => {
  const button = event.target.closest('button');
  if (!button) return;
  if (button.hasAttribute('data-clear-query')) { clearTimeout(searchTimer); state.q = ''; $('#title-search').value = ''; }
  else if (button.dataset.removeField) state.filters[button.dataset.removeField] = state.filters[button.dataset.removeField].filter(key => key !== button.dataset.removeKey);
  state.page = 1; render(); commit();
});
$('#results').addEventListener('click', event => {
  const film = event.target.closest('[data-film]'), genre = event.target.closest('[data-genre]');
  if (film) openRecord(film.dataset.film);
  else if (genre) { state.filters.genres = [genre.dataset.genre]; state.page = 1; render(); commit(); }
  else if (event.target.closest('[data-reset]')) reset();
  else if (event.target.closest('[data-retry]')) loadCatalog(true);
});
$('#results').addEventListener('error', event => { if (event.target.tagName === 'IMG') event.target.remove(); }, true);
$('#pagination').addEventListener('click', event => {
  const button = event.target.closest('[data-page]');
  if (!button || button.disabled) return;
  state.page = Number(button.dataset.page); render(); commit();
  $('#catalog').scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
  $('#result-count').setAttribute('tabindex', '-1');
  $('#result-count').focus({ preventScroll: true });
});
$('#close-dialog').addEventListener('click', () => $('#film-dialog').close());
$('#film-dialog').addEventListener('click', event => {
  if (event.target !== $('#film-dialog')) return;
  const rect = event.target.getBoundingClientRect();
  if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) event.target.close();
});
window.addEventListener('popstate', () => { clearTimeout(searchTimer); state = { ...stateFromQuery(location.search), linked: false }; $('#title-search').value = state.q; render(); });
document.addEventListener('keydown', event => {
  if (event.key === '/' && !event.ctrlKey && !event.metaKey && !event.altKey && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName) && !document.activeElement?.isContentEditable && !$('#film-dialog').open) {
    event.preventDefault(); $('#title-search').focus();
  }
});
syncControls();
loadCatalog();
