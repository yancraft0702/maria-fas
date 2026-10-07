-- Presenca do host: timestamp do ultimo heartbeat enviado pelo anfitriao.
-- O servidor encerra a LIVE quando este campo fica mais velho que 60s.
ALTER TABLE live_rooms ADD COLUMN last_host_heartbeat INTEGER;
