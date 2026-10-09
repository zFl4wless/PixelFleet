import { useEffect } from "react";
import { LegalFooter } from "./legal/LegalPages";

export function NotFoundPage() {
  useEffect(() => {
    const previousTitle = document.title;
    document.title = "404 - Page not found | Pixel Fleet";
    return () => { document.title = previousTitle; };
  }, []);

  return (
    <>
      <main className="app-screen center-screen">
        <section className="pixel-panel not-found-panel" aria-labelledby="not-found-title">
          <img src="/pixel-fleet-mark.svg" alt="" className="login-logo" />
          <p className="eyebrow">Off the radar</p>
          <p className="not-found-code" aria-hidden="true">404</p>
          <h1 id="not-found-title">Page not found</h1>
          <p className="not-found-description">There is nothing at these coordinates. Head back to port to join the fleet.</p>
          <a className="eightbit-button button-lg not-found-home" href="/">Back to home</a>
        </section>
      </main>
      <LegalFooter />
    </>
  );
}
