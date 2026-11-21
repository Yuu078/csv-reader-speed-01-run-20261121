// Fast drop-in for csv-reader 1.0.0 (make.fun's own reference program).
// Returns exactly csv-reader's answer {columns, rows, errors} for every input.
// Pure: no clock, no randomness, no locale, nothing kept between calls.
//
// Strategy: the reference walks the text one character at a time and builds
// every field with per-character string concatenation. This implementation
// walks it with native scans instead: one regex exec finds the next
// separator inside/outside quotes, and fields are taken with slice() in a
// single piece. Behaviour is a line-for-line port of vendor/csv-reader:
//
//   - U+FEFF at the very start is dropped;
//   - a record ends at LF or CRLF; a line left with no characters is no record;
//   - outside quotes a CR not followed by LF is dropped (stray_cr);
//   - a field opening with a quote runs to the next quote that is not doubled,
//     "" inside it is one quote, each CRLF or lone CR inside it reads as LF;
//     what follows its closing quote, up to the next comma or line break, is
//     appended as it stands (quote_junk, when the field ends); a quote that
//     never closes is a literal character and the text after it is read again
//     as unquoted (unterminated_quote);
//   - a quote inside an unquoted field is a literal character;
//   - fields stay strings, never trimmed or converted;
//   - columns is the first record when header is true, else null; rows holds
//     the records after it, each padded with "" (short_row) or cut (long_row)
//     to the first record's width;
//   - each error is {code, line, row} in the order met; line is the 1-based
//     line its record starts on, row its record's index in rows (null for
//     the header).

const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

/** csv-reader 1.0.0's answer for one case's input {text, header}. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  const n = text.length;
  let pos = (n > 0 && text.charCodeAt(0) === 0xFEFF) ? 1 : 0;
  let line = 1; // the line the character at pos is on

  // The record being read: the line it starts on and its index in rows (null: header).
  let recordLine = 1;
  let recordRow = null;

  // Fresh regexes per call: /g state (lastIndex) must never leak between calls.
  // S finds the next separator of an unquoted field; Q the next special inside quotes.
  const S = /[,\r\n]/g;
  const Q = /["\r\n]/g;

  // Reads unquoted characters onto `value` up to the next comma or line break:
  // a CR not followed by LF is dropped (stray_cr). Returns the field, how it
  // ended, and `added`, the characters kept (for the quote_junk check).
  function readUnquoted(value) {
    let added = 0;
    S.lastIndex = pos;
    let m;
    while ((m = S.exec(text)) !== null) {
      const i = m.index;
      const c = m[0];
      if (c === ',') {
        value += text.slice(pos, i);
        added += i - pos;
        pos = i + 1;
        return { value, ended: COMMA, added };
      }
      if (c === '\n') {
        value += text.slice(pos, i);
        added += i - pos;
        pos = i + 1;
        line += 1;
        return { value, ended: LINE_BREAK, added };
      }
      // '\r'
      if (text.charCodeAt(i + 1) === 10) {
        value += text.slice(pos, i);
        added += i - pos;
        pos = i + 2;
        line += 1;
        return { value, ended: LINE_BREAK, added };
      }
      // Lone CR outside quotes: dropped, error recorded, reading goes on.
      errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
      value += text.slice(pos, i);
      added += i - pos;
      pos = i + 1;
      S.lastIndex = pos;
    }
    value += text.slice(pos);
    added += n - pos;
    pos = n;
    return { value, ended: END, added };
  }

  // Reads a quoted field whose opening quote is at pos.
  function readQuoted() {
    const open = pos;
    const openLine = line;
    let value = '';
    pos += 1;
    let closed = false;
    Q.lastIndex = pos;
    let m;
    while ((m = Q.exec(text)) !== null) {
      const i = m.index;
      const c = m[0];
      if (c === '"') {
        if (text.charCodeAt(i + 1) === 34) {
          // Doubled quote: one quote, reading goes on.
          value += text.slice(pos, i);
          value += '"';
          pos = i + 2;
          Q.lastIndex = pos;
          continue;
        }
        value += text.slice(pos, i);
        pos = i + 1;
        closed = true;
        break;
      }
      // CRLF and a lone CR inside quotes are each one LF.
      value += text.slice(pos, i);
      value += '\n';
      line += 1;
      pos = i + 1;
      if (c === '\r' && text.charCodeAt(pos) === 10) pos += 1;
      Q.lastIndex = pos;
    }
    if (!closed) {
      // The quote never closes: it is a literal character, and the text after
      // it is read again as unquoted.
      pos = open + 1;
      line = openLine;
      errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
      return readUnquoted('"');
    }
    if (pos >= n) return { value, ended: END, added: 0 };
    const c = text.charCodeAt(pos);
    if (c === 44) {
      pos += 1;
      return { value, ended: COMMA, added: 0 };
    }
    if (c === 10) {
      pos += 1;
      line += 1;
      return { value, ended: LINE_BREAK, added: 0 };
    }
    if (c === 13 && text.charCodeAt(pos + 1) === 10) {
      pos += 2;
      line += 1;
      return { value, ended: LINE_BREAK, added: 0 };
    }
    // What follows the closing quote is appended as it stands, up to the
    // next comma or line break.
    const junk = readUnquoted(value);
    if (junk.added > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
    return junk;
  }

  while (true) {
    // Lines with no characters are no records.
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= n) break;

    recordLine = line;
    recordRow = (header && columns === null) ? null : rows.length;
    const fields = [];
    let field;
    let quoted;
    do {
      quoted = text.charCodeAt(pos) === 34;
      field = quoted ? readQuoted() : readUnquoted('');
      fields.push(field.value);
    } while (field.ended === COMMA);

    // A line that held only stray CRs is left with no characters: no record
    // (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !quoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
