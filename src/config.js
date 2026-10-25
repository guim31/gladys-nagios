// -----------------------------------------------------------------------------
// Integration configuration: defaults (they mirror the `default` values of the
// manifest `config_schema`, see test/manifest.test.js) and normalization, so
// the rest of the code never deals with strings, blanks or `undefined`.
//
// One Nagios Core 4, through its CGIs (`/nagios/cgi-bin` by default), behind
// the Basic auth of its web server. The address can be typed as a host, with
// the web path (`nagios.lan/nagios4`), or copied from the browser
// (`http://192.0.2.5/nagios/cgi-bin/status.cgi?host=all`).
// -----------------------------------------------------------------------------

export const LANGUAGES = ['en', 'fr', 'de', 'es'];

// Refresh intervals offered in the configuration, in seconds.
export const POLL_INTERVALS = ['30', '60', '120', '300'];

export const DEFAULT_CONFIG = {
  nagios_url: '',
  username: '',
  password: '',
  host_groups: '',
  poll_interval: '60',
  allow_acknowledge: true,
  allow_recheck: true,
  allow_self_signed: false,
  language: 'fr',
};

export const MAX_GROUPS = 20;

export const DEFAULT_PATH = '/nagios';
const CGI_PATH = '/cgi-bin';

/**
 * Parse the address typed by the user into the base URL of the CGIs:
 * `192.0.2.5`, `nagios.lan/nagios4`, `https://192.0.2.5:8443/nagios/`, or a
 * page of the web interface. HTTP and `/nagios` unless typed.
 * @param {unknown} raw
 * @returns {string|null} `http(s)://host[:port]/path/cgi-bin`, null when unusable
 */
export function parseCgiUrl(raw) {
  if (typeof raw !== 'string') {
    return null;
  }
  const text = raw.trim();
  if (!text) {
    return null;
  }
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`;
  let url;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) {
    return null;
  }
  // Credentials in the address would end up in the logs.
  if (url.username || url.password) {
    return null;
  }
  // Everything before /cgi-bin is the web path of Nagios; a page of the
  // interface (`/nagios/main.php`) is dropped.
  const at = url.pathname.search(/\/cgi-bin(\/|$)/);
  let prefix = (at >= 0 ? url.pathname.slice(0, at) : url.pathname)
    .replace(/\/[^/]*\.(php|html?|cgi)$/i, '')
    .replace(/\/+$/, '');
  // No path typed: the default of the Nagios packages. `/cgi-bin` typed
  // alone: Nagios served at the root.
  if (!prefix && at < 0) {
    prefix = DEFAULT_PATH;
  }
  return `${url.origin}${prefix}${CGI_PATH}`;
}

/** The address shown to the user: host and web path, without scheme nor /cgi-bin. */
export const addressOf = (cgiUrl) =>
  cgiUrl.replace(/^https?:\/\//, '').replace(new RegExp(`${CGI_PATH}$`), '');

/** Host group names, separated by commas, `;` or new lines. */
export function parseGroups(raw) {
  if (typeof raw !== 'string') {
    return [];
  }
  const seen = new Set();
  const groups = [];
  for (const entry of raw.split(/[\n,;]/)) {
    const name = entry.trim();
    if (name && !seen.has(name.toLowerCase())) {
      seen.add(name.toLowerCase());
      groups.push(name);
    }
  }
  return groups.slice(0, MAX_GROUPS);
}

const isTrue = (value) => value === true || value === 'true';

/**
 * @param {Record<string, unknown>} raw the configuration returned by the SDK
 */
export function normalizeConfig(raw = {}) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const text = (key) => (typeof source[key] === 'string' ? source[key].trim() : '');
  const pick = (key, list) => {
    const value = source[key] === undefined || source[key] === null ? '' : String(source[key]);
    return list.includes(value) ? value : DEFAULT_CONFIG[key];
  };
  const typed = text('nagios_url');
  const apiUrl = parseCgiUrl(typed);
  return {
    apiUrl,
    invalidUrl: Boolean(typed) && !apiUrl,
    username: text('username'),
    // A pasted password often carries a trailing space or new line.
    password: text('password'),
    groups: parseGroups(source.host_groups),
    pollIntervalMs: Number(pick('poll_interval', POLL_INTERVALS)) * 1000,
    allowAcknowledge:
      source.allow_acknowledge === undefined || source.allow_acknowledge === null
        ? DEFAULT_CONFIG.allow_acknowledge
        : isTrue(source.allow_acknowledge),
    allowRecheck:
      source.allow_recheck === undefined || source.allow_recheck === null
        ? DEFAULT_CONFIG.allow_recheck
        : isTrue(source.allow_recheck),
    allowSelfSigned:
      source.allow_self_signed === undefined || source.allow_self_signed === null
        ? DEFAULT_CONFIG.allow_self_signed
        : isTrue(source.allow_self_signed),
    language: LANGUAGES.includes(source.language) ? source.language : DEFAULT_CONFIG.language,
  };
}
