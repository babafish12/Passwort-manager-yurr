// Local DOM/event fixture; service-worker storage and save decisions have separate Node tests.
const scenario = new URLSearchParams(location.search).get('scenario') || 'spa';
const fixture = document.getElementById('fixture');
const state = window.fixtureState = { messages: [], pending: null, username: '', saved: null };
// Fixture-only access: real extension scripts run in an isolated world and keep
// the save controls in a closed root. Retain the test handle for trusted clicks.
const attachShadow = Element.prototype.attachShadow;
Element.prototype.attachShadow = function (options) {
  const root = attachShadow.call(this, options);
  if (this.id === 'yurrr-save-banner') state.saveBannerRoot = root;
  if (this.id === 'yurrr-overlay-host') state.overlayRoot = root;
  return root;
};
const user = '<label>Email <input name="email" type="email" autocomplete="username" required></label>';
const password = '<label>Password <input name="password" type="password" required></label>';
if (scenario.startsWith('landed')) state.pending = JSON.parse(sessionStorage.getItem('yurrr-fixture-pending') || 'null');
else sessionStorage.removeItem('yurrr-fixture-pending');

window.chrome = {
  runtime: {
    onMessage: { addListener() {} },
    sendMessage({ type, payload = {} }, callback) {
      state.messages.push({ type, payload });
      let response = {};
      if (type === 'GENERATE_PASSWORD') response = { password: 'synthetic-generated' };
      if (type === 'PENDING_USERNAME') state.username = payload.username;
      if (type === 'GET_PENDING_USERNAME') response = { username: state.username };
      if (type === 'PENDING_CREDENTIALS') {
        state.pending = { ...payload, username: payload.username || state.username, expiresAt: Date.now() + 300000 };
        if (scenario === 'choose-account') {
          state.pending.action = 'choose_account';
          state.pending.accounts = [{ id: 'alice', username: 'alice' }, { id: 'bob', username: 'bob' }];
        }
        sessionStorage.setItem('yurrr-fixture-pending', JSON.stringify(state.pending));
        response = { stored: true };
      }
      if (type === 'MARK_PENDING_CREDENTIALS_READY' && state.pending?.submissionId === payload.submissionId) {
        state.pending.promptReady = true;
        sessionStorage.setItem('yurrr-fixture-pending', JSON.stringify(state.pending));
        response = { ready: true };
      }
      if (type === 'CHECK_PENDING_CREDENTIALS') response = {
        hasPending: Boolean(state.pending && (payload.manual || state.pending.promptReady || state.pending.pageUrl !== location.href)),
        available: Boolean(state.pending && !state.pending.promptReady && !payload.manual),
        submissionId: state.pending?.submissionId,
        expiresAt: state.pending?.expiresAt,
        credentials: state.pending,
      };
      if (type === 'CLEAR_PENDING_CREDENTIALS' && state.pending?.submissionId === payload.submissionId) state.pending = null;
      if (type === 'FORM_SUBMITTED') { state.saved = payload; response = { saved: true }; }
      callback?.(response);
      return Promise.resolve(response);
    },
  },
};

const button = '<button type="submit">Sign in</button>';
if (scenario === 'landed') {
  document.getElementById('result').textContent = 'Signed in';
} else if (scenario === 'formless') {
  fixture.innerHTML = `<section>${user}${password}<button type="button">Anmelden</button></section>`;
} else if (scenario === 'associated') {
  fixture.innerHTML = `<form id="login">${user}</form><label>Password <input form="login" name="password" type="password" required></label><button type="submit" form="login">Sign in</button>`;
} else if (scenario === 'password-change') {
  fixture.innerHTML = '<form><label>Old password <input type="password" name="old_password" required></label><label>New password <input type="password" name="new_password" required></label><label>Confirm password <input type="password" name="confirm_password" required></label><button type="submit">Save password</button></form>';
} else if (scenario === 'signup') {
  fixture.innerHTML = `<form>${user}<label>Password <input type="password" autocomplete="new-password" required></label><label>Confirm password <input type="password" autocomplete="new-password" required></label><button type="submit">Register</button></form>`;
} else if (scenario === 'multi-step') {
  fixture.innerHTML = `<form>${user}<button type="button" id="next">Weiter</button></form>`;
  document.getElementById('next').addEventListener('click', () => {
    fixture.innerHTML = `<form>${password}${button}</form>`;
    bindSubmit();
  });
} else {
  const action = scenario === 'reset-click' ? '<button type="button">Reset password</button>'
    : scenario === 'click' ? '<button type="button">Sign in</button>' : button;
  fixture.innerHTML = `<form>${user}${password}${action}</form>`;
}
if (scenario === 'contents-failed') fixture.querySelector('form').style.display = 'contents';
if (scenario === 'dynamic-type') {
  const input = fixture.querySelector('input[type="password"]');
  input.type = 'text';
  const activate = document.createElement('button');
  activate.textContent = 'Enable password';
  activate.addEventListener('click', () => { input.type = 'password'; });
  fixture.append(activate);
}
if (scenario === 'replacement') {
  const replace = document.createElement('button');
  replace.textContent = 'Replace fields';
  replace.addEventListener('click', () => {
    const input = fixture.querySelector('input[type="password"]');
    input.replaceWith(input.cloneNode(true));
  });
  fixture.append(replace);
}
if (scenario === 'reveal') {
  const reveal = document.createElement('button');
  reveal.textContent = 'Show password';
  reveal.addEventListener('click', () => { fixture.querySelector('input[type="password"]').type = 'text'; });
  fixture.append(reveal);
}
function finish(event) {
  event.preventDefault();
  if (['manual', 'choose-account'].includes(scenario)) { document.getElementById('result').textContent = 'Signed in'; return; }
  if (scenario === 'failed' || scenario === 'contents-failed') { document.getElementById('result').textContent = 'Invalid password'; return; }
  if (scenario === 'navigation') { location.href = '?scenario=landed'; return; }
  if (scenario === 'navigation-with-form') { location.href = '?scenario=landed-with-form'; return; }
  if (scenario === 'transient') {
    fixture.hidden = true;
    setTimeout(() => { fixture.hidden = false; }, 300);
    return;
  }
  const complete = () => {
    fixture.querySelectorAll('input').forEach((input) => { input.value = ''; });
    fixture.replaceChildren();
    document.getElementById('result').textContent = 'Signed in';
  };
  if (scenario === 'slow') setTimeout(complete, 6000);
  else complete();
}
function bindSubmit() {
  fixture.querySelector('form')?.addEventListener('submit', finish);
}
bindSubmit();
if (['click', 'formless', 'reset-click'].includes(scenario)) fixture.querySelector('button').addEventListener('click', finish);

if (['shadow', 'nested-shadow', 'dynamic-shadow', 'shadow-formless', 'shadow-replacement'].includes(scenario)) {
  const makeShadow = () => {
    const host = document.createElement('section');
    fixture.replaceChildren(host);
    let root = host.attachShadow({ mode: 'open' });
    if (scenario === 'nested-shadow') {
      const inner = document.createElement('div');
      root.append(inner);
      root = inner.attachShadow({ mode: 'open' });
    }
    const render = () => {
      root.innerHTML = scenario === 'shadow-formless'
        ? `${user}${password}<button type="button">Sign in</button>`
        : `<form>${user}${password}${button}</form>`;
      (root.querySelector('form') || root.querySelector('button')).addEventListener(scenario === 'shadow-formless' ? 'click' : 'submit', (event) => {
        event.preventDefault();
        root.replaceChildren();
      });
    };
    render();
    if (scenario === 'shadow-replacement') {
      const replace = document.createElement('button');
      replace.textContent = 'Replace shadow fields';
      replace.addEventListener('click', render);
      fixture.append(replace);
    }
  };
  if (scenario === 'dynamic-shadow') {
    fixture.innerHTML = '<button id="attach-shadow">Open login</button>';
    fixture.querySelector('button').addEventListener('click', makeShadow);
  } else makeShadow();
}
