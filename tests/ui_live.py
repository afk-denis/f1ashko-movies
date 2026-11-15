"""Read-only Playwright checks against the deployed catalog; no film API calls.
Real-data checks and synthetic cast/director checks are reported separately.
"""
import copy
import json
import os
import re
import unicodedata
from pathlib import Path
from urllib.parse import urljoin
from playwright.sync_api import sync_playwright, expect

BASE = os.environ.get('CATALOG_TEST_URL', 'https://d-malashin.github.io/f1ashko-movies/').rstrip('/') + '/'
OUT = Path(os.environ.get('SCREENSHOT_DIR', 'test-results'))
OUT.mkdir(parents=True, exist_ok=True)
checks, errors, requests = [], [], []

def norm(value):
    value = unicodedata.normalize('NFKC', str(value or '')).lower().replace('ё', 'е')
    return ' '.join(re.sub(r'[^\w]+', ' ', value).replace('_', ' ').split())

def check(name, condition=True):
    if not condition:
        raise AssertionError(name)
    checks.append(name)
    print('PASS:', name, flush=True)

def count(page, expected):
    expect(page.locator('#result-count strong')).to_have_text(re.compile(r'^' + r'[\s\u00a0\u202f]*'.join(str(expected)) + r'$'))

def select(page, field, query, label=None):
    page.locator(f'#{field}-button').click()
    search = page.locator(f'#{field}-search')
    search.fill(query)
    option = page.locator(f'#{field}-options .facet-option').filter(has=page.locator('.option-name', has_text=re.compile('^' + re.escape(label or query) + '$')))
    expect(option).to_have_count(1)
    expect(option).to_be_enabled()
    option.click()
    search.press('Escape')

with sync_playwright() as pw:
    launch = {'headless': True}
    if os.environ.get('CHROMIUM_PATH'):
        launch['executable_path'] = os.environ['CHROMIUM_PATH']
    browser = pw.chromium.launch(**launch)
    context = browser.new_context(viewport={'width': 1440, 'height': 1080}, reduced_motion='reduce')
    context.on('request', lambda r: requests.append({'url': r.url, 'headers': r.headers}))
    page = context.new_page()
    page.on('pageerror', lambda error: errors.append(str(error)))
    try:
        with page.expect_response(lambda r: '/data/catalog.json' in r.url) as response:
            page.goto(BASE + '?ui-check=' + os.environ.get('GITHUB_RUN_ID', 'manual'), wait_until='domcontentloaded')
        data = response.value.json()
        records = data['records']
        expect(page.locator('.movie-card').first).to_be_visible()
        expect(page.locator('body')).to_have_class('night-drive')
        expect(page.locator('link[href*="night.css"]')).to_have_count(1)
        expect(page.locator('link[href*="compact.css"]')).to_have_count(1)
        check('compact night design loaded; real catalog is not empty', len(records) > 0)
        image = context.request.get(urljoin(BASE, 'assets/skyrim-awake.jpg'))
        check('reference scene served by our own Pages host', image.status == 200 and len(image.body()) > 1000)
        count(page, len(records))
        expect(page.locator('#hero-stats strong')).to_have_count(1)
        unique = len({str(r.get('filmId') or r['title']) for r in records})
        hero_count = int(re.sub(r'\D', '', page.locator('#hero-stats strong').inner_text()))
        check('hero has exactly one unique-title counter', hero_count == unique)
        expect(page.locator('.hero-actions, .hero-side-note, #random-button, #recording-only')).to_have_count(0)
        check('CTA, extra buttons and recording-only checkbox are removed')
        expect(page.locator('#hero-title')).to_have_text('Эй, ты. Наконец-то проснулся.')
        expect(page.locator('#hero-title')).to_have_css('text-transform', 'none')
        expect(page.locator('.scene-caption, .filter-footnote, #data-coverage')).to_have_count(0)
        check('requested title and removed copy blocks')
        expect(page.locator('.brand-caption')).to_have_text('АРХИВ кИно')
        expect(page.locator('.brand-caption')).to_have_css('text-transform', 'none')
        expect(page.locator('.hero-copy .eyebrow, .checkered, .track-strip, .heading-slash')).to_have_count(0)
        expect(page.locator('.brand-icon')).to_have_css('transform', 'none')
        expect(page.locator('#hero-title')).to_have_css('font-style', 'normal')
        expect(page.locator('#hero-title')).to_have_css('transform', 'none')
        expect(page.locator('.brand-wordmark')).to_have_css('font-style', 'normal')
        check('channel wording and no racing symbols or skewed typography')
        expect(page.locator('#hero-title span')).to_have_css('color', 'rgb(242, 172, 0)')
        expect(page.locator('.rating strong').first).to_have_css('color', 'rgb(242, 172, 0)')
        expect(page.locator('.brand-icon')).to_have_css('color', 'rgb(242, 172, 0)')
        check('gold banner accents used for title, logo and ratings')

        background = page.locator('.hero-scene').evaluate('(node) => getComputedStyle(node).backgroundImage')
        check('local Skyrim hero background', 'assets/skyrim-awake.jpg' in background)
        icon = context.request.get(urljoin(BASE, 'favicon.svg?v=2'))
        check('black-gold F1 favicon is served locally', icon.status == 200 and '<title>F1</title>' in icon.text() and '#f2ac00' in icon.text())

        check('default pagination renders 24 results', page.locator('.movie-card').count() == min(24, len(records)))
        check('desktop has no horizontal overflow', page.evaluate('document.documentElement.scrollWidth <= innerWidth'))

        page.locator('#genres-button').click()
        for query in ['acti', 'action', 'экшн', 'экшен']:
            page.locator('#genres-search').fill(query)
            expect(page.locator('#genres-options .option-name')).to_have_text(['боевик'])
        check('genre search: acti/action/экшн/экшен resolve to боевик')
        page.locator('#genres-search').press('ArrowDown')
        page.locator('#genres-search').press('Enter')
        page.locator('#genres-search').press('Escape')
        action = [r for r in records if 'боевик' in [norm(g) for g in r.get('genres', [])]]
        count(page, len(action))
        check('genre keyboard selection and result count')
        expect(page.locator('.active-chip').first).to_have_css('color', 'rgb(255, 216, 129)')
        check('selected filters use warm gold instead of teal')
        select(page, 'genres', 'хорр', 'ужасы')
        either = [r for r in records if {'боевик', 'ужасы'} & {norm(g) for g in r.get('genres', [])}]
        count(page, len(either))
        check('multiple values in one filter use OR')
        chosen = next(r for r in either if r.get('countries') and r.get('year'))
        country = chosen['countries'][0]
        select(page, 'countries', country)
        combo = [r for r in either if norm(country) in [norm(c) for c in r.get('countries', [])]]
        count(page, len(combo))
        select(page, 'years', str(chosen['year']))
        combo = [r for r in combo if r.get('year') == chosen['year']]
        count(page, len(combo))
        check('genre + country + year use AND; counts match independent predicate')
        query = page.url
        page.reload(wait_until='domcontentloaded')
        count(page, len(combo))
        check('filter state survives a real browser reload', page.url == query)
        page.locator('[data-remove-field=years]').click()
        count(page, len([r for r in either if norm(country) in [norm(c) for c in r.get('countries', [])]]))
        check('individual filter chip removal')
        page.locator('#reset-filters').click()
        count(page, len(records))
        check('reset clears all selections')

        title = records[0]['title']
        page.locator('#title-search').fill(title.upper())
        expected = [r for r in records if all(t in norm(r['title']) for t in norm(title).split())]
        count(page, len(expected))
        check('case-insensitive multiword title search')
        page.locator('#title-search').press('Escape')
        count(page, len(records))
        check('Escape clears title search')
        for size in [12, 48, 96, 24]:
            page.locator('#page-size').select_option(str(size))
            expect(page.locator('.movie-card')).to_have_count(min(size, len(records)))
        check('all page sizes: 12/24/48/96')
        first_ids = page.locator('.movie-card').evaluate_all('(nodes) => nodes.map(n => n.dataset.record)')
        page.get_by_role('button', name='Следующая страница', exact=True).click()
        expect(page.locator('#pagination [aria-current=page]')).to_have_text('2')
        second_ids = page.locator('.movie-card').evaluate_all('(nodes) => nodes.map(n => n.dataset.record)')
        check('page 2 changes the actual records', not set(first_ids) & set(second_ids))
        page.reload(wait_until='domcontentloaded')
        expect(page.locator('#pagination [aria-current=page]')).to_have_text('2')
        check('pagination survives reload')
        page.locator('#sort').select_option('rating-desc')
        expect(page.locator('#pagination [aria-current=page]')).to_have_text('1')
        ratings = page.locator('.rating strong').all_text_contents()
        numeric = [float(r) for r in ratings if r != '—']
        check('rating sorting and page reset', numeric == sorted(numeric, reverse=True))
        page.go_back(wait_until='domcontentloaded')
        expect(page.locator('#pagination [aria-current=page]')).to_have_text('2')
        check('browser Back restores previous state')
        page.locator('#title-search').fill('zzzz-no-such-film-987654321')
        expect(page.locator('.empty-state')).to_be_visible()
        check('empty results are explicit')
        page.locator('[data-reset]').click()
        count(page, len(records))
        page.locator('[data-view=grid]').click()
        expect(page.locator('#results')).to_have_class('results-grid')
        page.locator('.movie-title').first.click()
        expect(page.locator('#film-dialog')).to_be_visible()
        check('card layout and film dialog')
        page.locator('#close-dialog').click()
        page.locator('[data-view=list]').click()
        for field in ['actors', 'directors']:
            has_data = any(r.get(field) for r in records)
            check(field + ' control reflects available data', page.locator(f'#{field}-button').is_enabled() == has_data)
        page.evaluate('scrollTo(0, 0)')
        page.screenshot(path=str(OUT/'night-desktop.png'), full_page=False)
        check('no page JavaScript exceptions', not errors)

        for width in [320, 390, 768]:
            mobile = browser.new_context(viewport={'width': width, 'height': 844}, is_mobile=True, has_touch=True, reduced_motion='reduce')
            mp = mobile.new_page()
            mp.on('pageerror', lambda error: errors.append(str(error)))
            mp.goto(BASE, wait_until='domcontentloaded')
            expect(mp.locator('.movie-card').first).to_be_visible()
            check(f'no horizontal overflow at {width}px', mp.evaluate('document.documentElement.scrollWidth <= innerWidth'))
            expect(mp.locator('#hero-title')).to_have_text('Эй, ты. Наконец-то проснулся.')
            expect(mp.locator('.brand-caption')).to_have_text('АРХИВ кИно')
            check(f'hero title fits at {width}px', mp.locator('#hero-title').evaluate('(n) => n.scrollWidth <= n.clientWidth + 1'))

            if width == 390:
                mp.screenshot(path=str(OUT/'night-mobile.png'), full_page=False)
            mp.locator('#mobile-filters').click()
            mp.locator('#genres-button').click()
            mp.locator('#genres-search').fill('ужа')
            expect(mp.locator('#genres-options .option-name')).to_have_text(['ужасы'])
            box = mp.locator('.facet-popover:visible').bounding_box()
            check(f'searchable dropdown fits at {width}px', box['x'] >= -1 and box['x'] + box['width'] <= width + 1)
            mp.locator('#genres-options [role=option]').click()
            mp.locator('#genres-search').press('Escape')
            mp.locator('#mobile-filters').click()
            count(mp, sum('ужасы' in [norm(g) for g in r.get('genres', [])] for r in records))
            check(f'mobile filter selection at {width}px')
            mobile.close()

        # Explicitly synthetic: cast/director fields and old linked-only bookmarks.
        fixture = copy.deepcopy(data)
        fixture['records'] = [
            {'id': 'fixture-1', 'title': 'Проверка А', 'year': 2001, 'genres': ['драма'], 'countries': ['Тестландия'], 'actors': ['Пётр Тестов'], 'directors': ['Анна Тестова']},
            {'id': 'fixture-2', 'title': 'Проверка Б', 'year': 2002, 'genres': ['комедия'], 'countries': ['Тестландия'], 'actors': ['Иван Примеров'], 'directors': ['Борис Примеров']},
        ]
        synthetic = browser.new_context(viewport={'width': 1440, 'height': 1080}, reduced_motion='reduce')
        synthetic.route('**/data/catalog.json*', lambda route: route.fulfill(json=fixture))
        sp = synthetic.new_page()
        sp.goto(BASE + '?linked=1', wait_until='domcontentloaded')
        expect(sp.locator('.movie-card')).to_have_count(2)
        check('synthetic: old linked=1 links do not silently hide records', 'linked=' not in sp.url)
        select(sp, 'actors', 'петр', 'Пётр Тестов')
        select(sp, 'directors', 'анна', 'Анна Тестова')
        expect(sp.locator('.movie-title')).to_have_text(['Проверка А'])
        check('synthetic: cast + director filters and е/ё normalization')
        synthetic.close()
        check('browsing never sends an API key or film-detail API request', not any('x-api-key' in r['headers'] or '/api/v2.2/films/' in r['url'] for r in requests))
        check('no browser exceptions across all viewports', not errors)
        report = {'status': 'passed', 'baseUrl': BASE, 'checks': checks, 'checkCount': len(checks), 'catalogStats': data.get('stats'), 'generatedAt': data.get('generatedAt'), 'syntheticOnly': ['cast/director fixture', 'old linked bookmark'], 'pageErrors': errors}
        (OUT/'ui-report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2))
        print(json.dumps(report, ensure_ascii=False), flush=True)
    except Exception:
        page.screenshot(path=str(OUT/'failure.png'), full_page=True)
        raise
    finally:
        browser.close()
