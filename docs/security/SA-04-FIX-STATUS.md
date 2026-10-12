# SA-04: Feste serverseitige Laufzeit für Gast-Sessions

Stand: 2026-10-12. Normaler lokaler Entwicklungsauftrag, ausschließlich SA-04 aus `~/security-audit-skill/PixelFleet/run-1/SESSION-AUTH-STATIC.md`. Ausgangscommit: `774d35cfd513fc6d1133dce3e8f190803042196b` (`fix: ignores stale frontend session and socket callbacks`); Arbeitsbaum zu Beginn sauber. Die zuvor vom Nutzer gemeldeten 99/99 Tests und der begrenzte Browsercheck gehören zum SA-08-Stand, nicht zu dieser Änderung.

**Status:** SA-04 implementiert; **120/120 Tests der vollständigen Suite bestanden, vom Nutzer ausgeführt und gemeldet**. Codex hat diesen Lauf nicht unabhängig beobachtet. **20/20 neue zeitgesteuerte Tests, Typecheck und Build bestanden zuvor in Codex** für denselben ausführbaren Quell- und Teststand. Der historische vollständige Codex-Lauf mit 98 bestandenen / 22 wegen `listen EPERM` fehlgeschlagenen Tests bleibt getrennt dokumentiert. Der Fix wird für den separaten Commit `fix: expires guest sessions after 365 days` vorbereitet. Kein neuer Security-Audit, Push oder Deployment. Der ursprüngliche Vollaudit bleibt **incomplete**.

## Beobachtung und Produktentscheidung

Am Ausgangsstand prüfte `getSessionByToken` die Existenz des Tokens und aktualisierte `last_seen_at`, ohne eine serverseitige Ablaufbedingung. `sessionCookie` setzte ein Jahr `Max-Age`; diese Browserregel begrenzte weder die serverseitige Tokenberechtigung noch bereits authentifizierte WebSockets. Die Beobachtung aus SA-04 trifft auf diesen Ausgangsstand zu.

Die nun ausdrücklich gewählte Frist beträgt **365 × 24 Stunden = 31.536.000 Sekunden** ab der ursprünglichen Erstellung der jeweiligen Session, nicht ein Kalenderjahr und nicht eine Inaktivitätsfrist. Nutzung verlängert diese Frist nicht. Logout widerruft weiterhin sofort. Ablauf löscht weder das Gastkonto noch dessen Statistiken.

## Korrektur und Invarianten

| Invariante | Umsetzung im Fixstand |
| --- | --- |
| Eine gemeinsame absolute Frist | `apps/backend/src/session-lifetime.ts:1`: feste Dauer; `sessionExpiresAt(createdAt)` berechnet die Deadline. `db.ts:173`, `:199` liefern sie an Cookieausgabe und WebSocket-Verbindung weiter. |
| Bestehende Sessions behalten ihr Alter | `db.ts:189`: Lookup liest ausdrücklich `sessions.created_at`, nicht das Erstellungsdatum des Kontos. Keine Migration, kein pauschaler Reset und keine Änderung gespeicherter Erstellungszeiten. Bereits mindestens 365 Tage alte Sessions werden ab diesem Fix abgewiesen. |
| Ab Ablauf keine Authentifizierung | `db.ts:200`: `Date.now() >= expiresAt` liefert `null`, bevor `last_seen_at` aktualisiert wird. Nicht lesbare Erstellungszeit liefert ebenfalls keine Berechtigung und keine neue Frist. |
| HTTP und neue WebSockets verwenden denselben Lookup | `db.ts:209`, `server.ts:418`: HTTP-Profilprüfung und Upgradeprüfung verwenden die Ablaufbedingung. Ein bereits beim Lookup abgelaufenes Token führt bei `/api/me` und Upgrade zu HTTP 401. |
| Cookie-Laufzeit verlängert die Frist nicht bei Nutzung | `http.ts:44`, `server.ts:330`: Ausgabe erhält dieselbe Deadline und setzt `Max-Age` auf die verbleibenden, abgerundeten ganzen Sekunden, mindestens null. Ein gültiger wiederholter Gastlogin stellt keinen neuen Cookie aus. Cookie-Scope und Secure-Entscheidung sowie Löschattribute bleiben unverändert. |
| Ablauf zwischen Lookup und Upgradeabschluss wird abgefangen | `game-hub.ts:100`: Erneute Prüfung vor Aufnahme der Verbindung und vor Verdrängung einer gültigen unabhängigen Verbindung. Bereits aufgerüstete, inzwischen abgelaufene Verbindungen werden mit dem bestehenden Code 4003 geschlossen. |
| Offene WebSockets verlieren ihre Rechte auch ohne Nachrichten | `game-hub.ts:162`: Pro aktueller Verbindung läuft ein Ablauf-Timer. Er ruft bei Erreichen der absoluten Deadline die vorhandene `revokeSession`-Behandlung auf: sofortige Invalidierung, Queue-/Disconnectbehandlung und Close 4003. |
| Die Jahresfrist darf Node-Timer nicht überlaufen lassen | `game-hub.ts:28`, `:172`: Timerabschnitte sind auf `2 ** 31 - 1` ms begrenzt; nach jedem Abschnitt wird die verbleibende Zeit zur ursprünglichen Deadline neu berechnet. Es entsteht keine neue Sessionfrist. |
| Verzögerte Timer erlauben keine verspäteten Aktionen | `game-hub.ts:147`: Aktuelle Verbindungsidentität und Frist werden zusätzlich vor Nachrichtenverarbeitung und Senden geprüft. Bei Ablauf erfolgt Widerruf, bevor eine Nachricht dekodiert oder ein Fehlerbudget belastet wird. |
| Alte Timer beeinflussen keine Ersatzverbindung | `game-hub.ts:109`, `:157`, `:188`, `:742`: Disconnect, Ersatz und Runtime-Reset löschen den Timer. Ein schon zugestellter alter Callback prüft zusätzlich Widerruf und Identität der ursprünglichen Verbindung. |
| Ablauf einer Session widerruft keine unabhängige Session | Vorhandene `revokeSession(sessionId)`-Bindung bleibt erhalten. Ein gültiger Ersatz derselben Person aus einer später erstellten unabhängigen Session bleibt berechtigt. |

Die bestehende Behandlung von Logout, Verbindungsersatz und Runtime-Reset sowie die Spielregeln bleiben erhalten. Bei Ablauf im aktiven Match gilt weiterhin die 30-Sekunden-Disconnectfrist; danach wird ein nicht wieder verbundener Spieler nach der vorhandenen Forfeit-Regel gewertet. Ablauf selbst löscht keine Statistiken; eine spätere reguläre Matchwertung darf sie weiterhin aktualisieren.

Abgelaufene Sessionzeilen dürfen gespeichert bleiben, authentifizieren aber nicht mehr. Es wurde keine Bereinigungs- oder Wiederherstellungsfunktion hinzugefügt. Historische Browsercookies werden nicht pauschal ersetzt; ihre gespeicherten Tokens unterliegen sofort der serverseitigen Frist anhand des vorhandenen `created_at`.

## Frontend und Zugang nach Ablauf

Die bereits implementierte SA-08-Behandlung in `apps/frontend/src/lib/sessionConnection.ts:164` führt bei Close **4003** zum Loginzustand, invalidiert alte Vorgänge und startet keinen Reconnect. Sie wird für Ablauf unverändert wiederverwendet. Bei einem vom Browser nur als Netzunterbrechung sichtbaren abgewiesenen Handshake unterscheidet die Profilprüfung HTTP **401** von Netzwerkfehlern (`apps/frontend/src/lib/api.ts:32`). So beendet auch ein abgelaufenes Token den Accountzustand. Echte vorübergehende Netzunterbrechungen behalten das bestehende Reconnect-Verhalten.

README und die sichtbaren Cookie-/Aufbewahrungstexte in `LegalPages.tsx` beschreiben die feste Frist und die erhaltenen Kontodaten. **Ohne separate Wiederherstellungsfunktion ist nach Ablauf der Gast-Session kein erneuter Zugang zum bisherigen Gastkonto möglich. Ein neuer Gastlogin erzeugt ein neues Konto, auch bei gleichem Anzeigenamen.** Eine bereits vorhandene andere gültige Session wird durch den Ablauf dieser Session nicht widerrufen. Kein Frontend-Controller oder React-Lebenszyklus wurde geändert.

## Regressionstests

`tests/session-expiry.test.ts` enthält **20 neue Tests**, jeweils mit Fake-Zeit, temporärer SQLite-Datenbank und Dummy-Konten. Sie prüfen das Verhalten der tatsächlichen Datenbankfunktionen und des GameHubs über Profile, Nachrichten, Close-Ereignisse, Queue-/Matchzustand und erhaltene Kontodaten:

- Neuerstellung mit exakt 365 Tagen; bestehende Session vor, genau am und nach Ablauf; ursprüngliches Sessiondatum statt Kontodatum; ungültiges gespeichertes Datum führt nicht zu neuer Berechtigung.
- Wiederholte Profilabfragen und Socketaktionen verlängern die Frist nicht; `created_at` bleibt unverändert. Cookie-Restlaufzeit wird abgerundet und endet bei null.
- Ruhender neuer Socket über die gesamte 365-Tage-Frist einschließlich mehrerer Timerabschnitte; ruhender Socket einer bestehenden Session mit kurzer Restlaufzeit.
- Nachricht am Ablaufzeitpunkt bei noch nicht ausgeführtem Timer: keine Dekodierung oder Verarbeitung und kontrollierter Widerruf.
- Neue abgelaufene Verbindung genau am und nach Ablauf verdrängt keine gültige unabhängige Verbindung.
- Timerbereinigung bei Disconnect, Verbindungsersatz, Runtime-Reset und Logout; bereits zugestellte alte Callbacks bleiben wirkungslos für eine Ersatzverbindung.
- Unabhängige spätere Session bleibt gültig; erhaltene Profile und vorhandene Statistiken; bisherige Disconnect-/Forfeit-Regel bei Ablauf während eines Matches.

Ein zusätzlicher nativer Test in `tests/deployment.test.ts:153` prüft mit echten HTTP-Anfragen und WebSockets gegen einen ausschließlich lokalen Testprozess: bestehende Session unmittelbar vor Ablauf gültig, wiederholter Login ohne Erneuerung, Socketersatz vor der Grenze, autonomer Close 4003 ohne weitere Nachricht, HTTP-/Upgrade-401 genau am und nach Ablauf, erhaltenes Sessiondatum und Kontostatistiken sowie neuer Gastlogin mit neuer Identität. Die Uhrsteuerung existiert nur in einer temporären Testdatei und wird über Prozess-IPC ausgelöst; nur `Date` ist ersetzt, Node-Timer und WebSocket-Close-Ereignisse bleiben nativ. **In Codex erreichte dieser Test wegen EPERM seine Verhaltensprüfungen nicht; laut Nutzer bestand er anschließend als Teil der vollständigen Suite mit 120/120 Tests.**

Die vorhandenen Session-/Matchtests erhalten lediglich die nun erforderliche Deadline im Verbindungsfixture. Der vorhandene Cookieattributtest wurde auf die gemeinsame Deadline angepasst, der native Ausgabetest toleriert die abgelaufene erste Sekunde. Origin-/Proxyentscheidungen wurden nicht geändert. Die 29 bestehenden Frontend-Verhaltenstests einschließlich 4003, HTTP 401 und zulässigem Reconnect bestanden in beiden Läufen.

## Testumgebung und ausgeführte Prüfungen

Vor der Ausführung wurden npm-Skripte, Testhelfer und Umgebung auf temporäre Datenbankpfade, Dummy-Konten/-Token und lokale Testziele geprüft. Jeder datenbanknutzende Helfer setzt den temporären Pfad vor dem Backendimport. Die Ausführung verwendet die vorhandene Node-24.20.0-Toolchain, die normale Codex-Sandbox und einen bereinigten Launcher mit temporären Home-/Cache-/TMPDIR-/Fallback-Datenbankpfaden sowie npm offline. Keine Dependency-Installation, echten Datenbanken oder Zugangsdaten, produktiven Dienste, externen Testziele, erweiterten Hostrechte oder Deployment.

Launcher und temporäre Ausführungsprotokolle der historischen Codex-Läufe: `/private/tmp/pixelfleet-sa04-validation-m7uu4197/run.py`, `command-1.log` bis `command-4.log`; Exitcodes sind separat in `command-*.exit` gespeichert. Die Codex-Befehle wurden in folgender Reihenfolge ausgeführt: gezielter Lauf, Typecheck, Build, vollständige Suite. Der spätere erfolgreiche vollständige Lauf stammt vom Nutzer; seine Ausführung wurde von Codex nicht beobachtet.

| Prüfung | Ergebnis und Herkunft |
| --- | --- |
| Vollständige Suite, anschließender manueller Lauf | **120/120 bestanden, vom Nutzer ausgeführt und gemeldet**; nicht unabhängig durch Codex beobachtet |
| Gezielter Lauf, Befehl unten | Historischer Codex-Lauf: **Exit 1**, sechs Dateien: 89 bestanden / 22 fehlgeschlagen, insgesamt 111 Tests; neue zeitgesteuerte Tests **20/20 bestanden** |
| `npm run typecheck` | Codex: **Bestanden, Exit 0** |
| `npm run build` | Codex: **Bestanden, Exit 0**, Shared, Backend und Frontend |
| Vollständige Suite, Befehl unten | Historischer Codex-Lauf: **Exit 1**, neun Dateien: 98 bestanden / 22 fehlgeschlagen, insgesamt 120 Tests |
| `git diff --check` | **Bestanden** |

Gezielter ausgeführter Befehl:

```sh
npm test -- tests/session-expiry.test.ts tests/session-authorization.test.ts tests/match-membership.test.ts tests/http.test.ts tests/frontend-session.test.ts tests/deployment.test.ts --maxWorkers=1 --minWorkers=1 --no-file-parallelism
```

Alle 22 im historischen Codex-Lauf fehlgeschlagenen nativen Deploymenttests brechen vor ihrem eigentlichen Szenario beim Start des Servers ab:

```text
Error: listen EPERM: operation not permitted 0.0.0.0
code: 'EPERM'
errno: -1
syscall: 'listen'
address: '0.0.0.0'
Node.js v24.20.0
```

Diese historischen Tests wurden weder als bestanden noch als übersprungen gezählt. Von den 23 Deploymenttests bestand dort lediglich der Startabbruch bei fehlendem Frontend ohne Listener. Es wurde keine Sandboxumgehung angefordert. Der vollständige Testbefehl mit den temporären Fixtures und Dummy-Daten lautet:

```sh
cd /Users/noahbauditz/Documents/Projects/PixelFleet
npm test -- --maxWorkers=1 --minWorkers=1 --no-file-parallelism
```

Testzahl am dokumentierten Stand: **120 Tests in neun Dateien**; vom Nutzer gemeldetes Ergebnis **120/120 bestanden**. Der gezielte Befehl hat **111 Tests in sechs Dateien**, davon **23 Deploymenttests**. Die zuvor ausstehende lokale Integrationsvalidierung ist damit laut Nutzer abgeschlossen. Für diese Statusaktualisierung und Commitvorbereitung wurden weder Tests noch Browserchecks erneut gestartet; Quellcode und Tests sind unverändert.

## Verbleibende Grenzen

- Native HTTP-/WebSocket-Integration einschließlich Ablauf und Freigabe der aktiven Verbindungsquote blieb in Codex wegen Listener-EPERM ungeprüft. Laut Nutzer bestanden anschließend sämtliche Integrationstests; Codex hat diesen Lauf nicht unabhängig beobachtet.
- Die automatisierten Ablaufgrenzen verwenden kontrollierte Zeit und Transport-Doubles; der native Test ergänzt diese laut erfolgreichem Nutzerlauf. Das ersetzt keine Beobachtung eines realen 365-Tage-Betriebs.
- Ein Browsercheck für den neuen Ablaufpfad und browserseitige Cookieablaufzeit wurde nicht ausgeführt. `Max-Age` hat Sekundenauflösung und beginnt browserseitig beim Empfang; die serverseitige Deadline bleibt unabhängig von Browseruhr, Empfangsverzögerung oder Cookieaufbewahrung maßgeblich. Eine umfassende Browser-/React-DOM-Abdeckung wird nicht behauptet.
- Die Frist nutzt die Serveruhr. Timer werden autonom geplant, ihre physische Zustellung kann durch Eventloop- oder Betriebssystempausen verzögert werden; vor jeder weiteren Nachrichtenverarbeitung und beim Authentifizierungslookup wird die absolute Frist erneut durchgesetzt. Manipulierte oder falsch synchronisierte Betriebsuhren wurden nicht getestet.
- Bestehende Sessions wurden über temporäre Fixtures mit gespeicherten Erstellungszeiten geprüft. Keine echte Datenbank wurde geöffnet oder geändert. Es gibt keinen neuen Wiederherstellungsweg oder Löschjob; die produktive Proxy-Konfiguration bleibt ungeprüft.

## Diff und geprüfter Stand

Ausschließlich für den SA-04-Commit ausgewählt: `apps/backend/src/session-lifetime.ts`, `db.ts`, `game-hub.ts`, `http.ts`, `server.ts`; `tests/session-expiry.test.ts`, `deployment.test.ts`, `http.test.ts`, `match-membership.test.ts`, `session-authorization.test.ts`; `README.md`, `apps/frontend/src/components/legal/LegalPages.tsx` und dieser Statusbericht. Keine unbeabsichtigten Änderungen festgestellt. Dependencies, Shared-Code, CI, Deploymentkonfiguration und andere Audit-Punkte sind unverändert. Die anschließend erstellte Übersicht `docs/security/REMEDIATION-STATUS.md` gehört nicht zur Auswahl für diesen separaten Fixcommit.

Nach den Ausführungsprüfungen wurden ausschließlich ein erklärender Kommentar in `http.ts` präzisiert und dieser Bericht ergänzt; ausführbarer Quellcode und Tests sind unverändert. SHA-256 des finalen Quell-/Teststands:

| Datei | SHA-256 |
| --- | --- |
| `apps/backend/src/session-lifetime.ts` | `4ca42a0b1eab8d53983ae8d7bade8bfc61c4fd5ea845de98321805eea9b3b45a` |
| `apps/backend/src/db.ts` | `7fd3962029a626c9ca654288ac27b5a3a6f9e514c57fb1bbf452b5a18aa71688` |
| `apps/backend/src/game-hub.ts` | `e60da0c14aee21bfd5fd193bb55605eabc18f1d0dc3c4e28f8c95304431b8b59` |
| `apps/backend/src/http.ts` | `b4479fdd59c3c452f85f677ee979f1ce51f4fd01be44e6c895fff47d99fa6774` |
| `apps/backend/src/server.ts` | `3d81f8b0a0039e7a3abb1f47d8f3a2eb67e84607e126ee925608a948ea1c7484` |
| `tests/session-expiry.test.ts` | `a62fa11f221c001737238cc3fad978e08662de9cdfe115d2e922e157e2ad2698` |
| `tests/deployment.test.ts` | `36a2aaf39c3e885e013b857422058808f3c404ca43734125146a207207354387` |
| `tests/http.test.ts` | `1c09ae3b7cb432af045eb6e719f887585f99800051e95b3bf4ce5f558ff3affb` |
| `tests/match-membership.test.ts` | `c0e4a3a21f12d902a9f7aeee17a3b5f5b8801ae4328335b1179c1f46dd7eaa29` |
| `tests/session-authorization.test.ts` | `d296671bc458d7d465bef60ae459b205400328a8adafacf313001eebea7248a7` |

## Commitvorbereitung

Vorgesehener separater Commit: `fix: expires guest sessions after 365 days`.

Am 2026-10-12 wurde ausschließlich das Staging der 13 oben ausgewählten SA-04-Dateien versucht. Git brach mit Exit 128 ab:

```text
fatal: Unable to create '/Users/noahbauditz/Documents/Projects/PixelFleet/.git/index.lock': Operation not permitted
```

Der Index blieb unverändert und leer; ein Commit wurde nicht ausgeführt. Es wurden keine erweiterten Rechte angefordert. Die exakt ausgewählten Befehle für das lokale Terminal lauten:

```sh
cd /Users/noahbauditz/Documents/Projects/PixelFleet
git add -- README.md apps/backend/src/db.ts apps/backend/src/game-hub.ts apps/backend/src/http.ts apps/backend/src/server.ts apps/backend/src/session-lifetime.ts apps/frontend/src/components/legal/LegalPages.tsx tests/deployment.test.ts tests/http.test.ts tests/match-membership.test.ts tests/session-authorization.test.ts tests/session-expiry.test.ts docs/security/SA-04-FIX-STATUS.md
git commit -m "fix: expires guest sessions after 365 days"
```

`docs/security/REMEDIATION-STATUS.md` wird separat als Übersicht erstellt und mit diesen Befehlen ausdrücklich nicht gestaged.

Der ursprüngliche Auditdatensatz wurde nicht geändert: `run-metadata.json` enthält weiterhin `run_status: incomplete`, SHA-256 `86d5a650d4af8589a632390586ed2b9b9d94bb7506d8420d7044dba8b4d1226d`. Der ursprüngliche Vollaudit bleibt **incomplete**.
