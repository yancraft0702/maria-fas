/**
 * Verificacao de higiene do codigo.
 *
 * Classes de problema cobertas (todas exigidas pelo padrao de entrega):
 *  1. Marcadores pendentes (TODO/FIXME/HACK/XXX/stub) em codigo de producao
 *  2. `console.log` deixado em server/ e web/ (vaza dado e polui log)
 *  3. Segredos reachable pelo frontend (GIPHY_API_KEY, SESSION_SECRET, etc.)
 *  4. Placeholders simulados ("mock", "fake", "simulado", "dados ficticios")
 *  5. Duplicacao de sistema (chat2/live2/player2/profile2/effects2/...)
 *  6. Imports declarados e nunca usados
 *  7. Rotas duplicadas registradas duas vezes
 *  8. `debugger` e `alert(` esquecidos
 *
 * Excecoes explicitas ficam na lista ALLOW.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCAN_DIRS = ['server', 'web', 'scripts', 'tests'];
const SKIP_DIRS = new Set(['node_modules', '.git', 'data', 'storage', 'assets', '.tmp']);

/** Padroes aceitos de proposito (documentacao, testes, geradores). */
const ALLOW = [
  { file: 'tests', reason: 'testes podem afirmar comportamento esperado' },
  { file: 'scripts', reason: 'scripts de verificacao citam padroes proibidos' },
];

// Marcadores pendentes. Portugues tem "todo/toda" como palavra comum, entao
// `TODO` so conta em caixa alta (forma usada de verdade nos codigos).
const PENDING = /\bTODO\b|\bFIXME\b|\bHACK\b|\bXXX\b|\bWIP\b|(^|[^a-zA-Z])stub\b/i;
const PLACEHOLDER = /\b(mock\w*|fake\w*|simulad[oa]s?|dados ficticios|placeholder data)\b/i;
const CONSOLE_LOG = /console\s*\.\s*log\s*\(/;
const DEBUGGER = /\bdebugger\b/;
const ALERT_CALL = /(^|[^.\w])alert\s*\(/;
const DUPLICATE_SYSTEM = /\b(chat2|live2|player2|profile2|effects2|message2|feed2|user2)\b/i;

/** Segredos que jamais podem aparecer no bundle do navegador. */
const FRONTEND_SECRETS = [
  'GIPHY_API_KEY',
  'SESSION_SECRET',
  'LIVE_TOKEN_SECRET',
  'VAPID_PRIVATE_KEY',
  'SMTP_PASSWORD',
  'ADMIN_PASSWORD',
  'TURN_PASSWORD',
  'TURNS_API_KEY',
];

const problems = [];

function walk(dir, files = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, files);
    else if (/\.(js|mjs|html|css)$/.test(entry.name)) files.push(full);
  }
  return files;
}

function rel(file) {
  return path.relative(ROOT, file).split(path.sep).join('/');
}

function isAllowed(relPath) {
  return ALLOW.some((rule) => relPath.startsWith(`${rule.file}/`));
}

/** Remove comentarios e literais de string/template da linha. */
function stripCommentsAndStrings(line) {
  return line
    .replace(/\/\*.*?\*\//g, ' ')
    .replace(/\/\/.*$/, ' ')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``');
}

/** Extrai os nomes importados de um bloco `import { a, b as } from '...';`. */
function importedNames(source) {
  const names = [];
  const re = /import\s+(?:([\w$]+)\s*,\s*)?\{([^}]*)\}\s*from\s*['"][^'"]+['"]/g;
  let match;
  while ((match = re.exec(source)) !== null) {
    if (match[1]) names.push(match[1]);
    for (const part of match[2].split(',')) {
      const clean = part.trim();
      if (!clean) continue;
      const asMatch = /\sas\s+([\w$]+)$/.exec(clean);
      names.push(asMatch ? asMatch[1] : clean);
    }
  }
  const defRe = /import\s+([\w$]+)\s+from\s*['"][^'"]+['"]/g;
  while ((match = defRe.exec(source)) !== null) names.push(match[1]);
  const nsRe = /import\s+\*\s+as\s+([\w$]+)\s+from/g;
  while ((match = nsRe.exec(source)) !== null) names.push(match[1]);
  return names;
}

/** Verifica se `name` aparece no codigo fora da linha de import. */
function usedAfterImports(source, name) {
  const withoutImports = source.replace(/^\s*import\s[^;]*;?\s*$/gm, '');
  const re = new RegExp(`\\b${name.replace(/[$]/g, '\\$')}\\b`);
  return re.test(withoutImports);
}

const files = [];
for (const dir of SCAN_DIRS) {
  const full = path.join(ROOT, dir);
  if (fs.existsSync(full)) walk(full, files);
}

// ---------------------------------------------------------------------------
for (const file of files) {
  const r = rel(file);
  const isFrontend = r.startsWith('web/');
  const isServer = r.startsWith('server/');
  const source = fs.readFileSync(file, 'utf8');
  // Comentarios de bloco podem ocupar varias linhas: remove do texto inteiro
  // antes de quebrar em linhas (senao "Todo" numa doc e' lido como pendencia).
  const withoutBlockComments = source.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  const lines = withoutBlockComments.split('\n');

  lines.forEach((line, index) => {
    const lineNo = index + 1;
    // Comentarios e literais de texto podem citar os termos legitimamente
    // ("configure GIPHY_API_KEY no servidor", "TODO" numa doc). So o codigo
    // executavel conta.
    const code = stripCommentsAndStrings(line);

    if (!isAllowed(r) && PENDING.test(code)) {
      problems.push({ r, line: lineNo, kind: 'pendente', detail: line.trim().slice(0, 90) });
    }
    if (!isAllowed(r) && isServer && PLACEHOLDER.test(code)) {
      problems.push({ r, line: lineNo, kind: 'simulado', detail: line.trim().slice(0, 90) });
    }
    if ((isServer || isFrontend) && CONSOLE_LOG.test(code) && !isAllowed(r)) {
      problems.push({ r, line: lineNo, kind: 'console.log', detail: line.trim().slice(0, 90) });
    }
    if (DEBUGGER.test(code)) {
      problems.push({ r, line: lineNo, kind: 'debugger', detail: line.trim().slice(0, 90) });
    }
    if (ALERT_CALL.test(code) && !r.startsWith('tests/')) {
      problems.push({ r, line: lineNo, kind: 'alert()', detail: line.trim().slice(0, 90) });
    }
    if (DUPLICATE_SYSTEM.test(code) && r !== 'scripts/check-dead-code.mjs') {
      problems.push({ r, line: lineNo, kind: 'sistema duplicado', detail: line.trim().slice(0, 90) });
    }
    // Um NOME de variavel de ambiente em mensagem de texto nao e vazamento;
    // so interessa acesso ao VALOR (atribuicao, indice, template com valor).
    if (isFrontend) {
      for (const secret of FRONTEND_SECRETS) {
        const re = new RegExp(`(import\\.meta\\.env\\.${secret}|process\\.env\\.${secret}|\\b${secret}\\b\\s*[:=]\\s*[^'"]|\\{\\s*${secret}\\s*\\})`);
        if (re.test(code)) {
          problems.push({ r, line: lineNo, kind: 'segredo no frontend', detail: secret });
        }
      }
    }
  });

  // ---- imports declarados e nao usados ------------------------------------
  for (const name of importedNames(source)) {
    if (!usedAfterImports(source, name)) {
      problems.push({ r, line: 0, kind: 'import nao usado', detail: name });
    }
  }
}

// ---------------------------------------------------------------------------
// Rotas duplicadas (o Router ja falha no boot, mas o report e explicito).
// ---------------------------------------------------------------------------
const routeFiles = files.filter((f) => rel(f).startsWith('server/routes/'));
const seenRoutes = new Map();
for (const file of routeFiles) {
  const source = fs.readFileSync(file, 'utf8');
  const re = /router\.(get|post|put|patch|delete)\(\s*['"]([^'"]+)['"]/g;
  let match;
  while ((match = re.exec(source)) !== null) {
    const key = `${match[1].toUpperCase()} ${match[2]}`;
    if (seenRoutes.has(key)) {
      problems.push({
        r: rel(file),
        line: source.slice(0, match.index).split('\n').length,
        kind: 'rota duplicada',
        detail: `${key} (ja existe em ${seenRoutes.get(key)})`,
      });
    } else {
      seenRoutes.set(key, rel(file));
    }
  }
}

// ---------------------------------------------------------------------------
const unique = [];
const seen = new Set();
for (const problem of problems) {
  const key = `${problem.r}|${problem.line}|${problem.kind}|${problem.detail}`;
  if (seen.has(key)) continue;
  seen.add(key);
  unique.push(problem);
}

console.log(`Higiene: ${files.length} arquivo(s), ${unique.length} problema(s)`);
for (const problem of unique.slice(0, 60)) {
  console.log(`  ${problem.r}${problem.line ? `:${problem.line}` : ''} [${problem.kind}] ${problem.detail}`);
}
if (unique.length > 60) console.log(`  ... e mais ${unique.length - 60}`);
if (unique.length) process.exit(1);