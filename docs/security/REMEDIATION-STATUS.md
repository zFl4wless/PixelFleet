# PixelFleet: Remediation-Status

Stand: 2026-10-12. Übersicht der gezielten Entwicklungsfixes zu `~/security-audit-skill/PixelFleet/run-1/SESSION-AUTH-STATIC.md`, kein neuer Audit. Commitreferenzen wurden gegen die lokale Git-Historie geprüft; geprüfter Stand: `45870edcb36812424577ee70a54a030d27396e50`. **Der ursprüngliche Vollaudit bleibt incomplete.** Die Behebung dieser Punkte bestätigt weder vollständige Codebase-Coverage noch produktive Deployment-Sicherheit.

## Umgesetzte Punkte und Nachweise

Alle vollständigen Suite-Ergebnisse in dieser Tabelle wurden **vom Nutzer ausgeführt und gemeldet**, nicht unabhängig von Codex beobachtet. Sie beziehen sich jeweils auf den damaligen Fixstand und sind nicht zu addieren. Typecheck und Build bestanden für diese Fixstände zuvor in Codex; Details und historische Sandboxfehler stehen in den verlinkten Berichten.

| Punkt | Umsetzung | Lokaler Commit | Vollständige Suite / Fixstatus |
| --- | --- | --- | --- |
| SA-07 | Kontrollierte Cookiefehler und robuste Fehlerbehandlung beim Upgrade; gültige Anmeldung und Quotenbereinigung erhalten | `b1a503a6ae95` — `fix: handles malformed cookies during websocket upgrades` | **30/30**, [Nachweis](SA-07-FIX-STATUS.md) |
| SA-01 / SA-02 | Sessiongebundener Logout-Widerruf; nur aktuelle offene Verbindung verarbeitet Nachrichten; alte Verbindungen bleiben bei Ersatz/Reset wirkungslos | `8f456f394405` — `fix: revokes websocket permissions when sessions end` | **42/42**, [Nachweis](SA-01-SA-02-FIX-STATUS.md) |
| SA-03 | Eindeutige aktive Matchzuordnung getrennt von aufbewahrten Ergebnissen; Queue, Aktionen und Reconnect verwenden sie gemeinsam | `fef3d7290948` — `fix: separates active matches from retained results` | **50/50**, [Nachweis](SA-03-FIX-STATUS.md) |
| SA-05 | Entwicklungs-Originfreigabe prüft tatsächlichen IP-Typ vor privatem Bereich; HTTP, CORS und WebSocket konsistent | `cb898d76800d` — `fix: validates ip addresses before allowing development origins` | **58/58**, [Nachweis](SA-05-FIX-STATUS.md) |
| SA-06, Repositoryteil | `TRUST_PROXY=false` ignoriert Forwarding-Header für Client-IP und Cookie-Secure; direkte TLS-Sockets bleiben maßgeblich | `58a0010697e3` — `fix: respects proxy trust when determining cookie security` | **70/70**, [Nachweis](SA-06-FIX-STATUS.md); produktiver Proxyteil **offen** |
| SA-08 | Account-/Verbindungsgeneration bindet Profilantworten, Socketcallbacks und Reconnect; Widerruf führt zum Login | `774d35cfd513` — `fix: ignores stale frontend session and socket callbacks` | **99/99**, [Nachweis](SA-08-FIX-STATUS.md); zusätzlich begrenzter nutzerausgeführter Browsercheck |
| SA-04 | Feste serverseitige 365-Tage-Frist ab gespeichertem `created_at`, ohne Nutzungsverlängerung; autonome Socketinvalidierung und Timerbereinigung; Kontodaten erhalten | `45870edcb368` — `fix: expires guest sessions after 365 days` | **120/120**, [Nachweis](SA-04-FIX-STATUS.md); 20 neue zeitgesteuerte Tests, Typecheck und Build zuvor in Codex bestanden |

SA-04 ist separat als `45870edcb36812424577ee70a54a030d27396e50` committet; die frühere Staging-Sperre im SA-04-Bericht dokumentiert den damaligen Codex-Versuch. Diese Übersicht wird allein für den separaten Dokumentationscommit `docs: records security remediation status` vorbereitet. Es wurden für die Statusaktualisierung keine Tests erneut gestartet, keine Codeänderungen vorgenommen und nichts gepusht oder deployt.

## Verbleibende Validierungsgrenzen

- Die nativen HTTP-/WebSocket-Tests waren in Codex durch `listen EPERM: operation not permitted 0.0.0.0` blockiert. Die späteren erfolgreichen Nutzerläufe schließen die lokale Suite laut Nutzer ab; sie werden nicht als eigene Codex-Integrationserfolge umgedeutet. Der letzte historische Codex-Lauf hatte 98 bestandene / 22 fehlgeschlagene Tests, insgesamt 120.
- Der erfolgreiche SA-08-Browsercheck stammt ebenfalls vom Nutzer und umfasst ausschließlich Login/Reload, Logout, erneuten Gastlogin und Reconnect nach Netzunterbrechung. Keine umfassende Browserabdeckung, kein gezielter React-DOM-/Strict-Mode-Test und kein Browsercheck des neuen SA-04-Ablaufs wurden nachgewiesen. Die automatisierten Controller- und Ablaufprüfungen verwenden kontrollierte Ereignisse beziehungsweise Zeit.
- SA-04 belegt keinen realen 365-Tage-Dauerbetrieb. Serveruhr und Ausführung der Eventloop bleiben Betriebsannahmen; die absolute Deadline wird zusätzlich bei Authentifizierung und Nachrichtenverarbeitung geprüft. Browserseitiges `Max-Age` hat Sekundenauflösung und beginnt bei Empfang; serverseitiger Ablauf bleibt maßgeblich. Ohne separate Wiederherstellung gibt es nach Ablauf keinen erneuten Zugang über diese Gast-Session; das Konto und seine Statistiken bleiben gespeichert.
- Direkte TLS-Eigenschaften wurden mit Socket-Doubles geprüft, nicht mit einem nativen TLS-Handshake. Docker-/Compose-Läufe, effektive Produktionskonfiguration und Produktionsdaten wurden nicht geprüft. Entwicklungsprüfungen nutzten lokale Dummy-Fixtures; kein produktiver Dienst wurde kontaktiert.
- Diese Fixes ersetzen keine abgeschlossene Coverage und unabhängige Verifikation des ursprünglichen Vollaudits. Dessen Abschluss und die vorgeschriebenen vollständigen Auditnachweise werden hier nicht behauptet. Der unveränderte Auditdatensatz enthält `run_status: incomplete` (SHA-256 `86d5a650d4af8589a632390586ed2b9b9d94bb7506d8420d7044dba8b4d1226d`).

## Offene produktive Proxy-Nachweise zu SA-06

Der lokale Repositoryfix behebt die Vertrauensinkonsistenz. **SA-06 ist hinsichtlich des produktiven Dokploy-/Traefik-Aufbaus nicht vollständig geschlossen.** Aus dem Compose-Quelltext ohne Hostport-Mapping lässt sich keine vollständige Backend-Isolation ableiten. Folgende effektiven Einstellungen und Verhaltensnachweise fehlen weiterhin:

1. **Transport und Routing:** Tatsächliche HTTPS-Terminierung, HTTP-zu-HTTPS-Weiterleitung, öffentliche Hostregel und WebSocket-Routing zum Backendport.
2. **Peers und Erreichbarkeit:** Tatsächlich angebundene Netze und Container sowie mögliche direkte Zugriffe auf den Backendport.
3. **Forwarding-Kette:** Umgang mit clientseitigen `X-Forwarded-For`-/`X-Forwarded-Proto`-Werten und weiteren Proxyhops. Nachweisen, dass der von Node verwendete erste Client-Eintrag und der genaue Protokollwert autoritativ sind; keine Peer-Allowlist oder Headerbereinigungsregel aus dem Repository unterstellen.
4. **Effektive Runtime:** Wirksamer `TRUST_PROXY`-Wert, konsistente Login-/Logout-Cookieattribute auf dem öffentlichen HTTPS-Pfad und die tatsächlich für HTTP-/WebSocket-Quoten ausgewählte Client-IP in einem autorisierten Testdeployment.

Grundlage: [SA-06-Fixstatus](SA-06-FIX-STATUS.md) und [Deployment-Dokumentation](../dokploy.md). Keine Proxy-Peers, CIDRs oder Traefik-Regeln wurden erfunden oder verändert. **Lokale Testerfolge bestätigen nicht die Sicherheit der produktiven Proxy-Konfiguration.**
