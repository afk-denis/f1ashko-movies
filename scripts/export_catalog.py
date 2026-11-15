#!/usr/bin/env python3
"""Read the public Google workbook, preserving hyperlink targets and merged cells.

Standard library only; no Google credentials and no writes to the spreadsheet.
An unsuccessful fetch fails the build rather than publishing a misleading snapshot.
"""
from __future__ import annotations
import argparse
import datetime as dt
import hashlib
import io
import json
import math
import posixpath
import re
import sys
import time
import unicodedata
import urllib.parse
import urllib.request
import zipfile
import xml.etree.ElementTree as ET
from pathlib import Path

DEFAULT_ID = '1BAml2MY-A6zeIyGRDfqEhAX_vIBFW4hNbV0SdNgl_9k'
NS = {'s': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main',
      'r': 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'}
MAX_DOWNLOAD = 30 * 1024 * 1024
ID_OVERRIDES = {
    'одиссей (мини–сериал 1997)': '77183',
    'как витька чеснок вез леху штыря в дом инвалидов (2017)': '909700',
}


def normalize(value: object) -> str:
    return ' '.join(unicodedata.normalize('NFKC', str(value or '')).lower().replace('ё', 'е').split())


def safe_url(value: object) -> str:
    value = str(value or '').strip()
    try:
        url = urllib.parse.urlsplit(value)
        if url.scheme not in ('http', 'https') or not url.hostname or url.username or url.password:
            return ''
        return value
    except ValueError:
        return ''


def split_values(value: object) -> list[str]:
    text = str(value or '').strip()
    parts = re.split(r'[\n;|]' if re.search(r'[\n;|]', text) else ',', text)
    seen: set[str] = set()
    result: list[str] = []
    for part in parts:
        name = ' '.join(part.strip().split())
        key = normalize(name)
        if key and key not in seen:
            seen.add(key)
            result.append(name)
    return result


def xml_root(archive: zipfile.ZipFile, path: str) -> ET.Element:
    data = archive.read(path)
    if b'<!DOCTYPE' in data.upper() or b'<!ENTITY' in data.upper():
        raise ValueError('Unexpected XML declarations')
    return ET.fromstring(data)


def col_number(col: str) -> int:
    value = 0
    for char in col:
        value = value * 26 + ord(char) - 64
    return value


def col_name(value: int) -> str:
    out = ''
    while value:
        value, rem = divmod(value - 1, 26)
        out = chr(65 + rem) + out
    return out


def cells_in_range(ref: str):
    match = re.fullmatch(r'([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?', ref)
    if not match:
        return
    c1, r1, c2, r2 = match.groups()
    a, b = int(r1), int(r2 or r1)
    x, y = col_number(c1), col_number(c2 or c1)
    if (b - a + 1) * (y - x + 1) > 500000:
        raise ValueError('Oversized merged or hyperlink range')
    for row in range(a, b + 1):
        for col in range(x, y + 1):
            yield f'{col_name(col)}{row}'


def relationship_map(archive: zipfile.ZipFile, file: str) -> dict[str, str]:
    directory, base = posixpath.split(file)
    rel_file = f'{directory}/_rels/{base}.rels'
    if rel_file not in archive.namelist():
        return {}
    return {node.attrib['Id']: node.attrib['Target'] for node in xml_root(archive, rel_file)}


def resolve_part(base: str, target: str) -> str:
    if target.startswith('/'):
        return target.lstrip('/')
    return posixpath.normpath(posixpath.join(posixpath.dirname(base), target))


def read_workbook(raw: bytes) -> dict[str, dict]:
    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
        if sum(info.file_size for info in archive.infolist()) > 150 * 1024 * 1024:
            raise ValueError('Workbook uncompressed size is too large')
        strings: list[str] = []
        if 'xl/sharedStrings.xml' in archive.namelist():
            strings = [''.join(item.itertext()) for item in xml_root(archive, 'xl/sharedStrings.xml')]
        wb = xml_root(archive, 'xl/workbook.xml')
        props = wb.find('s:workbookPr', NS)
        date1904 = props is not None and props.attrib.get('date1904') in ('1', 'true')
        relationships = relationship_map(archive, 'xl/workbook.xml')
        result: dict[str, dict] = {}
        for sheet in wb.findall('s:sheets/s:sheet', NS):
            rid = sheet.attrib['{' + NS['r'] + '}id']
            path = resolve_part('xl/workbook.xml', relationships[rid])
            root = xml_root(archive, path)
            cells: dict[str, object] = {}
            for cell in root.findall('.//s:sheetData/s:row/s:c', NS):
                ref = cell.attrib['r']
                kind = cell.attrib.get('t', '')
                node = cell.find('s:v', NS)
                text = node.text if node is not None and node.text else ''
                if kind == 's':
                    value = strings[int(text)] if text else ''
                elif kind == 'inlineStr':
                    node = cell.find('s:is', NS)
                    value = ''.join(node.itertext()) if node is not None else ''
                elif kind == 'e':
                    value = ''
                else:
                    value = text
                cells[ref] = value
            urls = relationship_map(archive, path)
            links: dict[str, str] = {}
            for item in root.findall('s:hyperlinks/s:hyperlink', NS):
                href = urls.get(item.attrib.get('{' + NS['r'] + '}id', ''), '')
                for ref in cells_in_range(item.attrib['ref']):
                    links[ref] = safe_url(href)
            for cell in root.findall('.//s:sheetData/s:row/s:c', NS):
                formula = cell.find('s:f', NS)
                if formula is not None and formula.text:
                    match = re.match(r'(?i)(?:_xlfn\.)?HYPERLINK\(\s*"([^"]+)"', formula.text)
                    if match:
                        links.setdefault(cell.attrib['r'], safe_url(match.group(1)))
            merges = [item.attrib['ref'] for item in root.findall('s:mergeCells/s:mergeCell', NS)]
            # Propagate only inside explicit merged ranges. Same date is not same stream.
            for merged in merges:
                anchor = merged.split(':')[0]
                for ref in cells_in_range(merged):
                    if anchor in cells:
                        cells.setdefault(ref, cells[anchor])
                    if anchor in links:
                        links.setdefault(ref, links[anchor])
            row_count = max((int(re.search(r'\d+', ref).group()) for ref in cells), default=1)
            result[sheet.attrib['name']] = {
                'cells': cells, 'links': links, 'rows': row_count, 'merges': merges,
                'date1904': date1904,
            }
        return result


def date_value(raw: object, date1904: bool = False) -> str:
    text = str(raw or '').strip()
    if not text:
        return ''
    try:
        serial = float(text)
        if not math.isfinite(serial) or serial < 1 or serial > 200000:
            return ''
        base = dt.datetime(1904, 1, 1) if date1904 else dt.datetime(1899, 12, 30)
        return (base + dt.timedelta(days=serial)).date().isoformat()
    except (ValueError, OverflowError):
        pass
    for pattern in ('%d.%m.%Y', '%Y-%m-%d'):
        try:
            return dt.datetime.strptime(text[:10], pattern).date().isoformat()
        except ValueError:
            continue
    return ''


def film_year(value: object) -> int | None:
    text = str(value or '').strip()
    if re.fullmatch(r'(18|19|20|21)\d{2}(?:\.0+)?', text):
        return int(text.split('.')[0])
    for group in re.findall(r'\(([^)]*)\)', text):
        match = re.search(r'\b((?:18|19|20|21)\d{2})\b', group)
        if match:
            return int(match.group(1))
    return None


def metadata_from_sheet(sheet: dict | None) -> dict[str, dict[str, object]]:
    if not sheet:
        return {}
    cells = sheet['cells']
    headers = {normalize(value): re.sub(r'\d', '', ref)
               for ref, value in cells.items() if re.fullmatch(r'[A-Z]+1', ref)}
    if 'кп id' not in headers:
        return {}
    data = {}
    for row in range(2, sheet['rows'] + 1):
        item = {label: cells.get(f'{col}{row}', '') for label, col in headers.items()}
        key = str(item.get('кп id', '')).strip()
        match = re.fullmatch(r'(\d+)(?:\.0+)?', key)
        if match:
            data[match.group(1)] = item
    return data


def genre_values(main: object, entry: dict) -> list[str]:
    # Cleared cells request re-verification; do not resurrect unverified legacy data.
    fallback = entry.get('жанры api', '') if entry.get('фильм api') == 'ok' else ''
    return split_values(main or fallback)


def build_catalog(raw: bytes, sheet_id: str = DEFAULT_ID,
                  sheet_name: str = 'Человек-аук') -> dict:
    workbook = read_workbook(raw)
    if sheet_name not in workbook:
        raise ValueError(f'Sheet {sheet_name!r} not found; available: {list(workbook)}')
    sheet = workbook[sheet_name]
    cells, links = sheet['cells'], sheet['links']
    if 'название' not in normalize(cells.get('B1')) or normalize(cells.get('E1')) != 'запись':
        raise ValueError('Unexpected source schema: expected title in B and recording in E')
    meta = metadata_from_sheet(workbook.get('Метаданные'))
    records, used_ids = [], set()
    for row in range(2, sheet['rows'] + 1):
        title = ' '.join(str(cells.get(f'B{row}', '')).split())
        if not title:
            continue
        source_url = safe_url(links.get(f'B{row}', ''))
        parsed_url = urllib.parse.urlsplit(source_url)
        match = re.match(r'^/(?:film|series)/(\d+)(?:/|$)', parsed_url.path) if parsed_url.hostname in ('kinopoisk.ru', 'www.kinopoisk.ru') else None
        fid = match.group(1) if match else ID_OVERRIDES.get(normalize(title), '')
        entry = meta.get(fid, {})
        genres = genre_values(cells.get(f'G{row}', ''), entry)
        recording_url = safe_url(links.get(f'E{row}', '') or cells.get(f'E{row}', ''))
        watched = date_value(cells.get(f'D{row}', ''), sheet['date1904'])
        identity = f'{fid or normalize(title)}|{title}|{watched}|{recording_url}'
        base_id = hashlib.sha256(identity.encode()).hexdigest()[:14]
        record_id, suffix = base_id, 2
        while record_id in used_ids:
            record_id = f'{base_id}-{suffix}'
            suffix += 1
        used_ids.add(record_id)
        try:
            rating = float(str(cells.get(f'C{row}', '')).replace(',', '.'))
            if not math.isfinite(rating) or not 0 <= rating <= 10:
                rating = None
        except ValueError:
            rating = None
        records.append({
            'id': record_id, 'sourceRow': row, 'title': title, 'filmId': fid,
            'year': film_year(entry.get('год')) or film_year(title),
            'type': str(cells.get(f'F{row}', '')).strip() or 'Не указан',
            'rating': rating, 'watchedAt': watched, 'genres': genres,
            'countries': split_values(entry.get('страны', '')),
            'actors': split_values(entry.get('актеры', '')),
            'directors': split_values(entry.get('режиссеры', '')),
            'posterUrl': safe_url(entry.get('постер url', '')),
            'kinopoiskUrl': (source_url if match else f'https://www.kinopoisk.ru/film/{fid}/' if fid else ''),
            'originalTitleLink': source_url,
            'watchUrl': recording_url,
            'filmVerified': entry.get('фильм api') == 'ok',
            'staffVerified': entry.get('участники api') == 'ok',
        })
    if not records:
        raise ValueError('No records found; refusing to publish an empty catalog')
    stats = {
        'records': len(records),
        'uniqueTitles': len({r['filmId'] or normalize(r['title']) for r in records}),
        'withWatchUrl': sum(bool(r['watchUrl']) for r in records),
        'withGenres': sum(bool(r['genres']) for r in records),
        'withCountries': sum(bool(r['countries']) for r in records),
        'withActors': sum(bool(r['actors']) for r in records),
        'withDirectors': sum(bool(r['directors']) for r in records),
        'apiVerified': sum(bool(r['filmVerified']) for r in records),
    }
    return {
        'schemaVersion': 1,
        'generatedAt': dt.datetime.now(dt.timezone.utc).isoformat(timespec='seconds'),
        'source': {'spreadsheetId': sheet_id, 'sheetName': sheet_name,
                   'url': f'https://docs.google.com/spreadsheets/d/{sheet_id}/edit#gid=0'},
        'stats': stats, 'records': records,
    }


def download_workbook(sheet_id: str) -> bytes:
    if not re.fullmatch(r'[A-Za-z0-9_-]+', sheet_id):
        raise ValueError('Invalid spreadsheet ID')
    url = f'https://docs.google.com/spreadsheets/d/{sheet_id}/export?format=xlsx'
    error = None
    for attempt in range(3):
        try:
            request = urllib.request.Request(url, headers={'User-Agent': 'F1ashkoCatalog/1.0 (read-only)'})
            with urllib.request.urlopen(request, timeout=45) as response:
                raw = response.read(MAX_DOWNLOAD + 1)
            if len(raw) > MAX_DOWNLOAD or not raw.startswith(b'PK'):
                raise ValueError('Expected an XLSX workbook. Check public READ-ONLY link access.')
            return raw
        except (OSError, ValueError) as exc:
            error = exc
            if attempt < 2:
                time.sleep(2 ** attempt)
    raise RuntimeError(f'Cannot read the Google workbook: {error}')


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--sheet-id', default=DEFAULT_ID)
    parser.add_argument('--sheet-name', default='Человек-аук')
    parser.add_argument('--input', type=Path, help='Use an exported workbook for local testing')
    parser.add_argument('--out', type=Path, default=Path('site/data/catalog.json'))
    args = parser.parse_args()
    try:
        raw = args.input.read_bytes() if args.input else download_workbook(args.sheet_id)
        payload = build_catalog(raw, args.sheet_id, args.sheet_name)
        args.out.parent.mkdir(parents=True, exist_ok=True)
        temporary = args.out.with_suffix('.tmp')
        temporary.write_text(json.dumps(payload, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
        temporary.replace(args.out)
        print(json.dumps(payload['stats'], ensure_ascii=False))
        return 0
    except (OSError, ValueError, KeyError, RuntimeError, zipfile.BadZipFile) as exc:
        print(f'Catalog export failed: {exc}', file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
