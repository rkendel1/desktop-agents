# Security Policy

## Reporting a vulnerability

Please **do not** open a public issue for security problems.

Email **support@thinkany.ai** with:

- a description of the issue and its impact,
- steps to reproduce (proof-of-concept if possible),
- any suggested fix.

We aim to acknowledge reports within a few business days and will keep you updated
as we investigate and ship a fix. Responsible disclosure is appreciated — please
give us a reasonable window to release a patch before any public disclosure.

## Scope notes

- Douchat has no account and no cloud service. Desktop state lives in a local
  FeltDB database. Provider API keys and mailbox passwords are entered by the
  user and stored only in the operating system's credential store (Electron
  `safeStorage`), never in FeltDB, never committed to this repository, and never
  sent anywhere other than the provider the user configured. Reports of secrets
  reaching FeltDB, logs or the renderer are in scope.
- Renderer windows run with context isolation, sandboxing and no Node.js
  integration. Reports about the IPC bridge (for example, a renderer reaching
  arbitrary files or processes) are in scope.
- Local file tools are limited to Downloads, Desktop and Documents, and local
  agent CLIs keep their own login and approval model. Bypasses of either are in
  scope.
- Automatic updates are served from `https://cdn.douchat.ai` with
  checksum-protected manifests. Anything that lets an attacker substitute an
  update is in scope.
- Vulnerabilities in third-party agent CLIs themselves should be reported to
  their maintainers.
