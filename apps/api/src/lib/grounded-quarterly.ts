/** Small, auditable extractor: no model/code generation and no guessed cells. */
export type CellEvidence = { path: string; period: string; row: string; column: number; raw: string; value: string | number | null; sourceValue?: number | null; sourceUnit?: CurrencyUnit; outputUnit?: CurrencyUnit; conversion?: { operation: "multiply"; factor: 10000000; exact: true }; absence?: { status: "row-not-present"; scope: "selected-quarter-table"; metric: "auditor-fee"; tableIndex: number; column: number; inspectedRowLabels: string[] } };
export type ExtractionGrounding = { method: string; status: string; periods?: string[]; tableIndex?: number; fields: CellEvidence[]; inputTruncated: boolean };
export class GroundingError extends Error {
  readonly code = "LOCAL_EXTRACTION_GROUNDING_FAILED";
}
const words = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const clean = (s: string) => s.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/<[^>]*>/g, "").replace(/\\([+*_])/g, "$1").replace(/[*`]/g, "").replace(/&nbsp;|\u00a0/g, " ").trim();
const months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
function period(s: string) {
  const match = clean(s).match(/^([a-z]{3})[a-z]*\s*[-/]?\s*(20\d{2}|19\d{2})$/i);
  if (!match) return undefined;
  const month = months.indexOf(match[1].toLowerCase());
  return month < 0 ? undefined : { label: clean(s), key: Number(match[2]) * 12 + month };
}
function cells(line: string) {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split(/(?<!\\)\|/).map(clean);
}
function rowKind(label: string): "sales" | "profit" | "auditor" | undefined {
  if (/%|\b(?:percent|percentage|bps|basis points?|ratio|margin|growth|rate)\b/i.test(label)) return undefined;
  const n = words(label).replace(/\b(?:rs|inr|crores?|cr|million|millions)\b/g, "").trim();
  if (/^(?:net )?sales$|^(?:total )?revenue(?: from operations)?$/.test(n)) return "sales";
  if (/^(?:net profit|net income|profit after tax|pat)$/.test(n)) return "profit";
  if (/^(?:(?:statutory )?(?:auditors?(?: s)?|audit) fees?|auditors?(?: s)? remuneration)$/.test(n)) return "auditor";
  return undefined;
}
export function tableNumber(raw: string): number | null {
  const text = clean(raw).replace(/^(?:₹|INR|Rs\.?|\$)\s*/i, "").replace(/\s*(?:crores?|cr\.?)$/i, "");
  if (!text || /^(?:[-–—]|n\/?a|null)$/i.test(text)) return null;
  const digits = "(?:\\d+|\\d{1,3}(?:,\\d{3})+|\\d{1,2}(?:,\\d{2})*,\\d{3})(?:\\.\\d+)?";
  if (!new RegExp("^(?:[+-]?" + digits + "|\\(" + digits + "\\))$").test(text)) throw new GroundingError("A requested table cell is not an unambiguous number");
  const result = Number(text.replace(/[(),]/g, "")) * (text.startsWith("(") ? -1 : 1);
  if (!Number.isFinite(result)) throw new GroundingError("A requested table cell is outside the numeric range");
  if ((Number.isInteger(result) && !Number.isSafeInteger(result)) || (!Number.isInteger(result) && text.replace(/[^\d]/g, "").replace(/^0+/, "").length > 15)) throw new GroundingError("A requested number cannot be represented without precision loss");
  const signed = text.startsWith("(") ? "-" + text.slice(1, -1).replace(/,/g, "") : text.replace(/,/g, "");
  if (!sameDecimal(signed, String(result))) throw new GroundingError("A requested number cannot be represented without decimal precision loss");
  return result;
}
type Table = { index: number; context: string; header: string[]; rows: { label: string; kind: "sales" | "profit" | "auditor"; values: string[] }[]; allRows: { label: string; values: string[] }[]; complete: boolean; periods: { label: string; key: number; column: number }[] };
function tables(markdown: string): Table[] {
  const lines = markdown.split(/\r?\n/), found: Table[] = []; let ordinal = 0;
  for (let i = 0; i < lines.length - 2; i++) {
    if (!lines[i].includes("|") || !/^\s*\|?\s*:?-{3,}/.test(lines[i + 1])) continue;
    const index = ordinal++;
    const header = cells(lines[i]), rows: Table["rows"] = [], allRows: Table["allRows"] = [];
    const periods = header.map((v, column) => ({ ...period(v), column })).filter((v): v is Table["periods"][number] => v.key !== undefined);
    let end = i + 2;
    for (; end < lines.length && lines[end].includes("|"); end++) {
      const values = cells(lines[end]); const kind = rowKind(values[0] ?? "");
      allRows.push({ label: values[0] ?? "", values });
      if (kind) rows.push({ label: values[0], kind, values });
    }
    if (periods.length >= 2 && rows.length) {
      periods.sort((a, b) => b.key - a.key);
      const context = lines.slice(Math.max(0, i - 12), i).join(" ");
      // A three-month gap does not turn explicitly monthly/annual figures into quarterly figures.
      const nonQuarterly = /\b(?:monthly|annual|yearly|half[- ]yearly|semi[- ]annual)\s+(?:financial\s+)?(?:figures?|results?|statements?|sales|revenue)\b/i.test(context);
      if (!nonQuarterly && periods[0].key - periods[1].key === 3 && new Set(periods.map(p => p.key)).size === periods.length) found.push({ index, context, header, rows, periods, allRows, complete: allRows.length <= 256 && allRows.every(r => r.values.length === header.length) });
    }
    i = end - 1;
  }
  return found;
}
function schemaNode(node: any, root: any, depth = 0): any {
  if (depth > 10 || !node || typeof node !== "object") throw new GroundingError("Unsupported or recursive financial schema");
  if (node.$ref) {
    if (!/^#\/(?:\$defs|definitions)\/[A-Za-z0-9_-]+$/.test(node.$ref)) throw new GroundingError("Unsupported financial schema reference");
    const resolved = schemaNode(node.$ref.slice(2).split("/").reduce((a: any, k: string) => a?.[k], root), root, depth + 1);
    return { ...resolved, title: [resolved.title, node.title].filter(Boolean).join(" "), description: [resolved.description, node.description].filter(Boolean).join(" ") };
  }
  if (node.anyOf || node.oneOf) {
    const branches = (node.anyOf ?? node.oneOf).filter((n: any) => n.type !== "null");
    if (branches.length !== 1) throw new GroundingError("Ambiguous financial schema alternatives");
    const resolved = schemaNode(branches[0], root, depth + 1);
    return { ...resolved, title: [resolved.title, node.title].filter(Boolean).join(" "), description: [resolved.description, node.description].filter(Boolean).join(" "), nullable: true };
  }
  return node;
}
function nullable(node: any) { return node.nullable || node.type === "null" || (Array.isArray(node.type) && node.type.includes("null")); }
function requestedBases(hints: string) { return new Set(words(hints).match(/\b(?:consolidated|standalone)\b/g) ?? []); }
function affirmsBasis(context: string, basis: string) {
  return new RegExp("\\b" + basis + "\\s+(?:(?:quarterly|financial)\\s+)?(?:figures?|results|statements?)\\b", "i").test(context);
}
// Required schema annotations select a table; optional annotations are checked only if emitted.
function requiredBasisHints(rawNode: any, root: any, depth = 0): string {
  if (depth > 12) throw new GroundingError("Financial schema exceeds bounded extraction limits");
  const node = schemaNode(rawNode, root);
  let hints = (node.title ?? "") + " " + (node.description ?? "");
  for (const key of node.required ?? []) {
    if (node.properties?.[key]) hints += " " + key + " " + requiredBasisHints(node.properties[key], root, depth + 1);
  }
  if (node.items) hints += " " + requiredBasisHints(node.items, root, depth + 1);
  return hints;
}

type CurrencyUnit = "INR_crore" | "INR_rupee";
type UnitScale = "crore" | "rupee";
type UnitDirective = { target?: UnitScale; source?: UnitScale };
const unitWords = (text: string) => words(text.replace(/₹/g, " inr ").replace(/\b(?:inr|rs\.?)\s*(?:cr\.?|crores?)\b/gi, " inr crore ")).replace(/\b(?:inr|rs)\s*(?:cr|crores?)\b/g, "inr crore").replace(/\bcr\b/g, "crore");
const unitError = (message: string) => new GroundingError("Unit conversion: " + message);
function rejectUnsupportedUnits(text: string) {
  // Rs/rupee symbols must not erase an explicitly declared non-INR currency.
  const declarations = [...text.matchAll(/\bcurrency(?:[ _-]?code)?\s*(?::|=|\bis\b)\s*["']?([a-z]{3})\b/gi)];
  const adjacentCodes = [...text.matchAll(/\b([a-z]{3})\s+(?=(?:inr|rs\.?|rupees?|crores?|cr\.?)\b)/gi)].filter(m => m[1] === m[1].toUpperCase());
  if ([...declarations, ...adjacentCodes].some(m => m[1].toUpperCase() !== "INR")) throw unitError("only INR is supported; explicit currency declaration was not INR");
  if (/[$€£¥]/.test(text) || /\b(?:usd|dollars?|eur|euros?|gbp|pounds?|jpy|yen|aud|cad|pkr|npr|lkr|cny|millions?|billions?|lakhs?|paise|paisa)\b/.test(unitWords(text))) throw unitError("unsupported currency or scale; only established INR crore-to-rupee conversion is supported");
}
/** Interpret only bounded, explicit instruction grammar; page content never enters this path. */
function financialInstructions(raw: string): string {
  let text = raw;
  if (/\b(?:do not|don't|never)\s+(?:multiply|multiplying|multiplied)\b/i.test(text)) throw unitError("negated multiplication cannot establish a conversion request");
  // Prohibitions are not requests to estimate. Stop before a separate positive operation.
  const positive = "(?:(?:and|or|but|then|also|instead)\\s+(?:also\\s+)?(?:compute|calculate|sum|multiply|multiplying|divide|round|add|subtract|forecast|double|halve)|(?:and|but|then|also|instead)\\s+(?:also\\s+)?estimate)\\b";
  const prohibition = new RegExp("\\b(?:do not|don't|never)\\s+(?:infer|estimate|guess|substitute)\\b(?:(?![.;!?\\n]|\\b" + positive + ").){0,240}", "gi");
  text = text.replace(prohibition, clause => clause.replace(/\b(?:infer|estimate|guess|substitute)\b/gi, " "));
  const convertToRupees = /\bconvert\b.{0,180}\b(?:to|into)\s+(?:absolute\s+|unscaled\s+|whole\s+|indian\s+)?(?:(?:inr|rs)\s+)?(?:rupees?|inr|rs)\b/.test(unitWords(text));
  // Explicit arithmetic is allowed only for the independently validated INR scale change.
  text = text.replace(/\b(?:multiply|multiplying|multiplied)\s+by\s*([+-]?\d[\d,]*(?:\.\d+)?(?:e[+-]?\d+)?)/gi, (_whole, factor: string) => {
    if (!convertToRupees || tableNumber(factor) !== 10000000) throw unitError("only an explicit multiply-by-10000000 INR conversion is supported");
    return " ";
  });
  const example = /\b(one|[+-]?\d[\d,]*(?:\.\d+)?)\s+(?:(?:inr|rs\.?)\s+)?crores?\s+(?:equals?|must\s+become|becomes?)\s+([+-]?\d[\d,]*(?:\.\d+)?)\s+(?:(?:inr|rs\.?)\s+)?rupees?\b/gi;
  text = text.replace(example, (_whole, before: string, after: string) => {
    const input = before.toLowerCase() === "one" ? "1" : before;
    tableNumber(input); tableNumber(after);
    if (!sameDecimal(exactRupees(input).text, after.replace(/,/g, ""))) throw unitError("the supplied crore-to-rupee example is inconsistent with 10000000");
    return " ";
  });
  if (convertToRupees) {
    text = text.replace(/\brather than\s+(?:the\s+)?(?:unconverted\s+)?(?:inr[- ]?)?crore\s+values\s+mislabel(?:l)?ed\s+as\s+(?:inr\s+)?rupees\b/gi, " ");
    text = text.replace(/\bdo not return\s+(?:the\s+)?unconverted\s+(?:inr[- ]?)?crore\s+values\b/gi, " ");
  }
  return text;
}
function periodField(key: string, rawNode: any, root: any) {
  const node = schemaNode(rawNode, root), hint = words(key + " " + (node.title ?? "") + " " + (node.description ?? ""));
  return /\b(?:quarter|period)\b/.test(hint) && !/\b(?:sales|revenue|profit|income|pat|auditor|auditors|audit|fee|fees|energy|cost|expenses?|company|issuer|business|organization|legal|product|person|country|address|ticker|symbol|currency)\b/.test(hint);
}

function unitDirective(raw: string): UnitDirective {
  rejectUnsupportedUnits(raw);
  let text = unitWords(financialInstructions(raw));
  if (/\b(?:not|never|no|don t)\b.{0,40}\b(?:convert|conversion|rupees?|crores?)\b/.test(text)) throw unitError("negated or ambiguous unit instructions require an explicit target");
  const targets = new Set<UnitScale>(), sources = new Set<UnitScale>();
  if (/\b(?:multiply|multiplying|multiplied)\s+by\s*[+-]?\d/i.test(raw)) sources.add("crore");
  // Source annotations describe input, never the desired output scale.
  const unitPhrase = "(?:(?:inr|rs|rupees?)\\s+)?crores?(?:\\s+(?:of\\s+)?rupees?)?|(?:absolute\\s+|unscaled\\s+|whole\\s+)?(?:rupees?|inr|rs)";
  const sourcePhrase = new RegExp("\\b(?:source|table|original|input|page)(?:\\s+(?:figures?|values?|numbers?|cells?|data|amounts?|is|are|was|were|shown|reported|stated|denominated|expressed|in|units?|of|the))*\\s+(" + unitPhrase + ")\\b", "g");
  text = text.replace(sourcePhrase, (_whole, unit: string) => { sources.add(/\bcrores?\b/.test(unit) ? "crore" : "rupee"); return " "; });
  const reportedSource = new RegExp("\\b(?:source|table|page)\\s+(?:reports|states|shows|lists)\\s+(?:[a-z]+\\s+){0,16}?in\\s+(" + unitPhrase + ")\\b", "g");
  text = text.replace(reportedSource, (_whole, unit: string) => { sources.add(/\bcrores?\b/.test(unit) ? "crore" : "rupee"); return " "; });
  // Direction must be parsed before counting unit words; both mentions cannot cancel.
  text = text.replace(/\b(?:from\s+)?(?:(?:inr|rs|rupees?)\s+)?crores?(?:\s+(?:values?|figures?|amounts?|numbers?))?\s+(?:to|into)\s+(?:absolute\s+|unscaled\s+|whole\s+|indian\s+)?(?:rupees?|inr|rs)\b/g, () => { sources.add("crore"); targets.add("rupee"); return " "; });
  text = text.replace(/\b(?:(?:inr|rs|rupees?)(?:\s+in)?\s+crores?|crores?(?:\s+of)?\s+(?:inr|rs|rupees?))\b/g, () => { targets.add("crore"); return " "; });
  if (/\bcrores?\b/.test(text)) targets.add("crore");
  if (/\b(?:rupees?|inr|rs)\b/.test(text)) targets.add("rupee");
  if (targets.size > 1 || sources.size > 1) throw unitError("ambiguous or conflicting source/target scales");
  if (/\b(?:scale|scaled|rescale|rescaled|base units?)\b/.test(text) && !targets.size) throw unitError("a requested scaling operation has no supported explicit target");
  return { target: [...targets][0], source: [...sources][0] };
}
function sourceCurrencyUnit(context: string, row: string, raw: string): CurrencyUnit | undefined {
  const all = context + " " + row + " " + raw;
  rejectUnsupportedUnits(all);
  const text = unitWords(all);
  const crore = /\bcrores?\b/.test(text), currency = /\b(?:inr|rs|rupees?)\b/.test(text);
  const withoutCroreCurrency = text.replace(/\b(?:(?:inr|rs|rupees?)(?:\s+in)?\s+crores?|crores?(?:\s+of)?\s+(?:inr|rs|rupees?))\b/g, " ");
  if (crore && (/\brupees?\b/.test(withoutCroreCurrency) || /\b(?:rupees?|inr|rs)\s+(?:and|or)\s+crores?\b|\bcrores?\s+(?:and|or)\s+(?:rupees?|inr|rs)\b/.test(text))) throw unitError("source declares conflicting scales");
  if (!currency) return undefined;
  return crore ? "INR_crore" : "INR_rupee";
}
function outputCurrencyUnit(prompt: string, scopes: string[], source: CurrencyUnit | undefined): CurrencyUnit | undefined {
  const directives = [unitDirective(prompt), ...scopes.map(unitDirective)];
  const promptTarget = directives[0].target;
  const schemaTarget = directives.slice(1).map(d => d.target).filter((v): v is UnitScale => v !== undefined).at(-1);
  if (promptTarget && schemaTarget && promptTarget !== schemaTarget) throw unitError("prompt and field schema request different output scales");
  const target = schemaTarget ?? promptTarget;
  const expectedSources = new Set(directives.map(d => d.source).filter(Boolean));
  if (expectedSources.size > 1) throw unitError("conflicting requested source scales");
  if ((target || expectedSources.size) && !source) throw unitError("source currency and scale are not established by the source table");
  if (expectedSources.size && !expectedSources.has(source === "INR_crore" ? "crore" : "rupee")) throw unitError("requested source scale disagrees with the source table");
  if (!target) return undefined;
  const result: CurrencyUnit = target === "crore" ? "INR_crore" : "INR_rupee";
  if (source === "INR_rupee" && result === "INR_crore") throw unitError("reverse rupee-to-crore conversion is not supported");
  return result;
}
function decimalParts(text: string) {
  const m = text.match(/^([+-]?)(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i);
  if (!m) throw unitError("invalid decimal representation");
  const scale = (m[3]?.length ?? 0) - Number(m[4] ?? 0);
  if (Math.abs(scale) > 100) throw unitError("decimal precision exceeds the exact conversion bound");
  return { coefficient: BigInt(m[2] + (m[3] ?? "")) * (m[1] === "-" ? -1n : 1n), scale };
}
function sameDecimal(left: string, right: string) {
  const a = decimalParts(left), b = decimalParts(right), common = Math.max(a.scale, b.scale, 0);
  return a.coefficient * 10n ** BigInt(common - a.scale) === b.coefficient * 10n ** BigInt(common - b.scale);
}
function exactRupees(raw: string): { value: number; text: string } {
  // tableNumber already validated grouping/signs/range. Scale the decimal digits, not a float.
  const text = clean(raw).replace(/^(?:₹|INR|Rs\.?)\s*/i, "").replace(/\s*(?:crores?|cr\.?)$/i, "").replace(/,/g, "");
  const signed = text.startsWith("(") ? "-" + text.slice(1, -1) : text;
  const input = decimalParts(signed);
  let coefficient = input.coefficient * 10000000n, scale = input.scale;
  if (scale < 0) { coefficient *= 10n ** BigInt(-scale); scale = 0; }
  const negative = coefficient < 0n;
  let digits = (negative ? -coefficient : coefficient).toString().padStart(scale + 1, "0");
  let result = scale ? digits.slice(0, -scale) + "." + digits.slice(-scale) : digits;
  if (scale) result = result.replace(/0+$/, "").replace(/\.$/, "");
  if (negative && coefficient !== 0n) result = "-" + result;
  const value = Number(result);
  if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) throw unitError("converted value exceeds safe numeric precision");
  if (!sameDecimal(result, String(value))) throw unitError("converted value cannot be serialized without decimal precision loss");
  return { value, text: result };
}
function rejectsFinancialCalculation(text: string) {
  text = financialInstructions(text);
  return /\b(?:sum|summed|average|mean|median|difference|delta|growth|change|percentage|percent|ratio|annualized|annualised|cagr|round|rounding|rounded|multiply|multiplying|multiplied|divide|divided|subtract|subtracted|add|added|plus|minus|increment|aggregate|aggregated|adjust|adjusted|discount|inflation|forecast|estimate|project|double|triple|twice|times|half|halve|margin)\b/.test(words(text)) || /\b(?:absolute value|base units?)\b/.test(words(text)) || /%|[×*/+]\s*\d|\d\s*[×*/+]|\bby\s*\d/i.test(text);
}

/** Undefined means unrelated request; a recognized but unsafe request throws. */
export function extractGroundedQuarterly(markdown: string, prompt: string | undefined, schema: any): { extract: any; grounding: ExtractionGrounding } | undefined {
  const rawRequest = (prompt ?? "") + " " + JSON.stringify(schema ?? {});
  const request = unitWords(rawRequest);
  const financial = /\b(?:sales|revenue|profit|income|pat)\b/.test(request);
  const unitMention = /\b(?:rupees?|crores?|inr|rs|lakhs?|millions?|billions?|usd|dollars?|eur|euros?|gbp|pounds?|yen|jpy|aud|cad)\b/.test(request) || /[₹$€£]/.test(rawRequest);
  const unitTransformation = unitMention && /\b(?:convert|conversion)\b/.test(request);
  if (!financial && !unitTransformation) return undefined;
  if (rejectsFinancialCalculation(rawRequest)) throw new GroundingError("Unsupported financial calculation; only exact source cells and INR crore-to-rupee scaling can be grounded");
  const fiscalSelection = /\b(?:q[1-4]|fy(?:\s*\d{2,4})?|fiscal\s+(?:year|quarter)|financial\s+year)\b/.test(request);
  if (!fiscalSelection && !/\b(?:quarters?|quarterly|periods?|latest|last|recent|current|previous|prior)\b/.test(request) && !unitMention) return undefined;
  if (fiscalSelection) throw new GroundingError("Explicit fiscal quarter/year selection is unsupported; financial values were not delegated to a model");
  if (!/\b(?:quarters?|quarterly|periods?)\b/.test(request) || (/\b(?:annual|yearly)\b/.test(request) && !/\b(?:quarter|quarterly)\b/.test(request))) throw new GroundingError("Specify supported quarterly period semantics; financial values were not delegated to a model");
  if (!schema || !/\b(?:latest|last|recent|current|previous|prior)\b/.test(request)) throw new GroundingError("Quarterly financial extraction requires a schema and explicit latest/previous period semantics");
  if (Buffer.byteLength(markdown, "utf8") > 2 * 1024 * 1024) throw new GroundingError("Financial source exceeds the bounded table parser; select the quarterly section");
  let candidates = tables(markdown);
  if (!candidates.length) throw new GroundingError("No unambiguous quarterly financial table was found; numerical JSON was not generated");
  const basisHints = requestedBases((prompt ?? "") + " " + requiredBasisHints(schema, schema));
  if (basisHints.size > 1) throw new GroundingError("Mixed financial reporting bases require an explicitly selected source table");
  if (basisHints.size) {
    const basis = [...basisHints][0];
    candidates = candidates.filter(t => affirmsBasis(t.context, basis));
    if (!candidates.length) throw new GroundingError("The requested financial reporting basis is not affirmatively established by the source");
  }
  const outcomes = candidates.map(table => {
    const evidence: CellEvidence[] = [];
    const walk = (rawNode: any, path: string[], inheritedRank?: number, depth = 0, ancestorHints: string[] = []): any => {
      if (depth > 12 || evidence.length > 64) throw new GroundingError("Financial schema exceeds bounded extraction limits");
      const node = schemaNode(rawNode, schema), type = Array.isArray(node.type) ? node.type.find((t: string) => t !== "null") : node.type;
      const ownWords = words(path[path.length - 1] ?? "");
      const description = words((node.title ?? "") + " " + (node.description ?? ""));
      const hint = ownWords + " " + description;
      const rankFrom = (s: string, allowBoth = false) => {
        const latest = /\b(?:latest|current|recent)\b/.test(s), previous = /\b(?:previous|prior|penultimate)\b/.test(s);
        if (latest && previous) { if (allowBoth) return undefined; throw new GroundingError("Conflicting financial period hints"); }
        return previous ? 1 : latest ? 0 : undefined;
      };
      const keyRank = rankFrom(ownWords), descriptionRank = path.length ? rankFrom(description, type === "object" || type === "array") : undefined;
      const ranks = [inheritedRank, keyRank, descriptionRank].filter((v): v is number => v !== undefined);
      if (new Set(ranks).size > 1) throw new GroundingError("Conflicting latest/previous source bindings");
      const rank = ranks[0];
      const unitScopes = [...ancestorHints, (path[path.length - 1] ?? "") + " " + (node.title ?? "") + " " + (node.description ?? "")];
      const unitHints = unitScopes.join(" ");
      if (type === "object" || node.properties) {
        const out: Record<string, unknown> = {}; const required = new Set(node.required ?? []);
        for (const [key, child] of Object.entries(node.properties ?? {})) {
          const before = evidence.length;
          try { out[key] = walk(child, [...path, key], rank, depth + 1, unitScopes); }
          catch (error) { evidence.splice(before); if (required.has(key)) throw error; }
        }
        return out;
      }
      if (type === "array") {
        const item = schemaNode(node.items, schema);
        if (path.length && !/\b(?:quarters?|periods?)\b/.test(ownWords) && !Object.entries(item.properties ?? {}).some(([k, child]) => { const resolved = schemaNode(child, schema); return periodField(k, resolved, schema) && /\b(?:quarter|period)\b/.test(words(k + " " + (resolved.title ?? "") + " " + (resolved.description ?? ""))); })) throw new GroundingError("An unrelated array cannot be interpreted as two financial periods");
        if (!/\b(?:two|2)\b/.test(request) || (node.maxItems !== undefined && node.maxItems < 2) || (node.minItems ?? 0) > 2) throw new GroundingError("Quarter array extraction supports an explicitly requested latest two periods");
        return [walk(node.items, [...path, "0"], 0, depth + 1, unitScopes), walk(node.items, [...path, "1"], 1, depth + 1, unitScopes)];
      }
      if (rank === undefined) throw new GroundingError("A requested financial field is not bound to latest or previous quarter");
      const selected = table.periods[rank];
      if (!selected) throw new GroundingError("A requested quarter is missing from the source headers");
      const fieldBases = requestedBases((prompt ?? "") + " " + unitHints);
      if (fieldBases.size > 1) throw new GroundingError("Mixed financial reporting bases require an explicitly selected source table");
      if (fieldBases.size && !affirmsBasis(table.context, [...fieldBases][0])) throw new GroundingError("The requested financial reporting basis is not affirmatively established by the source");
      if (periodField(path[path.length - 1] ?? "", node, schema)) {
        if (type !== "string") throw new GroundingError("Quarter labels must retain source text");
        evidence.push({ path: path.join("."), period: selected.label, row: "header", column: selected.column, raw: selected.label, value: selected.label });
        return selected.label;
      }
      const profit = /\b(?:net profit|net income|profit after tax|pat)\b/.test(hint), sales = /\b(?:sales|revenue)\b/.test(hint), auditor = /\b(?:auditor|auditors|audit)\b/.test(hint) && /\b(?:fee|fees|remuneration)\b/.test(hint);
      if ([profit, sales, auditor].filter(Boolean).length > 1) throw new GroundingError("Conflicting financial metric roles");
      const kind = /\b(?:margin|growth|percent|percentage|attributable|owners|shareholders|adjusted)\b/.test(hint) ? undefined : profit ? "profit" : sales ? "sales" : auditor ? "auditor" : undefined;
      if (!kind || !["number", "integer", "string"].includes(type)) throw new GroundingError("Financial field " + path.join(".") + " has no supported source row binding in the selected quarter table");
      const rows = table.rows.filter(r => r.kind === kind);
      if (!rows.length && kind === "auditor" && nullable(node)) {
        if (!table.complete || table.allRows.some(r => /\b(?:audit|auditor|auditors|auditing)\b/.test(words(r.label)))) throw new GroundingError("Financial field " + path.join(".") + " has ambiguous or incomplete auditor-fee row evidence");
        const sourceUnit = sourceCurrencyUnit(table.context, "", ""), outputUnit = outputCurrencyUnit(prompt ?? "", unitScopes, sourceUnit);
        evidence.push({ path: path.join("."), period: selected.label, row: "[row absent]", column: selected.column, raw: "", value: null, sourceValue: null, ...(sourceUnit ? { sourceUnit } : {}), ...(outputUnit ? { outputUnit } : {}), absence: { status: "row-not-present", scope: "selected-quarter-table", metric: "auditor-fee", tableIndex: table.index, column: selected.column, inspectedRowLabels: table.allRows.map(r => r.label) } });
        return null;
      }
      if (rows.length !== 1 || rows[0].values.length !== table.header.length) throw new GroundingError("Missing, duplicated or misaligned financial source row for field " + path.join("."));
      const raw = rows[0].values[selected.column], value = tableNumber(raw);
      if (value === null && !nullable(node)) throw new GroundingError("A required financial value is missing; it was not replaced with zero");
      const sourceUnit = sourceCurrencyUnit(table.context, rows[0].label, raw);
      const outputUnit = outputCurrencyUnit(prompt ?? "", unitScopes, sourceUnit);
      const transformed = sourceUnit === "INR_crore" && outputUnit === "INR_rupee" && value !== null;
      const scaled = transformed ? exactRupees(raw) : undefined;
      const converted = scaled ? (type === "string" ? scaled.text : scaled.value) : value !== null && type === "string" ? raw : value;
      if (type === "integer" && typeof converted === "number" && !Number.isInteger(converted)) throw unitError("converted value does not satisfy the integer field");
      evidence.push({ path: path.join("."), period: selected.label, row: rows[0].label, column: selected.column, raw, value: converted, sourceValue: value, ...(sourceUnit ? { sourceUnit } : {}), ...(outputUnit ? { outputUnit } : {}), ...(transformed ? { conversion: { operation: "multiply", factor: 10000000, exact: true } } : {}) });
      return converted;
    };
    const extract = walk(schema, []);
    return { extract, grounding: { method: "deterministic-quarterly-table", status: evidence.some(f => f.absence) ? (evidence.some(f => f.conversion) ? "row-column-unit-and-absence-verified" : "row-column-and-absence-verified") : evidence.some(f => f.conversion) ? "row-column-and-unit-verified" : "row-column-verified", periods: table.periods.slice(0, 2).map(p => p.label), tableIndex: table.index, fields: evidence, inputTruncated: false } satisfies ExtractionGrounding };
  });
  if (!outcomes[0].grounding.fields.some(f => f.row !== "header")) throw new GroundingError("No requested financial value could be grounded");
  if (outcomes.some(o => JSON.stringify(o.extract) !== JSON.stringify(outcomes[0].extract))) throw new GroundingError("Multiple financial tables disagree; select one explicitly");
  return outcomes[0];
}

/** A presence check is deliberately not advertised as semantic validation. */
export function rejectUnsupportedNumbers(value: unknown, source: string) {
  const values = new Set<number>();
  for (const match of source.matchAll(/(?:\(\s*)?[+-]?\d[\d,]*(?:\.\d+)?(?:\s*\))?/g)) {
    try { const n = tableNumber(match[0]); if (n !== null) values.add(n); } catch { /* non-financial syntax */ }
  }
  let checked = 0;
  const walk = (v: unknown, depth = 0) => {
    if (depth > 20 || ++checked > 20000) throw new GroundingError("Extracted JSON exceeds grounding limits");
    if (typeof v === "number" && !values.has(v)) throw new GroundingError("An extracted number is absent from the retained source; numerical JSON was rejected");
    if (typeof v === "string" && /^\(?[+-]?\d[\d,]*(?:\.\d+)?\)?$/.test(v.trim())) { const n = tableNumber(v); if (n !== null && !values.has(n)) throw new GroundingError("An extracted numeric string is absent from the retained source"); }
    if (Array.isArray(v)) v.forEach(x => walk(x, depth + 1));
    else if (v && typeof v === "object") Object.values(v).forEach(x => walk(x, depth + 1));
  };
  walk(value);
}
