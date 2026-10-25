// -----------------------------------------------------------------------------
// Gladys devices, proposed in the Discovery tab (the user adds the ones to
// follow, nothing is created on their behalf):
//
//   - one device per Nagios host (the host groups of the configuration, or
//     every host the web user can see), identity = the Nagios host name
//     (unique, and what every command takes);
//       up            input/binary, 1 UP, 0 DOWN or UNREACHABLE, nothing
//                     published while the host is PENDING
//       services_*    counter-sensor/integer, services WARNING, CRITICAL, UNKNOWN
//       unhandled     counter-sensor/integer, problems (host and services)
//                     neither acknowledged nor in a downtime
//       acknowledged  input/binary, 1 when the host problem is acknowledged
//       downtime      input/binary, 1 in a scheduled downtime
//   - one "Nagios" device: whether the Nagios daemon runs, the same totals
//     over the hosts in scope, and the hosts DOWN or UNREACHABLE.
//
// Published with should_poll: false: the integration reads Nagios on its own
// timer (src/hub.js), at the interval chosen in the configuration.
// -----------------------------------------------------------------------------

import { DEVICE_FEATURE_CATEGORIES, DEVICE_FEATURE_TYPES } from '@gladysassistant/integration-sdk';

export const HOST_TYPE = 'host';
export const INSTANCE_TYPE = 'instance';
export const INSTANCE_ID = 'main';

// Suffixes of the feature external ids: permanent once published.
export const FEATURE_KEYS = Object.freeze({
  UP: 'up',
  WARN: 'services_warning',
  CRIT: 'services_critical',
  UNKNOWN: 'services_unknown',
  UNHANDLED: 'unhandled',
  ACKNOWLEDGED: 'acknowledged',
  DOWNTIME: 'downtime',
  HOSTS_DOWN: 'hosts_down',
  DAEMON: 'daemon_running',
});

// Service states (src/nagios/client.js maps the bit masks of the CGIs).
export const SERVICE_STATES = Object.freeze({ WARN: 1, CRIT: 2, UNKNOWN: 3 });
// Host states, as in the Nagios logs: UNREACHABLE is a DOWN host behind a parent that is down.
export const HOST_STATES = Object.freeze({ UP: 0, DOWN: 1, UNREACHABLE: 2 });

// Feature names, in the language chosen in the configuration (Gladys does not
// tell a device integration the user's language). Frozen at creation in Gladys.
// WARNING, CRITICAL and UNKNOWN are the words of Nagios in every language.
export const NAMES = {
  en: {
    [FEATURE_KEYS.UP]: 'Host up',
    [FEATURE_KEYS.WARN]: 'Services WARNING',
    [FEATURE_KEYS.CRIT]: 'Services CRITICAL',
    [FEATURE_KEYS.UNKNOWN]: 'Services UNKNOWN',
    [FEATURE_KEYS.UNHANDLED]: 'Unhandled problems',
    [FEATURE_KEYS.ACKNOWLEDGED]: 'Host acknowledged',
    [FEATURE_KEYS.DOWNTIME]: 'In downtime',
    [FEATURE_KEYS.HOSTS_DOWN]: 'Hosts down',
    [FEATURE_KEYS.DAEMON]: 'Nagios running',
  },
  fr: {
    [FEATURE_KEYS.UP]: 'Hôte UP',
    [FEATURE_KEYS.WARN]: 'Services WARNING',
    [FEATURE_KEYS.CRIT]: 'Services CRITICAL',
    [FEATURE_KEYS.UNKNOWN]: 'Services UNKNOWN',
    [FEATURE_KEYS.UNHANDLED]: 'Problèmes non traités',
    [FEATURE_KEYS.ACKNOWLEDGED]: 'Hôte acquitté',
    [FEATURE_KEYS.DOWNTIME]: 'En maintenance',
    [FEATURE_KEYS.HOSTS_DOWN]: 'Hôtes DOWN',
    [FEATURE_KEYS.DAEMON]: 'Nagios actif',
  },
  de: {
    [FEATURE_KEYS.UP]: 'Host UP',
    [FEATURE_KEYS.WARN]: 'Services WARNING',
    [FEATURE_KEYS.CRIT]: 'Services CRITICAL',
    [FEATURE_KEYS.UNKNOWN]: 'Services UNKNOWN',
    [FEATURE_KEYS.UNHANDLED]: 'Unbehandelte Probleme',
    [FEATURE_KEYS.ACKNOWLEDGED]: 'Host quittiert',
    [FEATURE_KEYS.DOWNTIME]: 'In Wartungszeit',
    [FEATURE_KEYS.HOSTS_DOWN]: 'Hosts DOWN',
    [FEATURE_KEYS.DAEMON]: 'Nagios läuft',
  },
  es: {
    [FEATURE_KEYS.UP]: 'Host UP',
    [FEATURE_KEYS.WARN]: 'Servicios WARNING',
    [FEATURE_KEYS.CRIT]: 'Servicios CRITICAL',
    [FEATURE_KEYS.UNKNOWN]: 'Servicios UNKNOWN',
    [FEATURE_KEYS.UNHANDLED]: 'Problemas sin gestionar',
    [FEATURE_KEYS.ACKNOWLEDGED]: 'Host reconocido',
    [FEATURE_KEYS.DOWNTIME]: 'En mantenimiento',
    [FEATURE_KEYS.HOSTS_DOWN]: 'Hosts DOWN',
    [FEATURE_KEYS.DAEMON]: 'Nagios en marcha',
  },
};

export const INSTANCE_NAME = 'Nagios';

// Display bounds (the core never applies them on write).
export const MAX_COUNT = 100_000;

export const MODEL_HOST = 'Nagios host';
export const MODEL_INSTANCE = 'Nagios Core';
export const PARAMS = Object.freeze({ HOST: 'NAGIOS_HOST', ADDRESS: 'NAGIOS_ADDRESS' });

export const hostIds = (gladys, hostName) => gladys.externalIds(HOST_TYPE, hostName);
export const instanceIds = (gladys) => gladys.externalIds(INSTANCE_TYPE, INSTANCE_ID);

/** The Nagios host name of a device external id, null when it is not a host of ours. */
export function parseHostName(gladys, externalId) {
  const prefix = hostIds(gladys, '').device;
  if (typeof externalId !== 'string' || !externalId.startsWith(prefix)) {
    return null;
  }
  const name = externalId.slice(prefix.length);
  return name && !name.includes(':') ? name : null;
}

const readOnly = { read_only: true, has_feedback: false, keep_history: true };

function counter(name, externalId) {
  return {
    name,
    external_id: externalId,
    category: DEVICE_FEATURE_CATEGORIES.COUNTER_SENSOR,
    type: DEVICE_FEATURE_TYPES.SENSOR.INTEGER,
    ...readOnly,
    min: 0,
    max: MAX_COUNT,
  };
}

function binary(name, externalId) {
  return {
    name,
    external_id: externalId,
    category: DEVICE_FEATURE_CATEGORIES.INPUT,
    type: DEVICE_FEATURE_TYPES.SENSOR.BINARY,
    ...readOnly,
    min: 0,
    max: 1,
  };
}

const SERVICE_COUNTERS = [FEATURE_KEYS.WARN, FEATURE_KEYS.CRIT, FEATURE_KEYS.UNKNOWN];
const STATE_OF = {
  [FEATURE_KEYS.WARN]: SERVICE_STATES.WARN,
  [FEATURE_KEYS.CRIT]: SERVICE_STATES.CRIT,
  [FEATURE_KEYS.UNKNOWN]: SERVICE_STATES.UNKNOWN,
};

/**
 * The discovery payload of a host.
 * @param {object} gladys SDK client
 * @param {object} host see NagiosClient.snapshot()
 * @param {string} language feature names language
 */
export function buildHostDevice(gladys, host, language = 'en') {
  const ids = hostIds(gladys, host.name);
  const names = NAMES[language] ?? NAMES.en;
  return {
    name: (host.alias || host.name).slice(0, 255),
    external_id: ids.device,
    model: MODEL_HOST,
    should_poll: false,
    params: [{ name: PARAMS.HOST, value: host.name.slice(0, 255) }],
    features: [
      binary(names[FEATURE_KEYS.UP], ids.feature(FEATURE_KEYS.UP)),
      ...SERVICE_COUNTERS.map((key) => counter(names[key], ids.feature(key))),
      counter(names[FEATURE_KEYS.UNHANDLED], ids.feature(FEATURE_KEYS.UNHANDLED)),
      binary(names[FEATURE_KEYS.ACKNOWLEDGED], ids.feature(FEATURE_KEYS.ACKNOWLEDGED)),
      binary(names[FEATURE_KEYS.DOWNTIME], ids.feature(FEATURE_KEYS.DOWNTIME)),
    ],
  };
}

/** The discovery payload of the "Nagios" device. */
export function buildInstanceDevice(gladys, address, language = 'en') {
  const ids = instanceIds(gladys);
  const names = NAMES[language] ?? NAMES.en;
  return {
    name: INSTANCE_NAME,
    external_id: ids.device,
    model: MODEL_INSTANCE,
    should_poll: false,
    params: [{ name: PARAMS.ADDRESS, value: String(address ?? '').slice(0, 255) }],
    features: [
      binary(names[FEATURE_KEYS.DAEMON], ids.feature(FEATURE_KEYS.DAEMON)),
      counter(names[FEATURE_KEYS.HOSTS_DOWN], ids.feature(FEATURE_KEYS.HOSTS_DOWN)),
      ...SERVICE_COUNTERS.map((key) => counter(names[key], ids.feature(key))),
      counter(names[FEATURE_KEYS.UNHANDLED], ids.feature(FEATURE_KEYS.UNHANDLED)),
    ],
  };
}

export const isDown = (host) => host.state !== null && host.state !== HOST_STATES.UP;

/** A problem Nagios calls "unhandled": neither acknowledged nor in a downtime. */
export const isUnhandled = (problem) => !problem.acknowledged && !problem.downtime;

/** Unhandled problems of hosts (DOWN, UNREACHABLE) and of their services. */
export const unhandledCount = (hosts, services) =>
  hosts.filter((host) => isDown(host) && isUnhandled(host)).length +
  services.filter(isUnhandled).length;

/**
 * Feature values of a host (null: nothing to publish).
 * @param {object[]} services the services of this host that are not OK
 * @returns {Array<{ externalId: string, value: number|null }>}
 */
export function hostValues(gladys, host, services) {
  const ids = hostIds(gladys, host.name);
  return [
    {
      externalId: ids.feature(FEATURE_KEYS.UP),
      value: host.state === null ? null : host.state === HOST_STATES.UP ? 1 : 0,
    },
    ...SERVICE_COUNTERS.map((key) => ({
      externalId: ids.feature(key),
      value: services.filter((service) => service.state === STATE_OF[key]).length,
    })),
    { externalId: ids.feature(FEATURE_KEYS.UNHANDLED), value: unhandledCount([host], services) },
    {
      externalId: ids.feature(FEATURE_KEYS.ACKNOWLEDGED),
      value: isDown(host) && host.acknowledged ? 1 : 0,
    },
    { externalId: ids.feature(FEATURE_KEYS.DOWNTIME), value: host.downtime ? 1 : 0 },
  ];
}

/**
 * Feature values of the Nagios device.
 * @param {boolean|null} running whether the daemon runs, null when unknown (Nagios does not answer)
 */
export function instanceValues(gladys, hosts, services, running = null) {
  const ids = instanceIds(gladys);
  return [
    {
      externalId: ids.feature(FEATURE_KEYS.DAEMON),
      value: running === null ? null : running ? 1 : 0,
    },
    { externalId: ids.feature(FEATURE_KEYS.HOSTS_DOWN), value: hosts.filter(isDown).length },
    ...SERVICE_COUNTERS.map((key) => ({
      externalId: ids.feature(key),
      value: services.filter((service) => service.state === STATE_OF[key]).length,
    })),
    { externalId: ids.feature(FEATURE_KEYS.UNHANDLED), value: unhandledCount(hosts, services) },
  ];
}
