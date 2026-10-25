import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COMMANDS } from '../src/nagios/client.js';
import { BASE_CONFIG, createWorld, hostDevice } from './helpers/world.js';

async function world(t, options) {
  const created = await createWorld(options);
  t.after(() => created.app.stop());
  return created;
}

const committed = (w) =>
  w.nagios.commands.map(({ type, host, service, comment }) => [type, host, service, comment]);

test('acknowledge_host_problems acknowledges the host and its services, with a comment', async (t) => {
  const w = await world(t);
  w.nagios.setHost('switch', 1); // not acknowledged any more
  w.nagios.setService('switch', 'SSH', 2);
  await w.hub.pollAll();
  const device = hostDevice(w.gladys, 'switch');
  const ack = await w.fake.sceneAction('acknowledge_host_problems', { device, message: ' Seen ' });
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual(ack.data.outputs, { acknowledged: 2 });
  assert.deepEqual(committed(w), [
    [COMMANDS.ACKNOWLEDGE_HOST, 'switch', undefined, 'Seen'],
    [COMMANDS.ACKNOWLEDGE_SERVICE, 'switch', 'SSH', 'Seen'],
  ]);
  // Read again at once: nothing left to acknowledge.
  const again = await w.fake.sceneAction('acknowledge_host_problems', { device });
  assert.deepEqual(again.data.outputs, { acknowledged: 0 });
});

test('acknowledge_host_problems: services only on a host UP, the default comment in its language', async (t) => {
  const w = await world(t, { config: { ...BASE_CONFIG, language: 'fr' } });
  const ack = await w.fake.sceneAction('acknowledge_host_problems', {
    device: hostDevice(w.gladys, 'nas'),
  });
  // The RAID was already acknowledged.
  assert.deepEqual(ack.data.outputs, { acknowledged: 2 });
  assert.deepEqual(committed(w), [
    [COMMANDS.ACKNOWLEDGE_SERVICE, 'nas', 'Backup', 'Acquitté depuis Gladys'],
    [COMMANDS.ACKNOWLEDGE_SERVICE, 'nas', 'Disk /', 'Acquitté depuis Gladys'],
  ]);
});

test('acknowledge_host_problems: turned off, refused, unknown host', async (t) => {
  const off = await world(t, { config: { ...BASE_CONFIG, allow_acknowledge: false } });
  const disabled = await off.fake.sceneAction('acknowledge_host_problems', {
    device: hostDevice(off.gladys, 'nas'),
  });
  assert.equal(disabled.success, false);
  assert.match(disabled.error, /turned off/);
  assert.deepEqual(off.nagios.commands, []);

  const w = await world(t);
  w.nagios.missing.add('commands');
  const refused = await w.fake.sceneAction('acknowledge_host_problems', {
    device: hostDevice(w.gladys, 'nas'),
  });
  assert.equal(refused.success, false);
  assert.match(refused.error, /authorized_for_all_host_commands/);
  const unknown = await w.fake.sceneAction('acknowledge_host_problems', { device: 'nope' });
  assert.match(unknown.error, /not a Nagios host/);
});

test('check_host_now schedules the host and its services, forced', async (t) => {
  const w = await world(t);
  const ack = await w.fake.sceneAction('check_host_now', { device: hostDevice(w.gladys, 'nas') });
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual(ack.data.outputs, { scheduled: true });
  assert.deepEqual(
    w.nagios.commands.map(({ type, host }) => [type, host]),
    [
      [COMMANDS.CHECK_HOST, 'nas'],
      [COMMANDS.CHECK_HOST_SERVICES, 'nas'],
    ],
  );
  const posts = w.nagios.calls.filter((call) => call.method === 'POST');
  assert.ok(posts.every((call) => call.form.force_check === 'on'));

  w.nagios.missing.add('external_commands');
  const disabled = await w.fake.sceneAction('check_host_now', {
    device: hostDevice(w.gladys, 'nas'),
  });
  assert.match(disabled.error, /check_external_commands/);

  const off = await world(t, { config: { ...BASE_CONFIG, allow_recheck: false } });
  const refused = await off.fake.sceneAction('check_host_now', {
    device: hostDevice(off.gladys, 'nas'),
  });
  assert.match(refused.error, /turned off/);
  assert.deepEqual(off.nagios.commands, []);
});

test('get_problems: every host, or one, in words', async (t) => {
  const w = await world(t);
  const all = await w.fake.sceneAction('get_problems', {});
  assert.deepEqual(all.data.outputs, {
    count: 7,
    unhandled: 2,
    hosts_down: 3,
    services_critical: 2,
    services_warning: 1,
    services_unknown: 1,
    names:
      'Outside camera: DOWN, Switch: DOWN, Camera garage: UNREACHABLE, ' +
      'Outside camera: HTTP CRITICAL, NAS du salon: RAID CRITICAL, ' +
      'NAS du salon: Backup UNKNOWN, NAS du salon: Disk / WARNING',
  });

  const one = await w.fake.sceneAction('get_problems', { device: hostDevice(w.gladys, 'outside') });
  assert.equal(one.data.outputs.count, 2);
  assert.equal(one.data.outputs.names, 'Outside camera: DOWN, Outside camera: HTTP CRITICAL');
});

test('the scene actions fail clearly while Nagios does not answer', async (t) => {
  const w = await world(t);
  w.nagios.failure = 'down';
  w.clock.advance(20_000);
  const ack = await w.fake.sceneAction('get_problems', {});
  assert.equal(ack.success, false);
  assert.match(ack.error, /does not answer/);
});
