// -----------------------------------------------------------------------------
// Texts the integration sends to Gladys outside the widget (src/widgets.js):
// connection status, errors, the "Test the connection" report, scene action
// messages. Four languages, the four of the Gladys interface; German says
// "du", Spanish "usted". test/i18n.test.js checks every table.
//
// The states (UP, DOWN, UNREACHABLE, OK, WARNING, CRITICAL, UNKNOWN) stay
// the words of Nagios: its web interface does not translate them either.
// -----------------------------------------------------------------------------

import { ERROR_KINDS } from './nagios/client.js';

export const INIT_FAILED = {
  en: 'Initialization failed, check the integration logs.',
  fr: "L'initialisation a échoué, consultez les logs de l'intégration.",
  de: 'Initialisierung fehlgeschlagen, sieh dir die Protokolle der Integration an.',
  es: 'La inicialización ha fallado, consulte los registros de la integración.',
};

export const CONNECTION_TEXT = {
  noServer: {
    en: 'Enter the address of your Nagios and its web user in the configuration.',
    fr: "Saisissez l'adresse de votre Nagios et son utilisateur web dans la configuration.",
    de: 'Gib die Adresse deines Nagios und seinen Web-Benutzer in der Konfiguration ein.',
    es: 'Introduzca la dirección de su Nagios y su usuario web en la configuración.',
  },
  invalidUrl: {
    en: 'Address not understood, e.g. 192.168.1.2 or http://nagios.lan/nagios',
    fr: 'Adresse incomprise, ex. 192.168.1.2 ou http://nagios.lan/nagios',
    de: 'Adresse nicht verstanden, z. B. 192.168.1.2 oder http://nagios.lan/nagios',
    es: 'Dirección no válida, p. ej. 192.168.1.2 o http://nagios.lan/nagios',
  },
};

// One short explanation per error kind (src/nagios/client.js).
export const ERROR_TEXT = {
  [ERROR_KINDS.UNREACHABLE]: {
    en: 'Nagios does not answer',
    fr: 'Nagios ne répond pas',
    de: 'Nagios antwortet nicht',
    es: 'Nagios no responde',
  },
  [ERROR_KINDS.TLS]: {
    en: 'certificate refused: tick "Accept self-signed certificates"',
    fr: 'certificat refusé : cochez « Accepter les certificats auto-signés »',
    de: 'Zertifikat abgelehnt: Aktiviere „Selbstsignierte Zertifikate akzeptieren“',
    es: 'certificado rechazado: marque «Aceptar certificados autofirmados»',
  },
  [ERROR_KINDS.AUTH]: {
    en: 'user or password refused by the web server',
    fr: 'utilisateur ou mot de passe refusé par le serveur web',
    de: 'Benutzer oder Passwort vom Webserver abgelehnt',
    es: 'usuario o contraseña rechazados por el servidor web',
  },
  [ERROR_KINDS.CREDENTIALS_MISSING]: {
    en: 'Nagios asks for a user and a password',
    fr: 'Nagios demande un utilisateur et un mot de passe',
    de: 'Nagios verlangt einen Benutzer und ein Passwort',
    es: 'Nagios pide un usuario y una contraseña',
  },
  [ERROR_KINDS.NOT_NAGIOS]: {
    en: 'no Nagios Core 4 at this address: check the web path (/nagios)',
    fr: 'pas de Nagios Core 4 à cette adresse : vérifiez le chemin web (/nagios)',
    de: 'kein Nagios Core 4 unter dieser Adresse: Prüfe den Web-Pfad (/nagios)',
    es: 'no hay ningún Nagios Core 4 en esta dirección: compruebe la ruta web (/nagios)',
  },
  [ERROR_KINDS.DAEMON_STOPPED]: {
    en: 'the Nagios daemon is not running',
    fr: "le démon Nagios n'est pas lancé",
    de: 'der Nagios-Dienst läuft nicht',
    es: 'el servicio Nagios no está en marcha',
  },
  [ERROR_KINDS.NO_HOSTS]: {
    en: 'no host visible: see authorized_for_all_hosts in cgi.cfg',
    fr: 'aucun hôte visible : voir authorized_for_all_hosts dans cgi.cfg',
    de: 'kein Host sichtbar: Sieh dir authorized_for_all_hosts in cgi.cfg an',
    es: 'ningún host visible: consulte authorized_for_all_hosts en cgi.cfg',
  },
  [ERROR_KINDS.UNKNOWN_GROUP]: {
    en: 'a host group of the configuration does not exist in Nagios',
    fr: "un groupe d'hôtes de la configuration n'existe pas dans Nagios",
    de: 'eine Hostgruppe der Konfiguration existiert in Nagios nicht',
    es: 'un grupo de hosts de la configuración no existe en Nagios',
  },
  [ERROR_KINDS.PERMISSION]: {
    en: 'this user may not send commands, see the documentation',
    fr: "cet utilisateur n'a pas le droit d'envoyer des commandes, voir la documentation",
    de: 'dieser Benutzer darf keine Befehle senden, sieh in der Dokumentation nach',
    es: 'este usuario no puede enviar comandos, consulte la documentación',
  },
  [ERROR_KINDS.COMMANDS_DISABLED]: {
    en: 'Nagios does not accept external commands (check_external_commands)',
    fr: "Nagios n'accepte pas les commandes externes (check_external_commands)",
    de: 'Nagios nimmt keine externen Befehle an (check_external_commands)',
    es: 'Nagios no acepta comandos externos (check_external_commands)',
  },
  [ERROR_KINDS.API]: {
    en: 'request refused by Nagios, see the logs',
    fr: 'requête refusée par Nagios, voir les logs',
    de: 'Anfrage von Nagios abgelehnt, sieh in den Protokollen nach',
    es: 'petición rechazada por Nagios, consulte los registros',
  },
  [ERROR_KINDS.HTTP]: {
    en: 'unexpected answer, see the logs',
    fr: 'réponse inattendue, voir les logs',
    de: 'unerwartete Antwort, sieh in den Protokollen nach',
    es: 'respuesta inesperada, consulte los registros',
  },
};

export const HOST_STATE_NAMES = ['UP', 'DOWN', 'UNREACHABLE'];
export const SERVICE_STATE_NAMES = ['OK', 'WARNING', 'CRITICAL', 'UNKNOWN'];

// The "Test the connection" report.
export const REPORT_TEXT = {
  en: {
    ok: 'OK',
    hosts: (count, total) => (count === total ? `${count} host(s)` : `${count}/${total} host(s)`),
    problems: (down, services) => `${down} host(s) down, ${services} service problem(s)`,
  },
  fr: {
    ok: 'OK',
    hosts: (count, total) => (count === total ? `${count} hôte(s)` : `${count}/${total} hôte(s)`),
    problems: (down, services) => `${down} hôte(s) DOWN, ${services} service(s) en problème`,
  },
  de: {
    ok: 'OK',
    hosts: (count, total) => (count === total ? `${count} Host(s)` : `${count}/${total} Host(s)`),
    problems: (down, services) => `${down} Host(s) DOWN, ${services} Service-Problem(e)`,
  },
  es: {
    ok: 'OK',
    hosts: (count, total) => (count === total ? `${count} host(s)` : `${count}/${total} host(s)`),
    problems: (down, services) => `${down} host(s) DOWN, ${services} servicio(s) con problemas`,
  },
};

// Scene action messages (shown in Gladys).
export const ACTION_TEXT = {
  noServer: {
    en: 'No Nagios is configured.',
    fr: "Aucun Nagios n'est configuré.",
    de: 'Kein Nagios ist konfiguriert.',
    es: 'No hay ningún Nagios configurado.',
  },
  unknownHost: {
    en: 'This device is not a Nagios host.',
    fr: "Cet appareil n'est pas un hôte Nagios.",
    de: 'Dieses Gerät ist kein Nagios-Host.',
    es: 'Este dispositivo no es un host de Nagios.',
  },
  acknowledgeDisabled: {
    en: 'Acknowledging is turned off in the configuration of the integration.',
    fr: "L'acquittement est désactivé dans la configuration de l'intégration.",
    de: 'Das Quittieren ist in der Konfiguration der Integration ausgeschaltet.',
    es: 'El reconocimiento está desactivado en la configuración de la integración.',
  },
  recheckDisabled: {
    en: 'Checking now is turned off in the configuration of the integration.',
    fr: "La vérification immédiate est désactivée dans la configuration de l'intégration.",
    de: 'Die sofortige Prüfung ist in der Konfiguration der Integration ausgeschaltet.',
    es: 'La comprobación inmediata está desactivada en la configuración de la integración.',
  },
  commandRefused: {
    en: 'Nagios refused the command: in cgi.cfg, add the user to authorized_for_all_host_commands and authorized_for_all_service_commands.',
    fr: "Nagios a refusé la commande : dans cgi.cfg, ajoutez l'utilisateur à authorized_for_all_host_commands et authorized_for_all_service_commands.",
    de: 'Nagios hat den Befehl abgelehnt: Füge den Benutzer in cgi.cfg zu authorized_for_all_host_commands und authorized_for_all_service_commands hinzu.',
    es: 'Nagios rechazó el comando: en cgi.cfg, añada el usuario a authorized_for_all_host_commands y authorized_for_all_service_commands.',
  },
  defaultComment: {
    en: 'Acknowledged from Gladys',
    fr: 'Acquitté depuis Gladys',
    de: 'In Gladys quittiert',
    es: 'Reconocido desde Gladys',
  },
};

export const LANGUAGE_FALLBACK = 'en';

/** "Name: text", with the space French puts before a colon. */
export const labelled = (name, text, language) =>
  `${name}${language === 'fr' ? ' : ' : ': '}${text}`;
export const pick = (text, language) => text[language] ?? text[LANGUAGE_FALLBACK];
