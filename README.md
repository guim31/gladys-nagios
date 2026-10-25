# Nagios for Gladys Assistant

A [Gladys Assistant](https://gladysassistant.com) integration for
[Nagios Core](https://www.nagios.org/projects/nagios-core/): your monitored
hosts and their services in Gladys, scenes that react when a host goes down or
a service fails, the problems of a host acknowledged or checked again from a
scene, and a dashboard widget of the problems in progress.

It reads the JSON CGIs of the Nagios Core 4 web interface on your local
network, with a web user (the Basic auth of `htpasswd.users`).

## Features

- **One device per host** (every host the web user sees, or the hosts of
  chosen host groups): host up, services WARNING, CRITICAL and UNKNOWN,
  unhandled problems, host acknowledged, in downtime.
- **A "Nagios" device**: whether the Nagios daemon runs, the hosts down and
  the service problems of the whole setup.
- **Scene triggers**: a host goes down, a host is back up, a service has a
  problem (filter: WARNING, CRITICAL, UNKNOWN), a service is OK again, Nagios
  no longer watches (no answer, or daemon stopped). HARD states only; problems
  in a downtime are held, as Nagios holds its notifications.
- **Scene actions**: acknowledge the problems of a host (with a comment), check
  a host and its services now (both can be turned off), read the problems
  (counts and list).
- **Widget**: the hosts down and the services in problem, the most serious
  first, with the unhandled ones.
- Feature names, messages and documentation in English, French, German and
  Spanish.

## Requirements

- Gladys Assistant 5.1.0 or later.
- Nagios Core 4.x with its web interface (`statusjson.cgi`, `objectjson.cgi`,
  `cmd.cgi`). Not Nagios XI, nor the forks (Icinga, Naemon).
- A web user listed in `cgi.cfg` under `authorized_for_all_hosts` and
  `authorized_for_all_services`, plus `authorized_for_all_host_commands` and
  `authorized_for_all_service_commands` to acknowledge or check now.

## Installation

1. In Gladys, open **Integrations** → **Install from GitHub** and enter the
   address of this repository: `https://github.com/guim31/gladys-nagios` (or
   install **Nagios** from the catalog once it is listed).
2. In **Configuration**, enter the address of the web interface
   (`192.168.1.2`: `http://` and `/nagios` are added; `192.168.1.2/nagios4` on
   Debian), the web user and its password. Save, then click **Test the
   connection**.
3. Open the **Discover** tab and add the hosts to follow.

The user guide is in [`docs/en.md`](docs/en.md) (also in
[French](docs/fr.md), [German](docs/de.md) and [Spanish](docs/es.md)); Gladys
links it from the Configuration screen.

## How it works

Every minute by default, the integration sends three GET requests to the CGIs
(`http://<host>/nagios/cgi-bin`): `statusjson.cgi?query=programstatus`
(version, and whether the daemon still updates its status),
`query=hostlist&details=true` and
`query=servicelist&details=true&servicestatus=warning critical unknown`; one
more per host group (`hostgroup=`), and `objectjson.cgi?query=hostlist` once an
hour for the aliases. The status bit masks of the CGIs are mapped to the usual
states. The states of the added devices are sent only when they change (and
every 6 hours), the scene events on every HARD change, added device or not.
The problems already seen are kept in `/data`: a restart neither repeats nor
misses one.

Commands go through `cmd.cgi` as the web interface does: a GET of the form
gives the anti-CSRF token of Nagios 4.5 (`nagFormId`, also a cookie) and the
check time in the `date_format` of the server, then a POST commits the command
(33 and 34 to acknowledge, sticky; 96 and 17 to check a host and its services
now, forced). Nagios answers HTML: the result is read from its
`infoMessage`/`errorMessage` block.

## Checked on a real Nagios

On 25/10/2026, the Docker image of the integration ran with the constraints
of the Gladys sandbox (read-only rootfs, no capability, 256 MB) against
Nagios Core 4.5.12 (`jasonrivers/nagios` Docker image), with the fake Gladys
of the SDK: discovery, states, "Test the connection", widget, the five
triggers (states driven by passive check results), acknowledgement (read back
in Nagios), check now, the daemon stopped, a wrong password, a wrong path, a
user without rights, an unknown host group. The answers are kept as fixtures
in [`test/fixtures/nagios`](test/fixtures/nagios).

## Limitations

- One Nagios per integration; host and service states only (no metrics, no
  performance data).
- Polling: a problem that comes and goes between two reads is missed.
- A service in problem removed from monitoring counts as OK again.
- At most 30 scene events per read.

## Development

```bash
npm ci
npm run format:check && npm run lint && npm test
npx -y github:GladysAssistant/integration-store --skip-image-check .
```

The tests run against the fake Gladys of the SDK and an in-memory Nagios
(`test/helpers/fakeNagios.js`) seeded with real answers. See
[`CLAUDE.md`](CLAUDE.md) for the project rules.

## Credits

- Started from the official
  [integration template](https://github.com/GladysAssistant/integration-template-js)
  and the [integration SDK](https://github.com/GladysAssistant/integration-sdk-js)
  of Gladys Assistant (Apache-2.0).
- The [Nagios Core documentation](https://assets.nagios.com/downloads/nagioscore/docs/nagioscore/4/en/)
  (CGIs, external commands) and the answers of a real Nagios Core 4.5.12 were
  the references; no code is copied from another project.
- Cover: the Nagios logo,
  [`Nagios_logo.svg`](https://commons.wikimedia.org/wiki/File:Nagios_logo.svg)
  on Wikimedia Commons (public domain), a trademark of Nagios Enterprises.
- Architecture shared with
  [gladys-icinga](https://github.com/guim31/gladys-icinga),
  [gladys-checkmk](https://github.com/guim31/gladys-checkmk) and
  [gladys-centreon](https://github.com/guim31/gladys-centreon).

## Disclaimer

Not affiliated with Nagios Enterprises. Nagios is a trademark of Nagios
Enterprises, LLC.

## License

[Apache-2.0](LICENSE)
