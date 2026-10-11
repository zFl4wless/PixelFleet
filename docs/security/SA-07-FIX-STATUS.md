# SA-07: Cookie-Parsing und WebSocket-Upgrade

Stand: 2026-10-11. Basis des Fixes: `60b972f5c2b6a5cd520695c1d8d792f2d75ee5cb`; Arbeitsbaum vor dem Fix sauber. Lokaler Entwicklungsauftrag, kein neuer Security-Audit. Der ursprüngliche Vollaudit bleibt **incomplete**; dessen Metadaten und Ergebnisse werden durch diesen Fix nicht abgeschlossen.

## Änderung

Die Beobachtung aus `SESSION-AUTH-STATIC.md`, SA-07, wurde am Ausgangscode nachvollzogen: Cookie-Dekodierung konnte werfen; der separate WebSocket-Upgrade-Handler besaß keine lokale Ausnahmegrenze um Sessionauflösung und Initialisierung. Eine tatsächliche damalige Prozessfolge wurde nicht nachgewiesen.

- Fehlerhafte Cookie-Kodierung führt zu einem expliziten Fehler für den gesamten Header. Auch ein zuvor gelesener gültiger Sessionwert wird dann nicht verwendet. Der Fehler wird nicht in „keine Session“ umgewandelt und kann beim Gastlogin kein neues Konto erzeugen. Gültige Cookie-Dekodierung bleibt erhalten.
- Der Upgrade-Einstieg weist Dekodierfehler kontrolliert mit 400 und unerwartete Fehler vor dem Handshake generisch mit 500 ab. Bestehende 401/403/429 bleiben erhalten. Ablehnungen schließen den Transport und setzen keine Session-Cookies.
- Nach einem bereits erfolgten Handshake wird eine fehlgeschlagene Initialisierung durch Terminierung bereinigt. Belegte aktive Verbindungsplätze werden genau einmal freigegeben; Fehlversuche bleiben im Versuchslimit berücksichtigt.
- Der vorhandene GameHub-Close-Handler wird vor weiteren Initialisierungsschritten installiert, damit keine teilweise registrierte Verbindung zurückbleibt.

Geänderte Anwendungspfade: `apps/backend/src/http.ts`, `apps/backend/src/server.ts`, `apps/backend/src/game-hub.ts`. Andere Audit-Punkte sind nicht Bestandteil dieses Fixstands.

## Regressionstests

Fünf neue Unit-Fälle in `tests/http.test.ts` prüfen gültige, zusätzliche und URL-kodierte Cookies, fehlende Sessions und mehrere Kategorien ungültiger Kodierung einschließlich fehlerhafter zusätzlicher Cookies.

Fünf neue Integrationstests in `tests/deployment.test.ts` prüfen HTTP-Ablehnung ohne Konto-/Sessionerzeugung, gültige WebSocket-Anmeldung und Verbindungsgrenzen, kontrollierte Session-Speicherfehler, Bereinigung nach einem Initialisierungsfehler sowie die Anrechnung fehlgeschlagener Upgrade-Versuche. SQLite-Dateien, Konten und Adminwerte sind ausschließlich temporäre Dummy-Fixtures. Fehler werden nur innerhalb dieser Fixtures injiziert; Anwendungscode enthält keine Testschalter.

## Validierung und Herkunft der Ergebnisse

| Prüfung | Ergebnis | Ausgeführt von |
| --- | --- | --- |
| Vollständige Suite: fünf Testdateien, alle 30 Tests | **bestanden, vom Nutzer gemeldet** | Nutzer, außerhalb der Codex-Sandbox, laut Nutzer derselbe Fixstand |
| `npm run typecheck` | **bestanden, Exit 0** | Codex, übliche Codex-Sandbox |
| `npm run build` | **bestanden, Exit 0**; Shared, Backend, Frontend | Codex, übliche Codex-Sandbox |
| `git diff --check` | **bestanden** | Codex |

Der erfolgreiche vollständige Testlauf ist ausdrücklich **nutzerausgeführt**. Codex hat diesen externen Lauf nicht selbst ausgeführt oder unabhängig beobachtet; Grundlage ist die ausdrückliche Bestätigung des Nutzers am 2026-10-11 für denselben Fixstand.

Historische Codex-Testläufe: gezielt 11 bestanden / 10 fehlgeschlagen; vollständig 20 bestanden / 10 fehlgeschlagen. Alle zehn Fehlschläge waren Serverstarts mit `listen EPERM: operation not permitted 0.0.0.0`, bevor die Integrationsszenarien erreicht wurden. Die Cookie-Unit-Tests bestanden bereits dort. Dieser historische Sandbox-Blocker wird durch die erfolgreiche Nutzervalidierung ergänzt, nicht als eigener Codex-Testerfolg umgedeutet.

Die Entwicklungsbefehle wurden in Codex mit bereinigter Umgebung, temporären Home-/Cache-/Datenbankpfaden und npm im Offline-Modus ausgeführt. Keine Dependency-Installation, Rechteerweiterung, produktiven Daten, externen Testziele, Veröffentlichung oder Deployment.

## Grenzen

Die Validierung betrifft den unten festgehaltenen SA-07-Fixstand und die vorhandenen Regressionstests. Sie ersetzt weder die unabhängige Verifikation noch die offene Coverage des ursprünglichen Vollaudits. Dessen Status bleibt **incomplete**. Spätere Anwendungsereignisse, andere Audit-Punkte und wirksame Deployment-Kontrollen sind nicht Bestandteil dieser SA-07-Validierung.

## Fixstand vor nachfolgenden Änderungen (SHA-256)

- `apps/backend/src/http.ts`: `64ef66c7c76829076c2c9a0401a61f9a6c13c82b2b9c28ae2eb3a8793fcbe875`
- `apps/backend/src/server.ts`: `7a98b97baa692ba08cdf2760c792f1bd74f63264327a680e5a0726e0acece4f7`
- `apps/backend/src/game-hub.ts`: `7a9ca063a876d63177fd40c76d5366230ab3e449ff856a9eb6034bcc73980ef1`
- `tests/http.test.ts`: `308e9a9a235c2f485dc89ab5e0667710e60d9c6acad8f4da98b14538f9a865ae`
- `tests/deployment.test.ts`: `2423a13bc9eba18ac66bb34f5b09c702d5737cc6e21e7b5f65b6c8757cdcd26e`

## Lokaler Commitversuch

Der angeforderte Commit `fix: handles malformed cookies during websocket upgrades` konnte in Codex nicht erstellt werden: Bereits `git add` scheiterte mit `fatal: Unable to create .../.git/index.lock: Operation not permitted`. Es wurden keine erweiterten Hostrechte angefordert. Vor den folgenden SA-01/SA-02-Änderungen wurde der isolierte SA-07-Diff einschließlich dieses Statusberichts als lokaler Patch gesichert.
