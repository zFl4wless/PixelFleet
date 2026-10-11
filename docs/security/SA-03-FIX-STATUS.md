# SA-03: Eindeutige aktive Matchmitgliedschaft

Stand: 2026-10-11. Normaler lokaler Entwicklungsauftrag, ausschließlich SA-03 aus `~/security-audit-skill/PixelFleet/run-1/SESSION-AUTH-STATIC.md`. Ausgangscommit: `8f456f394405a68f16cd7e72ef6a183f20e8508f` (`fix: revokes websocket permissions when sessions end`), Arbeitsbaum zu Beginn sauber. SA-07 und SA-01/SA-02 sind separat committet. Die zuvor vom Nutzer gemeldeten **42/42 bestandenen Tests** gehören zum Ausgangsstand und sind kein Testergebnis für diesen SA-03-Fix.

**Status:** SA-03 implementiert; die vollständige Suite mit **50/50 Tests ist bestanden, vom Nutzer ausgeführt und am 2026-10-11 gemeldet**. Das umfasst die native HTTP-/WebSocket-Validierung. Codex hat diesen manuellen Lauf nicht selbst ausgeführt oder unabhängig beobachtet. Keine weiteren Audit-Punkte bearbeitet, kein Push, kein Deployment. Der ursprüngliche Vollaudit bleibt **incomplete**. Separater Commit vorgesehen: `fix: separates active matches from retained results`.

## Beobachtung am Ausgangsstand

`findMatchForUser` in `apps/backend/src/game-hub.ts:459` wählte den ersten gespeicherten, nicht verlassenen Treffer unabhängig von dessen Phase. `joinQueue:245` erlaubte bei einem abgeschlossenen Treffer die erneute Teilnahme, während `requireActiveMatch:451`, `connect:111`, `disconnect:159` und `leaveMatch:429` weiterhin denselben alten Treffer auswählten. Ein aufbewahrtes Ergebnis konnte so ein neues aktives Match verdecken und die Queueprüfung für einen bereits aktiven Spieler passieren lassen. Die Aussage aus dem statischen Bericht ist am aktuellen Ausgangscommit weiterhin zutreffend. Daraus wird keine beobachtete Auswirkung auf ein produktives System abgeleitet.

## Korrektur und Invarianten

- `apps/backend/src/game-hub.ts:81`: Ein eigener Index `activeMatchByUser` ordnet jedem Spieler höchstens eine aktive Match-ID zu. Die bestehende Matchsammlung bewahrt weiterhin abgeschlossene Ergebnisse auf.
- `apps/backend/src/game-hub.ts:247`, `:273`: Queuezulassung und Gegnerauswahl verwenden die aktive Zuordnung. Vor Matchanlage wird für beide Teilnehmer geprüft, dass sie verschieden und frei sind. Nach erfolgreicher Anlage werden beide Zuordnungen gesetzt und beide Queueeinträge entfernt. Abgeschlossene Ergebnisse blockieren eine neue Teilnahme nicht und erlauben keine zusätzliche Teilnahme neben einem aktiven Match.
- `apps/backend/src/game-hub.ts:471`: Die gemeinsame aktive Auflösung prüft, dass das referenzierte Match vorhanden, nicht abgeschlossen und der Spieler tatsächlich Teilnehmer ist. Widersprüchliche vorhandene Indexeinträge werden mit einem Fehler abgewiesen; es gibt keinen Fallback auf einen beliebigen gespeicherten Treffer.
- `apps/backend/src/game-hub.ts:112`, `:160`, `:441`, `:464`: Reconnect, Disconnect, Leave, Flottenplatzierung und Schüsse verwenden dieselbe aktive Zuordnung. Nur wenn keine aktive Zuordnung besteht, dürfen Disconnect und Leave ein abgeschlossenes Ergebnis zur bisherigen Bereinigung auswählen (`findFinishedMatchForUser:483`).
- `apps/backend/src/game-hub.ts:396`: Jeder Abschlussweg entfernt beide aktiven Zuordnungen. Entfernt wird nur eine noch auf genau dieses Match zeigende Zuordnung. Das gilt für reguläres Spielende, Leave-Forfeit und Disconnect-Timeout. Ergebnisse, Profil-/XP-Aktualisierung und `match_finished`-Nachrichten bleiben erhalten.
- `apps/backend/src/game-hub.ts:701`: Runtime-Reset löscht neben Matches, Queue und Reconnect-Timern auch die aktiven Zuordnungen.

Reconnect behält das bestehende 30-Sekunden-Fenster bei und hebt den Offline-Zustand im neuen aktiven Match auf. Bei Ablauf ohne Reconnect tritt weiterhin Forfeit ein. Ergebnisanzeige und Bestätigung/Bereinigung ohne aktives Match bleiben erhalten. Nachrichtenformat, Sessionautorisierung, Spielregeln, Limits, Datenbankschema, Frontend und Deployment wurden nicht geändert.

## Regressionstests

`tests/match-membership.test.ts` prüft ausschließlich über Hub-Einstieg, Nachrichten, öffentliche Matchansichten, Hubstatistik und temporäre Datenbankprofile; keine Inspektion privater Maps. Das kontrollierte Socketmodell verwendet keine Netzwerklistener. Sieben Fälle:

1. Aufbewahrtes Forfeit-Ergebnis, danach neues Match: Flottenplatzierung, Zugwechsel, Schuss und Leave wirken auf das neue Match; alte Ergebnisnachrichten und alter Gegner bleiben erhalten.
2. Wiederholtes Queuebetreten beider aktiver Teilnehmer wird abgewiesen. Zwei weitere Spieler können ein eigenes Match starten, ohne die bestehende Zuordnung zu ändern.
3. Disconnect und Reconnect betreffen das neue Match trotz altem Ergebnis; Reconnect löscht dessen Frist, ein späterer Disconnect führt regulär zum Forfeit.
4. Disconnect-Timeout gibt beide Mitgliedschaften frei; dieselben Teilnehmer können danach wieder zusammen spielen.
5. Vollständiges reguläres Spielende durch versenkte Schiffe liefert weiterhin Ergebnisse und gibt beide Teilnehmer für ein neues Match frei.
6. Ohne aktives Match bleiben Ergebnisbestätigung und Bereinigung verfügbar; Spielaktionen ohne aktive Mitgliedschaft werden abgewiesen.
7. Runtime-Reset entfernt aktive Zuordnungen und alte Disconnect-Timer; frische Verbindungen können anschließend wieder spielen.

`tests/deployment.test.ts:153` ergänzt einen nativen lokalen HTTP-/WebSocket-Test: Dummy-Login, erstes Match, Forfeit mit aufbewahrtem Ergebnis, neues Match, Disconnect und Reconnect mit derselben Session in das neue Match. Im historischen Codex-Lauf wurde dieses Szenario wegen der Listenerbeschränkung nicht erreicht; laut dem vom Nutzer gemeldeten vollständigen Lauf ist es inzwischen bestanden.

## Testumgebung und ausgeführte Prüfungen

Vor Ausführung wurden npm-Skripte, Vite-Buildkonfiguration und alle Testhelfer geprüft. Neue und vorhandene Hubtests setzen `DATABASE_PATH` vor dem Datenbankimport auf ihre eigene temporäre SQLite-Datei und schließen/entfernen sie nach dem Lauf. Deploymenttests erzeugen ausschließlich temporäre Fixture-Datenbanken, Dummy-Konten, Dummy-Admin-Token und Fixture-HTML; HTTP-/WebSocket-Ziele stammen aus dem lokalen Server mit zufälligem Port (`127.0.0.1`). Origin-Testwerte werden nur als Daten geprüft, nicht als externe Ziele aufgerufen.

Die historischen Codex-Befehle wurden in der üblichen Codex-Sandbox ausgeführt, ohne Rechteerweiterung oder Installation. Verwendet wurden die vorhandene Node-24.20.0-Toolchain und npm im Offline-Modus. Das Environment wurde ausdrücklich bereinigt: temporäre Home-/Cache-/TMPDIR-/Fallback-Datenbankpfade, leere npm-Konfigurationsdateien, ausschließlich Dummy-Admin-Token, keine übernommenen Zugangsdaten. Testprotokolle liegen unter `/private/tmp/pixelfleet-sa03-validation-_lfdzmta/command-*.log` und sind temporär; die Ergebnisse sind hier dauerhaft festgehalten.

| Prüfung | Tatsächlich beobachtetes Ergebnis |
| --- | --- |
| Vollständige Suite, sieben Dateien / 50 Tests | **Bestanden, vom Nutzer ausgeführt und am 2026-10-11 gemeldet: 50/50 Tests** |
| Historischer Codex-Lauf: `npm test -- tests/match-membership.test.ts tests/session-authorization.test.ts tests/http.test.ts tests/deployment.test.ts --maxWorkers=1 --minWorkers=1 --no-file-parallelism` | Exit 1: vier Dateien, **28 bestanden / 13 fehlgeschlagen**; alle sieben neuen Hubtests sowie zehn Session- und zehn HTTP-Tests bestanden |
| `npm run typecheck` | **Bestanden, Exit 0** |
| `npm run build` | **Bestanden, Exit 0**, Shared, Backend und Frontend |
| Historischer vollständiger Codex-Lauf: `npm test -- --maxWorkers=1 --minWorkers=1 --no-file-parallelism` | Exit 1: sieben Dateien, **37 bestanden / 13 fehlgeschlagen, insgesamt 50 Tests**; alle sieben neuen Hubtests bestanden |
| `git diff --check` | **Bestanden** |

Alle 13 fehlgeschlagenen Deploymenttests im historischen Codex-Lauf brachen beim Serverstart vor ihren Integrationsszenarien ab:

```text
Error: listen EPERM: operation not permitted 0.0.0.0
code: 'EPERM'
errno: -1
syscall: 'listen'
address: '0.0.0.0'
Node.js v24.20.0
```

Diese historischen Fehlschläge werden weder als Codex-Erfolg noch als übersprungen umgedeutet. Der eine erfolgreiche Deploymenttest prüft den kontrollierten Startabbruch bei fehlendem Frontend und benötigt keinen Listener. Die vollständige Suite war in Codex **nicht bestanden**. Der abschließende vollständige Codex-Lauf enthält den finalen Teststand. Typecheck und Build beziehen sich auf denselben Anwendungscode; danach wurde nur die gemeinsame Beobachtung zweier Reconnect-Promises im neuen Integrationstest angepasst.

## Nutzerausgeführte Validierung und Grenzen

Der Nutzer bestätigte am 2026-10-11 den erfolgreichen vollständigen Lauf mit **50/50 Tests** für diesen SA-03-Fixstand. Die zuvor ausstehende manuelle Validierung ist damit laut Nutzer abgeschlossen, einschließlich der nativen HTTP-/WebSocket-Integrationstests. Der Erfolg ist ausdrücklich **nutzerausgeführt**, nicht unabhängig von Codex beobachtet. Die historischen Sandboxfehler bleiben als solche dokumentiert. Für diese reine Status- und Commitvorbereitung wurden keine Tests oder anderen Zielprogramme erneut ausgeführt.

Die erfolgreichen Hubtests belegen das Verhalten im kontrollierten Transportmodell mit realer temporärer SQLite-Datenbank; sie ersetzen keinen nativen WebSocket-Test. Browserdarstellung und sämtliche nativen Ereignisreihenfolgen sind nicht unabhängig beobachtet. Die Zuordnung gilt für den bestehenden einzelnen synchron arbeitenden Hub-Prozess; mehrere Prozesse mit gemeinsamem Matchmaking sind kein Bestandteil dieses Fixes. Keine neuen Regeln für Ergebnisaufbewahrung oder deren Speicherbegrenzung.

Der verbleibende Diff wurde erneut geprüft und umfasst ausschließlich die aktive Matchzuordnung in `apps/backend/src/game-hub.ts`, den neuen nativen Test in `tests/deployment.test.ts`, sieben Hub-Regressionstests in `tests/match-membership.test.ts` und diesen Bericht. Die Quell- und Testdateien entsprechen weiterhin den unten festgehaltenen SHA-256-Werten. Keine unbeabsichtigten Änderungen festgestellt; `git diff --check` bestanden. Der ursprüngliche Auditdatensatz wurde nicht verändert; `run-metadata.json` enthält weiterhin `run_status: incomplete` (SHA-256: `86d5a650d4af8589a632390586ed2b9b9d94bb7506d8420d7044dba8b4d1226d`).

## Validierter Quell- und Teststand (SHA-256)

- `apps/backend/src/game-hub.ts`: `49df3457e1f69df3c1d5bc40654fdafca3acaa314d58318577f263a1b8e67b2d`
- `tests/match-membership.test.ts`: `a815e4b5cae7aa02965323ac45026f19d2df690fbd23c1a09144bebc9d1c5381`
- `tests/deployment.test.ts`: `cd4cbdf1eb828ae853d1809e061e60f47e207b933f94be5c1ede5d6123f6b20e`

## Commitvorbereitung

Der separate Commit `fix: separates active matches from retained results` ist inhaltlich vorbereitet. Das Staging der vier ausdrücklich ausgewählten SA-03-Dateien scheiterte am 2026-10-11 innerhalb der Codex-Sandbox mit Exit 128:

```text
fatal: Unable to create '/Users/noahbauditz/Documents/Projects/PixelFleet/.git/index.lock': Operation not permitted
```

Keine Rechteerweiterung angefordert; der Index blieb unverändert, der Commitbefehl wurde nicht ausgeführt. Zum Abschluss im Nutzerterminal:

```sh
cd /Users/noahbauditz/Documents/Projects/PixelFleet
git add -- apps/backend/src/game-hub.ts tests/deployment.test.ts tests/match-membership.test.ts docs/security/SA-03-FIX-STATUS.md
git commit -m "fix: separates active matches from retained results"
```

Kein Push, kein Deployment; der Vollaudit bleibt **incomplete**.
