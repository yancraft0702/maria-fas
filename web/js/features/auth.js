/**
 * Autenticacao no cliente: cadastro, login, 2FA, sessao e perfil basico.
 * A senha nunca e guardada no cliente.
 */
import { api, ApiError } from '../core/api.js';
import { el, icon, brandHeart } from '../core/dom.js';
import { toastSuccess, toastError, toast } from '../core/ui.js';
import { setUser, store, bootstrapSession, refreshCounts } from '../core/store.js';

export async function register({ email, username, password, displayName }) {
  const result = await api.post('/api/auth/register', { email, username, password, displayName });
  if (result.csrfToken) window.__PULSE_CSRF__ = result.csrfToken;
  setUser(result.user);
  await refreshCounts();
  return result.user;
}

/**
 * Login por USUARIO (com ou sem @) ou por email.
 * A tela de entrada pede so usuario e senha; o backend escolhe a coluna.
 */
export async function login({ identifier, password, totpCode = null, backupCode = null }) {
  const result = await api.post('/api/auth/login', { identifier, password, totpCode, backupCode });
  if (result.csrfToken) window.__PULSE_CSRF__ = result.csrfToken;
  setUser(result.user);
  await refreshCounts();
  return result.user;
}

export async function logout() {
  try {
    await api.post('/api/auth/logout', {});
  } finally {
    setUser(null);
  }
}

export async function requestPasswordReset(identifier) {
  return api.post('/api/auth/forgot-password', { identifier });
}

export async function resetPassword(token, password) {
  return api.post('/api/auth/reset-password', { token, password });
}

export async function changePassword(currentPassword, newPassword) {
  return api.post('/api/auth/change-password', { currentPassword, newPassword });
}

export async function changeUsername(username) {
  const result = await api.post('/api/auth/username', { username });
  setUser(result.user);
  return result.user;
}

export async function updateProfile(changes) {
  const result = await api.patch('/api/users/me', changes);
  setUser(result.user);
  return result.user;
}

export async function uploadAvatar(file, onProgress) {
  const { promise } = api.upload('/api/users/me/avatar', { file, onProgress });
  const result = await promise;
  setUser(result.user);
  return result.user;
}

export async function uploadCover(file, onProgress) {
  const { promise } = api.upload('/api/users/me/cover', { file, onProgress });
  const result = await promise;
  setUser(result.user);
  return result.user;
}

export async function deleteAccount(password) {
  const result = await api.post('/api/users/me/delete', { password });
  setUser(null);
  return result;
}

// --------------------------------------------------------------------------
// 2FA
// --------------------------------------------------------------------------
export const setupTotp = () => api.post('/api/auth/2fa/setup', {});
export const activateTotp = (code) => api.post('/api/auth/2fa/activate', { code });
export const disableTotp = (code) => api.post('/api/auth/2fa/disable', { code });
export const regenerateRecoveryCodes = (code) => api.post('/api/auth/2fa/regenerate-codes', { code });

// --------------------------------------------------------------------------
// Telas
// --------------------------------------------------------------------------
function field(labelText, inputEl, hint) {
  return el('div', { class: 'field' }, [
    el('label', { for: inputEl.id, text: labelText }),
    inputEl,
    hint ? el('div', { class: 'tiny faint', text: hint }) : null,
  ]);
}

/**
 * Logo da marca: CORACAO animado (item 15).
 *
 * SVG puro (sem imagem externa, sem fonte de icone): entrada suave + pulso
 * continuo discreto. A animacao e feita em CSS com `transform`/`opacity`
 * (composta pela GPU) e respeita `prefers-reduced-motion`.
 */
function brandLogo() {
  const wrap = el('div', { class: 'brand-logo', 'aria-label': 'MARIA FÃS' });
  // Mesmo coracao do header/sidebar (definicao unica em core/dom.js).
  wrap.innerHTML = `${brandHeart({ className: 'brand-heart' })}
    <span class="brand-wordmark">MARIA FÃS</span>`;
  return wrap;
}

/**
 * Mensagem de erro que o usuario realmente precisa ver (item 5).
 *
 * A API traz `details.fields[]` com o motivo por campo. Se houver erro de
 * campo, mostramos esse texto; caso contrario, a mensagem do erro. Nunca
 * devolvemos um "Dados invalidos" sem explicar o motivo.
 */
function erroDeCampo(err) {
  const campos = err?.details?.fields;
  if (Array.isArray(campos) && campos.length) {
    const texto = campos.map((c) => c.message).filter(Boolean).join(' ');
    if (texto) return texto;
  }
  return err?.message || 'Nao foi possivel concluir.';
}

/** Brilho decorativo das telas de autenticacao (fundo escuro + halos). */
function authArt() {
  return el('div', { class: 'auth-page-art', 'aria-hidden': 'true' });
}

/** Frase curta abaixo da marca. */
function subtitleLine() {
  return el('p', { class: 'auth-subtitle', text: 'Videos, chat e LIVE em um so lugar' });
}

export function loginScreen({ onDone, initialTab = 'login' }) {
  const container = el('div', { class: 'auth-wrap' });
  const card = el('div', { class: 'auth-card' });

  let mode = initialTab; // login | register | forgot

  const errorBox = el('div', { class: 'auth-error', hidden: true, role: 'alert' });
  const form = el('form', { class: 'card', novalidate: true });
  const tabs = el('div', { class: 'seg mb' });
  const title = el('div', { class: 'auth-tag' });
  const submitBtn = el('button', { type: 'submit', class: 'btn btn-primary btn-block', text: 'Entrar' });

  const showError = (message) => {
    errorBox.hidden = !message;
    errorBox.textContent = message || '';
  };

  const renderTabs = () => {
    tabs.replaceChildren();
    for (const [id, label] of [['login', 'Entrar'], ['register', 'Criar conta']]) {
      tabs.append(el('button', {
        type: 'button', text: label, 'aria-selected': String(mode === id),
        // Item 8: sem esta chamada o "aria-selected" ficava congelado no modo
        // inicial - clicar em "Criar conta" trocava o formulario mas deixava
        // "Entrar" marcado (e vice-versa). Redesenhando as duas abas, nunca
        // ficam as duas selecionadas ao mesmo tempo.
        onClick: () => {
          if (mode === id) return;
          mode = id;
          showError('');
          renderTabs();
          render();
        },
      }));
    }
  };

  const buildLogin = () => {
    title.textContent = 'Bem-vindo de volta ao MARIA FÃS';
    // Entrada simples: USUARIO + SENHA. O email continua existindo no
    // servidor (recuperacao de senha), mas nao e digitado pelo usuario.
    const identifier = el('input', {
      class: 'input', id: 'login-identifier', required: true,
      autocomplete: 'username', autocapitalize: 'none', spellcheck: 'false',
      placeholder: 'seu usuario', maxlength: '254',
    });
    const password = el('input', { class: 'input', type: 'password', id: 'login-password', autocomplete: 'current-password', required: true });
    const code = el('input', { class: 'input', id: 'login-2fa', placeholder: 'Codigo 2FA (6 digitos)', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: '6', pattern: '\\d{6}', hidden: true });
    const backup = el('input', { class: 'input', id: 'login-backup', placeholder: 'Codigo de recuperacao (ex.: A1B2C-3D4E5)', autocomplete: 'off', hidden: true });
    submitBtn.textContent = 'Entrar';

    code.addEventListener('input', () => { backup.hidden = true; });
    backup.addEventListener('input', () => { code.hidden = true; });

    form.replaceChildren(
      field('Usuario', identifier),
      field('Senha', password),
      field('Verificacao em duas etapas', code, 'Preencha apenas se sua conta usa 2FA'),
      field('Codigo de recuperacao', backup, 'Usado quando o aplicativo autenticador esta indisponivel'),
      submitBtn,
      el('div', { class: 'center mt' }, [
        el('button', {
          type: 'button', class: 'btn btn-sm btn-ghost', text: 'Esqueci minha senha',
          onClick: () => { mode = 'forgot'; renderTabs(); render(); },
        }),
      ]),
    );

    form.onsubmit = async (event) => {
      event.preventDefault();
      showError('');
      submitBtn.disabled = true;
      submitBtn.textContent = 'Entrando…';
      try {
        const payload = { identifier: identifier.value.trim(), password: password.value };
        if (!code.hidden && code.value.trim()) payload.totpCode = code.value.trim();
        if (!backup.hidden && backup.value.trim()) payload.backupCode = backup.value.trim();
        const user = await login(payload);
        toastSuccess(`Ola, ${user.displayName}!`);
        onDone?.(user);
      } catch (err) {
        if (err instanceof ApiError && err.code === 'totp_required') {
          code.hidden = false;
          backup.hidden = false;
          showError('Informe o codigo de verificacao em duas etapas.');
          code.focus();
        } else {
          showError(erroDeCampo(err));
        }
        submitBtn.textContent = 'Entrar';
      } finally {
        submitBtn.disabled = false;
      }
    };
    setTimeout(() => identifier.focus(), 60);
  };

  const buildRegister = () => {
    title.textContent = 'Crie sua conta no MARIA FÃS';
    const username = el('input', {
      class: 'input', id: 'reg-user', required: true,
      autocomplete: 'username', autocapitalize: 'none', spellcheck: 'false',
      placeholder: 'seu usuario', pattern: '[A-Za-z0-9._]{3,24}',
    });
    const password = el('input', { class: 'input', type: 'password', id: 'reg-pass', required: true, autocomplete: 'new-password', minlength: '8' });
    const confirm = el('input', { class: 'input', type: 'password', id: 'reg-pass2', required: true, autocomplete: 'new-password' });
    submitBtn.textContent = 'Criar conta';

    form.replaceChildren(
      field('Usuario', username, '3 a 24 caracteres: letras, numeros, ponto e underscore'),
      field('Senha', password, 'Minimo de 8 caracteres, combinando letras e numeros'),
      field('Confirmar senha', confirm),
      submitBtn,
    );

    form.onsubmit = async (event) => {
      event.preventDefault();
      showError('');
      if (password.value !== confirm.value) { showError('As senhas nao conferem.'); return; }
      submitBtn.disabled = true;
      submitBtn.textContent = 'Criando…';
      try {
        const user = await register({
          username: username.value.trim().replace(/^@/, ''),
          password: password.value,
          displayName: username.value.trim().replace(/^@/, ''),
        });
        toastSuccess('Conta criada. Bem-vindo ao MARIA FÃS!');
        onDone?.(user);
      } catch (err) {
        showError(erroDeCampo(err));
        submitBtn.textContent = 'Criar conta';
      } finally {
        submitBtn.disabled = false;
      }
    };
    setTimeout(() => username.focus(), 60);
  };

  const buildForgot = () => {
    title.textContent = 'Recuperar senha';
    const identifier = el('input', {
      class: 'input', id: 'forgot-identifier', required: true,
      autocapitalize: 'none', spellcheck: 'false', placeholder: 'seu usuario',
    });
    submitBtn.textContent = 'Enviar instrucoes';
    const aviso = el('p', { class: 'auth-note' });
    form.replaceChildren(
      field('Usuario da conta', identifier),
      submitBtn,
      aviso,
      el('div', { class: 'center mt' }, [
        el('button', {
          type: 'button', class: 'btn btn-sm btn-ghost', text: 'Voltar para o login',
          onClick: () => { mode = 'login'; renderTabs(); render(); },
        }),
      ]),
    );
    form.onsubmit = async (event) => {
      event.preventDefault();
      showError('');
      aviso.textContent = '';
      aviso.className = 'auth-note';
      submitBtn.disabled = true;
      try {
        const result = await requestPasswordReset(identifier.value.trim());
        // Item 6: o token NUNCA e mostrado na tela. A resposta apenas informa
        // se existe canal de entrega - sem prometer envio que nao acontece.
        aviso.textContent = result.message;
        aviso.classList.add(result.delivery === 'email' ? 'is-ok' : 'is-warn');
        if (result.delivery === 'email') toastSuccess(result.message);
        else toast('Recuperacao indisponivel no momento.', { type: 'warn' });
        identifier.value = '';
      } catch (err) {
        showError(err.message);
      } finally {
        submitBtn.disabled = false;
      }
    };
    setTimeout(() => identifier.focus(), 60);
  };

  const render = () => {
    if (mode === 'login') buildLogin();
    else if (mode === 'register') buildRegister();
    else buildForgot();
  };

  renderTabs();
  card.append(brandLogo(), subtitleLine(), title, errorBox, tabs, form);
  container.append(authArt(), card);
  // Desenha o formulario do modo inicial. Sem esta chamada o card abria
  // apenas com a logo e as abas, sem nenhum campo (login inutilizavel).
  render();

  return {
    element: container,
    setMode(next) { mode = next; renderTabs(); render(); },
    destroy() { container.replaceChildren(); container.remove(); },
  };
}

export function resetPasswordScreen({ token }) {
  const container = el('div', { class: 'auth-wrap' });
  const card = el('div', { class: 'auth-card' });
  const errorBox = el('div', { class: 'auth-error', hidden: true, role: 'alert' });
  const password = el('input', { class: 'input', type: 'password', autocomplete: 'new-password', required: true });
  const confirm = el('input', { class: 'input', type: 'password', autocomplete: 'new-password', required: true });
  const submit = el('button', { type: 'submit', class: 'btn btn-primary btn-block', text: 'Definir nova senha' });

  const form = el('form', { class: 'card', novalidate: true }, [
    errorBox,
    field('Nova senha', password, 'Minimo de 8 caracteres'),
    field('Confirmar nova senha', confirm),
    submit,
  ]);

  form.onsubmit = async (event) => {
    event.preventDefault();
    errorBox.hidden = true;
    if (password.value !== confirm.value) {
      errorBox.hidden = false;
      errorBox.textContent = 'As senhas nao conferem.';
      return;
    }
    submit.disabled = true;
    try {
      await resetPassword(token, password.value);
      toastSuccess('Senha alterada. Faca login.');
      location.href = '/';
    } catch (err) {
      toastError(err);
    } finally {
      submit.disabled = false;
    }
  };

  card.append(brandLogo(), el('div', { class: 'auth-tag', text: 'Definir nova senha' }), form);
  container.append(authArt(), card);
  return { element: container, destroy() { container.remove(); } };
}

/** Tela de setup do 2FA (QR visual em texto + otpauth, sem dependencia externa). */
export function twoFactorSetupPanel() {
  const wrap = el('div');
  wrap.append(el('p', { class: 'small muted', text: 'Adicione a chave abaixo no seu aplicativo autenticador e confirme o codigo gerado.' }));
  return wrap;
}

export { bootstrapSession, store, icon };
