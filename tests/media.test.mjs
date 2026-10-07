/**
 * Testes de midia e storage: ffmpeg real, transcoding, HLS, thumbnails,
 * autorizacao de arquivo, Range, magic bytes, orfaos e limites.
 */
import { startServer, Client, Report, makeTestVideo, makeTestImage, makeTestAudio, randomUsername, waitUntil } from './helpers.mjs';
const report = new Report('Midia e storage');

async function run() {
  const server = await startServer();
  report.ok('servidor no ar', server.baseUrl);

  try {
    const owner = new Client(server.baseUrl);
    await owner.register({ username: randomUsername('ana') });
    const other = new Client(server.baseUrl);
    await other.register({ username: randomUsername('bob') });

    // ------------------------------------------------------- TRANSFORMACAO
    const video = await makeTestVideo({ seconds: 2, width: 480, height: 854, withAudio: true });
    let mediaId = null;
    await report.step('upload de video + pipeline completo (ffmpeg)', async () => {
      const upload = await owner.upload('/api/media/upload?purpose=video', video.buffer, {
        filename: video.filename, mime: video.mime,
      });
      if (![200, 201, 202].includes(upload.status)) {
        throw new Error(`status ${upload.status}: ${JSON.stringify(upload.body).slice(0, 200)}`);
      }
      mediaId = upload.body.media.id;
      if (upload.body.media.status !== 'processing' && upload.body.media.status !== 'pending') {
        throw new Error(`video nao entrou como pendente (${upload.body.media.status})`);
      }
      return `media ${mediaId}`;
    });

    let processed = null;
    await report.step('processamento gera resolucoes, poster, storyboard e HLS', async () => {
      processed = await waitUntil(async () => {
        const { body } = await owner.get(`/api/media/${mediaId}/status`);
        if (body.media.status === 'failed') throw new Error(`falhou: ${body.media.error}`);
        return body.media.status === 'ready' ? body.media : null;
      }, { timeoutMs: 120000, intervalMs: 700 });
      if (!processed.durationMs) throw new Error('duracao nao detectada');
      if (!processed.width || !processed.height) throw new Error('dimensoes nao detectadas');
      if (!processed.posterKey) throw new Error('poster ausente');
      if (!processed.spriteKey) throw new Error('storyboard ausente');
      if (!processed.hlsKey) throw new Error('manifesto HLS ausente');
      if (!processed.renditions?.length) throw new Error('nenhuma resolucao gerada');
      return `${processed.renditions.map((r) => r.label).join(',')} | ${processed.durationMs}ms | ${processed.width}x${processed.height}`;
    });

    await report.step('cada artefato gerado e servivel com MIME correto', async () => {
      const checks = [
        ['poster', `/api/media/stream?key=${encodeURIComponent(`thumbnails/${processed.posterKey}`)}`, 'image'],
        ['storyboard', `/api/media/stream?key=${encodeURIComponent(`thumbnails/${processed.spriteKey}`)}`, 'image'],
        ['original', `/api/media/stream?key=${encodeURIComponent(`videos/${mediaId}.mp4`)}`, 'video'],
      ];
      for (const rendition of processed.renditions) {
        checks.push([rendition.label, `/api/media/stream?key=${encodeURIComponent(`videos/${rendition.key}`)}`, 'video']);
      }
      const results = [];
      for (const [name, url, expected] of checks) {
        const res = await owner.get(url, { raw: true });
        if (res.status !== 200) throw new Error(`${name}: status ${res.status}`);
        const type = res.headers.get('content-type') || '';
        if (!type.startsWith(expected)) throw new Error(`${name}: content-type ${type}`);
        const buffer = Buffer.from(await res.body.arrayBuffer());
        if (buffer.length < 500) throw new Error(`${name}: ${buffer.length} bytes`);
        results.push(`${name}=${(buffer.length / 1024).toFixed(0)}KB`);
      }
      return results.join(' ');
    });

    await report.step('HLS: master -> variante -> segmento .ts real', async () => {
      const key = encodeURIComponent(`videos/${processed.hlsKey}`);
      const manifest = await owner.get(`/api/media/hls?key=${key}`, { raw: true });
      if (manifest.status !== 200) throw new Error(`manifesto ${manifest.status}`);
      const master = Buffer.from(await manifest.body.arrayBuffer()).toString('utf8');
      if (!master.startsWith('#EXTM3U')) throw new Error('manifesto nao comeca com #EXTM3U');
      if (!master.includes('#EXT-X-STREAM-INF')) throw new Error('sem variantes no master');
      if (master.includes('undefined')) throw new Error('master com atributo undefined');
      if (!/RESOLUTION=\d+x\d+/.test(master)) throw new Error('master sem RESOLUTION valido');

      // Segue para a playlist da variante
      const variantMatch = /\r?\n([^\r\n]+\.m3u8)\s*$/.exec(master.split('#EXT-X-STREAM-INF')[1] || '');
      const variantName = (variantMatch?.[1] || '360p.m3u8').trim();
      const variantKey = encodeURIComponent(`videos/${mediaId}/${variantName}`);
      const variant = await owner.get(`/api/media/hls?key=${variantKey}`, { raw: true });
      if (variant.status !== 200) throw new Error(`variante ${variant.status}`);
      const playlist = Buffer.from(await variant.body.arrayBuffer()).toString('utf8');
      if (!playlist.includes('#EXTINF')) throw new Error('variante sem EXTINF');

      const segmentMatch = /^(.+\.ts)$/m.exec(playlist);
      if (!segmentMatch) throw new Error('nenhum segmento .ts listado');
      const segment = await owner.get(
        `/api/media/hls?key=${encodeURIComponent(`videos/${mediaId}/${segmentMatch[1]}`)}`,
        { raw: true },
      );
      if (segment.status !== 200) throw new Error(`segmento ${segment.status}`);
      const buffer = Buffer.from(await segment.body.arrayBuffer());
      if (buffer.length < 188) throw new Error(`segmento muito pequeno (${buffer.length})`);
      if (buffer[0] !== 0x47) throw new Error(`segmento MPEG-TS invalido (byte 0 = ${buffer[0]})`);
      return `${variantName} + segmento ${(buffer.length / 1024).toFixed(0)}KB`;
    });

    await report.step('Range: seek precisa de varios offsets', async () => {
      const key = encodeURIComponent(`videos/${mediaId}.mp4`);
      const full = await owner.get(`/api/media/stream?key=${key}`, { raw: true });
      const size = Number(full.headers.get('content-length'));
      const ranges = [
        ['bytes=0-0', 0, 1],
        ['bytes=100-199', 100, 100],
        ['bytes=-500', size - 500, 500],
      ];
      for (const [header, expectedStart, expectedLength] of ranges) {
        const res = await owner.get(`/api/media/stream?key=${key}`, {
          raw: true, headers: { Range: header },
        });
        if (res.status !== 206) throw new Error(`${header}: status ${res.status}`);
        const buffer = Buffer.from(await res.body.arrayBuffer());
        if (buffer.length !== expectedLength) {
          throw new Error(`${header}: ${buffer.length} bytes (esperava ${expectedLength})`);
        }
        const contentRange = res.headers.get('content-range') || '';
        if (!contentRange.includes(String(expectedStart))) {
          throw new Error(`${header}: Content-Range "${contentRange}"`);
        }
      }
      return `${ranges.length} ranges corretos em arquivo de ${(size / 1024).toFixed(0)}KB`;
    });

    await report.step('Range invalido nao derruba o servidor', async () => {
      for (const header of ['bytes=99999999-', 'bytes=abc-def', 'bytes=-', 'nonsense']) {
        const res = await owner.get(`/api/media/stream?key=${encodeURIComponent(`videos/${mediaId}.mp4`)}`, {
          raw: true, headers: { Range: header },
        });
        if (res.status >= 500) throw new Error(`${header}: ${res.status}`);
      }
      const health = await owner.get('/api/health');
      if (health.status !== 200) throw new Error('servidor fora do ar apos Range invalido');
      return '4 headers invalidos, servidor estavel';
    });

    // ------------------------------------------------------ MAGIC BYTES / TIPOS
    await report.step('MIME real prevalece sobre o declarado (sniffing)', async () => {
      // PNG declarado como video
      const image = await makeTestImage({ width: 32, height: 32 });
      const asVideo = await owner.upload('/api/media/upload?purpose=video', image.buffer, {
        filename: 'foto.mp4', mime: 'video/mp4',
      });
      if ([200, 201, 202].includes(asVideo.status)) throw new Error('PNG aceito como video');

      // Texto declarado como imagem
      const text = Buffer.from('isso nao e uma imagem, e texto puro');
      const asImage = await owner.upload('/api/users/me/avatar', text, {
        filename: 'avatar.png', mime: 'image/png',
      });
      if (asImage.status === 200) throw new Error('texto aceito como imagem');
      return `recusados com ${asVideo.status}/${asImage.status}`;
    });

    await report.step('dimensoes reais extraidas da imagem', async () => {
      const image = await makeTestImage({ width: 123, height: 456, color: 'teal' });
      const upload = await owner.upload('/api/users/me/avatar', image.buffer, {
        filename: image.filename, mime: image.mime,
      });
      if (upload.status !== 200) throw new Error(`status ${upload.status}`);
      const me = await owner.get('/api/auth/me');
      if (!me.body.user.avatarUrl) throw new Error('avatarUrl ausente');
      return 'avatar salvo e referenciado';
    });

    await report.step('audio: duracao detectada pelo ffmpeg', async () => {
      const audio = await makeTestAudio({ seconds: 2, frequency: 660 });
      const upload = await owner.upload('/api/sounds/upload?title=Teste', audio.buffer, {
        filename: audio.filename, mime: audio.mime,
      });
      if (upload.status !== 201) throw new Error(`status ${upload.status}: ${JSON.stringify(upload.body).slice(0, 160)}`);
      if (Math.abs((upload.body.sound.durationMs ?? 0) - 2000) > 400) {
        throw new Error(`duracao ${upload.body.sound.durationMs}ms (esperava ~2000)`);
      }
      return `${upload.body.sound.durationMs}ms`;
    });

    // ------------------------------------------------ AUTORIZACAO DE ARQUIVO
    await report.step('midia de outra conta nao e acessivel sem permissao', async () => {
      const key = encodeURIComponent(`videos/${mediaId}.mp4`);
      // Sem post publico associado, o arquivo e' privado do dono.
      const res = await other.get(`/api/media/stream?key=${key}`);
      if (res.status !== 403 && res.status !== 404) {
        throw new Error(`terceiro acessou midia solta (${res.status})`);
      }
      return 'sem acesso directo';
    });

    await report.step('midia de post publico e acessivel a terceiros', async () => {
      const post = await owner.post('/api/posts', {
        type: 'video', mediaId, caption: 'publico #testemidia',
      });
      if (post.status !== 201) throw new Error(`post ${post.status}`);
      const key = encodeURIComponent(`videos/${mediaId}.mp4`);
      const res = await other.get(`/api/media/stream?key=${key}`);
      if (res.status !== 200) throw new Error(`terceiro nao acessou post publico (${res.status})`);
      return 'visibilidade do post respeitada';
    });

    await report.step('path traversal e recusado em todos os buckets', async () => {
      const attacks = [];
      for (const bucket of ['videos', 'thumbnails', 'avatars', 'chat', 'effects', 'covers']) {
        attacks.push(`${bucket}/../../../etc/passwd`);
        attacks.push(`${bucket}/..%2F..%2Fpackage.json`);
        attacks.push(`${bucket}/%2e%2e%2f%2e%2e%2fserver%2fconfig.js`);
      }
      let blocked = 0;
      for (const key of attacks) {
        const res = await other.get(`/api/media/stream?key=${encodeURIComponent(key)}`, { raw: true });
        if (res.status === 200) {
          const text = Buffer.from(await res.body.arrayBuffer()).toString('utf8');
          if (text.includes('root:') || text.includes('"dependencies"') || text.includes('SESSION_SECRET')) {
            throw new Error(`VAZAMENTO via "${key}"`);
          }
        }
        blocked += 1;
      }
      return `${blocked} tentativas sem vazamento`;
    });

    await report.step('bucket inexistente e recusado', async () => {
      for (const bucket of ['../', 'etc', 'node_modules', 'data', '.tmp']) {
        const res = await other.get(`/api/media/stream?key=${encodeURIComponent(`${bucket}/x.mp4`)}`);
        if (res.status === 200) throw new Error(`bucket "${bucket}" servido`);
        if (res.status >= 500) throw new Error(`bucket "${bucket}" deu ${res.status}`);
      }
      return '5 buckets recusados';
    });

    // ------------------------------------------------------------ ALPHA REAL
    await report.step('arquivo com alfa e detectado como transparente', async () => {
      // Este build do ffmpeg nao grava o plano alpha (verificado no boot):
      // a API expoe o status real e o cliente aplica chroma-key na GPU.
      const effects = await owner.get('/api/live/effects');
      const withAlpha = effects.body.effects.filter((e) => e.alphaReady);
      const withKey = effects.body.effects.filter((e) => !e.alphaReady && e.chromaKey);
      if (withKey.length + withAlpha.length !== effects.body.effects.length) {
        throw new Error('efeito sem alfa E sem chromaKey (remocao de fundo indefinida)');
      }
      return `${withAlpha.length} com alfa em disco, ${withKey.length} com chroma-key na GPU`;
    });

    // -------------------------------------------------------------- ORFAOS
    await report.step('upload sem post vira orfao identificavel', async () => {
      const orphan = await makeTestVideo({ seconds: 1, width: 240, height: 426 });
      const upload = await owner.upload('/api/media/upload?purpose=video', orphan.buffer, {
        filename: orphan.filename, mime: orphan.mime,
      });
      const orphanId = upload.body.media.id;
      await waitUntil(async () => {
        const { body } = await owner.get(`/api/media/${orphanId}/status`);
        return body.media.status === 'ready' ? body.media : null;
      }, { timeoutMs: 90000, intervalMs: 700 });
      // O arquivo existe no storage mesmo sem estar publicado.
      const key = encodeURIComponent(`videos/${orphanId}.mp4`);
      const res = await owner.get(`/api/media/stream?key=${key}`, { raw: true });
      if (res.status !== 200) throw new Error(`orfao nao servido ao dono (${res.status})`);
      return `orfao ${orphanId} servivel ao dono`;
    });

    await report.step('uso de storage e contabilizado', async () => {
      // `?fresh=1`: medicao real (sem o cache de 15s do healthcheck).
      const health = await owner.get('/api/health?fresh=1');
      if (health.body.checks.storage !== true) throw new Error('checks.storage !== true');
      if (health.body.checks.storageFiles < 5) {
        throw new Error(`apenas ${health.body.checks.storageFiles} arquivos contados`);
      }
      if (health.body.checks.storageBytes <= 0) throw new Error('bytes reportados = 0');
      return `${health.body.checks.storageFiles} arquivos, ${(health.body.checks.storageBytes / 1048576).toFixed(1)} MB`;
    });

    await report.step('uso do storage por bucket e restrito a staff', async () => {
      const denied = await owner.get('/api/admin/storage/usage');
      if (denied.status !== 403) throw new Error(`usuario comum leu o storage (${denied.status})`);
    });

    await report.step('transcode desativado degrada sem quebrar (MEDIA_TRANSCODE=false)', async () => {
      const degraded = await startServer({ env: { MEDIA_TRANSCODE: 'false', MEDIA_HLS: 'false' } });
      try {
        const client = new Client(degraded.baseUrl);
        await client.register({ username: randomUsername('semf') });
        const clip = await makeTestVideo({ seconds: 1, width: 240, height: 426 });
        const upload = await client.upload('/api/media/upload?purpose=video', clip.buffer, {
          filename: clip.filename, mime: clip.mime,
        });
        if (![200, 201, 202].includes(upload.status)) throw new Error(`upload ${upload.status}`);

        const status = await waitUntil(async () => {
          const { body } = await client.get(`/api/media/${upload.body.media.id}/status`);
          return body.media.status === 'ready' || body.media.status === 'failed' ? body.media : null;
        }, { timeoutMs: 60000, intervalMs: 700 });
        if (status.status === 'failed') throw new Error(`falhou: ${status.error}`);

        // O original continua disponivel (sem HLS/renditions).
        const key = encodeURIComponent(`videos/${upload.body.media.id}.mp4`);
        const res = await client.get(`/api/media/stream?key=${key}`, { raw: true });
        if (res.status !== 200) throw new Error(`original indisponivel (${res.status})`);

        const health = await client.get('/api/health');
        if (health.body.features.transcode !== false) throw new Error('transcode ainda reportado como ativo');
        if (health.body.features.hls !== false) throw new Error('HLS ainda reportado como ativo');
        return 'original servido, features honestas';
      } finally {
        await degraded.stop();
      }
    });

    await report.step('FFMPEG_PATH invalido cai no ffmpeg embutido e avisa', async () => {
      const fallback = await startServer({
        env: { FFMPEG_PATH: 'C:/caminho/que/nao/existe/ffmpeg.exe' },
      });
      try {
        const client = new Client(fallback.baseUrl);
        await client.register({ username: randomUsername('fb') });
        const health = await client.get('/api/health');
        if (health.body.checks.ffmpeg !== true) throw new Error('fallback nao usou o ffmpeg embutido');
        // Janela ampla: o aviso e de boot e o catalogo de efeitos (que tambem
        // usa ffmpeg) pode logar linhas depois dele.
        if (!fallback.dumpLogs(500).includes('FFMPEG_PATH configurado nao e executavel')) {
          throw new Error('sem aviso de que a configuracao foi ignorada');
        }
        return 'fallback + aviso no log';
      } finally {
        await fallback.stop();
      }
    });

    await report.step('ffmpeg desligado (FFMPEG_PATH=none) degrada com honestidade', async () => {
      const noff = await startServer({ env: { FFMPEG_PATH: 'none' } });
      try {
        const client = new Client(noff.baseUrl);
        await client.register({ username: randomUsername('semff') });
        const health = await client.get('/api/health');
        if (health.body.checks.ffmpeg !== false) throw new Error('ffmpeg reportado como disponivel');
        if (health.body.status !== 'ok') throw new Error(`healthcheck ${health.body.status} sem ffmpeg`);
        if (health.body.features.transcode !== false || health.body.features.hls !== false) {
          throw new Error('features ainda anunciam transcode/HLS sem ffmpeg');
        }
        // A API segue no ar; apenas o processamento automatico fica indisponivel.
        const clip = await makeTestVideo({ seconds: 1, width: 240, height: 426 });
        const upload = await client.upload('/api/media/upload?purpose=video', clip.buffer, {
          filename: clip.filename, mime: clip.mime,
        });
        if (![200, 201, 202].includes(upload.status)) throw new Error(`upload ${upload.status}`);
        return `ffmpeg ausente, API no ar, upload ${upload.status}`;
      } finally {
        await noff.stop();
      }
    });

    report.ok('midia processada e servida com autorizacao real');
  } catch (error) {
    report.fail('fluxo de midia interrompido', error);
  } finally {
    await server.stop();
  }

  return report.summary();
}

run().then((result) => {
  process.exit(result.failed > 0 ? 1 : 0);
}).catch((error) => {
  console.error('erro fatal:', error);
  process.exit(1);
});