import { whoAmI } from './api.js';
import { loadSettings, normalizeApiBase, saveSettings } from './config.js';

/**
 * Where the token is pasted, and where it is proved to work.
 *
 * Saving the settings and then calling `/auth/me` is the point of this page.
 * A token that is wrong, revoked or pasted with a stray character is otherwise
 * indistinguishable from a working one until the first save fails -- at the
 * moment the user least wants to debug anything.
 */

const el = (id) => document.getElementById(id);

function show(message, kind = '') {
  const status = el('status');
  status.textContent = message;
  status.className = `status ${kind}`;
}

async function connect(event) {
  event.preventDefault();

  const apiBase = normalizeApiBase(el('api-base').value);
  const token = el('token').value.trim();

  if (!apiBase || !token) {
    show('Both fields are needed.', 'error');
    return;
  }

  // Written before the check, deliberately: `whoAmI` reads what is stored, and
  // a token that turns out to be wrong is left in place so the user can see and
  // correct it rather than retyping the whole thing.
  await saveSettings({ apiBase, token });
  show('Checking…');

  try {
    const { user } = await whoAmI();
    show(`Connected as ${user.email}.`, 'ok');
  } catch (error) {
    show(`${error.message} Nothing will be saved until this is fixed.`, 'error');
  }
}

async function start() {
  const settings = await loadSettings();

  el('api-base').value = settings.apiBase;
  el('token').value = settings.token;

  el('settings').addEventListener('submit', connect);

  if (settings.token) {
    try {
      const { user } = await whoAmI();
      show(`Connected as ${user.email}.`, 'ok');
    } catch (error) {
      show(error.message, 'error');
    }
  }
}

start();
