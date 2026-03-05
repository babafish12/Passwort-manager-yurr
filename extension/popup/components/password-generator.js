// Password strength indicator
const PasswordGenerator = {
  updateStrength(password) {
    const fill = document.getElementById('strength-fill');
    if (!password) {
      fill.className = 'strength-fill';
      return;
    }

    const score = this.calculateStrength(password);

    if (score < 2) fill.className = 'strength-fill weak';
    else if (score < 3) fill.className = 'strength-fill fair';
    else if (score < 4) fill.className = 'strength-fill good';
    else fill.className = 'strength-fill strong';
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
