# PixelFleet – Behebung von TD-01 bis TD-09

**Stand:** 12. Oktober 2026 · **Status:** TD-01 vollständig behoben und verifiziert.

**Ausgangsstand:** Commit `e96d01c8faa421bbffb25796924d662e1b30001f` und [TD-01 im historischen Audit](/Users/noahbauditz/Documents/Projects/PixelFleet/docs/tech-debt-audit.md:101). Der Befund wurde vor der Anwendungskorrektur erneut mit Regressionstests nachgewiesen. Der Auditbericht bleibt unverändert; seine damaligen Zeilenreferenzen und Testergebnisse beschreiben den Ausgangsstand.

## Umsetzung

Die Änderung umfasst ausschließlich zwei Backenddateien, zwei bestehende Testdateien und diesen Bericht. Abhängigkeiten, Frontend, Build-/Deploymentkonfiguration und andere Auditbefunde wurden nicht geändert.

| Änderung | Umsetzung und Wirkung |
| --- | --- |
| Frühe Fehlerbehandlung | [server.ts:425](/Users/noahbauditz/Documents/Projects/PixelFleet/apps/backend/src/server.ts:425): Im Upgrade-Callback werden `error` und `close` vor `hub.connect` registriert. Ein Transportfehler gibt den aktiven IP-Verbindungsplatz frei und beendet nur diesen Socket mit `terminate()`. Der Fehler wird einmal protokolliert. Damit sind auch Fehler vor abgeschlossener Hub-Initialisierung abgedeckt. |
| Einmalige Quotenfreigabe | [server.ts:429](/Users/noahbauditz/Documents/Projects/PixelFleet/apps/backend/src/server.ts:429): Der bestehende `released`-Guard wird gemeinsam von Fehler-, Close- und Upgrade-Catch-Pfad verwendet. Der zusätzliche `failed`-Guard verhindert wiederholte Terminierung und Protokollierung. Aufeinanderfolgende Ereignisse können keinen Platz eines anderen Clients freigeben. Das bestehende Limit für Verbindungsversuche wird weiterhin verbraucht, auch bei fehlgeschlagenen Verbindungen. |
| Integration in den Hub-Lebenszyklus | [game-hub.ts:112](/Users/noahbauditz/Documents/Projects/PixelFleet/apps/backend/src/game-hub.ts:112): `error` und `close` führen denselben bestehenden `disconnect(connection)`-Pfad aus. Dieser räumt Sessiontimer, aktuelle Verbindung und Queue auf. Die Identitätsprüfung in [game-hub.ts:188](/Users/noahbauditz/Documents/Projects/PixelFleet/apps/backend/src/game-hub.ts:188) verhindert wiederholte Zustandsänderungen, zusätzliche Reconnecttimer und Eingriffe alter Sockets in Ersatzverbindungen. Fehlerlistener bleiben für verspätete Fehler registriert. |
| Payloadlimit im Transport | [game-hub.ts:29](/Users/noahbauditz/Documents/Projects/PixelFleet/apps/backend/src/game-hub.ts:29) exportiert den bereits vorhandenen Wert aus `MAX_WS_PAYLOAD_BYTES` mit Standardwert 4096. [server.ts:357](/Users/noahbauditz/Documents/Projects/PixelFleet/apps/backend/src/server.ts:357) übergibt genau diesen Wert als `maxPayload` an `WebSocketServer`. Die bisherige Anwendungsprüfung bleibt erhalten. Der Receiver begrenzt damit bereits den Empfang, einschließlich der Gesamtlänge fragmentierter Nachrichten. |

Es gibt keinen globalen `uncaughtException`-Handler. Die Verantwortung bleibt beim jeweiligen Socket: Der Server beendet den Transport und verwaltet den IP-Platz; der Hub bereinigt den Spiel-/Sessionzustand.

## Regressionstests und Nachweis am bisherigen Stand

Die neuen Tests wurden zunächst mit unverändertem Anwendungscode ausgeführt. Alle neun neuen Fälle schlugen fehl; der Vitest-Prozess blieb dabei benutzbar. Anschließend bestanden dieselben neun Fälle mit der Korrektur.

Gezielter Aufruf, nach dem Build des Shared-Pakets:

```sh
npm run build -w packages/shared
npx vitest run tests/deployment.test.ts tests/session-expiry.test.ts \
  -t 'isolates|repeated socket errors|cleans up .* events once|starts one reconnect grace timer'
```

### Echte Verbindungen in isolierten Backendprozessen

[tests/deployment.test.ts:166](/Users/noahbauditz/Documents/Projects/PixelFleet/tests/deployment.test.ts:166) ergänzt fünf Varianten mit eigenen Backend-Unterprozessen, temporären SQLite-Datenbanken und drei authentifizierten Clients:

| Eingabe | Nachweis vor der Korrektur | Ergebnis mit Korrektur |
| --- | --- | --- |
| Textframe mit ungültigem UTF-8 (`0xff`) | Backendabsturz durch unbehandeltes `error`, `WS_ERR_INVALID_UTF8`; anschließender HTTP-Zugriff scheitert | Betroffener Client getrennt; Server und beide anderen Clients arbeiten weiter |
| Reservierter Opcode 3 | Backendabsturz durch unbehandeltes `error`, `WS_ERR_INVALID_OPCODE` | Fehler auf diese Verbindung begrenzt |
| Angekündigte Payload 4097 Byte bei Standardlimit 4096 | Keine zeitnahe Trennung; Test läuft in die 2-Sekunden-Frist | Trennung bereits anhand des Frameheaders, ohne Übertragung des Bodys |
| Angekündigte Payload 513 Byte bei konfiguriertem Limit 512 | Keine zeitnahe Trennung | Konfigurationswert im Transport wirksam |
| Fragmentierte Nachricht: 256 Byte plus angekündigte Fortsetzung mit 257 Byte bei Limit 512 | Keine zeitnahe Trennung | Auch die aggregierte Nachrichtengröße wird begrenzt |

Jede Variante prüft zusätzlich:

- Eine gültige UTF-8-JSON-Nachricht genau am jeweiligen Bytelimit wird angenommen; das enthaltene `é` verhindert eine bloße Zeichenanzahlprüfung.
- Nur der betroffene Client wird geschlossen. HTTP-Health bleibt 200, der Backendprozess läuft und der Hub enthält weiterhin zwei Verbindungen und deren laufende Partie, aber keinen verwaisten Queue-Eintrag.
- Beide unbeteiligten Clients bleiben offen; ein gültiger Schuss wird verarbeitet und beide erhalten den folgenden Zugzustand.
- Der betroffene Account kann erneut verbinden und gültige Nachrichten senden. Ein weiterer Socket wird bei wieder ausgeschöpftem IP-Limit mit HTTP 429 abgewiesen; es wurde kein zusätzlicher Platz freigegeben.
- Der Backend-Unterprozess lässt sich anschließend regulär mit Exitcode 0 beenden.

Ein sechster Unterprozesstest in [tests/deployment.test.ts:234](/Users/noahbauditz/Documents/Projects/PixelFleet/tests/deployment.test.ts:234) injiziert zwei aufeinanderfolgende asynchrone Socketfehler vor der Hub-Initialisierung. Die Injektion existiert ausschließlich im temporären Test-Einstiegspunkt. Vor der Korrektur stürzte das Backend ab. Mit Korrektur bleibt ein vorhandener Client benutzbar, ein Ersatzsocket erhält genau den freigewordenen Platz und ein zusätzlicher Versuch wird mit 429 abgewiesen.

Die Absturzproben laufen niemals im Testrunner selbst. Rohframes umgehen ausschließlich im Test die Senderprüfung des `ws`-Clients über dessen internen TCP-Socket; dafür wurde keine Anwendungsschnittstelle ergänzt.

### Deterministische Lebenszyklusprüfungen

Drei neue Fälle in [tests/session-expiry.test.ts:250](/Users/noahbauditz/Documents/Projects/PixelFleet/tests/session-expiry.test.ts:250) verwenden kontrollierte Sockets und eine simulierte Uhr:

- Sowohl `error` vor `close` als auch `close` vor `error`, jeweils mit Wiederholungen: Verbindung und Queue verschwinden; es verbleibt kein Sessiontimer. Verspätete Ereignisse eines alten Sockets beeinträchtigen die Ersatzverbindung nicht; deren Sessionfrist wird weiterhin korrekt durchgesetzt.
- Fehler während einer Partie: genau ein Reconnecttimer statt mehrfacher Timer oder Updates. Wiederverbindung hebt diesen auf. Späte Ereignisse des alten Sockets beenden die wiederhergestellte Partie nicht. Nach erneutem Ausfall und Ablauf der Schonfrist wird das Ergebnis genau einmal verbucht; beide Profile haben genau eine gespielte Partie.

Vor der Korrektur schlugen diese drei Tests wegen der unbehandelten Socketfehler fehl.

## Vollständige Verifikation

Lokal mit Node **24.20.0** und installiertem `ws` **8.21.0** ausgeführt:

| Prüfung | Ergebnis |
| --- | --- |
| Neue Regressionstests am Ausgangscode | **9 fehlgeschlagen**, 43 bestehende Tests durch Filter ausgelassen; Fehlernachweis vor Anwendungskorrektur |
| Neue Regressionstests mit Korrektur | **9 bestanden**, 43 durch Filter ausgelassen |
| `npm test` | **129/129 bestanden**, alle neun Testdateien; einschließlich 29 Deployment- und 23 Sessionfristtests |
| `npm run typecheck` | Bestanden |
| `npm run build` | Shared-Paket, Backend und Frontend erfolgreich gebaut |
| `npm run smoke:match` | Bestanden gegen das frisch kompilierte `apps/backend/dist/server.js`: vollständige Partie, beide Ergebnisse, Verlierer 350 XP und Gewinner 465 XP; Backend anschließend Exitcode 0 |
| Abschließende Diffprüfung | Keine Änderungen außerhalb TD-01 und seiner Tests/Dokumentation; `git diff --check` bestanden |

Für den bestehenden Match-Smoke wurde das kompilierte Backend mit `PORT=0`, eigener temporärer Datenbank und `TRUST_PROXY=false` gestartet. Der temporäre Prüfcontroller übergab die tatsächlich zugewiesene lokale Adresse als `SMOKE_BASE_URL` an `npm run smoke:match` und entfernte danach Prozess und Fixture. Das Smoke-Skript selbst wurde nicht geändert.

## Grenzen und erhaltener Bestand

- Die Tests decken die genannten Protokollverletzungen, Grenzwerte, Fragmentierung und Ereignisfolgen ab. Es erfolgten kein vollständiges Protokoll-Fuzzing, Last-/Dauerbetrieb oder erschöpfender Test aller Konfigurationswerte.
- Netzwerkproben verwenden echte lokale HTTP-/WebSocket-Verbindungen. Browser, TLS, produktiver Reverse Proxy und ein neuer Dockerlauf wurden für diesen Folgeauftrag nicht geprüft. Die Dockerergebnisse im Audit beziehen sich auf den historischen Ausgangsstand.
- Lebenszyklus- und Timerprüfungen verwenden eine simulierte Uhr. Die vorhandene 30-Sekunden-Reconnectfrist bleibt erhalten: Ist der fehlerhafte Client selbst Teilnehmer einer Partie, greift dieselbe Schonfrist wie bei anderen Verbindungsabbrüchen.
- Fehlerhafte Verbindungen werden mit `terminate()` beendet. Ein bestimmter WebSocket-Closecode wird deshalb nicht zugesichert; Clients können einen abnormalen Verbindungsabbruch sehen. Geprüft sind die Trennung und die weitere Nutzbarkeit des Servers und gültiger Clients.
- Andere Auditbefunde bleiben offen und außerhalb dieses Auftrags. Insbesondere wird hier keine allgemeine Speicherbereinigung oder Änderung der Ergebnispersistenz behauptet.
- Vorhandene unversionierte `.agents/`, `skills-lock.json` und der Auditbericht wurden erhalten. SHA-256 des unveränderten Auditberichts: `e8a8304ce83f26660d630a6db1f5f4834f27158180142985ec22b2e4687cc827`.
- Es erfolgten kein Deployment, Push oder Commit.

**Abschluss:** TD-01 ist im vereinbarten Umfang vollständig behoben. Fehlerhafte WebSocket-Frames beenden die betroffene Verbindung, ohne Backendprozess oder unbeteiligte Clients zu beenden; das konfigurierte Payloadlimit gilt bereits im Transport, und der bestehende Lebenszyklus bereinigt den betroffenen Zustand ohne mehrfache Freigaben.

## TD-03 – Verbindliche Prüfungen im Releasepfad

**Stand:** 12. Oktober 2026 · **Implementiert und lokal nachgewiesen. Externe Dokploy-/Repository-Einstellungen noch zu prüfen und gegebenenfalls einzurichten.** Die vorstehenden Abschnitte dokumentieren weiterhin den TD-01-Auftrag; die damaligen Prüfgrenzen sind keine Aussagen über diesen zusätzlichen TD-03-Nachweis.

### Befundprüfung und Entscheidung

[TD-03 im historischen Audit](/Users/noahbauditz/Documents/Projects/PixelFleet/docs/tech-debt-audit.md:127) war am aktuellen Arbeitsstand weiterhin belegt: Das Dockerfile führte nur `npm run build` aus; `.dockerignore` schloss Tests aus. Die Dokploy-Anleitung band AutoDeploy nicht an vollständige Prüfungen. Ein externer Schutz war mangels Zugang weder bestätigt noch widerlegt.

Die kleinste robuste Lösung ist ein Gate innerhalb des bestehenden mehrstufigen Dockerbuilds. Ein neuer unabhängiger CI-Workflow wäre für diesen Releasepfad allein nicht ausreichend und wurde nicht hinzugefügt. Anwendungscode, Spielregeln, vorhandene Tests und das Match-Smoke-Skript wurden für TD-03 nicht geändert.

### Implementierte Änderungen

| Datei | Änderung |
| --- | --- |
| [package.json:29](/Users/noahbauditz/Documents/Projects/PixelFleet/package.json:29) | `npm run verify` führt vollständige Testsuite, Root-Typecheck und Produktionsbuild nacheinander aus; ein Fehler stoppt die Kette. |
| [.dockerignore:13](/Users/noahbauditz/Documents/Projects/PixelFleet/.dockerignore:13) | Tests dürfen in den Buildkontext; lokale Dependencies, Buildausgaben, Datenbanken und `.env` bleiben ausgeschlossen. |
| [Dockerfile:10](/Users/noahbauditz/Documents/Projects/PixelFleet/Dockerfile:10) | Node 24 und `npm ci` bleiben die Installationsgrundlage. Der Build erhält Tests und Prüfscripte; `npm run verify` läuft ohne externe Netzwerkverbindung. Produktionsabhängigkeiten werden separat mit `npm ci --omit=dev` installiert. |
| [Dockerfile:64](/Users/noahbauditz/Documents/Projects/PixelFleet/Dockerfile:64) | `runtime-check` prüft das frisch erzeugte Runtime-Dateisystem als Produktionsbenutzer mit temporär eingebundenen Scripten und einer SQLite-Fixture im temporären Dateisystem. Das letzte/default Target `runtime` hängt über einen nur eingebundenen Erfolgsmarker von dieser Prüfung ab. Weder Testwerkzeuge noch Marker werden in das finale Runtime-Dateisystem kopiert. |
| [scripts/verify-runtime.mjs:42](/Users/noahbauditz/Documents/Projects/PixelFleet/scripts/verify-runtime.mjs:42) | Startet ausschließlich einen eigenen kompilierten Backendprozess mit Port 0 und temporärer Datenbank; prüft Healthcheck, vollständigen bestehenden Match-Smoke, erneuten Healthcheck und Shutdown mit Exitcode 0. Unterprozesse haben Zeitgrenzen; Fehler und Signale führen zur Beendigung eigener Prozesse und Entfernung der Fixture. |
| [docker-compose.yml:6](/Users/noahbauditz/Documents/Projects/PixelFleet/docker-compose.yml:6) | Legt das freizugebende Target ausdrücklich auf `runtime` fest. |
| [docs/dokploy.md:42](/Users/noahbauditz/Documents/Projects/PixelFleet/docs/dokploy.md:42) | Dokumentiert Gate, ausführbare Prüfkommandos, temporäre Container/Volumes, sichere Fehlerprobe und konkrete externe Einstellungen. Die frühere pauschale AutoDeploy-Freigabe nach dem ersten Deployment entfällt. |

### Lokaler Nachweis

Docker Engine **29.8.2**, Compose **5.5.1**, Node im Image **24.21.0**, UID **1000**. Es wurde kein produktiver Dienst angesprochen. Installationen verwenden das vorhandene unveränderte Lockfile.

| Prüfung | Beobachtetes Ergebnis |
| --- | --- |
| Erster `docker build --progress=plain --target runtime …` | Erfolgreich: `npm ci`, **129/129 Tests**, Typecheck, Produktionsbuild, Runtime-Healthcheck, vollständiger Match-Smoke und regulärer Backend-Shutdown. |
| Finale Imageprüfung als Container | Eigene neue Volume, Netzwerk `none`, read-only Root-Dateisystem, entfernte Capabilities und `no-new-privileges`. Docker-Healthstatus **healthy**, expliziter Healthcheck und vollständiger Match-Smoke erfolgreich; Shutdown **Exitcode 0**. |
| Absichtlich fehlschlagender Test | In einer temporären Kopie des aktuellen Buildkontexts wurde `td03-release-gate-probe.test.ts` mit `expect(true).toBe(false)` ergänzt. Der normale Build ohne `--target` endete bei `npm run verify` mit **Exitcode 1**, **1 fehlgeschlagenem und 129 bestandenen Tests**. Keine Runtime-Prüfung und kein Export unter dem eigenen Probe-Tag; `docker image inspect` bestätigte dessen Fehlen. Der Fehler stammte nachweislich aus der Probe, nicht aus einem Installations- oder Netzwerkproblem. |
| Probe entfernt, erneuter vollständiger Pfad | Nach Löschen ausschließlich der Probe bestand `docker compose --env-file /dev/null -p <temporäres Projekt> -f <temporärer Kontext>/docker-compose.yml --progress plain build --no-cache pixelfleet` erneut: frische `npm ci`-Installationen, **129/129 Tests**, Typecheck, Build, Healthchecks, Match-Smoke und Shutdown. |
| Erneute Prüfung des Compose-Ergebnisimages | Wieder Docker-Healthstatus **healthy**, vollständiger Match-Smoke mit zwei Gästen und beiden Ergebnissen (350/465 XP), Shutdown **Exitcode 0**. |
| Inhalt beider finalen Images | Projekt-`node_modules` enthält ausschließlich `@pixelfleet` und `ws`; Vite, Vitest, TypeScript, tsx und React fehlen. Keine Testdateien, Anwendungsquellen, Smoke-/Prüfscripte, eingebundene Prüfverzeichnisse oder Erfolgsmarker im Runtime-Dateisystem. |
| Bereinigung | Eigene Container, temporäre Volumes, eigene Image-Tags und der temporäre Buildkontext wurden entfernt. Die Fehlerprobe existierte nie im ursprünglichen Checkout. Keine Produktionsdaten oder vorhandenen Volumes verwendet. |
| Abschließender Diff | `git diff --check` bestanden. Der zusätzliche TD-03-Diff beschränkt sich auf Releasekonfiguration, Prüfscripte und Dokumentation. Die vier bereits für TD-01 geänderten Anwendungs-/Testdateien sind gegenüber dem Beginn dieses Folgeauftrags bytegleich. |

Die [Deployment-Anleitung](/Users/noahbauditz/Documents/Projects/PixelFleet/docs/dokploy.md:66) enthält ausführbare positive und negative Prüfkommandos. Die Runtime-Probe im Build prüft das Runtime-Dateisystem und den tatsächlichen Healthcheck-Befehl; die zusätzlichen Containerläufe weisen unabhängig davon auch Docker als Healthcheck-Scheduler und die produktiven Dateisystemrestriktionen nach.

### Extern noch einzurichten bzw. nachzuweisen

Es wurde keine aktive Produktionssperre verifiziert. Für den tatsächlichen Dokploy-Dienst müssen Verantwortliche die [konkreten Schritte](/Users/noahbauditz/Documents/Projects/PixelFleet/docs/dokploy.md:92) durchführen:

1. Richtige Git-Quelle und Deploymentbranch, eingecheckte Compose-Datei, BuildKit und Target `runtime` einstellen bzw. bestätigen.
2. Effektiven Deploybefehl auf verbindlichen Build (`up --build`) und Abbruch bei Fehler prüfen; kein `--no-build`, alternatives Image oder Fallback auf einen alten Tag. Projektidentität und vorhandenes Produktionsvolume erhalten.
3. In einem separaten Dokploy-Testprojekt mit eigener Volume einen fehlerhaften Testcommit und anschließend den bereinigten Commit prüfen. Die fehlgeschlagene Freigabe darf den laufenden Testdienst nicht ersetzen oder als Erfolg erscheinen. Commitzuordnung und Buildlogs kontrollieren.
4. Deploymentbranch gegen direkte/Force-Pushes schützen, Reviews für Releasekonfiguration und Prüfpfad verlangen sowie Dokploy-Änderungsrechte begrenzen. AutoDeploy erst nach diesem Nachweis aktivieren.

Normales Docker-Caching darf erfolgreiche Prüfungen identischer Eingaben wiederverwenden; der erneute lokale Erfolgsnachweis wurde ausdrücklich ohne Cache ausgeführt. Das Node-24-Basisimage ist ein fortlaufender Patch-Tag; die reproduzierbare npm-Installation wird nicht mit bitidentischen Images über Basisimage-Updates hinweg gleichgesetzt. Buildchecks ersetzen keine Browser-, TLS-, Proxy- oder Live-Dokploy-Prüfung. Bewusstes Ändern der Releasekonfiguration kann den Gate umgehen und muss deshalb durch die externen Rechte-/Reviewregeln abgedeckt werden.

Der historische Auditbericht bleibt bytegleich (SHA-256 weiterhin `e8a8304ce83f26660d630a6db1f5f4834f27158180142985ec22b2e4687cc827`). `.agents/`, `skills-lock.json`, TD-01 und weitere vorhandene Nutzerdateien wurden erhalten. Kein Deployment, Push oder Commit. TD-03 ist im eingecheckten Releasepfad umgesetzt und lokal nachgewiesen; die Wirksamkeit in der tatsächlichen Produktionsfreigabe bleibt bis zur externen Konfigurationsprüfung offen.

## TD-02 – Endlicher Lebenszyklus abgeschlossener Partien

**Stand:** 12. Oktober 2026 · **Status:** Im vereinbarten Umfang vollständig implementiert und lokal verifiziert. Die früheren TD-01-/TD-03-Abschnitte bleiben als Nachweis ihrer jeweiligen Folgeaufträge erhalten.

### Erneuter Befundnachweis

[TD-02 im historischen Audit](/Users/noahbauditz/Documents/Projects/PixelFleet/docs/tech-debt-audit.md:115) bestand auch nach TD-01 und TD-03: `disconnect` behandelte die Trennung nach Abschluss als Quittierung. Waren beide Teilnehmer schon vorher getrennt, blieb das anschließend durch den Reconnect-Timeout abgeschlossene Match ohne weiteres Ereignis unbegrenzt gespeichert. Es gab keinen Ergebnistimer. Die aktive Mitgliedschaft hatte bereits einen eigenen Index; aktive und abgeschlossene Matchobjekte lagen jedoch weiterhin in derselben Map.

Vor der Anwendungskorrektur wurden **23 neue Regressionstestfälle** mit simulierter Uhr ausgeführt: **23 fehlgeschlagen, sieben bestehende Fälle durch den Filter ausgelassen**. Sie wiesen fehlende Fristabläufe, unbeabsichtigte Quittierung durch Disconnect, fehlenden Ergebnisabruf und fehlende Konfigurationsvalidierung nach. Mit der Korrektur bestehen alle neuen und bisherigen Tests.

```sh
# Gezielter Nachweis; das Shared-Paket wird vorher gebaut.
npm run build -w packages/shared
npx vitest run tests/match-membership.test.ts -t 'finished match retention'

# Vollständige Quellprüfung und vollständiges Docker-Release-Gate.
npm run verify
docker build --no-cache --progress=plain --target runtime -t pixelfleet:checked .
```

Für einen isolierten Containerlauf mit anschließender Entfernung von Image, Container und Volume gelten die ausführbaren Befehle unter [Local container verification](/Users/noahbauditz/Documents/Projects/PixelFleet/docs/dokploy.md:243). Genau dieser Ablauf wurde für TD-02 mit einem eigenen eindeutigen Tag und zusätzlicher Inhaltsprüfung ausgeführt; kein Produktionsvolume wurde verwendet.

### Umsetzung und Konfiguration

| Bereich | Umsetzung und Referenz |
| --- | --- |
| Validierte Frist | [game-hub.ts:31](/Users/noahbauditz/Documents/Projects/PixelFleet/apps/backend/src/game-hub.ts:31): `FINISHED_MATCH_RETENTION_MS`, Einheit **Millisekunden**, Standard und Maximum **600000 = zehn Minuten**, gemessen ab Matchabschluss. Zulässig sind ausschließlich ganzzahlige Dezimalwerte **1–600000**. Nicht gesetzt oder leer verwendet den Standard; ungültige Werte lassen die Hub-Erzeugung und damit den Backendstart scheitern. Der Wert wird bei Hub-Erzeugung gelesen; Änderungen benötigen einen Neustart. |
| Getrennte Aufbewahrung | [game-hub.ts:97](/Users/noahbauditz/Documents/Projects/PixelFleet/apps/backend/src/game-hub.ts:97): `matches` enthält aktive Partien; `activeMatchByUser` ordnet ausschließlich diese zu. `finishedMatches` enthält abgeschlossene Partien mit Ablaufzeit und eigenem Timer. Der Abschluss gibt die beiden aktiven Mitgliedschaften frei und verschiebt das Match in die Ergebnisaufbewahrung. |
| Zeitgesteuerter Ablauf | [game-hub.ts:449](/Users/noahbauditz/Documents/Projects/PixelFleet/apps/backend/src/game-hub.ts:449): Jeder Abschluss startet genau einen Ergebnistimer. Er funktioniert auch, wenn beide Teilnehmer vorher getrennt wurden und keinerlei weitere Aktivität stattfindet. Die bisherigen Reconnecttimer werden beim Abschluss gelöscht; die **30-Sekunden-Schonfrist für aktive Partien bleibt unverändert**. |
| Abruf und Quittierung | [game-hub.ts:145](/Users/noahbauditz/Documents/Projects/PixelFleet/apps/backend/src/game-hub.ts:145): Ohne aktive Partie oder Queue wird beim Verbindungsaufbau das jüngste nicht quittierte, noch gültige Ergebnis als bestehende `match_finished`-Nachricht wiedergegeben. Disconnects quittieren kein Ergebnis. `leave_match` quittiert ohne aktive Partie das jüngste für diesen Account noch nicht quittierte Ergebnis; nach Quittierung beider Teilnehmer wird es früher gelöscht. |
| Sichere Löschung | [game-hub.ts:542](/Users/noahbauditz/Documents/Projects/PixelFleet/apps/backend/src/game-hub.ts:542): Der Abruf verwirft zusätzlich abgelaufene Einträge, falls der Eventloop den Timer noch nicht ausgeliefert hat. Die zentrale idempotente Löschung entfernt Timer und Ergebniseintrag, greift aber weder auf aktive Mitgliedschaften noch auf Datenbankstatistiken oder XP zu. Ein erneuter Abruf verlängert die Frist nicht. |
| Reset und Shutdown | [game-hub.ts:773](/Users/noahbauditz/Documents/Projects/PixelFleet/apps/backend/src/game-hub.ts:773): Runtime-Reset entfernt alle Ergebnis- und Reconnecttimer samt Maps/Referenzen. Der vorhandene Server-Shutdown ruft denselben Reset mit Code 1012 auf; der Serverpfad musste dafür nicht geändert werden. |
| Betriebsverdrahtung | [.env.example:34](/Users/noahbauditz/Documents/Projects/PixelFleet/.env.example:34), [docker-compose.yml:35](/Users/noahbauditz/Documents/Projects/PixelFleet/docker-compose.yml:35) und [dokploy.md:176](/Users/noahbauditz/Documents/Projects/PixelFleet/docs/dokploy.md:176): Standard, Einheit, Bereich und Verhalten sind dokumentiert; Compose übergibt den Runtime-Wert mit Standard 600000. |

Die Ergebnisaufbewahrung enthält weiterhin das bestehende Matchobjekt für die bisherigen Ergebnisansichten. Eine neue Datenbanktabelle, ein externer Cache oder ein neues Nachrichtenformat sind dafür nicht erforderlich. Die bestehenden Statistik-/XP-Buchungen erfolgen weiterhin nur beim Matchabschluss. Ablauf und Quittierung verbuchen nichts erneut und setzen nichts zurück.

### Prüfungen und Ergebnisse

Die Ergänzung in [match-membership.test.ts:251](/Users/noahbauditz/Documents/Projects/PixelFleet/tests/match-membership.test.ts:251) umfasst 23 Fälle mit `vi.useFakeTimers()`; Fristen werden nicht real abgewartet:

- Beidseitige Trennung vor Abschluss: bis 29999 ms bleibt die Partie aktiv, bei 30000 ms entsteht genau ein Ergebnis, und nach der Ergebnisfrist verschwinden Eintrag und letzter Timer ohne weitere Nachrichten oder Verbindungen.
- Einseitiger Abbruch, späterer Ergebnisabruf unmittelbar vor der Frist und fehlende Verfügbarkeit ab Ablauf; der Abruf verlängert die Frist nicht.
- Beidseitiger Disconnect nach Abschluss quittiert das Ergebnis nicht und verhindert den Abruf innerhalb der Frist nicht.
- Regulärer Abschluss durch versenkte Flotte und Abschluss durch Aufgabe: Aufbewahrung beginnt erst beim Abschluss, Bereinigung erfolgt an der Fristgrenze, Profile inklusive XP bleiben danach unverändert.
- Ausdrückliche Quittierung beider Teilnehmer entfernt den Ergebnistimer früher. Quittierung durch einen alten Gegner und ein bereits wartender alter Timer-Callback beeinträchtigen eine neuere Partie desselben Accounts nicht.
- Mehrere Folgepartien: ältere Ergebnisse laufen unabhängig ab, während eine neuere Partie aktiv bleibt und gültige Schüsse weiterhin verarbeitet. Reconnect priorisiert diese aktive Partie. Ohne aktive Partie ist jeweils das jüngste nicht quittierte Ergebnis abrufbar; ältere Einträge behalten ihre eigene Frist.
- Reset und Shutdown-Reset mit Codes 4009/1012: alle eigenen Timer verschwinden, alte Ergebnisse werden nicht erneut ausgegeben und spätere Partien bleiben auch nach den alten Fristen unverändert.
- Bereits abgelaufene Ergebnisse werden auch bei noch nicht ausgeführtem Timer nicht wiedergegeben. Neun ungültige Konfigurationen werden abgewiesen; 1, 1000 und 600000 ms werden an den Grenzzeitpunkten durchgesetzt.

Eine bestehende Timeranzahl in [session-expiry.test.ts:302](/Users/noahbauditz/Documents/Projects/PixelFleet/tests/session-expiry.test.ts:302) wurde von eins auf zwei angepasst: Nach dem forcierten Abschluss existieren jetzt der Sessiontimer des Gegners **und der neue endliche Ergebnistimer**. Die übrigen bestehenden Testassertionen blieben erhalten.

| Verifikation | Ergebnis |
| --- | --- |
| `npm run verify` am korrigierten Stand | **152/152 Tests** in neun Dateien, Root-Typecheck und Produktionsbuild bestanden. Match-Membership enthält jetzt 30 statt sieben Tests. |
| Vollständiger Dockerbuild ohne Cache | Node 24, beide `npm ci`-Installationen, **152/152 Tests**, Typecheck, Produktionsbuild und verpflichtende TD-03-Runtime-Prüfung bestanden. |
| Runtime-Prüfung im Build | Healthcheck vor/nach vollständigem bestehenden Match-Smoke und Backend-Shutdown mit **Exitcode 0** bestanden; temporäre SQLite-Fixture, kein externes Netzwerk. |
| Finaler Container | Node **24.21.0**, UID **1000**, eigenes neues Volume, Netzwerk `none`, read-only Root-Dateisystem, entfernte Capabilities, `no-new-privileges`. Docker-Healthstatus **healthy**, expliziter Healthcheck und zusätzlicher vollständiger Match-Smoke mit beiden Ergebnissen (350/465 XP) bestanden; Shutdown **Exitcode 0**. |
| Inhalt und Bereinigung | Im Runtime-Image keine Testdateien oder Smoke-/Prüfscripte; Projekt-Runtime-Dependencies weiterhin nur `@pixelfleet` und `ws`. Eigener Testcontainer, eigenes Volume und Image-Tag wurden entfernt; nachträgliche Docker-Inventur bestätigte deren Fehlen. |
| Diff und Bestand | `git diff --check` bestanden. TD-01-Fehlerbehandlung und TD-03-Gate erhalten. Dockerfile, `.dockerignore`, `package.json`, `scripts/verify-runtime.mjs`, Backend-Server, Deploymenttests, Lockfile und historische Auditdatei sind gegenüber Beginn dieses Auftrags unverändert. |

### Schnittstelle zu TD-06 und verbleibende Grenzen

Die beschränkte Ergebniswiedergabe beim Verbindungsaufbau erfüllt die hier erforderliche Abrufbarkeit. Sie liefert **keinen vollständigen Reconnect-Snapshot**. TD-06 muss weiterhin den expliziten Zustand „keine aktive Partie/kein Ergebnis“, abgebrochene Queuezustände und den Zustand nach Neustart mit dem Frontend abgleichen. Eine bestehende Ergebnisanzeige im Browser wird bei serverseitigem Fristablauf nicht aktiv gelöscht; hierfür wurde kein neues Protokoll eingeführt.

`leave_match` besitzt weiterhin keine Match-ID und priorisiert eine aktive Partie. Während einer neuen Partie gibt es somit keinen separaten Abruf-/Quittierungsbefehl für ein älteres Ergebnis. Ohne aktive Partie/Queue wird nur ein Ergebnis pro Verbindungsaufbau wiedergegeben, das jüngste nicht quittierte; ältere bleiben unabhängig bis zur jeweiligen Frist oder beidseitigen Quittierung gespeichert. Eine explizite Ergebnis-Historie oder korrelierte Quittierung kann TD-06 bei Bedarf definieren. Ergebnisprofile und Brettansichten beschreiben die alte Partie; der aktuelle Profilstand wird weiterhin separat als `profile` übertragen.

Timer benötigen wie alle Node-Timer einen ausführbaren Eventloop. Fällige Einträge werden bei der nächsten Timerverarbeitung gelöscht; ein Abruf prüft zusätzlich die absolute Ablaufzeit. Die Aufbewahrungsfrist begrenzt die Lebensdauer, nicht die Anzahl gleichzeitig innerhalb dieser Frist abgeschlossener Partien. Last-/Dauerbetrieb, Browser, produktiver Proxy und tatsächliche Dokploy-Einstellungen wurden hier nicht geprüft. Die extern offenen TD-03-Einstellungen bleiben offen.

TD-06, allgemeine Limiterbereinigung und die atomare Ergebnispersistenz aus TD-05 bleiben außerhalb dieses Auftrags. Es wurden keine Spielregeln oder Datenbankschemata verändert. Der historische Auditbericht bleibt bytegleich mit SHA-256 `e8a8304ce83f26660d630a6db1f5f4834f27158180142985ec22b2e4687cc827`; vorhandene unversionierte Nutzerdateien bleiben erhalten. Kein Deployment, Push oder Commit.

## TD-04 – Abgelaufene Quoten und endliches Fehlerfenster

**Stand:** 12. Oktober 2026 · **Status:** Im vereinbarten Umfang vollständig implementiert und lokal verifiziert. Die vorstehenden Abschnitte dokumentieren die früheren Aufträge und deren damalige Grenzen.

### Erneuter Befund und Fehlernachweis

[TD-04 im historischen Audit](/Users/noahbauditz/Documents/Projects/PixelFleet/docs/tech-debt-audit.md:139) bestand am aktuellen Stand weiterhin: Die vorhandene Methode `prune()` wurde im Backend nicht aufgerufen. Abgelaufene Schlüssel verschwanden nur bei erneuter Nutzung desselben Schlüssels oder bei einem administrativen Hub-Reset. `invalidActionCounts` zählte dauerhaft pro Account ohne Erholung nach Zeitablauf. Disconnect und Socketersatz ließen diese Zustände bereits bestehen; dieses notwendige Verhalten bleibt erhalten.

Vor der Anwendungskorrektur ergaben die neuen gezielten Unit-/Hub-Tests **fünf Fehlschläge und vier bestandene Fälle**. Zwei Fehlschläge zeigten den permanenten Fehlerzähler nach 60 Sekunden bzw. nach Reconnect; drei zeigten die fehlende periodische Bereinigungsschnittstelle. Die vier bereits erfolgreichen Fälle sichern vorhandene Quoten über Reconnect/Socketersatz sowie sofortige Ablehnung übergroßer Nachrichten ab. Der neue Backend-Unterprozesstest scheiterte zunächst zusätzlich am fehlenden Fehlerfenster.

Um den Speicherfehler unabhängig von einer fehlenden neuen Schnittstelle zu belegen, wurde der aktuelle Integrationstest anschließend in einer isolierten Kopie mit dem bytegleich rekonstruierten Anwendungscode vom Beginn dieses Auftrags ausgeführt. Die reine Timeranzahl-Assertion wurde nur für diese Ausgangsprobe ausgelassen: Nach **30 simulierten Sekunden ohne weitere Anfragen** enthielten die tatsächlichen 10-Sekunden-Limiter weiterhin die zuvor angelegten 1000 Schlüssel; die Erwartung leerer Buckets schlug fehl. Dieser Test erreichte also den konkreten Ablaufbefund. Die temporäre Kopie wurde entfernt; der Arbeitsstand mit TD-01/TD-02/TD-03 wurde nicht zurückgesetzt. Mit der Korrektur bestehen alle zehn neuen Testfälle.

### Umsetzung und Lebenszyklus

| Änderung | Wirkung und Referenz |
| --- | --- |
| Ein gemeinsamer Bereinigungstimer | [rate-limit.ts:13](/Users/noahbauditz/Documents/Projects/PixelFleet/apps/backend/src/rate-limit.ts:13): Ein `unref()`-Intervall läuft alle **30000 ms = 30 Sekunden** und liefert eine gemeinsame aktuelle Uhrzeit an die Bereinigung. Seine Stopfunktion kann mehrfach aufgerufen werden. Es gibt keinen zusätzlichen Timer pro Schlüssel. |
| Alle HTTP-/Upgrade- und Hub-Limiter | [server.ts:63](/Users/noahbauditz/Documents/Projects/PixelFleet/apps/backend/src/server.ts:63) ruft `prune(now)` für Public-, Login-, Admin- und WebSocket-Verbindungslimiter auf sowie [GameHub.pruneRateLimits:773](/Users/noahbauditz/Documents/Projects/PixelFleet/apps/backend/src/game-hub.ts:773) für Nachrichten, Queue, Schüsse und Fehlerbudget. Keine weitere Anfrage oder Verbindung ist nötig. |
| Gültige Quoten bleiben erhalten | [rate-limit.ts:57](/Users/noahbauditz/Documents/Projects/PixelFleet/apps/backend/src/rate-limit.ts:57): Der bestehende Pruner entfernt ausschließlich `resetAt <= now`. Der bestehende Prüfalgorithmus, Kosten, Quoten, Zeitfenster und Ablehnungsantworten bleiben unverändert. Disconnect, Reconnect und Socketersatz löschen keine Buckets. |
| Endliches Fehlerbudget | [game-hub.ts:117](/Users/noahbauditz/Documents/Projects/PixelFleet/apps/backend/src/game-hub.ts:117) verwendet denselben Fixed-Window-Limiter mit sieben erlaubten Fehlern und **60000 ms = 60 Sekunden** pro Account. Die erste ungültige Aktion beginnt das Fenster; [rejectAction:698](/Users/noahbauditz/Documents/Projects/PixelFleet/apps/backend/src/game-hub.ts:698) schließt bei der achten mit dem bisherigen Code **4008** und Grund. Weitere Fehler erneuern die Deadline nicht. An der exakten Deadline beginnt die nächste ungültige Aktion ein neues Fenster, auch wenn der Pruner noch nicht gelaufen ist. |
| Bestehende sofortige Trennung | Das bestehende `closeConnection`-Flag bleibt unabhängig vom Budget wirksam: Überschreitung des Anwendungspayloadlimits und der Nachrichtenquote schließen weiterhin bereits bei der ersten entsprechenden Ablehnung. Veraltete Sockets werden weiterhin vor jeder Fehlerverbuchung ausgeschlossen. |
| Reset und Shutdown | [resetRuntime:801](/Users/noahbauditz/Documents/Projects/PixelFleet/apps/backend/src/game-hub.ts:801) leert das Fehlerbudget gemeinsam mit den bisherigen Hubquoten. Der Server besitzt den Timer; ein administrativer Reset beendet oder dupliziert ihn nicht und setzt HTTP-/Upgradequoten weiterhin nicht zurück. [server.ts:376](/Users/noahbauditz/Documents/Projects/PixelFleet/apps/backend/src/server.ts:376) und [shutdown:480](/Users/noahbauditz/Documents/Projects/PixelFleet/apps/backend/src/server.ts:480) stoppen ihn bei Server-Close und beim Beginn des Shutdowns. |

Die vorhandenen Standardquoten bleiben unverändert; bestehende Umgebungsüberschreibungen der Mengen gelten weiterhin:

| Limiter | Standardmenge | Festes Fenster |
| --- | ---: | ---: |
| Öffentliche HTTP-Anfragen je IP | 240 | 60 Sekunden |
| Gastanmeldungen je IP | 12 | 3600 Sekunden |
| Adminanfragen je IP | 60 | 60 Sekunden |
| WebSocket-Verbindungsversuche je IP | 30 | 60 Sekunden |
| Hubnachrichten je Account | 120 | 10 Sekunden |
| Queueaktionen je Account | 12 | 60 Sekunden |
| Schussaktionen je Account | 120 | 10 Sekunden |
| Ungültige Aktionen je Account | Erste sieben ohne budgetbedingte Trennung; achte schließt | 60 Sekunden ab erstem Fehler |

Bereinigungsintervall und Fehlerfenster/-schwelle sind feste Werte; es wurden keine neuen Konfigurationsoptionen oder Infrastrukturabhängigkeiten eingeführt. Die [Deployment-Anleitung](/Users/noahbauditz/Documents/Projects/PixelFleet/docs/dokploy.md:175) dokumentiert diese Regeln und die Timerverantwortung.

### Regressionstests und vollständige Verifikation

```sh
npm run build -w packages/shared
npx vitest run tests/rate-limit.test.ts tests/session-authorization.test.ts \
  tests/deployment.test.ts -t 'TD-04'
npm run verify
docker build --no-cache --progress=plain --target runtime -t pixelfleet:checked .
```

Der isolierte Containerlauf mit zuverlässiger Entfernung eigener Ressourcen folgt den ausführbaren Befehlen unter [Local container verification](/Users/noahbauditz/Documents/Projects/PixelFleet/docs/dokploy.md:260). Für diesen Auftrag wurde ein eindeutiger eigener Tag verwendet; der Lauf ergänzte eine Inhaltsprüfung des Images.

- [rate-limit.test.ts:25](/Users/noahbauditz/Documents/Projects/PixelFleet/tests/rate-limit.test.ts:25) prüft 1000 unterschiedliche Schlüssel, Ablauf ohne Folgeaktivität, Erhalt später begonnener gültiger Quoten, exakte Grenzen, einen gemeinsamen Timer und dessen idempotenten Stopp.
- [session-authorization.test.ts:321](/Users/noahbauditz/Documents/Projects/PixelFleet/tests/session-authorization.test.ts:321) prüft Fensterbeginn erst beim ersten Fehler, siebten/achten Fehler, Erholung exakt nach 60 Sekunden, unabhängige Accounts, nicht verlängernde spätere Fehler, Disconnect/Reconnect/Socketersatz und verspätete Aktionen alter Sockets. Nachrichten-, Queue- und Schussquoten bleiben verbindungsübergreifend erhalten. 1000 Schlüssel in jedem Hub-Limiter werden ohne Folgeaktivität bereinigt, gültige bleiben bestehen; wiederholter Reset und weitere Nutzung funktionieren ohne zusätzliche Timer.
- [deployment.test.ts:166](/Users/noahbauditz/Documents/Projects/PixelFleet/tests/deployment.test.ts:166) startet einen isolierten Backend-Unterprozess mit eigener SQLite-Fixture und echten lokalen HTTP-/WebSocket-Verbindungen. Nach Auslösung sämtlicher Limiter werden jeweils 1000 unterschiedliche synthetische Schlüssel in deren tatsächlichen Instanzen angelegt. Simulierte Zeit weist Bereinigung nach 30 Sekunden, Schutz jüngerer Schlüssel nach 60 Sekunden und Ablauf auch des einstündigen Loginfensters nach. Ein echter Admin-Reset mit anschließender Verbindung und Fehler erzeugt weiterhin genau einen Bereinigungstimer neben dem bisherigen Heartbeat. Beim Shutdown verbleiben **null Intervalle**, der Prozess beendet sich mit **Exitcode 0**. Beobachtung privater Buckets und Uhrsteuerung existieren ausschließlich im temporären Test-Einstiegspunkt.

Alle Ablaufprüfungen verwenden simulierte Uhren statt echter Wartezeiten. Netzwerk-/Prozessbereitschaft und der bestehende vollständige Match-Smoke verwenden wie zuvor echte lokale Dienste.

| Prüfung | Ergebnis |
| --- | --- |
| Gezielte neue Fälle mit Korrektur | **10/10 bestanden**, 41 bestehende Fälle durch Filter ausgelassen. |
| `npm run verify`, lokal Node 24.20.0 | **162/162 Tests in neun Dateien**, vollständiger Typecheck und Produktionsbuild bestanden. TD-01-Protokolltests und TD-02-Match-Membership-Tests laufen unverändert mit. |
| Vollständiger Docker-Releasepfad ohne Cache | Node 24, beide reproduzierbaren `npm ci`-Installationen, **162/162 Tests**, Typecheck und Produktionsbuild bestanden. Das unveränderte TD-03-Gate führt vor dem finalen Imageexport Runtime-Healthchecks, vollständigen Match-Smoke und regulären Shutdown erfolgreich aus. |
| Frisches finales Runtime-Image | Node **24.21.0**, UID **1000**, eigene neue Volume, Netzwerk `none`, read-only Root-Dateisystem, entfernte Capabilities, `no-new-privileges`. Docker-Healthstatus **healthy**, expliziter Healthcheck und zusätzlicher vollständiger Match-Smoke mit beiden Ergebnissen und 350/465 XP bestanden. Shutdown **Exitcode 0**. |
| Imageinhalt und Ressourcen | Keine Tests, Smoke-/Prüfscripte oder Erfolgsmarker im finalen Dateisystem. Runtime-Dependencies weiterhin nur `@pixelfleet` und `ws`. Eigener Container, eigenes Volume und Image-Tag entfernt; anschließende Docker-Inventur bestätigte deren Fehlen. |
| Diff und Bestand | `git diff --check` bestanden. Zusätzliche Änderungen beschränken sich auf drei Backenddateien, drei Testdateien und zwei Dokumentationsdateien. Dockerfile, Compose, Paket-/Lockfiles, TD-03-Prüfscript sowie übrige vorhandene Dateien wurden gegenüber Auftragsbeginn nicht verändert. Der historische Auditbericht bleibt bytegleich. |

### Grenzen und erhaltener Bestand

Die regelmäßige Bereinigung begrenzt die **Aufbewahrungsdauer**, nicht die **Anzahl gleichzeitig gültiger Schlüssel**. Unter einem laufenden Eventloop verbleibt ein inaktiver Eintrag höchstens sein Fenster plus ein Bereinigungsintervall; das Loginfenster bleibt entsprechend bis zu einer Stunde plus 30 Sekunden erhalten. Ein blockierter Eventloop kann Timer verzögern. Die Sweep-Methode ist linear in der Anzahl gespeicherter Buckets. Für extrem viele gleichzeitig aktive Schlüssel gibt es keine neue Speicherobergrenze oder vorzeitige Verdrängung gültiger Quoten; dafür wäre eine eigene Kapazitäts-/Betriebsentscheidung erforderlich. Es wurde kein OOM-, Last- oder Dauerbetriebsnachweis durchgeführt.

`GameHub` besitzt bewusst keinen eigenen Wartungstimer. Der eingecheckte Backendserver übernimmt die regelmäßige Bereinigung; andere spätere Einbettungen müssen `pruneRateLimits(now)` ebenfalls regelmäßig aufrufen. Ein administrativer Reset darf wie bisher Hubquoten ausdrücklich zurücksetzen; normale Verbindungswechsel tun das nicht.

TD-01-Fehlerbehandlung, TD-02-Ergebnis-/Reconnecttimer und TD-03-Releasegate bleiben erhalten. Keine Spielregeln, Datenbankschemata, Ergebnisverbuchung oder Reconnect-Snapshots wurden verändert; TD-05/TD-06 bleiben außerhalb dieses Auftrags. Die extern offenen Dokploy-/Repository-Einstellungen aus TD-03 wurden nicht verändert oder produktiv verifiziert; eine aktive Produktionssperre wird weiterhin nicht behauptet.

Vorhandene Nutzeränderungen und unversionierte Dateien wurden erhalten. SHA-256 des historischen Auditberichts weiterhin `e8a8304ce83f26660d630a6db1f5f4834f27158180142985ec22b2e4687cc827`. Eigene temporäre Testressourcen wurden entfernt. Kein Deployment, Push oder Commit. **TD-04 ist im vereinbarten Umfang vollständig behoben.**

## TD-05 – Atomare Abschlüsse und dauerhafter Doppelbuchungsschutz

**Stand:** 12. Oktober 2026 · **Status:** Im vereinbarten Umfang vollständig implementiert und lokal verifiziert. Frühere Abschnitte dokumentieren weiterhin den jeweiligen damaligen Auftragsstand.

### Befundprüfung und Nachweis vor der Korrektur

[TD-05 im historischen Audit](/Users/noahbauditz/Documents/Projects/PixelFleet/docs/tech-debt-audit.md:151) bestand trotz TD-01 bis TD-04 weiterhin: Der Hub markierte Matches vor der Persistenz als abgeschlossen und startete bereits die Ergebnisaufbewahrung. Beide Spielerupdates und Account-/Sessionanlage waren jeweils getrennte autocommit-Statements. Die Timeout-Abschlüsse hatten keinen Schutz gegen Persistenzexceptions.

Vor der Anwendungskorrektur wurden drei neue Regressionstests gegen diesen Arbeitsstand ausgeführt. **Alle drei schlugen fehl:**

| Probe | Beobachtung am Ausgangscode |
| --- | --- |
| `BEFORE UPDATE OF games_played`-Trigger mit `RAISE(ABORT, ...)`, sobald das erste Spielerupdate erfolgt ist | Nach Aufgabe: `gamesPlayed` **[0, 1]** statt [0, 0]. Das erste Update war bereits dauerhaft verbucht. |
| Derselbe Fehler während des Disconnect-Timeouts | `advanceTimersByTime(30000)` warf **`injected second update failure`** aus dem Timer-Callback. |
| `BEFORE INSERT ON sessions`-Trigger mit `RAISE(ABORT, ...)` | Sessionanlage schlug fehl, aber **ein Account und null Sessions** blieben bestehen. |

Die Fehlerproben verwenden ausschließlich isolierte SQLite-Fixtures und simulierte Zeit. Sie bleiben als Regressionstests erhalten und bestehen nach der Korrektur. Die weiteren Tests ergänzen die neuen Verträge für Migration, Wiederholung, Fehlerzustand und administrative Resets; für diese wird kein eigener Vorher-Fehlschlag behauptet.

### Persistenz und Migration

| Bereich | Umsetzung |
| --- | --- |
| Eine Operation für das ganze Match | [db.ts:253](/Users/noahbauditz/Documents/Projects/PixelFleet/apps/backend/src/db.ts:253): `completeMatch` validiert zwei unterschiedliche Teilnehmer, Sieger, Grund und nichtnegative ganzzahlige Zähler. Ein `BEGIN IMMEDIATE` umfasst Nachweis, beide Statistik-/XP-Updates und das Lesen ihrer Profile; Rückgabe erst nach `COMMIT`. Ein Fehler rollt alle Änderungen zurück. Das frühere einzelne Spielerupdate ist nur noch ein privater Helfer. |
| Eindeutiger dauerhafter Nachweis | [migrations.ts:46](/Users/noahbauditz/Documents/Projects/PixelFleet/apps/backend/src/migrations.ts:46): `match_completions.match_id` ist ein nicht-nullbarer Primärschlüssel. Gespeichert werden eine kanonische Entscheidung mit beiden Account-IDs, Sieger, Grund und Schuss-/Treffer-/Versenkungszählern, die beiden vergebenen XP-Beträge und ein Zeitstempel der Abschlussoperation. Teilnehmerreihenfolge ist für den Vergleich unerheblich. |
| Wiederholung und Konflikt | Dieselbe Entscheidung liefert `applied: false`, die ursprünglich vergebenen XP-Beträge und aktuelle Profile, ohne weitere Updates. Andere Entscheidung zur selben ID wirft `MatchCompletionConflict`. Nach Statistikreset werden keine historischen Gesamtwerte zurückgeschrieben; gelöschte Accounts ergeben `profile: null` und werden nicht wiederhergestellt. |
| Gemeinsame Account-/Sessionanlage | [db.ts:124](/Users/noahbauditz/Documents/Projects/PixelFleet/apps/backend/src/db.ts:124): Accountinsert, Sessioninsert und Profilprüfung verwenden dieselbe Transaktionshilfe. Bei einem Sessionfehler bleibt kein verwaister Account. |
| Versionierte Migration | [migrations.ts:18](/Users/noahbauditz/Documents/Projects/PixelFleet/apps/backend/src/migrations.ts:18): Version 0 umfasst Neuinstallation und bisherige unversionierte Datenbanken. Tabellenanlage, Prüfung erwarteter Altbestandsspalten und `PRAGMA user_version = 1` erfolgen gemeinsam in einer Transaktion. Bestehende Datensätze werden nicht umgeschrieben. Version 1 ist beim Neustart ein No-op; neuere Versionen stoppen den Start vor Schema-/Journaländerungen. |
| Fehler beim Start | [db.ts:51](/Users/noahbauditz/Documents/Projects/PixelFleet/apps/backend/src/db.ts:51) schließt die Verbindung und bricht den Start ab, wenn Migration oder Datenbankinitialisierung scheitern. Nach Behebung eines Migrationsfehlers ist ein erneuter Versuch möglich. Die Transaktionshilfe berücksichtigt auch SQLite-Fehler, die selbst schon einen Rollback ausgelöst haben. |

### Konsistenter Abschlusszustand und begrenzte Wiederholung

[finishMatch:467](/Users/noahbauditz/Documents/Projects/PixelFleet/apps/backend/src/game-hub.ts:467) hält die erste Abschlussentscheidung inklusive aktueller Spielerzähler fest und setzt den Zug auf `null`. Ein bereits ausgeführter letzter Schuss wird nicht zurückgenommen oder erneut gespielt. Reconnecttimer und ihre Deadlines werden gelöscht; Disconnect und spätere bereits wartende Timeoutcallbacks können die Entscheidung nicht verändern. Die aktive Mitgliedschaft bleibt bis zum Commit oder administrativen Reset gesperrt.

[persistCompletion:494](/Users/noahbauditz/Documents/Projects/PixelFleet/apps/backend/src/game-hub.ts:494) macht **höchstens drei Versuche insgesamt**, mit **1000 ms Abstand** nach einem fehlgeschlagenen Versuch. Jede SQLite-Exception wird lokal abgefangen und als Fehlerereignis mit Match-ID und Versuchsnummer erfasst. Ein Konflikt mit einem bestehenden Nachweis beendet Versuche sofort. Nach dem letzten Fehlschlag bleibt die Partie ohne Wiederholungstimer gesperrt; der Client erhält eine Fehlermeldung mit Hinweis auf den Administrator. Es gibt keine endlose Schleife oder durch Clientaktionen neu beginnende Retry-Serie.

[handleMessage:285](/Users/noahbauditz/Documents/Projects/PixelFleet/apps/backend/src/game-hub.ts:285) lässt währenddessen keine normalen Spiel-/Queueaktionen durch; insbesondere kann eine weitere Aufgabe nicht den Sieger wechseln. Solche Aktionen sowie Speicherfehler selbst erhöhen nicht den Invalid-Action-Zähler. Die bestehenden Transport-/Nachrichtenquoten bleiben wirksam. Reconnect zeigt den blockierten Zustand und startet keinen neuen Abschlussversuch. Das vorhandene Protokoll bleibt erhalten: die vorherige `placing`-/`playing`-Phase mit gestopptem Zug und klarer Meldung, ohne Ergebnis oder vorzeitige Sieges-/Niederlagenmeldung.

Erst nach erfolgreichem Commit werden beide Ergebnisse im Speicher gesetzt, die aktive Zuordnung entfernt, aktualisierte Profile und `match_finished` versendet sowie `matches_finished_total` erhöht. Dann beginnt die TD-02-Aufbewahrung; die **zehn Minuten Standard-/Maximalfrist gelten ab erfolgreichem Commit**. Quittierung und Ablauf entfernen nur den RAM-Zustand, niemals den SQLite-Nachweis.

[resetRuntime:828](/Users/noahbauditz/Documents/Projects/PixelFleet/apps/backend/src/game-hub.ts:828) entfernt auch neue Wiederholungstimer und Abschlussreferenzen. Ein bereits wartender Callback prüft die Matchidentität und kann nach Reset keine alte Partie verbuchen oder eine neue verändern. Der vorhandene Shutdown ruft diesen Pfad mit Code 1012 auf; die 30-Sekunden-Reconnectfrist für noch nicht entschiedene Partien bleibt unverändert.

### Administrative Resets und Aufbewahrung

[server.ts:190](/Users/noahbauditz/Documents/Projects/PixelFleet/apps/backend/src/server.ts:190) leert nun **auch vor `stats` den gesamten Runtimezustand**: Sockets, aktive/pending Matches, aufbewahrte Ergebnisse und Timer. Accounts und Sessions bleiben beim Statistikreset erhalten. Das verhindert eine nachträgliche Verbuchung wartender Abschlüsse nach dem Zurücksetzen und die erneute Ausgabe alter Ergebnisprofile. Andere Datenbankreset-Scopes behielten diesen Runtime-Reset bereits bei. Schlägt der anschließende Datenbankreset fehl, bleibt der Runtimezustand trotzdem gelöscht; eine gemeinsame Transaktion zwischen RAM und SQLite wird nicht behauptet. Der CLI-Hilfetext wurde entsprechend angepasst.

Alle Reset-Scopes erhalten `match_completions`, einschließlich `accounts` und `all`. Die Tabelle besitzt bewusst keine kaskadierende Referenz auf `users`. Sonst würde das Löschen eines Accounts zugleich den Doppelbuchungsschutz entfernen. Ein bereits verbuchter Abschluss nach Statistikreset lässt die Nullwerte unverändert; nach Accountlöschung werden keine Nutzer oder Belohnungen neu erzeugt.

Die Tabelle wächst um **eine Zeile je erfolgreich abgeschlossenem Match**, dauerhaft und ohne automatische Bereinigung. Sie enthält keine Bretter, Benutzernamen oder Sessiontokens, aber weiterhin accountbezogene UUIDs. Die endliche RAM-Ergebnisaufbewahrung ist davon unabhängig. Speicher-/Backupkapazität und die Aufbewahrungsregeln dieser Daten müssen betrieblich berücksichtigt werden; eine spätere Komprimierung/Löschung braucht einen gleichwertigen dauerhaften Schutz vor Wiederholung und Konflikten. Für alte, vor dieser Migration verbuchte Statistiken können mangels historischer Match-IDs keine Nachweise rekonstruiert werden.

### Verifikation

```sh
npm run build -w packages/shared
npx vitest run tests/match-persistence.test.ts tests/migrations.test.ts \
  tests/deployment.test.ts -t 'TD-05'
npm run verify
docker build --no-cache --progress=plain --target runtime -t pixelfleet:checked .
```

Der zusätzliche Containerlauf folgte [Local container verification](/Users/noahbauditz/Documents/Projects/PixelFleet/docs/dokploy.md:364), mit eindeutigem eigenem Tag, Volume und Cleanup-Trap. Er prüfte zusätzlich Schema-Version und Nachweisanzahl sowie den Runtime-Dateiinhalt.

| Tests/Prüfung | Nachgewiesen |
| --- | --- |
| [match-persistence.test.ts:105](/Users/noahbauditz/Documents/Projects/PixelFleet/tests/match-persistence.test.ts:105), insgesamt 22 Fälle | Vollständiger Rollback bei zweitem Spielerupdate, SQLite-eigenem `RAISE(ROLLBACK, ...)`, fehlendem Teilnehmer und Sessionanlage. Erfolgreicher erneuter Versuch, gleiche ID auch nach neuem Öffnen der Datenbank, unveränderte Belohnung bei vertauschter Teilnehmerreihenfolge, vier Arten widersprüchlicher Wiederholung, alle persistenten Reset-Scopes. |
| [Abschlusslebenszyklus:217](/Users/noahbauditz/Documents/Projects/PixelFleet/tests/match-persistence.test.ts:217) | Speicherfehler beim letzten regulären Schuss, bei Aufgabe sowie nach ein-/beidseitigem Disconnect. Keine vorzeitigen Profile/Ergebnisse/Metriken, kein weiterer Schuss/Siegerwechsel, Reconnect bei wartendem Abschluss, genau einmalige Veröffentlichung, Frist ab Commit, Quittierung/Ablauf ohne Verlust des Nachweises. Harte Konflikte ohne Retry; drei erfolglose Versuche mit anschließendem Stillstand. Reset/Shutdown einschließlich bereits wartendem altem Callback und nachfolgender neuer Partie. |
| [migrations.test.ts:52](/Users/noahbauditz/Documents/Projects/PixelFleet/tests/migrations.test.ts:52), sechs Fälle | Leere Datenbank, synthetischer Altbestand mit Accounts/Sessions/allen Statistikfeldern/XP, erneuter Start, absichtlicher DDL-Fehler bei Neuinstallation und Altbestand samt anschließendem Wiederholungsversuch, inkompatible Altspalten und unbekannte neuere Version. Fehlgeschlagene Migration hinterlässt Schema und Version unverändert. |
| [deployment.test.ts:166](/Users/noahbauditz/Documents/Projects/PixelFleet/tests/deployment.test.ts:166), zwei zusätzliche Fälle | Echte lokale Admin-Endpunkte `stats` und `accounts` bei gleichzeitig aufbewahrtem Ergebnis und fehlgeschlagenem weiterem Abschluss. Reset trennt Sockets, entfernt Runtimezustand, erhält alte Nachweise und verhindert spätere alte Verbuchung. Neue Partie kann danach genau einmal abschließen. Backend-Unterprozesse und SQLite-Fixtures sind isoliert; Node-Timer und Zeit sind simuliert. |
| Anpassung eines bestehenden Testfixtures | [session-expiry.test.ts:72](/Users/noahbauditz/Documents/Projects/PixelFleet/tests/session-expiry.test.ts:72) legt den bisherigen Profilstand direkt per Fixture-SQL an, da einzelne Spielerupdates nicht mehr öffentlich angeboten werden. XP werden mit derselben bestehenden Formel berechnet. Die bisherigen Testassertionen blieben unverändert. |
| `npm run verify`, lokal Node **24.20.0** | **192/192 Tests in elf Dateien**, Typecheck und Produktionsbuild bestanden. Alle TD-01-/TD-02-/TD-04-Regressionen laufen mit. |
| Docker-Releasepfad ohne Cache | Beide `npm ci`-Installationen unter Node 24, **192/192 Tests**, Typecheck, Build und verpflichtender TD-03-Runtime-Gate bestanden. Healthcheck, vollständiger Match-Smoke mit beiden Ergebnissen (350/465 XP), erneuter Healthcheck und Shutdown **Exitcode 0**. |
| Frisches finales Image als Container | Node **24.21.0**, UID **1000**, eigene neue Volume, Netzwerk `none`, read-only Root-Dateisystem, entfernte Capabilities und `no-new-privileges`. Docker-Healthstatus **healthy**, expliziter Healthcheck, vollständiger zusätzlicher Match-Smoke und Shutdown **Exitcode 0**. Danach **Schema 1 und genau ein Nachweis** in der neuen Datenbank. |
| Runtime-Inhalt | Projekt-Runtime-Dependencies ausschließlich `@pixelfleet` und `ws`; keine Tests, Smoke-/Runtime-Prüfscripte oder Erfolgsmarker im finalen Dateisystem. |
| Bestand, Diff und Bereinigung | Zusätzliche Änderungen auf TD-05-Persistenz, Hub-/Resetintegration, CLI-Hilfe und notwendige Tests/Dokumentation begrenzt; `git diff --check` bestanden. TD-01 bis TD-04 erhalten, Releasekonfiguration und Lockfile unverändert. Eigene lokale Prozesse, Datenbank-Fixtures, temporäre Volume, Container, Image-Tag und Prüfcontroller entfernt. |

### Deployment und verbleibende Grenzen

Die [Deployment-Anleitung](/Users/noahbauditz/Documents/Projects/PixelFleet/docs/dokploy.md:153) enthält die konkrete Reihenfolge für Stop, konsistentes vollständiges Backup, Restoreprobe mit separatem Volume, Migration und Prüfung bestehender Accounts/Sessions. Ein Read-only-Befehl prüft die neue Schema-Version und Nachweisanzahl. **Diese Produktionsschritte wurden nicht ausgeführt**; lokal wurden nur synthetische Bestandsdaten migriert. Die extern offenen TD-03-Dokploy-/Repository-Einstellungen bleiben weiterhin extern zu prüfen.

Älterer Anwendungscode kennt weder Schemaguard noch Abschlussnachweise und darf nicht einfach gegen das migrierte Volume zurückgerollt werden. Die additive Tabelle allein macht den alten Schreibpfad nicht sicher. Ein Rückgang auf vor-TD-05-Code verlangt einen gestoppten Dienst, Sicherung des aktuellen vollständigen Bestands und Restore des passenden vorherigen Backups; dabei gehen spätere Fortschritte verloren und die alten Defekte kehren zurück. Eine Vorwärtskorrektur ist vorzuziehen. Es gibt keine Down-Migration oder sichere selektive Löschung von Nachweisen; Kontostände und Nachweise müssen aus demselben konsistenten Snapshot stammen.

Ein dauerhaft fehlgeschlagener Abschluss bleibt absichtlich gesperrt im RAM, bis ein administrativer Reset oder Shutdown ihn entfernt. Nach Behebung der Speicherursache kann der bestehende Runtime-Reset benutzt werden; dieser betrifft alle laufenden Partien und verwirft den nicht gespeicherten Abschluss ohne Belohnung. Die Fehlerhistorie ist die vorhandene begrenzte In-Memory-Metrikliste, kein dauerhaftes Fehlerjournal. Es wurde keine Wiederherstellung laufender/pending Partien oder Ergebnisansichten nach Prozessneustart eingeführt. Ein bereits erfolgreicher Commit bleibt dennoch dauerhaft vor Doppelbelohnung geschützt, auch wenn vor der Ergebnisnachricht der Prozess endet.

Die Tests injizieren deterministische SQLite-Fehler und prüfen Transaktionszustände; sie simulieren weder Stromausfall/defekte Datenträger noch Produktionslast. Der Betrieb bleibt auf eine Backendinstanz beschränkt. TD-06-Reconnect-Snapshot und TD-07-HTTP-Fehlerüberarbeitung sind unverändert außerhalb des Auftrags; Spielregeln und XP-Formel wurden nicht geändert.

Der historische Auditbericht bleibt bytegleich mit SHA-256 `e8a8304ce83f26660d630a6db1f5f4834f27158180142985ec22b2e4687cc827`. Vorhandene Nutzeränderungen sowie unversionierte Dateien wurden erhalten. Kein Deployment, Push oder Commit. **TD-05 ist im vereinbarten Umfang vollständig behoben.**

## TD-07 – Erwartete HTTP-Eingabefehler und interne Fehler

**Stand:** 12. Oktober 2026 · **Status:** im vereinbarten Umfang vollständig implementiert und lokal verifiziert. Kein Deployment, Push oder Commit.

### Ausgangsstand erneut geprüft

Der [historische TD-07-Befund](/Users/noahbauditz/Documents/Projects/PixelFleet/docs/tech-debt-audit.md:175) bestand auch mit TD-01 bis TD-05: Der HTTP-Catch antwortete für jede Exception mit 400 und deren unverändertem `message`. Vorbereitung lag vor dem Catch, statische ReadStreams wurden ohne abgewarteten Fehlerpfad angehängt. JSON wurde ohne Prüfung der Objektstruktur oder Feldtypen als typisiert angenommen.

**Nachweis vor der Anwendungskorrektur:** Der neue [Speicherfehler-Regressionsfall](/Users/noahbauditz/Documents/Projects/PixelFleet/tests/deployment.test.ts:353) startete einen eigenen Backend-Unterprozess mit temporärer SQLite-Datenbank, legte einen gültigen Account an und benannte ausschließlich in dieser Fixture `sessions` um. Die gültige Anfrage `/api/me` lieferte **400 mit `no such table: sessions`**. Der Test scheiterte an der erwarteten generischen 500. Health blieb 200; nach Rückbenennung lieferte dieselbe gültige Session wieder erfolgreich dasselbe Profil. Diese Reparatur und das Schließen der Fixture erfolgten bereits vor der fehlgeschlagenen Assertion; keine produktiven Daten wurden benutzt. Nach der Korrektur besteht derselbe Fall mit 500, korrelierter Diagnose und erfolgreicher Wiederholung nach Reparatur.

### Umsetzung

| Pfad | Änderung und Wirkung |
| --- | --- |
| [input-errors.ts:15](/Users/noahbauditz/Documents/Projects/PixelFleet/apps/backend/src/input-errors.ts:15) | `PublicInputError` klassifiziert ausschließlich explizit bekannte Eingabefehler mit festem Status und fester öffentlicher Meldung. Allgemeine `SyntaxError`-, `TypeError`-, SQLite- und unbekannte Exceptions erhalten keine pauschale 4xx-Klassifikation. |
| [http.ts:209](/Users/noahbauditz/Documents/Projects/PixelFleet/apps/backend/src/http.ts:209) | JSON-Parsefehler werden nur unmittelbar um `JSON.parse` als Eingabefehler klassifiziert. Fehlender/falscher Content-Type ergibt 415, Bodies über den vorhandenen **16384 Bytes** ergeben 413. Tatsächliche Bytes werden auch bei Chunked-Encoding gezählt. Der Request wird bei Übergröße nicht vor der Antwort zerstört; überschüssige Daten werden verworfen. Transportabbruch/-fehler wird kontrolliert an den Handler übergeben; Listener konsumieren auch verspätete Fehler bis Request-Close. |
| [http.ts:204](/Users/noahbauditz/Documents/Projects/PixelFleet/apps/backend/src/http.ts:204), [server.ts:204](/Users/noahbauditz/Documents/Projects/PixelFleet/apps/backend/src/server.ts:204), [server.ts:368](/Users/noahbauditz/Documents/Projects/PixelFleet/apps/backend/src/server.ts:368) | Die Eingabegrenze verlangt ein JSON-Objekt: null, Arrays und Skalare ergeben 400. Username und Reset-Scope werden vor Benutzung auf ihren Typ geprüft; ungültige Werte ergeben feste 400-Meldungen. Omitted Scope bleibt `runtime`; zusätzliche unbenutzte Felder bleiben erlaubt. Die bisherigen Username-Normalisierung und Reservierungen bleiben erhalten. |
| [db.ts:121](/Users/noahbauditz/Documents/Projects/PixelFleet/apps/backend/src/db.ts:121) | Nur die bisherigen reservierten/zu kurzen Namen werfen nun den expliziten Eingabefehlertyp. TD-05-Transaktionen, Migration, Matchnachweise, Session- und Statistikoperationen bleiben unverändert. SQLite-Fehler werden nicht zu Eingabefehlern umetikettiert. |
| [server.ts:303](/Users/noahbauditz/Documents/Projects/PixelFleet/apps/backend/src/server.ts:303) | Die HTTP-Fehlergrenze umfasst Vorbereitung, Routing und alle abgewarteten Pfade. Serverseitiges `randomUUID()` erzeugt `X-Request-ID`; ein eingehender gleichnamiger Header wird ignoriert. Unbekannte Fehler ergeben ausschließlich `Internal server error.` und die passende Request-ID mit Status 500. Erwartete Auth-/Origin-/Quoten-/Routingantworten behalten ihre Semantik und relevanten Header. |
| [http.ts:184](/Users/noahbauditz/Documents/Projects/PixelFleet/apps/backend/src/http.ts:184), [server.ts:236](/Users/noahbauditz/Documents/Projects/PixelFleet/apps/backend/src/server.ts:236) | JSON wird vor dem Senden der Header serialisiert. Bereits gestartete/beendete/zerstörte Responses erhalten keine weitere JSON-Antwort. Statische Dateien werden vor Header-Commit geöffnet und per abgewarteter `pipeline` übertragen, inklusive Read-/Responsefehler und Clientabbruch. Nur fehlende Dateien/Verzeichnisse ergeben das bisherige 404-Verhalten; andere Dateifehler gelangen in die interne Fehlergrenze. Datei-Handles werden auch im Fehlerpfad geschlossen. Nach begonnenen Headern kann ein Stream nur abgebrochen werden, nicht rückwirkend zu 500 werden. |
| [metrics.ts:45](/Users/noahbauditz/Documents/Projects/PixelFleet/apps/backend/src/metrics.ts:45), [metrics.ts:115](/Users/noahbauditz/Documents/Projects/PixelFleet/apps/backend/src/metrics.ts:115) | Strukturierte HTTP-Fehlerereignisse in der vorhandenen Liste mit Request-ID, erlaubter Methode, fester Routenkategorie, Verarbeitungsstufe, Responsezustand und begrenzter Diagnose. Nur feste Fehlerarten/-codes, begrenzte numerische SQLite-Codes und bekannte Komponenten mit numerischer Position werden übernommen. Keine rohen Meldungen, vollständigen Stacks, Pfade, IPs, URLs, Bodies, Cookies oder Tokens. Auch ein geworfenes Objekt mit fehlschlagenden Gettern kann die Diagnose nicht abbrechen. Origin- und HTTP-Reset-Ereignisse übernehmen keine ungefilterten Clientwerte mehr. |
| [metrics.ts:95](/Users/noahbauditz/Documents/Projects/PixelFleet/apps/backend/src/metrics.ts:95) | Die bestehenden Gesamtzähler bleiben. Neue `http_client_errors_total` (400–499) und `http_server_errors_total` (500–599) unterscheiden Statusklassen. Ein WeakSet verhindert doppelte Registrierung; `once("finish")` zählt jeden vollständig gesendeten Response genau einmal. Keine zusätzliche Zählung im Catch, keine variablen Metriklabels. |

Statuscodes, JSON-Vertrag, Request-ID, Diagnoseumfang und Metriksemantik stehen in der [Deployment-Anleitung, HTTP errors and diagnosis](/Users/noahbauditz/Documents/Projects/PixelFleet/docs/dokploy.md:313). Vertrauenswürdiges CORS stellt den ID-Header für Browsercode bereit. WebSocket-Protokoll, Healthcheck-Semantik, Spielregeln, XP, Quoten, Timer und persistente Tabellen wurden nicht geändert.

### Verifikation und ausführbare Befehle

```sh
npm run build -w packages/shared
npx vitest run tests/deployment.test.ts tests/http.test.ts tests/metrics.test.ts -t 'TD-07'
npm run verify
docker build --no-cache --progress=plain --target runtime -t pixelfleet:checked .
```

Für einen zusätzlichen finalen Containerlauf die ausführbare Anleitung [Local container verification](/Users/noahbauditz/Documents/Projects/PixelFleet/docs/dokploy.md:426) verwenden. Die lokale Ausführung nutzte einen eindeutigen eigenen Tag, temporäres Volume, Netzwerk `none`, read-only Root-Dateisystem, entfernte Capabilities und `no-new-privileges`, mit Cleanup-Trap. Keine vorhandenen Docker-Ressourcen oder `.env`-/Produktionsdaten wurden verwendet.

| Prüfung | Nachweis |
| --- | --- |
| [deployment.test.ts:353](/Users/noahbauditz/Documents/Projects/PixelFleet/tests/deployment.test.ts:353) | Speicherfehler vor Korrektur rot (400 mit SQL-Detail), danach generische 500. Response-ID und interne Event-ID stimmen überein; Datenbankfehlercode ist intern verfügbar. Cookie-/Session-/Admin-/Authorization-/Query-/Client-ID-Testgeheimnisse und Fixturepfad erscheinen nicht in Fehlerantwort oder Diagnose. Backend bleibt verfügbar, gleiche Session funktioniert nach Reparatur. |
| [deployment.test.ts:256](/Users/noahbauditz/Documents/Projects/PixelFleet/tests/deployment.test.ts:256) | Ungültiges/leeres JSON, null, Arrays, Skalare, falsche Feldtypen, kurze/reservierte Namen und ungültige Reset-Scopes: 400. Vier falsche Content-Types und fehlender Header: 415. Deklarierte und gestreamte Übergröße: 413; gültiges JSON exakt am 16-KiB-Limit funktioniert. Parameter/Großschreibung im gültigen Content-Type, Default-Reset-Scope und Sessioncookie funktionieren weiter. Keine Eingaben werden im Fehlertext oder in Ereignissen gespiegelt. |
| [deployment.test.ts:312](/Users/noahbauditz/Documents/Projects/PixelFleet/tests/deployment.test.ts:312) | 401/403/404/429, Retry-After, Security-/CORS-Header, OPTIONS und quotenunabhängige Healthchecks erhalten. Einzigartige serverseitige IDs trotz eingesandter Client-ID. Echte JSON- und Prometheus-Metriken zählen exakt einmal und besitzen keine ID-/URL-Labels. |
| [deployment.test.ts:167](/Users/noahbauditz/Documents/Projects/PixelFleet/tests/deployment.test.ts:167) | Isolierte Fault-Injection ausschließlich im temporären Unterprozess-Entrypoint: interner TypeError bei Header-Vorbereitung, asynchroner SyntaxError/ungekanntes Objekt bei Dateiprüfung, Open-Fehler und Read-Fehler nach begonnenem 200. Interne Sprachfehler bleiben 500; Stream endet kontrolliert als unvollständige Antwort. Abgebrochener Upload erzeugt keinen Account. Instrumentierte Responses erkennen **null** doppelte/verspätete Schreibversuche. Sechs interne Ereignisse, aber nur vier abgeschlossene 500-Antworten; Backend und neuer gültiger Login bleiben nutzbar. Keine Produktions-Testhooks. |
| [http.test.ts:9](/Users/noahbauditz/Documents/Projects/PixelFleet/tests/http.test.ts:9), [metrics.test.ts:8](/Users/noahbauditz/Documents/Projects/PixelFleet/tests/metrics.test.ts:8) | Vier Response-Regressionsfälle: keine Ausgabe nach Headers/End/Destroy, Serialisierungsfehler vor Header-Commit. Zwei Metrikfälle: doppelte Registrierung/Finish ohne Doppelzählung, getrennte Statusklassen, keine Zählung geschlossener unvollständiger Antworten, sichere Diagnose, Getterfehler und Begrenzung der Ereignisliste auf 50. |
| Vollständiger lokaler Pfad | `npm run verify` unter Node **24.20.0**: **202/202 Tests in zwölf Dateien**, Typecheck und Produktionsbuild bestanden. Bestehende Testassertionen wurden nicht abgeschwächt; TD-01 bis TD-05 laufen mit. |
| Docker-Releasepfad ohne Cache | Beide reproduzierbaren `npm ci`-Installationen unter Node 24, **202/202 Tests**, Typecheck, Produktionsbuild und verpflichtender Runtime-Gate bestanden. Healthcheck, vollständiger Match-Smoke, erneuter Healthcheck und Shutdown Exitcode **0**. |
| Frisches finales Runtime-Image | Node **24.21.0**, UID **1000**, Docker-Status **healthy**, explizite Healthchecks, weiterer vollständiger Match-Smoke mit beiden Ergebnissen und 350/465 XP, Shutdown Exitcode **0**. Schema weiterhin 1, genau ein persistenter Matchnachweis in der neuen Fixture. Runtime-Projektdependencies nur `@pixelfleet`/`ws`; keine Tests, Testdriver, Smokequelle oder Erfolgsmarker. |

### Grenzen, Bestand und Bereinigung

Die bestehende Fehlerhistorie bleibt auf **50 Ereignisse insgesamt im RAM** beschränkt, ohne neues Monitoring oder persistentes Log. Erwartete Eingabefehler erzeugen keine internen Exceptionereignisse. Eine vollständig defekte Datenbank kann auch den authentifizierten Admin-Metrikzugriff durch dessen Datenbank-Gauges verhindern; Events bleiben nur bis Reparatur/Verdrängung/Prozessende erreichbar. Diagnose verzichtet bewusst auf SQL-/Exceptiontexte und absolute Pfade. Andere bestehende Ereignisproduzenten außerhalb HTTP wurden nicht überarbeitet.

Request-IDs gelten für den regulären HTTP-Handler; Node-eigene Ablehnung kaputter HTTP-Transport-/Headerframes vor dem Handler und WS-Upgrades gehören nicht zu diesem Vertrag. Nach bereits gesendeten Headern oder Verbindungsabbruch wird keine falsche zweite 500 behauptet. Solche nicht fertiggestellten Antworten erhöhen die bestehenden auf `finish` basierenden Gesamt-/Statuszähler nicht; ihr unerwarteter Fehler wird intern erfasst. Der Healthcheck bestätigt weiterhin den laufenden Dienst, nicht erfolgreiche Persistenz. Die Tests simulieren gezielte SQLite-/Programm-/Dateifehler und lokale Abbrüche, keine Datenträgerdefekte oder Produktionslast.

**Extern:** Keine neue Infrastruktur oder Dokploy-Einstellung ist für die Fehlerklassifikation nötig. Die unverifiziert offenen Produktions-/Repository-Einstellungen aus TD-03 bleiben unverändert offen; es wurde keine aktive Produktionssperre oder ausgelieferte Korrektur behauptet. TD-06 und andere Auditbefunde bleiben außerhalb dieser Änderung.

Der Abschlussvergleich mit dem vor TD-07 gesicherten Dateiinhalt begrenzt neue Änderungen auf HTTP-Helfer, Server-HTTP-/Static-Pfad, zwei typisierte Username-Fehler, Metriken sowie unmittelbar notwendige Tests und diese beiden Dokumente. Spielhub, TD-05-Migration/Persistenzlogik, Limiter, Releasekonfiguration, Manifeste/Lockfile, Frontend und alle übrigen Nutzerdateien blieben bytegleich. Der historische Auditbericht bleibt SHA-256 `e8a8304ce83f26660d630a6db1f5f4834f27158180142985ec22b2e4687cc827`. `git diff --check` bestanden. Eigene Backendprozesse, SQLite-Fixtures, Docker-Container/-Volume/-Tag sowie temporäre Prüfcontroller und Nachweisdateien wurden entfernt; Docker-Buildcache wurde nicht global gelöscht. Kein Deployment, Push oder Commit. **TD-07 ist vollständig behoben.**

## TD-06 – Autoritativer Verbindungszustand und Clientabgleich

**Stand:** 12. Oktober 2026 · **Status:** vollständig implementiert und lokal verifiziert. Kein Deployment, Push oder Commit.

### Ausgangsstand und zuerst nachgewiesene Regressionen

Der [historische Befund TD-06](/Users/noahbauditz/Documents/Projects/PixelFleet/docs/tech-debt-audit.md:163) wurde nach TD-01 bis TD-05 und TD-07 erneut geprüft. TD-02 lieferte inzwischen aufbewahrte Ergebnisse bei Reconnect, beseitigte aber nicht die fehlende explizite Lobby. Der Hub entfernte einen Disconnect aus der Queue und sendete bei leerem Zustand nur `profile`; `SessionConnection` setzte bereits beim Socket-Open `connected=true`. React hielt für denselben Account weiterhin Queue oder alte Matchansicht. TD-05 blockierte Abschlüsse korrekt im Backend, meldete sie aber als bisherige placing-/playing-Phase mit gestopptem Zug und Text.

**Vor der Anwendungskorrektur** wurden zwei neue [Controller-Regressionsfälle](/Users/noahbauditz/Documents/Projects/PixelFleet/tests/frontend-session.test.ts:138) ausgeführt. Beide scheiterten wie erwartet: Socket-Open ergab `connected=true` statt false, und nach einem expliziten Lobby-Snapshot blieb `queued=true`. Der rote Lauf enthielt zwei fehlgeschlagene und 29 übersprungene Tests. Beide Fälle bestehen jetzt; sie wurden nicht durch abgeschwächte Erwartungen ersetzt.

### Gemeinsamer Protokoll- und Zustandsvertrag

| Änderung | Wirkung und Referenz |
| --- | --- |
| Typisierter Snapshot | [types.ts:124](/Users/noahbauditz/Documents/Projects/PixelFleet/packages/shared/src/types.ts:124): `SessionSnapshot` enthält Profil und genau einen Zustand: `{kind:"lobby"}`, `{kind:"queue"}` oder `{kind:"match",view}`. `view.phase` unterscheidet `placing`, `playing`, `saving`, `save_failed` und `finished`. Damit sind Lobby/Queue explizit leer bezüglich einer Partie und blockierte Abschlüsse explizit vom Spielen/Ergebnis getrennt. Keine parallelen Queue-/Matchflags im autoritativen Clientzustand. |
| Initialisierung jeder unterstützten Verbindung | [game-hub.ts:129](/Users/noahbauditz/Documents/Projects/PixelFleet/apps/backend/src/game-hub.ts:129): Erstverbindung, Reconnect und Socketersatz erhalten zuerst genau einen `session_snapshot`. Der Hub liest das aktuelle Profil aus SQLite; aktive Partie einschließlich ausstehendem/gescheitertem Abschluss hat Vorrang, danach bestehende Queue, jüngstes nicht quittiertes Ergebnis innerhalb der TD-02-Frist, sonst Lobby. Fristen werden nicht verlängert. |
| Eindeutige Reihenfolge | [game-hub.ts:174](/Users/noahbauditz/Documents/Projects/PixelFleet/apps/backend/src/game-hub.ts:174): Snapshotaufbau und Einreihen ins Socket sind synchron ohne `await`; erst danach werden Live-Ausgaben und der Nachrichtenhandler dieser Verbindung freigegeben. Das neue `initialized`-Flag unterdrückt vorzeitige Live-Ausgaben, etwa falls beim Connect eine fällige Schonfrist zum Abschluss führt. Folgende Frames laufen geordnet über denselben Socket. Es ist kein zweiter Fetch, globaler Sequenzzähler oder neuer Timer nötig. |
| Bestehende Schonfrist und Sichtbarkeit | Fällige Disconnectdeadlines werden auch vor einem noch wartenden Timeoutcallback ausgewertet; bei gleichen Deadlines bleibt die Einfügereihenfolge der bisherigen Timer maßgeblich. Die Frist bleibt 30000 ms. Public Views verwenden die bisherigen gefilterten eigenen/gegnerischen Boards; unbekannte Gegnerfelder enthalten weiterhin weder Positionen noch Ship-IDs. |
| Spielbereitschaft und alte Ereignisse | [sessionConnection.ts:142](/Users/noahbauditz/Documents/Projects/PixelFleet/apps/frontend/src/lib/sessionConnection.ts:142): Socket-Open allein gibt keine Aktionen frei. Erst ein passender Snapshot wird zusammenhängend übernommen und setzt die Verbindung bereit. Generation, Request-Abbruch und Socketidentität schützen weiterhin vor verspäteten Antworten/Nachrichten/Closecallbacks. Accountwechsel invalidiert die alte Verbindung. Eine Profilnachricht kann die Initialisierung nicht ersetzen. |
| React-Zustand und lokale Eingaben | [App.tsx:28](/Users/noahbauditz/Documents/Projects/PixelFleet/apps/frontend/src/App.tsx:28), [sessionState.ts:11](/Users/noahbauditz/Documents/Projects/PixelFleet/apps/frontend/src/lib/sessionState.ts:11): Ein Zustandsobjekt hält Profil und Serverzustand. Snapshot ersetzt es in einem Update; Lobby entfernt alte Queue-/Matchansichten. `GameScreen` ist nach Account-ID und Match-ID gekeyt. Derselbe unbestätigte Platzierungseditor bleibt bei kurzem Disconnect erhalten; Account-/Matchwechsel, Lobby, bestätigte Flotte oder andere Phase unmounten ihn. Alte Benachrichtigungen werden bei Snapshotübernahme entfernt. |
| Expliziter Speicherzustand | [game-hub.ts:665](/Users/noahbauditz/Documents/Projects/PixelFleet/apps/backend/src/game-hub.ts:665), [GameScreen.tsx:41](/Users/noahbauditz/Documents/Projects/PixelFleet/apps/frontend/src/components/GameScreen.tsx:41): `saving` zeigt „Saving match result. Play is locked while storage is retried.“; `save_failed` zeigt die gescheiterte Speicherung und Administrationshinweis. Beide haben keine Spielaktionen und kein Ergebnis. Die bisher zusätzlich erzeugten automatischen Fehler-Toasts entfallen für Abschlussversuche, weil sonst nach einem erfolgreichen Commit noch veraltete Speicherfehler über dem Ergebnis standen. Explizit versuchte verbotene Aktionen bleiben serverseitig abgewiesen. |
| Bedienelemente | Confirm, Fire, Queue-Cancel und Ergebnisquittierung sind vor Initialisierung und bei Verbindungsabbruch gesperrt; `SessionConnection.send` schützt zusätzlich unabhängig von React. Lokales Platzieren darf während eines kurzen Ausfalls weiter bearbeitet werden. Eine fehlgeschlagene Übertragung des „Back to Lobby“ verwirft die Ergebnisansicht nicht mehr. Eine verspätete Queue-Abmeldung kann eine inzwischen gefundene aktive Partie nicht aus dem Clientzustand löschen. |
| Gemeinsame Auslieferung | [server.ts:511](/Users/noahbauditz/Documents/Projects/PixelFleet/apps/backend/src/server.ts:511): `pixelfleet.v2` kennzeichnet passende WebSocket-Clients. Ein authentifizierter alter Client erhält Neuladehinweis und Close 4002, wird nicht im Hub angemeldet und kann keine Spielaktionen ausführen. Aktueller Client, Shared und Backend müssen gemeinsam ausgeliefert werden. [smoke-match.mjs:41](/Users/noahbauditz/Documents/Projects/PixelFleet/scripts/smoke-match.mjs:41) bietet nur das neue Subprotokoll an und wartet zusätzlich auf den Snapshot; Matchablauf, Zielwahl und Belohnungsprüfung bleiben erhalten. |

Die [Deployment-Anleitung](/Users/noahbauditz/Documents/Projects/PixelFleet/docs/dokploy.md:314) dokumentiert Vertrag, Reihenfolge, Phasen und Auslieferung. Bereits geöffneter alter JavaScript-Code kann Close 4002 weiterhin automatisch wiederholen, bis der Nutzer neu lädt/schließt; diese Versuche behalten ihre Quoten. Der Hinweis wird vom alten Toastformat verstanden. Bei erreichten Quoten kann nach dem Neuladen zunächst die Retry-Frist abzuwarten sein. Der neue Client wiederholt einen erkannten Protokollfehler nicht automatisch. Es wird keine erfolgreiche Rekonstruktion alter UI-Zustände durch alten Clientcode behauptet.

### Tests, Integrationsnachweise und ausführbare Befehle

```sh
# Node 24.15+ innerhalb der 24.x-Reihe für jsdom; lokal geprüft mit 24.20.0.
npm ci
npm run build -w packages/shared
npx vitest run tests/frontend-session.test.ts tests/reconnect-integration.test.tsx
npm run verify
docker build --no-cache --progress=plain --target runtime -t pixelfleet:checked .
```

Für den separaten Containerlauf gilt [Local container verification](/Users/noahbauditz/Documents/Projects/PixelFleet/docs/dokploy.md:492) mit eigenem Tag, neuer Wegwerf-Volume und Cleanup-Trap. `jsdom` **30.1.2** ist die einzige neu direkt deklarierte Entwicklungsabhängigkeit; der Lockfile enthält ihre zusätzlichen transitiven Abhängigkeiten. Keine vorherige Dependency-Version wurde verändert. Die DOM-Tests laufen in `npm test` und dadurch im bestehenden Docker-Gate; jsdom und die Testdateien gelangen nicht ins finale Runtime-Image.

| Prüfung | Nachgewiesen |
| --- | --- |
| [frontend-session.test.ts:138](/Users/noahbauditz/Documents/Projects/PixelFleet/tests/frontend-session.test.ts:138), drei neue Fälle, insgesamt 32 | Roter Ausgangsnachweis, Readiness erst nach Snapshot, explizites Entfernen einer alten Queue, Ablehnung profilbasierter alter Initialisierung ohne Aktionen oder neue Retryserie. Bestehende Lifecycle-Fälle zu späten HTTP-/Socket-/Login-/Logoutcallbacks und Strict-Mode-Generationen bleiben erhalten. Die Transportfixtures initialisieren ihre geöffneten Sockets jetzt entsprechend dem neuen Vertrag. |
| [reconnect-integration.test.tsx:152](/Users/noahbauditz/Documents/Projects/PixelFleet/tests/reconnect-integration.test.tsx:152), **26 neue Fälle** | Tatsächlich gemountete `App` und Spielansichten über unveränderte `SessionConnection`, serialisierte JSON-Nachrichten, echten GameHub und echte isolierte SQLite-Fixture. Nur Transport und Zeit sind simuliert. Keine nachgebildete React-Viewlogik oder unabhängigen Backend-/Frontend-Proben. |
| Queue und Reihenfolge | Erstverbindung unter echtem React StrictMode, noch nicht zugestellter Snapshot ohne freigegebene Aktionen, Queue-Disconnect/Cancel/Reconnect, Socketersatz mit erhaltener Queue, alte Close-/Aktionscallbacks sowie verspätete Abmeldung nach Matchmaking. |
| Platzierung und Spiel | 17-Zellen-Entwurf bleibt beim selben Match vor und nach Snapshot erhalten; anderer Account/Match oder inzwischen bestätigte Flotte verwirft den Editor. Reconnect in Platzierung und laufender Partie vor 30000 ms; unbekannte Gegnerfelder bleiben vollständig verdeckt. |
| Fristen und Ergebnisse | Reconnect bei 29999, 30000 und 31000 ms, fällige noch nicht gelaufene Timer und zwei gleiche Deadlines in ursprünglicher Disconnectreihenfolge. Gültiges, quittiertes, exakt abgelaufenes Ergebnis; jüngstes Ergebnis aus drei Folgepartien. Neuere aktive oder blockierte Partie hat Vorrang vor einem alten Ergebnis. Keine erneute XP-/Statistikbuchung. |
| Reset, Neustart und Accounts | Runtime-/Statistikreset und neuer Hub mit derselben SQLite-Session führen zu Lobby; folgende Partie hat leeren lokalen Editor. Accountwechsel, Logout, Sessionablauf und verspätete alte Socketnachrichten verändern keine neuere Verbindung. Zusätzlich prüft [deployment.test.ts:1196](/Users/noahbauditz/Documents/Projects/PixelFleet/tests/deployment.test.ts:1196) einen echten Backend-Unterprozessneustart mit derselben Datenbank und anschließendem Lobby-Snapshot. |
| Speicherabschluss während Reconnect | SQLite-Testtrigger erzwingt echte Speicherfehler. Pending und endgültig fehlgeschlagener Abschluss bleiben ohne normale Controls/Ergebnis sichtbar. Ein zurückgehaltener initialer Saving-Snapshot wird vor späterem `profile`/`match_finished` verarbeitet, wenn zwischenzeitlich der Commit gelingt; das Endergebnis bleibt erhalten. Bestehende TD-05-Transaktions-/Last-shot-/Timeoutfälle laufen weiter. |
| Protokollkompatibilität | [deployment.test.ts:167](/Users/noahbauditz/Documents/Projects/PixelFleet/tests/deployment.test.ts:167): alter echter WebSocket erhält Hinweis/4002 und belegt keinen Hubplatz. Der Transportplatz wird zuverlässig freigegeben; bei Limit 1 kann anschließend der v2-Client verbinden und erhält Lobby samt Profil. |
| Bestehende Testanpassungen | Initiale `profile`-/Queue-/Match-Einzelnachrichten wurden in Fixtures/Assertions durch den Snapshot ersetzt; View-Helfer können dessen Matchview lesen. TD-05 erwartet die explizite `saving`-Phase anstelle eines alten generischen Fehlerereignisses/der playing-Phase. Schutz-, Frist-, Persistenz- und Quotenassertionen wurden nicht entfernt. |
| Gesamter lokaler Prüfpfad | `npm run verify`: **232/232 Tests in 13 Dateien**, Typecheck und Produktionsbuild unter Node **24.20.0** erfolgreich. Gegenüber TD-07 sind 30 gezielte Fälle hinzugekommen. |
| Gesamter Docker-Releasepfad | Ohne Cache, beide `npm ci`-Installationen unter Node 24, **232/232 Tests**, Typecheck, Produktionsbuild, Runtime-Healthcheck, unverändert vollständiger Match-Smoke, weiterer Healthcheck und Shutdown Exitcode **0** bestanden. |
| Frisches finales Image | Zusätzlicher Container unter Node **24.21.0**, UID **1000**, Netzwerk `none`, read-only Root-Dateisystem, entfernte Capabilities und `no-new-privileges`. Docker **healthy**, explizite Healthchecks, zweiter vollständiger Match-Smoke mit 350/465 XP und Shutdown **0**. Schema 1 und genau ein Nachweis in der frischen Datenbank. Runtime-Projektdependencies ausschließlich `@pixelfleet` und `ws`; keine Tests, jsdom, Smokequelle oder Gate-Marker. |

### Gezielte Browserprüfung

**Prüffluss:** Gastlogin → Queue/Reconnect → aktive Platzierung/Reconnect → Runtime-Reset → neue Partie mit echtem UI-Schuss → ausstehende/fehlgeschlagene Speicherung → erfolgreicher Retry → echter Backend-Neustart → Lobby mit gültiger Session.

Browser-Skill/-Plugin war nicht verfügbar; verwendet wurde das vorhandene gebündelte **Playwright 1.62.1** mit **Chromium 151.0.7922.34**. Zwei isolierte Browserkontexte liefen gegen den frischen Produktionsbuild unter `http://127.0.0.1:64589`, Desktop **1440×1000**, anschließend Lobby **390×844**. Der lokale Dienst und diese Portbelegung wurden danach beendet. Die Browserfixture verwendete eine eigene temporäre SQLite-Datei und ausschließlich lokale Dienste. Temporäre Browserinstrumentierung unterbrach gezielt Sockets; ein SQLite-Testtrigger erzeugte Speicherfehler. Es gibt keine entsprechenden Hooks im Anwendungscode und keine neue Browser-Suite im Repository.

| Browsercheck | Ergebnis |
| --- | --- |
| Seitenidentität, echter Inhalt, Framework-Overlay | URL und Titel geprüft; Login/Lobby/Spielansichten vorhanden; kein Vite-Overlay oder leerer Bildschirm. |
| Interaktion | Queue-Reconnect zeigte wieder einen benutzbaren Startknopf. Ein unbestätigter 17-Zellen-Entwurf war nach Reconnect identisch. Runtime-Reset und nächste Partie entfernten ihn. Platzieren/Bestätigen und ein Schuss per echtem UI funktionierten. |
| Abschlusszustände | Saving- und Fehlgeschlagen-Ansicht ohne Spielknöpfe; Fehlgeschlagen blieb nach Reconnect bestehen. Nach einem weiteren Speicherfehler und Reparatur wechselte ein erfolgreicher Retry erst nach Commit zur Ergebnisansicht. |
| Echter Neustart | Beide Browser verbanden nach Stop/Start desselben Backendports mit unveränderten Sessions zur Lobby; die alte Ergebnisansicht verschwand und gespeicherte Statistik blieb erhalten. |
| Konsole | **0 JavaScript-Pageerrors**. Zwei erwartete 401-Ressourcenmeldungen von `/api/me` vor den beiden Gastlogins; keine weiteren Warn-/Fehlermeldungen. |
| Sichtprüfung | Screenshots von erhaltener Platzierung, Saving, gesperrtem Abschluss, committed Ergebnis und mobiler Lobby wurden erfasst. Platzierungsansicht, gesperrter Abschluss und mobile Lobby wurden visuell geprüft; keine durch TD-06 verursachte Darstellungslücke erkannt. |

Prüfnachweise außerhalb des Repositories: [QA-Daten](/Users/noahbauditz/.codex/visualizations/2026/10/12/01a12fe3-4502-77d1-bcd3-358fdd0eddcf/td06/qa.json), [erhaltene Platzierung](/Users/noahbauditz/.codex/visualizations/2026/10/12/01a12fe3-4502-77d1-bcd3-358fdd0eddcf/td06/placement-preserved.png), [gesperrter Speicherabschluss](/Users/noahbauditz/.codex/visualizations/2026/10/12/01a12fe3-4502-77d1-bcd3-358fdd0eddcf/td06/saving-failed.png). Das sind lokale Nachweisartefakte, keine ausgelieferte Browser-Infrastruktur.

### Grenzen, Auslieferung und Abschlussprüfung

Die Zustandsprüfung gilt für unterstützte v2-Verbindungen nach Authentifizierung. Es gibt weiterhin nur eine Backendinstanz und einen geordneten WebSocket je aktiver Clientverbindung. Der Snapshot ist kein Ereignisarchiv und enthält keine Ergebnis-Historie. Nach Ablauf eines Ergebnisses kann ein bereits geöffneter ResultScreen dessen schon empfangene Darstellung noch zeigen; der nächste Snapshot entfernt sie, und im Server ist der RAM-Eintrag gemäß TD-02 abgelaufen. Eine verlorene Partie nach Backendneustart wird nicht wiederhergestellt; der Snapshot macht diesen leeren Zustand eindeutig. Neuladen einer Seite verliert deren unbestätigte lokale Eingaben, selbst wenn ein noch laufender Server die Partie wieder liefert.

Die Browserprobe ersetzt keine TD-08-Suite: keine vollständige Safari-/Firefox-/Touch-Matrix, keine durchgängige mobile Partie, keine Produktionslast und keine Prüfung des echten Traefik-/Dokploy-Proxys. Der bestehende TD-03-Gate wurde lokal geprüft; externe Deployment-/Repository-Einstellungen bleiben unbestätigt. Für die spätere Auslieferung gemeinsam gebautes Image verwenden, Subprotokollweitergabe am autorisierten Testdeployment prüfen und Nutzer alter Tabs zum Neuladen auffordern. Kein Deployment wurde ausgeführt.

Der Diff wurde auf Initialisierungsreihenfolge, verspätete alte Ereignisse, lokale Eingaben, Rückfälle in frühere TD-Korrekturen und unnötige Änderungen geprüft. Die bestehenden TD-01-Transportbereinigung, TD-02-Aufbewahrung, TD-03-Releasekonfiguration, TD-04-Limiter, TD-05-Transaktionen/Migration und TD-07-HTTP-Fehlergrenze bleiben erhalten. Datenbank-, Migrations-, Limiter-, HTTP-Helfer-/Metrikdateien, Dockerfile, Compose und `.dockerignore` blieben bytegleich gegenüber Beginn dieses Auftrags. Neue Änderungen betreffen ausschließlich TD-06-Protokoll, Hubinitialisierung, Client-/Spielansichten, erforderliche Tests/Testabhängigkeit, Smoke-Initialisierung und Dokumentation.

Der historische Auditbericht bleibt bytegleich mit SHA-256 `e8a8304ce83f26660d630a6db1f5f4834f27158180142985ec22b2e4687cc827`. Alle anderen vorhandenen Nutzerdateien und unversionierten Dateien wurden erhalten. `git diff --check` bestanden. Eigene Backend-/Browserprozesse, temporäre Datenbanken, Docker-Container/-Volumes/-Tags sowie Prüfcontroller und temporäre Logs wurden entfernt; die separat verlinkten QA-Nachweisartefakte bleiben erhalten. Kein globales Docker-Cache-Pruning. **TD-06 ist im beauftragten Umfang vollständig behoben.**

## TD-08 – Dauerhafte Browserprüfung des Kernablaufs

**Stand:** 12. Oktober 2026 · **Status:** Der noch offene beauftragte TD-08-Umfang ist implementiert und lokal verifiziert. Keine Produktionsauslieferung oder verifizierte externe Dokploy-Sperre.

### Erneute Prüfung und Umfang

Der [historische Befund](/Users/noahbauditz/Documents/Projects/PixelFleet/docs/tech-debt-audit.md:187) wurde gegen den aktuellen Stand geprüft. TD-06 hat bereits 26 echte React-Mount-/Hub-Integrationstests, ergänzte Sessiontests und eine einmalige Chromium-Probe geliefert. Diese bleiben unverändert. Im Repository fehlten weiterhin Playwright-Konfiguration, ausführbare Browserfälle und deren verbindlicher Release-Gate. `npm run verify` und der bisherige Dockerpfad sicherten 232 Source-/React-/Backendtests ab; der Protokoll-Smoke bediente weiterhin keine UI. Die hier geschlossene Lücke ist somit die wiederholbare echte Browser-/Produktionsbuild-Integration, nicht eine zweite Umsetzung der TD-06-Zustandslogik.

Die bereitgestellten AGENTS-Regeln wurden berücksichtigt; im Checkout/den geprüften Elternverzeichnissen lag keine zusätzliche `AGENTS.md`. Ein SHA-256-Dateiinventar vor der Änderung dient zum Abgleich sämtlicher vorhandener versionierter und unversionierter Nutzerdateien. Anwendungscode, Spielregeln, Shared-Protokoll und vorhandene Testdateien wurden für TD-08 nicht geändert.

### Umsetzung

| Bereich | Implementierung |
| --- | --- |
| Kleine Chromium-Suite | [playwright.config.ts:1](/Users/noahbauditz/Documents/Projects/PixelFleet/playwright.config.ts:1), genau fünf Szenarien, ein Worker, Headless-Chromium, `retries: 0`, `forbidOnly: true`, begrenzte Aktions-/Navigations-/Assertion-/Testtimeouts. `.browser.ts` wird ausdrücklich von Playwright entdeckt und kollidiert nicht mit Vitests `.test`-/`.spec`-Discovery. |
| Vorbereitung und Befehle | [package.json:26](/Users/noahbauditz/Documents/Projects/PixelFleet/package.json:26): `browser:install` installiert die benötigten Browser-/Linuxbibliotheken; `browser:test` führt ausschließlich Tests aus. `typecheck` prüft zusätzlich Browsercode und Konfiguration. [setup.ts:1](/Users/noahbauditz/Documents/Projects/PixelFleet/tests/browser/setup.ts:1) verlangt den Produktionsbuild und installiertes Chromium; fehlende Vorbereitung schlägt mit konkretem Befehl fehl. |
| Echte Dienste und Isolation | [fixtures.ts:13](/Users/noahbauditz/Documents/Projects/PixelFleet/tests/browser/fixtures.ts:13), [fixtures.ts:180](/Users/noahbauditz/Documents/Projects/PixelFleet/tests/browser/fixtures.ts:180): Jeder Test startet den kompilierten Backend-Unterprozess mit eigenem temporären SQLite-Pfad, Port 0 und dem tatsächlich gebauten Frontend. Neue Browserkontexte trennen die zwei Cookies/Accounts. Neustart behält ausschließlich die Datenbank und den Port dieses Tests. Kein Vite-Devserver, fremder Dienst, Produktionsvolume oder `.env`-Lesen. |
| Authentische Interaktion | Login, Queue, manuelle Platzierung, Confirm, sämtliche Schüsse, Ergebnisquittierung und Logout erfolgen über Rollen und zugängliche Namen. Feste horizontale Flottenkoordinaten unterstützen nur reproduzierbare Zielwahl; der erste Zug bleibt serverbestimmt. Native Browser-WebSockets werden in einem ausschließlich testseitigen Init-Script referenziert und für Abbruchproben geschlossen; Frames/Aktionen/HTTP-Antworten werden nicht nachgebildet. Es gibt keine Produktions-Testhooks oder neuen Endpunkte. |
| Sichtbarkeit und Bereitschaft | Zugstatus, Match-/Lobby-/Queueansichten, aktive/gesperrte Knöpfe, unbekannte Gegnerfelder, sichtbare Treffer/Fehlschüsse sowie Ergebnisse werden geprüft. Echte eingehende Frames unterstützen das Warten auf Zustandswechsel. `expect.poll`/Locatorassertionen ersetzen Sleepketten. Nur das sichtbare Entwurfsmuster nutzt `.cell-ship` zur Inspektion der bereits vorhandenen Darstellung; keine neuen Test-IDs im Anwendungscode. |
| Fehlererkennung | [fixtures.ts:78](/Users/noahbauditz/Documents/Projects/PixelFleet/tests/browser/fixtures.ts:78): Jeder JavaScript-Pageerror wird als Testfehler erfasst. Unerwartete HTTP-/Request-/Console-/Socketfehler und vom Backend abgelehnte UI-Aktionen ebenso. Enge Ausnahmen gelten für anonymes GET `/api/me` mit 401 und explizite Verbindungsausfälle des eigenen `/api/me`-/`/ws`-Pfads während des markierten Neustarts. Keine pauschale Errorunterdrückung oder Test-Retryserie. |
| Artefakte und Cleanup | [fixtures.ts:239](/Users/noahbauditz/Documents/Projects/PixelFleet/tests/browser/fixtures.ts:239): Bei Fehlern Screenshots/Traces pro Captain sowie maximal 64000 Zeichen Backendlog und Browserdiagnosen; HTML-Report verlinkt die Anhänge. Bei Erfolg werden Traces verworfen. [fixtures.ts:250](/Users/noahbauditz/Documents/Projects/PixelFleet/tests/browser/fixtures.ts:250): Reentrante Bereinigung schließt Kontexte, beendet/erwartet den Backendprozess und entfernt danach SQLite/WAL/SHM. Signalhandler fordern dieselbe Bereinigung an; Shutdown hat einen endlichen Kill-Watchdog. |
| Verbindlicher Imagepfad | [Dockerfile:40](/Users/noahbauditz/Documents/Projects/PixelFleet/Dockerfile:40): `browser-tools` bereitet Browser und Systembibliotheken vor; `browser-check` führt die Suite mit `--network=none` und temporärem `/tmp` aus. [Dockerfile:87](/Users/noahbauditz/Documents/Projects/PixelFleet/Dockerfile:87): Das finale `runtime` benötigt sowohl deren Marker als auch den bisherigen Runtime-Health-/Match-Smoke-Marker. Fehler verhindern den Export. Default- und Compose-Target bleiben `runtime`. |
| Runtime-Trennung | Die Browserstage wird nicht zur Runtime-Basis. `npm ci --omit=dev` und selektive Runtime-Copies bleiben erhalten. Browser, deren zusätzlichen OS-Pakete, Playwright/jsdom/Vitest/TypeScript, Testdateien, Reports und Gate-Marker gelangen nicht in das finale Runtime-Dateisystem. `test-results/` ist in Git und Docker ausgeschlossen. |

Direkt neu ist ausschließlich **`@playwright/test` 1.64.0**, transitiv `playwright`/`playwright-core` derselben Version. Der zugehörige Chromium Headless Shell ist **156.0.8078.4, Revision 1248**. Nach Entfernen dieser drei neuen Package-Einträge und der neuen Root-Devdependency aus einer Kopie entspricht der Lockfile bytegleich dem vor TD-08 gesicherten Hash. Es wurden keine anderen Dependency-Versionen aktualisiert.

### Fünf Szenarien und Nachweise

| Szenario | Abgesichert |
| --- | --- |
| [Gast/Lobby/Logout:3](/Users/noahbauditz/Documents/Projects/PixelFleet/tests/browser/game.browser.ts:3) | Echter Gastlogin, benutzbarer Startknopf und Onlinezustand, Profile-Tab und Cookie-Löschung. Reload bestätigt fehlende Session; ein neuer Gast kann wieder spielen. |
| [Vollständige Partie:18](/Users/noahbauditz/Documents/Projects/PixelFleet/tests/browser/game.browser.ts:18) | Zwei separate Browserkontexte, sichtbare Queue und manuelle Platzierung aller fünf Schiffe pro Captain; beide UI-Confirms, verdecktes Gegnerbrett, ein absichtlicher Fehlschuss und alle nötigen echten UI-Schüsse bis `ships_sunk`. Sieg/Niederlage, XP und Games Played 1 werden für beide angezeigt; beide quittieren zur Lobby. HTTP bestätigt gespeicherte Statistik. |
| [Queue-Reconnect:51](/Users/noahbauditz/Documents/Projects/PixelFleet/tests/browser/game.browser.ts:51) | Eigener nativer Socketabbruch in Queue, neuer Lobby-Snapshot, verschwundene Suche, erneutes Starten und funktionierendes Cancel über UI. |
| [Platzierung/Spiel-Reconnect:65](/Users/noahbauditz/Documents/Projects/PixelFleet/tests/browser/game.browser.ts:65) | Fünf lokal entworfene Zellen bleiben mit gleichen Koordinaten bei Reconnect derselben Partie erhalten; anschließend restliche Platzierung/Confirm. Nach einem echten Schuss weiterer Disconnect, sichtbarer Offlinezustand beim Gegner, unveränderte Match-ID/Brettansicht nach Reconnect und ein weiterer zulässiger UI-Schuss. |
| [Backendneustart:100](/Users/noahbauditz/Documents/Projects/PixelFleet/tests/browser/game.browser.ts:100) | Echter Stop/Start mit derselben SQLite-Datei und Port bei laufender Partie. Beide alten Cookies authentifizieren weiterhin dieselben Accounts; Snapshot und UI zeigen explizite Lobby ohne altes Brett/Ergebnis. Eine folgende Partie ist benutzbar und beginnt mit leerem Entwurf/neuer Match-ID. Die verlorene Partie wird nicht verbucht oder rekonstruiert. |

Ausführbare Einrichtung, lokale Befehle, Docker-Diagnoselauf, Artefaktpfade und externe Einstellungen stehen in [docs/dokploy.md:501](/Users/noahbauditz/Documents/Projects/PixelFleet/docs/dokploy.md:501). Der [sichere Gate-Negativnachweis](/Users/noahbauditz/Documents/Projects/PixelFleet/docs/dokploy.md:642) verändert ausschließlich einen temporären Buildkontext.

| Verifikation | Ergebnis |
| --- | --- |
| Vollständige lokale Prüfung | `npm run verify`: **232/232 Tests in 13 Dateien**, vorhandene React-Mounttests unverändert, kompletter Typecheck einschließlich Browsercode und Produktionsbuild erfolgreich. Lokales Node **24.20.0**. |
| Chromium-Ausführung und Wiederholung | Fünf Szenarien erfolgreich; finale `npm run browser:test -- --repeat-each=3` mit **15/15 Erfolgen in 58.1 s**, jeweils frische Kontexte/Datenbanken, keine Retries. |
| Fehlender Browser | Ein leerer temporärer `PLAYWRIGHT_BROWSERS_PATH` beendet `browser:test` mit Exitcode 1 und „Chromium is unavailable. Run npm run browser:install …“. Keine Tests übersprungen, keine Downloads während Ausführung. |
| Docker-Negativprobe | Zusätzliche bewusst falsche Locatorassertion in `tests/browser/gate-probe.browser.ts` nur im temporären Kontext: **5 reguläre Erfolge, 1 erwarteter Fehler**, Exitcode 1 in `browser-check`; eindeutiger Probe-Tag existiert danach nicht. Screenshot-/Trace-/Diagnoseanhänge werden im Fehlerlog aufgeführt. |
| Fehlerartefakte im Docker-Diagnosepfad | Separate temporär gemountete Locator-Fehlerprobe gegen `browser-tools`, read-only Root und Host-Ausgabemount: erwarteter Exitcode 1, Screenshot und Trace erfolgreich auf dem Host gespeichert. PNG-Signatur und ZIP-Integrität/Inhalt geprüft; Backend beendet und Container/Image-Tag danach entfernt. Ignorierte Nachweise unter `test-results/gate-proof/`. |
| Erneuter erfolgreicher Releasepfad | Probe entfernt, finale Browserquellen in den temporären Kontext übernommen, vollständiger `docker build --no-cache --target runtime`: beide reproduzierbaren `npm ci`, **232 Source-/Reacttests**, Typecheck, Build, **5 Browsertests**, Runtime-Healthcheck, vollständiger Protokoll-Match-Smoke, zweiter Healthcheck und geordneter Shutdown erfolgreich; finales Image exportiert. Keine Browserdownloads in der Teststage. |
| Exportiertes finales Image | Zusätzlicher eigener Container, Netzwerk `none`, read-only Root, Capabilities entfernt, `no-new-privileges`, neues temporäres Volume. Node **24.21.0**, UID **1000**, Docker **healthy**, explizite Healthchecks, vollständiger weiterer Smoke mit **350/465 XP**, genau ein dauerhafter Abschlussnachweis, Shutdown **0**. Installed Runtime-Projektdependencies nur `@pixelfleet` und `ws`; Tests, Browser, Playwright/jsdom/Vitest/TypeScript, Smoke-/Prüftreiber, Konfiguration und Gate-Marker fehlen. |

Während der Einrichtung wurde die Loginfixture von der falschen Erwartung 200 auf den vorhandenen korrekten 201-Vertrag korrigiert. Eine parallel gestartete Fehlende-Browser-Probe löschte anfangs das gemeinsame Playwright-Ausgabeverzeichnis eines Wiederholungslaufs; sie wird nun separat ausgeführt, wie dokumentiert. Anschließende vollständige Wiederholungen bestehen. Es wurden keine pauschalen Retries, Sleeps oder abgeschwächten Spiel-/Fehlerassertionen eingeführt.

### Grenzen und externe Schritte

**Implementiert und lokal nachgewiesen:** Desktop-Chromium gegen echten Produktionsbuild, lokale HTTP-/WS-Verbindungen und tatsächliche Persistenz; Source-/Browser-/Runtime-Gates verhindern den unterstützten lokalen Imageexport bei Fehlern. Die früheren TD-01 bis TD-07-Korrekturen bleiben erhalten. Die vorhandenen ausführlichen React-/Backendtests prüfen weiterhin Grace-Grenzen, alte Accounts/Sockets, Speicherfehler und Ergebnisfristen; sie wurden hier nicht in eine große Browsermatrix übertragen.

**Extern noch einzurichten/verifizieren:** Die TD-03-Rechte-/Branch-/Dokploy-Einstellungen bleiben mangels Zugang unbestätigt. Der Builder benötigt Zugang zu npm, Debian-Paketquellen und dem Playwright-Browser-CDN während Vorbereitung; Testausführung benötigt nur Loopback. Mit separatem Dokploy-Testservice und eigener Wegwerf-Volume zunächst eine absichtlich fehlschlagende Browserassertion bauen und prüfen, dass weder Imagewechsel noch als erfolgreich gemeldeter Fallback erfolgt; danach erfolgreicher Build/Healthcheck. Nur dann AutoDeploy aktivieren. Targets/Dockerfile-/Branchauswahl dürfen die geprüfte `runtime`-Abhängigkeit nicht umgehen. Konkrete Schritte stehen in der [Deployment-Anleitung:42](/Users/noahbauditz/Documents/Projects/PixelFleet/docs/dokploy.md:42). Keine aktive Produktionssperre wird behauptet.

Nicht geprüft: Firefox/Safari, echte Touchgeräte, vollständige mobile Partie, systematische Screenreader-/Tastaturprüfung, visuelle Baselines, TLS/Traefik, Produktionslast oder Live-Dokploy. Die Suite testet kurze Wiederverbindungen und geordneten Backendneustart; sie ersetzt keine Prozess-/Hostabsturzprüfung. SIGKILL/Hostabbruch kann Cleanup verhindern. Browservorbereitung nutzt gepinnte Playwright-Revisionen, aber weder fortlaufender Node-24-Tag noch Debian-Sicherheitsrepositories sind ein bitidentischer OS-Snapshot. Fehlertraces enthalten ausschließlich wegwerfbare Testsessions/Fixture-Nachrichten, keine Produktionsdaten. Gleichzeitige lokale Playwright-Aufrufe brauchen getrennte Ausgabepfade; die dokumentierten Befehle laufen nacheinander.

Der abschließende Dateiabgleich und Diff begrenzen TD-08 auf fünf neue Browser-/Konfigurationsdateien sowie Package-/Lockfile, Dockerfile, Ignore-Dateien und diese Dokumentation. Backend-/Frontend-/Shared-Anwendungscode, alle bestehenden Tests, Compose und der historische Auditbericht bleiben bytegleich gegenüber Beginn dieses Auftrags; Audit-SHA-256 weiterhin `e8a8304ce83f26660d630a6db1f5f4834f27158180142985ec22b2e4687cc827`. `git diff --check` bestanden. Eigene Dienste, Container, Volumes, Image-Tags, temporäre Buildkontexte/Fehlerproben und SQLite-Fixtures wurden entfernt; Browserinstallation und ignorierte Nachweisartefakte bleiben zur lokalen Nutzung. Prozess-/Docker-/Temp-Inventar bestätigt das Cleanup. Kein globales Cache-Pruning, Deployment, Push oder Commit.

## TD-09 – Gezielte Advisory-Behandlung

**Stand:** 13. Oktober 2026. Der historische TD-09-Befund wurde gegen die tatsächlich installierten Pakete und den aktuellen npm-Advisory-Dienst neu geprüft; seine frühere Risikoeinschätzung wurde nicht übernommen. Die vom Nutzer erlaubte Übertragung an npm umfasste die für den Abgleich erforderlichen Paketnamen/Versionen. Die bereitgestellten AGENTS-Regeln gelten; im Checkout und den geprüften Elternverzeichnissen liegt keine zusätzliche `AGENTS.md`.

### Bestand, Reichweite und Nachweisverfahren

`npm ls --all --json`, `npm explain` und Lockfile-Abgleich unterscheiden tatsächlich installierte direkte/transitive Pakete von optionalen Plattformauflösungen im Lockfile. Vorher: **175 unterschiedliche installierte Name/Version-Paare**, 251 `node_modules`-Lockeinträge. Nachher: **165 Paare**, 216 Lockeinträge. Workspacepakete `@pixelfleet/backend`, `frontend`, `shared` bleiben 1.0.0. Lokale Prüfung unter Node **24.20.0**, npm **11.19.0**. Die vollständigen Bäume, Advisory-JSONs und das Pfad-/Versionsinventar stehen als lokale, ignorierte Nachweise in `test-results/td09/`; die unten beschriebenen Befehle erzeugen sie erneut. Optionale Plattformpakete werden von `npm ci` passend zur jeweiligen Plattform installiert, nicht alle gleichzeitig.

| Direkte Dependency | Tatsächlich aufgelöst vorher → nachher | Verwendung |
| --- | --- | --- |
| `vite` | 7.3.3 → **7.3.6** | Frontend-Devserver, Preview, Produktionsbuild und Vitest-Transformation |
| `vitest` | 3.2.4 → **4.1.11** | Gesamte Source-/Backend-/React-Mountsuite |
| `concurrently` | 9.2.1 → **9.2.5** | Zwei lokale Entwicklungsprozesse, fest eingecheckte npm-Kommandos |
| `@playwright/test` | **1.64.0 unverändert** | Echte Browserprüfungen, ausschließlich Prüfstage/lokal |
| `jsdom` | **30.1.2 unverändert** | React-Mounttests; betroffenes `source-map-js` transitiv korrigiert |
| `@vitejs/plugin-react` | 5.2.0 unverändert | Babel/React-Transformation |
| `tsx` | 4.22.3 unverändert | Backend-Entwicklung; betroffenes esbuild transitiv korrigiert |
| `typescript` | 5.9.3 unverändert | Typecheck und Build |
| `@types/node`, `@types/react`, `@types/react-dom`, `@types/ws` | 24.12.4 / 19.2.15 / 19.2.3 / 8.18.1 unverändert | Nur TypeScript-Typen |
| `react`, `react-dom` | 19.2.6 / 19.2.6 unverändert | Im statischen Frontend gebündelt; keine Server-Node-Dependencies |
| `ws` | 8.21.0 unverändert | Einzige externe Backend-Runtime-Dependency |

Belegte Verwendung: [Rootbefehle](../package.json), [Frontendbefehle](../apps/frontend/package.json), [Vite-Konfiguration](../apps/frontend/vite.config.ts), [React-Mounttests](../tests/reconnect-integration.test.tsx), [Playwright-Konfiguration](../playwright.config.ts) und [Dockerstages](../Dockerfile). **Runtime:** Backend nutzt Node-eigenes SQLite und `ws`, Frontend enthält React; kein aktueller npm-Treffer. **Entwicklungsserver:** Vite war standardmäßig im LAN erreichbar (`0.0.0.0`), Backend-Entwicklung läuft über tsx. **Build-/Source-Testausführung:** Vite/PostCSS/Babel und Vitest/jsdom laufen mit Dateizugriff des Entwicklers bzw. Builders. **Browserprüfstages:** Playwright/Chromium führen echte lokale UI-Prüfungen mit Wegwerfdaten durch; die Tools sind im Browser-Prüfimage vorhanden, im finalen Runtime-Image nicht. Vitests Browser Mode ist hier nicht Playwright: er wird nicht verwendet.

**Einordnung, keine pauschale Entwarnung:** Aus Manifesten, Aufrufen und getesteten Datenflüssen ergibt sich kein nachgewiesener öffentlich erreichbarer Exploit für diese Build-/Testpakete. Das ist eine codebasierte Einschätzung, kein durchgeführter Angriffstest sämtlicher Hersteller-PoCs. Veränderte Quelldateien, Test-/Buildkonfigurationen, manipulierte Sourcemaps oder künftig aktivierte Toolserver können Voraussetzungen ändern. Fehlende Runtime-Reichweite beseitigt deshalb den Wartungsbedarf nicht. npm-Schweregrade werden nicht als Beweis projektspezifischer Ausnutzbarkeit übernommen.

### Advisories mit Voraussetzungen, Pfad und konkreter Behandlung

Gemeinsame Ursachen sind gruppiert; jede GHSA-ID ist einzeln eingeordnet. Pfade beginnen beim Rootprojekt. Mehrfach propagierte Meldungen für `concurrently`, `vitest` und `@vitest/mocker` zählen nicht als zusätzliche Ursachen.

**A – Vitest:** `vitest → @vitest/mocker` bzw. `vitest → tinypool`, direkte Vitest-Meldung am Rootpaket. Der Repositorybefehl ist ausschließlich `vitest run`, ohne UI/API-Server oder Vitest Browser Mode; kein Standalone-Mocker in Vite. Der alte Workerpool wird für die Tests tatsächlich genutzt. Keine vorgelagerte Prototype-Pollution-Primitivstelle wurde in diesem Auftrag nachgewiesen.

| Advisory / Primärquelle | Betroffene installierte Version | Voraussetzung und tatsächliche Verwendung | Korrigierte Version / Behandlung |
| --- | --- | --- | --- |
| [GHSA-82fw-gwwq-j7x9](https://github.com/vitest-dev/vitest/security/advisories/GHSA-82fw-gwwq-j7x9) | `vitest` und `@vitest/mocker` 3.2.4 | Redirect-Mock außerhalb der Dateifreigabe; unauthentifiziert über öffentliches Standalone-Plugin/HMR erreichbar, Vitest Browser Mode dagegen tokengebunden. Diese Server-/Pluginpfade werden hier nicht aktiviert; Modul ist trotzdem Teil der Prüfkette. | **4.1.11** für beide. Hersteller plant keinen Fix für die ältere 3.x-Reihe; gezielter Majorwechsel statt inkompatiblem Mocker-Override. |
| [GHSA-5xrq-8626-4rwp](https://github.com/vitest-dev/vitest/security/advisories/GHSA-5xrq-8626-4rwp) | `vitest` 3.2.4 | UI-/API-/Browser-Dateizugriff und Codeausführung bei laufendem Toolserver, insbesondere Windows oder Netzexposition. `vitest run` ohne diese Modi erfüllt die beschriebene Serverkonfiguration nicht. | Hersteller nennt **3.2.5 / 4.1.0**, aktueller npm-Bereich verlangt in 3.x mindestens **3.2.6**. **4.1.11** erfüllt beide Quellen; nicht allein auf die niedrigere Herstellergrenze verlassen. |
| [GHSA-5gmw-xhrv-c9v3](https://github.com/tinylibs/tinypool/security/advisories/GHSA-5gmw-xhrv-c9v3) | `tinypool` 1.1.1 | Bereits verschmutztes `Object.prototype.execArgv`/`env` wird in Workeroptionen materialisiert; möglicher Codeimport. Pool läuft in Source-/Reacttests, kein nachgewiesener fremdgesteuerter Pollutionpfad. | Fix **2.1.1**. Vitest 4 entfernt tinypool vollständig; keine zusätzliche Override-/Poolmigration. |
| [GHSA-85c8-ppgw-ccpr](https://github.com/tinylibs/tinypool/security/advisories/GHSA-85c8-ppgw-ccpr) | `tinypool` 1.1.1 | Verschmutztes `filename` bei `pool.run(task, options)` mit fehlender eigener Eigenschaft; `run(task)` ohne Optionen ist laut Hersteller nicht betroffen. Kein HTTP-/WS-Nutzereingabepfad zum Testpool. | Fix **2.1.2** (npm stuft auch 2.1.1 als betroffen ein). Paket mit Vitest 4 vollständig entfernt. |

**B – Vite/esbuild:** Root `vite`, `vite → esbuild` und `tsx → esbuild`. Vite verwendet esbuild für Transformation/Build, tsx zur TypeScript-Ausführung; kein eingecheckter `esbuild.serve`-/`servedir`-Aufruf. Vite selbst stellt den Entwicklungsserver bereit.

| Advisory / Primärquelle | Betroffene installierte Version | Voraussetzung und tatsächliche Verwendung | Korrigierte Version / Behandlung |
| --- | --- | --- | --- |
| [GHSA-fx2h-pf6j-xcff](https://github.com/vitejs/vite/security/advisories/GHSA-fx2h-pf6j-xcff) | `vite` 7.3.3 | Windows/NTFS-ADS bzw. 8.3-Namen umgehen `server.fs.deny`, wenn Server erreichbar und sensibles File im erlaubten Baum. Das bisherige LAN-Binding war real; lokale Nachweise laufen auf macOS/Linux, nicht Windows. | Vite **7.3.5**, gewählt **7.3.6**; zusätzlich Dev und Preview auf `127.0.0.1`. |
| [GHSA-v6wh-96g9-6wx3](https://github.com/vitejs/launch-editor/security/advisories/GHSA-v6wh-96g9-6wx3) | `vite` 7.3.3 (eingebundene Editor-Middleware, kein separat aufgelöstes `launch-editor`) | Windows + aktiviertes NTLM + erreichbare Open-in-editor-Middleware; manipulierte UNC-Anfrage kann NTLM-Hash an SMB-Ziel auslösen. Auch ein Browser auf dem lokalen Rechner kann Anfrage initiieren; Loopback allein ist kein Fix. | Vite **7.3.5** (launch-editor separat **2.14.1**). **7.3.6** enthält die Middlewarekorrektur. |
| [GHSA-g7r4-m6w7-qqqr](https://github.com/evanw/esbuild/security/advisories/GHSA-g7r4-m6w7-qqqr) | esbuild **0.28.0** unter tsx, **0.27.7** unter Vite | Windows + esbuild-eigener Entwicklungsserver mit `servedir`, Backslash-Traversal. Dieser Server wird hier nicht verwendet; beide Instanzen waren dennoch laut npm betroffen. | **0.28.1**. Vite **7.3.6** erlaubt esbuild 0.28 ausdrücklich; eine gemeinsame natürliche Auflösung 0.28.1 für Vite/tsx, alte verschachtelte 0.27.7-Instanz entfernt. Kein Override. |

**C – Babel-Browserziele:** `@vitejs/plugin-react → @babel/core → @babel/helper-compilation-targets → browserslist → baseline-browser-mapping`. Nur geprüfte Repo-/Toolkonfiguration, keine Web-API für Browserqueries oder Statistikdateien.

| Advisory / Primärquelle | Betroffene installierte Version | Voraussetzung und tatsächliche Verwendung | Korrigierte Version / Behandlung |
| --- | --- | --- | --- |
| [GHSA-c83g-rgw3-j3cx](https://github.com/browserslist/browserslist/security/advisories/GHSA-c83g-rgw3-j3cx) | `browserslist` 4.28.2 | Viele unterschiedliche Queries in langlebigem Prozess füllen unbegrenzte Ergebnis-/Parsercaches. Babel benutzt Browserziele in Dev/Build; kein durch Clients frei wählbarer Querypfad. | **4.28.7**, kompatibles transitive Patchupdate. |
| [GHSA-73wf-gq98-2v4g](https://github.com/browserslist/browserslist/security/advisories/GHSA-73wf-gq98-2v4g) | `browserslist` 4.28.2 | Manipulierte `browserslist-stats.json` (auch automatisch aus Elternverzeichnissen gesucht) oder `opts.stats`; Crash/Prototypänderung bei Normalisierung. Keine solche Datei/Option im Projekt, lokale/Builder-Dateien bleiben Vertrauensgrenze. | **4.28.7**, derselbe Fix als gemeinsame Ursache. |
| GHSA-w5vr-8v7q-w6rv – [Herstellerrelease 2.11.0](https://github.com/web-platform-dx/baseline-browser-mapping/releases/tag/v2.11.0) | `baseline-browser-mapping` 2.10.32 | Ungültige Parameterkombinationen beenden Node mit `process.exit`. Keine ungeprüften Spiel-/HTTP-Werte an diese API; Babeltransformation nutzt das Paket als Buildtool. | **2.11.0**, kompatibles Minorupdate ersetzt Prozessende durch behandelbaren Fehler. |

**D – PostCSS/nanoid/source-map-js:** `vite → postcss → nanoid/source-map-js`. Zusätzlich `jsdom → css-tree → source-map-js`, einschließlich css-tree über `@asamuzakjp/dom-selector`, `@bramus/specificity` und `@csstools/css-syntax-patches-for-csstree`. Dieselbe hoisted source-map-js-Instanz wird für beide Bäume korrigiert. PostCSS verarbeitet eigene CSS-Dateien in Dev/Build; jsdom mountet unsere App in Source-Tests, kein öffentlicher Sourcemap-/CSS-Konvertierungsdienst.

| Advisory / Primärquelle | Betroffene installierte Version | Voraussetzung und tatsächliche Verwendung | Korrigierte Version / Behandlung |
| --- | --- | --- | --- |
| [GHSA-r28c-9q8g-f849](https://github.com/postcss/postcss/security/advisories/GHSA-r28c-9q8g-f849) | `postcss` 8.5.15 | Fremdes CSS mit `sourceMappingURL` und automatischem Map-Laden kann Dateien außerhalb des CSS-Verzeichnisses lesen und `sourcesContent` weitergeben. Vite verarbeitet eingechecktes CSS; keine API nimmt fremdes CSS an. | **8.5.18** für diesen Treffer; gewählt **8.5.23** wegen des folgenden unvollständigen Fixes. |
| [GHSA-fxqj-rqcc-2cmp](https://github.com/postcss/postcss/security/advisories/GHSA-fxqj-rqcc-2cmp) | `postcss` 8.5.15 | Ohne `from` fehlen Traversalprüfungen beim Laden fremder `.map`-Referenz. Kein eigener beliebiger `postcss.process(userCss)`-Pfad; Build-/Dev-Dateigrenze relevant. | **8.5.23**, kompatibles Patchupdate behebt beide PostCSS-Treffer. |
| GHSA-28wg-ghj8-5hjv – [Herstellerrelease 3.3.16](https://github.com/ai/nanoid/releases/tag/3.3.16) | `nanoid` 3.3.12 | Negative Größen in nicht kryptografischem Generator verursachen Endlosschleife. PostCSS ruft `nanoid/non-secure` mit fester Größe **6** auf (`lib/input.js`), nicht mit Account-/HTTP-Werten. | **3.3.16**, gewählt **3.3.18** für beide Nano-ID-Advisories. |
| GHSA-2v37-7h3g-55p8 – [Herstellerfix 3.3.17](https://github.com/ai/nanoid/releases/tag/3.3.17), [3.3.18](https://github.com/ai/nanoid/releases/tag/3.3.18) | `nanoid` 3.3.12 | Größe Null in Customgenerator; PostCSS verwendet keinen fremdgesteuerten Customgenerator. | 3.3.17 korrigiert den Hauptpfad, 3.3.18 den verbleibenden Async-Pfad; aktueller npm-Bereich fordert **3.3.18**, diese Version gewählt. |
| GHSA-68fv-2mgg-jv7q – [Herstellerfix/Tests](https://github.com/7rulnik/source-map-js/pull/79), [Release 1.2.2](https://github.com/7rulnik/source-map-js/releases/tag/v1.2.2) | `source-map-js` 1.2.1, beide oben genannten Dependencybäume | Manipulierte indexed Sourcemaps mit extremen Sectionoffsets bzw. verschachtelten Maps können CPU/Heap erschöpfen. Build und CSS-Baum der Reacttests enthalten die Bibliothek; kein nachgewiesener Nutzereingabepfad zu diesem Consumer. | **1.2.2**, eine gemeinsame kompatible Auflösung. jsdom selbst bleibt 30.1.2. |

**E – concurrently/shell-quote:** `concurrently → shell-quote`. Die Entwicklungsbefehle sind im Manifest fest vorgegeben, keine HTTP-/WS-Nutzerwerte gelangen in diese CLI. In `concurrently/dist/src/command-parser/expand-arguments.js` wird shell-quote zur Argumentbehandlung importiert; kein projektspezifischer `quote(parse(untrustedCommand).concat(untrustedArg))`-Aufruf. Trotzdem gezielte Behebung statt dauerhafter Ausnahme.

| Advisory / Primärquelle | Betroffene installierte Version | Voraussetzung und tatsächliche Verwendung | Korrigierte Version / Behandlung |
| --- | --- | --- | --- |
| [GHSA-w7jw-789q-3m8p](https://github.com/ljharb/shell-quote/security/advisories/GHSA-w7jw-789q-3m8p) | `shell-quote` 1.8.3 | Fremdgesteuerte Objekt-Tokens mit Zeilenumbruch in `.op` an `quote()`, anschließend Shellausführung. Keine solche Eingabe im eingecheckten Devbefehl. | **1.8.4**, final **1.12.0** über concurrently 9.2.5. |
| [GHSA-395f-4hp3-45gv](https://github.com/ljharb/shell-quote/security/advisories/GHSA-395f-4hp3-45gv) | `shell-quote` 1.8.3 | Große fremde Commandstrings verursachen quadratische `parse()`-Arbeit. Repo startet zwei kurze feste Commands. | **1.9.0**, final **1.12.0**. |
| [GHSA-pqg4-j6r4-53mv](https://github.com/ljharb/shell-quote/security/advisories/GHSA-pqg4-j6r4-53mv) | **1.9.0 im geprüften Zwischenstand**, 1.8.3 liegt außerhalb des npm-Bereichs dieses zusätzlichen Treffers | Zeilenumbruch in String nach `{ comment }`-Token in `quote()` kann Shellbefehle injizieren. Keine projektspezifischen fremden Tokens; dieser Treffer wurde erst durch den Wiederholungsabgleich sichtbar. | **1.11.0**. concurrently 9.2.4 pinnt noch 1.9.0; kleinste passende Hersteller-Patchversion **9.2.5** pinnt korrigiertes **1.12.0**. Kein Override. |

Damit sind **17 unterschiedliche ursprüngliche Advisories plus eine im Zwischenstand neu relevante GHSA** nachvollziehbar behandelt. Unterschiede zwischen aktuellen npm-Bereichen und Herstellergrenzen sind oben ausdrücklich erfasst; die finalen Versionen erfüllen jeweils die strengere einschlägige Grenze. Kein Treffer wurde allein wegen „nur dev“ oder durch npm-Schweregrade ausgeschlossen.

### Versionsentscheidungen und begrenzte Migration

Root-Manifeste pinnen nur die drei geänderten Direktpakete auf die geprüften Versionen: Vite 7.3.6, Vitest 4.1.11, concurrently 9.2.5. Alle übrigen direkten Versionen bleiben erhalten. Die transitiven Korrekturen sind im Lockfile, ohne neue Direktdependencies oder Overrides.

- [Vite-7.3.6-Changelog](https://github.com/vitejs/vite/blob/v7.3.6/packages/vite/CHANGELOG.md): 7.3.5 behebt beide Vite-Treffer, erst 7.3.6 erlaubt esbuild 0.28 regulär. Kein Vite-8-Majorwechsel nötig.
- [Vitest-4-Migration](https://v4.vitest.dev/guide/migration#pool-rework) und [Release 4.1.11](https://github.com/vitest-dev/vitest/releases/tag/v4.1.11): Vite ≥6/Node ≥20 erfüllt; tinypool vollständig entfernt. Dieses Repo besitzt keine Legacy-`poolOptions`, Workspace-Testkonfiguration, Custompools, Coverageprovider, Browser-Mode-Provider oder eigenen Reporter. Alle 13 Testdateien mit Fake-Timern, Mocks, echten React-Mounts und Backend-Unterprozessen bestehen unverändert. Kein Test wurde abgeschwächt oder ausgeschlossen; `.browser.ts` bleibt ausschließlich Playwright. Keine unabhängige größere Migration nötig.
- [concurrently 9.2.5](https://github.com/open-cli-tools/concurrently/releases/tag/v9.2.5): notwendiges Patchupdate auf Shell-Quote 1.12.0 statt Override eines exakt gepinnten Herstellerpakets.
- Browserslist 4.28.7 verlangt mindestens `caniuse-lite` 1.0.30001806, `electron-to-chromium` 1.5.393 und `node-releases` 2.0.51. Genau diese notwendigen Datenupdates statt pauschaler Aktualisierung; `update-browserslist-db` bleibt 1.2.3.
- Vitestbedingt: `@vitest/*` 3.2.4 → 4.1.11, Chai 5.3.3 → 6.3.0, es-module-lexer 1.7.0 → 2.3.2, std-env 3.10.0 → 4.3.0, tinyexec 0.3.2 → 1.3.1, tinyrainbow 2.0.0 → 3.2.0; neu obug 2.2.1 und `@standard-schema/spec` 1.1.0. Alte exklusive Vitest-Abhängigkeiten cac/check-error/deep-eql/loupe/pathval/strip-literal/tinyspy/vite-node/tinypool entfallen. Esbuild-Plattformpakete wechseln zusammen mit 0.28.1; die zweite 0.27.7-Plattformgruppe entfällt durch Deduplication.

`npm audit fix --force` und allgemeine Dependencyupdates wurden nicht verwendet. Ein erster gezielter `npm update` löste zusätzlich neuere kompatible Versionen auf; vor dem endgültigen `npm ci` wurden diese auf die oben begründeten korrigierten Versionen begrenzt. Kurzzeitige Auflösungsspezifikationen wurden entfernt; endgültige Direktdependencies sind ausschließlich die ursprünglichen plus deren drei Versionsänderungen. Gemeinsame Lockeinträge ohne Versionswechsel bleiben bis auf die Root-Spezifikation vollständig identisch. Der final geprüfte Lockfile-Diff enthält **2 neue, 37 entfernte, 51 aktualisierte Einträge**, darunter 26 zusammengehörige esbuild-Plattformpakete; keine fremden Quellen/Registrywechsel und kein unbeteiligter Versionschurn.

Playwright bleibt durchgängig **1.64.0** (`@playwright/test`, `playwright`, `playwright-core`), Chromium Headless Shell **156.0.8078.4 / Revision 1248**, FFmpeg Revision 1013. `browser:install` bestätigt/lädt genau die zu diesem Paket gehörenden Revisionen während Vorbereitung; Testläufe laden nichts nach. Dockerfile, Prüfmarker und Runtime-Copies bleiben für TD-09 bytegleich. Die beiden Vite-Skripte binden ausdrücklich `127.0.0.1`; dokumentierter LAN-Aufruf überschreibt dies bewusst mit `--host 0.0.0.0`. Backendbinding und Spielregeln bleiben erhalten.

### Ausführbare Prüfungen und Ergebnis

```bash
npm ci --no-audit --no-fund
npm ls --all --json
npm explain @vitest/mocker browserslist baseline-browser-mapping shell-quote postcss source-map-js nanoid esbuild
npm audit --json
npm audit --omit=dev --json
npm run verify
npm run browser:install
npm run browser:test
docker build --no-cache --progress=plain --target runtime -t pixelfleet:td09-check .
# Danach isolierte Containerprüfung/Cleanup gemäß docs/dokploy.md durchführen.
```

| Prüfung | Ergebnis |
| --- | --- |
| Vorheriger neuer npm-Abgleich | **12 Paketmeldungen**, davon low 1 / moderate 2 / high 5 / critical 4; **17** unterschiedliche GHSAs. Runtime `--omit=dev`: **0**. |
| Wiederholter Abgleich nach Zwischenstand | Zwei propagierte critical-Paketmeldungen für eine zusätzliche GHSA-pqg4-j6r4-53mv unter Shell-Quote 1.9.0; durch concurrently 9.2.5 behoben, keine Ausnahme belassen. |
| Finale npm-Abgleiche | `npm audit` **0**, `npm audit --omit=dev` **0**, beide Exitcode 0. |
| Reproduzierbarkeit/Paketbaum | Finales `npm ci` Exitcode 0, `npm ls --all` Exitcode 0; keine ungültigen Peer-/fehlenden Dependencies. Playwright/jsdom und alle Runtimeversionen erhalten. |
| Source-Gate | **232/232 Tests in 13/13 Dateien**, Typecheck einschließlich Browsercode, Produktionsbuild erfolgreich unter Vitest 4.1.11 / Vite 7.3.6. |
| Browser | Finale Chromium-Suite **5/5** erfolgreich gegen echten Produktionsbuild/Backend, keine Retries. Lokal identische Browserrevision vorbereitet. |
| Loopback/LAN | Eigene kurzlebige Dev-/Previewprozesse: je HTTP 200, `lsof` bestätigt Default **127.0.0.1** und ausdrücklichen LAN-Override **\***. Alle vier Prozesse beendet. |
| Docker-Releasepfad | Finaler Paketstand: Source-Gate unter Node 24 ohne Cache **232/232**, Typecheck/Build sowie Runtime-Healthcheck → vollständiger Match-Smoke (**350/465 XP**) → Healthcheck → Shutdown 0 erfolgreich. Erste Browservorbereitung scheiterte an externem Debian-Download; erneuter Build nutzte identische erfolgreiche Source-/Runtime-Stages aus Cache, installierte die passenden Browser/Systembibliotheken und bestand **5/5 Chromiumfälle** mit `--network=none`. Finaler `runtime`-Export erfolgreich, Digest `sha256:e067cdafd6ebbde9f5059c8e99f87040e8cae3a5a8945e643099480918ce8aee`. Keine Prüfung übersprungen oder Gateabhängigkeit verändert. |
| Exportiertes Image | Eigener zusätzlicher Container mit neuer temporärer Volume, Netzwerk `none`, read-only Root, entfernten Capabilities und `no-new-privileges`: Docker **healthy**, explizite Healthchecks vor/nach vollständigem Smoke, **350/465 XP**, genau ein persistenter Matchabschluss, Schema 1, geordneter Shutdown **0**. Node **24.21.0**, UID **1000**. |
| Runtime-Inhalt | Installierte Projektmodule nur `@pixelfleet/backend`, `@pixelfleet/shared`, `ws`; interner Produktionslock enthält keine `dev`-Einträge. Keine Playwright-/Vitest-/jsdom-/Vite-/TypeScriptpakete, Testdateien, Browser-Caches/Binärdateien, Browserkonfiguration, Prüf-/Smoketreiber, Reports oder Gate-Marker. Browserstage wird nicht zur Runtimebasis. |
| Diff und Ressourcen | Sechs geänderte Dateien gegenüber dem TD-09-Ausgangsinventar: Root-/Frontendmanifest, Lockfile, README, Dokploy-Anleitung und dieser Sanierungsbericht. Alle Anwendungssourcen, vorhandenen Tests, Dockerfile/Ignore/Compose und sonstigen versionierten/unversionierten Nutzerdateien bleiben erhalten. `git diff --check` bestanden. Eigene Prozesse, Container, Volume und Image-Tag entfernt; temporäre SQLite-Fixtures durch Test-Cleanup entfernt. |

### Grenzen, offene Punkte und Abschluss

**TD-09 ist im beauftragten Umfang behoben und lokal verifiziert.** Im finalen Abgleich bleiben keine unbehandelten npm-Treffer; beide Runtime- und Gesamtberichte sind leer. Das beweist keine allgemeine Schwachstellenfreiheit. Es ist kein neuer vollständiger Security-Audit und kein systematischer Windows-PoC-Nachweis. Browserengine, Node-Basisimage, Debianbibliotheken und unbekannte/noch unveröffentlichte Advisories werden durch npm audit nicht erfasst. Der Node-24-Tag und Debianrepositories bleiben wie bisher fortlaufend, keine bitidentische OS-Reproduzierbarkeit wird behauptet.

**Konkrete nächste Schritte außerhalb dieses lokalen Auftrags:** Vor einer Auslieferung beide npm-Abgleiche erneut ausführen, bei neuen Treffern die hier dokumentierten Pfade/Angriffsvoraussetzungen erneut einordnen und denselben vollständigen Releasepfad verwenden. Für eine Playwright-Änderung immer zusammengehörige npm-Versionen und Browservorbereitung aktualisieren. Der LAN-Modus bleibt eine ausdrückliche Entscheidung; die korrigierten Versionen auch dafür beibehalten. Externe Dokploy-/Branch-/Revieweinstellungen sind weiterhin mangels Zugang unbestätigt: `runtime` als Ziel, verpflichtende Prüfmarker, keine Buildfehler-Fallbacks und die TD-03/TD-08-Negativprobe in einem eigenen Dokploy-Testservice gemäß Deployment-Anleitung verifizieren. Keine neue Infrastruktur oder unabhängige größere Migration ist dafür implementiert oder als notwendig behauptet.

Historischer Auditbericht unverändert, SHA-256 `e8a8304ce83f26660d630a6db1f5f4834f27158180142985ec22b2e4687cc827`. Die vollständig erhaltenen TD-01 bis TD-08-Korrekturen werden zusätzlich durch alle bestehenden Gates geprüft. Lokale Nachweise bleiben unter ignoriertem `test-results/td09/`; vorhandene Browserinstallation und andere Nutzerartefakte bleiben erhalten. Keine globalen Cache-/Dockerbereinigungen, kein Deployment, Push oder Commit.

## Abschlussreview – Verbliebene Fehlergrenze von GET /metrics

**Stand:** 13. Oktober 2026 · **Status:** Der bestätigte P2-Reviewbefund zu TD-07 ist behoben und lokal verifiziert. Die früheren Abschnitte beschreiben weiterhin ihre jeweiligen Auftragsstände.

### Befund, Korrektur und Regression

Der Abschlussreview zeigte eine verbliebene Lücke: `GET /metrics` setzte per `writeHead(200)` die Header, bevor `metricGauges()` die Datenbank las und `metrics.prometheus()` den vollständigen Text erzeugte. Ein Datenbankfehler gelangte zwar in die bestehende HTTP-Fehlergrenze, konnte dort aber nur noch einen Verbindungsabbruch auslösen. Die erwartete generische 500 samt öffentlicher Request-ID und 5xx-Zählung fehlte.

Der neue [Regressionstest](/Users/noahbauditz/Documents/Projects/PixelFleet/tests/deployment.test.ts:407) wurde zuerst mit unverändertem Anwendungscode ausgeführt: **ein Fehlschlag, 37 durch den Filter ausgelassene Fälle**, Exitcode 1. Beim authentifizierten `GET /metrics` scheiterte `fetch` mit **`UND_ERR_SOCKET` / `other side closed`**. Die Ursache wurde ausschließlich in einer eigenen temporären SQLite-Fixture durch Umbenennen von `users` erzeugt; die Tabelle wurde im `finally` wiederhergestellt und die Fixtureverbindung geschlossen. Der bestehende Test-Cleanup beendete den eigenen Backend-Unterprozess und entfernte die Datenbank samt temporärem Verzeichnis auch im roten Lauf.

Die [Korrektur](/Users/noahbauditz/Documents/Projects/PixelFleet/apps/backend/src/server.ts:198) berechnet den vollständigen Prometheus-Text vor `writeHead()`. Erst danach werden Status 200, der bestehende Content-Type und der Text gesendet. Berechnungsfehler werden unverändert von der vorhandenen HTTP-Fehlergrenze behandelt; es gibt keinen zusätzlichen Catch oder eine zweite Fehlerzählung. Authentifizierung, Quoten und erfolgreiche Prometheus-Ausgabe bleiben erhalten.

Mit derselben unveränderten Testassertion bestehen nun folgende Nachweise:

- Fehlende Adminauthentifizierung liefert weiterhin 401.
- Der injizierte Datenbankfehler liefert eine vollständige JSON-500 mit ausschließlich `Internal server error.` und einer serverseitigen Request-ID. Ein Verbindungsabbruch lässt den Test scheitern und gilt nicht als Ersatzantwort.
- Header-ID, JSON-ID und das einzige interne Fehlerereignis stimmen überein; die vom Client eingesandte ID wird nicht übernommen. Das Ereignis meldet die Route `metrics`, einen Datenbankfehler und noch nicht gestartete Header.
- Prometheus und die spätere JSON-Metrikansicht bestätigen **genau einen** 5xx-Fehler. Gesamtfehler sind zwei: die separat geprüfte 401 und diese 500. Tokens, Client-ID, Fixturepfad/-tabellenname und SQL-Details erscheinen weder öffentlich noch im Diagnoseereignis.
- Health bleibt auch während des Fehlers 200. Nach Wiederherstellung liefert dieselbe authentifizierte Route wieder 200 mit `text/plain; version=0.0.4; charset=utf-8`, gültigen Users-/Sessions-Gauges und erhaltenen Zählern. Derselbe Gastaccount ist über `/api/me` weiter benutzbar. Der Backendprozess beendet sich anschließend regulär mit Exitcode 0.

### Prüfkommandos und Ergebnis

```sh
./node_modules/.bin/vitest run tests/deployment.test.ts -t 'metrics gauge failure' --reporter=dot
npm run verify
git diff --check
```

| Prüfung | Ergebnis |
| --- | --- |
| Gezielter Regressionstest nach Korrektur | **1 bestanden**, 37 durch Filter ausgelassen, Exitcode 0. |
| `npm run verify`, Node 24.20.0 | **233/233 Tests in 13 Dateien**, vollständiger Typecheck einschließlich Browsercode und Produktionsbuild erfolgreich. |
| Diff und Bestand | Zusätzliche Änderungen ausschließlich in `server.ts`, `deployment.test.ts` und diesem Bericht. Alle übrigen erfassten Nutzerdateien bleiben bytegleich; `git diff --check` bestanden. |

### U-04 und verbleibende Grenzen

**U-04 ist durch TD-05 erledigt.** Der bereits vorhandene [Migrationspfad](/Users/noahbauditz/Documents/Projects/PixelFleet/apps/backend/src/migrations.ts:18) führt Neuinstallation und unversionierten Altbestand transaktional auf Schema 1, erhält bestehende Daten, bleibt beim erneuten Start unverändert und lehnt unbekannte neuere Versionen vor Änderungen ab. Die [sechs Migrationstestfälle](/Users/noahbauditz/Documents/Projects/PixelFleet/tests/migrations.test.ts:52) bestehen im aktuellen vollständigen Lauf, einschließlich fehlgeschlagener Migration und anschließendem Wiederholungsversuch. Dafür wurde in diesem Folgeauftrag kein Migrationscode verändert. Der ausstehende Nachweis eines tatsächlichen Produktionsbackups und dessen Restore gehört weiterhin zu U-02 und öffnet U-04 nicht erneut.

Browser-Suite und Docker-Releasepfad wurden für diese eng begrenzte Korrektur nicht erneut ausgeführt; deren vorhandene Gates bleiben unverändert. Es wird keine neue Produktions-/Dokploy-Verifikation oder allgemeine Fehlerfreiheit behauptet. Der historische Auditbericht bleibt unverändert mit SHA-256 `e8a8304ce83f26660d630a6db1f5f4834f27158180142985ec22b2e4687cc827`. Eigene Testprozesse und SQLite-Fixtures wurden entfernt; vorhandene Nutzerdateien, Browserinstallationen und frühere Nachweise bleiben erhalten. Kein Deployment, Push oder Commit.

## Abschluss – Unabhängiger Nachreview und finale Releaseverifikation

**Stand:** 13. Oktober 2026 · **Status:** Keine offenen Implementierungsbefunde aus Abschlussreview und Nachreview; vollständiger lokaler Releasepfad am abschließenden Anwendungsstand erfolgreich. Die vorstehenden Abschnitte bleiben historische Nachweise ihrer jeweiligen Aufträge.

### Unabhängiger Nachreview

Der Nachreview hat die vollständige Metrikberechnung vor dem Header-Commit, die bestehende HTTP-Fehlergrenze und den hinzugekommenen Regressionstest unabhängig geprüft. Der isolierte Datenbankfehler liefert eine vollständige generische 500; Header, Antwort und internes Ereignis tragen dieselbe serverseitige Request-ID. Die 5xx-Zählung erfolgt genau einmal. Nach Fixture-Reparatur funktionieren dieselbe Prometheus-Route und die bestehende Session wieder; ein Verbindungsabbruch würde den Test scheitern lassen. Der gezielte Regressionstest und beide zusätzlichen Metriktests bestanden erneut, insgesamt **3/3**. Es wurden keine weiteren konkreten Fehler oder Commit-Hindernisse im hinzugekommenen Diff gefunden. **Der P2-Befund ist geschlossen. U-04 bleibt durch TD-05 erledigt.**

### Finale Verifikation des aktuellen Stands

Der vollständige unterstützte Releasepfad wurde erneut **ohne Cache** ausgeführt:

```sh
docker build --no-cache --progress=plain --target runtime \
  -t pixelfleet:final-remediation-20261013 .
```

Anschließend wurde das exportierte Image gemäß [lokaler Containerprüfung in der Deployment-Anleitung](/Users/noahbauditz/Documents/Projects/PixelFleet/docs/dokploy.md:601) zusätzlich mit eigenem Container und neuem temporärem Volume geprüft. Es wurden keine vorhandenen Datenbanken oder Volumes verwendet. Keine Hostports, Netzwerk `none`, read-only Root-Dateisystem, entfernte Capabilities und `no-new-privileges`; Ausführung als UID 1000 unter Node **24.21.0**, Docker Engine **29.8.2**, Linux ARM64.

| Prüfung | Abschließendes Ergebnis |
| --- | --- |
| Installation und Source-Gate | Frische `npm ci`-Installationen; **233/233 Tests in 13 Dateien**, vollständiger Typecheck einschließlich Browsercode und Produktionsbuild erfolgreich. Source-Prüfung mit `--network=none`. |
| Browser-Gate | **5/5 Chromiumfälle**, keine Retries: Gastlogin/Logout; vollständige UI-Partie mit zwei Spielern und beiden Ergebnissen; Queue-Abbruch/Reconnect; Platzierungsentwurf und laufende Partie nach Reconnect; Backendneustart mit gültiger Session und expliziter Lobby. Passende Chromium-Revision 1248 und FFmpeg 1013 während Vorbereitung geladen; Testausführung ohne externes Netzwerk. |
| Runtime-Gate im Build | Healthcheck → vollständiger Match-Smoke mit **350/465 XP** → erneuter Healthcheck → regulärer Backend-Shutdown **0**. Finale Stage mit beiden Prüfmarkern erfolgreich exportiert. |
| Exportiertes Image, zusätzliche Containerprüfung | Docker-Healthstatus **healthy**, explizite Healthchecks vor und nach vollständigem Match-Smoke; beide Ergebnisse und **350/465 XP** bestätigt; Shutdown **Exitcode 0**, kein OOM-Kill. |
| Runtime-Inhalt | Installierte Projektmodule ausschließlich `@pixelfleet/backend`, `@pixelfleet/shared`, `ws`; interner Produktionslock ohne `dev`-Einträge. Keine Testdateien, Browserinstallation, Prüf-/Smoketreiber, Browserkonfiguration, Reports oder Prüfmarker im Runtime-Dateisystem. |
| Exportidentität | Image-Digest `sha256:530b59deb06866d782f001f117c7ecfe09caf692195e619fe6a8feddbfc74a47`. Eigener Image-Tag nach Verifikation entfernt. |
| Bestand und Cleanup | Alle **88** vorab erfassten Dateien nach den Tests bytegleich. Eigener Container, temporäres Volume, Image-Tag und temporärer Prüfcontroller entfernt; Build-/Testfixtures durch ihren Lebenszyklus bereinigt. Keine globale Docker-/Cachebereinigung. `git diff --check` bestanden. |

Die lokalen Logs und das Dateiinventar liegen ausschließlich unter ignoriertem `test-results/final-remediation-20261013/`. Der einzige zusätzliche Dokumentationsdiff dieses Abschlussauftrags ist dieser Abschnitt; Anwendungscode, Tests, Abhängigkeiten und Releasekonfiguration wurden nicht erneut verändert.

### Commitauswahl und verbleibende externe Nachweise

Die geprüfte Auswahl für den zusammenhängenden Commit `fix: resolves technical debt findings` umfasst **46 Dateien**: 31 bereits geänderte Dateien und 15 neue Implementierungs-, Test-, Konfigurations- und Dokumentationsdateien einschließlich historischem Audit und Sanierungsbericht. Ausgangsbranch war `main`; vorgesehen ist `fix/tech-debt-remediation`. `.agents/`, `skills-lock.json`, ignorierte Testartefakte und unabhängige Nutzerdateien sind ausdrücklich ausgeschlossen. Der historische Auditbericht bleibt bytegleich, SHA-256 `e8a8304ce83f26660d630a6db1f5f4834f27158180142985ec22b2e4687cc827`.

Der Stand ist aus Reviewsicht commitbereit. **Externe Dokploy-/Repository-, Proxy- und Backup-/Restore-Nachweise bleiben offen**; die lokalen Prüfungen bestätigen keine aktive Produktionsfreigabesicherung. Die konkreten Dokploy-Schritte und Betriebsgrenzen in der Deployment-Anleitung bleiben maßgeblich. U-01 bis U-03 und U-05 bleiben entsprechend dem Abschlussreview externe Prüfungen bzw. Produkt-/Aufbewahrungsentscheidungen; sie sind keine neu bestätigten Implementierungsbefunde. Kein Push und kein Deployment in diesem Abschlussauftrag.
