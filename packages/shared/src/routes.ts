export type FrontendPage = "game" | "legal-notice" | "privacy-policy" | "not-found";

export function frontendPageFromPath(pathname: string): FrontendPage {
  let path: string;
  try {
    path = decodeURIComponent(pathname);
  } catch {
    return "not-found";
  }
  path = path.replace(/\/$/, "") || "/";

  if (path === "/" || path === "/index.html") {
    return "game";
  }
  if (path === "/legal-notice" || path === "/legal-notice/index.html") {
    return "legal-notice";
  }
  if (path === "/privacy-policy" || path === "/privacy-policy/index.html") {
    return "privacy-policy";
  }
  return "not-found";
}
