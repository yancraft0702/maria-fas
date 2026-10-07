-- Item 9: som do efeito da LIVE.
--
-- ate aqui o catalogo so guardava `media_id` (o arquivo VISUAL do efeito) e
-- nenhum dos 15 efeitos tinha som. `sound_id` aponta para o arquivo de audio
-- real do efeito, no mesmo bucket de midia. E NULL quando o efeito nao tem som:
-- nesse caso a API responde `hasAudio: false` e o cliente NAO toca nada -
-- nada de fingir som que nao existe.
ALTER TABLE effects ADD COLUMN sound_id TEXT REFERENCES media(id) ON DELETE SET NULL;

CREATE INDEX idx_effects_sound ON effects(sound_id) WHERE sound_id IS NOT NULL;