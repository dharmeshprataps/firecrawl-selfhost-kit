#!/usr/bin/env node
// Postdeployment acceptance only. Credentials and raw page bodies are not saved.
import {createHash} from 'node:crypto';
import {readFileSync, writeFileSync, mkdirSync, chmodSync, lstatSync, existsSync,
  openSync, readSync, closeSync} from 'node:fs';
import {dirname, isAbsolute, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {LocalBridge} from '../local-remote/bridge.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WORK = join(ROOT, 'local-bench/var/readonly-deployment');
const OUTPUT = join(WORK, 'acceptance');
const PYTHON = 'https://docs.python.org/3/tutorial/appetite.html';
const NEXT = 'https://docs.python.org/3/tutorial/interpreter.html';
const TRACE = join(ROOT, '.local-state/mcp/requests.jsonl');
const EXPECTED_TOOLS = new Set(['firecrawl_scrape', 'firecrawl_map', 'firecrawl_crawl',
  'firecrawl_check_crawl_status', 'firecrawl_search', 'local_web_capabilities',
  'local_web_status', 'local_web_attributes', 'local_web_batch_scrape',
  'local_web_monitor_create', 'local_web_monitor_list', 'local_web_monitor_get',
  'local_web_monitor_update', 'local_web_monitor_run', 'local_web_monitor_delete',
  'local_web_monitor_checks', 'local_web_monitor_check', 'local_web_read']);
const FORBIDDEN = ['actions', 'profile', 'session', 'headers', 'proxy', 'alexandria',
  'requestId', 'zeroDataRetention'];
const sha = text => createHash('sha256').update(text).digest('hex');
const canonical = value => Array.isArray(value) ? value.map(canonical) :
  value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const argHash = value => sha(JSON.stringify(canonical(value)));
const fail = code => {throw Object.assign(new Error(code), {acceptanceCode: code});};
const must = (value, code) => {if (!value) fail(code);};
const safeCode = error => /^[A-Z0-9_]{1,100}$/.test(error?.acceptanceCode ?? '') ?
  error.acceptanceCode : 'LOCAL_READ_ACCEPTANCE_REQUEST_FAILED';

function options(argv) {
  must(argv.length === 2 && argv[0] === '--launcher' && isAbsolute(argv[1]), 'USAGE_LAUNCHER_REQUIRED');
  const launcher = resolve(argv[1]);
  must(launcher === join(ROOT, 'local-plugin/bin/firecrawl-mcp'), 'UNREVIEWED_LAUNCHER');
  const stat = lstatSync(launcher);
  must(stat.isFile() && !stat.isSymbolicLink() && (stat.mode & 0o111) !== 0, 'LAUNCHER_NOT_REGULAR_EXECUTABLE');
  return {launcher};
}
function payload(result) {
  if (result?.structuredContent && typeof result.structuredContent === 'object') return result.structuredContent;
  for (const block of result?.content ?? []) if (block.type === 'text') {
    try {const decoded = JSON.parse(block.text); if (decoded && typeof decoded === 'object') return decoded;} catch {}
  }
  fail('JSON_TOOL_PAYLOAD_MISSING');
}
function document(result) {
  must(result?.isError !== true, 'EXPECTED_READ_SUCCESS');
  const value = payload(result);
  must(value.success !== false, 'EXPECTED_READ_SUCCESS');
  return value.data && typeof value.data === 'object' ? value.data : value;
}
function checkedDocument(doc, anchors = []) {
  must(doc?.metadata?.statusCode === 200 && typeof doc.markdown === 'string' && doc.markdown.length > 100,
    'PUBLIC_DOCUMENT_MISSING');
  must(anchors.every(anchor => doc.markdown.includes(anchor)), 'PUBLIC_CONTENT_ANCHOR_MISSING');
  must(!['failed', 'incomplete'].includes(doc.metadata.localContentCheck?.status), 'PUBLIC_CONTENT_INCOMPLETE');
  return {targetHttpStatus: 200, markdownCharacters: doc.markdown.length,
    markdownSha256: sha(doc.markdown), contentStatus: doc.metadata.localContentCheck?.status ?? 'not_reported'};
}
function exactCorpus() {
  const corpus = [
    ['python', 'https://docs.python.org/3/tutorial/appetite.html', ['Whetting Your Appetite', 'Python']],
    ['react', 'https://react.dev/learn', ['Quick Start', 'components']],
    ['mdn', 'https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise', ['Promise', 'fulfilled']],
    ['firecrawl-docs', 'https://docs.firecrawl.dev/contributing/self-host', ['Self', 'Docker']],
  ];
  return corpus.map(([historicalRequestId, url, expectedContentAnchors]) => {
    const args = {formats:['markdown'], onlyMainContent:true, maxAge:0, timeout:45000, url};
    return {historicalRequestId, arguments:args, argumentsSha256Canonical:argHash(args), expectedContentAnchors};
  });
}
function exactFinancial() {
  const fixture = JSON.parse(readFileSync(join(ROOT, 'apps/api/src/lib/__fixtures__/financial-exact-requests.json'), 'utf8'));
  const request = fixture.requests.find(item => item.request_id === 'Q084');
  must(request && argHash(request.arguments) === request.arguments_sha256_canonical, 'Q084_ORIGINAL_HASH_MISMATCH');
  return request;
}
function cells(line) {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/)
    .map(value => value.replace(/\\([+*_])/g, '$1').replace(/[*`]/g, '').trim());
}
function sourceQuarters(markdown) {
  const lines = markdown.split(/\r?\n/), section = lines.findIndex(line => /^\s*(?:#{1,6}\s*)?Quarterly Results\s*$/i.test(line));
  must(section >= 0, 'SOURCE_QUARTERLY_SECTION_MISSING');
  const months = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
  for (let index = section + 1; index < Math.min(lines.length - 1, section + 40); index++) {
    if (!lines[index].includes('|') || !/^\s*\|?\s*:?-{3,}/.test(lines[index + 1])) continue;
    const header = cells(lines[index]), periods = [];
    for (const [column, value] of header.entries()) {
      const match = value.match(/^([A-Za-z]{3})\s+(20\d{2}|19\d{2})$/), month = match ? months.indexOf(match[1].toLowerCase()) : -1;
      if (match && month >= 0) periods.push({period: value, key: Number(match[2]) * 12 + month, column});
    }
    if (periods.length < 2) continue;
    const context = lines.slice(section, index).join(' ');
    must(/Consolidated/i.test(context) && /(?:Rs\.?|INR|₹)\s*\.?\s*Crores?/i.test(context), 'SOURCE_BASIS_OR_UNIT_MISSING');
    let sales, profit;
    for (let row = index + 2; row < lines.length && lines[row].includes('|'); row++) {
      const values = cells(lines[row]);
      if (/^Sales\s*\+?$/i.test(values[0])) {must(!sales, 'SOURCE_DUPLICATE_SALES'); sales = values;}
      if (/^Net Profit\s*\+?$/i.test(values[0])) {must(!profit, 'SOURCE_DUPLICATE_PROFIT'); profit = values;}
    }
    must(sales?.length === header.length && profit?.length === header.length, 'SOURCE_QUARTER_ROWS_MISSING');
    periods.sort((a,b) => b.key - a.key);
    must(periods[0].key - periods[1].key === 3, 'SOURCE_NOT_TWO_LATEST_QUARTERS');
    const integer = raw => {must(/^-?\d+(?:,\d{3})*$/.test(raw), 'SOURCE_FINANCE_NOT_INTEGER'); const n = Number(raw.replace(/,/g, '')); must(Number.isSafeInteger(n), 'SOURCE_FINANCE_UNSAFE_INTEGER'); return n;};
    return periods.slice(0,2).map(({period,column}) => ({period, column,
      sales_inr_crore: integer(sales[column]), net_profit_inr_crore: integer(profit[column])}));
  }
  fail('SOURCE_QUARTER_TABLE_MISSING');
}
function traceOffset() {
  if (!existsSync(TRACE)) return null;
  const stat = lstatSync(TRACE);
  must(stat.isFile() && !stat.isSymbolicLink(), 'TRACE_NOT_REGULAR');
  return stat.size;
}
function dispatchesSince(offset) {
  if (offset === null || !existsSync(TRACE)) return null;
  const stat = lstatSync(TRACE);
  if (stat.size < offset) return null;
  const bytes = stat.size - offset;
  must(bytes <= 65536, 'TRACE_DELTA_TOO_LARGE');
  const data = Buffer.alloc(bytes), fd = openSync(TRACE, 'r');
  try {readSync(fd, data, 0, bytes, offset);} finally {closeSync(fd);}
  let count = 0;
  for (const line of data.toString('utf8').split('\n')) if (line) {
    let row; try {row = JSON.parse(line);} catch {fail('TRACE_DELTA_INVALID');}
    if (typeof row.url === 'string' && row.url.startsWith('http://127.0.0.1:3012/') && row.transport !== 'blocked') count++;
  }
  return count;
}

export async function run({launcher}) {
  process.umask(0o077);
  mkdirSync(OUTPUT, {recursive:true, mode:0o700}); chmodSync(OUTPUT, 0o700);
  const bridge = new LocalBridge({checkout:ROOT, launcher});
  const report = {kind:'installed-readonly-stdio-acceptance', startedAt:new Date().toISOString(), launcher,
    cloudFallback:false, checks:[], notes:[
      'Public pages only; no private fixture exception or native build. Caller must isolate this acceptance from other MCP traffic for negative-dispatch counting.',
      'Four independent original requests are launched together; local capacity remains bounded. This is not a hosted comparison or general speed/capacity guarantee.',
      'Original Q084 prompt/schema/options are preserved; only the tool name changes to local_web_read. Financial facts are checked against returned source cells, not independently audited filings.',
      'Evidence contains hashes/counts/typed checks and bounded financial facts, never raw page bodies, headers, environment values or free-form errors. Screenshot is a private JPEG artifact for visual review.'
    ]};
  const check = async(name, operation) => {
    const start = Date.now();
    try {const evidence = await operation(); report.checks.push({check:name,status:'passed',elapsedMs:Date.now()-start,evidence});}
    catch(error) {report.checks.push({check:name,status:'failed',elapsedMs:Date.now()-start,code:safeCode(error)});}
    const last = report.checks.at(-1); console.log(JSON.stringify({check:name,status:last.status,elapsedMs:last.elapsedMs,...(last.code?{code:last.code}:{})}));
    return last.status === 'passed';
  };
  try {
    if (!await check('catalog18-readonly-and-interactive-contract', async() => {
      const listed = await bridge.listTools(), tools = listed.tools;
      must(Array.isArray(tools) && tools.length === 18 && new Set(tools.map(tool => tool.name)).size === 18 &&
        tools.every(tool => EXPECTED_TOOLS.has(tool.name)), 'CATALOG18_MISMATCH');
      const read = tools.find(tool => tool.name === 'local_web_read'), interactive = tools.find(tool => tool.name === 'firecrawl_scrape');
      must(read.annotations?.readOnlyHint === true && read.annotations.destructiveHint === false && read.annotations.openWorldHint === true,
        'READ_ONLY_ANNOTATIONS_MISMATCH');
      must(read.inputSchema?.additionalProperties === false && read.inputSchema.required?.includes('url') &&
        FORBIDDEN.every(key => !Object.hasOwn(read.inputSchema.properties ?? {}, key)), 'READ_ONLY_SCHEMA_BOUNDARY_MISSING');
      must(interactive.annotations?.readOnlyHint === false && interactive.inputSchema?.properties?.actions,
        'INTERACTIVE_TOOL_CONTRACT_CHANGED');
      return {tools:18,readonlyAnnotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:true},forbiddenOptionsAbsent:FORBIDDEN,
        interactiveActionsRetained:true};
    })) fail('CATALOG_GATE_FAILED');
    if (!await check('local-readiness', async() => {
      const result = await bridge.callTool('local_web_status', {}), status = payload(result);
      must(result.isError !== true, 'LOCAL_READINESS_FAILED');
      must(status.ready === true && status.cloud_fallback === false, 'LOCAL_READINESS_FAILED');
      return {ready:true,cloudFallback:false};
    })) fail('READINESS_GATE_FAILED');
    await check('four-independent-original-read-calls', async() => {
      const start = Date.now(), calls = exactCorpus();
      const settled = await Promise.allSettled(calls.map(async(call) => {
        const began = Date.now(), result = await bridge.callTool('local_web_read', call.arguments), doc = document(result);
        const evidence = checkedDocument(doc, call.expectedContentAnchors);
        const timing = result._meta?.localExecution;
        must(timing?.tool === 'local_web_read' && Number.isFinite(timing.queueMs) && Number.isFinite(timing.serviceMs), 'READ_ALIAS_TIMING_MISSING');
        return {requestId:call.historicalRequestId,argumentsSha256Canonical:call.argumentsSha256Canonical,
          elapsedMs:Date.now()-began, ...evidence, localExecution:{tool:timing.tool,queueMs:timing.queueMs,serviceMs:timing.serviceMs}};
      }));
      must(settled.every(result => result.status === 'fulfilled'), 'INDEPENDENT_READ_FAILED');
      const results = settled.map(result => result.value);
      return {independentCalls:4,launchedTogether:true,totalMs:Date.now()-start,results};
    });
    await check('read-formats-and-content-readiness', async() => {
      const args = {url:PYTHON,formats:['markdown','html','rawHtml','links','images'],maxAge:0,storeInCache:false,
        timeout:45000,onlyMainContent:true,expectedContent:['Whetting Your Appetite']};
      const doc = document(await bridge.callTool('local_web_read', args)), evidence = checkedDocument(doc, ['Whetting Your Appetite']);
      must(typeof doc.html === 'string' && doc.html.length > 100 && typeof doc.rawHtml === 'string' && doc.rawHtml.length > 100,
        'READ_HTML_FORMATS_MISSING');
      must(Array.isArray(doc.links) && doc.links.length > 0 && Array.isArray(doc.images), 'READ_LINK_IMAGE_FORMATS_MISSING');
      must(doc.metadata.localContentCheck?.status === 'checked', 'READ_EXPECTED_CONTENT_NOT_CHECKED');
      return {...evidence,htmlCharacters:doc.html.length,htmlSha256:sha(doc.html),rawHtmlCharacters:doc.rawHtml.length,
        rawHtmlSha256:sha(doc.rawHtml),links:doc.links.length,images:doc.images.length,argumentsSha256:argHash(args)};
    });
    await check('bitcoin-pdf-two-page-limit', async() => {
      const args = {url:'https://bitcoin.org/bitcoin.pdf',formats:['markdown'],parsers:['pdf'],pdfOptions:{maxPages:2},
        onlyMainContent:true,maxAge:0,timeout:45000};
      const doc = document(await bridge.callTool('local_web_read', args)), evidence = checkedDocument(doc, ['Bitcoin']);
      must(doc.metadata.numPages === 2 && doc.metadata.totalPages === 9, 'PDF_LIMIT_METADATA_MISMATCH');
      must(!/(?:^|\n)\s*(?:#{1,6}\s*)?References\s*(?:\n|$)/i.test(doc.markdown) &&
        !/(?:^|\n)\s*(?:#{1,6}\s*)?4\.\s+Proof.of.Work\b/i.test(doc.markdown), 'PDF_LATER_PAGES_LEAKED');
      return {...evidence,numPages:2,totalPages:9,laterSectionHeadingsAbsent:true,argumentsSha256:argHash(args)};
    });
    await check('original-Q084-rupees-with-source-proof', async() => {
      const request = exactFinancial(), doc = document(await bridge.callTool('local_web_read', request.arguments));
      const evidence = checkedDocument(doc), source = sourceQuarters(doc.markdown);
      const expected = {quarters:source.map(row => ({period:row.period,sales_inr:row.sales_inr_crore*10000000,
        net_profit_inr:row.net_profit_inr_crore*10000000}))};
      for (const row of expected.quarters) must(Number.isSafeInteger(row.sales_inr) && Number.isSafeInteger(row.net_profit_inr), 'CONVERTED_FINANCE_UNSAFE_INTEGER');
      must(JSON.stringify(canonical(doc.json)) === JSON.stringify(canonical(expected)), 'Q084_CONVERTED_VALUES_MISMATCH');
      const grounding = doc.metadata.extractionGrounding;
      must(grounding?.status === 'row-column-and-unit-verified' && grounding.inputTruncated === false &&
        grounding.fields?.length === 6, 'Q084_GROUNDING_MISSING');
      for (let index=0; index<2; index++) for (const [field,kind] of [['sales_inr','sales_inr_crore'],['net_profit_inr','net_profit_inr_crore']]) {
        const cell = grounding.fields.find(value => value.path === `quarters.${index}.${field}`), row = source[index];
        must(cell?.period === row.period && cell.column === row.column && cell.sourceValue === row[kind] &&
          cell.value === expected.quarters[index][field] && cell.sourceUnit === 'INR_crore' && cell.outputUnit === 'INR_rupee' &&
          cell.conversion?.operation === 'multiply' && cell.conversion.factor === 10000000 && cell.conversion.exact === true,
          'Q084_SOURCE_OR_ARITHMETIC_PROOF_MISMATCH');
      }
      return {...evidence,requestId:'Q084',originalArgumentsSha256:request.arguments_sha256_canonical,
        toolNameOnlyChanged:true,sourceFacts:source,output:expected,groundingStatus:grounding.status,convertedFieldsVerified:4};
    });
    await check('readonly-screenshot-jpeg-image-block', async() => {
      const args = {url:PYTHON,formats:['markdown','screenshot'],maxAge:0,storeInCache:false,timeout:45000,
        onlyMainContent:true,screenshotOptions:{fullPage:false,quality:50,viewport:{width:1024,height:768}}};
      const result = await bridge.callTool('local_web_read', args), doc = document(result), evidence = checkedDocument(doc, ['Whetting Your Appetite']);
      const image = result.content?.find(block => block.type === 'image' && block.mimeType === 'image/jpeg');
      must(typeof image?.data === 'string' && image.data.length <= 2100000 && /^[A-Za-z0-9+/]*={0,2}$/.test(image.data), 'JPEG_IMAGE_BLOCK_MISSING');
      const bytes = Buffer.from(image.data, 'base64');
      must(bytes.length > 1000 && bytes.length <= 1572864 && bytes[0] === 0xff && bytes[1] === 0xd8 &&
        bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9, 'JPEG_IMAGE_BLOCK_INVALID');
      const file = join(OUTPUT, 'readonly-screenshot.jpg');writeFileSync(file, bytes, {mode:0o600});chmodSync(file,0o600);
      return {...evidence,imageMimeType:'image/jpeg',imageBytes:bytes.length,imageSha256:sha(bytes),privateImagePath:file,
        visualReview:'pending-parent-inspection',argumentsSha256:argHash(args)};
    });
    await check('readonly-actions-profile-headers-private-url-denied', async() => {
      const cases = [
        {name:'actions',args:{url:PYTHON,actions:[{type:'click',selector:'a'}]}},
        {name:'profile',args:{url:PYTHON,profile:{name:'acceptance-denied',saveChanges:true}}},
        {name:'headers',args:{url:PYTHON,headers:{'X-Readonly-Acceptance':'must-not-forward'}}},
        {name:'private-url',args:{url:'http://127.0.0.1:3012/v0/health/readiness'}},
      ];
      const before = traceOffset(), outcomes = [];
      for (const entry of cases) {
        const result = await bridge.callTool('local_web_read', entry.args);
        must(result.isError === true, 'READ_ONLY_NEGATIVE_NOT_REJECTED');
        let responseCode;
        try {const code=payload(result).code;if(/^[A-Z0-9_]{1,80}$/.test(code??''))responseCode=code;}catch{}
        outcomes.push({case:entry.name,rejected:true,...(responseCode?{responseCode}:{})});
      }
      const dispatches = dispatchesSince(before);
      must(dispatches === null || dispatches === 0, 'REJECTED_OPTIONS_REACHED_LOCAL_API');
      return {outcomes,localApiDispatchesObserved:dispatches,traceObservationAvailable:dispatches!==null};
    });
    await check('existing-interactive-click-next-retained', async() => {
      const args = {url:PYTHON,formats:['markdown'],actions:[{type:'click',selector:'a[accesskey="N"]'},
        {type:'wait',milliseconds:500},{type:'scrape'}],onlyMainContent:true,maxAge:0,timeout:45000};
      const doc = document(await bridge.callTool('firecrawl_scrape', args)), evidence = checkedDocument(doc, ['Using the Python Interpreter']);
      must(doc.metadata.url === NEXT && Array.isArray(doc.actions?.scrapes) && doc.actions.scrapes.some(item => item.url === NEXT),
        'INTERACTIVE_FINAL_URL_OR_ACTION_MISSING');
      return {...evidence,finalUrl:NEXT,actionScrapeUrlVerified:true,argumentsSha256:argHash(args)};
    });
  } catch(error) {report.error=safeCode(error);}
  finally {await bridge.close();}
  report.finishedAt = new Date().toISOString();report.passed=report.checks.filter(item=>item.status==='passed').length;
  report.total=report.checks.length;report.status=!report.error&&report.total===9&&report.passed===9?'passed':'failed';
  const file=join(OUTPUT,'installed-stdio-acceptance.json');writeFileSync(file,JSON.stringify(report,null,2)+'\n',{mode:0o600});chmodSync(file,0o600);
  console.log(JSON.stringify({status:report.status,passed:report.passed,total:report.total,report:file}));return report;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {const settings=options(process.argv.slice(2));run(settings).then(report=>{if(report.status!=='passed')process.exitCode=1;})
    .catch(error=>{console.error(JSON.stringify({status:'failed',code:safeCode(error)}));process.exitCode=1;});}
  catch(error) {console.error(JSON.stringify({status:'failed',code:safeCode(error)}));process.exitCode=1;}
}
