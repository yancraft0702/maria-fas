-- Republicar uma LIVE (item 13).
--
-- A tabela `posts` ja aceitava `type = 'live'`, mas nao guardava QUAL sala.
-- Sem essa referencia o post de republicacao nao sabia dizer ao feed qual LIVE
-- linkar, e o cartao do feed caia no placeholder de "sem midia".
--
-- `live_room_id` e a sala referenciada. `ON DELETE SET NULL` porque a sala e
-- encerrada, nunca apagada em cascata de conteudo do usuario.
ALTER TABLE posts ADD COLUMN live_room_id TEXT REFERENCES live_rooms(id) ON DELETE SET NULL;

CREATE INDEX idx_posts_live_room ON posts(live_room_id);