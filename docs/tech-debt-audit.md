# PixelFleet – Technical-Debt-Audit

**Stand:** 12. Oktober 2026 · **Geprüfter Commit:** `e96d01c8faa421bbffb25796924d662e1b30001f`

**Auftrag und Methode:** Bestandsaufnahme, anschließend Prüfung von Spielabläufen, Persistenz, Verbindungslebenszyklus, Frontend, Tests und Betrieb nach dem Skill `tech-debt`. Ergänzend wurden die React-Prüfkriterien aus `react-best-practices` berücksichtigt. Dieser Bericht ist die einzige Änderung an versionierbaren Projektdateien. Bereits vorhandene unversionierte `.agents/` und `skills-lock.json` wurden nicht verändert. Es wurden keine Anwendungskorrekturen, Dependency-Updates, Commits oder Deployments vorgenommen.

**Ergebnis:** Neun belegte Befunde. Am dringlichsten sind ein reproduzierbarer Backend-Absturz durch einen WebSocket-Protokollfehler, unbegrenzt aufbewahrte Laufzeitdaten und fehlende atomare Ergebnisspeicherung. Die vorhandenen 120 Tests, Typecheck, Produktionsbuild und zwei vollständige Match-Smokes bestehen. Diese Erfolge decken die hier nachgewiesenen Fehlerfälle bisher nicht ab.

## 1. Bestandsaufnahme

### Projektstruktur und Architektur

| Bereich | Bestand und Verantwortung | Zentrale Referenzen |
| --- | --- | --- |
| Monorepo | Drei npm-Workspaces; gemeinsames Lockfile; TypeScript mit `strict` und Projektreferenzen | [package.json:7–30](/Users/noahbauditz/Documents/Projects/PixelFleet/package.json:7), [tsconfig.json:1–9](/Users/noahbauditz/Documents/Projects/PixelFleet/tsconfig.json:1) |
| `packages/shared` | 10×10-Spielbrett, fünf Schiffe, Platzierungs-/Schussvalidierung, XP, öffentliche Nachrichtentypen und Seitenrouten; keine externen Laufzeitabhängigkeiten | [game.ts:13–88](/Users/noahbauditz/Documents/Projects/PixelFleet/packages/shared/src/game.ts:13), [types.ts:89–131](/Users/noahbauditz/Documents/Projects/PixelFleet/packages/shared/src/types.ts:89), [routes.ts:1–22](/Users/noahbauditz/Documents/Projects/PixelFleet/packages/shared/src/routes.ts:1) |
| `apps/backend` | Nativer Node-HTTP-Server mit REST, statischen Dateien, Admin/Prometheus und WebSocket-Upgrades; `GameHub` steuert Queue, Partien, Ansichten, Reconnect und Ergebnisübergabe | [server.ts:266–355](/Users/noahbauditz/Documents/Projects/PixelFleet/apps/backend/src/server.ts:266), [game-hub.ts:81–145](/Users/noahbauditz/Documents/Projects/PixelFleet/apps/backend/src/game-hub.ts:81) |
| Persistenz | `node:sqlite`/`DatabaseSync`, WAL, Foreign Keys; Tabellen `users` und `sessions`; Schema beim Modulimport, kein versionierter Migrationspfad | [db.ts:48–76](/Users/noahbauditz/Documents/Projects/PixelFleet/apps/backend/src/db.ts:48) |
| `apps/frontend` | React-SPA; App-Zustände Login → Lobby → Queue → Platzierung → Spiel → Ergebnis; `SessionConnection` besitzt Account-/Socketgeneration und Wiederverbindung; eigene UI-Komponenten und CSS | [App.tsx:27–59](/Users/noahbauditz/Documents/Projects/PixelFleet/apps/frontend/src/App.tsx:27), [App.tsx:109–136](/Users/noahbauditz/Documents/Projects/PixelFleet/apps/frontend/src/App.tsx:109), [sessionConnection.ts:29–40](/Users/noahbauditz/Documents/Projects/PixelFleet/apps/frontend/src/lib/sessionConnection.ts:29) |
| Hilfsskripte | Admin-CLI, HTTP-Healthcheck, Protokoll-Smoke mit zwei Gästen, Build-Artefaktbereinigung | [scripts/admin.mjs:7–23](/Users/noahbauditz/Documents/Projects/PixelFleet/scripts/admin.mjs:7), [scripts/smoke-match.mjs:90–142](/Users/noahbauditz/Documents/Projects/PixelFleet/scripts/smoke-match.mjs:90) |
| Dokumentation | README, ausführlicher Dokploy-Betriebsleitfaden und historische Statusberichte zu Session-/Origin-/Proxy-Korrekturen | [README.md:34–138](/Users/noahbauditz/Documents/Projects/PixelFleet/README.md:34), [docs/dokploy.md:1–168](/Users/noahbauditz/Documents/Projects/PixelFleet/docs/dokploy.md:1), [REMEDIATION-STATUS.md:3–38](/Users/noahbauditz/Documents/Projects/PixelFleet/docs/security/REMEDIATION-STATUS.md:3) |

Der Browser authentifiziert HTTP und WebSockets mit einem HttpOnly-Gastcookie. Die Datenbank speichert dessen SHA-256-Hash und eine feste Sessionfrist von 365 Tagen. Der Server entscheidet über Spielregeln und liefert getrennte eigene/gegnerische Brettansichten. Queue, Partien, Ergebnisse zur Anzeige, Verbindungen und Timer liegen ausschließlich im Prozessspeicher. Nur Profil-/Statistikdaten und Sessions überleben einen Neustart.

Die dokumentierte **Einzelinstanz mit SQLite ist für den vorhandenen Umfang nachvollziehbar**. Es gibt keinen Beleg, der Microservices, Redis oder einen Datenbankwechsel rechtfertigt. Dass Redeployments laufende Partien beenden, ist ausdrücklich dokumentiert; der fehlerhafte Abgleich des Clients danach ist dagegen ein konkreter Befund (TD-06).

### Tests und Build

Die neun Vitest-Dateien enthalten aktuell 120 Testfälle:

| Testdatei | Anzahl | Schwerpunkt |
| --- | ---: | --- |
| `tests/game.test.ts` | 5 | Flotten, Schüsse, Levelgrenzen |
| `tests/http.test.ts` | 22 | Cookies, Originregeln, Proxyvertrauen |
| `tests/frontend-session.test.ts` | 29 | Account-/Socketgeneration, Logout, Reconnect; kontrollierter Transport, kein React-DOM |
| `tests/session-authorization.test.ts` | 10 | Sessionwiderruf, Ersatzverbindungen, Quoten und Reset |
| `tests/session-expiry.test.ts` | 20 | Absolute Sessionfrist und Timerbereinigung |
| `tests/match-membership.test.ts` | 7 | Aktive Matchzuordnung, aufbewahrte Ergebnisse, Reconnect |
| `tests/deployment.test.ts` | 23 | Echte lokale HTTP-/WS-Verbindungen, Sessions, Routing, Shutdown; HTML-Fixtures |
| `tests/routes.test.ts` | 2 | Bekannte und unbekannte Seiten |
| `tests/rate-limit.test.ts` | 2 | Fensterlimit und Wiederfreigabe desselben Schlüssels |

Buildreihenfolge: Shared-Paket → Backend → Frontend. `typecheck` verwendet `tsc -b`; Tests bauen vorher nur das Shared-Paket. Die TypeScript-Projektreferenzen umfassen Anwendung und Vite-Konfiguration, nicht die Testdateien oder `.mjs`-Skripte ([package.json:15–30](/Users/noahbauditz/Documents/Projects/PixelFleet/package.json:15), [tsconfig.json:3–7](/Users/noahbauditz/Documents/Projects/PixelFleet/tsconfig.json:3)). Es wurde keine Coveragequote erhoben; aus der Testanzahl wird keine solche Quote abgeleitet.

### Abhängigkeiten und Deployment

- Lokal geprüft mit Node **24.20.0**, npm **11.19.0**. Aufgelöst sind unter anderem `ws` **8.21.0**, React/React DOM **19.2.6**, TypeScript **5.9.3**, Vite **7.3.3**, Vitest **3.2.4**. `npm ls --depth=0` meldet keinen defekten Dependency-Baum.
- Das Dockerfile verwendet Node 24 Bookworm Slim, getrennte Build-/Produktionsabhängigkeiten, UID 1000, Healthcheck und direkten Start des kompilierten Backends. Das frisch gebaute Image lief mit Node **24.21.0**. Der variable Node-24-Tag erklärt die Abweichung; allein daraus wird kein Befund konstruiert ([Dockerfile:2–60](/Users/noahbauditz/Documents/Projects/PixelFleet/Dockerfile:2)).
- Compose setzt ein persistentes Datenvolume, schreibgeschütztes Root-Dateisystem, entfernte Capabilities, `no-new-privileges`, Logrotation und 15 Sekunden Shutdownfrist. Die Anwendung hat eine eigene 10-Sekunden-Frist ([docker-compose.yml:34–55](/Users/noahbauditz/Documents/Projects/PixelFleet/docker-compose.yml:34), [server.ts:465–496](/Users/noahbauditz/Documents/Projects/PixelFleet/apps/backend/src/server.ts:465)).
- Traefik/Dokploy soll TLS und Routing übernehmen. Die eingecheckte Compose-Datei veröffentlicht keinen Hostport. Öffentliche Rechtstexte werden zur Buildzeit konfiguriert; `ADMIN_TOKEN` bleibt ein Runtime-Wert. Effektive Proxy- und Backupkonfiguration sind außerhalb des Repositorys.
- Im fertigen Image enthält `node_modules` nur die Einträge `@pixelfleet` und `ws`; Vite/Vitest sind nicht enthalten. Die Advisory-Meldungen der Entwicklungskette sind daher nicht pauschal Produktionsschwachstellen (TD-09).

## 2. Prüfungen und Nachweisqualität

**Belegt – dynamisch:** Mit isolierter Testdatenbank bzw. kontrolliertem Transport reproduziert. **Belegt – statisch:** Im eingecheckten Code oder Buildpfad direkt nachweisbar. **Offen:** Eine Auswirkung hängt von unbekanntem Betrieb, Last oder Produktanforderungen ab; solche Punkte stehen getrennt in Abschnitt 5.

| Prüfung | Ergebnis und Grenze |
| --- | --- |
| Git-Bestand und Struktur | Commit, Workspace-Manifeste, Lockfile, Konfiguration, Skripte, Anwendungsdateien und Dokumentation gesichtet; vorhandene Nutzerdateien unverändert |
| `npm test` | Zunächst 98 bestanden/22 durch `listen EPERM` blockiert. Nach Freigabe lokaler Ports **120/120 bestanden**, neun Dateien; eigenständig beobachtet, nicht aus historischen Berichten übernommen |
| `npm run typecheck` | Bestanden |
| `npm run build` | Bestanden; 46 Frontendmodule, JS 224,53 kB bzw. 70,40 kB gzip; keine daraus ableitbare relevante Bundle-Übergröße |
| Match-Smoke gegen kompiliertes Backend | Bestehendes `scripts/smoke-match.mjs` mit zwei Testgästen: komplette Partie und beide Ergebnisse erfolgreich |
| Gezielte Fehler-/Lebenszyklusproben | WS-Prozessabsturz, Teilcommit, verbliebene Match-/Limiterdaten, unvollständiger Reconnect und falscher HTTP-Fehlerstatus reproduziert; Details bei den Befunden |
| `docker compose config --quiet` | Bestanden |
| `docker build` | Unverändertes Dockerfile mit `npm ci` erfolgreich gebaut; keine Rechtstextwerte als Buildargumente gesetzt |
| Containerprüfung | Frisches Wegwerfvolume; read-only, UID 1000, Capabilities entfernt; Port ausschließlich an 127.0.0.1. Healthcheck, `/`, beide Rechtstextseiten, echte 404 und vollständiger Match-Smoke erfolgreich. Container und Volume anschließend entfernt |
| Paketprüfung des Images | Vite/Vitest fehlen im Runtime-Image, `ws` vorhanden. Ein Syntaxfehler im temporären Inventurkommando wurde durch eine separate erfolgreiche Inventur korrigiert; kein Anwendungsfehler |
| Aktueller npm-Advisory-Abgleich | Nach ausdrücklicher Freigabe der Metadatenübertragung erfolgreich: **12 betroffene Paketeinträge**, davon 4 critical/5 high/2 moderate/1 low; sämtliche Treffer Entwicklungsabhängigkeiten. `npm audit --omit=dev`: **0 Treffer**. Kein Nachweis umfassender Schwachstellenfreiheit |

Temporäre Prüfprogramme wurden außerhalb des Repositorys ausgeführt. Sie verwendeten ausschließlich neue SQLite-Fixtures, eigene Testgäste und eigene lokale Prozesse. Für den Match-Timeout wurde gezielt der bereits registrierte Timer-Callback aufgerufen, statt 30 Sekunden real abzuwarten; der betreffende Nachweis ist deshalb kein Dauerbetriebstest. HTTP-/WS-Smokes verwendeten echte Sockets. Controllerproben verwendeten Transport-Doubles.

## 3. Priorisierung und fünf wichtigste Maßnahmen

Berechnung nach Skill: **Priorität = (Impact + Risk) × (6 − Effort)**; alle Teilwerte liegen zwischen 1 und 5. Impact bewertet Nutzerfolgen und Teamaufwand, Risk die Folgen des Aufschubs. Effort bewertet die jeweils vorgeschlagene Maßnahme inklusive gezielter Regressionstests, nicht nur die Codezeilen. Aufwandsschätzungen gelten für eine mit dem Repository vertraute Person; ein Personentag (PT) entspricht etwa acht Stunden. Die Werte sind Planungsurteile, keine gemessenen Ausfallwahrscheinlichkeiten.

Orientierung für Effort: 1 = wenige Stunden, 2 = etwa ½–2 PT, 3 = mehrere Tage, 4 = etwa ein bis zwei Wochen, 5 = mehrwöchige oder teamübergreifende Arbeit.

| Rang | ID | Belegter Befund | Kategorie nach Skill | Impact | Risk | Effort | Rechnung / Priorität | Aufwand |
| ---: | --- | --- | --- | ---: | ---: | ---: | --- | --- |
| 1 | TD-01 | WS-Protokollfehler beendet den gesamten Server | Code debt | 5 | 5 | 2 | (5+5)×4 = **40** | 1–2 PT |
| 2 | TD-02 | Abgeschlossene Partien bleiben nach Disconnect im Speicher | Code debt | 4 | 4 | 2 | (4+4)×4 = **32** | 1–2 PT |
| 3 | TD-03 | Eingecheckter Releasepfad erzwingt keine Tests | Infrastructure debt | 4 | 4 | 2 | (4+4)×4 = **32** | 1–2 PT |
| 4 | TD-04 | Rate-Limit- und Fehlerschlüssel werden nicht bereinigt | Code debt | 3 | 4 | 2 | (3+4)×4 = **28** | ½–1 PT |
| 5 | TD-05 | Match-Abschluss und Statistikupdates sind nicht atomar | Architecture debt | 4 | 5 | 3 | (4+5)×3 = **27** | 3–5 PT |
| 6 | TD-06 | Reconnect gleicht Queue und beendete/gelöschte Partien nicht ab | Architecture debt | 4 | 4 | 3 | (4+4)×3 = **24** | 2–4 PT |
| 7 | TD-07 | Interne HTTP-Fehler erscheinen als 400 mit Rohfehlermeldung | Code debt | 3 | 3 | 2 | (3+3)×4 = **24** | 1–2 PT |
| 8 | TD-08 | Browser-/React-Integration des Kernablaufs fehlt in der Testsuite | Test debt | 4 | 3 | 3 | (4+3)×3 = **21** | 3–5 PT |
| 9 | TD-09 | Bekannte Advisory-Treffer in Build-/Testabhängigkeiten | Dependency debt | 2 | 2 | 2 | (2+2)×4 = **16** | 1–2 PT für Triage und kompatible Updates |

**Die fünf wichtigsten Maßnahmen:**

1. **WebSocket-Fehler begrenzen (TD-01, 40):** Protokollfehler dürfen nur die einzelne Verbindung schließen; Payloadlimit am Transport durchsetzen. Das schützt alle laufenden Partien vor einem einzelnen fehlerhaften Client.
2. **Laufzeitdaten mit klaren Ablaufregeln bereinigen (TD-02/TD-04, 32 bzw. 28):** Ergebnisaufbewahrung begrenzen und abgelaufene Quotenschlüssel entfernen. Diese zwei Befunde werden als zusammenhängende Betriebsmaßnahme gebündelt; ihre Scores werden nicht addiert.
3. **Release-Gate herstellen (TD-03, 32):** Tests, Typecheck, Build und Container-Smoke müssen den tatsächlich ausgelieferten Commit prüfen. Das nutzt die bereits vorhandene Suite dauerhaft.
4. **Match-Abschluss transaktional und wiederholbar machen (TD-05, 27):** Beide Statistiken gemeinsam committen; Ergebniszustand erst danach veröffentlichen. So entsteht nach Speicherfehlern kein einseitiger Sieg/Verlust.
5. **Vollständigen Zustand nach Reconnect übertragen (TD-06, 24):** Der Client muss nach Queue-Abbruch, Timeout und Neustart wieder einen benutzbaren Zustand erhalten. Gegenüber TD-07 mit gleichem Score ist die unmittelbar blockierte Spielteilnahme ausschlaggebend.

## 4. Belegte Befunde im Detail

### TD-01 – Fehlende Fehlergrenze für etablierte WebSockets

**Kategorie:** Code debt · **Impact 5 / Risk 5 / Effort 2 → 40** · **Aufwand:** 1–2 PT.

**Referenzen:** [server.ts:357](/Users/noahbauditz/Documents/Projects/PixelFleet/apps/backend/src/server.ts:357), [server.ts:425–461](/Users/noahbauditz/Documents/Projects/PixelFleet/apps/backend/src/server.ts:425), [game-hub.ts:115–144](/Users/noahbauditz/Documents/Projects/PixelFleet/apps/backend/src/game-hub.ts:115), [game-hub.ts:231–237](/Users/noahbauditz/Documents/Projects/PixelFleet/apps/backend/src/game-hub.ts:231), aufgelöstes `ws` in [package-lock.json:3135–3138](/Users/noahbauditz/Documents/Projects/PixelFleet/package-lock.json:3135).

**Problem und Beleg:** Nach dem Upgrade erhält das WebSocket-Objekt `pong`-, `close`- und `message`-Listener, aber keinen `error`-Listener. Der Listener des ursprünglichen TCP-Sockets und das synchrone `try/catch` um `handleUpgrade` fangen spätere WebSocket-Fehler nicht ab. In einem eigenen lokalen Backendprozess wurde eine reguläre Gastsession geöffnet und mit `ws.send(Buffer.from([0xff]), { binary: false })` ein ungültiger UTF-8-Textframe gesendet. Ergebnis: **Exitcode 1**, `Unhandled 'error' event`, `Invalid WebSocket frame: invalid UTF-8 sequence`.

Zusätzlich wird `MAX_WS_PAYLOAD_BYTES` erst nach Empfang und Stringkonvertierung der vollständigen Nachricht geprüft. `WebSocketServer({ noServer: true })` erhält kein `maxPayload`; die installierte `ws`-Implementierung verwendet standardmäßig 100 MiB (`node_modules/ws/lib/websocket-server.js`, Z. 69–75). Das 4096-Byte-Anwendungslimit begrenzt diese vorherige Pufferung daher nicht. Diese Aussage ist statisch geprüft, kein durchgeführter Speicherauslastungsangriff.

**Praktische Auswirkung:** Ein authentifizierter Gast kann durch einen fehlerhaften Frame den gemeinsamen Prozess beenden. Wegen des In-Memory-Spielzustands verlieren auch unbeteiligte Spieler ihre laufenden Partien. Ein Containerneustart stellt diese nicht wieder her.

**Maßnahme und Abnahme:** Fehlerlistener vor weiterer Socketinitialisierung installieren, Verbindung und Quoten genau einmal bereinigen, Transportlimit aus derselben Konfiguration setzen. Regressionstests für ungültiges UTF-8, fehlerhafte Frames und Übergröße: betroffener Socket geschlossen, Server und zweite Partie weiterhin benutzbar. Ein bloßer `uncaughtException`-Handler ist keine geeignete Reparatur.

### TD-02 – Aufbewahrte Ergebnisse besitzen keinen vollständigen Lebenszyklus

**Kategorie:** Code debt · **Impact 4 / Risk 4 / Effort 2 → 32** · **Aufwand:** 1–2 PT.

**Referenzen:** [game-hub.ts:186–228](/Users/noahbauditz/Documents/Projects/PixelFleet/apps/backend/src/game-hub.ts:186), [game-hub.ts:433–475](/Users/noahbauditz/Documents/Projects/PixelFleet/apps/backend/src/game-hub.ts:433), [game-hub.ts:477–527](/Users/noahbauditz/Documents/Projects/PixelFleet/apps/backend/src/game-hub.ts:477), [game-hub.ts:726–735](/Users/noahbauditz/Documents/Projects/PixelFleet/apps/backend/src/game-hub.ts:726).

**Problem und Beleg:** Ein Match wird erst gelöscht, wenn beide Spieler nach Abschluss als gegangen markiert sind. Trennen sich beide vorher, erstellt der erste Disconnect-Timeout später ein Ergebnis und löscht die Reconnect-Timer. Kein weiterer Close-Callback markiert die schon getrennten Spieler. Die Fixture-Reproduktion lieferte `activeConnections: 0`, `finishedMatches: 1`, `leftAfterFinish.size: 0`, `reconnectTimers.size: 0`. Es gibt weder Ergebnis-TTL noch periodische Matchbereinigung. Auch das Starten weiterer Partien quittiert alte Ergebnisse nicht zuverlässig; die Tests erlauben ausdrücklich deren weitere Aufbewahrung ([match-membership.test.ts:188–209](/Users/noahbauditz/Documents/Projects/PixelFleet/tests/match-membership.test.ts:188)).

**Praktische Auswirkung:** Normales Tab-Schließen kann vollständige Matchobjekte bis zum Neustart zurücklassen. Speicherverbrauch sowie das Durchlaufen von `matches` für Status und alte Ergebnisse wachsen mit der Betriebshistorie. Dass unter realer Last bereits Speicher ausgegangen wäre, ist nicht belegt.

**Maßnahme und Abnahme:** Ergebnisaufbewahrung mit endlicher Frist definieren; bereits getrennte Teilnehmer beim Abschluss berücksichtigen; aktive Mitgliedschaft und Ergebniscache getrennt bereinigen. Mit TD-06 abstimmen, damit eine angemessene Ergebnisanzeige nach Reconnect möglich bleibt. Zeitgesteuerte Tests müssen nach beidseitigem Abbruch, einseitigem Abbruch und mehreren Folgepartien eine begrenzte Anzahl gespeicherter Ergebnisse nachweisen.

### TD-03 – Tests sind kein Bestandteil des eingecheckten Releasepfads

**Kategorie:** Infrastructure debt · **Impact 4 / Risk 4 / Effort 2 → 32** · **Aufwand:** 1–2 PT.

**Referenzen:** [package.json:22–29](/Users/noahbauditz/Documents/Projects/PixelFleet/package.json:22), [Dockerfile:13–36](/Users/noahbauditz/Documents/Projects/PixelFleet/Dockerfile:13), [.dockerignore:13–15](/Users/noahbauditz/Documents/Projects/PixelFleet/.dockerignore:13), [dokploy.md:11–29](/Users/noahbauditz/Documents/Projects/PixelFleet/docs/dokploy.md:11).

**Problem und Beleg:** Der Docker-Build führt `npm run build`, aber keine Tests aus; die Testdateien werden sogar vom Docker-Kontext ausgeschlossen. `build` ruft weder `test` noch das vollständige Root-`typecheck` auf. Im versionierten Dateibestand existiert kein CI-Workflow oder alternatives Pipeline-Skript. Die Deploymentanleitung erlaubt AutoDeploy nach dem ersten erfolgreichen Deployment. Das ist ein belegter fehlender Schutz im Repository; unbekannte externe Branchregeln oder Dokploy-Hooks werden ausdrücklich nicht als fehlend behauptet.

**Praktische Auswirkung:** Ein Build kann auslieferbar sein, obwohl Session-, Reconnect- oder Autorisierungstests scheitern. Die umfangreichen bisherigen Regressionstests wirken dann nur, wenn jemand sie manuell vor jedem Release ausführt.

**Maßnahme und Abnahme:** Pipeline mit Node 24, `npm ci`, Typecheck, Tests, Build und Container-Smoke hinzufügen; geschützten Deploymentpfad an den erfolgreichen Check desselben Commits binden. Falls ein externer Gate bereits existiert, diesen nachweisen und dokumentieren statt einen zweiten aufzubauen. Abnahme: Ein absichtlich fehlschlagender Regressionstest blockiert nachweislich die Freigabe des Testcommits.

### TD-04 – Abgelaufene Quoten und Fehlerzähler bleiben dauerhaft gespeichert

**Kategorie:** Code debt · **Impact 3 / Risk 4 / Effort 2 → 28** · **Aufwand:** ½–1 PT.

**Referenzen:** [rate-limit.ts:13–67](/Users/noahbauditz/Documents/Projects/PixelFleet/apps/backend/src/rate-limit.ts:13), [server.ts:47–64](/Users/noahbauditz/Documents/Projects/PixelFleet/apps/backend/src/server.ts:47), [game-hub.ts:86–98](/Users/noahbauditz/Documents/Projects/PixelFleet/apps/backend/src/game-hub.ts:86), [game-hub.ts:662–675](/Users/noahbauditz/Documents/Projects/PixelFleet/apps/backend/src/game-hub.ts:662), [game-hub.ts:750–757](/Users/noahbauditz/Documents/Projects/PixelFleet/apps/backend/src/game-hub.ts:750), [rate-limit.test.ts:4–19](/Users/noahbauditz/Documents/Projects/PixelFleet/tests/rate-limit.test.ts:4).

**Problem und Beleg:** `prune()` existiert, wird aber im Anwendungscode nie aufgerufen. Ein Zeitablauf ersetzt nur den erneut verwendeten Schlüssel. Eine Probe mit 1000 unterschiedlichen Schlüsseln bei Zeit 0 und einem neuen Schlüssel nach Ablauf des Fensters ergab **1001 gespeicherte Buckets**. HTTP-Limiter leben bis zum Prozessende. Hub-Limiter und `invalidActionCounts` werden erst bei `resetRuntime` geleert. Der Fehlerzähler hat ebenfalls weder Zeitfenster noch Erholung; die achte ungültige Aktion zählt über mehrere Verbindungen hinweg.

**Praktische Auswirkung:** Speicher wächst mit allen jemals gesehenen IPs/Accounts statt mit aktiven Quoten. Seltene Fehlklicks oder verspätete Aktionen können einen Account langfristig so belasten, dass jede weitere ungültige Aktion sofort die Verbindung schließt. Eine reale OOM-Situation wurde nicht gemessen.

**Maßnahme und Abnahme:** Begrenzte, regelmäßig ausgeführte Bereinigung für alle Limiter; Fehlerversuche über ein definiertes Zeitfenster bewerten. Quoten nicht einfach beim Disconnect löschen, sonst können Reconnects sie umgehen. Tests für Schlüsselwechsel, Ablauf, erneute Verbindung und bereinigte Schlüsselanzahl ergänzen; nicht nur denselben Schlüssel nach Fensterende testen.

### TD-05 – Match-Ergebnisse können teilweise gespeichert und trotzdem abgeschlossen werden

**Kategorie:** Architecture debt · **Impact 4 / Risk 5 / Effort 3 → 27** · **Aufwand:** 3–5 PT.

**Referenzen:** [game-hub.ts:215–225](/Users/noahbauditz/Documents/Projects/PixelFleet/apps/backend/src/game-hub.ts:215), [game-hub.ts:433–475](/Users/noahbauditz/Documents/Projects/PixelFleet/apps/backend/src/game-hub.ts:433), [db.ts:221–257](/Users/noahbauditz/Documents/Projects/PixelFleet/apps/backend/src/db.ts:221). Verwandter Mehrschrittpfad: [db.ts:154–166](/Users/noahbauditz/Documents/Projects/PixelFleet/apps/backend/src/db.ts:154).

**Problem und Beleg:** `finishMatch` setzt die Phase auf `finished`, entfernt aktive Zuordnungen und erhöht den Abschlusszähler vor der Persistenz. Danach werden die beiden Spieler separat und ohne gemeinsame Transaktion aktualisiert. Ein Testtrigger ließ gezielt das zweite Statistikupdate mit `RAISE(ABORT, ...)` scheitern. Ergebnis: **gamesPlayed `[0,1]`**, Phase `finished`, nur **ein** gespeichertes MatchResult und **null** aktive Zuordnungen. Die zweite Ergebnisnachricht wird nicht erreicht. Der Guard gegen wiederholtes Abschließen verhindert einen einfachen erneuten Versuch. Fehler aus dem Timeout-Abschluss laufen zusätzlich außerhalb des Message-`try/catch`.

**Praktische Auswirkung:** Bei Schreibfehlern oder Prozessabbruch zwischen den Updates stimmen Siege, Niederlagen und Spielezahl nicht zusammen. Ohne persistente Match-ID/Ergebnisaufzeichnung ist die betroffene Partie aus Aggregaten nicht verlässlich rekonstruierbar. Die Probe belegt den Fehlerpfad, nicht dessen Häufigkeit im Betrieb.

**Maßnahme und Abnahme:** Persistenzoperation für den gesamten Matchabschluss mit SQLite-Transaktion und eindeutiger Match-ID schaffen; beide Statistiken und Abschlussnachweis gemeinsam speichern. Erst nach Commit In-Memory-Abschluss und Nachrichten veröffentlichen. Wiederholung darf nicht doppelt belohnen. Account- und Sessionanlage ebenfalls transaktional zusammenfassen. Fehler im zweiten Update, erneuter Abschlussversuch und Neustart nach Commit müssen entweder zwei korrekte Updates oder keine Änderung ergeben.

### TD-06 – Reconnect liefert keinen vollständigen aktuellen Spielzustand

**Kategorie:** Architecture debt · **Impact 4 / Risk 4 / Effort 3 → 24** · **Aufwand:** 2–4 PT.

**Referenzen:** [game-hub.ts:122–138](/Users/noahbauditz/Documents/Projects/PixelFleet/apps/backend/src/game-hub.ts:122), [game-hub.ts:194–205](/Users/noahbauditz/Documents/Projects/PixelFleet/apps/backend/src/game-hub.ts:194), [sessionConnection.ts:115–169](/Users/noahbauditz/Documents/Projects/PixelFleet/apps/frontend/src/lib/sessionConnection.ts:115), [App.tsx:47–50](/Users/noahbauditz/Documents/Projects/PixelFleet/apps/frontend/src/App.tsx:47), [App.tsx:113–130](/Users/noahbauditz/Documents/Projects/PixelFleet/apps/frontend/src/App.tsx:113).

**Problem und Beleg:** Beim Disconnect entfernt der Server den Spieler aus der Queue. Beim Reconnect ohne aktive Partie sendet er ein Profil, aber keinen expliziten Lobbyzustand und kein `queued: false`. Bei derselben Account-ID bewahrt der Client `queued` und `matchView`. Controller- und Hubproben belegen: **Serverqueue 0, Client `queued: true`, Reconnectnachrichten nur `profile`**. Nach Closecode 1012 und erneuter Profilbestätigung blieb eine alte `placing`-Ansicht erhalten. Ebenso liefert der Hub nach Ablauf der 30-Sekunden-Frist nur das Profil und nicht das inzwischen vorhandene Ergebnis.

**Praktische Auswirkung:** Der Browser zeigt endlose Gegnersuche ohne Queue-Mitgliedschaft oder eine schon beendete/bei Redeployment gelöschte Partie. Aktionen werden dann abgelehnt; der Nutzer muss abbrechen oder neu laden. Das ist unabhängig davon, dass der Verlust laufender Partien beim Redeployment dokumentiert ist.

**Maßnahme und Abnahme:** Nach jeder authentifizierten Verbindung einen vollständigen, eindeutigen Snapshot übertragen: Lobby/Queue/aktive Partie bzw. verfügbares Ergebnis. Clientzustand daraus ersetzen, einschließlich explizit leerer Zustände; Accountgeneration-Schutz erhalten. Tests müssen Queue-Reconnect, Reconnect vor/nach Grace-Timeout, Serverneustart und Runtime-Reset mit derselben Account-ID über beide Seiten hinweg prüfen. Ein unbedachtes generelles Zurücksetzen beim Verbindungsabbruch würde dagegen die lokale Platzierung unnötig verlieren.

### TD-07 – HTTP-Speicherfehler werden als Benutzereingabefehler behandelt

**Kategorie:** Code debt · **Impact 3 / Risk 3 / Effort 2 → 24** · **Aufwand:** 1–2 PT.

**Referenzen:** [server.ts:305–311](/Users/noahbauditz/Documents/Projects/PixelFleet/apps/backend/src/server.ts:305), [server.ts:350–354](/Users/noahbauditz/Documents/Projects/PixelFleet/apps/backend/src/server.ts:350), [http.ts:187–210](/Users/noahbauditz/Documents/Projects/PixelFleet/apps/backend/src/http.ts:187), [metrics.ts:45–58](/Users/noahbauditz/Documents/Projects/PixelFleet/apps/backend/src/metrics.ts:45). Bereits kontrollierter Upgrade-Gegenfall: [deployment.test.ts:539–559](/Users/noahbauditz/Documents/Projects/PixelFleet/tests/deployment.test.ts:539).

**Problem und Beleg:** Der globale HTTP-Catch sendet unabhängig von der Ursache Status 400 und `error.message`. In einer wegwerfbaren Datenbank wurde nach gültigem Login die Sessiontabelle umbenannt. `/api/me` lieferte **400 mit `{"error":"no such table: sessions"}`**, während `/api/health` weiter 200 lieferte. Beim WS-Upgrade wird derselbe Speicherfehler bereits als 500 behandelt. In den Metriken werden sämtliche HTTP-Fehler gemeinsam gezählt; die Ereignisliste hält nur 50 Meldungen im RAM.

**Praktische Auswirkung:** Betriebsfehler erscheinen als fehlerhafte Clientanfragen und geben interne Speicherinformationen zurück. Fehlersuche und gezielte 5xx-Alarmierung werden erschwert. Der Healthcheck ist derzeit ein Lebenszeichen, keine Bestätigung funktionierender Persistenz; das ist bei seiner Verwendung zu berücksichtigen.

**Maßnahme und Abnahme:** Erwartete Eingabefehler typisieren und mit passenden 4xx beantworten; unerwartete Fehler als generische 500 mit internem strukturiertem Fehlerereignis/Request-ID protokollieren. Clientdetails nicht ungefiltert loggen. Statusklassen in Metriken unterscheiden. Mit defekter Testtabelle 500 ohne SQL-Details und nach Reparatur erfolgreiche Anfrage nachweisen; fehlerhaftes JSON muss weiterhin kontrolliert als 4xx enden.

### TD-08 – Kontrollertests ersetzen die React-/Browserintegration nicht

**Kategorie:** Test debt · **Impact 4 / Risk 3 / Effort 3 → 21** · **Aufwand:** 3–5 PT.

**Referenzen:** [frontend-session.test.ts:23–48](/Users/noahbauditz/Documents/Projects/PixelFleet/tests/frontend-session.test.ts:23), [frontend-session.test.ts:78–115](/Users/noahbauditz/Documents/Projects/PixelFleet/tests/frontend-session.test.ts:78), [deployment.test.ts:17–27](/Users/noahbauditz/Documents/Projects/PixelFleet/tests/deployment.test.ts:17), [smoke-match.mjs:16–42](/Users/noahbauditz/Documents/Projects/PixelFleet/scripts/smoke-match.mjs:16), [main.tsx:6–10](/Users/noahbauditz/Documents/Projects/PixelFleet/apps/frontend/src/main.tsx:6), [GameScreen.tsx:74–143](/Users/noahbauditz/Documents/Projects/PixelFleet/apps/frontend/src/components/GameScreen.tsx:74).

**Problem und Beleg:** Die 29 Frontendtests prüfen `SessionConnection` mit selbst definierten Callback-Zuständen. Auch der Strict-Mode-Test ruft manuell `start/stop/start` auf; React wird nicht gemountet. Deploymenttests verwenden minimale HTML-Fixtures. Der Match-Smoke ist ein Node-HTTP-/WS-Client und betätigt keine UI. Im Repository gibt es keine Browser-Testkonfiguration oder DOM-Komponententests. Damit kann die gesamte Suite grün bleiben, obwohl die Zusammenschaltung von Appzustand und Backend bei TD-06 versagt.

**Praktische Auswirkung:** Loginformular, Platzierung, Buttonzustände, tatsächliche Effect-Lebenszyklen und Wechsel zwischen Match/Lobby sind ohne automatisierten Schutz. Frontend- und Protokolländerungen verlangen wiederholte manuelle Gesamtprüfungen. Eine schlechte pauschale Coverage oder ein konkreter Layoutdefekt werden damit nicht behauptet.

**Maßnahme und Abnahme:** Eine kleine Browser-Suite gegen das gebaute Frontend mit isolierter Datenbank aufbauen: Gastlogin, zwei Browserkontexte mit vollständigem Spiel, Reconnect in Queue und Partie, Ergebnis/Lobby, Logout. Dazu wenige echte React-Mounttests für Strict Mode und asynchrone Sessionwechsel. Zustände/Nachrichten abwarten, keine willkürlichen Sleepketten. Die vorhandenen schnellen Kontroller- und Backendtests beibehalten; TD-03 bindet die neuen Checks ein.

### TD-09 – Advisory-Treffer der Entwicklungskette benötigen gezielte Behandlung

**Kategorie:** Dependency debt · **Impact 2 / Risk 2 / Effort 2 → 16** · **Aufwand:** 1–2 PT für Triage und kompatible Updates; ein erforderlicher Major-Wechsel ist separat zu schätzen.

**Referenzen:** [package.json:32–42](/Users/noahbauditz/Documents/Projects/PixelFleet/package.json:32), [frontend/package.json:7–9](/Users/noahbauditz/Documents/Projects/PixelFleet/apps/frontend/package.json:7), [package-lock.json:2445–2463](/Users/noahbauditz/Documents/Projects/PixelFleet/package-lock.json:2445), [package-lock.json:3027–3050](/Users/noahbauditz/Documents/Projects/PixelFleet/package-lock.json:3027), [Dockerfile:35–51](/Users/noahbauditz/Documents/Projects/PixelFleet/Dockerfile:35).

**Beleg:** Der am Auditdatum genehmigt ausgeführte npm-Abgleich meldet folgende installierte Pakete. Die Schwere ist jeweils die npm-Meldung, nicht die projektspezifische Risikobewertung. Mehrere Einträge entstehen durch dieselbe transitive Ursache.

| Paket | Installiert | npm-Schwere |
| --- | --- | --- |
| `@vitest/mocker` | 3.2.4 | moderate |
| `baseline-browser-mapping` | 2.10.32 | moderate |
| `browserslist` | 4.28.2 | high |
| `concurrently` | 9.2.1 | critical, über `shell-quote` |
| `esbuild` | 0.28.0 und 0.27.7 | low |
| `nanoid` | 3.3.12 | high |
| `postcss` | 8.5.15 | high |
| `shell-quote` | 1.8.3 | critical |
| `source-map-js` | 1.2.1 | high |
| `tinypool` | 1.1.1 | critical |
| `vite` | 7.3.3 | high |
| `vitest` | 3.2.4 | critical |

**Praktische Einordnung:** Alle Treffer sind im Lockfile als `dev` markiert. `npm audit --omit=dev` meldet null Treffer; das Docker-Runtime-Inventar bestätigt die Trennung. Beim belegten [Vite-Advisory GHSA-fx2h-pf6j-xcff](https://github.com/vitejs/vite/security/advisories/GHSA-fx2h-pf6j-xcff) sind Windows-/NTFS-Pfade und ein erreichbarer Devserver Voraussetzungen. Das Startskript bindet tatsächlich `0.0.0.0`; die weitere Voraussetzung ist für den geprüften Mac bzw. Linux-Container nicht nachgewiesen. Das [Vitest-Advisory GHSA-5xrq-8626-4rwp](https://github.com/vitest-dev/vitest/security/advisories/GHSA-5xrq-8626-4rwp) betrifft UI/API-/Browser-Serverbedingungen, während das Repository `vitest run` nutzt. Ein ausnutzbarer RCE-Pfad in PixelFleet wird nicht behauptet. Andere Meldungen betreffen beispielsweise nicht vertrauenswürdige Buildinputs oder besondere Generatorparameter; ihre individuelle Erreichbarkeit wurde nicht vollständig untersucht.

**Maßnahme und Abnahme:** Advisory-Liste mit tatsächlichem Aufrufpfad, Plattform und Owner triagieren; kompatible korrigierte Versionen samt Lockfile aktualisieren und Build/Tests/Container erneut prüfen. Netzwerkbindung des Devservers standardmäßig lokal halten, sofern LAN-Tests nicht ausdrücklich gebraucht werden. Kein blindes `npm audit fix --force`: Die Empfehlungen beruhen auf konkreten Advisory-Treffern und dem offen gebundenen Devserver, nicht allein auf älteren Versionsnummern. Die niedrigere projektspezifische Bewertung berücksichtigt die fehlende Produktionsreichweite.

## 5. Offene Vermutungen und bedingte Empfehlungen

Diese Punkte sind **keine zusätzlich bestätigten Defekte**. Die angegebenen Werte bewerten vorläufig den nächsten begrenzten Prüf-/Klärungsschritt, nicht einen bereits beschlossenen Architekturumbau. Ein extern vorhandener Nachweis kann den jeweiligen Punkt schließen.

| ID / Kategorie | Konkreter Anhaltspunkt und mögliche Auswirkung | Fehlender Beleg; nächster Schritt und Aufwand | Vorläufige Bewertung |
| --- | --- | --- | --- |
| U-01 / Infrastructure debt | [http.ts:58–75](/Users/noahbauditz/Documents/Projects/PixelFleet/apps/backend/src/http.ts:58) vertraut bei aktiviertem Proxytrust jedem Peer und dem ersten Forwarding-Eintrag. [dokploy.md:91–111](/Users/noahbauditz/Documents/Projects/PixelFleet/docs/dokploy.md:91) benennt selbst die fehlenden Produktionsnachweise. Unbereinigte Header könnten Quoten oder Cookieattribute beeinflussen. | Effektive Netze, Peers und Headerbehandlung fehlen. Betreiberkonfiguration und autorisierten Testpfad prüfen; erst daraus konkrete Trustregeln ableiten. **½–1 PT**, ohne Wartezeit auf Zugang. | I3/R5/E2 → **32**, bedingt |
| U-02 / Infrastructure debt | [dokploy.md:56–65](/Users/noahbauditz/Documents/Projects/PixelFleet/docs/dokploy.md:56) beschreibt konsistente Backups und Restoreprüfung; [metrics.ts:36–58](/Users/noahbauditz/Documents/Projects/PixelFleet/apps/backend/src/metrics.ts:36) hält Diagnoseereignisse nur im RAM. Fehlende externe Sicherung/Erfassung würde Wiederherstellung und Diagnose erschweren. | Kein Zugang zu Backupjobs, Restoreprotokollen, Scrapes oder Alarmen. Bestehende Einrichtungen nachweisen, Restore in separater Umgebung durchführen und Alarmzustellung prüfen. **1–2 PT**; fehlende externe Werkzeuge nicht unterstellen. | I3/R5/E2 → **32**, bedingt |
| U-03 / Architecture debt | [db.ts:199–205](/Users/noahbauditz/Documents/Projects/PixelFleet/apps/backend/src/db.ts:199) lehnt abgelaufene Sessions ab, löscht sie aber nicht. [db.ts:288–308](/Users/noahbauditz/Documents/Projects/PixelFleet/apps/backend/src/db.ts:288) bietet nur globale Resets. [legalConfig.ts:19–20](/Users/noahbauditz/Documents/Projects/PixelFleet/apps/frontend/src/lib/legalConfig.ts:19) ist reiner Anzeigetext, keine technische Retentionsfrist. Langfristig können nicht mehr erreichbare Gastkonten anwachsen. | Das Behalten von Konten ist bewusst dokumentiert und getestet ([session-expiry.test.ts:97–115](/Users/noahbauditz/Documents/Projects/PixelFleet/tests/session-expiry.test.ts:97)). Tatsächliche Mengen und gewünschte Fristen fehlen. Retention/Recovery mit Betreiber festlegen; Löschung erst darauf abstimmen. **½–1 PT** für Klärung, Implementierung anschließend schätzen. Kein Rechtsverstoß abgeleitet. | I2/R3/E2 → **20**, bedingt |
| U-04 / Architecture debt | [db.ts:48–76](/Users/noahbauditz/Documents/Projects/PixelFleet/apps/backend/src/db.ts:48) initialisiert nur mit `CREATE TABLE IF NOT EXISTS`. Bei der nächsten Schemaänderung, etwa TD-05, könnten bestehende Volumes ein anderes Schema als Neuinstallationen behalten. | Es liegt heute kein nachgewiesener Schema-Upgradefehler vor. Vor TD-05 einen kleinen versionierten Migrationspfad mit Altbestandfixture und Backup-/Rollbackentscheidung planen; **½–1 PT** für Vorbereitung, Umsetzung in TD-05 einrechnen. | I3/R3/E2 → **24**, bedingt |
| U-05 / Code debt | [game-hub.ts:358–424](/Users/noahbauditz/Documents/Projects/PixelFleet/apps/backend/src/game-hub.ts:358) hat keine Platzierungs-/Zugfrist; [GameScreen.tsx:26–44](/Users/noahbauditz/Documents/Projects/PixelFleet/apps/frontend/src/components/GameScreen.tsx:26) bietet keinen Match-Abbruch. Ein weiter verbundener, untätiger Gegner kann die Partie unbegrenzt halten. | Kein Produktziel für Zeitlimits vereinbart. Entscheidung über sichtbares Aufgeben und ggf. Zeitlimits treffen, Nutzerablauf prüfen; **½ PT** für Entscheidung/Entwurf. Reines Warten nicht ohne Produktentscheidung als Regelverstoß behandeln. | I3/R2/E1 → **25**, bedingt |

Eine hohe Priorität in dieser Tabelle bedeutet dringende **Verifikation**, keine bewiesene Produktionsgefährdung. U-01/U-02 können zeitlich parallel zur Fehlerbehebung geklärt werden; sie werden nicht mit bestätigten Befunden vermischt.

## 6. Schrittweiser Sanierungsplan neben Featurearbeit

| Schritt | Arbeitspaket und Reihenfolge | Fertig, wenn … | Grober Aufwand |
| --- | --- | --- | --- |
| 1 – Fehler reproduzierbar absichern | Die Nachweise aus TD-01, TD-02, TD-04, TD-05 und TD-06 als gezielte Regressionstests übernehmen. Je Fix einen zunächst fehlschlagenden Test ergänzen; keine Anwendungskorrektur ohne denselben Test. | Die beschriebenen Fälle schlagen am heutigen Stand gezielt fehl und werden durch die jeweilige Änderung behoben. | In den Befundschätzungen enthalten |
| 2 – Betrieb zuerst stabilisieren | TD-01 schließen; TD-02 und TD-04 als kleine unabhängige Änderungen abarbeiten. Aufbewahrungsfrist der Ergebnisse bereits mit TD-06 abstimmen. | Ein fehlerhafter Socket beendet keine fremde Partie; inaktiver Match-/Quotenzustand wird zeitgesteuert abgebaut; Reconnect umgeht keine Quote. | **2½–5 PT** |
| 3 – Schutz dauerhaft machen | TD-03 unmittelbar einrichten; U-01 und U-02 durch den Betreiber parallel verifizieren. | Derselbe Commit besteht Tests/Build/Smoke vor Freigabe; Proxy-/Backup-/Alarmnachweise sind vorhanden oder als konkrete Folgetickets offen. | **1–2 PT** plus **1½–3 PT** Betreiberprüfungen |
| 4 – Datenintegrität und Fehlerdiagnose | U-04 vor einer Schemaerweiterung klären; TD-05 und TD-07 umsetzen. Kleinste notwendige Migration statt Datenbankwechsel. | Teilfehler rollen zurück; erneuter Abschluss zählt nicht doppelt; bestehende Datenbestände werden migriert; HTTP-Speicherfehler liefern 500 ohne Rohdetails. | **4–7 PT**, Migrationsarbeit in TD-05 enthalten |
| 5 – Verbindungen und Frontend verbinden | TD-06 schließen, dann TD-08 mit wenigen repräsentativen Browserabläufen absichern. Tests in das Gate integrieren. | Queue, aktive Partie, Timeout-Ergebnis und Lobby stimmen nach Reconnect/Neustart mit dem Server überein; vollständiges Spiel und Logout funktionieren im Browser. | **5–9 PT** |
| 6 – Abhängigkeiten und Folgeentscheidungen | TD-09 triagieren/kompatibel aktualisieren; U-03/U-05 als Produktentscheidungen behandeln. Nach Bedarf Last-/Dauertest für bereinigte Laufzeitdaten und synchrone DB-Zugriffe. | Advisory-Behandlung ist nachvollziehbar; keine unbegründeten Major-Upgrades; Fristen und weitere Betriebsziele sind explizit entschieden. | **1–2 PT** für TD-09; Produkt-/Lastarbeit separat |

Für TD-01 bis TD-09 ergeben sich insgesamt etwa **13½–25 PT**, mit gemeinsamer Regressionstest- und Reviewarbeit teilweise überlappend. Keine feste Kalenderzusage: Sinnvoll sind kleine Änderungen von höchstens wenigen Tagen und zunächst etwa ein Viertel der Entwicklungskapazität für die Sanierung. TD-01 hat wegen des nachgewiesenen Prozessabsturzes Vorrang vor dem nächsten öffentlichen Release. Großumbauten des Monorepos oder der Spielregeln sind für diese Maßnahmen nicht erforderlich.

## 7. Prüfabdeckung, Grenzen und bewusst nicht empfohlene Änderungen

**Geprüft:** Backendmodule für HTTP, WebSockets, Matchmaking, Spielzustand, Sessionfrist, SQLite, Quoten und Metriken; Shared-Spielregeln/-Typen/-Routing; React-Appzustand, Sessioncontroller/API, Login/Lobby/Platzierung/Bretter/Ergebnisse und Rechtstextkonfiguration; CSS/HTML hinsichtlich Struktur, Ressourcen und vorhandener responsiver Regeln; alle neun Testbereiche mit gezielter Sichtung der Fixtures und kritischen Assertions; npm-Manifeste/Lockfile, TypeScript/Vite, Docker/Compose, Ignore-/Environmentvorlagen, alle vier Betriebsskripte, README und Deployment-/Remediationdokumentation. Die historischen Fixberichte dienen dem Abgleich bereits behandelter Probleme und werden nicht als neue Ausführungsnachweise gewertet.

**Nicht möglich mangels Zielzugang bzw. effektiver Konfiguration:** Prüfung des produktiven Dokploy-/Traefik-Netzes, öffentlicher TLS-/DNS-/Forwarding-Ketten, Branchschutz/externem Release-Gate, realer Backups/Restores, tatsächlicher Alarmierung und realer Produktionslast. Es wurden weder Produktionsdaten noch private `.env`-Werte gelesen oder ein produktiver Dienst angesprochen. Lokale Containererfolge beweisen diese Eigenschaften nicht.

**Nicht durchgeführt:** echte Browser-/Screenreader-/Tastatur- und Mobilgeräteprüfung, React-DOM-Mounttests, Coverageinstrumentierung, Langzeit-/Last-/Heapmessung, Test unter Windows/NTFS, realer TLS-Handshake, vollständige Analyse jedes transitiven Advisory-Aufrufpfads und Scan des OS-Layer-Inhalts des Docker-Images. Die Browserchecks waren kein technischer Zugangsfehler, sondern sind eine verbleibende Validierungslücke dieses Audits. Der Container wurde mit produktionsnahen Sicherheitsoptionen gestartet, nicht über eine reale Dokploy-/Traefik-Installation. Die dynamischen Fehlerproben sind gezielte Robustheitsprüfungen, kein vollständiger Penetrationstest.

**Vorhandene Stärken:** Serverautorität und verdeckte Gegnerpositionen, feste Sessionfrist, Schutz vor veralteten Socket-/Accountcallbacks, echte HTTP-/WS-Integrationstests, SQLite-WAL/Foreign Keys, schlankes Runtime-Image, Containerhärtung, Shutdownpfad und konkrete Backup-/Proxyhinweise. Die frühere Aussage, native Integrationstests seien in Codex grundsätzlich unprüfbar, gilt für diesen Lauf nicht: Die Sandboxgrenze wurde mit freigegebener Ausführung überwunden.

**Keine Befunde allein aufgrund von Stil oder Größe:** Die Länge von `GameHub`, eigene HTTP-Routen, eigene UI-Bausteine, ein einzelnes CSS-Stylesheet, fehlende Memoisierung und einzelne wiederholte Brettkonstanten rechtfertigen ohne konkrete Folge keinen Umbau. Ebenso wird weder eine Bibliothek nur wegen einer älteren Version beanstandet noch der dokumentierte Einzelinstanzbetrieb pauschal als falsche Architektur gewertet. Refactorings sollten die oben belegten Fehlergrenzen, Zustandsübergänge und Testbarkeit verbessern und daran gemessen werden.
