// Fast drop-in replacement for csv-reader 1.0.0. (round 5)
//
// Same answer as csv-reader for every {text, header}: {columns, rows, errors}.
// Design: ONE field loop for every record — no fast/slow dispatch, no
// per-field return objects, no per-field function calls in the hot path.
// A field that opens with a quote takes the quoted branch; every other field
// is one indexOf(',') plus one slice, bounded by the cached end of the
// current line (lineEnd), so the line end is never re-scanned per field.
// A quote in the middle of an unquoted field is a literal (csv-reader's
// rule), so only a quote at a field start ever needs the quoted branch.
//
// Semantics (csv-reader 1.0.0): U+FEFF at the very start is dropped; a record
// ends at LF or CRLF; an empty line is no record; outside quotes a CR not
// followed by LF is dropped (stray_cr); a field opening with a quote runs to
// the next non-doubled quote ("" inside is one quote, CRLF/lone CR inside is
// read as LF), text after the closing quote up to the next comma or line break
// is appended as-is (quote_junk when the field ends); an unclosed quote is a
// literal and the text after it is re-read as unquoted (unterminated_quote);
// a quote inside an unquoted field is a literal; fields stay strings;
// columns is the first record when header is true, else null; rows are padded
// with "" (short_row, fields: count) or cut (long_row, extra: cut fields) to
// the first record's width; errors are {code, line, row} in the order met,
// line the 1-based line the record starts on, row its index in rows
// (null for the header).

/** csv-reader 1.0.0's answer for one case's input. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  const len = text.length;
  let pos = 0; // the next character to read
  let line = 1; // the line that character is on
  if (text.charCodeAt(0) === 0xfeff) pos = 1;

  // Index of the next LF at or after the position where it was computed
  // (len when there is none), and whether it still bounds the current pos.
  // It is recomputed only when pos crosses a line break or a quoted field
  // spans lines, so an unquoted field never re-scans for the line end.
  let lineEnd = len;
  let lineEndValid = false;

  // Index of the next CR at or after the position where it was computed
  // (len when there is none). It is refreshed only when it falls behind
  // pos, so the total scan for CRs over a run is linear in the text.
  let nextCR = -1;
  // Content end of the current line (lineEnd minus a CRLF terminator) and
  // whether the current line can hold a stray CR. Both are set by
  // refreshLineEnd and stay valid while lineEnd is valid: a line with no
  // stray CR cannot gain one as pos advances within it.
  let lineCend = len;
  let lineHasStrayCR = true;

  // The record being read: the line it starts on and the index in rows it takes (null: the header).
  let recordLine = 1;
  let recordRow = null;

  // The field just read: its value, how it ended, and whether it opened
  // with a quote. Set by readField / unquoted, read by the record loop.
  let fValue = '';
  let fEnded = 'end';
  let fQuoted = false;

  function refreshLineEnd() {
    if (!lineEndValid) {
      const ni = text.indexOf('\n', pos);
      lineEnd = ni === -1 ? len : ni;
      lineEndValid = true;
      if (nextCR < pos) {
        const r = text.indexOf('\r', pos);
        nextCR = r === -1 ? len : r;
      }
      lineCend =
        lineEnd < len && lineEnd > pos && text.charCodeAt(lineEnd - 1) === 13
          ? lineEnd - 1
          : lineEnd;
      lineHasStrayCR = nextCR < lineCend;
    }
  }

  // A quoted field's content chunk [start, end): CR and LF inside quotes are
  // each read as one LF and each counts one line. The chunk holds neither in
  // the common case. When the chunk ends at or before the cached line end it
  // cannot hold an LF, so only the CR scan runs. Appends the chunk to `value`.
  function appendQuoted(value, start, end) {
    const s = text.slice(start, end);
    // The chunk lies inside a line known to hold no stray CR and ends at or
    // before that line's content end, so it holds neither CR nor LF.
    if (lineEndValid && end <= lineCend && !lineHasStrayCR) return value === '' ? s : value + s;
    if (lineEndValid && end <= lineEnd) {
      if (s.indexOf('\r') === -1) return value === '' ? s : value + s;
    } else if (s.indexOf('\n') === -1 && s.indexOf('\r') === -1) {
      return value === '' ? s : value + s;
    }
    let breaks = 0;
    const fixed = s.replace(/\r\n|\r|\n/g, () => {
      breaks += 1;
      return '\n';
    });
    line += breaks;
    if (breaks > 0) lineEndValid = false;
    return value === '' ? fixed : value + fixed;
  }

  // Reads unquoted characters onto `value` up to the next comma or line
  // break: a CR not followed by LF is dropped (stray_cr). The field's end is
  // the nearer of the next comma and the cached line end. Sets fEnded.
  // A stray CR is rare, so its chunk is handled by slicing around each CR
  // instead of a per-character loop.
  function unquoted(value) {
    if (pos >= len) {
      fEnded = 'end';
      return value;
    }
    refreshLineEnd();
    const ci = text.indexOf(',', pos);
    if (ci !== -1 && ci < lineEnd) {
      const chunk = text.slice(pos, ci);
      if (!lineHasStrayCR || chunk.indexOf('\r') === -1) {
        pos = ci + 1;
        fEnded = 'comma';
        return value === '' ? chunk : value + chunk;
      }
      let start = 0;
      let i = chunk.indexOf('\r');
      while (i !== -1) {
        errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
        if (i > start) value = value === '' ? chunk.slice(start, i) : value + chunk.slice(start, i);
        start = i + 1;
        i = chunk.indexOf('\r', start);
      }
      if (start < chunk.length) value = value === '' ? chunk.slice(start) : value + chunk.slice(start);
      pos = ci + 1;
      fEnded = 'comma';
      return value;
    }
    // The field ends at the line break (or the end of the text).
    const chunk = text.slice(pos, lineCend);
    if (!lineHasStrayCR || chunk.indexOf('\r') === -1) {
      if (chunk !== '') value = value === '' ? chunk : value + chunk;
    } else {
      let start = 0;
      let i = chunk.indexOf('\r');
      while (i !== -1) {
        errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
        if (i > start) value = value === '' ? chunk.slice(start, i) : value + chunk.slice(start, i);
        start = i + 1;
        i = chunk.indexOf('\r', start);
      }
      if (start < chunk.length) value = value === '' ? chunk.slice(start) : value + chunk.slice(start);
    }
    if (lineEnd >= len) {
      pos = len;
      fEnded = 'end';
    } else {
      pos = lineEnd + 1;
      line += 1;
      lineEndValid = false;
      fEnded = 'line break';
    }
    return value;
  }

  // Reads one field starting at pos. Sets fValue, fEnded, fQuoted.
  function readField() {
    fQuoted = text.charCodeAt(pos) === 34;
    if (!fQuoted) {
      fValue = unquoted('');
      return;
    }
    const open = pos;
    const openLine = line;
    pos += 1;
    let chunkStart = pos;
    let value = '';
    while (true) {
      const q = text.indexOf('"', pos);
      if (q === -1) {
        // The quote never closes: it is a literal character, and the text
        // after it is read again as unquoted.
        pos = open + 1;
        line = openLine;
        errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
        fValue = unquoted('"');
        return;
      }
      if (text[q + 1] === '"') {
        // A doubled quote: the chunk up to and including the first quote
        // holds one quote in the value; read on after the pair.
        value = appendQuoted(value, chunkStart, q + 1);
        pos = q + 2;
        chunkStart = pos;
        continue;
      }
      value = appendQuoted(value, chunkStart, q);
      pos = q + 1;
      if (pos >= len) {
        fValue = value;
        fEnded = 'end';
        return;
      }
      const c = text.charCodeAt(pos);
      if (c === 44) {
        pos += 1;
        fValue = value;
        fEnded = 'comma';
        return;
      }
      if (c === 10) {
        pos += 1;
        line += 1;
        lineEndValid = false;
        fValue = value;
        fEnded = 'line break';
        return;
      }
      if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
        lineEndValid = false;
        fValue = value;
        fEnded = 'line break';
        return;
      }
      // What follows the closing quote is appended as it stands, up to the
      // next comma or line break.
      const before = value.length;
      fValue = unquoted(value);
      if (fValue.length > before) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
      return;
    }
  }

  while (true) {
    // Lines with no characters are no records.
    while (pos < len) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
        lineEndValid = false;
      } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
        lineEndValid = false;
      } else {
        break;
      }
    }
    if (pos >= len) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;
    refreshLineEnd();

    const fields = [];
    let quotedAny = false;
    do {
      readField();
      if (fQuoted) quotedAny = true;
      fields.push(fValue);
    } while (fEnded === 'comma');
    if (fields.length === 1 && fields[0] === '' && !quotedAny) {
      // A line of only stray CRs: its stray_cr errors stay, but it is no record.
      continue;
    }

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
