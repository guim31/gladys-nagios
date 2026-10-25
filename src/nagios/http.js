// -----------------------------------------------------------------------------
// The one function that talks to the network: an HTTP(S) request on node:http
// / node:https. Not on fetch: fetch cannot accept the self-signed certificate
// of one server only (a Nagios behind HTTPS often has a self-signed one),
// node:https can, per request.
//
// The client takes this function as a parameter: the tests replace it with an
// in-memory Nagios (test/helpers/fakeNagios.js).
// (Adapted from guim31/gladys-zabbix.)
// -----------------------------------------------------------------------------

import http from 'node:http';
import https from 'node:https';

// The status of every host of a big setup weighs a few MB (objectjson.cgi more).
export const MAX_BODY_BYTES = 16 * 1024 * 1024;

/**
 * @param {string} url absolute URL
 * @param {object} [options]
 * @param {string} [options.method] GET by default
 * @param {string} [options.body] request body
 * @param {Record<string, string>} [options.headers]
 * @param {boolean} [options.insecure] accept a certificate that does not verify (HTTPS only)
 * @param {number} [options.timeoutMs]
 * @returns {Promise<{ status: number, headers: Record<string, string>, body: string }>}
 */
export function httpRequest(
  url,
  { method = 'GET', body = '', headers = {}, insecure = false, timeoutMs = 15_000 } = {},
) {
  const target = new URL(url);
  const isHttps = target.protocol === 'https:';

  return new Promise((resolve, reject) => {
    const request = (isHttps ? https : http).request(
      target,
      {
        method,
        headers: body ? { ...headers, 'Content-Length': Buffer.byteLength(body) } : headers,
        timeout: timeoutMs,
        ...(isHttps ? { rejectUnauthorized: !insecure } : {}),
      },
      (response) => {
        const chunks = [];
        let size = 0;
        response.on('data', (chunk) => {
          size += chunk.length;
          if (size > MAX_BODY_BYTES) {
            request.destroy(new Error('Response too large'));
            return;
          }
          chunks.push(chunk);
        });
        response.on('end', () =>
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
        response.on('error', reject);
      },
    );
    // `timeout` only covers a silent socket: a whole answer that trickles in
    // is bounded by this timer too.
    const timeOut = () => {
      const error = new Error(`Timed out after ${timeoutMs} ms`);
      error.code = 'ETIMEDOUT';
      request.destroy(error);
    };
    const timer = setTimeout(timeOut, timeoutMs);
    request.on('timeout', timeOut);
    request.on('close', () => clearTimeout(timer));
    request.on('error', reject);
    request.end(body || undefined);
  });
}
