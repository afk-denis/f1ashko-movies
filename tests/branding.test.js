import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
const html = readFileSync(new URL('../site/index.html', import.meta.url), 'utf8');
const app = readFileSync(new URL('../site/app.js', import.meta.url), 'utf8');
const css = readFileSync(new URL('../site/compact.css', import.meta.url), 'utf8');
test('requested greeting and local Skyrim background', () => {
  assert.ok(html.includes('Эй, ты. <span>Наконец-то проснулся.</span>'));
  assert.ok(html.includes('./assets/skyrim-awake.jpg'));
  assert.ok(existsSync(new URL('../site/assets/skyrim-awake.jpg', import.meta.url)));
});
test('header uses the exact channel caption', () => {
  assert.ok(html.includes('<span class="brand-caption">АРХИВ кИно</span>'));
  assert.ok(!html.includes('АРХИВ ПРОСМОТРОВ'));
  const hero = html.match(/<div class="hero-copy">([\s\S]*?)<\/section>/)?.[1] || '';
  assert.ok(hero && !hero.includes('F1ASHKO') && !hero.includes('eyebrow'));
});
test('unwanted labels and racing symbols are removed', () => {
  for (const text of ['ВЕСЬ АРХИВ.', 'НА ПОВТОРЕ.', 'АРХИВ СТРИМОВ', 'NIGHT SESSION', 'F1 / REPLAY', 'Несколько значений внутри фильтра', 'Данные из таблицы', 'Фильтры учитывают только заполненные значения.', 'С отметкой проверки API:', 'Каталог сообщества.', 'Новые снимки публикуются по расписанию.', 'data-coverage', 'class="checkered"', 'class="track-strip"', 'class="heading-slash"']) assert.ok(!html.includes(text) && !app.includes(text), text);
});
test('channel palette is gold on neutral black with no skewed typography', () => {
  assert.ok(css.includes('--accent: #f2ac00;'));
  assert.ok(css.includes('--bg: #0b0b0b;'));
  assert.ok(css.includes('font-style: normal;'));
  assert.ok(css.includes('transform: none;'));
  assert.ok(!css.includes('#39ffc5'));
});
test('favicon is self-contained gold F1 on black', () => {
  const svg = readFileSync(new URL('../site/favicon.svg', import.meta.url), 'utf8');
  for (const text of ['<title>F1</title>', '#f2ac00', '#0b0b0b']) assert.ok(svg.includes(text));
  assert.ok(!svg.includes('<text') && !svg.includes('<script') && !svg.includes('<image'));
  assert.ok(html.includes('favicon.svg?v=2'));
});
test('catalog behavior remains passive and controls are kept', () => {
  assert.equal(app.split('await fetch(').length - 1, 1);
  assert.ok(!app.includes('setInterval(') && !html.includes('refresh-button'));
  for (const id of ['title-search', 'filters', 'sort', 'pagination', 'hero-stats']) assert.ok(html.includes('id="' + id + '"'));
});
