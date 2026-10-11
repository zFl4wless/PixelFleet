# SA-05: Entwicklungs-Originprüfung nach tatsächlichem Adresstyp

Stand: 2026-10-11. Normaler lokaler Entwicklungsauftrag, ausschließlich SA-05 aus `~/security-audit-skill/PixelFleet/run-1/SESSION-AUTH-STATIC.md`. Ausgangscommit: `fef3d7290948cd288a4ba63e433ee22e8ae5279e` (`fix: separates active matches from retained results`), Arbeitsbaum zu Beginn sauber. Der zuvor vom Nutzer gemeldete Erfolg mit **50/50 Tests** gehört zum separat committeten SA-03-Stand und ist kein Testergebnis für diesen Fix.

**Status:** SA-05 implementiert; die vollständige Suite mit **58/58 Tests ist bestanden, vom Nutzer ausgeführt und am 2026-10-11 gemeldet**. Das umfasst die native HTTP-/CORS-/WebSocket-Validierung. Codex hat diesen Lauf nicht selbst ausgeführt oder unabhängig beobachtet. Typecheck und Build waren bereits für denselben Fixstand in Codex erfolgreich. Separater Commit vorgesehen: `fix: validates ip addresses before allowing development origins`. Kein Push oder Deployment. Der ursprüngliche Vollaudit bleibt **incomplete**.

## Beobachtung am Ausgangsstand

`apps/backend/src/http.ts:110` prüfte im Hostklassifizierer `startsWith("fc")` und `startsWith("fd")`, ohne IPv6-Syntax zu verlangen. Dadurch konnten DNS-Namen mit diesen Präfixen bei HTTP(S) und einem Vite-Port automatisch Entwicklungsfreigaben erhalten. Auch kurze gültige IPv6-Hextette wie `fc::1` haben numerisch nicht den ULA-Präfix `fc00::/7`, obwohl ihre Textdarstellung mit `fc` beginnt. Die Beobachtung ist am Ausgangscommit weiterhin zutreffend. Der bestehende Produktionszweig deaktivierte bereits automatische Entwicklungsfreigaben.

HTTP-POST- und WebSocket-Originprüfung verwenden `isTrustedOrigin` (`apps/backend/src/server.ts:295`, `:404`); dieses Prädikat und CORS verwenden gemeinsam `isAllowedOrigin`. Der Fix setzt an diesem gemeinsamen Hostklassifizierer an. Daraus wird keine beobachtete Browser- oder Produktionswirkung abgeleitet.

## Kleinste Korrektur und erhaltene Regeln

- `apps/backend/src/http.ts:111`: `localhost` und `.localhost` bleiben ausdrückliche lokale Namensregeln. Für alle anderen Hosts stellt `node:net.isIP` zuerst fest, ob überhaupt eine gültige IPv4- oder IPv6-Adresse vorliegt. Andere DNS-Namen bekommen keine automatische Freigabe allein aufgrund ihrer Schreibweise.
- `apps/backend/src/http.ts:117`: Nur tatsächliche IPv4-Adressen erreichen die vorhandene IPv4-Bereichsprüfung. Die bisherigen Freigaben bleiben erhalten: `0.0.0.0/8`, `10.0.0.0/8`, `127.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16` und `169.254.0.0/16`.
- `apps/backend/src/http.ts:125`: Erst nach erfolgreicher IPv6-Typprüfung wird das erste Hextett numerisch ausgewertet. Erlaubt bleiben Loopback `::1`, ULA `fc00::/7` und die bisherige Freigabe `fe80::/16`. Der Umfang der bisherigen `fe80:`-Regel wird erhalten; andere linklokale Hextette werden nicht zusätzlich freigegeben. Kurze Hextette `fc`, `fd`, `fc0` oder `fd0` liegen außerhalb des ULA-Bereichs.
- `apps/backend/src/http.ts:131`: Automatische Freigaben bleiben auf HTTP(S), Vite-Ports **5173–5179** und Nichtproduktion beschränkt. In Produktion gibt es keine automatische Entwicklungsfreigabe. Exakte Originfreigaben für den Request-Host sowie ausdrücklich konfigurierte `FRONTEND_ORIGIN`-Werte bleiben erhalten.
- `apps/backend/src/http.ts:144`, `:154`, `:163`: HTTP-Vertrauen, CORS und WebSocket-Vertrauen verwenden weiterhin dieselbe Originentscheidung. Keine Änderungen am Serverrouting oder an der Behandlung fehlender Origin-Header.

Keine Änderungen an Proxyvertrauen, Proxy-Headern, Cookie-/Sessionlogik, Matchzuordnung, Limits, Datenbankschema, Frontend oder Deploymentkonfiguration. Geändert wurden ausschließlich `apps/backend/src/http.ts`, `tests/http.test.ts`, die SA-05-Testfälle samt optionalem Originparameter des lokalen Sockethelfers in `tests/deployment.test.ts` und dieser Bericht.

## Regressionstests

Sechs neue Fälle in `tests/http.test.ts:85` prüfen das öffentliche Verhalten:

1. DNS-Namen mit `fc`-/`fd`-/`fe80`-ähnlichen Präfixen werden abgewiesen; ausdrückliche localhost-Namen bleiben erlaubt.
2. Tatsächliche lokale/private IPv4- und IPv6-Adressen einschließlich Bereichsgrenzen, Großschreibung und ausgeschriebener IPv6-Darstellung bleiben erlaubt.
3. Andere Bereiche, kurze IPv6-Hextette außerhalb ULA und ungültige IPv4-/IPv6-Syntax werden abgewiesen. Die vorhandene Behandlung von IPv4-gemappten IPv6-Adressen und nicht freigegebenen linklokalen Hextetten bleibt erhalten.
4. Alle sieben erlaubten Ports funktionieren für HTTP und HTTPS; andere Ports, ungültige Ports und andere Schemes erhalten keine automatische Freigabe.
5. Produktion deaktiviert sämtliche automatischen Kategorien für alle Vite-Ports; ausdrückliche Konfiguration und Request-Host-Freigaben bleiben wirksam.
6. Eine erwartungsbasierte Originmatrix prüft `isAllowedOrigin`, das von HTTP und WebSocket verwendete `isTrustedOrigin` sowie die tatsächlich gesetzten CORS-Header in Entwicklung und Produktion.

Zwei neue native Fälle in `tests/deployment.test.ts:153` prüfen Entwicklung und Produktion jeweils mit derselben Kategorienmatrix über OPTIONS/CORS, HTTP-POST und authentifizierten WebSocket-Upgrade. Sie verwenden ausschließlich eine lokale temporäre Fixture-Datenbank und ein Dummy-Konto. Andere Hostnamen erscheinen nur im Origin-Header; die Testverbindungen gehen immer zum lokalen Server auf `127.0.0.1`. Beide Szenarien wurden im historischen Codex-Lauf wegen der Listenerbeschränkung nicht erreicht; laut dem vom Nutzer gemeldeten vollständigen Lauf sind sie inzwischen bestanden.

## Testumgebung und tatsächliche Ergebnisse

Vor Ausführung wurden die npm-Skripte, Buildkonfiguration und Testhelfer geprüft. Alle Datenbanktests setzen vor dem Datenbankimport eigene temporäre SQLite-Pfade. Die Deploymenthelfer starten den lokalen Server mit Port 0, temporären Frontend-Fixtures und Dummy-Token. Die Origin-Unit-Tests führen keine DNS-Auflösung oder Netzwerkaufrufe aus.

Die historischen Codex-Prüfungen liefen in der üblichen Codex-Sandbox mit der vorhandenen Node-24.20.0-Toolchain, npm im Offline-Modus, bereinigtem Environment und temporären Home-/Cache-/TMPDIR-/Fallback-Datenbankpfaden. Keine Dependency-Installation, erweiterten Hostrechte, echten Datenbanken, Zugangsdaten, produktiven Dienste oder externen Testziele. Die protokollierten Endergebnisse beziehen sich auf den finalen Quell- und Teststand. Temporäre Testprotokolle: `/private/tmp/pixelfleet-sa05-validation-2n_puayo/command-*.log`.

| Prüfung | Tatsächlich beobachtetes Ergebnis |
| --- | --- |
| Vollständige Suite, sieben Dateien / 58 Tests | **Bestanden, vom Nutzer ausgeführt und am 2026-10-11 gemeldet: 58/58 Tests** |
| Historischer Codex-Lauf: `npm test -- tests/http.test.ts tests/deployment.test.ts --maxWorkers=1 --minWorkers=1 --no-file-parallelism` | Exit 1: zwei Dateien, **17 bestanden / 15 fehlgeschlagen**, insgesamt 32 Tests. Alle 16 HTTP-Tests bestanden. |
| `npm run typecheck` | **Bestanden, Exit 0** |
| `npm run build` | **Bestanden, Exit 0**, Shared, Backend und Frontend |
| Historischer vollständiger Codex-Lauf: `npm test -- --maxWorkers=1 --minWorkers=1 --no-file-parallelism` | Exit 1: sieben Dateien, **43 bestanden / 15 fehlgeschlagen**, insgesamt 58 Tests |
| `git diff --check` | **Bestanden** |

Alle 15 fehlgeschlagenen Tests im historischen Codex-Lauf waren native Deploymenttests und brachen beim Serverstart vor ihren Integrationsszenarien ab:

```text
Error: listen EPERM: operation not permitted 0.0.0.0
code: 'EPERM'
errno: -1
syscall: 'listen'
address: '0.0.0.0'
Node.js v24.20.0
```

Die historischen Fehlschläge werden weder als Codex-Erfolg noch als übersprungen umgedeutet; ihre Integrationsszenarien wurden in Codex nicht geprüft. Der einzige bestandene Deploymenttest benötigt keinen Listener und prüft den Startabbruch bei fehlendem Frontend. Die vollständige Suite war in Codex **nicht bestanden**. Die erfolgreichen Prädikat-/CORS-Tests ersetzen keinen nativen Integrationstest.

## Nutzerausgeführte Validierung und Grenzen

Der Nutzer bestätigte am 2026-10-11 den erfolgreichen vollständigen Lauf mit **58/58 Tests** für diesen SA-05-Fixstand. Die zuvor ausstehende manuelle Validierung ist damit laut Nutzer abgeschlossen, einschließlich der nativen Originfälle in Entwicklung und Produktion. Dieser Erfolg ist ausdrücklich **nutzerausgeführt**; Codex hat ihn nicht selbst ausgeführt oder unabhängig beobachtet. Die historischen Sandboxfehler bleiben dokumentiert. Für diese reine Status- und Commitvorbereitung wurden keine Tests oder anderen Zielprogramme erneut ausgeführt.

Browserseitige SameSite-/Cookie-Wirkung und tatsächliche Deployment-Origin-/Host-Konfiguration wurden nicht beobachtet. Der ursprüngliche Auditdatensatz ist unverändert; `run-metadata.json` enthält weiterhin `run_status: incomplete`, SHA-256 `86d5a650d4af8589a632390586ed2b9b9d94bb7506d8420d7044dba8b4d1226d`.

Der verbleibende Diff wurde erneut geprüft: ausschließlich IP-Typ- und IPv6-Bereichsprüfung in `apps/backend/src/http.ts`, sechs neue HTTP-Regressionstests, zwei native Originfälle samt optionalem Originparameter des Sockethelfers in `tests/deployment.test.ts` und dieser Statusbericht. Keine unbeabsichtigten Änderungen festgestellt; `git diff --check` bestanden. Quell- und Testdateien entsprechen weiterhin den unten festgehaltenen SHA-256-Werten.

## Validierter Quell- und Teststand (SHA-256)

- `apps/backend/src/http.ts`: `a46b64eca856e5892ef21281d39f347821bb66d1959cf57f3ce7175bf46eedd9`
- `tests/http.test.ts`: `f7cefa9431688e8a59181634e5f1ede6e44550c8921f37f8f0e6cc7fefd96894`
- `tests/deployment.test.ts`: `997386fb6fc745eb052e04921c6ab649dc7e2cd9c49a09f74d2551fe83a41564`

## Commitvorbereitung

Der separate Commit `fix: validates ip addresses before allowing development origins` ist inhaltlich vorbereitet. Das Staging der vier ausdrücklich ausgewählten SA-05-Dateien scheiterte am 2026-10-11 innerhalb der Codex-Sandbox mit Exit 128:

```text
fatal: Unable to create '/Users/noahbauditz/Documents/Projects/PixelFleet/.git/index.lock': Operation not permitted
```

Keine Rechteerweiterung angefordert; der Index blieb unverändert, der Commitbefehl wurde nicht ausgeführt. Zum Abschluss im Nutzerterminal:

```sh
cd /Users/noahbauditz/Documents/Projects/PixelFleet
git add -- apps/backend/src/http.ts tests/http.test.ts tests/deployment.test.ts docs/security/SA-05-FIX-STATUS.md
git commit -m "fix: validates ip addresses before allowing development origins"
```

Kein Push, kein Deployment; der ursprüngliche Vollaudit bleibt **incomplete**.
