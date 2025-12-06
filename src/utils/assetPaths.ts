const ABSOLUTE_URL_PATTERN = /^[a-zA-Z][a-zA-Z\d+\-.]*:/;

export function withBasePath(path: string): string {
  if (!path) return path;
  if (ABSOLUTE_URL_PATTERN.test(path) || path.startsWith('//')) {
    return path;
  }
  const base = import.meta.env.BASE_URL ?? '/';
  const trimmedBase = base.endsWith('/') ? base : `${base}/`;
  const trimmedPath = path.startsWith('/') ? path.slice(1) : path;
  return `${trimmedBase}${trimmedPath}`;
}
