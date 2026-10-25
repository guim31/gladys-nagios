// -----------------------------------------------------------------------------
// Nagios Core 4 client: the JSON CGIs (`statusjson.cgi`, `objectjson.cgi`)
// and the command CGI (`cmd.cgi`), behind the HTTP Basic auth of the web
// server (the `htpasswd.users` of Nagios).
//
// One read (snapshot) = three GET requests, plus one per host group of the
// configuration: `programstatus` (version, and whether the daemon is
// running), the status of every host, the services WARNING, CRITICAL or
// UNKNOWN. The aliases of the hosts (`objectjson.cgi`, a large answer) are
// read once an hour, and when a new host shows up.
//
// Commands (acknowledge, check now) go through `cmd.cgi` as the web
// interface does: a GET of the form gives the CSRF token of Nagios 4.5
// (`nagFormId`, also set as a cookie) and the times in the `date_format` of
// the server, then a POST commits it. Nagios answers HTML; success and error
// are told by the `infoMessage` / `errorMessage` block.
//
// Errors are thrown as NagiosError with a `kind` (ERROR_KINDS): the hub and
// the texts know what to tell the user from it.
// -----------------------------------------------------------------------------

import { httpRequest } from './http.js';

export const ERROR_KINDS = Object.freeze({
  UNREACHABLE: 'unreachable', // no answer, timeout, 502/503/504
  TLS: 'tls', // the certificate does not verify
  AUTH: 'auth', // user or password refused (401)
  CREDENTIALS_MISSING: 'credentials_missing', // 401 with no user configured
  NOT_NAGIOS: 'not_nagios', // something answers, but not the CGIs of Nagios Core 4
  DAEMON_STOPPED: 'daemon_stopped', // the CGIs answer, the Nagios process does not run
  NO_HOSTS: 'no_hosts', // no host visible: the user is not a contact of any
  UNKNOWN_GROUP: 'unknown_group', // a host group of the configuration does not exist
  PERMISSION: 'permission', // cmd.cgi: the user may not send commands
  COMMANDS_DISABLED: 'commands_disabled', // check_external_commands=0, or no command file
  API: 'api', // a CGI refused a request (parameters)
  HTTP: 'http', // anything else
});

export class NagiosError extends Error {
  /**
   * @param {string} kind one of ERROR_KINDS
   * @param {string} message for the logs (never a secret)
   * @param {object} [extra] e.g. { status }
   */
  constructor(kind, message, extra = {}) {
    super(message);
    this.name = 'NagiosError';
    this.kind = kind;
    Object.assign(this, extra);
  }
}

const TLS_CODES = new Set([
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'CERT_HAS_EXPIRED',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

// The status of Nagios is a bit mask in the JSON CGIs.
const HOST_STATUS = Object.freeze({ PENDING: 1, UP: 2, DOWN: 4, UNREACHABLE: 8 });
const SERVICE_STATUS = Object.freeze({ PENDING: 1, OK: 2, WARNING: 4, UNKNOWN: 8, CRITICAL: 16 });
// To the states of the rest of the code: hosts 0 UP, 1 DOWN, 2 UNREACHABLE;
// services 1 WARNING, 2 CRITICAL, 3 UNKNOWN.
const HOST_STATE = { [HOST_STATUS.UP]: 0, [HOST_STATUS.DOWN]: 1, [HOST_STATUS.UNREACHABLE]: 2 };
const SERVICE_STATE = {
  [SERVICE_STATUS.WARNING]: 1,
  [SERVICE_STATUS.CRITICAL]: 2,
  [SERVICE_STATUS.UNKNOWN]: 3,
};

// Nagios writes status.dat every 10 s by default (status_update_interval):
// older than this, the daemon is hung or stopped without removing it.
export const STALE_STATUS_MS = 10 * 60_000;

// Command numbers of cmd.cgi (include/common.h of Nagios Core).
export const COMMANDS = Object.freeze({
  ACKNOWLEDGE_HOST: 33,
  ACKNOWLEDGE_SERVICE: 34,
  CHECK_HOST_SERVICES: 17, // SCHEDULE_HOST_SVC_CHECKS: every service of a host
  CHECK_HOST: 96, // SCHEDULE_HOST_CHECK
});

// The first line of a check output (the rest is the long output).
const firstLine = (text) => String(text ?? '').split('\n')[0];
const seconds = (ms) => (Number(ms) > 0 ? Math.round(Number(ms) / 1000) : 0);

const decodeHtml = (text) =>
  text
    .replace(/<[^>]*>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .trim();

/** The `errorMessage` / `infoMessage` of a cmd.cgi page. */
export function commandOutcome(html) {
  const block = (kind) => {
    // The first sentence: a <BR> follows it.
    const match = new RegExp(`class=['"]${kind}['"][^>]*>([^<]*)`, 'i').exec(html);
    return match ? decodeHtml(match[1]) : null;
  };
  return { error: block('errorMessage'), info: block('infoMessage') };
}

/** The value of an `<input name=…>` of a cmd.cgi form, null when absent. */
export function formValue(html, name) {
  for (const match of html.matchAll(/<input\b[^>]*>/gi)) {
    const tag = match[0];
    const named = /\bname\s*=\s*(['"])([^'"]*)\1/i.exec(tag);
    if (named && named[2] === name) {
      const value = /\bvalue\s*=\s*(['"])([^]*?)\1/i.exec(tag);
      return value ? value[2] : '';
    }
  }
  return null;
}

export class NagiosClient {
  /**
   * @param {object} options
   * @param {string} options.url base URL of the CGIs (…/cgi-bin)
   * @param {string} [options.username] web user (htpasswd.users)
   * @param {string} [options.password] its password
   * @param {boolean} [options.insecure] accept a certificate that does not verify
   * @param {typeof httpRequest} [options.request] test seam
   * @param {number} [options.timeoutMs]
   */
  constructor({
    url,
    username = '',
    password = '',
    insecure = false,
    request = httpRequest,
    timeoutMs = 15_000,
  }) {
    this.url = url;
    this.username = username;
    this.password = password;
    this.insecure = insecure;
    this.request = request;
    this.timeoutMs = timeoutMs;
    /** Host aliases (objectjson.cgi), read again after reset(). */
    this.aliases = null;
  }

  /** Read the aliases again before the next snapshot (hosts renamed in Nagios). */
  reset() {
    this.aliases = null;
  }

  /** One HTTP request to a CGI, with the auth; network errors become NagiosError. */
  async send(path, { method = 'GET', params = [], form, cookie } = {}) {
    const query = new URLSearchParams(params).toString();
    const headers = { accept: 'application/json, text/html' };
    if (this.username) {
      headers.authorization = `Basic ${Buffer.from(`${this.username}:${this.password}`).toString('base64')}`;
    }
    let body = '';
    if (form) {
      headers['content-type'] = 'application/x-www-form-urlencoded';
      body = new URLSearchParams(form).toString();
    }
    if (cookie) {
      headers.cookie = cookie;
    }
    let response;
    try {
      response = await this.request(`${this.url}/${path}${query ? `?${query}` : ''}`, {
        method,
        body,
        headers,
        insecure: this.insecure,
        timeoutMs: this.timeoutMs,
      });
    } catch (err) {
      if (TLS_CODES.has(err.code)) {
        throw new NagiosError(ERROR_KINDS.TLS, `Certificate refused (${err.code})`);
      }
      if (!err.code) {
        // The server answers, but not as expected (an answer too large…).
        throw new NagiosError(ERROR_KINDS.HTTP, err.message);
      }
      throw new NagiosError(ERROR_KINDS.UNREACHABLE, `${err.code}`);
    }
    const { status } = response;
    if ([502, 503, 504].includes(status)) {
      throw new NagiosError(ERROR_KINDS.UNREACHABLE, `HTTP ${status}`, { status });
    }
    if (status === 401) {
      throw new NagiosError(
        this.username ? ERROR_KINDS.AUTH : ERROR_KINDS.CREDENTIALS_MISSING,
        'Refused (HTTP 401)',
        { status },
      );
    }
    if (status === 403) {
      throw new NagiosError(ERROR_KINDS.PERMISSION, `${path}: HTTP 403`, { status });
    }
    if (status === 404 || (status >= 300 && status < 400)) {
      throw new NagiosError(ERROR_KINDS.NOT_NAGIOS, `No Nagios CGI here (HTTP ${status})`, {
        status,
      });
    }
    if (status !== 200) {
      throw new NagiosError(ERROR_KINDS.HTTP, `${path}: HTTP ${status}`, { status });
    }
    return response;
  }

  /**
   * One query to a JSON CGI.
   * @param {string} cgi `statusjson.cgi` or `objectjson.cgi`
   * @param {Record<string, string>} params
   * @returns {Promise<{ result: object, data: object }>}
   * @throws {NagiosError}
   */
  async json(cgi, params) {
    const response = await this.send(cgi, { params });
    // A stopped Nagios removes status.dat: statusjson.cgi then answers an
    // empty 200 (Nagios Core 4.5.12).
    if (cgi === 'statusjson.cgi' && !response.body.trim()) {
      throw new NagiosError(ERROR_KINDS.DAEMON_STOPPED, 'Empty status: Nagios is not running');
    }
    let parsed;
    try {
      parsed = JSON.parse(response.body);
    } catch {
      parsed = null;
    }
    if (!parsed || typeof parsed.result !== 'object' || parsed.result === null) {
      throw new NagiosError(ERROR_KINDS.NOT_NAGIOS, `Not a Nagios JSON CGI answer (${cgi})`);
    }
    const code = Number(parsed.result.type_code);
    if (code !== 0) {
      const message = String(parsed.result.message ?? parsed.result.type_text ?? '');
      throw new NagiosError(ERROR_KINDS.API, `${cgi} ${params.query}: ${message}`, {
        code,
        detail: message,
      });
    }
    return { result: parsed.result, data: parsed.data ?? {} };
  }

  /** Version and liveness of the daemon (`programstatus`). */
  async programStatus() {
    const { result, data } = await this.json('statusjson.cgi', { query: 'programstatus' });
    const status = data.programstatus ?? {};
    // Both times come from the server clock: no skew with the container.
    const age = Number(result.query_time) - Number(result.last_data_update);
    if (Number(result.last_data_update) > 0 && age > STALE_STATUS_MS) {
      throw new NagiosError(
        ERROR_KINDS.DAEMON_STOPPED,
        `Status not updated for ${Math.round(age / 60_000)} min: Nagios is hung or stopped`,
      );
    }
    return {
      version: typeof status.version === 'string' ? status.version : '',
      startedAt: seconds(status.program_start),
    };
  }

  /** Host aliases by name (`objectjson.cgi`), as typed in the Nagios configuration. */
  async readAliases() {
    const { data } = await this.json('objectjson.cgi', { query: 'hostlist', details: 'true' });
    const aliases = new Map();
    for (const [name, host] of Object.entries(data.hostlist ?? {})) {
      const alias = typeof host?.alias === 'string' && host.alias.trim() ? host.alias.trim() : '';
      aliases.set(name, alias || name);
    }
    this.aliases = aliases;
    return aliases;
  }

  /** The names of the hosts of the host groups (union), null for every host. */
  async groupMembers(groups) {
    if (groups.length === 0) {
      return null;
    }
    const members = new Set();
    for (const group of groups) {
      try {
        const { data } = await this.json('statusjson.cgi', { query: 'hostlist', hostgroup: group });
        for (const name of Object.keys(data.hostlist ?? {})) {
          members.add(name);
        }
      } catch (err) {
        // "The hostgroup 'x' could not be found." (type_code 6)
        if (err.kind === ERROR_KINDS.API && err.code === 6) {
          throw new NagiosError(ERROR_KINDS.UNKNOWN_GROUP, `Unknown host group "${group}"`, {
            group,
          });
        }
        throw err;
      }
    }
    return members;
  }

  /**
   * Everything one cycle needs, in the scope of the configuration.
   * @param {{ groups?: string[] }} [scope]
   * @returns {Promise<{ version: string, hosts: object[], services: object[], total: number }>}
   * @throws {NagiosError}
   */
  async snapshot({ groups = [] } = {}) {
    const { version } = await this.programStatus();
    const { data } = await this.json('statusjson.cgi', { query: 'hostlist', details: 'true' });
    const rawHosts = Object.entries(data.hostlist ?? {}).filter(
      ([name, host]) => name && host && typeof host === 'object',
    );
    // A user who is the contact of no host (and not authorized_for_all_hosts)
    // sees nothing: taken as is, every problem would end, then start again.
    if (rawHosts.length === 0) {
      throw new NagiosError(ERROR_KINDS.NO_HOSTS, 'No host visible to this user');
    }
    if (!this.aliases || rawHosts.some(([name]) => !this.aliases.has(name))) {
      await this.readAliases();
    }
    const members = await this.groupMembers(groups);
    const hosts = rawHosts
      .filter(([name]) => !members || members.has(name))
      .map(([name, host]) => {
        const status = Number(host.status);
        return {
          name,
          alias: this.aliases.get(name) ?? name,
          // null until checked once (PENDING).
          state: host.has_been_checked === false ? null : (HOST_STATE[status] ?? null),
          acknowledged: host.problem_has_been_acknowledged === true,
          downtime: Number(host.scheduled_downtime_depth) > 0,
          since: seconds(host.last_state_change),
          // SOFT (0) while Nagios retries before alerting; HARD (1) once confirmed.
          hard: Number(host.state_type) === 1,
        };
      });
    const byName = new Map(hosts.map((host) => [host.name, host]));

    const answer = await this.json('statusjson.cgi', {
      query: 'servicelist',
      details: 'true',
      servicestatus: 'warning critical unknown',
    });
    const services = [];
    for (const [hostName, list] of Object.entries(answer.data.servicelist ?? {})) {
      const host = byName.get(hostName);
      if (!host || !list || typeof list !== 'object') {
        continue;
      }
      for (const [description, service] of Object.entries(list)) {
        const state = SERVICE_STATE[Number(service?.status)];
        if (!state || service.has_been_checked === false) {
          continue;
        }
        services.push({
          host: hostName,
          // The description identifies a service in Nagios: what cmd.cgi takes.
          name: description,
          service: description,
          state,
          acknowledged: service.problem_has_been_acknowledged === true,
          // A downtime of the service or of its host: Nagios does not notify.
          downtime: Number(service.scheduled_downtime_depth) > 0 || host.downtime,
          since: seconds(service.last_state_change),
          hard: Number(service.state_type) === 1,
          output: firstLine(service.plugin_output),
        });
      }
    }
    return { version, hosts, services, total: rawHosts.length };
  }

  /**
   * Commit one command through cmd.cgi.
   * @param {number} type a COMMANDS value
   * @param {Record<string, string>} fields host, service, com_data…
   * @throws {NagiosError}
   */
  async command(type, fields) {
    // The form: the CSRF token (Nagios 4.5+, absent before) and the start
    // time in the date_format of the server.
    const page = await this.send('cmd.cgi', { params: { cmd_typ: String(type), ...fields } });
    const before = commandOutcome(page.body);
    if (before.error) {
      throw this.commandError(type, before.error);
    }
    const token = formValue(page.body, 'nagFormId');
    const form = { cmd_typ: String(type), cmd_mod: '2', ...fields };
    const startTime = formValue(page.body, 'start_time');
    if (startTime !== null) {
      form.start_time = startTime;
    }
    if (token) {
      form.nagFormId = token;
    }
    const result = await this.send('cmd.cgi', {
      method: 'POST',
      form,
      cookie: token ? `NagFormId=${token}` : undefined,
    });
    const outcome = commandOutcome(result.body);
    if (outcome.error || !outcome.info) {
      throw this.commandError(type, outcome.error ?? 'No answer from cmd.cgi');
    }
  }

  commandError(type, message) {
    let kind = ERROR_KINDS.API;
    if (/not authorized/i.test(message)) {
      kind = ERROR_KINDS.PERMISSION;
    } else if (/external commands|command file/i.test(message)) {
      kind = ERROR_KINDS.COMMANDS_DISABLED;
    }
    return new NagiosError(kind, `cmd.cgi ${type}: ${message}`);
  }

  /** Acknowledge a host problem (sticky, persistent comment, no notification). */
  acknowledgeHost(host, comment) {
    return this.command(COMMANDS.ACKNOWLEDGE_HOST, {
      host,
      com_data: comment,
      sticky_ack: 'on',
    });
  }

  acknowledgeService(host, service, comment) {
    return this.command(COMMANDS.ACKNOWLEDGE_SERVICE, {
      host,
      service,
      com_data: comment,
      sticky_ack: 'on',
    });
  }

  /** Check a host and all its services now (forced: also outside their check period). */
  async checkHostNow(host) {
    await this.command(COMMANDS.CHECK_HOST, { host, force_check: 'on' });
    await this.command(COMMANDS.CHECK_HOST_SERVICES, { host, force_check: 'on' });
  }
}
