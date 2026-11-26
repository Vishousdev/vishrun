// JSON for an inline <script>. Escaping '<' keeps data like '<head>' or
// '</script>' from being seen as markup by the parser or by host injection.
export function inlineJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}
