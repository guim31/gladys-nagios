# Nagios

Hol deine [Nagios-Core](https://www.nagios.org/projects/nagios-core/)-Überwachung
in Gladys: Jeder Host wird ein Gerät (UP, Services WARNING, CRITICAL und
UNKNOWN, unbehandelte Probleme, quittiert, Wartungszeit), ein Gerät „Nagios“
fasst alles zusammen und zeigt, ob Nagios läuft, und deine Szenen reagieren,
wenn ein Host ausfällt oder ein Service ein Problem hat — eine rote Lampe, wenn
das NAS weg ist, eine Nachricht, wenn eine Sicherung CRITICAL wird. Eine Szene
kann auch die Probleme eines Hosts quittieren oder ihn sofort prüfen lassen,
und ein Dashboard-Widget listet die aktuellen Probleme.

Die Integration liest die JSON-CGIs der Nagios-Weboberfläche in deinem lokalen
Netz, mit einem Web-Benutzer. Nichts läuft über eine Cloud.

Getestet mit einem echten Nagios Core 4.5 (4.5.12, Docker-Image
`jasonrivers/nagios`, Dummy-Checks auf WARNING, CRITICAL und UNKNOWN gesetzt,
ein Host DOWN, ein Host UNREACHABLE dahinter, eine Wartungszeit,
Quittierungen, ein nie geprüfter Host, der gestoppte Dienst). Rückmeldungen
sind willkommen:
[github.com/guim31/gladys-nagios/issues](https://github.com/guim31/gladys-nagios/issues).

## Was du brauchst

- Gladys Assistant 5.1.0 oder neuer.
- Nagios Core 4 (ab 4.0: die JSON-CGIs `statusjson.cgi` und `objectjson.cgi`
  kamen damit) und seine Weboberfläche, erreichbar vom Gladys-Rechner aus.
  Nagios XI, Icinga, Naemon und Shinken sind andere Produkte.
- Einen Web-Benutzer für Gladys mit den nötigen Rechten in `cgi.cfg`.

## Erste Schritte

### 1. Einen Web-Benutzer anlegen

Füge auf dem Nagios-Server einen Benutzer zur Passwortdatei der Weboberfläche
hinzu (der Pfad hängt von der Installation ab):

```
htpasswd /usr/local/nagios/etc/htpasswd.users gladys
```

Gib ihm dann die Rechte in `cgi.cfg`, indem du `gladys` zu diesen Zeilen
hinzufügst (durch Kommas getrennt):

```
authorized_for_all_hosts=nagiosadmin,gladys
authorized_for_all_services=nagiosadmin,gladys
authorized_for_all_host_commands=nagiosadmin,gladys
authorized_for_all_service_commands=nagiosadmin,gladys
```

Die letzten beiden braucht es nur zum Quittieren oder sofortigen Prüfen aus
Gladys: Lass sie weg, wenn Gladys nur lesen soll. Ohne die ersten beiden sieht
der Benutzer nur die Hosts und Services, deren Kontakt er ist. Kein Neustart
nötig: Die CGIs lesen `cgi.cfg` bei jeder Anfrage. Die Befehle brauchen
außerdem `check_external_commands=1` in `nagios.cfg` (die Voreinstellung).

### 2. Die Integration konfigurieren

Öffne in Gladys die Konfiguration der Integration:

- **Adresse**: die Adresse der Nagios-Weboberfläche, z. B.
  `192.168.1.2/nagios`. `http://` und `/nagios` werden ergänzt, außer du gibst
  etwas anderes ein (`/nagios4` bei den Debian- und Ubuntu-Paketen); die aus
  dem Browser kopierte Adresse einer Seite der Oberfläche geht auch.
- **Web-Benutzer** und **Passwort**: der Benutzer aus Schritt 1.
- **Hostgruppen (optional)**: Namen von Nagios-Hostgruppen (`hostgroup_name`),
  durch Kommas getrennt, z. B. `homelab, linux-servers`: Ein Host aus einer
  davon wird übernommen. Leer: alle Hosts.
- **Aktualisierungsintervall**: 30 Sekunden bis 5 Minuten (standardmäßig 1
  Minute).
- **Quittieren aus Szenen erlauben** und **Sofortige Prüfung aus Szenen
  erlauben**: Deaktiviere sie, um diese Aktionen auszuschalten.
- **Selbstsignierte Zertifikate akzeptieren**: nur für eine `https://`-Adresse
  mit eigenem Zertifikat; es wird dann nicht geprüft.
- **Sprache der Namen**: Sprache der Funktionsnamen und der Szenen-Ergebnisse.

Speichere und klicke dann auf **Verbindung testen**: Es zeigt die
Nagios-Version, die Zahl der Hosts, der ausgefallenen Hosts und der Services
mit Problem.

### 3. Die Geräte hinzufügen

Öffne den Tab **Entdecken** der Integration und füge die Hosts hinzu, die du
verfolgen willst, und das Gerät „Nagios“, wenn du die Summen willst. Die
Szenen-Auslöser gelten für alle Hosts, ob in Gladys hinzugefügt oder nicht.

## Die Geräte

Jeder **Host** (nach seinem Alias in Nagios benannt):

| Funktion              | Wert                                                                     |
| --------------------- | ------------------------------------------------------------------------ |
| Host UP               | 1 UP, 0 DOWN oder UNREACHABLE; leer, solange der Host PENDING ist        |
| Services WARNING      | Zahl der Services WARNING                                                |
| Services CRITICAL     | Zahl der Services CRITICAL                                               |
| Services UNKNOWN      | Zahl der Services UNKNOWN                                                |
| Unbehandelte Probleme | Host- und Service-Probleme, weder quittiert noch in einer Wartungszeit   |
| Host quittiert        | 1, solange der Host DOWN oder UNREACHABLE und sein Problem quittiert ist |
| In Wartungszeit       | 1, solange der Host in einer geplanten Wartungszeit ist                  |

Das Gerät **Nagios**: Nagios läuft (1, solange der Nagios-Dienst seinen Status
aktualisiert, 0, sobald er gestoppt ist), Hosts DOWN (DOWN oder UNREACHABLE),
Services WARNING, Services CRITICAL, Services UNKNOWN und Unbehandelte
Probleme, über die Hosts der Konfiguration.

Ein Host ist UNREACHABLE, wenn er hinter einem Elternteil (`parents`) ausfällt,
der ebenfalls ausgefallen ist. Die Service-Zähler enthalten die Zustände, die
Nagios noch bestätigt (SOFT), wie seine Weboberfläche. Werte gehen nur bei
einer Änderung an Gladys, sonst alle 6 Stunden.

## Dashboard

Das Widget **Nagios-Probleme** zeigt drei Kacheln — die ausgefallenen Hosts,
die Services CRITICAL, die unbehandelten Probleme — und die Probleme: Hosts
DOWN, dann UNREACHABLE, dann Services CRITICAL, UNKNOWN und WARNING, die
neuesten zuerst. Jede Zeile nennt den Service und seinen Zustand, den Host, ✓
sobald quittiert und ⏸ in einer Wartungszeit. Höchstens zehn Zeilen.
**Aktualisieren** liest Nagios neu. Wähle in den Einstellungen Hosts, um nur
deren Probleme zu zeigen (leer: alle Hosts).

## Szenen

### Auslöser

- **Ein Host fällt aus**: Ein Host wird DOWN oder UNREACHABLE. Filter: Hosts
  (leer: alle). Variablen: Hostname, Zustand (DOWN, UNREACHABLE). Ein Host, der
  von DOWN zu UNREACHABLE wechselt, wird nicht zweimal gemeldet.
- **Ein Host ist wieder da**: Ein als ausgefallen gemeldeter Host ist wieder
  UP. Variablen: Hostname, Dauer in Minuten.
- **Ein Service hat ein Problem**: Ein Service wird WARNING, CRITICAL oder
  UNKNOWN oder wechselt zwischen ihnen (zum Beispiel von WARNING zu CRITICAL).
  Filter: Hosts, Zustände (leer: alle; für „nur CRITICAL“ wähle CRITICAL).
  Variablen: Hostname, Service, Zustand, Check-Ausgabe (ihre erste Zeile).
- **Ein Service ist wieder OK**: Ein als problematisch gemeldeter Service ist
  wieder OK. Filter: Hosts, der zuletzt gemeldete Problemzustand. Variablen:
  Hostname, Service, letzter Problemzustand, Dauer in Minuten.
- **Nagios überwacht nicht mehr**: Die Weboberfläche antwortet zweimal
  hintereinander nicht, oder der Nagios-Dienst ist gestoppt (Variablen:
  Adresse, Fehler).

Probleme, die beim Start der Integration schon da sind, werden nicht gemeldet,
ihr Ende aber schon. Nur bestätigte Zustände (HARD) zählen: Solange Nagios
einen Check wiederholt (Zustand SOFT, bis `max_check_attempts`), wird nichts
gemeldet, so wie Nagios auch nicht benachrichtigt. Eine Änderung während eines
Neustarts von Gladys oder der Integration wird beim nächsten Lesen einmal
gemeldet. Ein Problem in einer Wartungszeit (des Services oder seines Hosts)
wird nicht gemeldet; ist es am Ende der Wartungszeit noch da, wird es dann
gemeldet.

### Aktionen

- **Probleme eines Hosts quittieren**: quittiert in Nagios das Host-Problem
  (DOWN, UNREACHABLE) und jeden seiner Services mit Problem, der noch nicht
  quittiert ist, mit einem Kommentar (leer: „In Gladys quittiert“). Die
  Quittierung bleibt bestehen (bis der Host UP oder der Service OK ist), ihr
  Kommentar wird behalten; Nagios trägt den Namen des Web-Benutzers als Autor
  ein. Gibt die Zahl der quittierten Probleme zurück. Schalte sie mit
  „Quittieren aus Szenen erlauben“ aus.
- **Host jetzt prüfen**: bittet Nagios, den Host und alle seine Services sofort
  zu prüfen (erzwungen, wie „Re-schedule the next check“ der Weboberfläche),
  zum Beispiel nach einer Reparatur oder einem Neustart. Die neuen Zustände
  kommen mit den nächsten Lesevorgängen. Schalte sie mit „Sofortige Prüfung aus
  Szenen erlauben“ aus.
- **Probleme lesen**: zählt und listet die Probleme eines Hosts oder aller, für
  die folgenden Aktionen: Anzahl, unbehandelt, ausgefallene Hosts, Services
  CRITICAL, WARNING und UNKNOWN, und die Liste „Host: Problem“.

### Szenen-Ideen

- **Eine rote Lampe, wenn das NAS ausfällt**: Auslöser „Ein Host fällt aus“,
  Host NAS → die Wohnzimmerlampe rot schalten und
  `{{triggerEvent.data.host}}: {{triggerEvent.data.state_name}}` senden.
- **Nur kritische Services**: Auslöser „Ein Service hat ein Problem“, Zustand
  CRITICAL → Nachricht `{{triggerEvent.data.host}} / {{triggerEvent.data.service}}:
{{triggerEvent.data.output}}`.
- **Zurück nach einem Neustart**: Wenn die smarte Steckdose des NAS wieder
  eingeschaltet wird, 3 Minuten warten, dann „Host jetzt prüfen“ für das NAS:
  Kein Warten auf den nächsten Check.
- **Morgenbericht**: jeden Tag um 8:00 „Probleme lesen“ → Anzahl und Liste
  senden, wenn die Anzahl über 0 liegt.
- **Vom Sofa aus gesehen**: Ein Dashboard-Button oder eine Zigbee-Fernbedienung
  startet „Probleme eines Hosts quittieren“ für das NAS.

## Fehlerbehebung

- **„Benutzer oder Passwort vom Webserver abgelehnt“**: Prüfe den Benutzer in
  `htpasswd.users` (melde dich damit an der Weboberfläche an).
- **„Nagios antwortet nicht“**: Prüfe die Adresse vom Gladys-Rechner aus.
  `localhost` ist der Container der Integration selbst: Nutze die IP-Adresse
  des Nagios-Rechners.
- **„Kein Nagios Core 4 unter dieser Adresse“**: Der Web-Pfad stimmt nicht
  (`/nagios`, `/nagios4`…), oder ein anderes Programm antwortet dort. Kopiere
  die Adresse der Nagios-Startseite aus dem Browser.
- **„Der Nagios-Dienst läuft nicht“**: Der Webserver antwortet, aber Nagios
  selbst ist gestoppt oder hängt (seine Statusdatei fehlt oder ist alt):
  Starte Nagios neu und prüfe seine Konfiguration mit `nagios -v nagios.cfg`.
- **„Kein Host sichtbar“**: Füge den Benutzer zu `authorized_for_all_hosts`
  und `authorized_for_all_services` in `cgi.cfg` hinzu, oder mach ihn zum
  Kontakt der Hosts.
- **„Eine Hostgruppe der Konfiguration existiert nicht“**: Prüfe die
  Schreibweise; es ist der `hostgroup_name`, nicht ihr Alias.
- **„Zertifikat abgelehnt“**: Aktiviere „Selbstsignierte Zertifikate
  akzeptieren“.
- **Quittieren oder Prüfen wird abgelehnt**: Füge den Benutzer zu
  `authorized_for_all_host_commands` und `authorized_for_all_service_commands`
  in `cgi.cfg` hinzu; „Nagios nimmt keine externen Befehle an“: Setze
  `check_external_commands=1` in `nagios.cfg` und starte Nagios neu.

## Grenzen

- Ein Nagios pro Integration. Nagios XI und die Ableger (Icinga, Naemon) werden
  nicht unterstützt: Deren Schnittstellen sind anders.
- Nur Host- und Service-Zustände: keine Metriken, keine Performance-Daten.
- Die Integration liest Nagios im gewählten Intervall: Ein Ereignis, das
  zwischen zwei Lesevorgängen kommt und geht, wird verpasst. Nagios schreibt
  seinen Status alle 10 Sekunden (`status_update_interval`): Eine Quittierung
  erscheint ein paar Sekunden später.
- „Ein Service ist wieder OK“ wird auch ausgelöst, wenn ein Service mit Problem
  aus der Überwachung entfernt wird; ein aus Nagios oder dem Bereich entfernter
  Host endet still.
- Höchstens 30 Szenen-Ereignisse pro Lesevorgang: Ein Netzausfall kann Dutzende
  auf einmal auslösen; der Rest folgt bei den nächsten Lesevorgängen.
- Kein Kontingent: Jeder Lesevorgang schickt drei Anfragen an die CGIs (eine
  mehr pro Hostgruppe, und einmal pro Stunde die Objektliste, für die Aliase).
  Ein Befehl sind zwei Anfragen (das Formular, für das Anti-CSRF-Token von
  Nagios 4.5, dann der Befehl).

Nicht mit Nagios Enterprises verbunden.
