# SA-08: Frontend-Vorgänge an die aktuelle Session und Verbindung binden

Stand: 2026-10-12. Normaler lokaler Entwicklungsauftrag, ausschließlich SA-08 aus `~/security-audit-skill/PixelFleet/run-1/SESSION-AUTH-STATIC.md`. Ausgangscommit: `58a0010697e3e9baf3ee38807ef545c8d49dc91b` (`fix: respects proxy trust when determining cookie security`), Arbeitsbaum zu Beginn sauber. Die vom Nutzer gemeldeten **70/70 bestandenen Tests** gehören zum separat committeten SA-06-Stand und sind kein Testergebnis für diesen Fix.

**Status:** Repositoryfix implementiert. **99/99 Tests der vollständigen Suite bestanden, vom Nutzer ausgeführt und gemeldet.** Der Nutzer hat außerdem einen erfolgreichen lokalen Browsercheck für Login/Reload, Logout, erneuten Gastlogin und Reconnect nach Netzunterbrechung gemeldet. Beide Prüfungen wurden von Codex nicht unabhängig beobachtet. **29/29 neue Verhaltenstests, Typecheck und Build bestanden zuvor in Codex** für denselben Quell- und Teststand. Die historischen EPERM-Ergebnisse bleiben getrennt dokumentiert. Der Browsercheck ist auf die genannten Abläufe begrenzt und belegt keine umfassende Browserabdeckung oder gezielte Prüfung sämtlicher Race-/Strict-Mode-Fälle. Der Fix wird für einen separaten Commit vorbereitet; kein Push oder Deployment. Der ursprüngliche Vollaudit bleibt **incomplete**.

## Beobachtung am Ausgangsstand

- `apps/frontend/src/App.tsx:45`: `fetchMe().then(setProfile)` hatte keine Cleanup- oder Generationsprüfung. Ein überholtes Ergebnis konnte weiterhin Profil und Ladezustand setzen, auch nach einem Effect-Cleanup.
- `App.tsx:70`: WebSocket-Open-/Message-/Close-Callbacks prüften weder aktuelle Accountgeneration noch Socketidentität. `disposed` verhinderte lediglich neue Verbindungen nach Cleanup; alte Ereignisse konnten weiterhin React-Zustand ändern.
- `App.tsx:77`: Jedes aktuelle Close-Ereignis startete nach 1200 ms einen Reconnect, ohne Widerruf, Verbindungsersatz und Netzunterbrechung zu unterscheiden.
- `App.tsx:137`: Logout löschte lokalen Zustand erst nach erfolgreichem `logoutGuest()`. Ein Fehler ließ das Profil bestehen und wurde nicht kontrolliert angezeigt; während der Anfrage blieben alte Socketcallbacks wirksam.
- `apps/frontend/src/lib/api.ts:22`: `fetchMe` behandelte jeden Fehler als fehlende Session. Damit ließ sich eine HTTP-401-Antwort nicht von Netzwerk-, Abort- oder anderen HTTP-Fehlern unterscheiden.

Die Aussagen treffen auf den geprüften Ausgangscommit zu. Daraus folgt kein eigenständiger Wechsel serverseitiger Berechtigungen; es geht um die Wirkung veralteter Vorgänge auf den Frontendzustand.

## Korrektur und Sicherheitsinvarianten

Die vorhandene Session-/Verbindungslogik wurde in `apps/frontend/src/lib/sessionConnection.ts` gebündelt. `App.tsx` behält seine Anzeige-, Spielnachrichten- und Toastbehandlung und bindet den Controller direkt an die bestehenden React-State-Setter.

| Invariante | Umsetzung im Fixstand |
| --- | --- |
| Nur die aktuelle Accountgeneration darf Ergebnisse anwenden | `sessionConnection.ts:89`, `:115`: Aktiver Lebenszyklus, Generationsprüfung und Identität der aktuellen Profilanfrage; `AbortController` beendet überholte Anfragen. Auch ein trotz Abort später geliefertes Ergebnis bleibt wirkungslos. |
| Login-Abschlüsse sind an ihren ursprünglichen Kontext gebunden | `sessionConnection.ts:55`, `App.tsx:112`: Der an `LoginScreen` übergebene Abschlusscallback erfasst die aktuelle Generation. Doppelte oder überholte Abschlüsse können einen neuen Account nicht überschreiben. |
| Nur aktuelle, offene Verbindungen verarbeiten Nachrichten oder senden Aktionen | `sessionConnection.ts:62`, `:138`: Accountgeneration plus konkrete Socketidentität; Open und Message prüfen zusätzlich den offenen Transportzustand. Ein veraltetes Close-Ereignis verändert weder den Onlinezustand noch den Reconnect. |
| Logout und Accountwechsel entziehen alten Vorgängen sofort ihre Wirkung | `sessionConnection.ts:68`, `:93`, `:105`: Generation zuerst invalidieren, Profilanfrage abbrechen, Reconnecttimer löschen, Socketreferenz vor `close()` entfernen. Erfolgreicher Logout beziehungsweise ein Accountwechsel setzt Match-, Queue- und Toastzustand zurück. |
| Auch bereits zugestellte alte Timer dürfen nichts starten | `sessionConnection.ts:174`: Generations- und Timeridentität werden im Callback geprüft, zusätzlich zum Löschen des Timers. |
| Gleiches Accountprofil ist kein automatischer Accountwechsel | `sessionConnection.ts:125`, `:153`: Aktuelle Profilupdates desselben Users erhalten Spielzustand und Verbindung. Eine andere aktuelle authentifizierte Identität wird als Accountgrenze behandelt und setzt alten Spielzustand zurück. |
| Effect-Cleanup entzieht allen Vorgängen ihre Wirkung | `App.tsx:43`, `:56`: Ein seiteneffektfrei konstruierter, stabiler Controller; Effect-Setup ruft `start()`, Cleanup `stop()`. Ein erneutes Setup erstellt eine neue Generation und Profilanfrage. Konstruktion startet weder HTTP noch WebSocket oder Timer. |

Die Callbacks im Controller erfassen in `App.tsx` ausschließlich stabile State-Setter und den stabilen Toastcallback; sie benötigen keine Profilkopie aus einem älteren Render. Die bestehenden Spielregeln, Resultatansicht und serverseitigen Disconnect-/Reconnect-Fristen wurden nicht geändert.

Das Cleanup-Prinzip folgt der [React-Dokumentation zu Effects und verspäteten Antworten](https://react.dev/reference/react/useEffect). Der zusätzliche Setup–Cleanup–Setup-Zyklus darf keine überholten Vorgänge wieder aktivieren.

## Close-Codes und Reconnect-Verhalten

Es wurden keine neuen serverseitigen Codes eingeführt und keine Backenddateien geändert.

| Ereignis | Repositorybeleg | Frontendverhalten |
| --- | --- | --- |
| `4003`, Sessionwiderruf | `apps/backend/src/game-hub.ts:139`, `:146` | Sofort zum Loginzustand, Account- und Spielzustand löschen, alte Vorgänge invalidieren, kein Reconnect. |
| `4001`, Verbindung ersetzt | `game-hub.ts:107` | Aktuelle Verbindung als getrennt anzeigen und Hinweis ausgeben; kein automatischer Reconnect, der mit der Ersatzverbindung konkurriert. Profil bleibt bestehen, da die Session nicht widerrufen wurde. |
| `4009`, Runtime-Reset | `game-hub.ts:701` | Weiterhin Reconnect zulassen; der Reset widerruft die Session nicht. |
| `1012`, Serverneustart | `apps/backend/src/server.ts:480`, `:483` | Weiterhin Reconnect zulassen. |
| Netzunterbrechung, insbesondere `1006` | Browser-Close-Ereignis | Account und Spielansicht behalten, Onlinezustand zurücksetzen, nach dem bisherigen Abstand von 1200 ms erneut versuchen. |
| Andere bisher erneut verbundene Close-Codes | bisherige allgemeine Close-Behandlung | Reconnect bleibt zulässig; keine weitere Close-Policy wurde als anderer Audit-Punkt geändert. |

Vor einem Reconnect erfolgt eine aktuelle `/api/me`-Abfrage. Browserhandshakes können eine abgewiesene Anmeldung nur als `1006` sichtbar machen. Die Profilabfrage unterscheidet das von einem echten Netzwerkfehler: **HTTP 401** bedeutet fehlende Session und führt zum Login; Netzwerk-, Abort- und andere HTTP-Fehler beweisen keinen Widerruf und lassen den Account für den nächsten Versuch bestehen. Eine erfolgreiche aktuelle Profilabfrage öffnet die neue Verbindung; derselbe Account behält dabei seine Spielansicht bis zu den aktuellen Serverupdates.

`apps/frontend/src/lib/api.ts:27` akzeptiert dafür ein Abortsignal. Nur HTTP 401 liefert `null`; andere Fehler werden weitergereicht. HTTP-Credentials bleiben `include` und die bestehende Cookieauthentifizierung bleibt erhalten.

## Fehlgeschlagener Logout

Das vorherige Verhalten, einen fehlgeschlagenen Request nicht als erfolgreichen Logout darzustellen, bleibt erhalten. Neu ist die kontrollierte Behandlung:

1. Bereits beim Logoutbeginn werden alte Anfragen, Socketcallbacks und Timer unwirksam. Die Verbindung wird geschlossen und kann keine Aktionen mehr senden. Ein doppelter Logout während des ausstehenden Requests startet keine weitere Anfrage.
2. Das angezeigte Profil bleibt bis zur Bestätigung bestehen. Ein erfolgreicher Logout löscht den Accountzustand.
3. Bei einem Fehler wird eine Fehlermeldung ausgegeben und die Session erneut geprüft. Eine gültige Session erhält eine frische Verbindung. HTTP 401 beendet den Account, etwa wenn der Server Logout bereits verarbeitet hat, aber die Antwort verloren ging.
4. Ist auch die Prüfung durch einen Netzwerkfehler unmöglich, bleibt das Profil getrennt bestehen; Reconnect prüft die Session erneut. Es wird weder Logout-Erfolg noch eine funktionierende Verbindung behauptet.
5. Nach einem zwischenzeitlichen Accountwechsel oder Effect-Cleanup bleiben sowohl ein späterer Logout-Erfolg als auch ein späterer Logout-Fehler wirkungslos für den aktuellen Zustand.

## Regressionstests

`tests/frontend-session.test.ts` enthält **29 Verhaltenstests** für den produktiv verwendeten Controller und die echte API-Schicht mit kontrollierten Transport-Doubles. Geprüft werden die nach außen gelieferten Profil-/Lade-/Verbindungs-/Queue-/Match-/Toastzustände, gesendete Aktionen, HTTP-Anfragen und ausbleibende weitere Verbindungen; keine Tests lesen den internen Generationszähler.

- Gültige Profilabfrage, aktuelle Profilupdates, Spiel-/Queue-Ereignisse und Aktionen am offenen Socket (`:130`).
- Verspätete Profilantwort über Setup–Cleanup–Setup hinweg; der zweite Ladevorgang wird nicht beendet und kein alter Account geöffnet (`:144`).
- Alte Profilantwort und doppelter Loginabschluss nach Auswahl eines neuen Accounts (`:162`).
- Alte Open-/Message-/Close-Ereignisse nach Account- oder Verbindungsersatz, einschließlich neuer Generation desselben Accounts; keine Veränderung aktueller Ansicht und kein Reconnect (`:177`).
- Keine Nachrichtenverarbeitung oder Aktionen am schließenden Socket (`:206`).
- Reconnect nach `1006`, `1012` und `4009`, Erhalt des Spielzustands und Abweisung alter Ereignisse/Timer (`:215`).
- Netzwerkfehler bleiben vorübergehend, eine belegte fehlende Session beendet den Account (`:243`, `:260`).
- `4003` führt sofort zum Login; `4001` startet keine Konkurrenzverbindung (`:274`, `:291`).
- Logout-Erfolg, Doppelaufruf, Fehlermeldung und Wiederherstellung einer weiterhin gültigen Session, verlorene Antwort mit anschließendem 401 sowie nicht bestätigbarer Logout bei Netzwerkfehlern (`:302`, `:327`, `:346`, `:359`).
- Verspäteter Logout-Erfolg und -Fehler nach Accountwechsel; alte Timer und Profilantworten während Accountwechsel/Logout (`:374`, `:388`, `:401`, `:415`).
- Andere aktuelle authentifizierte Socketidentität setzt alten Spielzustand zurück; Cleanup und erneutes Setup lassen alte Ereignisse nicht wieder wirksam werden (`:434`, `:451`, `:480`).
- Abortsignal und Cookie-Credentials, HTTP 401 gegenüber HTTP 403/503 und Netzwerk-/Abortfehlern (`:493`, `:501`, `:507`).

## Testumgebung und Ergebnisse

Vor Ausführung wurden npm-Skripte, Testhelfer, Vite-Buildkonfiguration und vorhandene Dependencies geprüft. Es gibt keine installierte DOM-/React-Rendering-Testumgebung; es wurden keine Dependencies installiert oder Paketdateien geändert.

Die neuen Tests verwenden ausschließlich Dummyprofile, in-memory HTTP-Antworten, einen kontrollierten Socket und Fake-Timer. `fetch` wird vollständig ersetzt; kein Zielkontakt und keine Datenbank. Die bestehende vollständige Suite verwendet temporäre SQLite-Dateien, temporäre Frontend-Fixtures, lokale Testlistener, Dummy-Konten und Dummy-Admin-Token. Ihre Testhelfer setzen temporäre Datenbankpfade vor dem Import des Backends.

Die historischen Codex-Befehle liefen in der üblichen Sandbox mit vorhandener Node-24.20.0-Toolchain und npm offline. Der Launcher verwendet ein bereinigtes Environment mit temporären Home-/Cache-/TMPDIR-/Fallback-Datenbankpfaden und Dummy-Token. Vorhandene echte Datenbanken oder Zugangsdaten wurden nicht verwendet. Keine Dependency-Installation, erweiterten Rechte, produktiven Dienste oder externen Testziele. Temporäre Ausführungsprotokolle liegen unter `/private/tmp/pixelfleet-sa08-validation-10492mdf/command-*.log`. Der anschließende vollständige Testlauf und lokale Browsercheck stammen vom Nutzer; deren Ausführung wurde von Codex nicht beobachtet.

| Prüfung | Ergebnis und Herkunft |
| --- | --- |
| Vollständige Suite, anschließender manueller Lauf | **99/99 bestanden, vom Nutzer ausgeführt und gemeldet**; nicht unabhängig durch Codex beobachtet |
| Lokaler Browsercheck | **Erfolgreich, vom Nutzer ausgeführt und gemeldet:** Login/Reload, Logout, erneuter Gastlogin und Reconnect nach Netzunterbrechung; auf diese Abläufe begrenzt |
| `npm test -- tests/frontend-session.test.ts --maxWorkers=1 --minWorkers=1 --no-file-parallelism` | Codex: **Bestanden, Exit 0: 29/29 Tests** |
| `npm run typecheck` | Codex: **Bestanden, Exit 0** |
| `npm run build` | Codex: **Bestanden, Exit 0**, Shared, Backend und Frontend |
| `npm test -- --maxWorkers=1 --minWorkers=1 --no-file-parallelism` | Historischer Codex-Lauf: **Exit 1**, acht Dateien, 78 bestanden / 21 fehlgeschlagen, insgesamt 99 Tests |
| `git diff --check` | **Bestanden** |

Alle 21 im historischen Codex-Lauf fehlgeschlagenen Tests sind bestehende native Deploymenttests, die beim Start des Servers vor ihren Integrationsszenarien abbrechen:

```text
Error: listen EPERM: operation not permitted 0.0.0.0
code: 'EPERM'
errno: -1
syscall: 'listen'
address: '0.0.0.0'
Node.js v24.20.0
```

Die betroffenen Szenarien blieben in Codex **ungeprüft**. Dieser historische vollständige Lauf ist weder bestanden noch als übersprungen gewertet; der spätere erfolgreiche Nutzerlauf ist davon getrennt dokumentiert. Der einzige dort erfolgreiche Deploymenttest benötigt keinen Listener und prüft den Startabbruch bei fehlendem Frontend. Es wurde keine Umgehung der Sandbox angefordert.

## Nutzerausgeführte Validierung und verbleibende Grenzen

Der Nutzer hat für den aktuellen Fixstand die vollständige Suite mit **99/99 bestandenen Tests** bestätigt. Der zuvor ausstehende lokale Integrationslauf ist damit laut Nutzer abgeschlossen. Zusätzlich war laut Nutzer der lokale Browsercheck für **Login/Reload, Logout, erneuten Gastlogin und Reconnect nach Netzunterbrechung erfolgreich**. Beide Prüfungen sind ausdrücklich **nutzerausgeführt** und wurden von Codex nicht unabhängig beobachtet. Für diese Statusaktualisierung und Commitvorbereitung wurden weder Tests noch Browsercheck erneut gestartet; Quellcode und Tests entsprechen weiterhin dem geprüften Fixstand.

Der Browsercheck belegt die genannten normalen lokalen Abläufe. Browsername/-version, detaillierte Schritte und eine gezielte Prüfung von Strict-Mode-Doppelsetup, künstlich verspäteten Antworten, alten Socketereignissen, Verbindungsersatz, Sessionwiderruf außerhalb des normalen Logout-Ablaufs oder fehlgeschlagenem Logout wurden nicht mitgeteilt. Eine vollständige Abdeckung nativer Ereignisreihenfolgen, mehrerer Browser oder aller Race-Fälle wird daraus nicht abgeleitet.

Die automatisierten Tests belegen das Verhalten des tatsächlich eingebundenen Controllers und der API-Schicht unter kontrollierter Ereignisreihenfolge. Der Setup–Cleanup–Setup-Zyklus wird direkt ausgeführt. Ein gezielter React-DOM-Test unter Strict Mode und eine umfassende Browser-/WebSocket-Abdeckung bleiben **ungeprüft**. Typecheck, Build und der erfolgreiche Nutzerlauf ersetzen diese weitergehenden Prüfungen nicht.

Die Generation schützt lokale Zustandsänderungen. Sie kann bereits serverseitig bearbeitete HTTP-Anfragen oder vom Browser angewandte Cookieheader nicht rückgängig machen und koordiniert keine anderen Tabs. Serverseitige Authentifizierung bleibt maßgeblich. Die produktive Proxy-Konfiguration bleibt ungeprüft; es wurde kein Deployment kontaktiert oder verändert.

## Diff und geprüfter Stand

Ausschließlich geändert beziehungsweise neu: `apps/frontend/src/App.tsx`, `apps/frontend/src/lib/api.ts`, `apps/frontend/src/lib/sessionConnection.ts`, `tests/frontend-session.test.ts` und dieser Statusbericht. Keine unbeabsichtigten Änderungen festgestellt. Backend, Shared-Paket, Deploymentdateien, Dependencies und andere Audit-Punkte sind unverändert. Die Quell- und Testdateien entsprechen weiterhin den nachstehenden SHA-256-Werten. Kein Push oder Deployment.

SHA-256 des getesteten Quell- und Teststands:

- `App.tsx`: `e47b14b69ba650bd968602cadce7344f6e0c52f998f89838284081d2a57d5627`
- `lib/api.ts`: `bf517fedbc993aac4c592ef255d8b60ae53a6adb461f865de2d43efc865076e4`
- `lib/sessionConnection.ts`: `024fcb3607d9c45158026bc8700d26822fb778e0c5ec84d3f04b776a9e73620c`
- `tests/frontend-session.test.ts`: `f3b15eea183fc5c98eaa1e23278a11a7b5279b0d5a8bca034713c5c9e6554d23`

## Commitvorbereitung

Vorgesehener separater Commit: `fix: ignores stale frontend session and socket callbacks`.

Am 2026-10-12 wurde ausschließlich das Staging der fünf unten ausgewählten SA-08-Dateien versucht. Git brach mit Exit 128 ab:

```text
fatal: Unable to create '/Users/noahbauditz/Documents/Projects/PixelFleet/.git/index.lock': Operation not permitted
```

Der Index blieb unverändert und leer; ein Commit wurde nicht ausgeführt. Es wurden keine erweiterten Rechte angefordert. Die exakt ausgewählten Befehle für das lokale Terminal lauten:

```sh
cd /Users/noahbauditz/Documents/Projects/PixelFleet
git add -- apps/frontend/src/App.tsx apps/frontend/src/lib/api.ts apps/frontend/src/lib/sessionConnection.ts tests/frontend-session.test.ts docs/security/SA-08-FIX-STATUS.md
git commit -m "fix: ignores stale frontend session and socket callbacks"
```

Nach den Ausführungsprüfungen wurde nur dieser Statusbericht ergänzt und aktualisiert. Der ursprüngliche Auditdatensatz wurde nicht geändert: `run-metadata.json` enthält weiterhin `run_status: incomplete`, SHA-256 `86d5a650d4af8589a632390586ed2b9b9d94bb7506d8420d7044dba8b4d1226d`. Der ursprüngliche Vollaudit bleibt **incomplete**.
