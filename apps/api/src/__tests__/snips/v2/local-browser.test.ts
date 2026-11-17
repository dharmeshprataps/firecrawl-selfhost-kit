import { config } from "../../../config";
import { scrapeTimeout } from "./lib";
const enabled = !!config.TEST_SUITE_SELF_HOSTED && !!process.env.LOCAL_FIXTURE_ORIGIN;
const origin = process.env.LOCAL_FIXTURE_ORIGIN ?? "http://fixtures.firecrawl.test:8765";
async function scrape(body: object) {
 const response = await fetch(`${config.TEST_API_URL}/v2/scrape`, {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
 return {status:response.status,body:await response.json()};
}
describe.skipIf(!enabled)("Local browser actions and screenshots", () => {
 it("clicks rendered content and returns a real bounded JPEG", async () => {
  const {status,body} = await scrape({url:origin+"/interactive.html",formats:["markdown",{type:"screenshot",fullPage:true}],actions:[{type:"click",selector:"#reveal"},{type:"wait",milliseconds:100}],maxAge:0,timeout:25000});
  expect(status).toBe(200);expect(body.success).toBe(true);expect(body.data.markdown).toContain("clicked-marker-6204");expect(body.data.markdown).not.toContain("before-click-marker");
  expect(body.data.screenshot).toMatch(/^data:image\/jpeg;base64,/);
  const bytes=Buffer.from(body.data.screenshot.split(",")[1],"base64");expect(bytes[0]).toBe(255);expect(bytes[1]).toBe(216);expect(bytes.length).toBeGreaterThan(1000);expect(bytes.length).toBeLessThanOrEqual(1500000);
 },scrapeTimeout);
 it("rejects unsupported arbitrary-JavaScript actions", async () => {
  const {status,body}=await scrape({url:origin+"/interactive.html",formats:["markdown"],actions:[{type:"executeJavascript",script:"document.title='unsupported'"}],maxAge:0,timeout:15000});
  expect(status!==200 || body.success===false).toBe(true);
 },scrapeTimeout);
 it("blocks a click navigating to a denied private host", async () => {
  const {status,body}=await scrape({url:origin+"/interactive.html",formats:["markdown"],actions:[{type:"click",selector:"#denied"}],maxAge:0,timeout:15000});
  expect(status!==200 || body.success===false || body.data?.metadata?.statusCode===403).toBe(true);
  const audit=await scrape({url:origin+"/security/audit/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",formats:["markdown"],maxAge:0});expect(audit.body.data.markdown).toContain("canary-count-0");
 },scrapeTimeout);
});
