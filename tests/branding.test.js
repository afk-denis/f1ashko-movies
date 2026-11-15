import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
const html = readFileSync(new URL('../site/index.html', import.meta.url), 'utf8');
const app = readFileSync(new URL('../site/app.js', import.meta.url), 'utf8');
test('requested hero text and local Skyrim background', () => {
  assert.ok(html.includes('АРХИВ <span>кИно</span>'));
  assert.ok(html.includes('./assets/skyrim-awake.jpg'));
  assert.ok(existsSync(new URL('../site/assets/skyrim-awake.jpg', import.meta.url)));
});
test('unwanted labels are removed from markup and JavaScript', () => {
  for (const text of ['ВЕСЬ АРХИВ.', 'НА ПОВТОРЕ.', 'АРХИВ СТРИМОВ', 'NIGHT SESSION', 'F1 / REPLAY', 'Несколько значений внутри фильтра', 'Данные из таблицы', 'Фильтры учитывают только заполненные значения.', 'С отметкой проверки API:', 'Каталог сообщества.', 'Новые снимки публикуются по расписанию.', 'data-coverage']) assert.ok(!html.includes(text) && !app.includes(text), text);
});
test('favicon is original self-contained gold F1 on black', () => {
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
