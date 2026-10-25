// The hub against the fake Nagios: discovery, states of the added devices
// only, scene events on hosts and services (kept across a restart, held
// during a downtime, HARD states only), Nagios unreachable or stopped,
// heartbeat, the reading timer, and quiet logs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FEATURE_KEYS } from '../src/devices.js';
import { TRIGGERS } from '../src/hub.js';
import {
  BASE_CONFIG,
  FakeNagios,
  READ_AT,
  PASSWORD,
  createClock,
  createDevices,
  createWorld,
  hostDevice,
  hostFeature,
  instanceFeature,
} from './helpers/world.js';

/** The lines written at `LOG_LEVEL=info` from now on (the SDK logger reads it per line). */
function captureLogs(t) {
  const previous = process.env.LOG_LEVEL;
  process.env.LOG_LEVEL = 'info';
  const lines = [];
  for (const stream of ['log', 'error']) {
    t.mock.method(console, stream, (...args) => lines.push(args.join(' ')));
  }
  t.after(() => {
    process.env.LOG_LEVEL = previous;
  });
  return lines;
}

async function world(t, options = {}) {
  const created = await createWorld(options);
  t.after(() => created.app.stop());
  return created;
}

const keysOf = (w) => w.fake.sceneEvents.map((event) => event.key);
const DEVICES = 6; // "Nagios" and the five hosts of the fixture

test('discovery: the Nagios device and one device per host, sorted by alias', async (t) => {
  const w = await world(t);
  assert.deepEqual(
    w.fake.discoveredDevices.map((device) => device.name),
    ['Nagios', 'Camera garage', 'NAS du salon', 'New host', 'Outside camera', 'Switch'],
  );
  assert.deepEqual(w.fake.connectionStatus, { connected: true });
  // Nothing is published for a device not added: Gladys would drop it.
  assert.equal(w.fake.states.length, 0);
});

test('host groups keep their hosts, and the Nagios device counts them only', async (t) => {
  const w = await world(t, { config: { ...BASE_CONFIG, host_groups: 'homelab' } });
  assert.deepEqual(
    w.fake.discoveredDevices.map((device) => device.name),
    ['Nagios', 'NAS du salon', 'Switch'],
  );
  await createDevices(w);
  assert.equal(w.fake.lastState(instanceFeature(w.gladys, FEATURE_KEYS.HOSTS_DOWN)), 1);
  assert.equal(w.fake.lastState(instanceFeature(w.gladys, FEATURE_KEYS.CRIT)), 1);
});

test('added devices get every state, then only the changes', async (t) => {
  const w = await world(t);
  await createDevices(w);
  const state = (host, key) => w.fake.lastState(hostFeature(w.gladys, host, key));
  assert.equal(state('nas', FEATURE_KEYS.UP), 1);
  assert.equal(state('nas', FEATURE_KEYS.WARN), 1);
  assert.equal(state('nas', FEATURE_KEYS.CRIT), 1);
  assert.equal(state('nas', FEATURE_KEYS.UNKNOWN), 1);
  assert.equal(state('nas', FEATURE_KEYS.UNHANDLED), 2, 'the RAID is acknowledged');
  assert.equal(state('switch', FEATURE_KEYS.UP), 0);
  assert.equal(state('switch', FEATURE_KEYS.ACKNOWLEDGED), 1);
  assert.equal(state('switch', FEATURE_KEYS.UNHANDLED), 0);
  assert.equal(state('camera', FEATURE_KEYS.UP), 0, 'UNREACHABLE is not up');
  assert.equal(state('outside', FEATURE_KEYS.DOWNTIME), 1);
  assert.equal(state('outside', FEATURE_KEYS.CRIT), 1);
  assert.equal(state('outside', FEATURE_KEYS.UNHANDLED), 0, 'in a downtime: handled');
  assert.equal(state('newhost', FEATURE_KEYS.UP), undefined, 'PENDING: nothing for "up"');
  const total = (key) => w.fake.lastState(instanceFeature(w.gladys, key));
  assert.equal(total(FEATURE_KEYS.DAEMON), 1);
  assert.equal(total(FEATURE_KEYS.HOSTS_DOWN), 3);
  assert.equal(total(FEATURE_KEYS.WARN), 1);
  assert.equal(total(FEATURE_KEYS.CRIT), 2);
  assert.equal(total(FEATURE_KEYS.UNKNOWN), 1);
  assert.equal(total(FEATURE_KEYS.UNHANDLED), 2);

  const before = w.fake.states.length;
  await w.hub.pollAll();
  assert.equal(w.fake.states.length, before, 'nothing changed, nothing sent');

  w.nagios.setHost('camera', 0);
  w.nagios.setService('nas', 'Backup', 0);
  w.nagios.setService('nas', 'Web', 3);
  w.nagios.setHost('outside', 1, { scheduled_downtime_depth: 0 });
  await w.hub.pollAll();
  assert.equal(state('camera', FEATURE_KEYS.UP), 1);
  assert.equal(state('nas', FEATURE_KEYS.UNKNOWN), 1);
  assert.equal(state('outside', FEATURE_KEYS.DOWNTIME), 0);
  assert.equal(state('outside', FEATURE_KEYS.UNHANDLED), 1);
  assert.equal(total(FEATURE_KEYS.HOSTS_DOWN), 2);
});

test('a device added later receives everything at once, and the widget is refreshed', async (t) => {
  const w = await world(t);
  const nas = w.fake.discoveredDevices.find((device) => device.name === 'NAS du salon');
  await w.fake.deviceCreated(nas);
  assert.equal(w.fake.lastState(hostFeature(w.gladys, 'nas', FEATURE_KEYS.CRIT)), 1);
  assert.ok(w.fake.widgetRefreshes.includes('problems'));
  // "Update" (onDeviceUpdated) sends everything again too.
  const count = w.fake.states.length;
  await w.fake.deviceUpdated(nas);
  assert.ok(w.fake.states.length > count);
});

test('scene events: the first read records, then hosts down and up', async (t) => {
  const clock = createClock();
  const w = await world(t, { clock });
  assert.deepEqual(w.fake.sceneEvents, [], 'the problems already there are not announced');

  w.nagios.setHost('nas', 1, { last_state_change: READ_AT });
  await w.hub.pollAll();
  assert.deepEqual(w.fake.sceneEvents, [
    {
      key: TRIGGERS.HOST_DOWN,
      data: { device: hostDevice(w.gladys, 'nas'), host: 'NAS du salon', state_name: 'DOWN' },
    },
  ]);
  // DOWN to UNREACHABLE: still down, not announced again.
  w.nagios.setHost('nas', 2);
  await w.hub.pollAll();
  assert.equal(w.fake.sceneEvents.length, 1);

  clock.advance(10 * 60_000);
  w.nagios.setHost('nas', 0);
  await w.hub.pollAll();
  assert.deepEqual(w.fake.sceneEvents.at(-1), {
    key: TRIGGERS.HOST_UP,
    data: { device: hostDevice(w.gladys, 'nas'), host: 'NAS du salon', duration_minutes: 10 },
  });
  // A host down from the start is announced up when it comes back.
  w.nagios.setHost('switch', 0);
  await w.hub.pollAll();
  assert.equal(w.fake.sceneEvents.at(-1).data.host, 'Switch');
  assert.equal(w.fake.sceneEvents.length, 3);
});

test('a host that goes UNREACHABLE is announced with that state', async (t) => {
  const w = await world(t);
  w.nagios.setHost('nas', 2);
  await w.hub.pollAll();
  assert.equal(w.fake.sceneEvents[0].data.state_name, 'UNREACHABLE');
});

test('scene events: a service enters a problem, worsens, recovers', async (t) => {
  const clock = createClock();
  const w = await world(t, { clock });
  w.nagios.setService('nas', 'Memory', 1, {
    last_state_change: READ_AT,
    plugin_output: 'RAM used: 85%\nlong output',
  });
  await w.hub.pollAll();
  assert.deepEqual(w.fake.sceneEvents, [
    {
      key: TRIGGERS.SERVICE_PROBLEM,
      data: {
        device: hostDevice(w.gladys, 'nas'),
        host: 'NAS du salon',
        service: 'Memory',
        state: 1,
        state_name: 'WARNING',
        output: 'RAM used: 85%',
      },
    },
  ]);
  w.nagios.setService('nas', 'Memory', 2);
  await w.hub.pollAll();
  assert.equal(w.fake.sceneEvents.at(-1).data.state_name, 'CRITICAL');
  await w.hub.pollAll();
  assert.equal(w.fake.sceneEvents.length, 2, 'unchanged: not again');

  clock.advance(5 * 60_000);
  w.nagios.setService('nas', 'Memory', 0);
  // A service of the fixture, UNKNOWN from the start, recovers too.
  w.nagios.setService('nas', 'Backup', 0);
  await w.hub.pollAll();
  assert.deepEqual(
    w.fake.sceneEvents.slice(2).map((event) => [event.key, event.data.service, event.data.state]),
    [
      [TRIGGERS.SERVICE_RECOVERED, 'Backup', 3],
      [TRIGGERS.SERVICE_RECOVERED, 'Memory', 2],
    ],
  );
  const memory = w.fake.sceneEvents.at(-1).data;
  assert.equal(memory.duration_minutes, 5);
  assert.equal(memory.state_name, 'CRITICAL');
});

test('a service back to PENDING has not recovered; its recovery comes later', async (t) => {
  const w = await world(t);
  w.nagios.setService('nas', 'Backup', 3, { status: 1, has_been_checked: false });
  await w.hub.pollAll();
  assert.deepEqual(w.fake.sceneEvents, []);
  w.nagios.setService('nas', 'Backup', 0);
  await w.hub.pollAll();
  assert.deepEqual(keysOf(w), [TRIGGERS.SERVICE_RECOVERED]);
});

test('a host name with a colon is still found', async (t) => {
  const w = await world(t);
  w.nagios.hosts.push({ ...w.nagios.host('nas'), name: 'site:nas', alias: 'Site NAS' });
  await w.hub.pollAll();
  assert.equal(w.hub.findHost(hostDevice(w.gladys, 'site:nas'))?.name, 'site:nas');
});

test('a host removed from Nagios takes its services along, without events', async (t) => {
  const w = await world(t);
  w.nagios.hosts = w.nagios.hosts.filter((host) => host.name !== 'nas');
  w.nagios.services = w.nagios.services.filter((service) => service.host_name !== 'nas');
  await w.hub.pollAll();
  assert.deepEqual(w.fake.sceneEvents, []);
});

test('a downtime holds the events until it ends', async (t) => {
  const w = await world(t);
  w.nagios.setHost('nas', 1, { scheduled_downtime_depth: 1 });
  // A service of a host in downtime is held too.
  w.nagios.setService('nas', 'Memory', 2);
  await w.hub.pollAll();
  assert.deepEqual(w.fake.sceneEvents, []);
  w.nagios.host('nas').scheduled_downtime_depth = 0;
  await w.hub.pollAll();
  assert.deepEqual(keysOf(w), [TRIGGERS.HOST_DOWN, TRIGGERS.SERVICE_PROBLEM]);
  // A problem born and gone in a downtime is never announced.
  w.nagios.setService('nas', 'Flapping', 2, { scheduled_downtime_depth: 1 });
  await w.hub.pollAll();
  w.nagios.setService('nas', 'Flapping', 0);
  await w.hub.pollAll();
  assert.equal(w.fake.sceneEvents.length, 2);
});

test('a restart neither repeats nor misses a change', async (t) => {
  const nagios = new FakeNagios();
  const first = await world(t, { nagios });
  nagios.setService('nas', 'kept', 2);
  await first.hub.pollAll();
  await first.app.stop();
  assert.equal(first.fake.sceneEvents.length, 1);

  // While the integration was stopped: one problem ends, another one starts.
  nagios.setService('nas', 'kept', 0);
  nagios.setService('nas', 'fresh', 1);
  const second = await world(t, { nagios, dataDir: first.dataDir });
  assert.deepEqual(
    second.fake.sceneEvents.map((event) => [event.key, event.data.service]),
    [
      [TRIGGERS.SERVICE_PROBLEM, 'fresh'],
      [TRIGGERS.SERVICE_RECOVERED, 'kept'],
    ],
  );
});

test('another scope records its problems without announcing them', async (t) => {
  const w = await world(t, { config: { ...BASE_CONFIG, host_groups: 'homelab' } });
  w.nagios.host('outside').scheduled_downtime_depth = 0;
  w.nagios.service('outside', 'HTTP').scheduled_downtime_depth = 0;
  await w.fake.configUpdated({ ...BASE_CONFIG, host_groups: '' });
  assert.deepEqual(w.fake.sceneEvents, []);
});

test('Nagios silent twice: one scene event, unreachable badges, then back', async (t) => {
  const w = await world(t);
  await createDevices(w);
  w.nagios.failure = 'down';
  await w.hub.pollAll();
  assert.deepEqual(w.fake.sceneEvents, [], 'one failure is a blip');
  await w.hub.pollAll();
  await w.hub.pollAll();
  assert.deepEqual(w.fake.sceneEvents, [
    {
      key: TRIGGERS.UNREACHABLE,
      data: { address: '192.0.2.10/nagios', error: 'Nagios does not answer' },
    },
  ]);
  assert.equal(w.fake.connectionStatus.connected, false);
  assert.ok(w.fake.transports.slice(-DEVICES).every((entry) => entry.transport === 'unreachable'));
  w.nagios.failure = null;
  await w.hub.pollAll();
  assert.deepEqual(w.fake.connectionStatus, { connected: true });
  assert.ok(w.fake.transports.slice(-DEVICES).every((entry) => entry.transport === 'local'));
});

test('the Nagios daemon stopped: "Nagios running" at 0, one scene event, then back', async (t) => {
  const w = await world(t);
  await createDevices(w);
  const running = () => w.fake.lastState(instanceFeature(w.gladys, FEATURE_KEYS.DAEMON));
  assert.equal(running(), 1);
  w.nagios.failure = 'stopped';
  await w.hub.pollAll();
  assert.equal(running(), 0, 'at once: the web server answered');
  await w.hub.pollAll();
  await w.hub.pollAll();
  assert.deepEqual(w.fake.sceneEvents, [
    {
      key: TRIGGERS.UNREACHABLE,
      data: { address: '192.0.2.10/nagios', error: 'the Nagios daemon is not running' },
    },
  ]);
  assert.match(w.fake.connectionStatus.message.en, /daemon is not running/);
  w.nagios.failure = null;
  await w.hub.pollAll();
  assert.equal(running(), 1);
  assert.deepEqual(w.fake.connectionStatus, { connected: true });
});

test('a refused password is a connection status, not an outage', async (t) => {
  const w = await world(t, { config: { ...BASE_CONFIG, password: 'wrong' } });
  await w.hub.pollAll();
  await w.hub.pollAll();
  assert.equal(w.fake.connectionStatus.connected, false);
  assert.match(w.fake.connectionStatus.message.en, /password refused/);
  assert.deepEqual(w.fake.sceneEvents, []);
});

test('an unchanged value is sent again after 6 hours', async (t) => {
  const clock = createClock();
  const w = await world(t, { clock });
  await createDevices(w);
  const count = w.fake.states.length;
  clock.advance(6 * 3600_000);
  await w.hub.pollAll();
  assert.equal(w.fake.states.length, count * 2);
});

test('the container reads Nagios on its own timer, without onPoll', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const w = await world(t, { timers: true });
  const reads = () => w.nagios.calls.filter((call) => call.params.query === 'servicelist').length;
  const first = reads();
  t.mock.timers.tick(60_000);
  await new Promise((resolve) => setImmediate(resolve));
  await w.hub.polling;
  assert.equal(reads(), first + 1);
});

test('a normal cycle writes nothing at the info level; a failure one line each way', async (t) => {
  const w = await world(t);
  await createDevices(w);
  const lines = captureLogs(t);
  w.nagios.setService('nas', 'quiet', 2);
  await w.hub.pollAll();
  w.nagios.setService('nas', 'quiet', 0);
  await w.hub.pollAll();
  await w.hub.rediscover();
  assert.equal(w.fake.sceneEvents.length, 2);
  assert.deepEqual(lines, []);

  w.nagios.failure = 'down';
  for (let read = 0; read < 4; read += 1) {
    await w.hub.pollAll();
  }
  w.nagios.failure = null;
  await w.hub.pollAll();
  assert.equal(lines.length, 2, lines.join('\n'));
  assert.ok(
    lines.every((line) => !line.includes(PASSWORD)),
    'no password in the logs',
  );
});

test('a burst of new problems is capped per read, the rest follows', async (t) => {
  const w = await world(t);
  for (let index = 0; index < 40; index += 1) {
    w.nagios.setService('nas', `service-${index}`, 2);
  }
  await w.hub.pollAll();
  assert.equal(w.fake.sceneEvents.length, 30);
  await w.hub.pollAll();
  assert.equal(w.fake.sceneEvents.length, 40);
  await w.hub.pollAll();
  assert.equal(w.fake.sceneEvents.length, 40);
});

test('Gladys refusing the scene events (restarting): sent at a next read, once', async (t) => {
  const w = await world(t);
  const original = w.gladys.publishSceneEvent.bind(w.gladys);
  let refuse = true;
  w.gladys.publishSceneEvent = (key, data) =>
    refuse ? Promise.reject(new Error('ECONNREFUSED')) : original(key, data);
  w.nagios.setHost('nas', 1);
  await w.hub.pollAll();
  assert.equal(w.fake.sceneEvents.length, 0);
  refuse = false;
  await w.hub.pollAll();
  await w.hub.pollAll();
  assert.deepEqual(keysOf(w), [TRIGGERS.HOST_DOWN]);
});

test('a new scope during a read: the old read does not prime the new scope', async (t) => {
  const w = await world(t, { config: { ...BASE_CONFIG, host_groups: 'homelab' } });
  const reading = w.hub.pollAll();
  await w.fake.configUpdated({ ...BASE_CONFIG, host_groups: '' });
  await reading;
  w.nagios.host('outside').downtime_depth = 0;
  await w.hub.pollAll();
  assert.deepEqual(w.fake.sceneEvents, []);
  assert.equal(w.fake.discoveredDevices.length, DEVICES);
});

test('no configuration: a clear connection status, no request', async (t) => {
  const w = await world(t, { config: {} });
  assert.equal(w.fake.connectionStatus.connected, false);
  assert.match(w.fake.connectionStatus.message.en, /Enter the address/);
  assert.equal(w.nagios.calls.length, 0);
});

test('"Test the connection" sums up Nagios', async (t) => {
  const w = await world(t, { config: { ...BASE_CONFIG, host_groups: 'homelab' } });
  const ack = await w.fake.action('test_connection', {});
  assert.equal(ack.success, true);
  assert.equal(
    ack.data.message.en,
    '192.0.2.10/nagios: OK, Nagios 4.5.12, 2/5 host(s), 1 host(s) down, 3 service problem(s)',
  );
  assert.match(ack.data.message.fr, /^192\.0\.2\.10\/nagios : OK/);
});

test('no host visible: an error, and nothing is taken for resolved', async (t) => {
  const w = await world(t);
  w.nagios.missing.add('hosts');
  await w.hub.pollAll();
  assert.equal(w.fake.connectionStatus.connected, false);
  assert.match(w.fake.connectionStatus.message.en, /no host visible/);
  assert.equal(w.fake.discoveredDevices.length, DEVICES, 'the list Gladys has stays');
  w.nagios.missing.clear();
  await w.hub.pollAll();
  assert.deepEqual(w.fake.sceneEvents, []);
});

test('a SOFT state is not announced until Nagios confirms it (HARD)', async (t) => {
  const nagios = new FakeNagios();
  nagios.service('nas', 'Disk /').state_type = 0;
  const w = await world(t, { nagios });
  w.nagios.setHost('nas', 1, { state_type: 0 });
  w.nagios.setService('nas', 'flaky', 2, { state_type: 0 });
  await w.hub.pollAll();
  assert.deepEqual(w.fake.sceneEvents, []);
  w.nagios.setHost('nas', 0);
  w.nagios.setService('nas', 'flaky', 0);
  await w.hub.pollAll();
  assert.deepEqual(w.fake.sceneEvents, [], 'a SOFT blip that heals: nothing at all');
  w.nagios.setService('nas', 'flaky', 2, { state_type: 1 });
  await w.hub.pollAll();
  assert.deepEqual(keysOf(w), [TRIGGERS.SERVICE_PROBLEM]);
  // The SOFT disk warning, already there, turns HARD: announced.
  w.nagios.service('nas', 'Disk /').state_type = 1;
  await w.hub.pollAll();
  assert.deepEqual(keysOf(w), [TRIGGERS.SERVICE_PROBLEM, TRIGGERS.SERVICE_PROBLEM]);
});

test('a new password for the same user keeps the problems already seen', async (t) => {
  const w = await world(t);
  w.nagios.setService('nas', 'kept', 2);
  await w.hub.pollAll();
  await w.fake.configUpdated({ ...BASE_CONFIG, password: 'rotated' });
  await w.fake.configUpdated(BASE_CONFIG);
  w.nagios.setService('nas', 'kept', 0);
  await w.hub.pollAll();
  assert.deepEqual(keysOf(w), [TRIGGERS.SERVICE_PROBLEM, TRIGGERS.SERVICE_RECOVERED]);
});

test('a host down since its creation (last_state_change 0) still gets a duration', async (t) => {
  const clock = createClock();
  const nagios = new FakeNagios();
  nagios.host('switch').last_state_change = 0;
  const w = await world(t, { clock, nagios });
  clock.advance(3 * 3600_000);
  w.nagios.setHost('switch', 0);
  await w.hub.pollAll();
  assert.equal(w.fake.sceneEvents[0].data.duration_minutes, 180);
});

test('an outage after another kind of error is announced again', async (t) => {
  const w = await world(t);
  w.nagios.failure = 'down';
  await w.hub.pollAll();
  await w.hub.pollAll();
  w.nagios.failure = 'not_nagios';
  await w.hub.pollAll();
  w.nagios.failure = 'down';
  await w.hub.pollAll();
  await w.hub.pollAll();
  assert.deepEqual(keysOf(w), [TRIGGERS.UNREACHABLE, TRIGGERS.UNREACHABLE]);
});
