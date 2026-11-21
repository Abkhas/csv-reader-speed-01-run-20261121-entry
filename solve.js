// Fast drop-in replacement for csv-reader 1.0.0.
//
// Same answer as csv-reader for every {text, header}: {columns, rows, errors}.
// Strategy: most records are plain (no quotes, no stray CRs). Those are parsed
// with a slice + split(',') per record, a handful of short bounded scans each,
// instead of one JavaScript step per character. Only a record whose line holds
// a quote or a stray CR takes the careful path, which follows csv-reader's
// rules field by field but still moves in whole chunks (indexOf to the next
// delimiter, slice for the content) instead of character by character.
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

  // The record being read: the line it starts on and the index in rows it takes (null: the header).
  let recordLine = 1;
  let recordRow = null;

  function error(code) {
    errors.push({ code, line: recordLine, row: recordRow });
  }

  // A quoted field's content chunk [start, end): CR and LF inside quotes are
  // each read as one LF and each counts one line. The common chunk holds
  // neither, so it is returned untouched.
  function fixQuoted(start, end) {
    const s = text.slice(start, end);
    if (s.indexOf('\r') === -1 && s.indexOf('\n') === -1) return s;
    let breaks = 0;
    const fixed = s.replace(/\r\n|\r|\n/g, () => {
      breaks += 1;
      return '\n';
    });
    line += breaks;
    return fixed;
  }

  // Reads unquoted characters onto `value` up to the next comma or line break:
  // a CR not followed by LF is dropped (stray_cr). Returns the field, how it
  // ended, and `added`, the characters kept in this call (quote_junk counts
  // only those). The field's end is the nearer of the next comma and the next
  // LF, so every scan stops at a delimiter a few characters away; a CR can
  // only be stray inside the chunk that ends there, and that chunk is short.
  function readUnquoted(value) {
    let added = 0;
    while (pos < len) {
      const ci = text.indexOf(',', pos);
      const ni = text.indexOf('\n', pos);
      let end;
      let ended;
      if (ci !== -1 && (ni === -1 || ci < ni)) {
        end = ci;
        ended = 'comma';
      } else if (ni !== -1) {
        end = ni;
        ended = 'line break';
      } else {
        end = len;
        ended = 'end';
      }
      // A CR just before the LF is the CRLF terminator, not part of the field.
      let cend = end;
      if (ended === 'line break' && end > pos && text.charCodeAt(end - 1) === 13) cend = end - 1;
      const chunk = text.slice(pos, cend);
      if (chunk.indexOf('\r') === -1) {
        value += chunk;
        added += chunk.length;
        if (ended === 'comma') {
          pos = end + 1;
        } else if (ended === 'line break') {
          pos = end + 1;
          line += 1;
        } else {
          pos = len;
        }
        return { value, ended, added };
      }
      // Rare: stray CRs inside this chunk. Every CR here is stray: no LF
      // follows one inside the chunk (the chunk stops at the next LF, and a
      // CR just before it is the CRLF terminator, already excluded above).
      for (let i = 0; i < chunk.length; i++) {
        const ch = chunk[i];
        if (ch === '\r') {
          error('stray_cr');
          continue;
        }
        value += ch;
        added += 1;
      }
      if (ended === 'comma') {
        pos = end + 1;
      } else if (ended === 'line break') {
        pos = end + 1;
        line += 1;
      } else {
        pos = len;
      }
      return { value, ended, added };
    }
    return { value, ended: 'end', added };
  }

  // Reads a quoted field whose opening quote is at pos.
  function readQuoted() {
    const open = pos;
    const openLine = line;
    pos += 1;
    let value = '';
    let chunkStart = pos;
    while (true) {
      const q = text.indexOf('"', pos);
      if (q === -1) {
        // The quote never closes: it is a literal character, and the text
        // after it is read again as unquoted.
        pos = open + 1;
        line = openLine;
        error('unterminated_quote');
        return readUnquoted('"');
      }
      if (text[q + 1] === '"') {
        // A doubled quote: the chunk up to and including the first quote
        // holds one quote in the value; read on after the pair.
        value += fixQuoted(chunkStart, q + 1);
        pos = q + 2;
        chunkStart = pos;
        continue;
      }
      value += fixQuoted(chunkStart, q);
      pos = q + 1;
      if (pos >= len) return { value, ended: 'end' };
      const c = text[pos];
      if (c === ',') {
        pos += 1;
        return { value, ended: 'comma' };
      }
      if (c === '\n') {
        pos += 1;
        line += 1;
        return { value, ended: 'line break' };
      }
      if (c === '\r' && text[pos + 1] === '\n') {
        pos += 2;
        line += 1;
        return { value, ended: 'line break' };
      }
      // What follows the closing quote is appended as it stands, up to the
      // next comma or line break.
      const junk = readUnquoted(value);
      if (junk.added > 0) error('quote_junk');
      return junk;
    }
  }

  // Reads one record that holds a quote or a stray CR, field by field.
  // Returns the fields, or null when the record holds no characters (a line
  // of only stray CRs: its stray_cr errors stay, but it is no record).
  function readSlowRecord() {
    const fields = [];
    let field;
    let quoted = false;
    do {
      quoted = text[pos] === '"';
      field = quoted ? readQuoted() : readUnquoted('');
      fields.push(field.value);
    } while (field.ended === 'comma');
    if (fields.length === 1 && fields[0] === '' && !quoted) return null;
    return fields;
  }

  while (true) {
    // Lines with no characters are no records.
    while (pos < len) {
      if (text[pos] === '\n') {
        pos += 1;
        line += 1;
      } else if (text[pos] === '\r' && text[pos + 1] === '\n') {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= len) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;

    // The record's first line ends at the next LF (or the end of the text).
    // When it holds no quote and no CR except a CRLF terminator, the whole
    // record is that line and its fields are one split.
    const nl = text.indexOf('\n', pos);
    const lineEnd = nl === -1 ? len : nl;
    let segEnd = lineEnd;
    if (nl !== -1 && lineEnd > pos && text.charCodeAt(lineEnd - 1) === 13) segEnd = lineEnd - 1;
    const seg = text.slice(pos, segEnd);

    let fields;
    if (seg.indexOf('"') === -1 && seg.indexOf('\r') === -1) {
      if (seg === '') {
        // Defensive: the empty-line skip above leaves no empty segment.
        pos = nl === -1 ? len : nl + 1;
        line += 1;
        continue;
      }
      fields = seg.split(',');
      pos = nl === -1 ? len : nl + 1;
      line += 1;
    } else {
      fields = readSlowRecord();
      if (fields === null) continue;
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
