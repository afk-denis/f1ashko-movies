"""Passive-site regression checks. Filename retained for workflow compatibility.
No repeated loads, refresh controls, external API requests or writes are permitted.
"""
import json
import os
from pathlib import Path
from urllib.parse import urlsplit
from playwright.sync_api import sync_playwright, expect

BASE = os.environ.get('CATALOG_TEST_URL', 'https://d-malashin.github.io/f1ashko-movies/').rstrip('/') + '/'
OUT = Path(os.environ.get('SCREENSHOT_DIR', 'test-results'))
OUT.mkdir(parents=True, exist_ok=True)
checks = []
def check(name, ok=True):
    if not ok:
        raise AssertionError(name)
    checks.append(name)
    print('PASS:', name, flush=True)

with sync_playwright() as pw:
    options = {'headless': True}
    if os.environ.get('CHROMIUM_PATH'):
        options['executable_path'] = os.environ['CHROMIUM_PATH']
    browser = pw.chromium.launch(**options)
    context = browser.new_context(viewport={'width': 1440, 'height': 1080})
    requests, errors = [], []
    context.on('request', lambda r: requests.append({'url': r.url, 'method': r.method, 'type': r.resource_type, 'headers': r.headers}))
    page = context.new_page()
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.clock.install()
    page.goto(BASE, wait_until='domcontentloaded')
    expect(page.locator('.movie-card').first).to_be_visible()
    xhr = lambda: [r for r in requests if r['type'] in ['fetch', 'xhr', 'websocket', 'eventsource']]
    check('Exactly one catalog fetch at startup', len(xhr()) == 1)
    check('Request is cacheable, same-origin, without cache-busting query', urlsplit(xhr()[0]['url']).netloc == urlsplit(BASE).netloc and urlsplit(xhr()[0]['url']).path.endswith('/data/catalog.json') and not urlsplit(xhr()[0]['url']).query)
    expect(page.locator('#refresh-button, [data-retry], form')).to_have_count(0)
    check('No refresh, retry or form controls')
    page.locator('#genres-button').click()
    page.locator('#genres-search').fill('acti')
    page.locator('#genres-search').press('ArrowDown')
    page.locator('#genres-search').press('Enter')
    page.locator('#genres-search').press('Escape')
    page.locator('#sort').select_option('rating-desc')
    page.locator('#page-size').select_option('12')
    page.locator('#reset-filters').click()
    page.get_by_role('button', name='Следующая страница', exact=True).click()
    page.locator('[data-view=grid]').click()
    page.locator('.movie-title').first.click()
    page.locator('#close-dialog').click()
    page.locator('#title-search').fill('неттакогофильма1234')
    page.clock.fast_forward(200)
    expect(page.locator('.empty-state')).to_be_visible()
    page.locator('[data-reset]').click()
    check('Search, filters, sorting, pagination and dialogs do not fetch data', len(xhr()) == 1)
    for _ in range(5):
        page.evaluate("window.dispatchEvent(new Event('focus')); document.dispatchEvent(new Event('visibilitychange')); window.dispatchEvent(new Event('online'))")
    page.clock.fast_forward(60 * 60 * 1000)
    check('One hour and repeated focus/visibility/online events do not poll', len(xhr()) == 1)
    check('No write requests or API credentials', all(r['method'] == 'GET' and 'x-api-key' not in r['headers'] and 'authorization' not in r['headers'] for r in requests))
    check('No direct requests to Google Sheets, Apps Script or film API', not any(any(part in r['url'] for part in ['docs.google.com', 'script.google.com', '/api/v1/', '/api/v2.', 'api.github.com']) for r in requests))
    check('No JavaScript exceptions', not errors)
    # Fresh context: one failed initial fetch, no network retries and no retry button.
    offline = browser.new_context()
    offline_requests = []
    offline.route('**/data/catalog.json*', lambda route: route.abort())
    op = offline.new_page()
    op.on('request', lambda r: offline_requests.append(r.url) if '/data/catalog.json' in r.url else None)
    op.clock.install()
    op.goto(BASE, wait_until='domcontentloaded')
    expect(op.locator('.empty-state')).to_be_visible()
    expect(op.locator('[data-retry], #refresh-button')).to_have_count(0)
    op.clock.fast_forward(60 * 60 * 1000)
    check('Failure does not trigger a retry loop', len(offline_requests) == 1)
    report = {'status': 'passed', 'mode': 'passive-static', 'checks': checks, 'checkCount': len(checks), 'dataRequests': xhr(), 'pageErrors': errors}
    (OUT / 'passive-network-report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps({'status':'passed', 'checks':len(checks)}, ensure_ascii=False))
    browser.close()
