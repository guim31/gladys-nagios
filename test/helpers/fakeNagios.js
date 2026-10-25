// -----------------------------------------------------------------------------
// An in-memory Nagios Core 4, seeded with the real answers of Nagios Core
// 4.5.12 (test/fixtures/nagios): the JSON CGIs (programstatus, host list with
// its `hostgroup` selector, services filtered by `servicestatus`, object
// list), the Basic auth of the web server, and cmd.cgi with its CSRF token
// (form, cookie, real HTML answers). Tests change its state (host and
// service states, downtimes, rights, failures) between two reads.
// -----------------------------------------------------------------------------

import { readFileSync } from 'node:fs';

export const ADDRESS = '192.0.2.10';
export const CGI_URL = `http://${ADDRESS}/nagios/cgi-bin`;
export const USERNAME = 'gladys';
export const PASSWORD = 'test-password-0123';
export const TOKEN = '2cd89a3257e4ccaf';

export const fixture = JSON.parse(
  readFileSync(new URL('../fixtures/nagios/nagios-4.5.12.json', import.meta.url), 'utf8'),
);

// The fixture was read at this time (ms).
export const READ_AT = fixture.programstatus.result.query_time;

const HOST_STATUS = [2, 4, 8]; // UP, DOWN, UNREACHABLE
const SERVICE_STATUS = [2, 4, 16, 8]; // OK, WARNING, CRITICAL, UNKNOWN
const SERVICE_FILTER = { ok: 2, warning: 4, critical: 16, unknown: 8, pending: 1 };

const json = (body) => ({
  status: 200,
  headers: { 'content-type': 'application/json; charset=utf-8' },
  body: JSON.stringify(body, null, 2),
});
const html = (body, headers = {}) => ({
  status: 200,
  headers: { 'content-type': 'text/html; charset=utf-8', ...headers },
  body,
});
const errorPage = (message) =>
  html(`<html><body><P><DIV CLASS='errorMessage'>${message}</DIV></P></body></html>`);

export class FakeNagios {
  constructor() {
    const aliases = fixture.objects_hostlist.data.hostlist;
    const homelab = Object.keys(fixture.hostgroup_homelab.data.hostlist);
    this.hosts = Object.values(structuredClone(fixture.hostlist.data.hostlist)).map((host) => ({
      ...host,
      alias: aliases[host.name]?.alias ?? host.name,
      groups: homelab.includes(host.name) ? ['homelab'] : [],
    }));
    this.services = Object.values(structuredClone(fixture.servicelist.data.servicelist)).flatMap(
      (list) => Object.values(list),
    );
    this.version = fixture.programstatus.data.programstatus.version;
    /** 'down' (refused), 'proxy' (502), 'not_nagios', 'stopped' (no status.dat), 'stale', or null */
    this.failure = null;
    /** Rights the user lacks: 'hosts' (contact of nothing), 'commands'; or 'external_commands' off. */
    this.missing = new Set();
    /** Before Nagios 4.5: cmd.cgi has no CSRF token. */
    this.csrf = true;
    /** lock_author_names=0: the author comes from the form, and must not be empty. */
    this.lockAuthor = true;
    /** A proxy that loses the POST body: cmd.cgi shows the form again. */
    this.formOnPost = false;
    /** A web server that refuses the reads (`Require ip`). */
    this.forbidden = false;
    this.calls = [];
    /** Commands committed: { type, host, service, comment, startTime }. */
    this.commands = [];
  }

  host(name) {
    return this.hosts.find((host) => host.name === name);
  }

  service(host, description) {
    return this.services.find(
      (service) => service.host_name === host && service.description === description,
    );
  }

  /** Put a host in a state: 0 UP, 1 DOWN, 2 UNREACHABLE. */
  setHost(name, state, extra = {}) {
    Object.assign(this.host(name), {
      status: HOST_STATUS[state],
      has_been_checked: true,
      state_type: 1,
      problem_has_been_acknowledged: false,
      ...extra,
    });
  }

  /** Put a service in a state (0 removes it from the answers: OK). */
  setService(host, description, state, extra = {}) {
    const existing = this.service(host, description);
    if (state === 0) {
      this.services = this.services.filter((service) => service !== existing);
      return;
    }
    const values = {
      status: SERVICE_STATUS[state],
      state_type: 1,
      problem_has_been_acknowledged: false,
      ...extra,
    };
    if (existing) {
      Object.assign(existing, values);
      return;
    }
    this.services.push({
      host_name: host,
      description,
      plugin_output: `${description} is ${state}`,
      has_been_checked: true,
      last_state_change: READ_AT - 60_000,
      scheduled_downtime_depth: 0,
      ...values,
    });
  }

  result(query, extra = {}) {
    return {
      query_time: READ_AT,
      cgi: 'statusjson.cgi',
      user: USERNAME,
      query,
      query_status: 'released',
      program_start: fixture.programstatus.result.program_start,
      last_data_update: this.failure === 'stale' ? READ_AT - 3600_000 : READ_AT - 5000,
      type_code: 0,
      type_text: 'Success',
      message: '',
      ...extra,
    };
  }

  visibleHosts() {
    return this.missing.has('hosts') ? [] : this.hosts;
  }

  /** The network seam of the client (src/nagios/http.js). */
  async request(url, { method = 'GET', body = '', headers = {} }) {
    if (this.failure === 'down') {
      throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    }
    if (this.failure === 'proxy') {
      return { status: 502, headers: {}, body: '<html>Bad Gateway</html>' };
    }
    if (this.failure === 'not_nagios') {
      return html('<html>It works!</html>');
    }
    if (!url.startsWith(`${CGI_URL}/`)) {
      return { status: 404, headers: {}, body: '<html>Not Found</html>' };
    }
    const target = new URL(url);
    const cgi = target.pathname.slice(new URL(CGI_URL).pathname.length + 1);
    const params = Object.fromEntries(target.searchParams);
    const form = method === 'POST' ? Object.fromEntries(new URLSearchParams(body)) : {};
    this.calls.push({ method, cgi, params, form });
    const expected = `Basic ${Buffer.from(`${USERNAME}:${PASSWORD}`).toString('base64')}`;
    if (headers.authorization !== expected) {
      return { status: 401, headers: {}, body: '<html><h1>Unauthorized</h1></html>' };
    }
    if (this.forbidden) {
      return { status: 403, headers: {}, body: '<html><h1>Forbidden</h1></html>' };
    }
    if (cgi === 'statusjson.cgi') {
      if (this.failure === 'stopped') {
        return { status: 200, headers: {}, body: '\n' }; // status.dat removed
      }
      return this.status(params);
    }
    if (cgi === 'objectjson.cgi' && params.query === 'hostlist') {
      const hostlist = Object.fromEntries(
        this.visibleHosts().map((host) => [
          host.name,
          { name: host.name, display_name: host.name, alias: host.alias },
        ]),
      );
      return json({ format_version: 0, result: this.result('hostlist'), data: { hostlist } });
    }
    if (cgi === 'cmd.cgi') {
      return method === 'POST' ? this.commit(form, headers) : this.form();
    }
    return { status: 404, headers: {}, body: '<html>Not Found</html>' };
  }

  status(params) {
    if (params.query === 'programstatus') {
      const programstatus = { ...fixture.programstatus.data.programstatus, version: this.version };
      return json({
        format_version: 0,
        result: this.result('programstatus'),
        data: { programstatus },
      });
    }
    if (params.query === 'hostlist') {
      let hosts = this.visibleHosts();
      if (params.hostgroup) {
        if (!this.hosts.some((host) => host.groups.includes(params.hostgroup))) {
          // Nagios knows only the groups that have members here.
          return json({
            ...fixture.hostgroup_unknown,
            result: {
              ...fixture.hostgroup_unknown.result,
              message: `The hostgroup '${params.hostgroup}' could not be found.`,
            },
          });
        }
        hosts = hosts.filter((host) => host.groups.includes(params.hostgroup));
      }
      const details = params.details === 'true';
      const hostlist = Object.fromEntries(
        hosts.map((host) => {
          const { alias, groups, ...status } = host; // not in the status of Nagios
          void alias;
          void groups;
          return [host.name, details ? status : status.status];
        }),
      );
      return json({ format_version: 0, result: this.result('hostlist'), data: { hostlist } });
    }
    if (params.query === 'servicelist') {
      const mask = String(params.servicestatus ?? '')
        .split(' ')
        .reduce((sum, name) => sum + (SERVICE_FILTER[name] ?? 0), 0);
      const visible = new Set(this.visibleHosts().map((host) => host.name));
      const servicelist = {};
      for (const service of this.services) {
        if (!visible.has(service.host_name) || (mask && !(service.status & mask))) {
          continue;
        }
        servicelist[service.host_name] ??= {};
        servicelist[service.host_name][service.description] = service;
      }
      return json({ format_version: 0, result: this.result('servicelist'), data: { servicelist } });
    }
    return json({
      format_version: 0,
      result: this.result(params.query, { type_code: 6, type_text: 'Option Value Invalid' }),
      data: {},
    });
  }

  form() {
    const page = this.csrf
      ? fixture.cmd_form
      : fixture.cmd_form.replace(/<INPUT TYPE='hidden' NAME='nagFormId'[^>]*>/, '');
    return html(page, this.csrf ? { 'set-cookie': `NagFormId=${TOKEN}; SameSite=Strict` } : {});
  }

  commit(form, headers) {
    if (this.csrf && (form.nagFormId !== TOKEN || headers.cookie !== `NagFormId=${TOKEN}`)) {
      return errorPage('Error: Invalid or missing CSRF cookie!');
    }
    if (this.formOnPost) {
      return html(fixture.cmd_form);
    }
    if (!this.lockAuthor && !form.com_author) {
      return errorPage('Author was not entered');
    }
    if (this.missing.has('commands')) {
      return html(fixture.cmd_denied);
    }
    if (this.missing.has('external_commands')) {
      return errorPage(
        'Sorry, but Nagios is currently not checking for external commands, so your command will not be committed!',
      );
    }
    const type = Number(form.cmd_typ);
    const host = this.host(form.host);
    if (!host || form.cmd_mod !== '2') {
      return html(fixture.cmd_denied); // what cmd.cgi says for an unknown host too
    }
    this.commands.push({
      type,
      host: form.host,
      ...(form.service ? { service: form.service } : {}),
      ...(form.com_data ? { comment: form.com_data } : {}),
      ...(form.start_time ? { startTime: form.start_time } : {}),
      ...(form.com_author ? { author: form.com_author } : {}),
    });
    // Nagios applies them later (status.dat every 10 s): the tests see them at once.
    if (type === 33 && host.status !== 2) {
      host.problem_has_been_acknowledged = true;
    }
    const service = this.service(form.host, form.service);
    if (type === 34 && service) {
      service.problem_has_been_acknowledged = true;
    }
    return html(fixture.cmd_success);
  }
}
