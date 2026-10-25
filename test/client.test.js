// The Nagios client against the fake Nagios (real answers of Nagios Core
// 4.5.12): states mapped from the bit masks of the CGIs, host groups,
// aliases, the errors, and cmd.cgi with its CSRF token.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  COMMANDS,
  ERROR_KINDS,
  NagiosClient,
  commandOutcome,
  formValue,
} from '../src/nagios/client.js';
import { CGI_URL, FakeNagios, PASSWORD, USERNAME, fixture } from './helpers/fakeNagios.js';

function setup({ username = USERNAME, password = PASSWORD, url = CGI_URL } = {}) {
  const nagios = new FakeNagios();
  const client = new NagiosClient({
    url,
    username,
    password,
    request: (target, options) => nagios.request(target, options),
  });
  return { nagios, client };
}

const rejectsWith = (promise, kind) => assert.rejects(promise, (err) => err.kind === kind);

test('snapshot: hosts, aliases and the services in problem of the real answers', async () => {
  const { client } = setup();
  const snapshot = await client.snapshot();
  assert.equal(snapshot.version, '4.5.12');
  assert.equal(snapshot.total, 5);
  const hosts = Object.fromEntries(snapshot.hosts.map((host) => [host.name, host]));
  assert.deepEqual(
    Object.fromEntries(Object.entries(hosts).map(([name, host]) => [name, host.state])),
    { camera: 2, nas: 0, newhost: null, outside: 1, switch: 1 },
    'UP 0, DOWN 1, UNREACHABLE 2, PENDING null',
  );
  assert.equal(hosts.nas.alias, 'NAS du salon');
  assert.equal(hosts.switch.acknowledged, true);
  assert.equal(hosts.outside.downtime, true);
  assert.equal(hosts.camera.hard, true);
  assert.equal(hosts.switch.since, Math.round(hosts.switch.since), 'seconds, not ms');

  const services = snapshot.services.map((service) => [
    service.host,
    service.name,
    service.state,
    service.acknowledged,
    service.downtime,
  ]);
  assert.deepEqual(services, [
    ['nas', 'Backup', 3, false, false],
    ['nas', 'Disk /', 1, false, false],
    ['nas', 'RAID', 2, true, false],
    ['outside', 'HTTP', 2, false, true],
  ]);
  assert.equal(snapshot.services[2].output, 'CRITICAL: RAID CRITICAL - md0 degraded');
});

test('the services read are only the problems (servicestatus), aliases read once', async () => {
  const { nagios, client } = setup();
  await client.snapshot();
  await client.snapshot();
  const list = nagios.calls.find((call) => call.params.query === 'servicelist');
  assert.equal(list.params.servicestatus, 'warning critical unknown');
  assert.equal(nagios.calls.filter((call) => call.cgi === 'objectjson.cgi').length, 1);
  // A new host: the aliases are read again.
  nagios.hosts.push({ ...nagios.host('nas'), name: 'printer', alias: 'Printer' });
  const again = await client.snapshot();
  assert.equal(again.hosts.find((host) => host.name === 'printer').alias, 'Printer');
  assert.equal(nagios.calls.filter((call) => call.cgi === 'objectjson.cgi').length, 2);
});

test('host groups: the union of their members, and an unknown group is an error', async () => {
  const { client } = setup();
  const snapshot = await client.snapshot({ groups: ['homelab'] });
  assert.deepEqual(
    snapshot.hosts.map((host) => host.name),
    ['nas', 'switch'],
  );
  assert.deepEqual([...new Set(snapshot.services.map((service) => service.host))], ['nas']);
  assert.equal(snapshot.total, 5);
  await rejectsWith(client.snapshot({ groups: ['homelab', 'nope'] }), ERROR_KINDS.UNKNOWN_GROUP);
});

test('errors: refused password, no user, nothing visible, not Nagios, proxy, network', async () => {
  await rejectsWith(setup({ password: 'wrong' }).client.snapshot(), ERROR_KINDS.AUTH);
  await rejectsWith(
    setup({ username: '', password: '' }).client.snapshot(),
    ERROR_KINDS.CREDENTIALS_MISSING,
  );
  await rejectsWith(
    setup({ url: 'http://192.0.2.10/nagios4/cgi-bin' }).client.snapshot(),
    ERROR_KINDS.NOT_NAGIOS,
  );
  const { nagios, client } = setup();
  nagios.missing.add('hosts');
  await rejectsWith(client.snapshot(), ERROR_KINDS.NO_HOSTS);
  nagios.missing.clear();
  nagios.failure = 'not_nagios';
  await rejectsWith(client.snapshot(), ERROR_KINDS.NOT_NAGIOS);
  nagios.failure = 'proxy';
  await rejectsWith(client.snapshot(), ERROR_KINDS.UNREACHABLE);
  nagios.failure = 'down';
  await rejectsWith(client.snapshot(), ERROR_KINDS.UNREACHABLE);
});

test('a stopped daemon (empty status) or a hung one (old status) is told apart', async () => {
  const { nagios, client } = setup();
  nagios.failure = 'stopped';
  await rejectsWith(client.snapshot(), ERROR_KINDS.DAEMON_STOPPED);
  nagios.failure = 'stale';
  await rejectsWith(client.snapshot(), ERROR_KINDS.DAEMON_STOPPED);
  nagios.failure = null;
  assert.equal((await client.snapshot()).hosts.length, 5);
});

test('the unauthorized user of the real answers sees an empty list', () => {
  assert.deepEqual(fixture.hostlist_unauthorized.data.hostlist, {});
});

test('commands: the form gives the CSRF token, the POST carries it and the cookie', async () => {
  const { nagios, client } = setup();
  await client.acknowledgeHost('switch', 'Seen');
  await client.acknowledgeService('nas', 'Disk /', 'Seen');
  await client.checkHostNow('nas');
  assert.deepEqual(
    nagios.commands.map(({ type, host, service, comment }) => [type, host, service, comment]),
    [
      [COMMANDS.ACKNOWLEDGE_HOST, 'switch', undefined, 'Seen'],
      [COMMANDS.ACKNOWLEDGE_SERVICE, 'nas', 'Disk /', 'Seen'],
      [COMMANDS.CHECK_HOST, 'nas', undefined, undefined],
      [COMMANDS.CHECK_HOST_SERVICES, 'nas', undefined, undefined],
    ],
  );
  // The check time comes from the form, in the date_format of the server.
  assert.equal(nagios.commands[2].startTime, formValue(fixture.cmd_form, 'start_time'));
  const post = nagios.calls.find((call) => call.method === 'POST');
  assert.equal(post.form.cmd_mod, '2');
  assert.equal(post.form.sticky_ack, 'on');
});

test('commands: before Nagios 4.5 (no token), and the refusals', async () => {
  const { nagios, client } = setup();
  nagios.csrf = false;
  await client.acknowledgeHost('switch', 'Seen');
  assert.equal(nagios.commands.length, 1);
  nagios.csrf = true;
  nagios.missing.add('commands');
  await rejectsWith(client.acknowledgeHost('switch', 'x'), ERROR_KINDS.PERMISSION);
  nagios.missing.clear();
  nagios.missing.add('external_commands');
  await rejectsWith(client.checkHostNow('nas'), ERROR_KINDS.COMMANDS_DISABLED);
});

test('cmd.cgi pages: the real success, refusal and form', () => {
  assert.deepEqual(commandOutcome(fixture.cmd_success), {
    error: null,
    info: 'Your command request was successfully submitted to Nagios for processing.',
  });
  assert.equal(
    commandOutcome(fixture.cmd_denied).error,
    'Sorry, but you are not authorized to commit the specified command.',
  );
  assert.match(formValue(fixture.cmd_form, 'nagFormId'), /^[0-9a-f]+$/);
  assert.match(formValue(fixture.cmd_form, 'start_time'), /^\d\d-\d\d-\d{4} \d\d:\d\d:\d\d$/);
  assert.equal(formValue(fixture.cmd_form, 'missing'), null);
});
