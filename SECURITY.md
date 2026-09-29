# Security policy

## Reporting a vulnerability

Please do not report a vulnerability in a public issue, pull request or
discussion.

Report it privately through GitHub instead: on the repository's
**Security** tab, choose **Report a vulnerability**
(<https://github.com/seike460/kagero/security/advisories/new>). If that
button is not there, open an issue that only asks for a private
contact, with no details of the problem.

A useful report includes:

- the affected part (the agent, a collector template, a package, a
  workflow) and the version or commit,
- the steps to reproduce it, and
- what an attacker gains.

Reports in English or Japanese are welcome.

kagero is maintained by one person, so the response time is best
effort. A fix ships in a new release, and the advisory is published
with it.

## Supported versions

kagero is at 0.x. Only the latest release gets security fixes. A
published version is never re-tagged; the fix goes into the next
version.

## Scope

The agent runs as PID 1 next to app code that kagero treats as
untrusted. The [threat model](docs/design/architecture.en.md#9-threat-model)
lists the risks that remain open, such as hooks forged through the
MicroVM's own IP while `KAGERO_HOOK_ALLOWED_PEERS` is unset. A way
around a mitigation that the threat model describes is a vulnerability;
a risk it already lists as remaining is known, but a report that makes
it worse than described is still welcome.
