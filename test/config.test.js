import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_CONFIG,
  MAX_GROUPS,
  addressOf,
  normalizeConfig,
  parseCgiUrl,
  parseGroups,
} from '../src/config.js';

test('the address, with or without scheme or web path, gives the CGI base URL', () => {
  const cgi = 'http://192.0.2.5/nagios/cgi-bin';
  const cases = {
    '192.0.2.5': cgi,
    '192.0.2.5/': cgi,
    '192.0.2.5/nagios': cgi,
    'http://192.0.2.5/nagios/': cgi,
    'http://192.0.2.5/nagios/cgi-bin/status.cgi?host=all': cgi,
    'http://192.0.2.5/nagios/main.php': cgi,
    ' nagios.lan/nagios4 ': 'http://nagios.lan/nagios4/cgi-bin',
    'https://192.0.2.5:8443/monitoring/nagios': 'https://192.0.2.5:8443/monitoring/nagios/cgi-bin',
    '[2001:db8::5]:8080': 'http://[2001:db8::5]:8080/nagios/cgi-bin',
    // Served at the root: /cgi-bin typed alone.
    'http://192.0.2.5/cgi-bin/': 'http://192.0.2.5/cgi-bin',
  };
  for (const [typed, expected] of Object.entries(cases)) {
    assert.equal(parseCgiUrl(typed), expected, typed);
  }
  const bad = ['', '   ', 'ftp://192.0.2.5', 'http://nagiosadmin:nagios@192.0.2.5', 'http://', 42];
  for (const typed of bad) {
    assert.equal(parseCgiUrl(typed), null, String(typed));
  }
  assert.equal(addressOf(cgi), '192.0.2.5/nagios');
});

test('host groups: separated by commas, `;` or new lines, without duplicates', () => {
  assert.deepEqual(parseGroups(' homelab, linux-servers ;Homelab\noffice,,'), [
    'homelab',
    'linux-servers',
    'office',
  ]);
  assert.deepEqual(parseGroups(undefined), []);
  assert.equal(
    parseGroups(Array.from({ length: 30 }, (_, i) => `g${i}`).join(',')).length,
    MAX_GROUPS,
  );
});

test('normalizeConfig: defaults, an invalid address, booleans as strings', () => {
  const empty = normalizeConfig({});
  assert.equal(empty.apiUrl, null);
  assert.equal(empty.invalidUrl, false);
  assert.equal(empty.pollIntervalMs, 60_000);
  assert.equal(empty.allowAcknowledge, true);
  assert.equal(empty.allowRecheck, true);
  assert.equal(empty.allowSelfSigned, false, 'a certificate is verified unless asked');
  assert.equal(empty.language, DEFAULT_CONFIG.language);
  assert.deepEqual(empty.groups, []);

  const config = normalizeConfig({
    nagios_url: 'ftp://192.0.2.5',
    username: ' gladys ',
    password: ' abc \n',
    host_groups: 'homelab',
    poll_interval: 120,
    allow_acknowledge: 'false',
    allow_recheck: false,
    allow_self_signed: 'true',
    language: 'xx',
  });
  assert.equal(config.invalidUrl, true);
  assert.equal(config.username, 'gladys');
  assert.equal(config.password, 'abc');
  assert.deepEqual(config.groups, ['homelab']);
  assert.equal(config.pollIntervalMs, 120_000);
  assert.equal(config.allowAcknowledge, false);
  assert.equal(config.allowRecheck, false);
  assert.equal(config.allowSelfSigned, true);
  assert.equal(config.language, 'fr');
  assert.equal(normalizeConfig({ poll_interval: '15' }).pollIntervalMs, 60_000);
});
