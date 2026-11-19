# Security Policy

## Supported Versions

| Version | Supported |
| ------- | --------- |
| Latest  | :white_check_mark: |
| < Latest | :x: |

Only the latest release on the primary branch receives security updates.

## Reporting a Vulnerability

Please do not report security vulnerabilities through public GitHub issues or public discussions.

To report a vulnerability:
1. Navigate to the **Security** tab of the Hookmend repository on GitHub.
2. Select **Advisories** and click **Report a vulnerability** to open a Private Vulnerability Report.
3. Include detailed reproduction steps, potential impact, and any proof-of-concept payloads.

Do not use personal email addresses or phone numbers for vulnerability reporting. All security communications must occur through GitHub Private Vulnerability Reporting.

Reports are handled on a best-effort response basis by the maintainers.

## Scope

The following areas are in scope for security review:
- HMAC signature verification and timestamp replay protection across provider adapters.
- Server-Side Request Forgery (SSRF) validation on downstream delivery endpoints.
- Payload value sanitization and redaction mechanisms across logging, SSE streams, and AI proposal generation.
- Access control and authentication on administrative REST endpoints.
- AI containment filters and schema compilation validation.

## Critical Limitation & Scope Restriction

Hookmend is an experimental reference gateway and message infrastructure project. It is **NOT** certified or intended for processing real payment data, credit cards, or financial transactions. Under no circumstances should real production payment payloads or sensitive personal financial information be processed by or routed through this software.
