// -----------------------------------------------------------------------------
// Scene action handlers (manifest `scene_actions`, Gladys 5.1+).
//
// "Is this host down?" is already a scene condition on the device features.
// These actions do what a condition cannot:
//   - acknowledge the problems of a host from a scene (a button of the
//     dashboard, a vocal command, a "seen" reply), with a comment in Nagios:
//     the host problem if it is DOWN or UNREACHABLE, and each of its services
//     WARNING, CRITICAL or UNKNOWN not acknowledged yet — can be turned off
//     in the configuration;
//   - check a host and its services now (after a repair, a reboot): Nagios
//     would otherwise wait for the next check, up to its check_interval;
//   - put the problems in words for a message ("3 problems: NAS: DOWN…"),
//     across every host, added to Gladys or not.
// They read Nagios again when the last read is older than 15 seconds.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { isDown, isUnhandled } from './devices.js';
import { ERROR_KINDS } from './nagios/client.js';
import { ACTION_TEXT, ERROR_TEXT, pick } from './texts.js';

const logger = createLogger({ name: 'nagios-scenes' });

// Problems listed in the `names` output, at most (the rest is counted).
export const MAX_LISTED_PROBLEMS = 20;
// Nagios keeps the comment whole; a scene does not need more.
export const MAX_COMMENT_LENGTH = 1000;
// Commands per action, at most (one HTTP round trip pair each).
export const MAX_COMMANDS = 50;

function assertReadable(hub) {
  const language = hub.config?.language;
  if (!hub.client) {
    throw new Error(pick(ACTION_TEXT.noServer, language));
  }
  if (hub.error || !hub.data) {
    throw new Error(pick(ERROR_TEXT[hub.error?.kind ?? ERROR_KINDS.UNREACHABLE], language));
  }
}

/** The message of a refused command: what to change, in the user's language. */
function commandFailure(err, language) {
  if (err.kind === ERROR_KINDS.PERMISSION) {
    return new Error(pick(ACTION_TEXT.commandRefused, language), { cause: err });
  }
  return new Error(pick(ERROR_TEXT[err.kind] ?? ERROR_TEXT.http, language), { cause: err });
}

export const SCENE_ACTIONS = {
  async acknowledge_host_problems(hub, { fields = {} }) {
    const language = hub.config?.language;
    if (!hub.client) {
      throw new Error(pick(ACTION_TEXT.noServer, language));
    }
    if (!hub.config.allowAcknowledge) {
      throw new Error(pick(ACTION_TEXT.acknowledgeDisabled, language));
    }
    await hub.refreshIfStale();
    assertReadable(hub);
    const host = hub.findHost(fields.device);
    if (!host) {
      throw new Error(pick(ACTION_TEXT.unknownHost, language));
    }
    const typed = typeof fields.message === 'string' ? fields.message.trim() : '';
    const comment = (typed || pick(ACTION_TEXT.defaultComment, language)).slice(
      0,
      MAX_COMMENT_LENGTH,
    );
    // cmd.cgi takes one object per command. A problem that ended meanwhile
    // is acknowledged for nothing: Nagios ignores it.
    const tasks = [];
    if (isDown(host) && !host.acknowledged) {
      tasks.push(() => hub.client.acknowledgeHost(host.name, comment));
    }
    for (const service of hub.servicesOf(host.name)) {
      if (!service.acknowledged && tasks.length < MAX_COMMANDS) {
        tasks.push(() => hub.client.acknowledgeService(host.name, service.name, comment));
      }
    }
    let acknowledged = 0;
    for (const task of tasks) {
      try {
        await task();
        acknowledged += 1;
      } catch (err) {
        logger.warn(`Acknowledging the problems of ${host.name} failed: ${err.message}`);
        if (acknowledged > 0) {
          await hub.pollAll({ fresh: true });
        }
        throw commandFailure(err, language);
      }
    }
    if (tasks.length === 0) {
      return { acknowledged: 0 };
    }
    logger.info(`${acknowledged} problem(s) of ${host.name} acknowledged`);
    await hub.pollAll({ fresh: true });
    return { acknowledged };
  },

  async check_host_now(hub, { fields = {} }) {
    const language = hub.config?.language;
    if (!hub.client) {
      throw new Error(pick(ACTION_TEXT.noServer, language));
    }
    if (!hub.config.allowRecheck) {
      throw new Error(pick(ACTION_TEXT.recheckDisabled, language));
    }
    await hub.refreshIfStale();
    assertReadable(hub);
    const host = hub.findHost(fields.device);
    if (!host) {
      throw new Error(pick(ACTION_TEXT.unknownHost, language));
    }
    try {
      await hub.client.checkHostNow(host.name);
    } catch (err) {
      logger.warn(`Checking ${host.name} now failed: ${err.message}`);
      throw commandFailure(err, language);
    }
    logger.info(`Check of ${host.name} and its services scheduled now`);
    // The results come with the next reads: Nagios runs the checks meanwhile.
    return { scheduled: true };
  },

  async get_problems(hub, { fields = {} }) {
    const language = hub.config?.language;
    await hub.refreshIfStale();
    assertReadable(hub);
    let scope = null;
    if (fields.device) {
      const host = hub.findHost(fields.device);
      if (!host) {
        throw new Error(pick(ACTION_TEXT.unknownHost, language));
      }
      scope = new Set([host.name]);
    }
    const problems = hub.problems(scope);
    const listed = problems
      .slice(0, MAX_LISTED_PROBLEMS)
      .map((problem) => hub.problemLabel(problem, language));
    const services = problems.filter((problem) => problem.service);
    const ofState = (state) => services.filter((problem) => problem.state === state).length;
    return {
      count: problems.length,
      unhandled: problems.filter(isUnhandled).length,
      hosts_down: problems.length - services.length,
      services_critical: ofState(2),
      services_warning: ofState(1),
      services_unknown: ofState(3),
      names:
        problems.length > listed.length
          ? `${listed.join(', ')}, +${problems.length - listed.length}`
          : listed.join(', '),
    };
  },
};
