-- ===========================================================================
-- MARIA FÃS - schema inicial (migracao 0001)
-- ===========================================================================

CREATE TABLE users (
  id                TEXT PRIMARY KEY,
  email             TEXT NOT NULL,
  email_normalized  TEXT NOT NULL UNIQUE,
  username          TEXT NOT NULL,
  username_norm     TEXT NOT NULL UNIQUE,
  display_name      TEXT NOT NULL,
  bio               TEXT NOT NULL DEFAULT '',
  website           TEXT NOT NULL DEFAULT '',
  location          TEXT NOT NULL DEFAULT '',
  avatar_key        TEXT,
  cover_key         TEXT,
  avatar_version    INTEGER NOT NULL DEFAULT 0,
  password_hash     TEXT NOT NULL,
  role              TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user','moderator','admin')),
  status            TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','banned','deleted')),
  status_reason     TEXT,
  status_until      INTEGER,
  email_verified    INTEGER NOT NULL DEFAULT 0,
  totp_secret       TEXT,
  totp_enabled      INTEGER NOT NULL DEFAULT 0,
  recovery_codes    TEXT,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  last_seen_at      INTEGER,
  deleted_at        INTEGER
);
CREATE INDEX idx_users_status ON users(status);
CREATE INDEX idx_users_role ON users(role);

CREATE TABLE profiles (
  user_id           TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  account_privacy   TEXT NOT NULL DEFAULT 'public' CHECK (account_privacy IN ('public','private')),
  friend_only       INTEGER NOT NULL DEFAULT 0,
  who_can_follow    TEXT NOT NULL DEFAULT 'everyone',
  who_can_comment   TEXT NOT NULL DEFAULT 'everyone',
  who_can_message   TEXT NOT NULL DEFAULT 'everyone',
  who_can_mention   TEXT NOT NULL DEFAULT 'everyone',
  who_can_tag       TEXT NOT NULL DEFAULT 'everyone',
  who_can_see_likes TEXT NOT NULL DEFAULT 'everyone',
  who_can_see_reposts TEXT NOT NULL DEFAULT 'everyone',
  download_allowed  TEXT NOT NULL DEFAULT 'everyone',
  remix_allowed     TEXT NOT NULL DEFAULT 'everyone',
  view_mode         TEXT NOT NULL DEFAULT 'everyone',
  updated_at        INTEGER NOT NULL
);

CREATE TABLE sessions (
  id                TEXT PRIMARY KEY,
  user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash        TEXT NOT NULL UNIQUE,
  csrf_token        TEXT NOT NULL,
  device_id         TEXT,
  user_agent        TEXT NOT NULL DEFAULT '',
  ip                TEXT NOT NULL DEFAULT '',
  created_at        INTEGER NOT NULL,
  last_used_at      INTEGER NOT NULL,
  expires_at        INTEGER NOT NULL,
  revoked_at        INTEGER,
  revoked_reason    TEXT
);
CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_sessions_token ON sessions(token_hash);

CREATE TABLE devices (
  id                TEXT PRIMARY KEY,
  user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_label      TEXT NOT NULL DEFAULT '',
  device_type       TEXT NOT NULL DEFAULT 'other',
  push_enabled      INTEGER NOT NULL DEFAULT 0,
  last_used_at      INTEGER NOT NULL,
  created_at        INTEGER NOT NULL
);
CREATE INDEX idx_devices_user ON devices(user_id);

CREATE TABLE push_subscriptions (
  id                TEXT PRIMARY KEY,
  user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id         TEXT REFERENCES devices(id) ON DELETE SET NULL,
  endpoint          TEXT NOT NULL UNIQUE,
  p256dh            TEXT NOT NULL,
  auth              TEXT NOT NULL,
  created_at        INTEGER NOT NULL,
  last_used_at      INTEGER NOT NULL,
  failure_count     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_push_user ON push_subscriptions(user_id);

CREATE TABLE password_resets (
  id                TEXT PRIMARY KEY,
  user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash        TEXT NOT NULL UNIQUE,
  created_at        INTEGER NOT NULL,
  expires_at        INTEGER NOT NULL,
  used_at           INTEGER
);

-- ------------------------------- MIDIA ------------------------------------
CREATE TABLE media (
  id                TEXT PRIMARY KEY,
  owner_id          TEXT REFERENCES users(id) ON DELETE CASCADE,
  kind              TEXT NOT NULL CHECK (kind IN ('video','image','audio','file','sticker','effect','thumbnail')),
  bucket            TEXT NOT NULL,
  storage_key       TEXT NOT NULL UNIQUE,
  original_name     TEXT NOT NULL DEFAULT '',
  mime              TEXT NOT NULL,
  size              INTEGER NOT NULL,
  width             INTEGER,
  height            INTEGER,
  duration_ms       INTEGER,
  has_audio         INTEGER NOT NULL DEFAULT 0,
  checksum          TEXT,
  status            TEXT NOT NULL DEFAULT 'ready' CHECK (status IN ('pending','processing','ready','failed')),
  processing_error  TEXT,
  meta_json         TEXT NOT NULL DEFAULT '{}',
  created_at        INTEGER NOT NULL,
  deleted_at        INTEGER
);
CREATE INDEX idx_media_owner ON media(owner_id);
CREATE INDEX idx_media_status ON media(status);
CREATE INDEX idx_media_kind ON media(kind);

CREATE TABLE video_renditions (
  id                TEXT PRIMARY KEY,
  media_id          TEXT NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  label             TEXT NOT NULL,
  width             INTEGER NOT NULL,
  height            INTEGER NOT NULL,
  bitrate           INTEGER NOT NULL,
  bucket            TEXT NOT NULL,
  storage_key       TEXT NOT NULL UNIQUE,
  size              INTEGER NOT NULL,
  mime              TEXT NOT NULL,
  created_at        INTEGER NOT NULL,
  UNIQUE (media_id, label)
);

CREATE TABLE hls_manifests (
  id                TEXT PRIMARY KEY,
  media_id          TEXT NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  bucket            TEXT NOT NULL,
  storage_key       TEXT NOT NULL UNIQUE,
  duration_ms       INTEGER NOT NULL DEFAULT 0,
  created_at        INTEGER NOT NULL
);

-- ------------------------------- POSTS ------------------------------------
CREATE TABLE posts (
  id                TEXT PRIMARY KEY,
  author_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  media_id          TEXT REFERENCES media(id) ON DELETE SET NULL,
  type              TEXT NOT NULL CHECK (type IN ('video','image','text','repost','live')),
  caption           TEXT NOT NULL DEFAULT '',
  visibility        TEXT NOT NULL DEFAULT 'public'
                    CHECK (visibility IN ('public','followers','friends','private')),
  comments_enabled  INTEGER NOT NULL DEFAULT 1,
  download_allowed TEXT NOT NULL DEFAULT 'everyone',
  remix_allowed     TEXT NOT NULL DEFAULT 'everyone',
  duet_allowed      INTEGER NOT NULL DEFAULT 1,
  location          TEXT NOT NULL DEFAULT '',
  sound_id          TEXT REFERENCES sounds(id) ON DELETE SET NULL,
  repost_of_id      TEXT REFERENCES posts(id) ON DELETE CASCADE,
  comment_count     INTEGER NOT NULL DEFAULT 0,
  like_count        INTEGER NOT NULL DEFAULT 0,
  repost_count      INTEGER NOT NULL DEFAULT 0,
  view_count        INTEGER NOT NULL DEFAULT 0,
  share_count       INTEGER NOT NULL DEFAULT 0,
  status            TEXT NOT NULL DEFAULT 'published'
                    CHECK (status IN ('published','draft','processing','failed','deleted')),
  is_ad             INTEGER NOT NULL DEFAULT 0,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  published_at      INTEGER,
  deleted_at        INTEGER
);
CREATE INDEX idx_posts_author ON posts(author_id, status, created_at DESC);
CREATE INDEX idx_posts_feed ON posts(status, visibility, published_at DESC);
CREATE INDEX idx_posts_repost ON posts(repost_of_id);

CREATE TABLE drafts (
  id                TEXT PRIMARY KEY,
  user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  payload_json      TEXT NOT NULL,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);
CREATE INDEX idx_drafts_user ON drafts(user_id, updated_at DESC);

CREATE TABLE post_hashtags (
  post_id           TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  hashtag_id        TEXT NOT NULL REFERENCES hashtags(id) ON DELETE CASCADE,
  position          INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (post_id, hashtag_id)
);
CREATE INDEX idx_post_hashtags_tag ON post_hashtags(hashtag_id);

CREATE TABLE hashtags (
  id                TEXT PRIMARY KEY,
  tag               TEXT NOT NULL UNIQUE,
  use_count         INTEGER NOT NULL DEFAULT 0,
  view_count        INTEGER NOT NULL DEFAULT 0,
  created_at        INTEGER NOT NULL
);

CREATE TABLE sounds (
  id                TEXT PRIMARY KEY,
  title             TEXT NOT NULL,
  artist            TEXT NOT NULL DEFAULT '',
  media_id          TEXT REFERENCES media(id) ON DELETE SET NULL,
  is_original       INTEGER NOT NULL DEFAULT 0,
  license           TEXT NOT NULL DEFAULT 'platform',
  duration_ms       INTEGER NOT NULL DEFAULT 0,
  use_count         INTEGER NOT NULL DEFAULT 0,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);
CREATE INDEX idx_sounds_title ON sounds(title);

CREATE TABLE post_sounds (
  post_id           TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  sound_id          TEXT NOT NULL REFERENCES sounds(id) ON DELETE CASCADE,
  offset_ms         INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (post_id, sound_id)
);

CREATE TABLE sound_saves (
  user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sound_id          TEXT NOT NULL REFERENCES sounds(id) ON DELETE CASCADE,
  created_at        INTEGER NOT NULL,
  PRIMARY KEY (user_id, sound_id)
);

CREATE TABLE mentions (
  post_id           TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (post_id, user_id)
);

-- ------------------------------ INTERACOES --------------------------------
CREATE TABLE likes (
  user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  post_id           TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  created_at        INTEGER NOT NULL,
  PRIMARY KEY (user_id, post_id)
);
CREATE INDEX idx_likes_post ON likes(post_id);

CREATE TABLE comments (
  id                TEXT PRIMARY KEY,
  post_id           TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  author_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  parent_id         TEXT REFERENCES comments(id) ON DELETE CASCADE,
  body              TEXT NOT NULL,
  like_count        INTEGER NOT NULL DEFAULT 0,
  reply_count       INTEGER NOT NULL DEFAULT 0,
  status            TEXT NOT NULL DEFAULT 'published'
                    CHECK (status IN ('published','deleted','hidden')),
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  deleted_at        INTEGER
);
CREATE INDEX idx_comments_post ON comments(post_id, created_at DESC);
CREATE INDEX idx_comments_parent ON comments(parent_id);

CREATE TABLE comment_likes (
  user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  comment_id        TEXT NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
  created_at        INTEGER NOT NULL,
  PRIMARY KEY (user_id, comment_id)
);

CREATE TABLE comment_mentions (
  comment_id        TEXT NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
  user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (comment_id, user_id)
);

CREATE TABLE reposts (
  id                TEXT PRIMARY KEY,
  user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  post_id           TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  comment           TEXT NOT NULL DEFAULT '',
  created_at        INTEGER NOT NULL,
  UNIQUE (user_id, post_id)
);
CREATE INDEX idx_reposts_post ON reposts(post_id);
CREATE INDEX idx_reposts_user ON reposts(user_id, created_at DESC);

CREATE TABLE favorites (
  user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  post_id           TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  created_at        INTEGER NOT NULL,
  PRIMARY KEY (user_id, post_id)
);
CREATE INDEX idx_favorites_user ON favorites(user_id, created_at DESC);

CREATE TABLE collections (
  id                TEXT PRIMARY KEY,
  user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name              TEXT NOT NULL,
  description       TEXT NOT NULL DEFAULT '',
  privacy           TEXT NOT NULL DEFAULT 'private'
                    CHECK (privacy IN ('public','private','followers')),
  cover_key         TEXT,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);
CREATE INDEX idx_collections_user ON collections(user_id);

CREATE TABLE collection_items (
  collection_id     TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  post_id           TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  position          INTEGER NOT NULL DEFAULT 0,
  created_at        INTEGER NOT NULL,
  PRIMARY KEY (collection_id, post_id)
);

CREATE TABLE follows (
  follower_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  followee_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status            TEXT NOT NULL DEFAULT 'accepted'
                    CHECK (status IN ('accepted','pending')),
  created_at        INTEGER NOT NULL,
  PRIMARY KEY (follower_id, followee_id),
  CHECK (follower_id <> followee_id)
);
CREATE INDEX idx_follows_followee ON follows(followee_id);

CREATE TABLE friendships (
  user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  friend_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at        INTEGER NOT NULL,
  PRIMARY KEY (user_id, friend_id),
  CHECK (user_id <> friend_id)
);

CREATE TABLE blocks (
  blocker_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at        INTEGER NOT NULL,
  PRIMARY KEY (blocker_id, blocked_id),
  CHECK (blocker_id <> blocked_id)
);

CREATE TABLE mutes (
  user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_type       TEXT NOT NULL CHECK (target_type IN ('user','post','sound','hashtag','chat')),
  target_id         TEXT NOT NULL,
  created_at        INTEGER NOT NULL,
  PRIMARY KEY (user_id, target_type, target_id)
);

CREATE TABLE hidden_posts (
  user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  post_id           TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  reason            TEXT NOT NULL DEFAULT 'not_interested',
  created_at        INTEGER NOT NULL,
  PRIMARY KEY (user_id, post_id)
);

CREATE TABLE watch_events (
  id                TEXT PRIMARY KEY,
  user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  post_id           TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  watch_ms          INTEGER NOT NULL DEFAULT 0,
  completed         INTEGER NOT NULL DEFAULT 0,
  replays           INTEGER NOT NULL DEFAULT 0,
  skipped           INTEGER NOT NULL DEFAULT 0,
  liked             INTEGER NOT NULL DEFAULT 0,
  commented         INTEGER NOT NULL DEFAULT 0,
  shared            INTEGER NOT NULL DEFAULT 0,
  favorited         INTEGER NOT NULL DEFAULT 0,
  reposted          INTEGER NOT NULL DEFAULT 0,
  followed_author   INTEGER NOT NULL DEFAULT 0,
  profile_visited   INTEGER NOT NULL DEFAULT 0,
  created_at        INTEGER NOT NULL
);
CREATE INDEX idx_watch_user ON watch_events(user_id, created_at DESC);
CREATE INDEX idx_watch_post ON watch_events(post_id);

CREATE TABLE user_interests (
  user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind              TEXT NOT NULL CHECK (kind IN ('hashtag','sound','category','language')),
  value             TEXT NOT NULL,
  weight            REAL NOT NULL DEFAULT 1,
  updated_at        INTEGER NOT NULL,
  PRIMARY KEY (user_id, kind, value)
);

CREATE TABLE recommendation_settings (
  user_id           TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  opt_out           INTEGER NOT NULL DEFAULT 0,
  reduced_mode      INTEGER NOT NULL DEFAULT 0,
  preferred_language TEXT NOT NULL DEFAULT 'pt',
  blocked_categories TEXT NOT NULL DEFAULT '[]',
  reset_at          INTEGER
);

-- ------------------------------- STORIES ----------------------------------
CREATE TABLE stories (
  id                TEXT PRIMARY KEY,
  author_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  media_id          TEXT REFERENCES media(id) ON DELETE SET NULL,
  type              TEXT NOT NULL CHECK (type IN ('image','video','text')),
  text              TEXT NOT NULL DEFAULT '',
  background        TEXT NOT NULL DEFAULT '#111111',
  duration_ms       INTEGER NOT NULL DEFAULT 5000,
  sound_id          TEXT REFERENCES sounds(id) ON DELETE SET NULL,
  view_count        INTEGER NOT NULL DEFAULT 0,
  status            TEXT NOT NULL DEFAULT 'published'
                    CHECK (status IN ('published','expired','deleted')),
  created_at        INTEGER NOT NULL,
  expires_at        INTEGER NOT NULL,
  deleted_at        INTEGER
);
CREATE INDEX idx_stories_author ON stories(author_id, created_at DESC);
CREATE INDEX idx_stories_expiry ON stories(status, expires_at);

CREATE TABLE story_views (
  story_id          TEXT NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  viewer_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  seen_at           INTEGER NOT NULL,
  PRIMARY KEY (story_id, viewer_id)
);

CREATE TABLE story_replies (
  id                TEXT PRIMARY KEY,
  story_id          TEXT NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  author_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body              TEXT NOT NULL DEFAULT '',
  reaction          TEXT NOT NULL DEFAULT '',
  created_at        INTEGER NOT NULL
);

-- ------------------------------ NOTIFICACOES ------------------------------
CREATE TABLE notifications (
  id                TEXT PRIMARY KEY,
  user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  actor_id          TEXT REFERENCES users(id) ON DELETE CASCADE,
  type              TEXT NOT NULL,
  entity_type       TEXT NOT NULL DEFAULT '',
  entity_id         TEXT NOT NULL DEFAULT '',
  body              TEXT NOT NULL DEFAULT '',
  payload_json      TEXT NOT NULL DEFAULT '{}',
  read_at           INTEGER,
  created_at        INTEGER NOT NULL
);
CREATE INDEX idx_notifications_user ON notifications(user_id, created_at DESC);

CREATE TABLE notification_settings (
  user_id           TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  likes             INTEGER NOT NULL DEFAULT 1,
  comments          INTEGER NOT NULL DEFAULT 1,
  replies           INTEGER NOT NULL DEFAULT 1,
  follows           INTEGER NOT NULL DEFAULT 1,
  mentions          INTEGER NOT NULL DEFAULT 1,
  reposts           INTEGER NOT NULL DEFAULT 1,
  messages          INTEGER NOT NULL DEFAULT 1,
  lives             INTEGER NOT NULL DEFAULT 1,
  activity          INTEGER NOT NULL DEFAULT 1,
  push_enabled      INTEGER NOT NULL DEFAULT 1,
  updated_at        INTEGER NOT NULL
);

-- --------------------------------- CHAT -----------------------------------
CREATE TABLE conversations (
  id                TEXT PRIMARY KEY,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  last_message_id   TEXT
);

CREATE TABLE conversation_members (
  conversation_id   TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_at         INTEGER NOT NULL,
  last_read_message_id TEXT,
  last_read_at      INTEGER,
  muted             INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (conversation_id, user_id)
);
CREATE INDEX idx_conv_members_user ON conversation_members(user_id);

CREATE TABLE messages (
  id                TEXT PRIMARY KEY,
  conversation_id   TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type              TEXT NOT NULL
                    CHECK (type IN ('text','emoji','gif','sticker','image','video','audio','file','repost','effect','system')),
  body              TEXT NOT NULL DEFAULT '',
  media_id          TEXT REFERENCES media(id) ON DELETE SET NULL,
  repost_post_id    TEXT REFERENCES posts(id) ON DELETE SET NULL,
  reply_to_id       TEXT REFERENCES messages(id) ON DELETE SET NULL,
  effect_id         TEXT REFERENCES effects(id) ON DELETE SET NULL,
  metadata_json     TEXT NOT NULL DEFAULT '{}',
  status            TEXT NOT NULL DEFAULT 'sent' CHECK (status IN ('sent','deleted')),
  created_at        INTEGER NOT NULL,
  edited_at         INTEGER,
  deleted_at        INTEGER,
  client_event_id   TEXT
);
CREATE INDEX idx_messages_conv ON messages(conversation_id, created_at DESC);
CREATE UNIQUE INDEX idx_messages_client_event ON messages(conversation_id, sender_id, client_event_id)
  WHERE client_event_id IS NOT NULL;

CREATE TABLE message_reads (
  message_id        TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  read_at           INTEGER NOT NULL,
  PRIMARY KEY (message_id, user_id)
);

CREATE TABLE global_chat (
  id                TEXT PRIMARY KEY,
  user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type              TEXT NOT NULL
                    CHECK (type IN ('text','emoji','gif','sticker','image','video','audio','file','repost','effect','system')),
  body              TEXT NOT NULL DEFAULT '',
  media_id          TEXT REFERENCES media(id) ON DELETE SET NULL,
  repost_post_id    TEXT REFERENCES posts(id) ON DELETE SET NULL,
  effect_id         TEXT REFERENCES effects(id) ON DELETE SET NULL,
  metadata_json     TEXT NOT NULL DEFAULT '{}',
  status            TEXT NOT NULL DEFAULT 'sent' CHECK (status IN ('sent','deleted')),
  created_at        INTEGER NOT NULL,
  deleted_at        INTEGER,
  client_event_id   TEXT
);
CREATE INDEX idx_global_chat_time ON global_chat(created_at DESC);
CREATE UNIQUE INDEX idx_global_chat_client_event ON global_chat(user_id, client_event_id)
  WHERE client_event_id IS NOT NULL;

CREATE TABLE global_chat_reactions (
  message_id        TEXT NOT NULL REFERENCES global_chat(id) ON DELETE CASCADE,
  user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reaction          TEXT NOT NULL,
  created_at        INTEGER NOT NULL,
  PRIMARY KEY (message_id, user_id, reaction)
);

-- --------------------------------- LIVE -----------------------------------
CREATE TABLE live_rooms (
  id                TEXT PRIMARY KEY,
  host_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title             TEXT NOT NULL DEFAULT '',
  cover_media_id    TEXT REFERENCES media(id) ON DELETE SET NULL,
  category          TEXT NOT NULL DEFAULT 'geral',
  status            TEXT NOT NULL DEFAULT 'live'
                    CHECK (status IN ('live','ended','banned')),
  started_at        INTEGER NOT NULL,
  ended_at          INTEGER,
  peak_viewers      INTEGER NOT NULL DEFAULT 0,
  total_views       INTEGER NOT NULL DEFAULT 0,
  heart_count       INTEGER NOT NULL DEFAULT 0,
  comment_count     INTEGER NOT NULL DEFAULT 0,
  effect_count      INTEGER NOT NULL DEFAULT 0,
  ended_reason      TEXT
);
CREATE INDEX idx_live_rooms_host ON live_rooms(host_id, started_at DESC);
CREATE INDEX idx_live_rooms_status ON live_rooms(status, started_at DESC);

CREATE TABLE live_participants (
  id                TEXT PRIMARY KEY,
  room_id           TEXT NOT NULL REFERENCES live_rooms(id) ON DELETE CASCADE,
  user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role              TEXT NOT NULL DEFAULT 'viewer' CHECK (role IN ('host','moderator','viewer')),
  is_moderator      INTEGER NOT NULL DEFAULT 0,
  joined_at         INTEGER NOT NULL,
  left_at           INTEGER,
  disconnect_count  INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX idx_live_participant_active
  ON live_participants(room_id, user_id) WHERE left_at IS NULL;
CREATE INDEX idx_live_participants_room ON live_participants(room_id);

CREATE TABLE live_messages (
  id                TEXT PRIMARY KEY,
  room_id           TEXT NOT NULL REFERENCES live_rooms(id) ON DELETE CASCADE,
  user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body              TEXT NOT NULL DEFAULT '',
  created_at        INTEGER NOT NULL,
  deleted_at        INTEGER
);
CREATE INDEX idx_live_messages_room ON live_messages(room_id, created_at DESC);

CREATE TABLE live_likes (
  id                TEXT PRIMARY KEY,
  room_id           TEXT NOT NULL REFERENCES live_rooms(id) ON DELETE CASCADE,
  user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  quantity          INTEGER NOT NULL DEFAULT 1,
  created_at        INTEGER NOT NULL
);
CREATE INDEX idx_live_likes_room ON live_likes(room_id, created_at DESC);

-- -------------------------------- EFEITOS ---------------------------------
CREATE TABLE effects (
  id                TEXT PRIMARY KEY,
  slug              TEXT NOT NULL UNIQUE,
  name              TEXT NOT NULL,
  emoji             TEXT NOT NULL DEFAULT '',
  media_id          TEXT REFERENCES media(id) ON DELETE SET NULL,
  alpha_ready       INTEGER NOT NULL DEFAULT 0,
  duration_ms       INTEGER NOT NULL DEFAULT 5000,
  position          TEXT NOT NULL DEFAULT 'bottom-right',
  scale             REAL NOT NULL DEFAULT 0.55,
  requires_alpha    INTEGER NOT NULL DEFAULT 1,
  enabled           INTEGER NOT NULL DEFAULT 1,
  min_role          TEXT NOT NULL DEFAULT 'user',
  created_at        INTEGER NOT NULL
);

CREATE TABLE effect_events (
  id                TEXT PRIMARY KEY,
  room_id           TEXT NOT NULL REFERENCES live_rooms(id) ON DELETE CASCADE,
  effect_id         TEXT NOT NULL REFERENCES effects(id) ON DELETE CASCADE,
  user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sequence          INTEGER NOT NULL,
  client_event_id   TEXT,
  created_at        INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_effect_event_dedupe ON effect_events(room_id, user_id, client_event_id)
  WHERE client_event_id IS NOT NULL;
CREATE INDEX idx_effect_events_room ON effect_events(room_id, sequence DESC);

CREATE TABLE effect_usage_daily (
  user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day               TEXT NOT NULL,
  count             INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day)
);

-- ----------------------------- MODERACAO ----------------------------------
CREATE TABLE reports (
  id                TEXT PRIMARY KEY,
  reporter_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_type       TEXT NOT NULL CHECK (target_type IN ('user','post','comment','message','live','sound','story')),
  target_id         TEXT NOT NULL,
  category          TEXT NOT NULL,
  details           TEXT NOT NULL DEFAULT '',
  status            TEXT NOT NULL DEFAULT 'open'
                    CHECK (status IN ('open','reviewing','resolved','rejected')),
  assigned_to       TEXT REFERENCES users(id) ON DELETE SET NULL,
  resolution        TEXT NOT NULL DEFAULT '',
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  resolved_at       INTEGER
);
CREATE INDEX idx_reports_status ON reports(status, created_at DESC);
CREATE UNIQUE INDEX idx_reports_reporter_target ON reports(reporter_id, target_type, target_id);

CREATE TABLE moderation_actions (
  id                TEXT PRIMARY KEY,
  moderator_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  action            TEXT NOT NULL,
  target_type       TEXT NOT NULL,
  target_id         TEXT NOT NULL,
  reason            TEXT NOT NULL DEFAULT '',
  details_json      TEXT NOT NULL DEFAULT '{}',
  created_at        INTEGER NOT NULL
);
CREATE INDEX idx_mod_actions_target ON moderation_actions(target_type, target_id);
CREATE INDEX idx_mod_actions_time ON moderation_actions(created_at DESC);

CREATE TABLE user_warnings (
  id                TEXT PRIMARY KEY,
  user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  moderator_id      TEXT REFERENCES users(id) ON DELETE SET NULL,
  category          TEXT NOT NULL,
  message           TEXT NOT NULL DEFAULT '',
  created_at        INTEGER NOT NULL
);

-- ------------------------------- SETTINGS ---------------------------------
CREATE TABLE settings (
  user_id           TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  language          TEXT NOT NULL DEFAULT 'pt-BR',
  autoplay          INTEGER NOT NULL DEFAULT 1,
  autoplay_muted    INTEGER NOT NULL DEFAULT 1,
  reduce_motion     INTEGER NOT NULL DEFAULT 0,
  font_scale        REAL NOT NULL DEFAULT 1,
  high_contrast     INTEGER NOT NULL DEFAULT 0,
  captions_default  INTEGER NOT NULL DEFAULT 1,
  show_live_captions INTEGER NOT NULL DEFAULT 0,
  data_saver        INTEGER NOT NULL DEFAULT 0,
  default_post_visibility TEXT NOT NULL DEFAULT 'public',
  allow_comments    INTEGER NOT NULL DEFAULT 1,
  allow_duets       INTEGER NOT NULL DEFAULT 1,
  updated_at        INTEGER NOT NULL
);

CREATE TABLE audit_log (
  id                TEXT PRIMARY KEY,
  request_id        TEXT NOT NULL DEFAULT '',
  user_id           TEXT,
  method            TEXT NOT NULL DEFAULT '',
  path              TEXT NOT NULL DEFAULT '',
  status            INTEGER NOT NULL DEFAULT 0,
  duration_ms       INTEGER NOT NULL DEFAULT 0,
  ip                TEXT NOT NULL DEFAULT '',
  error_code        TEXT,
  created_at        INTEGER NOT NULL
);
CREATE INDEX idx_audit_user ON audit_log(user_id, created_at DESC);
CREATE INDEX idx_audit_time ON audit_log(created_at DESC);

CREATE TABLE idempotency_keys (
  key               TEXT NOT NULL,
  user_id           TEXT NOT NULL,
  scope             TEXT NOT NULL,
  response_json     TEXT NOT NULL,
  created_at        INTEGER NOT NULL,
  PRIMARY KEY (key, user_id, scope)
);
