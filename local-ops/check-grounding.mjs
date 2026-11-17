// Portable CI contract check: uses the actual captured table and production helper.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {extractGroundedQuarterly, rejectUnsupportedNumbers} from '../apps/api/src/lib/grounded-quarterly.ts';
const markdown=readFileSync(new URL('../apps/api/src/lib/__fixtures__/screener-quarterly-captured.md',import.meta.url),'utf8');
const properties={latestQuarter:{type:'string'},latestSales:{type:'number'},latestNetProfit:{type:'number'},previousQuarter:{type:'string'},previousSales:{type:'number'},previousNetProfit:{type:'number'}};
const schema={type:'object',properties,required:Object.keys(properties),additionalProperties:false};
const result=extractGroundedQuarterly(markdown,'Latest two consolidated quarters sales and net profit',schema);
assert.deepEqual(result.extract,{latestQuarter:'Sep 2026',latestSales:21794,latestNetProfit:411,previousQuarter:'Jun 2026',previousSales:15548,previousNetProfit:718});
assert.equal(result.grounding.fields.length,6);
assert.throws(()=>extractGroundedQuarterly('No financial table','Latest two quarters sales',schema));
assert.throws(()=>rejectUnsupportedNumbers({value:99999},'Value 42'));
console.log('Captured financial table: six exact facts grounded; missing and unsupported values rejected');

const converted=extractGroundedQuarterly(markdown,'Latest two consolidated quarters sales and net profit. Convert crore into rupees.',schema);
assert.deepEqual(converted.extract,{latestQuarter:'Sep 2026',latestSales:217940000000,latestNetProfit:4110000000,previousQuarter:'Jun 2026',previousSales:155480000000,previousNetProfit:7180000000});
assert.equal(converted.grounding.status,'row-column-and-unit-verified');
for(const field of converted.grounding.fields.filter(field=>typeof field.value==='number')){
 assert.equal(field.sourceUnit,'INR_crore');assert.equal(field.outputUnit,'INR_rupee');
 assert.deepEqual(field.conversion,{operation:'multiply',factor:10000000,exact:true});
 assert.equal(BigInt(field.sourceValue)*10000000n,BigInt(field.value));
}
assert.throws(()=>extractGroundedQuarterly(markdown,'Latest two consolidated quarters sales and net profit. Multiply all amounts by 3.',schema));
assert.throws(()=>extractGroundedQuarterly(markdown.replace('21,794','900,719,926'),'Latest two consolidated quarters sales and net profit. Convert crore into rupees.',schema));
console.log('Financial unit contract: source cells and exact crore-to-rupee transformations verified; unsupported arithmetic/unsafe range rejected');

assert.throws(()=>extractGroundedQuarterly(markdown.replace(/Rs\./g,"PKR Rs."),"Latest two consolidated quarters sales and net profit. Convert crore into rupees.",schema));
assert.throws(()=>extractGroundedQuarterly(markdown,"Latest two consolidated quarters sales and net profit in PKR rupees.",schema));

// These prompts and schemas are verbatim from the supplied 217-attempt ledger.
// The stable captured table is the only substituted input in this offline check.
const exact=JSON.parse(readFileSync(new URL('../apps/api/src/lib/__fixtures__/financial-exact-requests.json',import.meta.url),'utf8'));
for(const entry of exact.requests){
 const {prompt,schema}=entry.arguments.jsonOptions;
 if(entry.request_id==='Q082'){
  assert.throws(()=>extractGroundedQuarterly(markdown,prompt,schema),/energy.*cost|energy_cost/i);
  continue;
 }
 const actual=extractGroundedQuarterly(markdown,prompt,schema);
 const rupees=['Q083','Q084'].includes(entry.request_id), multiplier=rupees?10000000:1;
 const rows=[['Sep 2026',21794,411],['Jun 2026',15548,718]];
 const expected=entry.request_id==='Q081'
  ?{rows:rows.map(([label,turnover_crore,profit_after_tax_crore])=>({label,turnover_crore,profit_after_tax_crore}))}
  :{quarters:rows.map(([period,sales,profit])=>rupees?{period,sales_inr:sales*multiplier,net_profit_inr:profit*multiplier}:{period,sales_inr_crore:sales,net_profit_inr_crore:profit})};
 if(schema.properties.latest_quarter_auditor_fee_inr_crore) expected.latest_quarter_auditor_fee_inr_crore=null;
 assert.deepEqual(actual.extract,expected,entry.request_id);
 if(Object.hasOwn(expected,'latest_quarter_auditor_fee_inr_crore')){
  const absent=actual.grounding.fields.find(field=>field.path==='latest_quarter_auditor_fee_inr_crore');
  assert.equal(absent.value,null);assert.equal(absent.sourceValue,null);
  assert.equal(absent.absence.status,'row-not-present');assert.equal(absent.absence.scope,'selected-quarter-table');
  assert.equal(absent.absence.metric,'auditor-fee');assert.equal(absent.column,13);
  assert.ok(absent.absence.inspectedRowLabels.some(label=>/sales/i.test(label)));
 }
 if(rupees)for(const field of actual.grounding.fields.filter(field=>typeof field.value==='number')){
  assert.equal(field.sourceUnit,'INR_crore');assert.equal(field.outputUnit,'INR_rupee');
  assert.equal(field.conversion.factor,10000000);assert.equal(field.value,field.sourceValue*10000000);
 }
}
console.log('Exact report contract: nine original financial requests answered; unavailable energy cost rejected; nullable absence and both rupee prompts verified');
