/**
 * Request-path canonicality.
 *
 * Route matching here and the origin behind it must agree on which resource a
 * request names. CloudFront chooses the cache behavior using a normalised form
 * of the path, but hands this function the URI as it was sent. A path that
 * normalises to a gated route can therefore miss the route table below while
 * still being served by the origin as that route.
 *
 * Rather than guess how every hop will interpret an unusual path, accept only
 * paths that are already in canonical form and reject the rest. Legitimate
 * clients send canonical paths, so this costs them nothing.
 *
 * A path is canonical when it:
 *   - starts with "/" and contains no control characters or backslashes;
 *   - has no malformed percent-escapes;
 *   - has no percent-encoded dot, slash, backslash, percent sign (double
 *     encoding) or control character;
 *   - has no "." or ".." segment (a ";" path parameter on a segment is ignored
 *     when checking, since some servers strip it) and no empty segment other
 *     than a trailing one ("//" is rejected, "/a/" is fine).
 *
 * Other percent-encoded characters (for example UTF-8 sequences) are allowed.
 */
export function isCanonicalRequestPath(uri: unknown): boolean {
  if (typeof uri !== 'string' || uri.length === 0 || uri[0] !== '/') return false;

  // Control characters and backslash (treated as a separator by some servers).
  if (/[\u0000-\u001f\u007f\\]/.test(uri)) return false;

  // Malformed percent-escape.
  if (/%(?![0-9a-f]{2})/i.test(uri)) return false;

  // Encoded dot (%2e), slash (%2f), percent (%25), backslash (%5c), or control
  // character (%00-%1f, %7f).
  if (/%(?:2[ef5]|5c|[01][0-9a-f]|7f)/i.test(uri)) return false;

  const segments = uri.split('/').slice(1);
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    const base = segment.split(';', 1)[0];
    if (base === '.' || base === '..') return false;
    if (segment === '' && i < segments.length - 1) return false;
  }
  return true;
}
