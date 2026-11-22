// Fast drop-in replacement for csv-reader 1.0.0. (round 6)
//
// Same answer as csv-reader for every {text, header}: {columns, rows, errors}.
// Design: ONE inlined field loop for every record — no per-field function
// calls in the hot path (round 5 paid a readField() call per field, an
// unquoted() call per unquoted field, a refreshLineEnd() call per unquoted
// field, and an appendQuoted() call per quoted chunk). The record loop below
// reads each field inline: a quote at a field start takes the quoted branch,
// every other field is one indexOf(',') plus one slice, bounded by the
// cached end of the current line (lineEnd), so the line end is never
// re-scanned per field. A quote in the middle of an unquoted field is a
// literal (csv-reader's rule), so only a quote at a field start ever needs
// the quoted branch.
//
// The helpers refreshLineEnd / appendQuoted / unquoted are kept for the
// rare paths only: refreshLineEnd runs once per record (to arm the quoted
// fast path) and inside unquoted; appendQuoted runs only when a quoted
// chunk misses the inlined fast path; unquoted runs only for quote junk
// after a closing quote and for unterminated quotes. All three still share
// the same closure state, so the rare paths behave exactly as in round 5.
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

  // How the field just read ended ('comma', 'line break' or 'end').
  // Set by the inlined field code and by unquoted(), read by the record loop.
  let fEnded = 'end';

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
  // instead of a per-character loop. Only used for the rare paths (quote
  // junk after a closing quote, unterminated quotes); the hot path inlines
  // this logic in the record loop.
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
      let v;
      if (text.charCodeAt(pos) === 34) {
        // Quoted field (inlined readField quoted branch).
        quotedAny = true;
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
            v = unquoted('"');
            break;
          }
          if (text[q + 1] === '"') {
            // A doubled quote: the chunk up to and including the first quote
            // holds one quote in the value; read on after the pair.
            const s = text.slice(chunkStart, q + 1);
            if (lineEndValid && q + 1 <= lineCend && !lineHasStrayCR) {
              value = value === '' ? s : value + s;
            } else {
              value = appendQuoted(value, chunkStart, q + 1);
            }
            pos = q + 2;
            chunkStart = pos;
            continue;
          }
          {
            const s = text.slice(chunkStart, q);
            if (lineEndValid && q <= lineCend && !lineHasStrayCR) {
              value = value === '' ? s : value + s;
            } else {
              value = appendQuoted(value, chunkStart, q);
            }
          }
          pos = q + 1;
          if (pos >= len) {
            v = value;
            fEnded = 'end';
            break;
          }
          const c = text.charCodeAt(pos);
          if (c === 44) {
            pos += 1;
            v = value;
            fEnded = 'comma';
            break;
          }
          if (c === 10) {
            pos += 1;
            line += 1;
            lineEndValid = false;
            v = value;
            fEnded = 'line break';
            break;
          }
          if (c === 13 && text.charCodeAt(pos + 1) === 10) {
            pos += 2;
            line += 1;
            lineEndValid = false;
            v = value;
            fEnded = 'line break';
            break;
          }
          // What follows the closing quote is appended as it stands, up to the
          // next comma or line break.
          const before = value.length;
          v = unquoted(value);
          if (v.length > before) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
          break;
        }
      } else {
        // Unquoted field (inlined unquoted with the refresh check inlined).
        if (pos >= len) {
          fEnded = 'end';
          v = '';
        } else {
          if (!lineEndValid) refreshLineEnd();
          const ci = text.indexOf(',', pos);
          if (ci !== -1 && ci < lineEnd) {
            const chunk = text.slice(pos, ci);
            if (!lineHasStrayCR || chunk.indexOf('\r') === -1) {
              pos = ci + 1;
              fEnded = 'comma';
              v = chunk;
            } else {
              let value = '';
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
              v = value;
            }
          } else {
            // The field ends at the line break (or the end of the text).
            const chunk = text.slice(pos, lineCend);
            let value = '';
            if (!lineHasStrayCR || chunk.indexOf('\r') === -1) {
              if (chunk !== '') value = chunk;
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
            v = value;
          }
        }
      }
      fields.push(v);
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
