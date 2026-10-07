/**
 * Verifica constraints e zoom da captura com tracks controlados, sem camera.
 * O browser fake nao representa o campo de visao de um sensor fisico.
 */
import { Report } from '../tests/helpers.mjs';

const gomFalso = { pedidas: null, stream: null };
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  writable: true,
  value: {
    mediaDevices: {
      getUserMedia: async (constraints) => {
        gomFalso.pedidas = constraints;
        return gomFalso.stream;
      },
      enumerateDevices: async () => [],
    },
  },
});

const { MediaDevices } = await import('../web/js/features/live-media-devices.js');
const { escolherEnquadramento } = await import('../web/js/features/live-layout.js');
const report = new Report('LIVE: captura natural sem crop forcado');

function fakeTrack({ width, height, zoom = null, zoomSetting = null }) {
  const applied = [];
  const settings = { width, height, aspectRatio: width / height };
  if (zoomSetting !== null) settings.zoom = zoomSetting;
  const track = {
    getSettings: () => ({ ...settings }),
    getConstraints: () => ({ ...applied.at(-1)?.constraints }),
    getCapabilities: () => ({
      aspectRatio: { min: 0.4, max: 2.4 },
      ...(zoom ? { zoom } : {}),
    }),
    applyConstraints: async (constraints) => {
      applied.push({ constraints });
      if (constraints.advanced?.some((item) => 'zoom' in item)) {
        settings.zoom = constraints.advanced.find((item) => 'zoom' in item).zoom;
      } else if ('zoom' in constraints) {
        settings.zoom = constraints.zoom;
      } else {
        throw new Error(`constraint inesperada: ${JSON.stringify(constraints)}`);
      }
    },
    stop() {},
  };
  return { track, applied };
}

function useCamera(track) {
  const stream = {
    getTracks: () => [track],
    getVideoTracks: () => [track],
    getAudioTracks: () => [],
    removeTrack() {},
    addTrack() {},
  };
  gomFalso.stream = stream;
  return stream;
}

async function openCamera(track) {
  useCamera(track);
  const devices = new MediaDevices();
  await devices.open({ video: true, audio: false });
  return devices;
}

async function run() {
  try {
    const constraint = MediaDevices.videoConstraint();
    for (const key of ['width', 'height', 'aspectRatio', 'zoom']) {
      if (constraint[key] !== undefined) {
        throw new Error(`videoConstraint() ainda pede ${key}: `
          + JSON.stringify(constraint[key]));
      }
    }
    if (constraint.facingMode?.ideal !== 'user') {
      throw new Error('a camera frontal nao esta configurada como preferencia');
    }
    report.ok(`getUserMedia pede somente facingMode/frameRate: ${JSON.stringify(constraint)}`);

    for (const [width, height] of [[1280, 720], [640, 480], [720, 1280]]) {
      const { track, applied } = fakeTrack({ width, height });
      const devices = await openCamera(track);
      const asked = gomFalso.pedidas.video;
      if (asked.height || asked.width || asked.aspectRatio || asked.zoom) {
        throw new Error(`houve constraint de recorte/zoom em ${width}x${height}: `
          + JSON.stringify(asked));
      }
      if (applied.some(({ constraints: c }) => 'aspectRatio' in c || 'width' in c || 'height' in c)) {
        throw new Error(`o track ${width}x${height} foi alterado fora da capability zoom`);
      }
      if (devices.quadro.width !== width || devices.quadro.height !== height) {
        throw new Error(`quadro nativo ${width}x${height} alterado para `
          + `${devices.quadro.width}x${devices.quadro.height}`);
      }
      const fit = escolherEnquadramento(
        { largura: width, altura: height },
        { largura: 390, altura: 844 },
      );
      if (fit.fit !== 'cover') {
        throw new Error(`${width}x${height}: fullscreen nao selecionou cover`);
      }
      report.ok(`track ${width}x${height} (${(width / height).toFixed(4)}): `
        + 'resolucao/proporcao preservadas, sem constraint de crop; exibicao cover');
    }

    {
      const zoom = { min: 1.7, max: 4, step: 0.1 };
      const { track, applied } = fakeTrack({
        width: 1280, height: 720, zoom, zoomSetting: 2.4,
      });
      const devices = await openCamera(track);
      if (!devices.zoom.suportado || !devices.zoom.aplicado) {
        throw new Error(`capability zoom nao foi neutralizada: ${JSON.stringify(devices.zoom)}`);
      }
      if (track.getSettings().zoom !== zoom.min
          || devices.zoom.valor !== zoom.min
          || !applied.some(({ constraints: c }) => c.zoom === zoom.min
            || c.advanced?.some((item) => item.zoom === zoom.min))) {
        throw new Error(`zoom nao foi definido pelo minimo real ${zoom.min}`);
      }
      report.ok(`zoom exposto pelo track: capability ${JSON.stringify(zoom)}, `
        + `valor inicial 2.4 -> minimo declarado ${track.getSettings().zoom}`);
    }

    {
      const { track, applied } = fakeTrack({ width: 640, height: 480 });
      const devices = await openCamera(track);
      if (devices.zoom.suportado || applied.length) {
        throw new Error('aplicou zoom sem capability no track');
      }
      report.ok('track sem capability zoom: nenhuma constraint de zoom aplicada');
    }

    report.ok('captura: sem resolucao/proporcao forçada; zoom limitado ao minimo declarado');
  } catch (error) {
    report.fail('verificacao da captura interrompida', error);
  }
  return report.summary();
}

process.stdout.isTTY = true;
const result = await run();
process.exit(result.failed > 0 ? 1 : 0);
