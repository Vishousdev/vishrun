/**
 * Apply `$0` / `$1..$N` backreferences and the `{{match}}` macro in a card's
 * `replaceString`.
 *
 *  - `$0` / `{{match}}` → the full match string (entire trigger). `{{match}}`
 *    is the SillyTavern regex-context macro; Lumiverse's macro engine has no
 *    such macro, so we expand it here while the full match is in hand (used by
 *    the Jujutsu Check scripts, `{{setvar::var::$N}}{{match}}`).
 *  - `$1..$N` → 1-indexed capture groups.
 *  - `$$` stays as written: SillyTavern only substitutes `$N`, so card code
 *    such as `var $$=function(...)` must reach the widget unchanged.
 *  - Missing groups (e.g. `$5` when only 1 group exists) substitute to empty
 *    string, matching JS's RegExp.exec behavior for missing captures.
 *
 * The function avoids `String.prototype.replace`'s pattern argument because
 * those have their own `$&`/`$1` interpretation that we don't want to
 * cascade into the substitution result.
 */
export function substitute(template: string, fullMatch: string, groups: string[]): string {
  let out = '';
  let i = 0;
  while (i < template.length) {
    const ch = template[i];
    if (ch === '{' && template.slice(i, i + 9).toLowerCase() === '{{match}}') {
      out += fullMatch;
      i += 9;
      continue;
    }
    if (ch !== '$') {
      out += ch;
      i++;
      continue;
    }
    const next = template[i + 1];
    if (next >= '0' && next <= '9') {
      // Greedy: $12 reads as group 12 if present, else falls back to $1 + '2'.
      // Cards in scope only use single-digit references, but be sane about it.
      let endNum = i + 2;
      while (endNum < template.length && template[endNum] >= '0' && template[endNum] <= '9') endNum++;
      const numStr = template.slice(i + 1, endNum);
      const idx = parseInt(numStr, 10);
      if (idx === 0) {
        out += fullMatch;
        i = endNum;
        continue;
      }
      if (idx <= groups.length) {
        out += groups[idx - 1] ?? '';
        i = endNum;
        continue;
      }
      // Out-of-range: try shorter prefix (e.g. $12 → $1 if only 1 group).
      // This matches the Perl-ish behavior that JS-Slash-Runner relies on.
      let consumed = numStr.length;
      while (consumed > 1) {
        consumed--;
        const tryIdx = parseInt(numStr.slice(0, consumed), 10);
        if (tryIdx >= 1 && tryIdx <= groups.length) {
          out += groups[tryIdx - 1] ?? '';
          out += numStr.slice(consumed); // remaining digits as literal
          i = endNum;
          break;
        }
      }
      if (consumed === 1) {
        // No prefix matched a group — emit `$` literal then the digits.
        out += '$' + numStr;
        i = endNum;
      }
      continue;
    }
    // `$` followed by something non-digit — emit literal `$`.
    out += '$';
    i++;
  }
  return out;
}
