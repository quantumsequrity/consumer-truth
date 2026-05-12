# Security policy

Alzhal handles untrusted input from three webhook surfaces (the web UI, WhatsApp, and Telegram). We take security reports seriously.

## Reporting a vulnerability

**Do not open a public GitHub issue.** Use the private security advisory form:

https://github.com/quantumsequrity/alzhal/security/advisories/new

Please include:

- A brief description of the vulnerability and its impact.
- The endpoint, component, or file involved (a path + line number is ideal).
- A minimal reproduction. A `curl` invocation with a sample payload, or a code snippet that triggers the issue, is the fastest way to a fix.
- Whether the issue is already known to be exploited in the wild, if you know.

You will get an initial acknowledgement within 7 days. We aim to ship a fix within 30 days for credible reports, faster for actively exploited issues.

## Scope

In scope:

- The Next.js routes under `app/api/` (web UI, WhatsApp webhook, Telegram webhook).
- The libraries under `lib/` (security, external-data, gemini, whatsapp, telegram, ocr-merge, analysis*).
- The ingester scripts under `scripts/`.
- The grounded-fact pipeline (regulatory_fact + fact_evidence schema in `scripts/d1-regulatory-schema.sql`).

Specific classes of issue we care about:

- Authentication / authorization bypass on the WhatsApp or Telegram webhooks (e.g. signature verification missing, replay, smuggling).
- Prompt-injection paths that let untrusted input write into the LLM context unsanitized.
- SSRF in OCR / external-data fetch paths.
- Hallucinated regulatory claims that bypass the no-hallucination guarantee of the grounded renderer. (This is a security property of the product — a "made-up regulation" bug is treated as a vulnerability.)
- Secrets leakage in logs, error responses, or committed history.
- Rate-limit bypass that lets a single client exhaust Worker quota or upstream-API quota.

Out of scope:

- Self-XSS on a user's own machine via console hacks.
- Denial of service that requires a botnet to be effective.
- Reports against unmodified upstream dependencies (file those with the dependency).
- Findings that are only theoretical and have no exploitation path against the deployed app.

## Disclosure

We coordinate disclosure with the reporter. Default policy: public disclosure 30 days after a fix ships, or sooner with the reporter's agreement. Credit is given in the advisory unless the reporter prefers anonymity.

## Hall of fame

Names and links of security researchers who have helped harden Alzhal will be listed here as advisories are published.
