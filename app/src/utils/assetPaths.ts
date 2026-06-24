const ABSOLUTE_URL_PATTERN = /^[a-zA-Z][a-zA-Z\d+\-.]*:/;

export function withBasePath(path: string): string {
  if (!path) return path;
  if (ABSOLUTE_URL_PATTERN.test(path) || path.startsWith('//')) {
    return path;
  }
  const envBase = import.meta.env.BASE_URL ?? '/';
  // If the build base is '/', derive a runtime base from the current document (helps on GitHub Pages).
  const runtimeBase =
    envBase === '/' && typeof document !== 'undefined'
      ? new URL('.', document.baseURI).pathname
      : envBase;
  const trimmedBase = runtimeBase.endsWith('/') ? runtimeBase : `${runtimeBase}/`;
  const trimmedPath = path.startsWith('/') ? path.slice(1) : path;
  return `${trimmedBase}${trimmedPath}`;
}
