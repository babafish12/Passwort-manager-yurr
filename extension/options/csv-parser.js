// CSV parser for browser password exports
const CSVParser = {
  parse(csvText, browserType) {
    const lines = this.splitLines(csvText);
    if (lines.length < 2) return [];

    const headers = this.parseLine(lines[0]);
    const entries = [];

    for (let i = 1; i < lines.length; i++) {
      const values = this.parseLine(lines[i]);
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
      website_url: values[urlIdx] || '',
      username: values[userIdx] || '',
      password: values[pwIdx] || '',
      notes: noteIdx >= 0 ? values[noteIdx] || null : null,
    };
  },

  parseFirefoxRow(headers, values) {
    const urlIdx = headers.findIndex((h) => h.toLowerCase() === 'url');
    const userIdx = headers.findIndex((h) => h.toLowerCase() === 'username');
    const pwIdx = headers.findIndex((h) => h.toLowerCase() === 'password');

    return {
      website_url: values[urlIdx] || '',
      username: values[userIdx] || '',
      password: values[pwIdx] || '',
      notes: null,
    };
  },

  // RFC 4180-compliant CSV line parser
  parseLine(line) {
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
        if (char === '"') {
          inQuotes = true;
        } else if (char === ',') {
          values.push(current.trim());
          current = '';
        } else {
          current += char;
        }
      }
    }
    values.push(current.trim());
    return values;
  },

  // Split text into lines, respecting quoted fields that contain newlines
  splitLines(text) {
    const lines = [];
    let current = '';
    let inQuotes = false;

    for (const char of text) {
      if (char === '"') inQuotes = !inQuotes;
      if ((char === '\n' || char === '\r') && !inQuotes) {
        if (current.trim()) lines.push(current);
        current = '';
      } else {
        current += char;
      }
    }
    if (current.trim()) lines.push(current);
    return lines;
  },
};
