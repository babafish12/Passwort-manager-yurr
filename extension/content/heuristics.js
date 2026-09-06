// Heuristics for form field detection
const YurrrHeuristics = {
  usernameKeywordPattern: /(user(name)?|email|e-?mail|login|log[ -]?in|account|acct|identifier|member|signin|sign[ -]?in|mail)/i,
  negativeKeywordPattern: /(search|query|suche|suchen|durchsuchen|coupon|promo|captcha|otp|2fa|token|code|postal|zip|city|country|address)/i,
  searchKeywordPattern: /\b(search|query|lookup|find|suche|suchen|durchsuchen)\b/i,
  inputSelector: 'input[type="text"], input[type="email"], input[type="tel"], input:not([type])',
  addressFieldSelector: 'input[type="text"], input[type="tel"], input:not([type]), textarea, select',

  // Find standalone username/email fields when no password field is present
  findStandaloneUsernameFields() {
    const allInputs = Array.from(document.querySelectorAll(this.inputSelector));
    const scored = [];

    for (const el of allInputs) {
      if (!this.isEligibleInput(el)) continue;
      const score = this.scoreUsernameCandidate(el);
      if (score >= 6) {
        scored.push({ el, score });
      }
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.map((item) => item.el);
  },

  // Find the username/email field associated with a password field
  findUsernameField(passwordField) {
    if (!passwordField) return null;
    const form = passwordField.closest('form');
    const scope = form || document;
    const inputs = Array.from(scope.querySelectorAll(this.inputSelector));
    const allInputs = Array.from(scope.querySelectorAll('input'));
    const pwIndex = allInputs.indexOf(passwordField);
    const candidates = [];

    for (const el of inputs) {
      if (!this.isEligibleInput(el)) continue;
      if (form && el.closest('form') !== form) continue;
      if (el === passwordField) continue;

      let score = this.scoreUsernameCandidate(el);
      const idx = allInputs.indexOf(el);

      if (pwIndex !== -1 && idx !== -1) {
        if (idx < pwIndex) {
          score += 4;
          if (idx === pwIndex - 1) score += 2;
        } else {
          score -= 4;
        }
      }

      if (score >= 6) {
        candidates.push({ el, score });
      }
    }

    candidates.sort((a, b) => b.score - a.score);
    return candidates[0]?.el || null;
  },

  findRegistrationEmailField(form, passwordField = null) {
    const scope = form || document;
    const fields = Array.from(scope.querySelectorAll(this.inputSelector));
    let best = null;
    let bestScore = -1;

    for (const el of fields) {
      if (!this.isEligibleInput(el)) continue;
      let score = this.scoreUsernameCandidate(el);
      if (this.isLikelyEmailField(el)) score += 5;

      if (passwordField && form) {
        const allInputs = Array.from(form.querySelectorAll('input'));
        const pwIndex = allInputs.indexOf(passwordField);
        const idx = allInputs.indexOf(el);
        if (pwIndex !== -1 && idx !== -1 && idx < pwIndex) {
          score += 2;
        }
      }

      if (score > bestScore) {
        bestScore = score;
        best = el;
      }
    }

    return bestScore >= 7 ? best : null;
  },

  isLikelyEmailField(el) {
    if (!el) return false;
    if (this.isSearchField(el)) return false;

    const type = (el.type || '').toLowerCase();
    const autocomplete = (el.autocomplete || '').toLowerCase();
    const inputMode = (el.inputMode || '').toLowerCase();
    if (type === 'email') return true;
    if (inputMode === 'email') return true;
    if (autocomplete.includes('email')) return true;

    const meta = this.getFieldMeta(el);
    return /(email|e-?mail|mail)/i.test(meta);
  },

  isSearchField(el) {
    if (!el) return false;

    const type = (el.type || '').toLowerCase();
    const role = (el.getAttribute('role') || '').toLowerCase();
    if (type === 'search' || role === 'searchbox') return true;

    const form = typeof el.closest === 'function' ? el.closest('form') : null;
    const formRole = (form?.getAttribute('role') || '').toLowerCase();
    if (formRole === 'search') return true;

    if (typeof el.closest === 'function' && el.closest('search,[role="search"]')) {
      return true;
    }

    return this.searchKeywordPattern.test(this.getFieldMeta(el));
  },

  scoreUsernameCandidate(el) {
    const type = (el.type || '').toLowerCase();
    const autocomplete = (el.autocomplete || '').toLowerCase();
    const inputMode = (el.inputMode || '').toLowerCase();
    const meta = this.getFieldMeta(el);
    let score = 0;

    if (autocomplete.includes('username')) score += 14;
    if (autocomplete.includes('email')) score += 13;
    if (type === 'email') score += 12;
    if (inputMode === 'email') score += 8;

    if (this.usernameKeywordPattern.test(meta)) score += 8;
    if (/(phone|tel|mobile)/i.test(meta)) score += 2; // email/phone combo logins
    if (this.isSearchField(el)) score -= 20;
    if (this.negativeKeywordPattern.test(meta)) score -= 8;

    return score;
  },

  getFieldMeta(el) {
    const parts = [
      el.name || '',
      el.id || '',
      el.placeholder || '',
      el.getAttribute('aria-label') || '',
      el.getAttribute('autocomplete') || '',
      el.getAttribute('inputmode') || '',
      this.getAssociatedLabelText(el),
    ];
    return parts.join(' ').trim();
  },

  getAssociatedLabelText(el) {
    if (!el) return '';
    const labelTexts = [];

    if (el.labels) {
      for (const label of el.labels) {
        labelTexts.push(label.textContent || '');
      }
    }

    const parentLabel = el.closest('label');
    if (parentLabel) {
      labelTexts.push(parentLabel.textContent || '');
    }

    return labelTexts.join(' ');
  },

  isEligibleInput(el) {
    if (!el) return false;
    if (this.isHidden(el)) return false;
    if (el.disabled || el.readOnly) return false;
    const type = (el.type || '').toLowerCase();
    if (type === 'hidden' || type === 'password') return false;
    return true;
  },

  isEligibleAddressField(el) {
    if (!el) return false;
    if (this.isHidden(el)) return false;
    if (el.disabled || el.readOnly) return false;

    const tagName = String(el.tagName || '').toLowerCase();
    if (tagName === 'textarea' || tagName === 'select') return true;

    if (tagName !== 'input') return false;
    const type = (el.type || '').toLowerCase();
    return !['hidden', 'password', 'checkbox', 'radio', 'submit', 'button', 'reset', 'file', 'image', 'search'].includes(type);
  },

  getAutocompleteTokens(el) {
    return String(el?.getAttribute('autocomplete') || '')
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean);
  },

  getAddressFieldKind(el) {
    if (!this.isEligibleAddressField(el) || this.isSearchField(el)) return '';

    const tokens = this.getAutocompleteTokens(el);
    if (tokens.some((token) => ['email', 'username', 'current-password', 'new-password', 'one-time-code', 'tel'].includes(token))) return '';
    if (this.isLikelyEmailField(el)) return '';
    if (tokens.includes('given-name')) return 'given_name';
    if (tokens.includes('family-name')) return 'family_name';
    if (tokens.includes('name')) return 'full_name';
    if (tokens.includes('street-address')) return 'street_address';
    if (tokens.includes('address-line1')) return 'line1';
    if (tokens.includes('address-line2')) return 'line2';
    if (tokens.includes('address-level2')) return 'city';
    if (tokens.includes('postal-code')) return 'postal_code';
    if (tokens.includes('country') || tokens.includes('country-name')) return 'country';

    const meta = this.getFieldMeta(el);
    if (/(address|adresse|addr)[\s_-]*(2|two|second)|(^|[\s_-])(apt|apartment|suite|unit|wohnung|zusatz)\b|line[\s_-]*2/i.test(meta)) {
      return 'line2';
    }
    if (/(postal|post[\s_-]*code|postcode|zip|plz)/i.test(meta)) {
      return 'postal_code';
    }
    if (/(city|town|locality|stadt|ort)\b/i.test(meta)) {
      return 'city';
    }
    if (/(country|land)\b/i.test(meta)) {
      return 'country';
    }
    if (/(^|[\s_-])(first|given|vorname)([\s_-]|$)/i.test(meta)) {
      return 'given_name';
    }
    if (/(^|[\s_-])(last|family|surname|nachname)([\s_-]|$)/i.test(meta)) {
      return 'family_name';
    }
    if (/(^|[\s_-])(full[\s_-]*name|vollst[aä]ndiger[\s_-]*name|name)([\s_-]|$)/i.test(meta)) {
      return 'full_name';
    }
    if (/(street|strasse|straße|address|adresse|addr|line[\s_-]*1)/i.test(meta)) {
      return 'line1';
    }

    return '';
  },

  isStrongAddressKind(kind) {
    return ['street_address', 'line1', 'line2', 'city', 'postal_code', 'country'].includes(kind);
  },

  findAddressFields(scope = document) {
    const fields = Array.from(scope.querySelectorAll(this.addressFieldSelector))
      .filter((field) => this.getAddressFieldKind(field));
    const hasStrongAddressField = fields.some((field) => this.isStrongAddressKind(this.getAddressFieldKind(field)));

    if (!hasStrongAddressField) {
      return [];
    }

    return fields;
  },

  getVisiblePasswordFields(form) {
    if (!form) return [];
    return Array.from(form.querySelectorAll('input[type="password"]'))
      .filter((field) => !this.isHidden(field) && !field.disabled && !field.readOnly);
  },

  isCurrentPasswordField(field) {
    if (!field || (field.type || '').toLowerCase() !== 'password') return false;

    const autocomplete = (field.autocomplete || '').toLowerCase();
    if (autocomplete.split(/\s+/).includes('current-password')) return true;

    const meta = this.getFieldMeta(field);
    return (
      /(current|old|existing)\s*(password|passcode|pass|pwd)/i.test(meta) ||
      /(password|passcode|pass|pwd)\s*(current|old|existing)/i.test(meta)
    );
  },

  isNewPasswordField(field) {
    if (!field || (field.type || '').toLowerCase() !== 'password') return false;

    const autocomplete = (field.autocomplete || '').toLowerCase();
    if (autocomplete.split(/\s+/).includes('new-password')) return true;

    const meta = this.getFieldMeta(field);
    return (
      /(new|confirm|confirmation|repeat|retype|verify)\s*(password|passcode|pass|pwd)/i.test(meta) ||
      /(password|passcode|pass|pwd)\s*(new|confirm|confirmation|repeat|retype|verify)/i.test(meta)
    );
  },

  findCurrentPasswordField(form) {
    return this.getVisiblePasswordFields(form).find((field) => this.isCurrentPasswordField(field)) || null;
  },

  isPasswordChangeForm(form) {
    const passwordFields = this.getVisiblePasswordFields(form);
    if (passwordFields.length < 2) return false;

    const hasCurrentPassword = passwordFields.some((field) => this.isCurrentPasswordField(field));
    if (!hasCurrentPassword) return false;

    const hasNewPassword = passwordFields.some((field) => this.isNewPasswordField(field));
    return hasNewPassword || passwordFields.length >= 3;
  },

  // Detect if a form is a registration form vs login form
  isRegistrationForm(form) {
    if (!form) return false;
    if (this.isPasswordChangeForm(form)) return false;

    // Check for multiple password fields
    const passwordFields = this.getVisiblePasswordFields(form);
    if (passwordFields.length >= 2) return true;

    // Check autocomplete="new-password"
    const newPw = passwordFields.find((field) => this.isNewPasswordField(field));
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
      Number.parseFloat(style.opacity) === 0 ||
      el.offsetWidth === 0 ||
      el.offsetHeight === 0
    );
  },
};
