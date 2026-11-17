// This deployment permits exactly one deterministic fixture origin.
// Other private addresses keep the upstream protections; webhooks get no exception.
const FIXTURE_ORIGIN = "http://fixtures.firecrawl.test:8765";
const configured = process.env.LOCAL_FIXTURE_ORIGIN;
if (configured && configured !== FIXTURE_ORIGIN) {
  throw new Error("LOCAL_FIXTURE_ORIGIN must equal the reviewed private fixture origin");
}

export function isLocalFixtureUrl(value: string | URL): boolean {
  if (!configured) return false;
  try {
    const url = new URL(value.toString());
    return url.origin === FIXTURE_ORIGIN && !url.username && !url.password;
  } catch {
    return false;
  }
}
