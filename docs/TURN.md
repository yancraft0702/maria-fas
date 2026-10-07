# ============================================================================
# TURN - o que existe, o que falta e como provar relay de verdade
# ============================================================================
#
# Resumo honesto: a PARTE DA APLICACAO esta completa e real (credenciais
# efemeras com expiracao, diagnostico que distingue host/srflx/relay e so
# considera TURN resolvido quando um par conectado sai por relay). O que falta
# nesta maquina e o BINARIO do coturn rodando - sem ele nao existe relay, e o
# projeto NAO se declara resolvido.
#
# ---------------------------------------------------------------------------
# 1) O QUE O CODIGO FAZ (e pode ser conferido no navegador)
# ---------------------------------------------------------------------------
#
# `server/config.js`
#   Le TURN_URL / TURN_URLS (UDP, TCP e TURNS), TURN_USERNAME/TURN_CREDENTIAL
#   (modo estatico) e TURN_SECRET / TURN_TTL_SECONDS (modo efemero).
#
# `server/lib/turn-credentials.js`
#   Gera credenciais EFEMERAS no formato da TURN REST API:
#     username  = "<expiracao em segundos>:<rotulo>"
#     credential = base64( HMAC-SHA1( TURN_SECRET , username ) )
#   O segredo compartilhado NUNCA sai do servidor. No modo estatico (sem
#   TURN_SECRET) o projeto usa TURN_USERNAME/TURN_CREDENTIAL e DECLARA isso em
#   `turn.credentialMode`, em vez de fingir que e efemero.
#
# `server/domain/live.js`
#   `iceServers()` monta a lista com a credencial gerada no momento do pedido e
#   devolve `turnCredentialMode` e `turnExpiresAt` para o diagnostico.
#
# `web/js/features/webrtc.js` (classe `IceDiagnostics`)
#   Conta candidatos por tipo - host, srflx, relay, prflx - e le o par
#   selecionado de `getStats()`. `relayWorking` so e verdadeiro quando o par
#   CONECTADO saiu por relay. E esse o criterio de "TURN resolvido".
#
# `GET /api/live/config`
#   `turn.configured`, `turn.transports`, `turn.credentialMode`,
#   `turn.expiresAt` e `turn.warning` (que continua aparecendo quando nao ha
#   TURN - o aviso nao e escondido).
#
# ---------------------------------------------------------------------------
# 2) O QUE FALTA NESTA MAQUINA
# ---------------------------------------------------------------------------
#
# O binario do coturn (`turnserver.exe`). Motivos, com o que foi checado:
#
#   - `turnserver` nao esta no PATH;
#   - Docker nao esta instalado (sem `docker` na maquina);
#   - Chocolatey nao esta instalado;
#   - os releases oficiais do coturn no GitHub (4.15 ate 4.18) publicam apenas
#     o codigo-fonte em tar.gz, sem binario para Windows - confirmado pela API
#     do GitHub;
#   - compilar o coturn no Windows exigiria toolchain C (MSYS2/MinGW) que nao
#     esta instalado.
#
# Sem o binario, nao existe relay. Nenhuma credencial foi inventada e nenhum
# "TURN resolvido" foi declarado: sem TURN_SECRET/TURN_URL, a API responde
# `turn.configured: false` e a LIVE mostra o aviso real.
#
# ---------------------------------------------------------------------------
# 3) COMO ATIVAR (passo a passo)
# ---------------------------------------------------------------------------
#
# A) Instalar o coturn
#
#    - Windows com WSL2 (recomendado, sem compilar):
#        wsl --install -d Ubuntu
#        wsl -d Ubuntu -- sudo apt update && sudo apt install -y coturn
#        wsl -d Ubuntu -- sudo nano /etc/coturn/turnserver.conf
#          (use infra/coturn/turnserver.conf como modelo)
#
#    - Windows com binario de terceiros (verifique a origem):
#        baixe um turnserver.exe assinado por fonte confiavel, coloque em
#        C:\coturn\ e rode:  turnserver -c C:\...\turnserver.conf -v
#
#    - Linux/maquina virtual:
#        sudo apt install coturn
#        sudo cp infra/coturn/turnserver.conf /etc/coturn/turnserver.conf
#
#    - Docker (em qualquer maquina com Docker):
#        ver o bloco de exemplo no topo de infra/coturn/turnserver.conf
#
# B) Definir o segredo e as URLs
#
#    No `.env` da raiz do projeto:
#        TURN_SECRET=<openssl rand -hex 32>
#        TURN_URLS=turn:<IP_PUBLICO>:3478?transport=udp,turn:<IP_PUBLICO>:3478?transport=tcp,turns:<IP_PUBLICO>:5349
#        TURN_TTL_SECONDS=3600
#
#    O mesmo `static-auth-secret` do `turnserver.conf` tem que estar em
#    `TURN_SECRET` - sao o mesmo segredo, visto de dois lados.
#
# C) Abrir o firewall (ver o bloco `firewall` do turnserver.conf)
#
# D) Provar
#
#        npm run test:turn
#
#    O verificador so marca "relay" quando o navegador gather um candidato
#    `relay` E o par conecta por ele. Se o coturn nao responder, o verificador
#    falha com o motivo - nao degrada para "verde".
#
# ---------------------------------------------------------------------------
# 3.1) SERVICO TURN GERENCIADO E VERCEL
# ---------------------------------------------------------------------------
#
# Para um provedor gerenciado que fornece URL(s), username e password:
#
#   TURN_URLS=turn:host-do-provedor:3478?transport=udp,turns:host-do-provedor:5349?transport=tcp
#   TURN_USERNAME=<username fornecido pelo provedor>
#   TURN_CREDENTIAL=<password/credential fornecido pelo provedor>
#
# Cadastre os valores como variaveis privadas do backend (por exemplo, no
# Render, em Environment). O projeto nao e Next.js: nao use NEXT_PUBLIC_*.
# As credenciais necessarias para ICE sao entregues somente pelo endpoint
# autenticado da LIVE. O segredo TURN_SECRET nunca e enviado ao navegador.
#
# Metered.ca pode ser usado com credenciais estaticas conforme os dados e a
# validade oferecidos pela conta. Se o provedor, como Twilio, emitir credenciais
# temporarias por uma API, a renovacao precisa ser integrada ao backend; nao
# copie credenciais expiraveis como se fossem permanentes. Consulte a
# documentacao/condicoes atuais do provedor para URLs, transportes, expiracao e
# precos.
#
# A Vercel permite cadastrar variaveis em Project Settings > Environment
# Variables, mas nao hospeda este backend completo como esta: WebSocket,
# SQLite persistente e uploads em disco exigem servico/armazenamento externos.
# Definir variaveis TURN na Vercel nao resolve esses requisitos de deploy.
#
# ---------------------------------------------------------------------------
# 4) COMO CONFIRMAR QUE NAO HA SEGREDO PERMANENTE NO FRONTEND
# ---------------------------------------------------------------------------
#
#    1) Abra a LIVE, va em devtools > Network > WS e procure a mensagem de
#       configuracao. Ela traz `username` no formato "<expiracao>:<rotulo>" e
#       `credential` em base64 - credencial de uso unico.
#    2) Espere TURN_TTL_SECONDS e recarregue: o `username` tem outro
#       timestamp. Ele NAO e fixo.
#    3) O valor de `TURN_SECRET` nao aparece em nenhum arquivo de `web/`.
#
# ---------------------------------------------------------------------------
# 5) TESTES MANUAIS QUE O ITEM 3 PEDE
# ---------------------------------------------------------------------------
#
# 1) streamer inicia LIVE                 -> coberto por verify-live-camadas
# 2) viewer entra                          -> coberto por verify-live-camadas
# 3) SDP                                   -> offer/answer trocados via realtime
# 4) ICE                                   -> `onicecandidate` + `drainCandidates`
# 5) candidates                            -> `IceDiagnostics.candidates`
# 6) host/srflx/relay                      -> `IceDiagnostics.selected`
# 7) midia (audio+video)                   -> coberto por verify-live-camadas
# 8) reconexao                             -> `reconnect()` + item 13 da rodada
# 9) troca de rede                         -> exige desligar a interface de rede
#                                            durante a LIVE (manual)
# 10) encerramento                         -> coberto por verify-live-camadas
# 11) relay real quando a rede exige       -> `npm run test:turn` com coturn no ar
# 12) HTTPS LAN real                       -> `npm run test:turn -- --lan`