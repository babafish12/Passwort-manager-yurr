// CSV parser for browser password exports. Passwords and notes retain whitespace.
const CSVParser = {
  parse(csvText, browserType) {
    return this.parseWithReport(csvText, browserType).entries;
  },

  parseWithReport(csvText, browserType) {
    const rows = this.parseRows(String(csvText || '').replace(/^\uFEFF/, ''));
    if (!rows.length) throw new Error('The CSV file is empty.');
    const headers = rows.shift().map((value) => value.trim().toLowerCase());
    for (const name of ['url', 'username', 'password']) {
      if (headers.filter((header) => header === name).length !== 1) {
        throw new Error(`CSV must contain exactly one ${name} column. Choose a browser password export.`);
      }
    }

    const entries = [];
    let skippedRows = 0;
    for (const [index, values] of rows.entries()) {
      if (values.length !== headers.length) {
        throw new Error(`CSV record ${index + 2} has ${values.length} columns; expected ${headers.length}. Check the export file.`);
      }
      const field = (name) => values[headers.indexOf(name)] || '';
      const website = field('url').trim();
      const username = field('username').trim();
      const password = field('password');
      let url;
      try {
        url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(website) ? website : `https://${website}`);
      } catch {
        skippedRows += 1;
        continue;
      }
      if (!website || !username || !password.trim() || !['https:', 'http:'].includes(url.protocol) || url.username || url.password) {
        skippedRows += 1;
        continue;
      }
      entries.push({
        website_url: url.href,
        username,
        password,
        notes: browserType === 'firefox' ? null : (field('note') || field('notes') || null),
      });
    }
    return { entries, skippedRows, totalRows: rows.length };
  },

  parseRows(text) {
    const rows = [];
    let row = [];
    let field = '';
    let inQuotes = false;
    let closedQuote = false;
    let recordHasContent = false;
    const finishField = () => {
      row.push(field);
      field = '';
      closedQuote = false;
    };
    const finishRecord = () => {
      finishField();
      if (recordHasContent) rows.push(row);
      row = [];
      recordHasContent = false;
    };

    for (let i = 0; i < text.length; i++) {
      const char = text[i];
      if (inQuotes) {
        if (char === '"') {
          if (text[i + 1] === '"') {
            field += '"';
            i += 1;
          } else {
            inQuotes = false;
            closedQuote = true;
          }
        } else {
          field += char;
        }
      } else if (char === ',') {
        recordHasContent = true;
        finishField();
      } else if (char === '\r' || char === '\n') {
        finishRecord();
        if (char === '\r' && text[i + 1] === '\n') i += 1;
      } else if (char === '"' && !field && !closedQuote) {
        recordHasContent = true;
        inQuotes = true;
      } else {
        if (closedQuote || char === '"') {
          throw new Error(`Invalid quoting in CSV record ${rows.length + 1}. Export the file again.`);
        }
        recordHasContent = true;
        field += char;
      }
    }
    if (inQuotes) throw new Error('The CSV contains an unclosed quoted field. Export the file again.');
    if (recordHasContent) finishRecord();
    return rows;
  },
};
