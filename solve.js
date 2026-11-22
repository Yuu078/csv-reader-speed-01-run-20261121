// Fast drop-in for csv-reader 1.0.0 (make.fun's own reference program).
// Returns exactly csv-reader's answer {columns, rows, errors} for every input.
// Pure: no clock, no randomness, no locale, nothing kept between calls.
//
// v9 strategy (v7's readers plus one narrow span path; the harness runs
// every case in a fresh process, so nothing may be cached between calls
// and all of the win has to come from the cold path itself):
//   - Readers navigate with native indexOf jumps instead of
//     per-character JS loops (a bare charCodeAt counting loop over the
//     competition texts costs ~57 ms per 10M chars; indexOf jumps over
//     the same texts cost ~22 ms). The next LF / CR / comma / quote
//     positions are cached and only move forward, so per field the work
//     is O(1) checks plus amortized indexOf scans:
//       - an unquoted field ends at the earliest of the next comma, the
//         next LF, or a lone CR; a CR belonging to a CRLF is governed
//         by its LF. Only when a lone CR cuts the field (rare) does the
//         field fall back to the character loop, which also serves
//         quote junk and the unterminated-quote re-read. (The caches
//         close v6's O(N^2): it rescanned indexOf(',') from the field
//         start every time — a 200k-line one-column file took ~4.2 s
//         vs the reference's ~0.08 s.)
//       - a quoted field jumps between its specials (quote, CR, LF):
//         an LF inside it is kept as it stands and only counted, a CR
//         becomes one LF, a doubled quote one quote — segments are
//         sliced, never built character by character. The moment no
//         quote remains anywhere the field is known unterminated: bail
//         out at once instead of walking every remaining line break.
//   - One-field records skip the reader machinery entirely: when the
//     record's span (up to the next LF, a cache that only moves
//     forward) provably holds no '"', no CR but the closing CRLF's own
//     and no comma, the field is the span sliced once. The path is
//     gated on the record width being one (or not yet known), so
//     multi-column files — every generated case — pay nothing for it
//     per record, while one-column files (the per-record-overhead
//     worst case, ~3x the per-char cost of a mixed file) read at
//     split speed. Broader span splitting (whole records, inlined
//     readers) was built and measured for v9 and came out SLOWER in
//     fresh processes on generated cases — the split's allocation
//     pattern costs more under a cold heap than the reader calls it
//     saves — so the span path stays this narrow on purpose.
// Semantics are a line-for-line port of vendor/csv-reader:
//   U+FEFF at the very start is dropped; a record ends at LF or CRLF; a
//   line left with no characters is no record; outside quotes a CR not
//   followed by LF is dropped (stray_cr); a field opening with a quote
//   runs to the next quote that is not doubled, "" inside it is one quote,
//   each CRLF or lone CR inside it reads as LF; what follows its closing
//   quote, up to the next comma or line break, is appended as it stands
//   (quote_junk, when the field ends); a quote that never closes is a
//   literal character and the text after it is read again as unquoted
//   (unterminated_quote); a quote inside an unquoted field is a literal
//   character; fields stay strings, never trimmed; columns is the first
//   record when header is true, else null; rows holds the records after
//   it, each padded with "" (short_row) or cut (long_row) to the first
//   record's width; each error is {code, line, row} in the order met.

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

  // The field just read, carried in closure variables (no per-field object).
  let fValue = '';
  let fEnded = END;
  let fAdded = 0;

  // Cached next LF / CR / comma / quote at or after the last lookup
  // (Infinity: none). All only move forward; the one place pos rewinds
  // (the unterminated-quote re-read) resets them all.
  let nextLF = -1;
  let nextCR = -1;
  let nextComma = -1;
  let nextQuote = -1;

  // Character-loop unquoted read (the exact port): used when a lone CR
  // splits a field, and for the quote-junk and unterminated-quote re-reads.
  // Reads onto `value` up to the next comma or line break; a CR not
  // followed by LF is dropped (stray_cr). Sets fValue/fEnded/fAdded.
  function readUnquotedSlow(value) {
    let i = pos;
    let seg = pos; // start of the current kept segment
    let parts = null; // kept segments, only once a stray CR splits the field
    let added = 0;
    while (i < n) {
      const c = text.charCodeAt(i);
      if (c >= 45) { // ordinary character (letters, digits, '-', '.', ...)
        i += 1;
        continue;
      }
      if (c === 44) { // ','
        pos = i + 1;
        fAdded = added + (i - seg);
        fValue = parts === null
          ? value + text.slice(seg, i)
          : value + (parts.push(text.slice(seg, i)), parts.join(''));
        fEnded = COMMA;
        return;
      }
      if (c === 10) { // '\n'
        pos = i + 1;
        line += 1;
        fAdded = added + (i - seg);
        fValue = parts === null
          ? value + text.slice(seg, i)
          : value + (parts.push(text.slice(seg, i)), parts.join(''));
        fEnded = LINE_BREAK;
        return;
      }
      if (c === 13) { // '\r'
        if (text.charCodeAt(i + 1) === 10) { // CRLF
          pos = i + 2;
          line += 1;
          fAdded = added + (i - seg);
          fValue = parts === null
            ? value + text.slice(seg, i)
            : value + (parts.push(text.slice(seg, i)), parts.join(''));
          fEnded = LINE_BREAK;
          return;
        }
        // Lone CR outside quotes: dropped, error recorded, reading goes on.
        errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
        if (parts !== null) parts.push(text.slice(seg, i));
        else if (i > seg) parts = [text.slice(seg, i)];
        added += i - seg;
        i += 1;
        seg = i;
        continue;
      }
      i += 1; // a character under 45 that is no separator: space, '"', ...
    }
    pos = n;
    fAdded = added + (i - seg);
    fValue = parts === null
      ? value + text.slice(seg, i)
      : value + (parts.push(text.slice(seg, i)), parts.join(''));
    fEnded = END;
  }

  // Fast unquoted read for the record loop (initial value always '').
  function readUnquoted() {
    if (nextLF < pos) {
      const x = text.indexOf('\n', pos);
      nextLF = x === -1 ? Infinity : x;
    }
    if (nextCR < pos) {
      const x = text.indexOf('\r', pos);
      nextCR = x === -1 ? Infinity : x;
    }
    if (nextComma < pos) {
      const x = text.indexOf(',', pos);
      nextComma = x === -1 ? Infinity : x;
    }
    const comma = nextComma;
    // A CR that belongs to a CRLF is governed by its LF; only a lone CR
    // cuts the field, and then the character loop takes over.
    let cr = nextCR;
    if (cr !== Infinity && text.charCodeAt(cr + 1) === 10) cr = Infinity;
    if (cr < comma && cr < nextLF) {
      readUnquotedSlow('');
      return;
    }
    if (comma < nextLF) {
      fValue = text.slice(pos, comma);
      pos = comma + 1;
      fEnded = COMMA;
      return;
    }
    if (nextLF !== Infinity) {
      // The CR of a CRLF is not field content.
      const end = text.charCodeAt(nextLF - 1) === 13 ? nextLF - 1 : nextLF;
      fValue = text.slice(pos, end);
      pos = nextLF + 1;
      line += 1;
      fEnded = LINE_BREAK;
      return;
    }
    fValue = text.slice(pos);
    pos = n;
    fEnded = END;
  }

  // Reads a quoted field whose opening quote is at pos, jumping between
  // its specials with indexOf.
  function readQuoted() {
    const open = pos;
    const openLine = line;
    let i = pos + 1;
    let seg = i; // start of the current raw segment (LFs inside stay as they are)
    let parts = null; // segments, only once a conversion ("" or CR) splits the field
    let value;
    while (true) {
      if (nextQuote < i) {
        const x = text.indexOf('"', i);
        nextQuote = x === -1 ? Infinity : x;
      }
      if (nextQuote === Infinity) {
        // No quote remains anywhere in the text, so this one never
        // closes: it is a literal character, and the text after it is
        // read again as unquoted. Bail out at once — the CR/LF walk
        // below could only discard its work here anyway. pos rewinds to
        // just after the opening quote, so every position cache (valid
        // only for positions at or after the furthest lookup) must be
        // invalidated.
        pos = open + 1;
        line = openLine;
        nextLF = -1;
        nextCR = -1;
        nextComma = -1;
        nextQuote = -1;
        errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
        readUnquotedSlow('"');
        return;
      }
      if (nextLF < i) {
        const x = text.indexOf('\n', i);
        nextLF = x === -1 ? Infinity : x;
      }
      if (nextCR < i) {
        const x = text.indexOf('\r', i);
        nextCR = x === -1 ? Infinity : x;
      }
      const qPos = nextQuote;
      if (nextCR <= nextLF && nextCR <= qPos) {
        // CRLF and a lone CR inside quotes are each one LF.
        if (parts !== null) parts.push(text.slice(seg, nextCR), '\n');
        else parts = [text.slice(seg, nextCR), '\n'];
        line += 1;
        i = nextCR + (text.charCodeAt(nextCR + 1) === 10 ? 2 : 1);
        seg = i;
        continue;
      }
      if (nextLF <= qPos) {
        // An LF inside quotes is kept as it stands; the segment runs on.
        line += 1;
        i = nextLF + 1;
        continue;
      }
      if (text.charCodeAt(qPos + 1) === 34) {
        // Doubled quote: one quote, reading goes on.
        if (parts !== null) parts.push(text.slice(seg, qPos), '"');
        else parts = [text.slice(seg, qPos), '"'];
        i = qPos + 2;
        seg = i;
        continue;
      }
      // The closing quote.
      value = parts === null
        ? text.slice(seg, qPos)
        : (parts.push(text.slice(seg, qPos)), parts.join(''));
      pos = qPos + 1;
      break;
    }
    if (pos >= n) {
      fValue = value;
      fEnded = END;
      return;
    }
    const c = text.charCodeAt(pos);
    if (c === 44) {
      pos += 1;
      fValue = value;
      fEnded = COMMA;
      return;
    }
    if (c === 10) {
      pos += 1;
      line += 1;
      fValue = value;
      fEnded = LINE_BREAK;
      return;
    }
    if (c === 13 && text.charCodeAt(pos + 1) === 10) {
      pos += 2;
      line += 1;
      fValue = value;
      fEnded = LINE_BREAK;
      return;
    }
    // What follows the closing quote is appended as it stands, up to the
    // next comma or line break.
    readUnquotedSlow(value);
    if (fAdded > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
  }

  // The record's span, up to the next LF, when it is provably a
  // single plain field: no '"' and no CR in it but the closing CRLF's
  // own means no quoted field can start and no stray CR can hide, and
  // no comma means the one field is the span itself. Returns null for
  // any other record, which the field readers below then read exactly
  // as v7 did.
  function plainSpan() {
    // Only one-field records can take this path (a one-column file, or
    // the header record before the width is known); anything wider is
    // read by the field readers, so wide files pay nothing per record.
    if (width > 1) return null;
    if (nextLF < pos) {
      const x = text.indexOf('\n', pos);
      nextLF = x === -1 ? Infinity : x;
    }
    const lf = nextLF;
    const spanEnd = lf === Infinity ? n : lf;
    let contentEnd = spanEnd;
    if (lf !== Infinity && contentEnd > pos && text.charCodeAt(contentEnd - 1) === 13) contentEnd -= 1;
    if (contentEnd === pos) return null;
    if (nextQuote < pos) {
      const x = text.indexOf('"', pos);
      nextQuote = x === -1 ? Infinity : x;
    }
    if (nextQuote < contentEnd) return null;
    if (nextCR < pos) {
      const x = text.indexOf('\r', pos);
      nextCR = x === -1 ? Infinity : x;
    }
    if (nextCR < contentEnd) return null;
    if (nextComma < pos) {
      const x = text.indexOf(',', pos);
      nextComma = x === -1 ? Infinity : x;
    }
    if (nextComma < contentEnd) return null;
    const fields = [text.slice(pos, contentEnd)];
    pos = lf === Infinity ? n : lf + 1;
    if (lf !== Infinity) line += 1;
    return fields;
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

    let fields = plainSpan();
    let quoted = false;
    if (fields === null) {
      fields = [];
      do {
        if (pos < n && text.charCodeAt(pos) === 34) {
          quoted = true;
          readQuoted();
        } else {
          quoted = false;
          readUnquoted();
        }
        fields.push(fValue);
      } while (fEnded === COMMA);
    }

    // A line that held only stray CRs is left with no characters: no
    // record (its stray_cr errors stay).
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
