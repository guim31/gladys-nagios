# Security policy

## Reporting a vulnerability

Please do **not** report a security problem in a public issue, pull request or
forum post.

Report it privately through GitHub instead: open the **Security** tab of this
repository, then **Report a vulnerability**.

No such button? Private reporting is not enabled yet: open an issue that only
asks the maintainers for a private contact, without any detail of the problem,
and send the report there.

Include, when you can:

- the version of the integration and of Gladys;
- what an attacker can do, and the steps to reproduce it;
- the log lines that help (remove tokens, passwords and addresses first).

The fix ships as a new version of the integration, and the advisory is
published once users can update.

## Supported versions

Only the latest release receives security fixes: update the integration from
Gladys before reporting a problem.

## Scope

In scope: the code of this repository and the Docker image it publishes.

What the integration handles:

- **Secrets**: the password of the Nagios web user is a `secret` field of the
  Gladys configuration. The integration reads it from Gladys at startup, keeps
  it in memory, sends it only to the Nagios address of the configuration (the
  `Authorization: Basic` header), and never writes it to `/data` nor to the
  logs. Over `http://` (the default of Nagios), Basic auth travels in clear on
  the local network: prefer `https://` when the network is not trusted. The
  user has the rights `cgi.cfg` gives it: the documentation asks for read
  rights, plus the command rights only if acknowledging or checking now is
  wanted, and both scene actions can be turned off.
- **Stored in `/data`**: `nagios-state.json`, the problems already seen (host
  and service names, state, start time, check output), the address and host
  groups of the configuration, and a truncated hash of the user name, so that
  a restart neither repeats nor misses a scene event. No password.
- **Network**: requests go only to the Nagios address typed in the
  configuration. "Accept self-signed certificates" (off by default) turns the
  verification of an `https://` certificate off: the connection stays
  encrypted but the server is not authenticated. The integration opens no port
  and calls no cloud service.

Out of scope: Gladys Assistant itself (see its
[security policy](https://github.com/GladysAssistant/Gladys/security/policy)),
Nagios itself, and the hosts it monitors.
