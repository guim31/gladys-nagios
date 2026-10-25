// -----------------------------------------------------------------------------
// The Nagios hub: reads Nagios Core on a timer of the container (the interval
// chosen in the configuration), publishes the states of the added devices
// when they change, fires the scene events on hosts going down or up and on
// services entering or leaving a problem, and holds the views the widget and
// the scene actions read.
//
// Gladys never polls these devices (should_poll: false): the interval goes up
// to 5 minutes, beyond the fixed list of the core scheduler, and the scene
// events must fire for every host, added to Gladys or not.
//
// The problems already seen are kept in /data (src/store.js): a problem that
// started or ended while the integration or Gladys restarted is still
// announced, once. The very first read only records them.
// -----------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import { DEVICE_TRANSPORTS, createLogger } from '@gladysassistant/integration-sdk';
import {
  FEATURE_KEYS,
  buildHostDevice,
  buildInstanceDevice,
  hostIds,
  hostValues,
  isDown,
  parseHostName,
  instanceIds,
  instanceValues,
} from './devices.js';
import { ERROR_KINDS, NagiosClient, NagiosError } from './nagios/client.js';
import { addressOf } from './config.js';
import { FailureLog } from './logs.js';
import {
  CONNECTION_TEXT,
  ERROR_TEXT,
  HOST_STATE_NAMES,
  REPORT_TEXT,
  SERVICE_STATE_NAMES,
  labelled,
  pick,
} from './texts.js';

const logger = createLogger({ name: 'nagios-hub' });

export const WIDGET_KEY = 'problems';

// Scene trigger keys (manifest `scene_triggers`): permanent once published.
export const TRIGGERS = Object.freeze({
  HOST_DOWN: 'host_down',
  HOST_UP: 'host_up',
  SERVICE_PROBLEM: 'service_problem',
  SERVICE_RECOVERED: 'service_recovered',
  UNREACHABLE: 'nagios_unreachable',
});

export const HUB_TIMINGS = {
  // A Nagios that fails once is read again this soon, to tell a blip from an outage.
  retryMs: 15_000,
  // Failures in a row before Nagios counts as unreachable (scene event).
  downAfterFailures: 2,
  // A scene action or the widget reads Nagios again when the last read is older.
  freshMs: 15_000,
  // The host aliases (a large answer) are read again this often (hosts renamed).
  detectEveryMs: 3600_000,
  // An unchanged value is sent again this often: Gladys marks a value older
  // than 48 h as outdated.
  heartbeatMs: 6 * 3600_000,
};

// Scene events per read, at most: Gladys accepts 300 per minute, and a
// network outage can raise dozens of problems at once. The rest waits for the
// next reads.
export const MAX_EVENTS_PER_READ = 30;

// The errors that mean "Nagios no longer watches" (scene event).
const OUTAGE_KINDS = new Set([ERROR_KINDS.UNREACHABLE, ERROR_KINDS.DAEMON_STOPPED]);

const MAX_STATES_PER_REQUEST = 100;
// States per read, at most (Gladys accepts 300 per minute): the changes first,
// then the heartbeats; the rest goes at the next read.
export const MAX_STATES_PER_READ = 200;

const signature = (config) =>
  JSON.stringify([config.apiUrl, config.username, config.password, config.allowSelfSigned]);
// What decides which problems are seen: another scope does not resolve the
// problems of the previous one. The user is part of it (another user may see
// other hosts), hashed; a new password for the same user changes nothing.
const scopeOf = (config) =>
  JSON.stringify([
    config.apiUrl,
    config.groups,
    createHash('sha256').update(config.username).digest('hex').slice(0, 16),
  ]);

/** Key of a service in the saved state (its object name, not its display name): a host name has no new line. */
export const serviceKey = (host, service) => `${host}\n${service}`;

const minutesSince = (since, now) =>
  since ? Math.max(0, Math.round((now / 1000 - since) / 60)) : 0;

export class NagiosHub {
  /**
   * @param {object} options
   * @param {object} options.gladys GladysIntegration (or the SDK's fake Gladys)
   * @param {object} options.store persistence (src/store.js)
   * @param {Function} [options.request] HTTP seam (src/nagios/http.js)
   * @param {boolean} [options.timers] periodic timers (off in tests)
   * @param {object} [options.timings] HUB_TIMINGS overrides
   * @param {() => number} [options.now]
   */
  constructor({ gladys, store, request, timers = true, timings, now }) {
    this.gladys = gladys;
    this.store = store;
    this.request = request;
    this.timersEnabled = timers;
    this.timings = { ...HUB_TIMINGS, ...timings };
    this.now = now ?? (() => Date.now());
    this.config = null;
    this.client = null;
    this.signature = null;
    /** Last successful read: hosts by name, services not OK, version. */
    this.data = null;
    this.error = null;
    /** Whether the Nagios daemon runs: null until known. */
    this.running = null;
    this.failures = 0;
    this.down = false;
    this.readAt = 0;
    this.detectedAt = 0;
    this.polling = null;
    this.generation = 0;
    /** Last value published per feature external id, and when. */
    this.published = new Map();
    this.publishedAt = new Map();
    this.transports = new Map();
    this.connection = null;
    this.discovered = null;
    this.saved = { scope: null, primed: false, hosts: {}, services: {} };
    this.pollTimer = null;
    this.retryTimer = null;
    this.stopped = false;
    // What fails again at every cycle (Gladys refusing, the reading loop):
    // one line when it starts, one when it ends.
    this.failureLog = new FailureLog(logger);
  }

  // --- Lifecycle -------------------------------------------------------------

  async start(config) {
    const saved = await this.store.load();
    const object = (value) => (value && typeof value === 'object' ? value : {});
    this.saved = {
      scope: typeof saved.scope === 'string' ? saved.scope : null,
      primed: saved.primed === true,
      hosts: object(saved.hosts),
      services: object(saved.services),
    };
    await this.reconfigure(config);
  }

  /** Gladys reconnected (it restarted): send everything again. */
  async resync(config) {
    this.published.clear();
    this.publishedAt.clear();
    this.transports.clear();
    this.connection = null;
    this.discovered = null;
    await this.reconfigure(config);
  }

  async reconfigure(config) {
    const languageChanged = this.config?.language !== config.language;
    this.config = config;
    if (this.signature !== signature(config)) {
      this.generation += 1; // a read in progress for the old instance is ignored
      this.signature = signature(config);
      this.client = config.apiUrl
        ? new NagiosClient({
            url: config.apiUrl,
            username: config.username,
            password: config.password,
            insecure: config.allowSelfSigned,
            request: this.request,
          })
        : null;
      this.data = null;
      this.error = null;
      this.running = null;
      this.failures = 0;
      this.down = false;
      this.readAt = 0;
      clearTimeout(this.retryTimer);
    }
    const scope = scopeOf(config);
    if (this.saved.scope !== scope) {
      this.generation += 1; // a read in progress for the old scope is ignored
      this.saved = { scope, primed: false, hosts: {}, services: {} };
      this.store.save(this.saved);
    }
    if (languageChanged) {
      this.discovered = null;
    }
    await this.pollAll({ publish: true });
    this.schedulePoll();
  }

  async stop() {
    this.stopped = true;
    clearTimeout(this.pollTimer);
    clearTimeout(this.retryTimer);
    await this.store.flush();
  }

  schedulePoll() {
    clearTimeout(this.pollTimer);
    if (!this.timersEnabled || this.stopped || !this.client) {
      return;
    }
    this.pollTimer = setTimeout(async () => {
      try {
        await this.pollAll();
        this.failureLog.recover('poll', 'Reading Nagios works again');
      } catch (err) {
        this.failureLog.fail('poll', `Poll failed: ${err.message}`, 'error');
      }
      this.schedulePoll();
    }, this.config.pollIntervalMs);
  }

  // --- Reading Nagios -----------------------------------------------------------

  async pollAll({ publish = false, fresh = false } = {}) {
    const changed = await this.poll({ fresh });
    await this.afterChanges(changed, { publish });
  }

  /** Gladys asks for a refresh (onPoll): read now. */
  async pollDevice() {
    await this.pollAll();
  }

  /** Read again when the last read is older than `freshMs` (scene actions, widget). */
  async refreshIfStale() {
    if (this.client && this.now() - this.readAt >= this.timings.freshMs) {
      await this.pollAll();
    }
  }

  /**
   * Read Nagios and apply what changed. Concurrent calls share the read.
   * @returns {Promise<boolean>} whether the widget shows something new
   */
  poll({ fresh = false } = {}) {
    if (!this.client) {
      return Promise.resolve(false);
    }
    if (this.polling && (fresh || this.pollingGeneration !== this.generation)) {
      // A read started before an acknowledgement or a new configuration:
      // read again once it is over.
      return this.polling.catch(() => {}).then(() => this.poll());
    }
    if (!this.polling) {
      this.pollingGeneration = this.generation;
      this.polling = this.read().finally(() => {
        this.polling = null;
      });
    }
    return this.polling;
  }

  async read() {
    const { generation, client } = this;
    if (this.now() - this.detectedAt >= this.timings.detectEveryMs) {
      client.reset();
      this.detectedAt = this.now();
    }
    try {
      const snapshot = await client.snapshot({ groups: this.config.groups });
      return generation === this.generation ? await this.applySuccess(snapshot) : false;
    } catch (caught) {
      // An answer of an unexpected shape (a list that is not one…).
      const err = caught.kind ? caught : new NagiosError(ERROR_KINDS.HTTP, caught.message);
      return generation === this.generation ? await this.applyFailure(err) : false;
    }
  }

  instanceName() {
    return addressOf(this.config.apiUrl);
  }

  async applySuccess({ version, hosts, services, total }) {
    const previous = this.data;
    let widgetChanged = this.error !== null || previous === null;
    if (this.error) {
      logger.info(`Nagios ${this.instanceName()} answers again`);
    }
    if (!previous || version !== previous.version) {
      logger.info(
        `Nagios ${version || '(version unknown)'} at ${this.instanceName()}: ` +
          `${hosts.length} of ${total} host(s) in scope`,
      );
    }
    this.error = null;
    this.running = true;
    this.failures = 0;
    this.down = false;
    this.readAt = this.now();
    this.data = {
      version,
      total,
      hosts: new Map(hosts.map((host) => [host.name, host])),
      services,
    };
    if (
      previous &&
      (JSON.stringify(previous.services) !== JSON.stringify(services) ||
        JSON.stringify([...previous.hosts.values()]) !== JSON.stringify(hosts))
    ) {
      widgetChanged = true;
    }
    const { generation } = this;
    await this.transitions();
    if (generation !== this.generation) {
      return false; // reconfigured while Gladys took the events
    }
    await this.publishStates();
    return widgetChanged;
  }

  async applyFailure(err) {
    const wasError = this.error?.kind;
    this.error = { kind: err.kind, message: err.message };
    this.readAt = this.now();
    if (wasError !== err.kind) {
      logger.warn(`Nagios ${this.instanceName()}: ${err.message}`);
    }
    if (err.kind === ERROR_KINDS.DAEMON_STOPPED && this.running !== false) {
      this.running = false;
      if (this.isCreated(instanceIds(this.gladys).device)) {
        await this.sendStates([
          { externalId: instanceIds(this.gladys).feature(FEATURE_KEYS.DAEMON), value: 0 },
        ]);
      }
    }
    // Only silence counts as an outage, or a daemon that stopped: a refused
    // password is a configuration problem, reported by the connection status.
    if (!OUTAGE_KINDS.has(err.kind)) {
      this.failures = 0;
      this.down = false; // a later outage is announced again
      return wasError !== err.kind;
    }
    this.failures += 1;
    if (this.failures === 1) {
      this.scheduleRetry();
    }
    if (!this.down && this.failures >= this.timings.downAfterFailures) {
      this.down = true;
      await this.fireEvent(TRIGGERS.UNREACHABLE, {
        address: this.instanceName(),
        error: pick(ERROR_TEXT[err.kind], this.config.language),
      });
    }
    return wasError !== err.kind;
  }

  scheduleRetry() {
    clearTimeout(this.retryTimer);
    if (!this.timersEnabled || this.stopped) {
      return;
    }
    this.retryTimer = setTimeout(() => {
      this.pollAll()
        .then(() => this.failureLog.recover('retry'))
        .catch((err) => this.failureLog.fail('retry', `Retry failed: ${err.message}`, 'error'));
    }, this.timings.retryMs);
    this.retryTimer.unref?.();
  }

  /**
   * Compare the hosts and services with the ones already seen; fire the
   * scene events. A change is marked announced only once Gladys accepted its
   * event (Gladys restarting, a burst beyond the cap: sent at a next read),
   * and a recovery is announced only if the problem was (or was already
   * there at the first read). Only HARD states count: Nagios does not
   * notify a SOFT one either. A problem in a
   * downtime is not announced until the downtime is over (Nagios does not
   * notify it either). The problems already there at the first read (or
   * after a change of scope) are recorded, not announced.
   */
  async transitions() {
    const { generation } = this;
    const { hosts: knownHosts, services: knownServices, primed } = this.saved;
    const now = this.now();
    const events = [];

    for (const host of this.data.hosts.values()) {
      if (host.state === null || !host.hard) {
        continue; // PENDING, or SOFT: Nagios is still retrying
      }
      let entry = knownHosts[host.name];
      if (isDown(host)) {
        if (!entry) {
          // Nagios says 0 for a state unchanged since the object was created:
          // count from now, so "back up after N minutes" is not always 0.
          entry = { state: host.state, since: host.since || now / 1000, announced: !primed };
          knownHosts[host.name] = entry;
        }
        entry.state = host.state;
        if (!entry.announced && !host.downtime) {
          events.push({ key: TRIGGERS.HOST_DOWN, host, entry });
        }
      } else if (entry) {
        if (entry.announced) {
          events.push({ key: TRIGGERS.HOST_UP, host, entry });
        } else {
          delete knownHosts[host.name]; // never announced: its end is not either
        }
      }
    }
    for (const name of Object.keys(knownHosts)) {
      if (!this.data.hosts.has(name)) {
        delete knownHosts[name]; // removed from Nagios, or out of the scope
      }
    }

    const current = new Map(
      this.data.services.map((service) => [serviceKey(service.host, service.name), service]),
    );
    for (const [key, service] of current) {
      if (!service.hard) {
        continue; // SOFT: kept as is, neither new nor recovered
      }
      let entry = knownServices[key];
      if (!entry) {
        entry = {
          host: service.host,
          service: service.service,
          name: service.name,
          state: service.state,
          since: service.since || now / 1000,
          // The state announced last; 0: none yet.
          announced: primed ? 0 : service.state,
        };
        knownServices[key] = entry;
      }
      entry.state = service.state;
      entry.output = service.output;
      entry.service = service.service; // the display name may change meanwhile
      if (entry.announced !== service.state && !service.downtime) {
        events.push({ key: TRIGGERS.SERVICE_PROBLEM, service, entry });
      }
    }
    for (const [key, entry] of Object.entries(knownServices)) {
      if (current.has(key)) {
        continue;
      }
      if (!this.data.hosts.has(entry.host) || !entry.announced) {
        delete knownServices[key]; // the host left, or the problem was never announced
      } else {
        events.push({ key: TRIGGERS.SERVICE_RECOVERED, entry, serviceKey: key });
      }
    }
    this.saved.primed = true;

    const sent = events.slice(0, MAX_EVENTS_PER_READ);
    if (events.length > sent.length) {
      logger.warn(`${events.length - sent.length} change(s) left for the next read`);
    }
    for (const event of sent) {
      if (generation !== this.generation) {
        break; // reconfigured meanwhile: these events belong to the old scope
      }
      const data = this.eventData(event, now);
      logger.debug(`${event.key} on ${data.host}${data.service ? ` / ${data.service}` : ''}`);
      if (!(await this.fireEvent(event.key, data))) {
        break; // Gladys refuses: keep the order, try again at the next read
      }
      if (event.key === TRIGGERS.HOST_DOWN) {
        event.entry.announced = true;
      } else if (event.key === TRIGGERS.HOST_UP) {
        delete knownHosts[event.host.name];
      } else if (event.key === TRIGGERS.SERVICE_PROBLEM) {
        event.entry.announced = event.service.state;
      } else {
        delete knownServices[event.serviceKey];
      }
    }
    this.store.save(this.saved);
  }

  eventData({ key, host, service, entry }, now) {
    const hostName = host?.name ?? entry.host;
    const data = {
      device: hostIds(this.gladys, hostName).device,
      host: this.hostLabel(hostName),
    };
    if (key === TRIGGERS.HOST_DOWN) {
      return { ...data, state_name: HOST_STATE_NAMES[host.state] };
    }
    if (key === TRIGGERS.HOST_UP) {
      return { ...data, duration_minutes: minutesSince(entry.since, now) };
    }
    if (key === TRIGGERS.SERVICE_PROBLEM) {
      return {
        ...data,
        service: service.service,
        state: service.state,
        state_name: SERVICE_STATE_NAMES[service.state],
        output: service.output.slice(0, 500),
      };
    }
    return {
      ...data,
      service: entry.service,
      // The last problem state announced, so "CRIT recovered" can be filtered.
      state: entry.announced,
      state_name: SERVICE_STATE_NAMES[entry.announced],
      duration_minutes: minutesSince(entry.since, now),
    };
  }

  /** @returns {Promise<boolean>} whether Gladys accepted the event */
  async fireEvent(key, data) {
    try {
      await this.gladys.publishSceneEvent(key, data);
      this.failureLog.recover('event', 'Scene events accepted again');
      return true;
    } catch (err) {
      this.failureLog.fail('event', `Scene event refused: ${err.message}`);
      return false;
    }
  }

  // --- Devices -----------------------------------------------------------------

  isCreated(externalId) {
    return (this.gladys.devices ?? []).some((device) => device.external_id === externalId);
  }

  servicesOf(hostName) {
    return (this.data?.services ?? []).filter((service) => service.host === hostName);
  }

  discoveredDevices() {
    if (!this.data) {
      return [];
    }
    const language = this.config.language;
    const hosts = [...this.data.hosts.values()].sort((a, b) =>
      (a.alias || a.name).localeCompare(b.alias || b.name),
    );
    return [
      buildInstanceDevice(this.gladys, this.instanceName(), language),
      ...hosts.map((host) => buildHostDevice(this.gladys, host, language)),
    ];
  }

  /** Publish the Discovery list when it changed (a host added, renamed…). */
  async publishDevices({ force = false } = {}) {
    // Nothing read yet: keep the list Gladys has (an empty list only once
    // the address is removed from the configuration).
    if (!this.data && (!force || this.client)) {
      return;
    }
    const devices = this.discoveredDevices();
    const key = JSON.stringify(devices);
    if (!force && key === this.discovered) {
      return;
    }
    try {
      await this.gladys.publishDiscoveredDevices(devices);
      this.discovered = key;
      this.failureLog.recover('discovered', 'Discovered devices accepted again');
    } catch (err) {
      this.failureLog.fail('discovered', `Discovered devices refused: ${err.message}`);
    }
  }

  /** "Search" in the Discovery tab: read Nagios, publish the list again. */
  async rediscover() {
    await this.poll();
    await this.publishDevices({ force: true });
  }

  /** The user added a device: its states sent before were dropped by Gladys. */
  async onDeviceCreated(device) {
    if (!this.data) {
      return;
    }
    const externalId = device.external_id;
    if (externalId === instanceIds(this.gladys).device) {
      await this.sendStates(
        instanceValues(
          this.gladys,
          [...this.data.hosts.values()],
          this.data.services,
          this.running,
        ),
        { force: true },
      );
    } else {
      const host = this.findHost(externalId);
      if (!host) {
        return;
      }
      await this.sendStates(hostValues(this.gladys, host, this.servicesOf(host.name)), {
        force: true,
      });
    }
    await this.publishTransports();
    this.gladys.requestWidgetRefresh(WIDGET_KEY);
  }

  // --- Publishing to Gladys ----------------------------------------------------------

  /** The states of the added devices that changed (or are due for a heartbeat). */
  async publishStates() {
    const values = [];
    const hosts = [...this.data.hosts.values()];
    if (this.isCreated(instanceIds(this.gladys).device)) {
      values.push(...instanceValues(this.gladys, hosts, this.data.services, this.running));
    }
    for (const host of hosts) {
      if (this.isCreated(hostIds(this.gladys, host.name).device)) {
        values.push(...hostValues(this.gladys, host, this.servicesOf(host.name)));
      }
    }
    await this.sendStates(values);
  }

  async sendStates(values, { force = false } = {}) {
    const now = this.now();
    const known = values.filter(({ value }) => value !== null); // unknown: the last value stands
    const changed = known.filter(
      ({ externalId, value }) => force || this.published.get(externalId) !== value,
    );
    const due = known.filter(
      ({ externalId, value }) =>
        !force &&
        this.published.get(externalId) === value &&
        now - (this.publishedAt.get(externalId) ?? 0) >= this.timings.heartbeatMs,
    );
    const states = [...changed, ...due]
      .slice(0, force ? Infinity : MAX_STATES_PER_READ)
      .map(({ externalId, value }) => ({ device_feature_external_id: externalId, state: value }));
    for (let at = 0; at < states.length; at += MAX_STATES_PER_REQUEST) {
      const batch = states.slice(at, at + MAX_STATES_PER_REQUEST);
      try {
        await this.gladys.publishStates(batch);
        for (const state of batch) {
          this.published.set(state.device_feature_external_id, state.state);
          this.publishedAt.set(state.device_feature_external_id, now);
        }
        this.failureLog.recover('states', 'States accepted again');
      } catch (err) {
        this.failureLog.fail('states', `States refused: ${err.message}`);
      }
    }
  }

  async afterChanges(widgetChanged, { publish = false } = {}) {
    await this.publishDevices({ force: publish });
    await this.publishTransports();
    await this.publishConnectionStatus();
    if (widgetChanged) {
      this.gladys.requestWidgetRefresh(WIDGET_KEY);
    }
  }

  /** The badge of the added devices: "local", or "unreachable" while Nagios is. */
  async publishTransports() {
    if (!this.data || this.readAt === 0) {
      return;
    }
    const transport = this.error === null ? DEVICE_TRANSPORTS.LOCAL : DEVICE_TRANSPORTS.UNREACHABLE;
    const ids = [
      instanceIds(this.gladys).device,
      ...[...this.data.hosts.keys()].map((name) => hostIds(this.gladys, name).device),
    ];
    const entries = ids
      .filter((id) => this.isCreated(id) && this.transports.get(id) !== transport)
      .map((id) => ({ external_id: id, transport }));
    for (let at = 0; at < entries.length; at += MAX_STATES_PER_REQUEST) {
      const batch = entries.slice(at, at + MAX_STATES_PER_REQUEST);
      try {
        await this.gladys.publishTransports(batch);
        for (const entry of batch) {
          this.transports.set(entry.external_id, entry.transport);
        }
        this.failureLog.recover('transports', 'Transports accepted again');
      } catch (err) {
        this.failureLog.fail('transports', `Transports refused: ${err.message}`);
      }
    }
  }

  /** The status under the integration name. */
  connectionStatus() {
    const { apiUrl, invalidUrl } = this.config;
    if (!apiUrl) {
      return {
        connected: false,
        message: invalidUrl ? CONNECTION_TEXT.invalidUrl : CONNECTION_TEXT.noServer,
      };
    }
    if (!this.error) {
      return { connected: true };
    }
    const message = {};
    for (const language of Object.keys(CONNECTION_TEXT.noServer)) {
      message[language] = pick(ERROR_TEXT[this.error.kind], language);
    }
    return { connected: false, message };
  }

  async publishConnectionStatus() {
    const status = this.connectionStatus();
    const key = JSON.stringify(status);
    if (key === this.connection) {
      return;
    }
    try {
      await this.gladys.setConnectionStatus(status.connected, status.message);
      this.connection = key;
      this.failureLog.recover('connection', 'Connection status accepted again');
    } catch (err) {
      this.failureLog.fail('connection', `Connection status refused: ${err.message}`);
    }
  }

  // --- Views (widget, scene actions, report) --------------------------------------------

  /** The host of a device external id, null when unknown. */
  findHost(externalId) {
    const name = parseHostName(this.gladys, externalId);
    return name ? (this.data?.hosts.get(name) ?? null) : null;
  }

  /** The name shown for a host: its display name in Nagios, else its name. */
  hostLabel(hostName) {
    return this.data?.hosts.get(hostName)?.alias ?? hostName;
  }

  /**
   * The problems of the hosts in `scope` (a Set of host names, null for all),
   * for display: hosts down first, then services CRITICAL, UNKNOWN, WARNING, the
   * newest first.
   * @returns {Array<{ host: string, service: string|null, state: number, acknowledged: boolean, downtime: boolean, since: number }>}
   */
  problems(scope = null) {
    if (!this.data) {
      return [];
    }
    const inScope = (name) => !scope || scope.has(name);
    const hosts = [...this.data.hosts.values()]
      .filter((host) => inScope(host.name) && isDown(host))
      .map((host) => ({ ...host, host: host.name, service: null }))
      // DOWN before UNREACHABLE: an unreachable host is the consequence.
      .sort((a, b) => a.state - b.state || b.since - a.since);
    const rank = [0, 1, 3, 2]; // WARNING < UNKNOWN < CRITICAL
    const services = this.data.services
      .filter((service) => inScope(service.host))
      .sort((a, b) => rank[b.state] - rank[a.state] || b.since - a.since);
    return [...hosts, ...services];
  }

  /** A problem in a list: "Host: DOWN" or "Host: service CRITICAL". */
  problemLabel(problem, language) {
    const text = problem.service
      ? `${problem.service} ${SERVICE_STATE_NAMES[problem.state]}`
      : HOST_STATE_NAMES[problem.state];
    return labelled(this.hostLabel(problem.host), text, language);
  }

  /** "Test the connection": read now, one line. */
  async testConnection() {
    await this.pollAll({ publish: true, fresh: true });
    const message = {};
    for (const [language, text] of Object.entries(REPORT_TEXT)) {
      const status = this.connectionStatus();
      if (!status.connected || !this.data) {
        message[language] = labelled(
          this.config.apiUrl ? this.instanceName() : 'Nagios',
          pick(status.message ?? ERROR_TEXT[ERROR_KINDS.UNREACHABLE], language),
          language,
        );
        continue;
      }
      const hosts = [...this.data.hosts.values()];
      const parts = [
        text.ok,
        this.data.version ? `Nagios ${this.data.version}` : 'Nagios',
        text.hosts(hosts.length, this.data.total),
        text.problems(hosts.filter(isDown).length, this.data.services.length),
      ];
      message[language] = labelled(this.instanceName(), parts.join(', '), language);
    }
    return message;
  }
}
