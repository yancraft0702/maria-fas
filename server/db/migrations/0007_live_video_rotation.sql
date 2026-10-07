-- Orientacao do quadro da LIVE (item: enquadramento natural da camera).
--
-- Quando a camera do anfitriao so entrega LANDSCAPE e a tela e portrait, o
-- quadro e girado 90 graus para caber em tela cheia vertical sem zoom e sem
-- crop. A DIRECAO (90 ou 270) e escolhida pelo anfitriao e nao da para deduzir
-- de nenhum numero: ela depende de como aquele aparelho orienta o buffer.
--
-- Esse dado precisa sobreviver a quem entra DEPOIS: o fanout do realtime e em
-- tempo real, e um espectador que abre a LIVE no meio nao receberia nada. Por
-- isso a preferencia fica na sala e e lida no `GET /api/live/:id`.
--
-- `0` = o anfitriao pediu para nao girar; `90`/`270` = direcao preferida.
ALTER TABLE live_rooms ADD COLUMN video_rotation INTEGER NOT NULL DEFAULT 0
  CHECK (video_rotation IN (0, 90, 270));
