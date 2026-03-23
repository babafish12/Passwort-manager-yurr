// Heuristics for form field detection
const YurrrHeuristics = {
  // Find standalone username/email fields when no password field is present
  findStandaloneUsernameFields() {
    const candidates = [];

    // Strategy 1: autocomplete attributes
    const autocompleteCandidates = document.querySelectorAll(
      'input[autocomplete="username"], input[autocomplete="email"]'
    );
    for (const el of autocompleteCandidates) {
      if (!this.isHidden(el)) {
        candidates.push(el);
      }
    }

    // Strategy 2: input[type="email"]
    const emailInputs = document.querySelectorAll('input[type="email"]');
    for (const el of emailInputs) {
      if (!this.isHidden(el) && !candidates.includes(el)) {
        candidates.push(el);
      }
    }

    // Strategy 3: name/id matching
    const namePatterns = /^(user|username|email|login|account|uname|uid|identifier)$/i;
    const allInputs = document.querySelectorAll('input[type="text"], input:not([type])');

    for (const el of allInputs) {
      if (this.isHidden(el) || candidates.includes(el)) continue;
      
      const name = el.name || '';
      const id = el.id || '';

      if (namePatterns.test(name) || namePatterns.test(id)) {
        candidates.push(el);
      }
    }

    return candidates;
  },

  // Find the username/email field associated with a password field
  findUsernameField(passwordField) {
    const form = passwordField.closest('form');
    const candidates = [];

    // Strategy 1: autocomplete attributes
    const autocompleteCandidates = document.querySelectorAll(
      'input[autocomplete="username"], input[autocomplete="email"]'
    );
    for (const el of autocompleteCandidates) {
      if (!form || el.closest('form') === form) {
        candidates.push({ el, score: 10 });
      }
    }

    // Strategy 2: input[type="email"]
    const emailInputs = (form || document).querySelectorAll('input[type="email"]');
    for (const el of emailInputs) {
      if (!this.isHidden(el)) {
        candidates.push({ el, score: 8 });
      }
    }

    // Strategy 3: name/id matching
    const namePatterns = /^(user|username|email|login|account|uname|uid|identifier)$/i;
    const nameContains = /(user|email|login|acct|uname|identifier)/i;
    const allInputs = (form || document).querySelectorAll('input[type="text"], input[type="email"], input:not([type])');

    for (const el of allInputs) {
      if (this.isHidden(el)) continue;
      const name = el.name || '';
      const id = el.id || '';
      const placeholder = el.placeholder || '';
      const ariaLabel = el.getAttribute('aria-label') || '';

      if (namePatterns.test(name) || namePatterns.test(id)) {
        candidates.push({ el, score: 9 });
      } else if (nameContains.test(name) || nameContains.test(id)) {
        candidates.push({ el, score: 7 });
      } else if (nameContains.test(placeholder) || nameContains.test(ariaLabel)) {
        candidates.push({ el, score: 5 });
      }
    }

    // Strategy 4: nearest text input before password field in DOM order
    if (form) {
      const inputs = Array.from(form.querySelectorAll('input'));
      const pwIndex = inputs.indexOf(passwordField);
      for (let i = pwIndex - 1; i >= 0; i--) {
        const el = inputs[i];
        const type = el.type?.toLowerCase() || 'text';
        if ((type === 'text' || type === 'email' || !el.type) && !this.isHidden(el)) {
          candidates.push({ el, score: 3 });
          break;
        }
      }
    }

    // Return highest scoring unique candidate
    candidates.sort((a, b) => b.score - a.score);
    const seen = new Set();
    for (const c of candidates) {
      if (!seen.has(c.el)) {
        return c.el;
      }
    }
    return null;
  },

  // Detect if a form is a registration form vs login form
  isRegistrationForm(form) {
    if (!form) return false;

    // Check for multiple password fields
    const passwordFields = form.querySelectorAll('input[type="password"]');
    if (passwordFields.length >= 2) return true;

    // Check autocomplete="new-password"
    const newPw = form.querySelector('input[autocomplete="new-password"]');
    if (newPw) return true;

    // Check form action URL
    const action = (form.action || '').toLowerCase();
    const regPatterns = /(register|signup|sign-up|create|join|enroll)/i;
    if (regPatterns.test(action)) return true;

    // Check submit button text
    const buttons = form.querySelectorAll('button[type="submit"], input[type="submit"], button:not([type])');
    for (const btn of buttons) {
      const text = (btn.textContent || btn.value || '').toLowerCase();
      if (/(register|sign\s*up|create\s*account|join|get\s*started)/i.test(text)) {
        return true;
      }
    }

    return false;
  },

  // Check if element is visible
  isHidden(el) {
    if (!el) return true;
    const style = window.getComputedStyle(el);
    return (
      style.display === 'none' ||
      style.visibility === 'hidden' ||
      style.opacity === '0' ||
      el.offsetWidth === 0 ||
      el.offsetHeight === 0
    );
  },
};
