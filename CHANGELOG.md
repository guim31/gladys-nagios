# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

## [1.0.0] - 2026-10-25

### Added

- One device per Nagios Core host (every host the web user sees, or the hosts
  of chosen host groups): host up, services WARNING, CRITICAL and UNKNOWN,
  unhandled problems, host acknowledged, in downtime.
- A "Nagios" device: whether the Nagios daemon runs, the hosts down and the
  service problems of the whole setup.
- Scene triggers: a host goes down, a host is back up, a service has a problem
  (filter by state: WARNING, CRITICAL, UNKNOWN), a service is OK again, Nagios
  no longer watches (no answer, or daemon stopped). HARD states only; problems
  in a downtime are announced only if they outlast it.
- Scene actions: acknowledge the problems of a host with a comment, check a
  host and its services now (both can be turned off in the configuration),
  read the problems for a message.
- Dashboard widget: the hosts down and the services in problem, the most
  serious first, with the unhandled ones.
- Nagios Core 4 JSON CGIs and `cmd.cgi` (with the anti-CSRF token of Nagios
  4.5) behind the Basic auth of the web interface; feature names, messages and
  documentation in English, French, German and Spanish.

[Unreleased]: https://github.com/guim31/gladys-nagios/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/guim31/gladys-nagios/releases/tag/v1.0.0
