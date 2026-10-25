// -----------------------------------------------------------------------------
// Dashboard widget (manifest `widgets`, Gladys 5.1+): `problems`.
//
// The use case: a glance at the wall tablet tells whether the homelab is
// fine, and if not, what is wrong where. So the widget shows the hosts down,
// the services CRITICAL, the problems not handled yet (neither acknowledged nor
// in a downtime), and one row per problem — hosts down first, then services
// CRITICAL, UNKNOWN, WARNING — with the service, its host, and its state as icon and
// colour.
//
// Every host by default, or the hosts chosen in the widget settings (devices
// added to Gladys). The figures are sent as values, not bound to device
// features: the widget works before any device is added.
//
// Budget (8 components, 2 texts): three tiles, one status list of ten rows at
// most, one text while Nagios does not answer, and a Refresh button.
// -----------------------------------------------------------------------------

import { WIDGET_COLORS } from '@gladysassistant/integration-sdk';
import { isUnhandled } from './devices.js';
import { WIDGET_KEY } from './hub.js';
import { ERROR_TEXT, HOST_STATE_NAMES, SERVICE_STATE_NAMES, labelled, pick } from './texts.js';

// Action key of the button: permanent once published.
export const ACTIONS = Object.freeze({ REFRESH: 'refresh' });

export const MAX_ROWS = 10;

export const TEXT = {
  configure: {
    en: 'Enter the address of your Nagios and its web user in the configuration of the integration.',
    fr: "Saisissez l'adresse de votre Nagios et son utilisateur web dans la configuration de l'intégration.",
    de: 'Gib die Adresse deines Nagios und seinen Web-Benutzer in der Konfiguration der Integration ein.',
    es: 'Introduzca la dirección de su Nagios y su usuario web en la configuración de la integración.',
  },
  hostsDown: { en: 'Hosts down', fr: 'Hôtes DOWN', de: 'Hosts DOWN', es: 'Hosts DOWN' },
  critical: {
    en: 'Services CRITICAL',
    fr: 'Services CRITICAL',
    de: 'Services CRITICAL',
    es: 'Servicios CRITICAL',
  },
  unhandled: {
    en: 'Unhandled',
    fr: 'Non traités',
    de: 'Unbehandelt',
    es: 'Sin gestionar',
  },
  allClear: { en: 'No problem', fr: 'Aucun problème', de: 'Kein Problem', es: 'Ningún problema' },
  hosts: { en: 'hosts', fr: 'hôtes', de: 'Hosts', es: 'hosts' },
  host: { en: 'Host', fr: 'Hôte', de: 'Host', es: 'Host' },
  more: { en: 'Others', fr: 'Autres', de: 'Weitere', es: 'Otros' },
  refresh: { en: 'Refresh', fr: 'Actualiser', de: 'Aktualisieren', es: 'Actualizar' },
  refreshed: {
    en: 'Nagios read again.',
    fr: 'Nagios relu.',
    de: 'Nagios neu gelesen.',
    es: 'Nagios leído de nuevo.',
  },
};

// As in the Nagios web interface: hosts DOWN and UNREACHABLE and services
// CRITICAL in red, WARNING in yellow, UNKNOWN in orange.
const HOST_STYLE = { icon: 'server', color: WIDGET_COLORS.DANGER };
const SERVICE_STYLE = [
  null,
  { icon: 'alert-triangle', color: WIDGET_COLORS.WARNING },
  { icon: 'alert-octagon', color: WIDGET_COLORS.DANGER },
  { icon: 'help-circle', color: WIDGET_COLORS.WARNING },
];

const fit = (text, max) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);

const refreshButton = (language) => ({
  type: 'button',
  label: pick(TEXT.refresh, language),
  icon: 'refresh-cw',
  style: 'secondary',
  action: { key: ACTIONS.REFRESH },
});

/** The hosts the widget shows: the names of the chosen host devices, or null for every host. */
export function chosenHosts(hub, settings) {
  const chosen = [settings?.hosts ?? []].flat().filter((id) => typeof id === 'string' && id);
  // Chosen hosts that left the scope show nothing, not every host.
  return chosen.length > 0 ? new Set(chosen.map((id) => hub.findHost(id)?.name)) : null;
}

function row(hub, problem, language) {
  // The icon and colour carry the state; ✓: acknowledged, ⏸: in a downtime.
  const marks = `${problem.acknowledged ? ' ✓' : ''}${problem.downtime ? ' ⏸' : ''}`;
  if (!problem.service) {
    return {
      label: fit(`${pick(TEXT.host, language)} ${HOST_STATE_NAMES[problem.state]}`, 40),
      value: fit(`${hub.hostLabel(problem.host)}${marks}`, 40),
      ...HOST_STYLE,
    };
  }
  return {
    label: fit(`${problem.service} ${SERVICE_STATE_NAMES[problem.state]}`, 40),
    value: fit(`${hub.hostLabel(problem.host)}${marks}`, 40),
    ...SERVICE_STYLE[problem.state],
  };
}

async function get(hub, { settings, language = 'en' }) {
  if (!hub.client) {
    return {
      ttl_seconds: 300,
      components: [{ type: 'text', variant: 'body', text: pick(TEXT.configure, language) }],
    };
  }
  const components = [];
  const error = hub.error
    ? {
        type: 'text',
        variant: 'body',
        text: labelled(hub.instanceName(), pick(ERROR_TEXT[hub.error.kind], language), language),
      }
    : null;
  if (!hub.data) {
    return { ttl_seconds: 30, components: [error, refreshButton(language)].filter(Boolean) };
  }

  const scope = chosenHosts(hub, settings);
  const hostCount = [...hub.data.hosts.keys()].filter((name) => !scope || scope.has(name)).length;
  const problems = hub.problems(scope);
  const hostsDown = problems.filter((problem) => !problem.service).length;
  const critical = problems.filter((problem) => problem.service && problem.state === 2).length;
  const unhandled = problems.filter(isUnhandled).length;

  components.push(
    {
      type: 'value',
      value: hostsDown,
      label: pick(TEXT.hostsDown, language),
      icon: 'server',
      color: hostsDown > 0 ? WIDGET_COLORS.DANGER : WIDGET_COLORS.SUCCESS,
    },
    {
      type: 'value',
      value: critical,
      label: pick(TEXT.critical, language),
      icon: 'alert-octagon',
      color: critical > 0 ? WIDGET_COLORS.DANGER : WIDGET_COLORS.SUCCESS,
    },
    {
      type: 'value',
      value: unhandled,
      label: pick(TEXT.unhandled, language),
      icon: 'bell',
      color: unhandled > 0 ? WIDGET_COLORS.WARNING : WIDGET_COLORS.NEUTRAL,
    },
  );
  if (error) {
    components.push(error);
  }

  let items;
  if (problems.length === 0) {
    items = [
      {
        label: pick(TEXT.allClear, language),
        value: `${hostCount} ${pick(TEXT.hosts, language)}`,
        icon: 'check-circle',
        color: WIDGET_COLORS.SUCCESS,
      },
    ];
  } else {
    const shown = problems.length > MAX_ROWS ? problems.slice(0, MAX_ROWS - 1) : problems;
    items = shown.map((problem) => row(hub, problem, language));
    if (problems.length > shown.length) {
      items.push({
        label: pick(TEXT.more, language),
        value: `+${problems.length - shown.length}`,
        icon: 'more-horizontal',
        color: WIDGET_COLORS.NEUTRAL,
      });
    }
  }
  components.push({ type: 'status', items });
  components.push(refreshButton(language));

  // A problem moves fast: refresh sooner.
  return { ttl_seconds: problems.length > 0 || error ? 30 : 60, components };
}

async function action(hub, { actionKey }) {
  if (actionKey !== ACTIONS.REFRESH) {
    throw new Error(`Unknown action ${actionKey}`);
  }
  await hub.pollAll({ fresh: true });
  return { message: TEXT.refreshed };
}

export const WIDGETS = {
  [WIDGET_KEY]: { get, action },
};
