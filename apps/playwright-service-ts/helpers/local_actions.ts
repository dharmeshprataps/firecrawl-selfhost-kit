import { Page } from 'playwright';

export type LocalAction = { type: string; [key: string]: unknown };
export type LocalScreenshot = { fullPage?: boolean; quality?: number; viewport?: { width: number; height: number } };

const supported = new Set(['wait', 'click', 'write', 'press', 'scroll', 'scrape', 'screenshot']);
export function validateLocalActions(actions: LocalAction[], screenshot?: LocalScreenshot) {
  if (!Array.isArray(actions) || actions.length > 12) throw new Error('Local browser supports at most 12 actions');
  for (const action of actions) {
    if (!supported.has(action.type)) throw new Error(`Unsupported local action: ${action.type}`);
    if (action.type === 'wait' && (action.milliseconds === undefined) === (action.selector === undefined)) throw new Error('Wait requires exactly one selector or duration');
    if (action.type === 'wait' && action.milliseconds !== undefined && (!Number.isInteger(action.milliseconds) || Number(action.milliseconds) < 1 || Number(action.milliseconds) > 5000)) throw new Error('Local wait must be between 1 and 5000ms');
    if ((action.type === 'click' || action.selector !== undefined) && (typeof action.selector !== 'string' || action.selector.length < 1 || action.selector.length > 2000)) throw new Error('Invalid action selector');
    if (action.type === 'write' && (typeof action.text !== 'string' || action.text.length > 10000)) throw new Error('Invalid action text');
    if (action.type === 'press' && (typeof action.key !== 'string' || action.key.length > 100)) throw new Error('Invalid action key');
    if (action.type === 'scroll' && action.direction !== undefined && !['up', 'down'].includes(String(action.direction))) throw new Error('Invalid scroll direction');
    if (action.type === 'screenshot') validateScreenshot(action as LocalScreenshot);
  }
  if (screenshot) validateScreenshot(screenshot);
}
function validateScreenshot(options: LocalScreenshot) {
  if (options.quality !== undefined && (!Number.isInteger(options.quality) || options.quality < 1 || options.quality > 90)) throw new Error('Local screenshot quality must be 1 to 90');
  if (options.viewport && (!Number.isInteger(options.viewport.width) || !Number.isInteger(options.viewport.height) || options.viewport.width < 1 || options.viewport.width > 1920 || options.viewport.height < 1 || options.viewport.height > 1080)) throw new Error('Local screenshot viewport exceeds 1920x1080');
}
async function screenshot(page: Page, options: LocalScreenshot) {
  if (options.viewport) await page.setViewportSize(options.viewport);
  // Clip full-page captures to a bounded height instead of allocating arbitrary-size images.
  const size = page.viewportSize() ?? { width: 1280, height: 720 };
  const height = options.fullPage ? Math.min(12000, await page.evaluate(() => document.documentElement.scrollHeight)) : size.height;
  const bytes = await page.screenshot({ type: 'jpeg', quality: options.quality ?? 65, clip: { x: 0, y: 0, width: size.width, height }, timeout: 10000 });
  if (bytes.length > 1500000) throw new Error('Local screenshot exceeds 1.5MB');
  return 'data:image/jpeg;base64,' + bytes.toString('base64');
}
export async function runLocalActions(page: Page, actions: LocalAction[], requestedScreenshot?: LocalScreenshot) {
  const result = { screenshots: [] as string[], scrapes: [] as { url: string; html: string }[], javascriptReturns: [] as { type: string; value: unknown }[], pdfs: [] as string[] };
  for (const action of actions) {
    switch (action.type) {
      case 'wait':
        if (action.selector) await page.waitForSelector(String(action.selector), { timeout: 5000 });
        else await page.waitForTimeout(Number(action.milliseconds));
        break;
      case 'click': {
        const locator = page.locator(String(action.selector));
        const count = action.all ? Math.min(await locator.count(), 10) : 1;
        for (let i = 0; i < count; i++) await locator.nth(i).click({ timeout: 5000 });
        break;
      }
      case 'write': await page.keyboard.insertText(String(action.text)); break;
      case 'press': await page.keyboard.press(String(action.key)); break;
      case 'scroll':
        if (action.selector) await page.locator(String(action.selector)).scrollIntoViewIfNeeded({ timeout: 5000 });
        else await page.mouse.wheel(0, action.direction === 'up' ? -700 : 700);
        break;
      case 'scrape': result.scrapes.push({ url: page.url(), html: (await page.content()).slice(0, 1000000) }); break;
      case 'screenshot': result.screenshots.push(await screenshot(page, action as LocalScreenshot)); break;
    }
  }
  return { actions: result, screenshot: requestedScreenshot ? await screenshot(page, requestedScreenshot) : undefined };
}
