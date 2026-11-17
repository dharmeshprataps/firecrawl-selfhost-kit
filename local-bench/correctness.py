#!/usr/bin/env python3
"""Private deterministic correctness acceptance; invoke through run-fixture-tests.

Evidence contains fixed fixture facts, hashes, counts and typed checks only.
No response bodies, headers, environment values or free-form API errors are saved.
"""
import argparse
import datetime as dt
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import socket
import sys
import time
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
API = 'http://127.0.0.1:3012'
ORIGIN = 'http://fixtures.firecrawl.test:8765'
MAX_RESPONSE = 4 * 1024 * 1024
EXPECTED = {'latestQuarter': 'Sep 2026', 'latestSales': 21794, 'latestNetProfit': 411,
            'previousQuarter': 'Jun 2026', 'previousSales': 15548, 'previousNetProfit': 718}
SCHEMA = {'type': 'object', 'properties': {key: {'type': 'string' if 'Quarter' in key else 'number'} for key in EXPECTED},
          'required': list(EXPECTED), 'additionalProperties': False}
PROMPT = 'Extract sales and net profit from the latest two consolidated quarters. Preserve source units.'
MONEY_FIELDS = frozenset(key for key in EXPECTED if 'Quarter' not in key)
RUPEES = {key: value * 10000000 if key in MONEY_FIELDS else value for key, value in EXPECTED.items()}
CONVERT_PROMPT = 'Extract sales and net profit from the latest two consolidated quarters. Convert crore into rupees. Preserve period labels.'
MIXED_FIELDS = frozenset({'latestSales', 'previousSales'})
MIXED = {key: value * 10000000 if key in MIXED_FIELDS else value for key, value in EXPECTED.items()}
MIXED_PROMPT = 'Extract sales and net profit from the latest two consolidated quarters in the units specified by each field. Preserve period labels.'
AMBIGUOUS_PROMPT = 'Extract sales and net profit from the latest two consolidated quarters. Convert each amount into crore or rupees.'
PYTHON_CODE = 'values = [\n    n < 3 and n >= 0,\n]\nprint(values[0])\n'
JSX_CODE = 'export function App() {\n  return <button onClick={() => setN(n + 1)}>Next & more</button>;\n}'


class CheckFailed(Exception):
    """A constant check identifier, never an untrusted API error message."""


def require(condition, code):
    if not condition:
        raise CheckFailed(code)


def sha256(text):
    return hashlib.sha256(text.encode()).hexdigest()


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise CheckFailed('unexpected_api_redirect')


def request(payload):
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    req = urllib.request.Request(API + '/v2/scrape', data=json.dumps(payload).encode(),
                                 headers={'Content-Type': 'application/json'}, method='POST')
    try:
        with opener.open(req, timeout=60) as response:
            status, raw = response.status, response.read(MAX_RESPONSE + 1)
    except urllib.error.HTTPError as exc:
        status, raw = exc.code, exc.read(MAX_RESPONSE + 1)
    require(len(raw) <= MAX_RESPONSE, 'response_size_limit')
    try:
        body = json.loads(raw)
    except (ValueError, UnicodeError) as exc:
        raise CheckFailed('non_json_response') from exc
    require(isinstance(body, dict), 'invalid_response_shape')
    return status, body


def scrape(path, formats=None, **options):
    require(path in {'/quarterly-results.html', '/pdf-page-limits.pdf', '/code-fidelity.html',
                     '/loading-table.html', '/dynamic-table.html'}, 'unreviewed_fixture_path')
    return request({'url': ORIGIN + path, 'formats': formats or ['markdown'],
                    'maxAge': 0, 'timeout': 55000, **options})


def document(response):
    status, body = response
    require(status == 200 and body.get('success') is True, 'scrape_not_successful')
    data = body.get('data')
    require(isinstance(data, dict), 'missing_document')
    return data


def validate_grounding(doc, output=None, converted_fields=None):
    output = EXPECTED if output is None else output
    expected_status = 'row-column-and-unit-verified' if converted_fields else 'row-column-verified'
    require(doc.get('json') == output, 'quarterly_six_facts_mismatch')
    grounding = doc.get('metadata', {}).get('extractionGrounding', {})
    require(grounding.get('method') == 'deterministic-quarterly-table' and
            grounding.get('status') == expected_status and
            grounding.get('periods') == ['Sep 2026', 'Jun 2026'] and
            grounding.get('inputTruncated') is False, 'missing_grounding_contract')
    fields = grounding.get('fields', [])
    require(isinstance(fields, list) and len(fields) == 6 and
            {field.get('path') for field in fields if isinstance(field, dict)} == set(EXPECTED), 'missing_cell_evidence')
    for field in fields:
        key = field['path']
        period = 'Sep 2026' if key.startswith('latest') else 'Jun 2026'
        require(field.get('period') == period and field.get('value') == output[key] and
                type(field.get('column')) is int and field['column'] == (13 if key.startswith('latest') else 12), 'cell_evidence_mismatch')
        raw = field.get('raw')
        require(isinstance(raw, str) and
                (raw.strip() == EXPECTED[key] if 'Quarter' in key else
                 re.sub(r'[,\s]', '', raw) == str(EXPECTED[key])), 'cell_raw_source_mismatch')
        row = field.get('row', '')
        require(isinstance(row, str) and ((row == 'header') if 'Quarter' in key else
                bool(re.search(r'net\s*profit' if 'NetProfit' in key else r'\bsales\b', row, re.I))), 'cell_row_mismatch')
        if converted_fields is not None and key in MONEY_FIELDS:
            require(type(field.get('sourceValue')) is int and field['sourceValue'] == EXPECTED[key],
                    'quarterly_money_source_value_mismatch')
            converted = key in converted_fields
            require(field.get('sourceUnit') == 'INR_crore' and
                    field.get('outputUnit') == ('INR_rupee' if converted else 'INR_crore'),
                    'quarterly_currency_unit_mismatch')
            if converted:
                proof = field.get('conversion', {})
                require(isinstance(proof, dict) and proof.get('operation') == 'multiply' and
                        type(proof.get('factor')) is int and proof['factor'] == 10000000 and
                        proof.get('exact') is True, 'quarterly_arithmetic_proof_missing')
                require(type(field.get('value')) is int and field['value'] == field['sourceValue'] * proof['factor'],
                        'quarterly_arithmetic_value_mismatch')
            else:
                require('conversion' not in field, 'quarterly_unexpected_conversion')
        elif converted_fields is not None:
            require('conversion' not in field and field.get('value') == EXPECTED[key], 'quarter_label_transformed')
    return {'exact_facts': output, 'grounding_fields': 6, 'grounding_status': expected_status,
            **({'converted_fields': sorted(converted_fields), 'source_unit': 'INR_crore',
                'converted_output_unit': 'INR_rupee', 'exact_multiplier': 10000000,
                'money_cell_proofs': [{key: field[key] for key in
                    ('path', 'period', 'row', 'column', 'raw', 'sourceValue', 'sourceUnit', 'outputUnit', 'value', 'conversion')
                    if key in field} for field in fields if field['path'] in MONEY_FIELDS]} if converted_fields else {})}


def quarterly():
    return validate_grounding(document(scrape('/quarterly-results.html',
        [{'type': 'json', 'schema': SCHEMA, 'prompt': PROMPT}])))


def quarterly_rupees():
    return validate_grounding(document(scrape('/quarterly-results.html',
        ['markdown', {'type': 'json', 'schema': SCHEMA, 'prompt': CONVERT_PROMPT}])), RUPEES, MONEY_FIELDS)


def mixed_schema():
    schema = json.loads(json.dumps(SCHEMA))
    for key in MONEY_FIELDS:
        schema['properties'][key]['description'] = ('Latest' if key.startswith('latest') else 'Previous') + \
            ' quarter ' + ('sales' if 'Sales' in key else 'net profit') + \
            (' in rupees' if key in MIXED_FIELDS else ' in crores')
    return schema


def quarterly_mixed_units():
    return validate_grounding(document(scrape('/quarterly-results.html',
        ['markdown', {'type': 'json', 'schema': mixed_schema(), 'prompt': MIXED_PROMPT}])), MIXED, MIXED_FIELDS)


def quarterly_ambiguous_units():
    status, body = scrape('/quarterly-results.html', [{'type': 'json', 'schema': SCHEMA, 'prompt': AMBIGUOUS_PROMPT}])
    return validate_rejection(status, body, 'ambiguous_transformation')


def validate_rejection(status, body, prefix):
    require(status >= 400 and body.get('success') is False and
            body.get('code') == 'LOCAL_EXTRACTION_GROUNDING_FAILED', prefix + '_not_typed_rejection')
    require(not body.get('data', {}).get('json') if isinstance(body.get('data'), dict) else True,
            prefix + '_fabricated_json')
    return {'http_status': status, 'code': 'LOCAL_EXTRACTION_GROUNDING_FAILED', 'fabricated_json': False}


def quarterly_unsupported():
    schema = json.loads(json.dumps(SCHEMA))
    schema['properties']['latestSales']['description'] = 'Latest sales in USD millions'
    status, body = scrape('/quarterly-results.html', [{'type': 'json', 'schema': schema, 'prompt': PROMPT}])
    return validate_rejection(status, body, 'unsupported_conversion')


def exact_financial(request_id):
    """Verbatim report prompt/schema, with the URL explicitly replaced by a fixture.

    The local adapter's jsonOptions-to-v2-format translation is reproduced here;
    public MCP replays with unchanged arguments are separate acceptance evidence.
    """
    catalogue = json.loads((ROOT / 'apps/api/src/lib/__fixtures__/financial-exact-requests.json').read_text())
    recorded = next(entry for entry in catalogue['requests'] if entry['request_id'] == request_id)
    payload = json.loads(json.dumps(recorded['arguments']))
    payload['url'] = ORIGIN + '/quarterly-results.html'
    options = payload.pop('jsonOptions')
    payload['formats'] = [{'type': 'json', **options} if fmt == 'json' else fmt for fmt in payload['formats']]
    status, body = request(payload)
    if request_id == 'Q082':
        return {'request_id': request_id, 'translation': 'private_fixture_url_and_v2_json_format',
                **validate_rejection(status, body, 'unavailable_energy_cost')}
    doc = document((status, body))
    rupees = request_id in {'Q083', 'Q084'}
    rows = [('Sep 2026', 21794, 411), ('Jun 2026', 15548, 718)]
    if request_id == 'Q081':
        expected = {'rows': [{'label': period, 'turnover_crore': sales, 'profit_after_tax_crore': profit}
                             for period, sales, profit in rows]}
    elif rupees:
        expected = {'quarters': [{'period': period, 'sales_inr': sales * 10000000,
                                 'net_profit_inr': profit * 10000000} for period, sales, profit in rows]}
    else:
        expected = {'quarters': [{'period': period, 'sales_inr_crore': sales,
                                 'net_profit_inr_crore': profit} for period, sales, profit in rows]}
    has_fee = 'latest_quarter_auditor_fee_inr_crore' in options['schema']['properties']
    if has_fee:
        expected['latest_quarter_auditor_fee_inr_crore'] = None
    require(doc.get('json') == expected, 'exact_report_financial_answer_mismatch')
    grounding = doc.get('metadata', {}).get('extractionGrounding', {})
    expected_status = ('row-column-and-unit-verified' if rupees else
                       'row-column-and-absence-verified' if has_fee else 'row-column-verified')
    require(grounding.get('status') == expected_status and grounding.get('inputTruncated') is False,
            'exact_report_grounding_status_mismatch')
    fields = grounding.get('fields', [])
    require(len(fields) == (7 if has_fee else 6), 'exact_report_evidence_count_mismatch')
    if has_fee:
        absent = next((field for field in fields if field.get('path') == 'latest_quarter_auditor_fee_inr_crore'), {})
        absence = absent.get('absence', {})
        require(absent.get('value', 'missing') is None and absent.get('sourceValue', 'missing') is None and
                absent.get('column') == 13 and absence.get('status') == 'row-not-present' and
                absence.get('scope') == 'selected-quarter-table' and absence.get('metric') == 'auditor-fee' and
                isinstance(absence.get('tableIndex'), int) and
                any(re.search(r'\bsales\b', label, re.I) for label in absence.get('inspectedRowLabels', [])),
                'exact_report_nullable_absence_unproven')
    if rupees:
        money = [field for field in fields if type(field.get('value')) is int]
        require(len(money) == 4, 'exact_report_conversion_evidence_missing')
        for field in money:
            proof = field.get('conversion', {})
            require(field.get('sourceUnit') == 'INR_crore' and field.get('outputUnit') == 'INR_rupee' and
                    proof == {'operation': 'multiply', 'factor': 10000000, 'exact': True} and
                    field['value'] == field.get('sourceValue', 0) * 10000000,
                    'exact_report_conversion_proof_mismatch')
    return {'request_id': request_id, 'translation': 'private_fixture_url_and_v2_json_format',
            'exact_prompt_and_schema': True, 'grounding_status': expected_status,
            'grounding_fields': len(fields), 'output': expected}


def pdf_marker(page):
    return f'pdf-limit-page-{page:02d}-marker'


def validate_pdf(doc, pages):
    metadata = doc.get('metadata', {})
    require(metadata.get('numPages') == pages and metadata.get('totalPages') == 9, 'pdf_page_metadata_mismatch')
    evidence = {}
    for fmt in ('markdown', 'html'):
        content = doc.get(fmt)
        require(isinstance(content, str), 'pdf_output_missing')
        observed = [page for page in range(1, 10) if pdf_marker(page) in content]
        require(observed == list(range(1, pages + 1)), 'pdf_output_page_boundary_mismatch')
        evidence[fmt] = {'characters': len(content), 'sha256': sha256(content), 'page_markers': observed}
    return {'numPages': pages, 'totalPages': 9, 'outputs': evidence}


def pdf(pages, mode='ocr', cap=None):
    parser = {'type': 'pdf', 'mode': mode}
    if cap is not None:
        parser['maxPages'] = cap
    result = validate_pdf(document(scrape('/pdf-page-limits.pdf', ['markdown', 'html'], parsers=[parser])), pages)
    return {'parser_mode': mode, 'requested_max_pages': cap, **result}


def validate_code(doc):
    markdown = doc.get('markdown', '')
    require(isinstance(markdown, str) and 'code-fidelity-marker-7431' in markdown, 'code_fixture_missing')
    # Backreferences match dynamic fences too; the captured body retains its final LF.
    blocks = re.findall(r'(?m)^(`{3,})([^\n]*)\n(.*?)^\1[ \t]*$', markdown, re.S)
    python = [body for _, language, body in blocks if language.strip() == 'python']
    jsx = [body for _, language, body in blocks if language.strip() == 'jsx']
    require(python == [PYTHON_CODE], 'python_literal_text_changed')
    require(jsx == [JSX_CODE + '\n'], 'jsx_literal_text_changed')
    require('`a < b && c >= 0`' in markdown and '`&lt;`' in markdown, 'inline_code_literal_changed')
    return {'languages': ['python', 'jsx'], 'python_sha256': sha256(python[0]),
            'jsx_sha256': sha256(jsx[0]), 'inline_operators_exact': True, 'entities_decoded_once': True}


def code_fidelity():
    return validate_code(document(scrape('/code-fidelity.html', onlyMainContent=False)))


def content_checker():
    path = ROOT / 'local-plugin/lib/local_tools.py'
    spec = importlib.util.spec_from_file_location('local_correctness_content_checks', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.content_check


def content_readiness(dynamic=False):
    path = '/dynamic-table.html' if dynamic else '/loading-table.html'
    options = {'actions': [{'type': 'wait', 'milliseconds': 750}]} if dynamic else {}
    doc = document(scrape(path, **options))
    expected = ['NIFTY 50', '12345.67']
    check = content_checker()(doc, expected)
    if dynamic:
        require(check.get('status') == 'checked' and not check.get('reasons'), 'rendered_content_not_ready')
        require('Loading' not in doc.get('markdown', ''), 'rendered_placeholder_remains')
    else:
        require(check.get('status') == 'incomplete' and
                'loading_table_without_rows' in check.get('reasons', []) and
                'expected_content_missing' in check.get('reasons', []), 'loading_only_table_not_flagged')
    return {'content_status': check['status'], 'reasons': check['reasons'],
            'accuracyVerified': check.get('accuracyVerified', False),
            'markdown_sha256': sha256(doc.get('markdown', '')), 'rendered': dynamic}


def guard():
    # The outer runner holds its maintenance lock and validates runtime isolation.
    # Refuse an independently open gateway even if the caller supplies the flag.
    try:
        with socket.create_connection(('127.0.0.1', 3013), timeout=1):
            pass
    except ConnectionRefusedError:
        return
    except OSError as exc:
        raise CheckFailed('gateway_state_unknown') from exc
    raise CheckFailed('public_gateway_still_open')


def run_check(name, function):
    started = time.monotonic()
    try:
        evidence = function()
        result = {'check': name, 'status': 'passed', 'evidence': evidence}
    except CheckFailed as exc:
        result = {'check': name, 'status': 'failed', 'code': str(exc)}
    except Exception:
        result = {'check': name, 'status': 'failed', 'code': 'request_or_validation_error'}
    result['seconds'] = round(time.monotonic() - started, 3)
    # stdout contains only allowlisted names/status/codes, never external text.
    print(json.dumps({key: value for key, value in result.items() if key != 'evidence'}), flush=True)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--guarded-run', action='store_true', required=True,
                        help='Set only by the reviewed stop/test/restore fixture runner')
    parser.parse_args()
    os.umask(0o077)
    guard()
    checks = [('quarterly-six-grounded-facts', quarterly),
              ('quarterly-unsupported-conversion-rejected', quarterly_unsupported),
              ('quarterly-four-money-fields-in-rupees', quarterly_rupees),
              ('quarterly-mixed-field-scales', quarterly_mixed_units),
              ('quarterly-ambiguous-transformation-rejected', quarterly_ambiguous_units),
              ('report-Q056-nullable-auditor-fee', lambda: exact_financial('Q056')),
              ('report-Q081-described-renamed-fields', lambda: exact_financial('Q081')),
              ('report-Q082-unavailable-energy-cost', lambda: exact_financial('Q082')),
              ('report-Q083-explicit-conversion-factor', lambda: exact_financial('Q083')),
              ('report-Q084-conversion-example-and-prohibition', lambda: exact_financial('Q084')),
              ('pdf-fallback-full-nine', lambda: pdf(9)),
              ('pdf-fallback-two-after-full', lambda: pdf(2, cap=2)),
              ('pdf-fallback-cap-above-total', lambda: pdf(9, cap=20)),
              ('pdf-native-two', lambda: pdf(2, mode='auto', cap=2)),
              ('literal-python-react-inline-code', code_fidelity),
              ('loading-only-table-flagged', content_readiness),
              ('dynamic-table-rendered-and-ready', lambda: content_readiness(True))]
    results = [run_check(name, function) for name, function in checks]
    report = {'version': 1, 'suite': 'correctness', 'timestamp': dt.datetime.now(dt.timezone.utc).isoformat(),
              'api': API, 'fixture_origin': ORIGIN, 'cloud_fallback': False,
              'status': 'passed' if all(item['status'] == 'passed' for item in results) else 'failed',
              'passed': sum(item['status'] == 'passed' for item in results), 'total': len(results), 'checks': results,
              'scope': 'Deterministic private fixtures; not a public-site, anti-bot, OCR or hosted-parity benchmark.'}
    destination = ROOT / 'local-bench/var/correctness'
    destination.mkdir(parents=True, exist_ok=True, mode=0o700)
    stamp = dt.datetime.now(dt.timezone.utc).strftime('%Y%m%dT%H%M%S.%fZ')
    folder = destination / stamp
    folder.mkdir(mode=0o700)
    data = json.dumps(report, indent=2) + '\n'
    (folder / 'report.json').write_text(data)
    temporary = destination / 'latest.tmp'
    temporary.write_text(data)
    temporary.replace(destination / 'latest.json')
    print(json.dumps({'suite': 'correctness', 'status': report['status'], 'passed': report['passed'], 'total': report['total']}))
    return 0 if report['status'] == 'passed' else 1


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except (CheckFailed, OSError):
        print('Correctness suite preflight or evidence write failed; use the reviewed fixture runner.', file=sys.stderr)
        raise SystemExit(1)
