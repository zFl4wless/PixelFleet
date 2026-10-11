# SA-06: Einheitliches Proxyvertrauen für Transport und Client-IP

Stand: 2026-10-12. Normaler lokaler Entwicklungsauftrag, begrenzt auf den aus dem Repository belegbaren Teil von SA-06 aus `~/security-audit-skill/PixelFleet/run-1/SESSION-AUTH-STATIC.md`. Ausgangscommit: `cb898d76800decade8a6a5c6e05922ed7e56b096` (`fix: validates ip addresses before allowing development origins`), Arbeitsbaum zu Beginn sauber. Die zuvor vom Nutzer gemeldeten **58/58 bestandenen Tests** gehören zum separat committeten SA-05-Stand und sind kein Testergebnis für diesen Fix.

**Status:** Lokale Inkonsistenz von `TRUST_PROXY` behoben. Die vollständige Suite bestand mit **70/70 Tests, vom Nutzer ausgeführt und gemeldet**. Dieser Lauf wurde von Codex nicht unabhängig beobachtet. Alle 22 HTTP-Tests einschließlich sechs neuer Regressionstests, Typecheck und Build bestanden zuvor in Codex für denselben Quell- und Teststand. Die tatsächliche produktive Proxy-Konfiguration ist weiterhin **ungeprüft und nicht nachgewiesen**; SA-06 wird dadurch nicht vollständig geschlossen. Der Repositoryfix wird für einen separaten Commit vorbereitet; kein Push oder Deployment. Der ursprüngliche Vollaudit bleibt **incomplete**.

## Beobachtung am aktuellen Ausgangsstand

`apps/backend/src/http.ts:57` verwendete `X-Forwarded-Proto: https` unmittelbar für die Secure-Entscheidung. `getClientIp:61` beachtete dagegen bereits `TRUST_PROXY` und verwendete bei `false` die Socketadresse. Dadurch beeinflusste ein Forwarding-Header bei deaktiviertem Proxyvertrauen weiterhin Cookie-Sicherheit, während er für die Quotenidentität ignoriert wurde. Das ist aus dem Quellcode belegbar; eine tatsächliche Produktionsauswirkung ist daraus nicht nachgewiesen.

Cookie-Ausgabe und Cookie-Löschung verwenden schon dieselbe Funktion: `apps/backend/src/server.ts:330` beziehungsweise `:340` rufen jeweils `isSecureRequest(req)` auf. HTTP-Quoten (`server.ts:270`) und WebSocket-Zulassung/Verbindungscaps (`server.ts:400`) verwenden gemeinsam `getClientIp(req)`.

## Kleinste Korrektur und Invarianten

- `apps/backend/src/http.ts:57`: Eine gemeinsame private Funktion `trustsProxyHeaders()` kapselt die bestehende Einstellung. Der genaue Wert `TRUST_PROXY=false` deaktiviert Proxyvertrauen; der bestehende aktivierte Default bleibt erhalten.
- `apps/backend/src/http.ts:61`: Die Secure-Entscheidung berücksichtigt zuerst den tatsächlichen TLS-Zustand des Sockets. `X-Forwarded-Proto` ist nur bei aktiviertem Proxyvertrauen relevant. Ein widersprechender Header kann direkte TLS-Verbindungen nicht herabstufen.
- `apps/backend/src/http.ts:66`: Die Client-IP-Ermittlung verwendet dieselbe Vertrauensentscheidung. Bei `false` wird ausschließlich `socket.remoteAddress` verwendet, mit dem bisherigen `unknown`-Fallback, falls diese Information fehlt. Forwarding-Header werden in diesem Zweig nicht ausgewertet.
- Bei aktiviertem Proxyvertrauen bleibt das dokumentierte Verhalten erhalten: erster getrimmter Eintrag eines nicht leeren stringförmigen `X-Forwarded-For`, exakter stringförmiger Wert `X-Forwarded-Proto: https`. Fehlende oder nicht verwendbare Header erlauben weiterhin Socket-Fallbacks. Die Headerkettenauswertung und Peer-Auswahl wurden nicht erweitert.
- `sessionCookie:45` und `clearSessionCookie:52` behalten `Path=/`, `HttpOnly` und `SameSite=Lax`; nur die Ausgabe hat den bisherigen Jahres-Max-Age, die Löschung `Max-Age=0`. Beide erhalten ihre Secure-Entscheidung aus derselben Transportfunktion an den unveränderten Serveraufrufstellen.

| Verbindung und Einstellung | Client-IP | Secure bei Ausgabe und Löschung |
| --- | --- | --- |
| Direkter HTTP-Socket, `TRUST_PROXY=false`, beliebige Forwarding-Header | tatsächliche Socketadresse | nein |
| Direkter TLS-Socket, `TRUST_PROXY=false` | tatsächliche Socketadresse | ja |
| HTTP-Socket, `TRUST_PROXY=true`, `X-Forwarded-For` und `X-Forwarded-Proto: https` | erster Forwarded-For-Eintrag | ja |
| HTTP-Socket ohne HTTPS-Transportinformation | Forwarded-For bei aktiviertem Vertrauen, sonst Socketadresse | nein |
| TLS-Socket mit widersprechendem `X-Forwarded-Proto: http` | gemäß Proxyvertrauen | ja |

Keine Änderungen an Originregeln, Sessionwiderruf, Matchzuordnung, Limits, Datenbankschema oder anderen Audit-Punkten. Es wurden keine Proxy-Peers, Netzbereiche, Headerbereinigungsregeln oder zusätzlichen TLS-Serveroptionen erfunden.

## Regressionstests

Sechs neue Unit-Fälle in `tests/http.test.ts:25` prüfen das öffentliche Verhalten:

1. Deaktiviertes Proxyvertrauen ignoriert Forwarding-Metadaten für Client-IP und Secure; fehlende Socketadresse erzeugt keine Header-Ersatzidentität.
2. Direkte TLS-Socketinformation bleibt in beiden Vertrauensmodi maßgeblich, auch mit widersprechendem Protokollheader; bei deaktiviertem Vertrauen bleibt die tatsächliche Peeradresse erhalten.
3. Aktiviertes Vertrauen erhält den ersten Forwarded-For-Eintrag und HTTPS-Transportinformation.
4. Nicht gesetztes `TRUST_PROXY` erhält den dokumentierten aktivierten Default.
5. Socket-Fallbacks bei fehlenden oder nicht verwendbaren Headers erhalten lokales HTTP ohne Secure.
6. Eine feste Fallmatrix für direkte HTTP-/TLS- und Proxyverbindungen prüft konsistente Ausgabe-/Löschattribute samt Secure, Cookiepfad und Ablaufwerten.

Sechs neue native Fälle in `tests/deployment.test.ts:153` prüfen jeweils `TRUST_PROXY=false` und `true`: Login-/Logout-Cookieattribute bei fehlendem, HTTP- und HTTPS-Protokollheader; tatsächliche HTTP-Quoten bei zwei unterschiedlichen Forwarded-For-Werten; tatsächliche WebSocket-Verbindungscaps bei zwei Dummy-Konten und unterschiedlichen Forwarded-For-Werten. Die Testhelfer akzeptieren hierfür zusätzliche Header, ohne bestehende Standardaufrufe zu ändern. Sämtliche Zielverbindungen gehen zum lokalen Fixture-Server; Forwarded-Adressen sind ausschließlich Dummy-Metadaten.

Die sechs neuen nativen Szenarien konnten in Codex wegen des gesperrten Listenerstarts nicht geprüft werden. Sie sind nun durch die **vom Nutzer ausgeführte vollständige Suite mit 70/70 bestandenen Tests** abgedeckt. Die TLS-Unit-Fälle verwenden kontrollierte Socketinformationen mit `encrypted: true`; sie sind kein ausgeführter TLS-Handshaketest. Der bestehende Anwendungsserver erstellt einen HTTP-Listener und erhält in der dokumentierten Produktion TLS-Information über den Proxy. Es wurde kein neuer TLS-Betriebsmodus hinzugefügt.

## Dockerfile, Compose und Dokumentationsabgleich

| Repositorybeleg | Beobachtung und Ergebnis |
| --- | --- |
| `Dockerfile:39`, `:43`, `:57` | Runtime setzt `NODE_ENV=production`, Port 3001 und `TRUST_PROXY=true`; `EXPOSE 3001` entspricht dem Backend-Port. Unverändert. |
| `docker-compose.yml:19`, `:23`, `:34` | Produktion setzt dieselben Werte und `TRUST_PROXY: "true"` ausdrücklich. `expose` nennt 3001; kein `ports`-Hostmapping vorhanden. Unverändert. |
| `docker-compose.yml:52` | Dokploy soll Netzwerk und Routinglabels über seine Domains-Konfiguration ergänzen. Diese effektive Konfiguration ist nicht im Repository enthalten. |
| `README.md:74` und `docs/dokploy.md:77` | Dokumentation präzisiert die gemeinsame Vertrauensentscheidung, den Default, die konkreten Headerwerte und die Socketquellen bei deaktiviertem Vertrauen. |
| `docs/dokploy.md:156` | Lokaler Container-Override veröffentlicht nur `127.0.0.1:3001:3001` und setzt `TRUST_PROXY: "false"`. Passt zur lokalen HTTP-Nutzung. |

Dockerfile und Compose erfordern für den begrenzten Fix keine Änderung. Die geprüfte Dokumentation kennzeichnet die TLS-Proxy-Topologie als vorgesehenes Deployment und ergänzt einen gesonderten Abschnitt zum fehlenden Konfigurationsnachweis. Die Konsistenzprüfung war statisch; kein Docker-Imagebau und kein Compose- oder Containerlauf wurde ausgeführt. Der Dockerfile-Build würde unter anderem Dependencies installieren und wurde im Rahmen der bestehenden Ausführungsgrenzen nicht gestartet.

## Noch nachzuweisende tatsächliche Dokploy-/Traefik-Einstellungen

Diese Fragen betreffen den effektiven produktiven Aufbau und sind separat von der lokalen Codekorrektur offen:

1. **Transport und Routing:** Effektive HTTPS-Terminierung, HTTP-zu-HTTPS-Weiterleitung, öffentliche Hostregel und WebSocket-Routing zum Backendport nachweisen. Repository-Anweisungen belegen nicht die tatsächlich angewandten Einstellungen.
2. **Erreichbare Peers und Netzwerkzugriff:** Tatsächlich angebundene Netzwerke, erreichbare Container und mögliche Direktzugriffe auf das Backend nachweisen. Die fehlende Hostport-Veröffentlichung im Compose-Quelltext belegt allein keine vollständige Backend-Isolation.
3. **Forwarding-Kette:** Nachweisen, wie die tatsächliche Konfiguration mit clientseitig gelieferten `X-Forwarded-For`-/`X-Forwarded-Proto`-Werten und etwaigen weiteren Proxyhops umgeht. Es muss belegbar sein, dass der von Node ausgewählte erste Client-Eintrag und der genaue Protokollwert autoritativ sind. Das Repository enthält keine entsprechende Peer-Allowlist oder Headerbereinigungsregel.
4. **Effektive Runtime und Verhalten:** Tatsächlich wirksames `TRUST_PROXY`, Login-/Logout-Cookieattribute auf dem öffentlichen HTTPS-Pfad und die für HTTP-/WebSocket-Quoten ausgewählte Client-IP in einem autorisierten Testdeployment nachweisen.

Es wurden keine produktiven Dienste kontaktiert oder Einstellungen verändert. Keine konkreten Proxy-Peers, vertrauenswürdigen CIDRs oder nicht belegten Traefik-Regeln werden vorgegeben. **Der lokale Fix bestätigt nicht die Sicherheit der produktiven Proxy-Konfiguration.**

## Testumgebung und ausgeführte Prüfungen

Vor Ausführung wurden npm-Skripte, Buildkonfiguration und Testhelfer geprüft. Alle Datenbanktests verwenden eigene temporäre SQLite-Dateien; Deploymenttests verwenden temporäre Frontend-Fixtures, Port 0, Dummy-Konten und Dummy-Admin-Token. Die reinen HTTP-Tests benötigen keine Datenbank oder Listener. Alle Zielverbindungen bleiben lokal, Headerwerte lösen keine externen Verbindungen aus.

Die historischen Codex-Prüfungen liefen am 2026-10-11 in der üblichen Sandbox mit vorhandener Node-24.20.0-Toolchain, npm im Offline-Modus und ausdrücklich bereinigtem Environment: temporäre Home-/Cache-/TMPDIR-/Fallback-Datenbankpfade, leere npm-Konfigurationsdateien und ausschließlich Dummy-Token. Keine Dependency-Installation, erweiterten Hostrechte, echten Datenbanken, Zugangsdaten, produktiven Dienste oder externen Testziele. Temporäre Protokolle: `/private/tmp/pixelfleet-sa06-validation-kc03dliq/command-*.log`. Der anschließende erfolgreiche vollständige Lauf stammt vom Nutzer; seine Ausführung wurde von Codex nicht beobachtet.

| Prüfung | Ergebnis und Herkunft |
| --- | --- |
| Vollständige Suite, anschließender manueller Lauf | **70/70 bestanden, vom Nutzer ausgeführt und gemeldet**; nicht unabhängig durch Codex beobachtet |
| `npm test -- tests/http.test.ts tests/deployment.test.ts --maxWorkers=1 --minWorkers=1 --no-file-parallelism` | Historischer Codex-Lauf: Exit 1, zwei Dateien, **23 bestanden / 21 fehlgeschlagen**, insgesamt 44 Tests; alle 22 HTTP-Tests bestanden |
| `npm run typecheck` | Codex: **Bestanden, Exit 0** |
| `npm run build` | Codex: **Bestanden, Exit 0**, Shared, Backend und Frontend |
| `npm test -- --maxWorkers=1 --minWorkers=1 --no-file-parallelism` | Historischer Codex-Lauf: Exit 1, sieben Dateien, **49 bestanden / 21 fehlgeschlagen**, insgesamt 70 Tests |
| `git diff --check` | **Bestanden** |

Alle 21 im historischen Codex-Lauf fehlgeschlagenen Tests sind native Deploymenttests, die vor ihren Integrationsszenarien beim Serverstart abbrechen:

```text
Error: listen EPERM: operation not permitted 0.0.0.0
code: 'EPERM'
errno: -1
syscall: 'listen'
address: '0.0.0.0'
Node.js v24.20.0
```

Die betroffenen Integrationsszenarien blieben in Codex **ungeprüft**; die fehlgeschlagenen Läufe gelten weder als bestanden noch als übersprungen. Der einzige dort erfolgreiche Deploymenttest prüft den Startabbruch bei fehlendem Frontend und benötigt keinen Listener. Die vollständige Suite ist im historischen Codex-Lauf **nicht bestanden**; der spätere Nutzerlauf ist davon getrennt als erfolgreich dokumentiert. Die Ergebnisse beziehen sich auf den finalen Quell- und Teststand; danach wurden nur Dokumentation und dieser Statusbericht bearbeitet.

## Nutzerausgeführte Validierung und Grenzen

Der Nutzer hat den erfolgreichen vollständigen Lauf mit **70/70 Tests** ausdrücklich gemeldet. Die zuvor ausstehende lokale Integrationsvalidierung ist damit laut Nutzer abgeschlossen. Codex hat diesen Lauf nicht selbst ausgeführt oder unabhängig beobachtet. Für diese Statusaktualisierung und Commitvorbereitung wurden die Tests nicht erneut gestartet; Quellcode und Tests entsprechen weiterhin dem oben geprüften Fixstand.

Der erfolgreiche lokale Lauf beantwortet die getrennt aufgeführten produktiven Deployment-Fragen nicht. Die effektive Dokploy-/Traefik-Konfiguration bleibt **ungeprüft**; der lokale Repositoryfix bestätigt ihre Sicherheit nicht.

## Diff und geprüfter Quellstand

Der erneut geprüfte Diff betrifft ausschließlich `apps/backend/src/http.ts`, SA-06-Tests und notwendige Testhelperparameter in `tests/http.test.ts` beziehungsweise `tests/deployment.test.ts`, die Proxy-Dokumentation in `README.md` und `docs/dokploy.md` sowie diesen Bericht. Keine unbeabsichtigten Änderungen festgestellt. Dockerfile, Compose und die bestehenden Fixstatusberichte sind unverändert. Die Quell- und Testdateien entsprechen weiterhin den nachstehenden SHA-256-Werten. Kein Push oder Deployment.

SHA-256 des geprüften Quell- und Teststands:

- `apps/backend/src/http.ts`: `e5deb248503af804416da8c55c80d7b5dfa8f847d61817d747d457b147aadad1`
- `tests/http.test.ts`: `94ed5b92c9c2f4f9e48fa918a87751fa2ff17e4c531ec9b2472c68343a6b1634`
- `tests/deployment.test.ts`: `c266b22865939edda9914479d8a9bf59eae4016bfabb9306c8bbf519a443d0c7`
- Unveränderter `Dockerfile`: `17351d9d3fce8997024f108e9d2c5897e858513cd30e111f54fb3603c0a341fe`
- Unveränderte `docker-compose.yml`: `db02d9b5bbb464c2a5848c6b9a5f6fb218e90c76fb01bc96dd360e4225d1b6c9`

## Commitvorbereitung

Vorgesehener separater Commit: `fix: respects proxy trust when determining cookie security`.

Am 2026-10-12 wurde ausschließlich das Staging der sechs unten ausgewählten SA-06-Dateien versucht. Git brach mit Exit 128 ab:

```text
fatal: Unable to create '/Users/noahbauditz/Documents/Projects/PixelFleet/.git/index.lock': Operation not permitted
```

Der Index blieb unverändert und leer; ein Commit wurde nicht ausgeführt. Es wurden keine erweiterten Rechte angefordert. Die exakt ausgewählten Befehle für das lokale Terminal lauten:

```sh
cd /Users/noahbauditz/Documents/Projects/PixelFleet
git add -- apps/backend/src/http.ts tests/http.test.ts tests/deployment.test.ts README.md docs/dokploy.md docs/security/SA-06-FIX-STATUS.md
git commit -m "fix: respects proxy trust when determining cookie security"
```

Der ursprüngliche Auditdatensatz wurde nicht verändert. `run-metadata.json` enthält weiterhin `run_status: incomplete`, SHA-256 `86d5a650d4af8589a632390586ed2b9b9d94bb7506d8420d7044dba8b4d1226d`. Der Vollaudit bleibt **incomplete**.
