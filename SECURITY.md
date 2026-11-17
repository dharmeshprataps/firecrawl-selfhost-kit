# Security policy

Use **Security → Report a vulnerability** in this GitHub repository for sensitive reports. Do not include working credentials, private page contents or exploitable details in public issues.

Only the current public kit release is maintained here. Upstream vulnerabilities may also affect this pinned Firecrawl version; review upstream advisories and dependencies before operating it. An absence of reported issues is not a security certification.

The raw API has authentication disabled and must remain bound to loopback. The optional remote gateway adds OAuth, explicit external-origin configuration, private-address/fixture rejection, bounded input/output/rates and two active calls/four pending slots. It is not an anonymous public scraping API or a general multi-tenant hosting product.

Treat retrieved web content as untrusted. API access can consume compute, reach public destinations and retain scraped data. Operate only on resources you are authorized to access and protect database volumes, backups, logs and OAuth state. Redaction is useful but does not guarantee that logs contain no sensitive information.

Fixture exceptions are for isolated tests and must be disabled in both API and browser before remote access. Keep optional provider and tunnel setup explicit. Do not weaken host/origin validation, TLS, loopback binding or the read-only input allowlist to work around an integration error.
