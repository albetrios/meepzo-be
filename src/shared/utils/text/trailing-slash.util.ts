/**
 * `text` without the `/` characters at its end — `https://app.example.com//` →
 * `https://app.example.com` — so a configured base URL joins a path without a doubled slash.
 *
 * @remarks
 * A loop from the end, not `replace(/\/+$/, '')`: that pattern retries every slash of a long run
 * that is not at the end, which is quadratic (SonarQube S5852). Linear in the trailing run.
 */
export function withoutTrailingSlashes(text: string): string {
  let end = text.length;
  while (end > 0 && text.charAt(end - 1) === '/') end -= 1;
  return text.slice(0, end);
}
