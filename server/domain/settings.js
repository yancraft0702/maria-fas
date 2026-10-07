import { get, run } from '../db/index.js';
import { assertSettingsExist, getSettings, getNotificationSettings, getProfile } from './users.js';
import { AUDIENCE_VALUES } from './privacy.js';
import { recommendationSettings } from './recommend.js';
import { badRequest, ValidationError } from '../lib/errors.js';

export function fullSettings(userId) {
  assertSettingsExist(userId);
  const settings = getSettings(userId);
  const notifications = getNotificationSettings(userId);
  const profile = getProfile(userId);
  return {
    account: {
      language: settings.language,
      autoplay: Boolean(settings.autoplay),
      autoplayMuted: Boolean(settings.autoplay_muted),
      dataSaver: Boolean(settings.data_saver),
    },
    accessibility: {
      reduceMotion: Boolean(settings.reduce_motion),
      fontScale: settings.font_scale,
      highContrast: Boolean(settings.high_contrast),
      captionsDefault: Boolean(settings.captions_default),
      showLiveCaptions: Boolean(settings.show_live_captions),
    },
    playback: {
      defaultPostVisibility: settings.default_post_visibility,
    },
    content: {
      allowComments: Boolean(settings.allow_comments),
      allowDuets: Boolean(settings.allow_duets),
    },
    privacy: {
      accountPrivacy: profile.account_privacy,
      friendOnly: Boolean(profile.friend_only),
      whoCanFollow: profile.who_can_follow,
      whoCanComment: profile.who_can_comment,
      whoCanMessage: profile.who_can_message,
      whoCanMention: profile.who_can_mention,
      whoCanTag: profile.who_can_tag,
      whoCanSeeLikes: profile.who_can_see_likes,
      whoCanSeeReposts: profile.who_can_see_reposts,
      downloadAllowed: profile.download_allowed,
      remixAllowed: profile.remix_allowed,
      viewMode: profile.view_mode,
    },
    notifications: {
      likes: Boolean(notifications.likes),
      comments: Boolean(notifications.comments),
      replies: Boolean(notifications.replies),
      follows: Boolean(notifications.follows),
      mentions: Boolean(notifications.mentions),
      reposts: Boolean(notifications.reposts),
      messages: Boolean(notifications.messages),
      lives: Boolean(notifications.lives),
      activity: Boolean(notifications.activity),
      pushEnabled: Boolean(notifications.push_enabled),
    },
    recommendation: recommendationSettings(userId),
  };
}

const BOOLEAN_SETTINGS = {
  autoplay: 'autoplay',
  autoplayMuted: 'autoplay_muted',
  reduceMotion: 'reduce_motion',
  highContrast: 'high_contrast',
  captionsDefault: 'captions_default',
  showLiveCaptions: 'show_live_captions',
  dataSaver: 'data_saver',
  allowComments: 'allow_comments',
  allowDuets: 'allow_duets',
};

export function updateSettings(userId, changes) {
  assertSettingsExist(userId);
  // A ordem das chaves segue a ordem dos `?` da SQL: as colunas dinamicas de
  // SET vem primeiro; updated_at e user_id sao acrescentados no fim.
  const sets = [];
  const params = {};

  for (const [key, column] of Object.entries(BOOLEAN_SETTINGS)) {
    if (changes[key] !== undefined) {
      sets.push(`${column} = ?`);
      params[column] = changes[key] ? 1 : 0;
    }
  }
  if (changes.fontScale !== undefined) {
    const scale = Number(changes.fontScale);
    if (!Number.isFinite(scale) || scale < 0.85 || scale > 1.5) {
      throw new ValidationError([{ field: 'fontScale', message: 'Escala deve estar entre 0.85 e 1.5' }]);
    }
    sets.push('font_scale = ?');
    params.fontScale = scale;
  }
  if (changes.language !== undefined) {
    const lang = String(changes.language);
    if (!/^[a-z]{2}(-[A-Z]{2})?$/.test(lang)) {
      throw new ValidationError([{ field: 'language', message: 'Codigo de idioma invalido' }]);
    }
    sets.push('language = ?');
    params.language = lang;
  }
  if (changes.defaultPostVisibility !== undefined) {
    const value = String(changes.defaultPostVisibility);
    if (!['public', 'followers', 'friends', 'private'].includes(value)) {
      throw new ValidationError([{ field: 'defaultPostVisibility', message: 'Visibilidade invalida' }]);
    }
    sets.push('default_post_visibility = ?');
    params.defaultPostVisibility = value;
  }
  if (sets.length) {
    params.updatedAt = Date.now();
    params.userId = userId;
    run(`UPDATE settings SET ${sets.join(', ')}, updated_at = ? WHERE user_id = ?`, params);
  }
  return fullSettings(userId);
}

const PRIVACY_FIELDS = {
  accountPrivacy: { column: 'account_privacy', values: ['public', 'private'] },
  friendOnly: { column: 'friend_only', boolean: true },
  whoCanFollow: { column: 'who_can_follow', audience: true },
  whoCanComment: { column: 'who_can_comment', audience: true },
  whoCanMessage: { column: 'who_can_message', audience: true },
  whoCanMention: { column: 'who_can_mention', audience: true },
  whoCanTag: { column: 'who_can_tag', audience: true },
  whoCanSeeLikes: { column: 'who_can_see_likes', audience: true },
  whoCanSeeReposts: { column: 'who_can_see_reposts', audience: true },
  downloadAllowed: { column: 'download_allowed', audience: true },
  remixAllowed: { column: 'remix_allowed', audience: true },
  viewMode: { column: 'view_mode', audience: true },
};

export function updatePrivacy(userId, changes) {
  assertSettingsExist(userId);
  // A ordem das chaves segue a ordem dos `?` da SQL (updated_at e user_id vao
  // no fim, como no UPDATE).
  const sets = [];
  const params = {};
  const errors = [];

  for (const [key, spec] of Object.entries(PRIVACY_FIELDS)) {
    if (changes[key] === undefined) continue;
    const value = changes[key];
    if (spec.boolean) {
      sets.push(`${spec.column} = ?`);
      params[spec.column] = value ? 1 : 0;
      continue;
    }
    if (spec.audience) {
      if (!AUDIENCE_VALUES.includes(String(value))) {
        errors.push({ field: key, message: `Valor invalido. Permitidos: ${AUDIENCE_VALUES.join(', ')}` });
        continue;
      }
      sets.push(`${spec.column} = ?`);
      params[spec.column] = String(value);
      continue;
    }
    if (!spec.values.includes(String(value))) {
      errors.push({ field: key, message: `Valor invalido. Permitidos: ${spec.values.join(', ')}` });
      continue;
    }
    sets.push(`${spec.column} = ?`);
    params[spec.column] = String(value);
  }

  if (errors.length) throw new ValidationError(errors);
  if (sets.length) {
    params.updatedAt = Date.now();
    params.userId = userId;
    run(`UPDATE profiles SET ${sets.join(', ')}, updated_at = ? WHERE user_id = ?`, params);
  }
  return fullSettings(userId);
}

/** Arquivo/exportacao de dados do proprio usuario. */
export function dataExport(userId) {
  assertSettingsExist(userId);
  const user = get('SELECT email, username, display_name, bio, website, location, role, status, created_at, totp_enabled FROM users WHERE id = ?', { userId });
  return {
    exportedAt: new Date().toISOString(),
    version: 1,
    account: user,
    settings: fullSettings(userId),
  };
}

/** Apaga a conta e os dados pessoais (direito de exclusao). */
export function requestAccountDeletion(userId, { passwordConfirmed = false } = {}) {
  const user = get('SELECT status FROM users WHERE id = ?', { userId });
  if (!user) throw badRequest('user_not_found', 'Usuario nao encontrado');
  if (user.status === 'deleted') return { alreadyDeleted: true };
  return { eligible: true, userId, confirmed: Boolean(passwordConfirmed) };
}

export function privacyDefaults() {
  return {
    accountPrivacy: 'public',
    friendOnly: false,
    whoCanFollow: 'everyone',
    whoCanComment: 'everyone',
    whoCanMessage: 'everyone',
    whoCanMention: 'everyone',
    whoCanTag: 'everyone',
    whoCanSeeLikes: 'everyone',
    whoCanSeeReposts: 'everyone',
    downloadAllowed: 'everyone',
    remixAllowed: 'everyone',
    viewMode: 'everyone',
  };
}
