import importlib.util
import io
import unittest
import zipfile
from pathlib import Path

spec = importlib.util.spec_from_file_location('export_catalog', Path(__file__).parents[1] / 'scripts' / 'export_catalog.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class ExportTests(unittest.TestCase):
    def test_numeric_metadata_ids_and_years(self):
        self.assertEqual(module.film_year('2011.0'), 2011)
        sheet = {'rows': 3, 'cells': {'A1': 'КП ID', 'B1': 'Год', 'J1': 'Фильм API',
            'A2': '484470.0', 'B2': '2011.0', 'J2': 'ok', 'A3': '12.5'}}
        data = module.metadata_from_sheet(sheet)
        self.assertEqual(list(data), ['484470'])
        self.assertEqual(data['484470']['фильм api'], 'ok')

    def test_scientific_notation_ids_are_exact(self):
        sheet = {'rows': 6, 'cells': {'A1': 'КП ID', 'J1': 'Фильм API',
            'A2': '1.0355286E7', 'J2': 'ok', 'A3': '1.25E0',
            'A4': 'NaN', 'A5': '1E999999', 'A6': '0'}}
        data = module.metadata_from_sheet(sheet)
        self.assertEqual(list(data), ['10355286'])
        self.assertEqual(data['10355286']['фильм api'], 'ok')

    def test_cleared_legacy_genres_not_resurrected(self):
        entry = {'жанры api': 'ужасы', 'фильм api': 'legacy'}
        self.assertEqual(module.genre_values('', entry), [])
        self.assertEqual(module.genre_values('драма', entry), ['драма'])
        entry['фильм api'] = 'ok'
        self.assertEqual(module.genre_values('', entry), ['ужасы'])

    def test_release_year_not_episode(self):
        self.assertEqual(module.film_year('Черное зеркало (2011) 5 сезон 1 серия'), 2011)
        self.assertEqual(module.film_year('Одиссей (мини–сериал 1997)'), 1997)
        self.assertIsNone(module.film_year('Гранд тур 7'))

    def test_dates(self):
        self.assertEqual(module.date_value('46340'), '2026-11-14')
        self.assertEqual(module.date_value('14.11.2026'), '2026-11-14')
        self.assertEqual(module.date_value('nan'), '')
        self.assertEqual(module.date_value('inf'), '')
        self.assertEqual(module.date_value('1', True), '1904-01-02')

    def test_link_security(self):
        self.assertEqual(module.safe_url('javascript:alert(1)'), '')
        self.assertEqual(module.safe_url('https://u:p@example.org/'), '')
        self.assertEqual(module.safe_url('https://example.org/x'), 'https://example.org/x')

    def test_person_separator(self):
        self.assertEqual(module.split_values('Киану Ривз\nКиану Ривз\nКэрри-Энн Мосс'), ['Киану Ривз', 'Кэрри-Энн Мосс'])
        self.assertEqual(module.split_values('ужасы, драма'), ['ужасы', 'драма'])

    def test_merged_link_not_forward_filled_without_merge(self):
        ns = module.NS['s']
        rel = module.NS['r']
        stream = io.BytesIO()
        with zipfile.ZipFile(stream, 'w') as z:
            z.writestr('xl/workbook.xml', f'<workbook xmlns="{ns}" xmlns:r="{rel}"><sheets><sheet name="Example" sheetId="1" r:id="rId1"/></sheets></workbook>')
            z.writestr('xl/_rels/workbook.xml.rels', '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>')
            z.writestr('xl/worksheets/sheet1.xml', f'<worksheet xmlns="{ns}" xmlns:r="{rel}"><sheetData><row r="2"><c r="E2" t="inlineStr"><is><t>Ссылка</t></is></c></row><row r="3"><c r="B3" t="inlineStr"><is><t>B</t></is></c></row><row r="4"><c r="B4" t="inlineStr"><is><t>C</t></is></c></row></sheetData><mergeCells><mergeCell ref="E2:E3"/></mergeCells><hyperlinks><hyperlink ref="E2" r:id="rId1"/></hyperlinks></worksheet>')
            z.writestr('xl/worksheets/_rels/sheet1.xml.rels', '<Relationships><Relationship Id="rId1" Target="https://example.org/record" TargetMode="External"/></Relationships>')
        sheet = module.read_workbook(stream.getvalue())['Example']
        self.assertEqual(sheet['links']['E3'], 'https://example.org/record')
        self.assertNotIn('E4', sheet['links'])

if __name__ == '__main__':
    unittest.main()
