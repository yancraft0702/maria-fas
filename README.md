# MARIA FÃS

Plataforma completa de vídeos curtos, rede social, chat e LIVE — frontend,
backend, banco, storage, realtime, autenticação, mídia, LIVE e administração
integrados e testados.

```
Frontend (PWA)  ──HTTP/JSON──▶  Backend Node  ──▶  SQLite (WAL)
      │                             │  ├─ ffmpeg (transcode/HLS/thumbnails)
      └──WebSocket /ws──────────────┘  └─ storage em disco (buckets)
```

---

## 1. Requisitos

| Item | Versão | Observação |
|---|---|---|
| Node.js | ≥ 22.5 (testado em 24.21) | usa o `node:sqlite` embutido |
| ffmpeg | qualquer 6.x | opcional: `npm i` já traz `ffmpeg-static` |
| Chrome/Chromium | qualquer versão recente | apenas para `npm run test:browser` |

Sem dependência de serviço externo: banco, storage e transcodificação são locais.

---

## 2. Instalação

```bash
npm install
cp .env.example .env      # ajuste os segredos
npm run keys              # gera SESSION_SECRET, LIVE_TOKEN_SECRET e o par VAPID
npm run bootstrap         # aplica as migrações
npm start
```

Aplicação em **http://localhost:3000** (porta definida em `.env`).

### 2.1 Administrador

O admin **nunca** é criado pelo código. Use variáveis de ambiente:

```bash
ADMIN_EMAIL=admin@exemplo.com \
ADMIN_USERNAME=adminpulse \
ADMIN_PASSWORD=<mínimo 12 caracteres> \
npm run seed
```

Sem essas variáveis o seed não cria ninguém e `/api/admin/*` responde 403.
O seed de demonstração (`npm run seed -- --demo`) é apenas para desenvolvimento:
exige `DEMO_PASSWORD` com pelo menos 12 caracteres e é bloqueado em produção.

### 2.2 Opcionais (honestidade em vez de simulação)

| Variável | Sem ela |
|---|---|
| `TURN_URL` ou `TURN_URLS`, `TURN_USERNAME`, `TURN_CREDENTIAL` | LIVE usa só STUN; a API responde `turn.configured=false` com aviso |
| `GIPHY_API_KEY` | endpoints de GIF respondem **503 `gif_provider_not_configured`** |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | push responde **503 `push_not_configured`** |
| `FFMPEG_PATH` | usa o binário embutido; `FFMPEG_PATH=none` desliga o processamento |

Nenhuma credencial é inventada e nenhum serviço faltante é mascarado.

---

## 3. Scripts

| Comando | O que faz |
|---|---|
| `npm start` | sobe o servidor |
| `npm run dev` | sobe com `--watch` |
| `npm run bootstrap` | aplica migrações |
| `npm run seed` | cria o admin a partir de `ADMIN_*` |
| `npm run keys` | gera segredos e chaves VAPID |
| `npm run icons` | regera os ícones do PWA |
| `npm run check` | **6 verificações estáticas** (sintaxe, imports, exports, params, sql-params, higiene) |
| `npm test` | todas as suítes (inclui navegador) |
| `npm run test:fast` | tudo **menos** o navegador |
| `npm run test:api` / `:security` / `:realtime` / `:live` / `:media` / `:admin` / `:browser` | suíte individual |

---

## 4. Arquitetura

```
server/
  main.js          bootstrap: migrações → efeitos → rotas → HTTP → WS
  config.js        configuração (env) — nenhuma credencial no código
  http.js          pipeline de requisição, multipart, gzip, estáticos, CSP
  router.js        roteador com prioridade literal > parâmetro
  middleware.js    rate limit, CSRF, sessão, roles, mute, auditoria
  db/
    index.js       prepared statements; bind por NOME quando a SQL usa :nome
    migrations/    0001_init.sql (esquema completo), 0002_mute_window.sql
    cli-*.js       migrate / seed / bootstrap
  domain/          regras de negócio (fonte da verdade)
  routes/          180 rotas REST
  realtime/        hub WebSocket único + handlers de publicação
  media/           upload, transcodificação, HLS, alpha de efeitos
  storage/         buckets em disco, path traversal bloqueado
  push/  lib/  static.js

web/
  index.html       shell da PWA
  sw.js            service worker (precache, mídia, push, deep link)
  manifest.webmanifest
  css/app.css
  js/core/         api, realtime, store, router, dom, ui, media, sounds
  js/features/     auth, feed, comments, live, live-viewer, webrtc,
                   live-effects, editor, profile, search, messaging, inbox,
                   chat global, youtube, emoji, gifs, voice, admin, …

tests/             7 suítes de integração (servidor real + Chrome real)
scripts/           verificações estáticas e utilitários
```

### Decisões que valem registro

- **Bind de parâmetros por nome.** `node:sqlite` liga `:nome` por *nome* (objeto),
  não por posição. `server/db/index.js` detecta a forma usada na SQL e entrega o
  que o driver espera. Isso eliminou uma família inteira de bugs de ordem.
- **Roteador com especificidade.** `/api/live/effects` é literal e vence
  `/api/live/:id`; sem isso o recurso virava "LIVE não encontrada".
- **Realtime pela mesma cookie da API.** O handshake do WebSocket autentica com
  a cookie HttpOnly — o JavaScript não (e não deve) ler o token de sessão.
- **Mute ≠ suspensão.** `users.muted_until` guarda a janela (2/4/6/10 min) e
  bloqueia escrita; `status` continua significando active/suspended/banned.
- **Alfa dos efeitos é verificado, não presumido.** O ffmpeg embutido não grava o
  plano alpha; `verifyAlphaChannel()` detecta isso e a API expõe
  `alphaReady:false` + parâmetros de `chromaKey` para remoção de fundo na GPU.
- **Os efeitos vêm do projeto, não de caminho fixo.** Os `.mp4` ficam em
  `animação/` na raiz do repositório (ou em `EFFECTS_SOURCE_DIR`), e o boot
  só libera a rota quando existe arquivo processado de verdade.

---

## 5. Recursos

**Vídeo e feed** — upload real, múltiplas resoluções, HLS adaptativo, poster,
storyboard, Range/206, download sob permissão, feed vertical com preload e
descarregamento, "não tenho interesse", ocultar criador, bloquear, denunciar.

**Rede social** — seguir, amigos, block, stories, drafts, hashtags, sons,
busca unificada, notificações, recomendações.

**Chat** — DM com recibos de leitura, idempotência por `clientEventId`, áudio,
imagem, chat global com presença ao vivo.

**LIVE** — WebRTC real (`getUserMedia` → `RTCPeerConnection` → `ontrack`),
sinalização pelo hub,-effects com `event_id`/`sequence`/idempotência, corações
ilimitados e independentes da cota de efeitos, 10 efeitos/dia (admin
ilimitado), moderação com janelas fixas, contador que exclui o host.

**PWA** — manifest, service worker, ícones, instalável, deep links, push,
sem rolagem horizontal de 320 px a 1920 px.

**YouTube** — apenas o player oficial (IFrame API), mini-player arrastável
(mouse e toque), 16:9, sem moldura/cartão/alça visível, fling para cima fecha.

---

## 6. Testes

217 verificações em 7 suítes, todas contra servidor, banco e storage reais.

| Suíte | Verificações | Foco |
|---|---|---|
| `api-flow` | 58 | fluxo completo ponta a ponta |
| `security` | 31 | CSRF, IDOR, path traversal, rate limit, escalate de privilégio, vazamento |
| `realtime` | 17 | WebSocket, fanout, idempotência, reconexão |
| `live` | 24 | sala, chat, corações, efeitos, cota, moderação, sinalização |
| `media` | 22 | ffmpeg, HLS, Range, magic bytes, storage, degradação |
| `admin` | 19 | admin por semente, moderação, ban, push |
| `browser` | 46 | Chrome headless: PWA, feed, busca, entrada, LIVE, áudio, emoji, YouTube, WebRTC real |

Cada suíte sobe seu próprio servidor em porta efêmera com banco temporário —
nenhuma depende da instância em execução.

Verificações pontuais de interface (também abrem Chrome real):

| Script | O que confere |
|---|---|
| `node scripts/verify-produto.mjs` | **28 checks em desktop E mobile**: guarda de login, redirect pós-login, coração da marca, mute com estado real do `<video>`, busca compacta, publicar no PC, editor no celular, troca de abas do feed, hierarquia do perfil, foto/capa, notificações, chat, LIVE com MediaStream, GIPHY, push, bottom nav |
| `node scripts/measure-layout.mjs` | 99 combinações (11 telas × 9 larguras): overflow, elemento fora da tela, sobreposição e conteúdo sob a bottom nav |
| `node scripts/measure-chat.mjs` | chat em 7 larguras: mensagens visíveis e campo de mensagem acima da bottom nav |
| `node scripts/verify-ui.mjs` | busca compacta, 5 ícones removidos, troca de abas do feed, aviso de push, tela de entrada, paleta, responsividade |
| `node scripts/verify-live-profile.mjs` | botão INICIAR LIVE + transmissão real (MediaStream), edição de foto e capa com upload e persistência |
| `node scripts/check-auth-guard.mjs` | 17 endpoints privados exigem sessão; 6 públicos continuam abertos |
| `node scripts/check-effects-source.mjs` | efeitos da LIVE vêm de `animação/` e nenhuma referência ao caminho antigo sobrou |

---

## 7. Limitações conhecidas do ambiente

Declaradas, não escondidas:

1. **Sem TURN** — sem credenciais, a LIVE usa só STUN. Vale na rede local; em NAT
   restritivo o handshake pode não atravessar. Configure `TURN_*` para produção.
2. **Alfa dos efeitos** — o build do ffmpeg embutido não grava o plano alpha de
   VP9. A API reporta `alphaReady:false` e o cliente aplica chroma-key na GPU
   (WebGL) sobre o mesmo arquivo real. Não é simulação: a remoção de fundo é
   computada por frame.
3. **GIPHY** — configurado no `.env` (chave nunca versionada, nunca vai para o
   navegador). Busca de GIF e de sticker devolvem resultados reais; os erros da
   API continuam sendo propagados, sem resposta vazia silenciosa.
4. **Push** — sem par VAPID, respondem 503. Com par VAPID, a entrega depende do
   provedor externo (não exercitável aqui).

---

## 8. Segurança

- Senha: `scrypt` + comparação *timing-safe*.
- Sessão: token em cookie HttpOnly; o banco guarda apenas o SHA-256.
- CSRF: double-submit com token por sessão.
- 2FA: TOTP + 10 códigos de recuperação.
- Permissões: **o backend é sempre a autoridade**. `userId`, `role` e `isAdmin`
  enviados pelo cliente são ignorados.
- CSP sem `unsafe-inline`/`unsafe-eval` em `script-src`; única origem externa é
  a IFrame API do YouTube.
- Erros preservam status e `code` estáveis (401/403/404/409/413/429/500/503).

---

## 9. GitHub e deploy

O repositório inclui `render.yaml` para publicar a aplicação completa como um
serviço Node no Render. A aplicação **não pode ser publicada completa apenas
na Vercel**: ela mantém conexões WebSocket, usa SQLite e grava uploads em disco.
Functions serverless e filesystem efêmero não atendem esses requisitos. O PWA
e a API são servidos pela mesma origem, então não é necessário separar o
frontend.

### Preparar o GitHub

1. Crie um repositório no GitHub.
2. Na pasta do projeto, confira que `.env`, `data/`, `storage/` e `.certs/` não
   serão enviados. O `.gitignore` já os exclui, assim como os temporários.
3. Envie o código e os arquivos de `animação/` (fontes dos efeitos da LIVE).
   Não envie `node_modules/`; o Render instala as dependências com `npm ci`.

### Publicar no Render

1. No Render, crie um **Blueprint** conectado ao repositório; ele detectará o
   `render.yaml`.
2. Quando solicitado, informe `PUBLIC_URL` com a URL HTTPS pública do serviço
   (por exemplo, `https://nome-do-servico.onrender.com`).
3. O blueprint cria um serviço Node com disco persistente de 10 GB, armazena
   nele o banco e os uploads, gera `SESSION_SECRET` e `LIVE_TOKEN_SECRET` e
   configura `/api/health` como health check.
4. Depois do deploy, acesse a URL HTTPS para verificar o PWA. Configure o admin
   pelo painel do Render (`ADMIN_EMAIL`, `ADMIN_USERNAME` e `ADMIN_PASSWORD`)
   e execute `npm run seed` no shell do serviço para criar a conta.

O disco persistente requer um plano pago e o SQLite deve permanecer em uma
única instância; não escale horizontalmente este serviço. O TURN é opcional,
mas é recomendado para que as LIVE atravessem redes móveis e NATs restritivos.
Backups do disco devem ser configurados separadamente.

### Configurar TURN

No painel do Render, configure as variáveis do serviço sem incluí-las no
frontend:

- `TURN_URLS`: uma ou mais URLs, separadas por vírgula, por exemplo
  `turn:turn.example.com:3478?transport=udp,turns:turn.example.com:5349?transport=tcp`.
- `TURN_USERNAME` e `TURN_CREDENTIAL`: credenciais fornecidas pelo serviço TURN.
- Alternativamente, para um coturn configurado com TURN REST API, use
  `TURN_SECRET` no lugar das credenciais estáticas; o backend emite credenciais
  temporárias. `TURN_TTL_SECONDS` controla a validade.

Metered.ca ou outro provedor que entregue URLs, usuário e senha pode ser usado
com o modo estático. Credenciais Twilio temporárias precisam ser renovadas pelo
backend conforme a validade emitida pelo Twilio; não coloque tokens ou senhas em
`NEXT_PUBLIC_*`, HTML ou JavaScript público. No painel Vercel, as variáveis de
ambiente são configuradas em **Project Settings → Environment Variables**, mas
isso não torna este servidor compatível com o runtime serverless da Vercel: o
backend completo deve continuar em um host com WebSocket e armazenamento
persistente, como o Render, a menos que WebSocket, SQLite e uploads sejam
migrados para serviços compatíveis.