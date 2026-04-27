// CSV parser for browser password exports
const CSVParser = {
  parse(csvText, browserType) {
    const lines = this.splitLines(csvText);
    if (lines.length < 2) return [];

    const headers = this.parseLine(lines[0], { trimFields: true });
    const entries = [];

    for (let i = 1; i < lines.length; i++) {
      const values = this.parseLine(lines[i], { trimFields: false });
      if (!values.length || values.every((v) => !v)) continue;

      let entry;
      if (browserType === 'firefox') {
        entry = this.parseFirefoxRow(headers, values);
      } else {
        entry = this.parseChromeRow(headers, values);
      }

      if (entry && entry.website_url && entry.username && entry.password) {
        // Normalize URL: add https:// if missing
        if (!entry.website_url.startsWith('http')) {
          entry.website_url = 'https://' + entry.website_url;
        }
        entries.push(entry);
      }
    }
    return entries;
  },

  parseChromeRow(headers, values) {
    const urlIdx = headers.findIndex((h) => h.toLowerCase() === 'url');
    const userIdx = headers.findIndex((h) => h.toLowerCase() === 'username');
    const pwIdx = headers.findIndex((h) => h.toLowerCase() === 'password');
    const noteIdx = headers.findIndex((h) => h.toLowerCase() === 'note' || h.toLowerCase() === 'notes');

    return {
      website_url: this.fieldValue(values, urlIdx),
      username: this.fieldValue(values, userIdx),
      password: this.fieldValue(values, pwIdx, { trim: false }),
      notes: noteIdx >= 0 ? this.fieldValue(values, noteIdx, { trim: false }) || null : null,
    };
  },

  parseFirefoxRow(headers, values) {
    const urlIdx = headers.findIndex((h) => h.toLowerCase() === 'url');
    const userIdx = headers.findIndex((h) => h.toLowerCase() === 'username');
    const pwIdx = headers.findIndex((h) => h.toLowerCase() === 'password');

    return {
      website_url: this.fieldValue(values, urlIdx),
      username: this.fieldValue(values, userIdx),
      password: this.fieldValue(values, pwIdx, { trim: false }),
      notes: null,
    };
  },

  fieldValue(values, index, { trim = true } = {}) {
    if (index < 0 || index >= values.length) return '';
    const value = values[index] ?? '';
    return trim ? value.trim() : value;
  },

  // RFC 4180-compliant CSV line parser
  parseLine(line, { trimFields = true } = {}) {
    const values = [];
    let current = '';
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      if (inQuotes) {
        if (char === '"') {
          if (i + 1 < line.length && line[i + 1] === '"') {
            current += '"';
            i++;
          } else {
            inQuotes = false;
          }
        } else {
          current += char;
        }
      } else {
        if (char === '"' && current === '') {
          inQuotes = true;
        } else if (char === ',') {
          values.push(trimFields ? current.trim() : current);
          current = '';
        } else {
          current += char;
        }
      }
    }
    values.push(trimFields ? current.trim() : current);
    return values;
  },

  // Split text into lines, respecting quoted fields that contain newlines
  splitLines(text) {
    const lines = [];
    let current = '';
    let inQuotes = false;

    for (let i = 0; i < text.length; i++) {
      const char = text[i];
      if (char === '"') {
        current += char;
        if (inQuotes && text[i + 1] === '"') {
          current += text[i + 1];
          i++;
          continue;
        }
        inQuotes = !inQuotes;
        continue;
      }

      if ((char === '\n' || char === '\r') && !inQuotes) {
        if (current.length) lines.push(current);
        current = '';
        if (char === '\r' && text[i + 1] === '\n') {
          i++;
        }
      } else {
        current += char;
      }
    }
    if (current.length) lines.push(current);
    return lines;
  },
};
