"""Prevent the correctness suite from accepting the reported silent failures."""
import contextlib
import copy
import importlib.util
import io
import json
from pathlib import Path
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[3]
SPEC = importlib.util.spec_from_file_location('correctness_under_test', ROOT / 'local-bench/correctness.py')
SUITE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(SUITE)


def grounded_document():
    fields = []
    for key, value in SUITE.EXPECTED.items():
        latest = key.startswith('latest')
        period = 'Sep 2026' if latest else 'Jun 2026'
        fields.append({'path': key, 'value': value, 'period': period, 'column': 13 if latest else 12,
                       'row': 'header' if 'Quarter' in key else 'Net Profit +' if 'NetProfit' in key else 'Sales +',
                       'raw': str(value)})
    return {'json': copy.deepcopy(SUITE.EXPECTED), 'metadata': {'extractionGrounding': {
        'method': 'deterministic-quarterly-table', 'status': 'row-column-verified',
        'periods': ['Sep 2026', 'Jun 2026'], 'inputTruncated': False, 'fields': fields}}}


def transformed_document(converted_fields):
    doc = grounded_document()
    doc['metadata']['extractionGrounding']['status'] = 'row-column-and-unit-verified'
    for field in doc['metadata']['extractionGrounding']['fields']:
        key = field['path']
        if key not in SUITE.MONEY_FIELDS:
            continue
        field.update(sourceValue=SUITE.EXPECTED[key], sourceUnit='INR_crore',
                     outputUnit='INR_rupee' if key in converted_fields else 'INR_crore')
        if key in converted_fields:
            field['value'] *= 10000000
            field['conversion'] = {'operation': 'multiply', 'factor': 10000000, 'exact': True}
            doc['json'][key] = field['value']
    return doc


class CorrectnessTests(unittest.TestCase):
    def test_all_four_money_fields_convert_with_distinct_source_proof(self):
        doc = transformed_document(SUITE.MONEY_FIELDS)
        evidence = SUITE.validate_grounding(doc, SUITE.RUPEES, SUITE.MONEY_FIELDS)
        self.assertEqual(evidence['exact_facts'], {
            'latestQuarter': 'Sep 2026', 'latestSales': 217940000000, 'latestNetProfit': 4110000000,
            'previousQuarter': 'Jun 2026', 'previousSales': 155480000000, 'previousNetProfit': 7180000000})
        self.assertEqual(evidence['exact_multiplier'], 10000000)
        # Reproduces the retest's silent unscaled-answer regression.
        doc['json']['latestSales'] = 21794
        with self.assertRaisesRegex(SUITE.CheckFailed, 'six_facts'):
            SUITE.validate_grounding(doc, SUITE.RUPEES, SUITE.MONEY_FIELDS)

    def test_converted_answer_requires_original_cell_and_exact_arithmetic_metadata(self):
        mutations = [
            ('sourceValue', 217940000000), ('sourceUnit', 'INR_rupee'), ('outputUnit', 'INR_crore'),
            ('raw', '217940000000'), ('column', 1), ('period', 'Sep 2024'),
            ('conversion', {'operation': 'multiply', 'factor': 100000, 'exact': True}),
            ('conversion', {'operation': 'multiply', 'factor': 10000000, 'exact': False}),
            ('conversion', {'operation': 'multiply', 'factor': 10000000, 'exact': 1}),
        ]
        for key, value in mutations:
            with self.subTest(key=key, value=value):
                doc = transformed_document(SUITE.MONEY_FIELDS)
                field = next(item for item in doc['metadata']['extractionGrounding']['fields'] if item['path'] == 'latestSales')
                field[key] = value
                with self.assertRaises(SUITE.CheckFailed):
                    SUITE.validate_grounding(doc, SUITE.RUPEES, SUITE.MONEY_FIELDS)
        doc = transformed_document(SUITE.MONEY_FIELDS)
        doc['metadata']['extractionGrounding']['status'] = 'row-column-verified'
        with self.assertRaisesRegex(SUITE.CheckFailed, 'grounding_contract'):
            SUITE.validate_grounding(doc, SUITE.RUPEES, SUITE.MONEY_FIELDS)

    def test_mixed_per_field_units_do_not_scale_unrequested_money_fields(self):
        doc = transformed_document(SUITE.MIXED_FIELDS)
        self.assertEqual(SUITE.validate_grounding(doc, SUITE.MIXED, SUITE.MIXED_FIELDS)['converted_fields'],
                         ['latestSales', 'previousSales'])
        self.assertEqual(doc['json']['latestNetProfit'], 411)
        field = next(item for item in doc['metadata']['extractionGrounding']['fields'] if item['path'] == 'latestNetProfit')
        field['conversion'] = {'operation': 'multiply', 'factor': 10000000, 'exact': True}
        with self.assertRaisesRegex(SUITE.CheckFailed, 'unexpected_conversion'):
            SUITE.validate_grounding(doc, SUITE.MIXED, SUITE.MIXED_FIELDS)

    def test_ambiguous_conversion_is_a_typed_rejection_not_an_unscaled_success(self):
        with patch.object(SUITE, 'scrape', return_value=(500, {'success': False, 'code': 'LOCAL_EXTRACTION_GROUNDING_FAILED'})):
            self.assertFalse(SUITE.quarterly_ambiguous_units()['fabricated_json'])
        for response in [(200, {'success': True, 'data': grounded_document()}),
                         (500, {'success': False, 'code': 'UNKNOWN_ERROR'})]:
            with patch.object(SUITE, 'scrape', return_value=response), self.assertRaises(SUITE.CheckFailed):
                SUITE.quarterly_ambiguous_units()

    def test_live_acceptance_builds_conversion_and_mixed_field_requests(self):
        for operation, fields, expected_prompt in [
            (SUITE.quarterly_rupees, SUITE.MONEY_FIELDS, SUITE.CONVERT_PROMPT),
            (SUITE.quarterly_mixed_units, SUITE.MIXED_FIELDS, SUITE.MIXED_PROMPT),
        ]:
            with patch.object(SUITE, 'scrape', return_value=(200, {'success': True, 'data': transformed_document(fields)})) as scrape:
                operation()
            path, formats = scrape.call_args.args
            self.assertEqual(path, '/quarterly-results.html')
            self.assertEqual(formats[0], 'markdown')
            self.assertEqual(formats[1]['prompt'], expected_prompt)
            self.assertEqual(formats[1]['schema']['required'], list(SUITE.EXPECTED))

    def test_quarterly_wrong_old_column_and_unverified_values_fail(self):
        doc = grounded_document()
        self.assertEqual(SUITE.validate_grounding(doc)['grounding_fields'], 6)
        doc['json']['latestSales'] = 12688
        with self.assertRaisesRegex(SUITE.CheckFailed, 'six_facts'):
            SUITE.validate_grounding(doc)
        doc = grounded_document()
        doc['metadata']['extractionGrounding']['fields'][0]['period'] = 'Sep 2024'
        with self.assertRaisesRegex(SUITE.CheckFailed, 'cell_evidence'):
            SUITE.validate_grounding(doc)

    def test_pdf_claiming_two_pages_while_leaking_nine_fails(self):
        first_two = '\n'.join(SUITE.pdf_marker(page) for page in (1, 2))
        doc = {'markdown': first_two, 'html': first_two, 'metadata': {'numPages': 2, 'totalPages': 9}}
        self.assertEqual(SUITE.validate_pdf(doc, 2)['numPages'], 2)
        doc['html'] += SUITE.pdf_marker(9)
        with self.assertRaisesRegex(SUITE.CheckFailed, 'page_boundary'):
            SUITE.validate_pdf(doc, 2)
        doc['html'] = first_two
        doc['metadata']['numPages'] = 20
        with self.assertRaisesRegex(SUITE.CheckFailed, 'metadata'):
            SUITE.validate_pdf(doc, 2)

    def test_code_literal_operator_and_multiline_bracket_corruption_fail(self):
        md = ('code-fidelity-marker-7431\n\n```python\n' + SUITE.PYTHON_CODE + '```\n\n'
              '```jsx\n' + SUITE.JSX_CODE + '\n```\n\n`a < b && c >= 0` and `&lt;`')
        self.assertTrue(SUITE.validate_code({'markdown': md})['inline_operators_exact'])
        for broken in (md.replace('values = [\n', 'values = [\\\n'), md.replace('n < 3', 'n &lt; 3'),
                       md.replace('>Next & more', '>Next &amp; more'), md.replace('`&lt;`', '`<`')):
            with self.assertRaises(SUITE.CheckFailed):
                SUITE.validate_code({'markdown': broken})

    def test_loading_only_and_rendered_content_use_actual_connector_checks(self):
        # The API HTTP200 is deliberately identical. Only useful content differs.
        loading = {'metadata': {'statusCode': 200}, 'markdown': '# Market prices\n\n| Symbol | Price |\n| --- | --- |\n| Loading… | |\n'}
        ready = {'metadata': {'statusCode': 200}, 'markdown': '# Market prices\n\n| Symbol | Price |\n| --- | --- |\n| NIFTY 50 | 12345.67 |\n'}
        with patch.object(SUITE, 'scrape', return_value=(200, {'success': True, 'data': loading})):
            self.assertEqual(SUITE.content_readiness()['content_status'], 'incomplete')
            with self.assertRaisesRegex(SUITE.CheckFailed, 'not_ready'):
                SUITE.content_readiness(True)
        with patch.object(SUITE, 'scrape', return_value=(200, {'success': True, 'data': ready})):
            self.assertEqual(SUITE.content_readiness(True)['content_status'], 'checked')

    def test_negative_requires_typed_error_and_no_json(self):
        failure = (500, {'success': False, 'code': 'LOCAL_EXTRACTION_GROUNDING_FAILED'})
        with patch.object(SUITE, 'scrape', return_value=failure):
            self.assertFalse(SUITE.quarterly_unsupported()['fabricated_json'])
        for bad in [(200, {'success': True, 'data': {'json': SUITE.EXPECTED}}),
                    (500, {'success': False, 'code': 'UNKNOWN_ERROR'}),
                    (500, {'success': False, 'code': 'LOCAL_EXTRACTION_GROUNDING_FAILED', 'data': {'json': {'latestSales': 42}}})]:
            with patch.object(SUITE, 'scrape', return_value=bad), self.assertRaises(SUITE.CheckFailed):
                SUITE.quarterly_unsupported()

    def test_stdout_does_not_echo_untrusted_exception_text(self):
        stream = io.StringIO()
        with contextlib.redirect_stdout(stream):
            result = SUITE.run_check('safe-test', lambda: (_ for _ in ()).throw(RuntimeError('secret-sentinel')))
        self.assertEqual(result['code'], 'request_or_validation_error')
        self.assertNotIn('secret-sentinel', stream.getvalue())
        self.assertEqual(json.loads(stream.getvalue())['status'], 'failed')

    def test_open_or_uncertain_gateway_fails_closed(self):
        with patch.object(SUITE.socket, 'create_connection'), self.assertRaisesRegex(SUITE.CheckFailed, 'still_open'):
            SUITE.guard()
        with patch.object(SUITE.socket, 'create_connection', side_effect=TimeoutError), self.assertRaisesRegex(SUITE.CheckFailed, 'unknown'):
            SUITE.guard()
        with patch.object(SUITE.socket, 'create_connection', side_effect=ConnectionRefusedError):
            SUITE.guard()


if __name__ == '__main__':
    unittest.main()
