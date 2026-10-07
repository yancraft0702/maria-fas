/**
 * Confere, no servidor REAL, quais endpoints privados continuam exigindo
 * sessao. Sem cookie, um endpoint privado tem que responder 401 (nunca 200).
 */
const BASE = process.env.BASE || 'http://127.0.0.1:3000';

// Endpoints que devem exigir sessao.
const PRIVADOS = [
  ['GET', '/api/feed/for-you'],
  ['GET', '/api/feed/following'],
  ['GET', '/api/feed/friends'],
  ['GET', '/api/explore'],
  ['GET', '/api/search?q=ana'],
  ['GET', '/api/notifications'],
  ['GET', '/api/conversations'],
  ['GET', '/api/search/quick?q=a'],
  ['GET', '/api/me/blocks'],
  ['GET', '/api/admin/overview'],
  ['GET', '/api/live/discover'],
  ['POST', '/api/posts'],
  ['POST', '/api/users/me/avatar'],
  ['POST', '/api/users/me/cover'],
  ['POST', '/api/live'],
  ['POST', '/api/chat/global'],
  ['POST', '/api/push/subscribe'],
];

// Endpoints publicos (precisam continuar abrindo sem sessao).
const PUBLICOS = [
  ['GET', '/api/health'],
  ['GET', '/api/app/config'],
  ['POST', '/api/auth/register'],
  ['POST', '/api/auth/login'],
  ['POST', '/api/auth/forgot-password'],
  ['GET', '/api/giphy/status'],
];

let falhas = 0;

const call = async (method, path, body) => {
  const res = await fetch(BASE + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  let payload = null;
  try { payload = await res.json(); } catch { /* sem corpo */ }
  return { status: res.status, code: payload?.error?.code || null };
};

console.log('Endpoints privados SEM sessao (esperado 401):');
for (const [method, path] of PRIVADOS) {
  const { status, code } = await call(method, path, method === 'GET' ? undefined : {});
  const ok = status === 401;
  if (!ok) falhas += 1;
  console.log(`  [${ok ? 'OK   ' : 'FALHA'}] ${method} ${path} -> ${status} ${code || ''}`);
}

console.log('\nEndpoints publicos SEM sessao (nao podem exigir login):');
for (const [method, path] of PUBLICOS) {
  const { status, code } = await call(method, path, method === 'GET' ? undefined : {});
  // Sem corpo, o backend responde 422 (validacao): o que importa aqui e
  // NAO ser 401 de sessao - ou seja, a rota continua publica.
  const esperado = method === 'POST' ? 422 : 200;
  const ok = status === esperado;
  if (!ok) falhas += 1;
  console.log(`  [${ok ? 'OK   ' : 'FALHA'}] ${method} ${path} -> ${status} (esperado ${esperado}) ${code || ''}`);
}

console.log(falhas ? `\n${falhas} problema(s)` : '\nBackend: todas as areas privadas exigem sessao');
process.exit(falhas ? 1 : 0);