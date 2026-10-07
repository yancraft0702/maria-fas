-- Comentarios com anexo (GIF, figurinha, imagem, audio e video).
--
-- Antes um comentario aceita APENAS texto: `body` era NOT NULL e a rota exigia
-- `min: 1`, entao escolher um GIF ou uma figurinha respondia "Campo
-- obrigatorio" e o anexo nunca era enviado. Agora o comentario segue o mesmo
-- modelo de `messages`: `type` diz o que e, `media_id` aponta para o arquivo
-- enviado pelo usuario e `metadata_json` guarda a origem do GIF (URL da GIPHY,
-- que e externa e nao vive na tabela `media`).
--
-- `body` continua NOT NULL: um comentario sem texto e sem anexo passa a ser
-- gravado com string vazia, e a validacao rejeita esse caso (nao ha conteudo).

ALTER TABLE comments ADD COLUMN type TEXT NOT NULL DEFAULT 'text'
  CHECK (type IN ('text','emoji','gif','sticker','image','video','audio'));

-- Anexo enviado pelo usuario (foto, audio, video, figurinha enviada).
ALTER TABLE comments ADD COLUMN media_id TEXT REFERENCES media(id) ON DELETE SET NULL;

-- Dados minimos do GIF (URL externa da GIPHY + id), no mesmo formato de
-- `messages.metadata_json`.
ALTER TABLE comments ADD COLUMN metadata_json TEXT NOT NULL DEFAULT '{}';

CREATE INDEX idx_comments_media ON comments(media_id);