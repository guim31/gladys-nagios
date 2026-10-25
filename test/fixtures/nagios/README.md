# Real answers of Nagios Core

`nagios-4.5.12.json` holds answers of a real Nagios Core 4.5.12
(`jasonrivers/nagios` Docker image, 25/10/2026), read as `nagiosadmin`:

- `programstatus`: `statusjson.cgi?query=programstatus`;
- `hostlist`: `statusjson.cgi?query=hostlist&details=true`;
- `servicelist`: `statusjson.cgi?query=servicelist&details=true&servicestatus=warning critical unknown`;
- `objects_hostlist`: `objectjson.cgi?query=hostlist&details=true` (the
  `services` lists dropped);
- `hostgroup_homelab`, `hostgroup_unknown`: `statusjson.cgi?query=hostlist`
  with an existing and an unknown `hostgroup` (its long `options` help
  dropped);
- `hostlist_unauthorized`: the host list of a web user in no
  `authorized_for_*` line and contact of nothing (an empty list);
- `cmd_form`, `cmd_success`, `cmd_denied`: the pages of `cmd.cgi` (the form of
  command 96 with its `nagFormId`, a committed acknowledgement, a refusal).

A stopped Nagios (no `status.dat`) makes `statusjson.cgi` answer an empty
200; the fake reproduces it.

The setup: dummy checks, `nas` (UP, services WARNING, UNKNOWN and an
acknowledged CRITICAL), `switch` (DOWN, acknowledged), `camera` (DOWN behind
`switch` through `parents`: UNREACHABLE, acknowledged), `outside` (DOWN in a
fixed downtime, with a CRITICAL service in downtime), `newhost` (active checks
off: PENDING), host group `homelab` (`nas`, `switch`). The sample host
`localhost` of the image is left out. Addresses are documentation ranges; no
secret.
