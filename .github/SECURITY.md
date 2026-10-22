# Security Policy

RēDesign runs on your own machine: a local server with a control panel and an MCP server that AI
agents can call, the AI provider API keys you keep in its `.env` file, HTML redesigns written by AI
models that it shows you in its viewer, and an updater that downloads new releases. A bug in any of
those could leak your keys or let a generated page or another program reach more than it should,
so we want to hear about it.

## Reporting a vulnerability

If you find a security issue (a generated redesign escaping its preview to reach the control panel or your
files, an API key leaking into a saved run, an error message or a log, a web page or another
program reaching RēDesign's local server or MCP tools, an update that could be swapped for
something else, or anything else that looks exploitable) **please report it privately** rather than
opening a public issue, so it can be fixed before it's disclosed:

- **Preferred:** GitHub's private
  **[Report a vulnerability](https://github.com/LunarWerxs/ReDesign/security/advisories/new)**
  (the repository's *Security, Advisories* tab), or
- open a normal issue **asking us to contact you** (don't include the exploit details there), or
- message the maintainers on [Discord](https://discord.gg/PsWpeNUzhk) and ask for a private
  channel.

Please include:

- what triggers it (the steps, screenshot or request, or a link to it),
- the **RēDesign version** and your **operating system**, and
- what you observed (what was reachable, leaked or changed).

We'll acknowledge within a few days and keep you updated through to a fix and release.

## Supported versions

The **latest release** is the supported version, so please update and confirm the issue still
reproduces before reporting.

Thank you for helping keep RēDesign users safe.
