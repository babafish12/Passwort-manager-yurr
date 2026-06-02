// Password strength indicator
const PasswordGenerator = {
  updateStrength(password) {
    const fill = document.getElementById('strength-fill');
    const meter = document.getElementById('strength-bar');
    const text = document.getElementById('strength-text');
    if (!password) {
      fill.className = 'strength-fill';
      if (meter) {
        meter.setAttribute('aria-valuenow', '0');
        meter.setAttribute('aria-valuetext', 'empty');
      }
      if (text) text.textContent = 'Password strength: empty';
      return;
    }

    const score = this.calculateStrength(password);
    let label = 'weak';
    let value = 1;

    if (score < 2) {
      fill.className = 'strength-fill weak';
    } else if (score < 3) {
      fill.className = 'strength-fill fair';
      label = 'fair';
      value = 2;
    } else if (score < 4) {
      fill.className = 'strength-fill good';
      label = 'good';
      value = 3;
    } else {
      fill.className = 'strength-fill strong';
      label = 'strong';
      value = 4;
    }

    if (meter) {
      meter.setAttribute('aria-valuenow', String(value));
      meter.setAttribute('aria-valuetext', label);
    }
    if (text) text.textContent = `Password strength: ${label}`;
  },

  calculateStrength(password) {
    let score = 0;

    if (password.length >= 8) score++;
    if (password.length >= 12) score++;
    if (password.length >= 16) score++;

    if (/[a-z]/.test(password) && /[A-Z]/.test(password)) score++;
    if (/\d/.test(password)) score++;
    if (/[^a-zA-Z0-9]/.test(password)) score++;

    return Math.min(score, 5);
  },
};
