import { useEffect } from "react";
import { EightBitAlert, EightBitSeparator } from "../8bit";
import { hasPlaceholderLegalConfig, legalConfig } from "../../lib/legalConfig";

export type LegalPageKind = "legal-notice" | "privacy-policy";

const lastUpdated = "May 31, 2026";

const pageTitles: Record<LegalPageKind, string> = {
  "legal-notice": "Legal Notice",
  "privacy-policy": "Privacy Policy"
};

function setMeta(name: string, content: string): () => void {
  const existing = document.querySelector<HTMLMetaElement>(`meta[name="${name}"]`);
  const previousContent = existing ? existing.getAttribute("content") : null;
  const meta = existing ?? document.createElement("meta");

  if (!existing) {
    meta.setAttribute("name", name);
    document.head.append(meta);
  }

  meta.setAttribute("content", content);

  return () => {
    if (!existing) {
      meta.remove();
      return;
    }

    if (previousContent === null) {
      existing.removeAttribute("content");
    } else {
      existing.setAttribute("content", previousContent);
    }
  };
}

export function LegalPage({ page }: { page: LegalPageKind }) {
  const title = pageTitles[page];

  useEffect(() => {
    document.title = `${title} | Pixel Fleet`;
    const restoreRobots = setMeta("robots", "noindex, nofollow, noarchive");
    const restoreGooglebot = setMeta("googlebot", "noindex, nofollow, noarchive");

    return () => {
      document.title = "Pixel Fleet";
      restoreRobots();
      restoreGooglebot();
    };
  }, [title]);

  return (
    <main className="app-screen legal-screen">
      <article className="pixel-panel legal-panel">
        <header className="legal-header">
          <a className="legal-home-link" href="/" aria-label="Back to Pixel Fleet">
            <img src="/pixel-fleet-mark.svg" alt="" />
            <span>Pixel Fleet</span>
          </a>
          <div className="legal-nav" aria-label="Legal pages">
            <a className={page === "legal-notice" ? "active" : undefined} href="/legal-notice">
              Legal Notice
            </a>
            <a className={page === "privacy-policy" ? "active" : undefined} href="/privacy-policy">
              Privacy Policy
            </a>
          </div>
        </header>

        <EightBitSeparator />

        <div className="legal-content">
          <p className="eyebrow">Pixel Fleet</p>
          <h1>{title}</h1>
          <p className="legal-updated">Last updated: {lastUpdated}</p>

          {page === "legal-notice" ? <LegalNotice /> : <PrivacyPolicy />}
        </div>
      </article>
    </main>
  );
}

export function LegalFooter() {
  return (
    <footer className="legal-footer" aria-label="Legal links">
      <a href="/legal-notice">Legal Notice</a>
      <a href="/privacy-policy">Privacy Policy</a>
    </footer>
  );
}

function LegalNotice() {
  return (
    <>
      {hasPlaceholderLegalConfig ? (
        <EightBitAlert tone="warning">
          Public source builds use placeholder legal details. Configure production values through deployment environment
          variables before publishing.
        </EightBitAlert>
      ) : null}

      <section className="legal-section">
        <h2>Information Pursuant To Section 5 DDG</h2>
        <dl className="legal-details">
          <div>
            <dt>Service provider</dt>
            <dd>{legalConfig.providerName}</dd>
          </div>
          <div>
            <dt>Address</dt>
            <dd>{legalConfig.providerAddress}</dd>
          </div>
          <div>
            <dt>Email</dt>
            <dd>{legalConfig.providerEmail}</dd>
          </div>
          <div>
            <dt>Represented by</dt>
            <dd>{legalConfig.representedBy}</dd>
          </div>
          <div>
            <dt>VAT ID</dt>
            <dd>{legalConfig.vatId}</dd>
          </div>
        </dl>
      </section>

      <section className="legal-section">
        <h2>Responsible For Content</h2>
        <p>Responsible for editorial content under Section 18(2) MStV, if applicable: {legalConfig.contentResponsible}.</p>
      </section>

      <section className="legal-section">
        <h2>Liability For Content</h2>
        <p>
          The contents of this website were created with reasonable care. However, we cannot guarantee that all
          information is complete, accurate, or always up to date.
        </p>
      </section>

      <section className="legal-section">
        <h2>Liability For Links</h2>
        <p>
          This website may contain links to external websites. The respective providers are responsible for their own
          content. If we become aware of unlawful content, we will remove the relevant links.
        </p>
      </section>

      <section className="legal-section">
        <h2>Copyright</h2>
        <p>
          Content, artwork, and source materials on this website are protected by copyright unless stated otherwise. Any
          use beyond the limits of copyright law requires prior permission from the respective rights holder.
        </p>
      </section>
    </>
  );
}

function PrivacyPolicy() {
  return (
    <>
      {hasPlaceholderLegalConfig ? (
        <EightBitAlert tone="warning">
          Public source builds use placeholder privacy details. Configure production values through deployment
          environment variables before publishing.
        </EightBitAlert>
      ) : null}

      <section className="legal-section">
        <h2>Controller</h2>
        <p>
          Controller for data processing on this website: {legalConfig.providerName}, {legalConfig.providerAddress},
          email: {legalConfig.providerEmail}.
        </p>
        <p>Data protection officer, if legally required: {legalConfig.dataProtectionOfficer}.</p>
      </section>

      <section className="legal-section">
        <h2>What Data We Process</h2>
        <p>
          When the website is accessed, technical request data may be processed, including IP address, date and time,
          requested URL, status code, referrer, and user agent. This is used to deliver the website, keep it secure, and
          prevent abuse.
        </p>
        <p>
          When a guest account is created, Pixel Fleet stores the chosen username, a user ID, avatar seed, experience
          points, match statistics, session token hash, and timestamps. During live matches, WebSocket connection data
          and temporary game state are processed so the game can run in real time.
        </p>
      </section>

      <section className="legal-section">
        <h2>Cookies And Local Storage</h2>
        <p>
          Pixel Fleet currently uses the strictly necessary session cookie <code>pf_session</code>. It is HttpOnly,
          SameSite=Lax, and can be stored for up to one year so a guest account can be recognized. The app does not
          currently use advertising, tracking, or analytics cookies.
        </p>
      </section>

      <section className="legal-section">
        <h2>Legal Bases</h2>
        <p>
          Account, session, matchmaking, and gameplay data are processed to provide the requested game functionality
          under Article 6(1)(b) GDPR. Security, abuse prevention, rate limiting, and technical logs are processed under
          Article 6(1)(f) GDPR. Strictly necessary cookie access is based on Section 25(2) TDDDG.
        </p>
      </section>

      <section className="legal-section">
        <h2>Hosting And Recipients</h2>
        <p>
          Data may be processed by the hosting provider and technical service providers that operate the website and
          server infrastructure. Hosting provider: {legalConfig.hostingProvider}. Hosting region:{" "}
          {legalConfig.hostingRegion}. Data processing agreement: {legalConfig.hostingDpa}.
        </p>
      </section>

      <section className="legal-section">
        <h2>Retention</h2>
        <p>
          Session data is kept while the guest account session is active or until the session is cleared. Guest account
          profiles and match statistics may remain on the server until deletion, reset, or the end of the configured
          retention period. Technical logs should be kept only as long as necessary for security and operation. Technical
          logs: {legalConfig.logRetention}. Guest accounts and match statistics: {legalConfig.accountRetention}.
        </p>
      </section>

      <section className="legal-section">
        <h2>Your Rights</h2>
        <p>
          Subject to the legal requirements, you may have the right to access, rectify, erase, restrict, or receive your
          personal data, and the right to object to processing based on legitimate interests. You may also lodge a
          complaint with a competent data protection supervisory authority.
        </p>
      </section>

      <section className="legal-section">
        <h2>Security</h2>
        <p>
          Pixel Fleet uses technical and organizational measures intended to protect personal data, including secure
          session cookies and server-side validation. No online service can guarantee absolute security.
        </p>
      </section>
    </>
  );
}
