/** Painel completo de configuracoes. */
import { api } from '../core/api.js';
import { el, icon } from '../core/dom.js';
import { emptyState, toastError, toastSuccess, openModal } from '../core/ui.js';
import { store, updatePreference, applyPreferences, toggleTheme } from '../core/store.js';
import { navigate } from '../core/router.js';
import { changePassword, disableTotp, deleteAccount, regenerateRecoveryCodes, activateTotp, setupTotp } from './auth.js';
import { REPORT_CATEGORIES } from './report.js';
const SECTIONS = [
  { id: 'conta', label: 'Conta' },
  { id: 'seguranca', label: 'Seguranca' },
  { id: 'notificacoes', label: 'Notificacoes' },
  { id: 'privacidade', label: 'Privacidade' },
  { id: 'conteudo', label: 'Conteudo' },
  { id: 'comentarios', label: 'Comentarios' },
  { id: 'mensagens', label: 'Mensagens' },
  { id: 'downloads', label: 'Downloads' },
  { id: 'idioma', label: 'Idioma' },
  { id: 'acessibilidade', label: 'Acessibilidade' },
  { id: 'reproducao', label: 'Reproducao' },
  { id: 'dados', label: 'Dados' },
  { id: 'dispositivos', label: 'Dispositivos' },
  { id: 'sessoes', label: 'Sessoes' },
  { id: 'bloqueados', label: 'Bloqueados' },
  { id: 'silenciados', label: 'Silenciados' },
  { id: 'moderacao', label: 'Minhas denuncias' },
];

export function createSettingsScreen() {
  const page = el('div', { style: { display: 'flex', flexDirection: 'column', minHeight: '100%' } });
  const nav = el('div', { class: 'settings-nav', role: 'tablist' });
  const body = el('div', { class: 'settings-body' });
  let current = 'conta';
  let settings = null;

  const renderNav = () => {
    nav.replaceChildren();
    for (const section of SECTIONS) {
      nav.append(el('button', {
        type: 'button', role: 'tab',
        'aria-selected': String(current === section.id),
        text: section.label,
        onClick: () => { current = section.id; renderNav(); renderBody(); },
      }));
    }
  };

  const group = (title, children) => el('div', { class: 'setting-group' }, [
    el('h3', { text: title }),
    ...(Array.isArray(children) ? children : [children]),
  ]);

  const switchRow = (label, value, onChange, hint = null) => {
    const toggle = el('input', { type: 'checkbox', checked: Boolean(value) });
    toggle.addEventListener('change', async () => {
      try {
        await onChange(toggle.checked);
        toastSuccess('Preferencia salva');
      } catch (err) {
        toggle.checked = !toggle.checked;
        toastError(err);
      }
    });
    return el('div', {}, [
      el('div', { class: 'switch' }, [el('span', { text: label }), toggle]),
      hint ? el('div', { class: 'tiny faint', style: { marginTop: '-6px', marginBottom: '6px' }, text: hint }) : null,
    ]);
  };

  const selectRow = (label, value, options, onChange) => {
    const select = el('select', { class: 'select' });
    for (const [optionValue, optionText] of options) select.append(el('option', { value: optionValue, text: optionText }));
    select.value = value;
    select.addEventListener('change', async () => {
      try {
        await onChange(select.value);
        toastSuccess('Preferencia salva');
      } catch (err) { toastError(err); }
    });
    return el('div', { class: 'field' }, [el('label', { text: label }), select]);
  };

  const patchPrivacy = async (payload) => {
    const result = await api.patch('/api/me/privacy', payload);
    settings.privacy = result.settings.privacy;
  };

  const patchSettings = async (payload) => {
    const result = await api.patch('/api/me/settings', payload);
    settings = result.settings;
    applyPreferences();
  };

  const AUDIENCE_OPTIONS = [
    ['everyone', 'Todos'],
    ['followers', 'Quem me segue'],
    ['friends', 'Somente amigos (mutuo)'],
    ['nobody', 'Ninguem'],
  ];

  const renderBody = () => {
    body.replaceChildren();
    if (!settings) return;

    switch (current) {
      case 'conta': return renderAccount();
      case 'seguranca': return renderSecurity();
      case 'notificacoes': return renderNotifications();
      case 'privacidade': return renderPrivacy();
      case 'conteudo': return renderContent();
      case 'comentarios': return renderComments();
      case 'mensagens': return renderMessages();
      case 'downloads': return renderDownloads();
      case 'idioma': return renderLanguage();
      case 'acessibilidade': return renderAccessibility();
      case 'reproducao': return renderPlayback();
      case 'dados': return renderData();
      case 'dispositivos': return renderDevices();
      case 'sessoes': return renderSessions();
      case 'bloqueados': return renderBlocked();
      case 'silenciados': return renderMuted();
      case 'moderacao': return renderReports();
      default: return renderAccount();
    }
  };

  const renderAccount = () => {
    body.append(
      group('Conta', [
        el('div', { class: 'row' }, [
          el('div', { class: 'avatar lg' }, [
            store.user.avatarUrl
              ? el('img', { src: store.user.avatarUrl, alt: '' })
              : el('div', { class: 'avatar lg' }),
          ]),
          el('div', { class: 'grow' }, [
            el('div', { class: 'strong', text: store.user.displayName }),
            el('div', { class: 'small faint', text: `@${store.user.username}` }),
            store.user.email ? el('div', { class: 'tiny faint', text: store.user.email }) : null,
          ]),
        ]),
        el('button', { type: 'button', class: 'btn btn-ghost btn-block', text: 'Editar perfil', onClick: () => navigate('/perfil') }),
      ]),
      group('Sobre', [
        el('div', { class: 'row small muted' }, [
          el('span', { class: 'grow', text: 'Papel' }),
          el('span', { text: store.user.role }),
        ]),
        el('div', { class: 'row small muted' }, [
          el('span', { class: 'grow', text: 'Conta criada' }),
          el('span', { text: new Date(store.user.createdAt).toLocaleDateString('pt-BR') }),
        ]),
        el('div', { class: 'row small muted' }, [
          el('span', { class: 'grow', text: 'MARIA FÃS' }),
          el('span', { text: store.appConfig?.version || '1.0.0' }),
        ]),
      ]),
    );
  };

  const renderSecurity = () => {
    body.append(
      group('Senha', [
        el('button', { type: 'button', class: 'btn btn-ghost btn-block', text: 'Alterar senha', onClick: () => openChangePassword() }),
      ]),
      group('Verificacao em duas etapas (2FA)', [
        el('p', { class: 'small muted', text: store.user.totpEnabled ? 'Ativo: um codigo do aplicativo autenticador e exigido a cada login.' : 'Inativo. Ative para proteger sua conta mesmo com senha vazada.' }),
        store.user.totpEnabled
          ? el('div', { class: 'col' }, [
            el('button', { type: 'button', class: 'btn btn-ghost', text: 'Gerar novos codigos de recuperacao', onClick: () => openRegenerateCodes() }),
            el('button', { type: 'button', class: 'btn btn-danger', text: 'Desativar 2FA', onClick: () => openDisableTotp() }),
          ])
          : el('button', { type: 'button', class: 'btn btn-primary', text: 'Ativar 2FA', onClick: () => openEnableTotp() }),
      ]),
      group('Sessao', [
        el('button', {
          type: 'button', class: 'btn btn-ghost btn-block', text: 'Encerrar outras sessoes',
          onClick: async () => {
            try {
              await api.post('/api/auth/sessions/revoke-others', {});
              toastSuccess('Outras sessoes encerradas');
            } catch (err) { toastError(err); }
          },
        }),
      ]),
      group('Excluir conta', [
        el('p', { class: 'small muted', text: 'A exclusao e definitiva: perfil, videos, comentarios e mensagens sao removidos.' }),
        el('button', { type: 'button', class: 'btn btn-danger', text: 'Excluir minha conta', onClick: () => openDeleteAccount() }),
      ]),
    );
  };

  const openChangePassword = () => {
    const current_ = el('input', { class: 'input', type: 'password', autocomplete: 'current-password' });
    const next = el('input', { class: 'input', type: 'password', autocomplete: 'new-password' });
    const confirm = el('input', { class: 'input', type: 'password', autocomplete: 'new-password' });
    openModal({
      title: 'Alterar senha',
      body: el('div', {}, [
        el('div', { class: 'field' }, [el('label', { text: 'Senha atual' }), current_]),
        el('div', { class: 'field' }, [el('label', { text: 'Nova senha' }), next]),
        el('div', { class: 'field' }, [el('label', { text: 'Confirmar nova senha' }), confirm]),
      ]),
      actions: [
        { label: 'Cancelar', class: 'btn-ghost' },
        {
          label: 'Alterar',
          class: 'btn-primary',
          onClick: async () => {
            if (next.value !== confirm.value) { toastError(new Error('As senhas nao conferem')); return false; }
            try {
              await changePassword(current_.value, next.value);
              toastSuccess('Senha alterada. Outras sessoes foram encerradas.');
              return true;
            } catch (err) { toastError(err); return false; }
          },
        },
      ],
    });
  };

  const openEnableTotp = async () => {
    const data = await setupTotp();
    const codeInput = el('input', { class: 'input', inputmode: 'numeric', maxlength: '6', placeholder: 'Codigo de 6 digitos' });
    const secretBox = el('div', { class: 'card' }, [
      el('div', { class: 'small muted', text: 'Adicione esta chave no seu aplicativo autenticador:' }),
      el('code', { style: { display: 'block', wordBreak: 'break-all', marginTop: '6px', fontSize: '15px' }, text: data.secret }),
      el('p', { class: 'tiny faint', style: { marginTop: '8px' }, text: 'Ou use o link otpauth no aplicativo:' }),
      el('code', { class: 'tiny faint', style: { display: 'block', wordBreak: 'break-all' }, text: data.otpauthUrl }),
    ]);
    const codesBox = el('div', { class: 'card mt' }, [
      el('div', { class: 'small strong', text: 'Codigos de recuperacao (guarde agora)' }),
      el('code', { style: { display: 'block', marginTop: '6px', wordBreak: 'break-all' }, text: data.recoveryCodes.join('  ') }),
    ]);

    openModal({
      title: 'Ativar verificacao em duas etapas',
      size: '480px',
      body: el('div', {}, [secretBox, codesBox, el('div', { class: 'field mt' }, [el('label', { text: 'Codigo gerado' }), codeInput])]),
      actions: [
        { label: 'Cancelar', class: 'btn-ghost' },
        {
          label: 'Ativar',
          class: 'btn-primary',
          onClick: async () => {
            try {
              await activateTotp(codeInput.value.trim());
              toastSuccess('2FA ativado');
              store.user.totpEnabled = true;
              renderBody();
              return true;
            } catch (err) { toastError(err); return false; }
          },
        },
      ],
    });
  };

  const openDisableTotp = () => {
    const code = el('input', { class: 'input', inputmode: 'numeric', maxlength: '6' });
    openModal({
      title: 'Desativar 2FA',
      body: el('div', { class: 'field' }, [el('label', { text: 'Codigo atual do aplicativo' }), code]),
      actions: [
        { label: 'Cancelar', class: 'btn-ghost' },
        {
          label: 'Desativar',
          class: 'btn-danger',
          onClick: async () => {
            try {
              await disableTotp(code.value.trim());
              toastSuccess('2FA desativado');
              store.user.totpEnabled = false;
              renderBody();
              return true;
            } catch (err) { toastError(err); return false; }
          },
        },
      ],
    });
  };

  const openRegenerateCodes = () => {
    const code = el('input', { class: 'input', inputmode: 'numeric', maxlength: '6' });
    const output = el('div', { class: 'card', hidden: true });
    openModal({
      title: 'Novos codigos de recuperacao',
      body: el('div', {}, [
        el('div', { class: 'field' }, [el('label', { text: 'Codigo do aplicativo' }), code]),
        output,
      ]),
      actions: [
        { label: 'Fechar', class: 'btn-ghost' },
        {
          label: 'Gerar',
          class: 'btn-primary',
          onClick: async () => {
            try {
              const result = await regenerateRecoveryCodes(code.value.trim());
              output.hidden = false;
              output.replaceChildren(
                el('div', { class: 'small strong', text: 'Guarde estes codigos' }),
                el('code', { style: { display: 'block', marginTop: '6px', wordBreak: 'break-all' }, text: result.recoveryCodes.join('  ') }),
              );
              return false;
            } catch (err) { toastError(err); return false; }
          },
        },
      ],
    });
  };

  const openDeleteAccount = () => {
    const password = el('input', { class: 'input', type: 'password', autocomplete: 'current-password' });
    openModal({
      title: 'Excluir conta definitivamente',
      body: el('div', {}, [
        el('p', { class: 'small muted', text: 'Esta acao remove perfil, videos, comentarios, stories, conversas e dados pessoais. Nao e possivel desfazer.' }),
        el('div', { class: 'field' }, [el('label', { text: 'Confirme sua senha' }), password]),
      ]),
      actions: [
        { label: 'Cancelar', class: 'btn-ghost' },
        {
          label: 'Excluir minha conta',
          class: 'btn-danger',
          onClick: async () => {
            try {
              await deleteAccount(password.value);
              toastSuccess('Conta excluida');
              navigate('/');
            } catch (err) { toastError(err); return false; }
            return false;
          },
        },
      ],
    });
  };

  const renderNotifications = () => {
    const n = settings.notifications;
    body.append(group('Notificacoes', [
      switchRow('Curtidas e comentarios curtidos', n.likes, (value) => api.patch('/api/me/notification-settings', { likes: value }).then(() => { n.likes = value; })),
      switchRow('Comentarios', n.comments, (value) => api.patch('/api/me/notification-settings', { comments: value }).then(() => { n.comments = value; })),
      switchRow('Respostas', n.replies, (value) => api.patch('/api/me/notification-settings', { replies: value }).then(() => { n.replies = value; })),
      switchRow('Seguidores e pedidos', n.follows, (value) => api.patch('/api/me/notification-settings', { follows: value }).then(() => { n.follows = value; })),
      switchRow('Mencoes', n.mentions, (value) => api.patch('/api/me/notification-settings', { mentions: value }).then(() => { n.mentions = value; })),
      switchRow('Reposts', n.reposts, (value) => api.patch('/api/me/notification-settings', { reposts: value }).then(() => { n.reposts = value; })),
      switchRow('Mensagens', n.messages, (value) => api.patch('/api/me/notification-settings', { messages: value }).then(() => { n.messages = value; })),
      switchRow('Atividade em LIVE', n.lives, (value) => api.patch('/api/me/notification-settings', { lives: value }).then(() => { n.lives = value; })),
      switchRow('Atividade geral', n.activity, (value) => api.patch('/api/me/notification-settings', { activity: value }).then(() => { n.activity = value; })),
      switchRow('Push no dispositivo', n.pushEnabled, (value) => api.patch('/api/me/notification-settings', { pushEnabled: value }).then(() => { n.pushEnabled = value; }),
        store.appConfig.features?.push ? null : 'Push nao configurado no servidor (VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY).'),
    ]));
  };

  const renderPrivacy = () => {
    const p = settings.privacy;
    body.append(group('Conta', [
      selectRow('Visibilidade', p.accountPrivacy, [['public', 'Publica'], ['private', 'Privada']], async (value) => {
        await patchPrivacy({ accountPrivacy: value });
        p.accountPrivacy = value;
      }),
      switchRow('Somente amigos veem meus conteudos', p.friendOnly, async (value) => {
        await patchPrivacy({ friendOnly: value });
        p.friendOnly = value;
      }, 'Amigos sao relacoes MUTUAS: os dois precisam se seguir.'),
    ]));
    body.append(group('Quem pode interagir comigo', [
      selectRow('Me seguir', p.whoCanFollow, AUDIENCE_OPTIONS, async (value) => { await patchPrivacy({ whoCanFollow: value }); p.whoCanFollow = value; }),
      selectRow('Comentar nos meus videos', p.whoCanComment, AUDIENCE_OPTIONS, async (value) => { await patchPrivacy({ whoCanComment: value }); p.whoCanComment = value; }),
      selectRow('Enviar mensagem', p.whoCanMessage, AUDIENCE_OPTIONS, async (value) => { await patchPrivacy({ whoCanMessage: value }); p.whoCanMessage = value; }),
      selectRow('Me mencionar', p.whoCanMention, AUDIENCE_OPTIONS, async (value) => { await patchPrivacy({ whoCanMention: value }); p.whoCanMention = value; }),
      selectRow('Marcar minha foto', p.whoCanTag, AUDIENCE_OPTIONS, async (value) => { await patchPrivacy({ whoCanTag: value }); p.whoCanTag = value; }),
    ]));
    body.append(group('Quem pode ver', [
      selectRow('Minhas curtidas', p.whoCanSeeLikes, AUDIENCE_OPTIONS, async (value) => { await patchPrivacy({ whoCanSeeLikes: value }); p.whoCanSeeLikes = value; }),
      selectRow('Meus reposts', p.whoCanSeeReposts, AUDIENCE_OPTIONS, async (value) => { await patchPrivacy({ whoCanSeeReposts: value }); p.whoCanSeeReposts = value; }),
    ]));
  };

  const renderContent = () => {
    const c = settings.content;
    body.append(group('Publicacao', [
      selectRow('Visibilidade padrao dos novos videos', settings.playback.defaultPostVisibility, [
        ['public', 'Publico'],
        ['followers', 'Quem me segue'],
        ['friends', 'Somente amigos'],
        ['private', 'Somente eu'],
      ], async (value) => { await patchSettings({ defaultPostVisibility: value }); settings.playback.defaultPostVisibility = value; }),
      switchRow('Permitir comentarios por padrao', settings.content.allowComments, async (value) => {
        await patchSettings({ allowComments: value });
        c.allowComments = value;
      }),
      switchRow('Permitir duets por padrao', settings.content.allowDuets, async (value) => {
        await patchSettings({ allowDuets: value });
        c.allowDuets = value;
      }),
    ]));
    body.append(group('Recomendacoes', [
      switchRow('Desativar recomendacoes personalizadas', settings.recommendation.optOut, async (value) => {
        const result = await api.patch('/api/me/recommendations', { optOut: value });
        settings.recommendation = result.recommendation;
      }, 'Voce continuara vendo conteudo, mas sem ordenacao por interesse.'),
      el('button', {
        type: 'button', class: 'btn btn-ghost', text: 'Redefinir recomendacoes',
        onClick: async () => {
          try {
            await api.post('/api/me/recommendations/reset', {});
            toastSuccess('Recomendacoes redefinidas');
          } catch (err) { toastError(err); }
        },
      }),
    ]));
  };

  const renderComments = () => {
    const p = settings.privacy;
    body.append(group('Comentarios', [
      selectRow('Quem pode comentar', p.whoCanComment, AUDIENCE_OPTIONS, async (value) => { await patchPrivacy({ whoCanComment: value }); p.whoCanComment = value; }),
      el('p', { class: 'small faint', text: 'Cada video tambem tem controle proprio de comentarios, ajustavel na publicacao.' }),
    ]));
  };

  const renderMessages = () => {
    const p = settings.privacy;
    body.append(group('Mensagens', [
      selectRow('Quem pode me enviar mensagem', p.whoCanMessage, AUDIENCE_OPTIONS, async (value) => { await patchPrivacy({ whoCanMessage: value }); p.whoCanMessage = value; }),
      el('a', { class: 'btn btn-ghost btn-block', href: '/chat-global', 'data-link': true, text: 'Abrir chat global' }),
    ]));
  };

  const renderDownloads = () => {
    const p = settings.privacy;
    body.append(group('Downloads e remix', [
      selectRow('Quem pode baixar meus videos', p.downloadAllowed, AUDIENCE_OPTIONS, async (value) => { await patchPrivacy({ downloadAllowed: value }); p.downloadAllowed = value; }),
      selectRow('Quem pode remixar meus videos', p.remixAllowed, AUDIENCE_OPTIONS, async (value) => { await patchPrivacy({ remixAllowed: value }); p.remixAllowed = value; }),
      el('p', { class: 'small faint', text: 'O controle de cada video tem prioridade sobre o padrao da conta.' }),
    ]));
  };

  const renderLanguage = () => {
    body.append(group('Idioma e regiao', [
      selectRow('Idioma da interface', settings.account.language, [
        ['pt-BR', 'Portugues (Brasil)'],
        ['pt-PT', 'Portugues (Portugal)'],
        ['en-US', 'English (US)'],
        ['es-ES', 'Espanhol'],
      ], async (value) => { await patchSettings({ language: value }); settings.account.language = value; }),
      el('p', { class: 'small faint', text: 'A interface esta em portugues. Novos idiomas podem ser adicionados sem alterar o backend.' }),
    ]));
  };

  const renderAccessibility = () => {
    const a = settings.accessibility;
    body.append(group('Acessibilidade', [
      switchRow('Reduzir animacoes', a.reduceMotion, async (value) => {
        await patchSettings({ reduceMotion: value });
        a.reduceMotion = value;
        updatePreference('reduceMotion', value);
      }),
      switchRow('Alto contraste', a.highContrast, async (value) => {
        await patchSettings({ highContrast: value });
        a.highContrast = value;
        updatePreference('highContrast', value);
      }),
      el('div', { class: 'field' }, [
        el('label', { text: `Tamanho do texto (${Math.round(a.fontScale * 100)}%)` }),
        el('input', {
          type: 'range', min: '85', max: '150', value: String(Math.round(a.fontScale * 100)), style: { width: '100%' },
          onChange: async (event) => {
            const scale = Number(event.target.value) / 100;
            try {
              await patchSettings({ fontScale: scale });
              a.fontScale = scale;
              updatePreference('fontScale', scale);
            } catch (err) { toastError(err); }
          },
        }),
      ]),
      switchRow('Legendas ativadas por padrao', a.captionsDefault, async (value) => { await patchSettings({ captionsDefault: value }); a.captionsDefault = value; }),
      switchRow('Mostrar legendas na LIVE', a.showLiveCaptions, async (value) => { await patchSettings({ showLiveCaptions: value }); a.showLiveCaptions = value; }),
      el('button', {
        type: 'button', class: 'btn btn-ghost', text: `Alternar tema (atual: ${store.theme === 'dark' ? 'escuro' : 'claro'})`,
        onClick: () => { toggleTheme(); renderBody(); },
      }),
    ]));
  };

  const renderPlayback = () => {
    const acc = settings.account;
    body.append(group('Reproducao', [
      switchRow('Reproducao automatica', acc.autoplay, async (value) => {
        await patchSettings({ autoplay: value });
        acc.autoplay = value;
        updatePreference('autoplay', value);
      }),
      switchRow('Reproducao automatica sem som', acc.autoplayMuted, async (value) => {
        await patchSettings({ autoplayMuted: value });
        acc.autoplayMuted = value;
        updatePreference('autoplayMuted', value);
      }),
      switchRow('Economia de dados', acc.dataSaver, async (value) => {
        await patchSettings({ dataSaver: value });
        acc.dataSaver = value;
        updatePreference('dataSaver', value);
      }, 'Carrega menos resolucoes e evita pre-carregamento agressivo.'),
    ]));
  };

  const renderData = () => {
    body.append(group('Seus dados', [
      el('p', { class: 'small muted', text: 'Baixe um arquivo com os seus dados ou remova sua conta.' }),
      el('button', {
        type: 'button', class: 'btn btn-ghost btn-block', text: 'Baixar meus dados (JSON)',
        onClick: async () => {
          const data = await api.get('/api/me/export');
          const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
          const url = URL.createObjectURL(blob);
          const link = el('a', { href: url, download: 'pulse-dados.json' });
          document.body.append(link);
          link.click();
          link.remove();
          URL.revokeObjectURL(url);
          toastSuccess('Arquivo gerado');
        },
      }),
      el('button', { type: 'button', class: 'btn btn-danger btn-block', text: 'Excluir minha conta', onClick: () => openDeleteAccount() }),
    ]));
  };

  const renderDevices = async () => {
    body.replaceChildren(group('Dispositivos', [el('div', { class: 'skeleton', style: { height: '80px' } })]));
    try {
      const data = await api.get('/api/auth/sessions');
      body.replaceChildren(group('Dispositivos', data.devices.length
        ? data.devices.map((device) => el('div', { class: 'row small', style: { padding: '6px 0' } }, [
          el('div', { class: 'grow' }, [
            el('div', { class: 'strong', text: device.label || 'Dispositivo' }),
            el('div', { class: 'tiny faint', text: `${device.activeSessions} sessao(oes) ativa(s) · ${new Date(device.lastUsedAt).toLocaleString('pt-BR')}` }),
          ]),
          device.pushEnabled ? el('span', { class: 'tiny faint', text: 'push' }) : null,
        ]))
        : el('p', { class: 'small faint', text: 'Nenhum dispositivo registrado.' })));
    } catch (err) {
      body.replaceChildren(emptyState({ iconName: 'warning', title: 'Falha ao carregar', message: err.message }));
    }
  };

  const renderSessions = async () => {
    body.replaceChildren(group('Sessoes', [el('div', { class: 'skeleton', style: { height: '80px' } })]));
    try {
      const data = await api.get('/api/auth/sessions');
      const list = el('div', { class: 'list' });
      for (const session of data.sessions) {
        list.append(el('div', { class: 'list-item' }, [
          icon('globe'),
          el('div', { class: 'grow' }, [
            el('div', { class: 'strong small', text: session.device }),
            el('div', { class: 'tiny faint', text: `${session.ip || 'ip desconhecido'} · ${new Date(session.lastUsedAt).toLocaleString('pt-BR')}` }),
          ]),
          session.current ? el('span', { class: 'tiny', style: { color: 'var(--brand)' }, text: 'atual' }) : el('button', {
            type: 'button', class: 'btn btn-sm btn-ghost', text: 'Encerrar',
            onClick: async () => {
              try {
                await api.post(`/api/auth/sessions/${session.id}/revoke`, {});
                toastSuccess('Sessao encerrada');
                renderSessions();
              } catch (err) { toastError(err); }
            },
          }),
        ]));
      }
      body.replaceChildren(group('Sessoes', [
        list,
        el('button', {
          type: 'button', class: 'btn btn-ghost btn-block mt', text: 'Encerrar todas as outras sessoes',
          onClick: async () => {
            try {
              await api.post('/api/auth/sessions/revoke-others', {});
              toastSuccess('Sessois encerradas');
              renderSessions();
            } catch (err) { toastError(err); }
          },
        }),
      ]));
    } catch (err) {
      body.replaceChildren(emptyState({ iconName: 'warning', title: 'Falha ao carregar', message: err.message }));
    }
  };

  const renderBlocked = async () => {
    body.replaceChildren(group('Contas bloqueadas', [el('div', { class: 'skeleton', style: { height: '60px' } })]));
    try {
      const data = await api.get('/api/me/blocks');
      if (!data.users.length) {
        body.replaceChildren(group('Contas bloqueadas', el('p', { class: 'small faint', text: 'Voce nao bloqueou nenhuma conta.' })));
        return;
      }
      const list = el('div', { class: 'list' });
      for (const user of data.users) {
        list.append(el('div', { class: 'list-item' }, [
          el('div', { class: 'avatar' }, [user.avatarUrl ? el('img', { src: user.avatarUrl, alt: '', loading: 'lazy' }) : el('div', { class: 'avatar' })]),
          el('div', { class: 'grow' }, [
            el('div', { class: 'strong', text: user.displayName }),
            el('div', { class: 'small faint', text: `@${user.username}` }),
          ]),
          el('button', {
            type: 'button', class: 'btn btn-sm btn-ghost', text: 'Desbloquear',
            onClick: async () => {
              try {
                await api.delete(`/api/users/${user.id}/block`);
                toastSuccess('Conta desbloqueada');
                renderBlocked();
              } catch (err) { toastError(err); }
            },
          }),
        ]));
      }
      body.replaceChildren(group('Contas bloqueadas', list));
    } catch (err) {
      body.replaceChildren(emptyState({ iconName: 'warning', title: 'Falha ao carregar', message: err.message }));
    }
  };

  const renderMuted = async () => {
    body.replaceChildren(group('Silenciados', [el('div', { class: 'skeleton', style: { height: '60px' } })]));
    try {
      const data = await api.get('/api/me/mutes');
      if (!data.mutes.length) {
        body.replaceChildren(group('Silenciados', el('p', { class: 'small faint', text: 'Voce nao silenciou ninguem.' })));
        return;
      }
      const list = el('div', { class: 'list' });
      for (const mute of data.mutes) {
        list.append(el('div', { class: 'list-item' }, [
          icon('mute'),
          el('div', { class: 'grow' }, [
            el('div', { class: 'strong small', text: mute.user ? `@${mute.user.username}` : `${mute.targetType}:${mute.targetId}` }),
          ]),
          el('button', {
            type: 'button', class: 'btn btn-sm btn-ghost', text: 'Remover',
            onClick: async () => {
              try {
                await api.delete('/api/mutes', { targetType: mute.targetType, targetId: mute.targetId });
                toastSuccess('Silenciamento removido');
                renderMuted();
              } catch (err) { toastError(err); }
            },
          }),
        ]));
      }
      body.replaceChildren(group('Silenciados', list));
    } catch (err) {
      body.replaceChildren(emptyState({ iconName: 'warning', title: 'Falha ao carregar', message: err.message }));
    }
  };

  const renderReports = async () => {
    body.replaceChildren(group('Minhas denuncias', [el('div', { class: 'skeleton', style: { height: '60px' } })]));
    try {
      const data = await api.get('/api/reports/mine');
      if (!data.reports.length) {
        body.replaceChildren(group('Minhas denuncias', el('p', { class: 'small faint', text: 'Voce nao fez nenhuma denuncia.' })));
        return;
      }
      const list = el('div', { class: 'list' });
      for (const report of data.reports) {
        list.append(el('div', { class: 'list-item' }, [
          icon('flag'),
          el('div', { class: 'grow' }, [
            el('div', { class: 'strong small', text: report.category }),
            el('div', { class: 'tiny faint', text: `${report.targetType} · ${report.status}` }),
          ]),
          el('span', { class: `status-tag status-${report.status}`, text: report.status }),
        ]));
      }
      body.replaceChildren(group('Minhas denuncias', list));
    } catch (err) {
      body.replaceChildren(emptyState({ iconName: 'warning', title: 'Falha ao carregar', message: err.message }));
    }
  };

  page.append(
    el('div', { class: 'row', style: { padding: '10px 14px 0' } }, [
      el('h1', { class: 'grow', style: { fontSize: '20px', margin: '0' }, text: 'Configuracoes' }),
      el('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Fechar', onClick: () => navigate('/') }, [icon('close')]),
    ]),
    nav,
    body,
  );

  renderNav();

  return {
    element: page,
    async load() {
      try {
        const data = await api.get('/api/me/settings');
        settings = data.settings;
        renderBody();
      } catch (err) {
        body.replaceChildren(emptyState({ iconName: 'warning', title: 'Falha ao carregar', message: err.message }));
      }
    },
    destroy() {
      page.replaceChildren();
      page.remove();
    },
  };
}

export { REPORT_CATEGORIES };
