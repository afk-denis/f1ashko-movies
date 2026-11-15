"""Test the deployed loader using explicitly synthetic successive JSON snapshots.
Clock advancement avoids five-minute waits; it does not call the film API.
"""
import copy
import json
import os
from pathlib import Path
from urllib.parse import quote
from playwright.sync_api import sync_playwright, expect

BASE = os.environ.get('CATALOG_TEST_URL', 'https://d-malashin.github.io/f1ashko-movies/').rstrip('/') + '/'
OUT = Path('test-results')
OUT.mkdir(exist_ok=True)
checks, errors = [], []

def check(name, condition=True):
    if not condition:
        raise AssertionError(name)
    checks.append(name)
    print('PASS:', name, flush=True)

old = {'schemaVersion': 1, 'generatedAt': '2026-11-15T18:00:00Z', 'records': [
    {'id': 'r-' + str(i), 'filmId': str(i + 1), 'title': 'Общий фильм ' + str(i), 'year': 2000,
     'genres': ['драма'], 'countries': ['Россия'], 'actors': [], 'directors': [], 'type': 'Фильм',
     'watchedAt': '2026-11-15', 'rating': 7.0, 'sourceRow': i + 2}
    for i in range(55)
]}
new = copy.deepcopy(old)
new['generatedAt'] = '2026-11-15T19:00:00Z'
new['records'].append({**old['records'][0], 'id': 'r-new', 'filmId': '999', 'title': 'Общий фильм новый', 'sourceRow': 57})

with sync_playwright() as pw:
    browser = pw.chromium.launch(headless=True)
    context = browser.new_context(viewport={'width': 1440, 'height': 1000}, reduced_motion='reduce')
    state = {'data': old, 'fail': False, 'calls': 0}
    def respond(route):
        state['calls'] += 1
        if state['fail']:
            route.fulfill(status=503, body='Temporary test failure')
        else:
            route.fulfill(json=state['data'])
    context.route('**/data/catalog.json*', respond)
    page = context.new_page()
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.clock.install()
    try:
        page.goto(BASE + '?q=' + quote('Общий') + '&genres=' + quote('драма') + '&sort=title-asc&size=12&page=2&view=grid', wait_until='domcontentloaded')
        expect(page.locator('#result-count strong')).to_have_text('55')
        expect(page.locator('#refresh-button')).to_be_enabled()
        expect(page.locator('#pagination [aria-current=page]')).to_have_text('2')
        previous_url = page.url
        state['data'] = new
        page.clock.fast_forward(600100)
        expect(page.locator('#result-count strong')).to_have_text('56')
        expect(page.locator('#hero-stats strong')).to_have_text('56')
        expect(page.locator('#pagination [aria-current=page]')).to_have_text('2')
        expect(page.locator('#title-search')).to_have_value('Общий')
        expect(page.locator('#sort')).to_have_value('title-asc')
        expect(page.locator('#page-size')).to_have_value('12')
        expect(page.locator('#results')).to_have_class('results-grid')
        check('automatic refresh loads a later snapshot without rebuilding or reloading the browser page', state['calls'] >= 2)
        check('refresh preserves title, genre, sorting, page size, page and view', previous_url == page.url)
        expect(page.locator('#refresh-button')).to_be_enabled()
        page.locator('.movie-card').first.evaluate('(node) => node.dataset.retained = "yes"')
        page.locator('#refresh-button').click()
        expect(page.locator('#toast')).to_contain_text('последняя опубликованная версия')
        check('unchanged data do not recreate result nodes', page.locator('[data-retained=yes]').count() == 1)
        expect(page.locator('#refresh-button')).to_be_enabled()
        state['data'] = old
        page.locator('#refresh-button').click()
        expect(page.locator('#load-notice')).to_be_visible()
        expect(page.locator('#result-count strong')).to_have_text('56')
        check('an older CDN snapshot cannot replace newer data')
        expect(page.locator('#refresh-button')).to_be_enabled()
        state['fail'] = True
        page.locator('#refresh-button').click()
        expect(page.locator('#refresh-button')).to_be_enabled()
        expect(page.locator('#load-notice')).to_be_visible()
        expect(page.locator('#result-count strong')).to_have_text('56')
        check('network error keeps current data and filter state', page.url == previous_url)
        state['fail'] = False
        state['data'] = {'schemaVersion': 1, 'generatedAt': '2026-11-15T20:00:00Z', 'records': []}
        page.locator('#refresh-button').click()
        expect(page.locator('#refresh-button')).to_be_enabled()
        expect(page.locator('#result-count strong')).to_have_text('56')
        check('an empty response cannot erase the catalog')
        state['data'] = new
        page.locator('#refresh-button').click()
        expect(page.locator('#load-notice')).to_be_hidden()
        check('successful retry clears the warning')

        offline = browser.new_context()
        offline.add_init_script('localStorage.setItem("f1ashko-public-catalog-v1", ' + json.dumps(json.dumps(new, ensure_ascii=False)) + ');')
        offline.route('**/data/catalog.json*', lambda route: route.fulfill(status=503, body='Unavailable'))
        op = offline.new_page()
        op.on('pageerror', lambda e: errors.append(str(e)))
        op.goto(BASE, wait_until='domcontentloaded')
        expect(op.locator('#result-count strong')).to_have_text('56')
        expect(op.locator('#load-notice')).to_be_visible()
        check('first load can use explicitly labeled cached data when the endpoint is unavailable')
        offline.close()
        check('no JavaScript exceptions in refresh and recovery tests', not errors)
        report = {'status': 'passed', 'mode': 'synthetic snapshots against deployed runtime', 'checks': checks, 'checkCount': len(checks), 'pageErrors': errors}
        (OUT/'refresh-report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2))
        print(json.dumps(report, ensure_ascii=False), flush=True)
    except Exception:
        page.screenshot(path=str(OUT/'refresh-failure.png'), full_page=True)
        raise
    finally:
        browser.close()
