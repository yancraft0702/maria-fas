-- Item 16: publicar SOMENTE audio.
--
-- CAUSA RAIZ do 500: a rota e o dominio ja aceitavam `type = 'audio'`, mas o
-- CHECK da tabela `posts` (migracao 0001) era
--     CHECK (type IN ('video','image','text','repost','live'))
-- e nao tinha 'audio'. O INSERT era rejeitado pelo proprio banco e a rota
-- devolvia 500 "Erro interno do servidor" - sem nenhuma pista do motivo.
--
-- SQLite nao permite alterar CHECK; a correcao correta e reconstruir a tabela.
-- A migracao abaixo:
--  1. cria `posts` nova com o CHECK ampliado (e com `live_room_id` da 0004);
--  2. copia TODOS os dados;
--  3. remove a tabela antiga e renomeia a nova.
--
-- Os dados sao copiados antes do drop: nenhum post e perde.

PRAGMA foreign_keys = OFF;

CREATE TABLE posts_novo (
  id                TEXT PRIMARY KEY,
  author_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  media_id          TEXT REFERENCES media(id) ON DELETE SET NULL,
  -- 'audio' entrou: publicar so um audio e uma publicacao valida (item 16).
  type              TEXT NOT NULL CHECK (type IN ('video','image','audio','text','repost','live')),
  caption           TEXT NOT NULL DEFAULT '',
  visibility        TEXT NOT NULL DEFAULT 'public'
                    CHECK (visibility IN ('public','followers','friends','private')),
  comments_enabled  INTEGER NOT NULL DEFAULT 1,
  download_allowed  TEXT NOT NULL DEFAULT 'everyone',
  remix_allowed     TEXT NOT NULL DEFAULT 'everyone',
  duet_allowed      INTEGER NOT NULL DEFAULT 1,
  location          TEXT NOT NULL DEFAULT '',
  sound_id          TEXT REFERENCES sounds(id) ON DELETE SET NULL,
  repost_of_id      TEXT REFERENCES posts(id) ON DELETE CASCADE,
  -- Referencia da sala (migracao 0004) mantida no rebuild.
  live_room_id      TEXT REFERENCES live_rooms(id) ON DELETE SET NULL,
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

INSERT INTO posts_novo (
  id, author_id, media_id, type, caption, visibility, comments_enabled,
  download_allowed, remix_allowed, duet_allowed, location, sound_id,
  repost_of_id, live_room_id, comment_count, like_count, repost_count,
  view_count, share_count, status, is_ad, created_at, updated_at,
  published_at, deleted_at
)
SELECT
  id, author_id, media_id, type, caption, visibility, comments_enabled,
  download_allowed, remix_allowed, duet_allowed, location, sound_id,
  repost_of_id, live_room_id, comment_count, like_count, repost_count,
  view_count, share_count, status, is_ad, created_at, updated_at,
  published_at, deleted_at
FROM posts;

DROP TABLE posts;
ALTER TABLE posts_novo RENAME TO posts;

CREATE INDEX idx_posts_author ON posts(author_id, status, created_at DESC);
CREATE INDEX idx_posts_feed ON posts(status, visibility, published_at DESC);
CREATE INDEX idx_posts_repost ON posts(repost_of_id);
CREATE INDEX idx_posts_live_room ON posts(live_room_id);

PRAGMA foreign_keys = ON;