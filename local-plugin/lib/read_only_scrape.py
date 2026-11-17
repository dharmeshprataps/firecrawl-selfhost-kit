"""A bounded reading surface over the pinned official scrape implementation."""
import copy
import math
from local_tools import LocalToolError, urls_value, expected_content

READ_NAME = 'local_web_read'
READ_KEYS = frozenset({
    'url', 'formats', 'jsonOptions', 'queryOptions', 'screenshotOptions',
    'parsers', 'pdfOptions', 'onlyMainContent', 'redactPII', 'includeTags',
    'excludeTags', 'waitFor', 'mobile', 'skipTlsVerification',
    'removeBase64Images', 'location', 'storeInCache', 'maxAge', 'lockdown',
    'timeout', 'expectedContent',
})
NESTED_KEYS = {
    'jsonOptions': frozenset({'prompt', 'schema'}),
    'queryOptions': frozenset({'prompt', 'mode'}),
    'screenshotOptions': frozenset({'fullPage', 'quality', 'viewport'}),
    'pdfOptions': frozenset({'maxPages'}),
    'location': frozenset({'country', 'languages'}),
}


def invalid(message):
    raise LocalToolError(message, code='INVALID_ARGUMENT')


def validate_read_args(args):
    """Enforce the read contract before passing arguments to the official SDK.

    In particular, the SDK's schema stripping is not a security boundary:
    unknown fields and even empty/null action fields are rejected here.
    JSON schemas are opaque data, not an argument namespace.
    """
    if not isinstance(args, dict) or set(args) - READ_KEYS:
        invalid('Unknown read-only option; browser actions and saved sessions require the interactive scrape tool')
    urls_value([args.get('url')])
    for name, allowed in NESTED_KEYS.items():
        if name in args and (not isinstance(args[name], dict) or set(args[name]) - allowed):
            invalid('Unknown or invalid read-only ' + name + ' option')
    for name in ('onlyMainContent', 'redactPII', 'mobile', 'skipTlsVerification',
                 'removeBase64Images', 'storeInCache', 'lockdown'):
        if name in args and type(args[name]) is not bool:
            invalid(name + ' must be boolean')
    # The upstream schema checks its supported options too. Reject malformed
    # primitives here so opaque objects cannot conceal stateful option names.
    for name in ('maxAge', 'waitFor'):
        if name in args and (type(args[name]) not in (int, float) or not math.isfinite(args[name]) or args[name] < 0):
            invalid(name + ' must be a finite nonnegative number')
    if 'timeout' in args and (type(args['timeout']) is not int or args['timeout'] <= 0):
        invalid('timeout must be a positive integer')
    for name in ('includeTags', 'excludeTags'):
        if name in args and (not isinstance(args[name], list) or any(not isinstance(value, str) for value in args[name])):
            invalid(name + ' must contain strings')
    if 'parsers' in args and (not isinstance(args['parsers'], list) or
                              len(args['parsers']) > 1 or any(value != 'pdf' for value in args['parsers'])):
        invalid('Read-only parsers supports only the PDF parser')
    json_options = args.get('jsonOptions', {})
    if 'prompt' in json_options and (not isinstance(json_options['prompt'], str)):
        invalid('JSON extraction prompt must be a bounded string')
    if 'schema' in json_options and not isinstance(json_options['schema'], dict):
        invalid('JSON extraction schema must be an object')
    query = args.get('queryOptions', {})
    if 'queryOptions' in args and (not isinstance(query.get('prompt'), str) or len(query['prompt']) > 10000 or
                                   query.get('mode', 'freeform') not in ('directQuote', 'freeform')):
        invalid('Invalid read-only query options')
    screenshot = args.get('screenshotOptions', {})
    if 'fullPage' in screenshot and type(screenshot['fullPage']) is not bool:
        invalid('Screenshot fullPage must be boolean')
    if 'quality' in screenshot and (type(screenshot['quality']) not in (int, float) or
                                    not math.isfinite(screenshot['quality'])):
        invalid('Screenshot quality must be finite')
    if 'viewport' in screenshot:
        view = screenshot['viewport']
        if not isinstance(view, dict) or set(view) != {'width', 'height'} or any(
                type(value) not in (int, float) or not math.isfinite(value) or value <= 0 for value in view.values()):
            invalid('Screenshot viewport requires finite positive width and height')
    location = args.get('location', {})
    if 'country' in location and (not isinstance(location['country'], str)):
        invalid('Location country must be a bounded string')
    if 'languages' in location and (not isinstance(location['languages'], list) or any(not isinstance(value, str) for value in location['languages'])):
        invalid('Location languages must be bounded strings')
    if 'expectedContent' in args:
        if args['expectedContent'] is None:
            invalid('expectedContent must be a nonempty array when supplied')
        expected_content(args['expectedContent'])


def read_tool_from_scrape(scrape):
    base_schema = scrape.get('inputSchema') if isinstance(scrape, dict) else None
    properties = base_schema.get('properties') if isinstance(base_schema, dict) else None
    if not isinstance(scrape, dict) or scrape.get('name') != 'firecrawl_scrape' or \
            not isinstance(base_schema, dict) or base_schema.get('type') != 'object' or \
            not isinstance(properties, dict) or not isinstance(properties.get('url'), dict):
        raise LocalToolError('Reviewed upstream scrape catalog is unavailable', code='LOCAL_TOOL_UNAVAILABLE')
    tool = copy.deepcopy(scrape)
    tool['name'] = READ_NAME
    tool['description'] = (
        'Default read-only public-page reader on this Mac. Use for ordinary Markdown, HTML, raw HTML, links, '
        'images, summaries, JSON extraction, native PDF text and screenshots. Headless JavaScript rendering '
        'is available. Browser actions, saved profiles, provider workflows and session changes are not accepted; '
        'use firecrawl_scrape for explicit interactions. Independent reads can be issued together within local '
        'capacity. Inspect metadata.localContentCheck and extractionGrounding; HTTP success is not factual '
        'verification. expectedContent checks required text. maxAge:0 requests a fresh fetch; '
        'pdfOptions.maxPages limits processed PDF pages. No Cloud fallback.'
    )
    tool['annotations'] = {'title': 'Local web read', 'readOnlyHint': True,
                           'destructiveHint': False, 'openWorldHint': True}
    schema = tool['inputSchema']
    schema['properties'] = {name: value for name, value in schema['properties'].items() if name in READ_KEYS}
    schema['required'] = ['url']
    schema['additionalProperties'] = False
    for name, allowed in NESTED_KEYS.items():
        node = schema['properties'].get(name)
        if isinstance(node, dict):
            node['properties'] = {key: value for key, value in node.get('properties', {}).items() if key in allowed}
            node['additionalProperties'] = False
    view = schema['properties'].get('screenshotOptions', {}).get('properties', {}).get('viewport')
    if isinstance(view, dict):
        view['additionalProperties'] = False
    return tool
