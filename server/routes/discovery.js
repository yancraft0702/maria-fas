import router from '../router.js';
import { endpoint } from '../middleware.js';
import { writeJson } from '../http.js';
import * as v from '../lib/validate.js';
import { get } from '../db/index.js';
import { notFound, forbidden, unauthorized } from '../lib/errors.js';
import {
  createStory, deleteStory, storyTray, listAuthorStories, markStoryViewed,
  storyViewers, replyStory, storyReplies, getStory,
} from '../domain/stories.js';
import { saveUpload } from '../media/upload.js';
import { readSingleFile } from './auth.js';
import { search, quickSearch, explore, popularSounds } from '../domain/search.js';
import { searchGifs, trendingGifs, gifById, giphyStatus } from '../domain/giphy.js';
import { getUserById, publicUser, softDeleteAccount } from '../domain/users.js';
import {
  createSound, listSounds, saveSound, unsaveSound, savedSounds,
  createCollection, addToCollection, removeFromCollection, deleteCollection, updateCollection,
} from '../domain/content.js';
import { fullSettings, updateSettings, updatePrivacy, dataExport, requestAccountDeletion } from '../domain/settings.js';
import { recommendationSettings, watchStats, interests } from '../domain/recommend.js';
import { totalUnread } from '../domain/messaging.js';

// --------------------------------------------------------------------------
// Stories
// --------------------------------------------------------------------------
router.get('/api/stories', endpoint(async (ctx, res) => {
  writeJson(res, 200, { tray: storyTray({ viewer: ctx.user }) });
}));

router.get('/api/stories/:id', endpoint(async (ctx, res) => {
  const storyId = v.id(ctx.params.id, { field: 'id' });
  const story = getStory(storyId, ctx.user?.id ?? null);
  if (!story) throw notFound('story_not_found', 'Story nao encontrado');
  writeJson(res, 200, {
    story,
    replies: storyReplies({ storyId, limit: 50 }),
    viewers: ctx.user && ctx.user.id === story.author.id ? storyViewers({ storyId, viewerId: ctx.user.id }) : undefined,
  });
}));

router.get('/api/users/:id/stories', endpoint(async (ctx, res) => {
  const user = getUserById(v.id(ctx.params.id, { field: 'id' }));
  if (!user) throw notFound('user_not_found', 'Usuario nao encontrado');
  writeJson(res, 200, { author: publicUser(user, ctx.user), stories: listAuthorStories({ authorId: user.id, viewer: ctx.user }) });
}));

router.post('/api/stories/upload', endpoint(async (ctx, res) => {
  const type = v.oneOf(ctx.query.type ?? 'image', ['image', 'video'], { field: 'type', fallback: 'image' });
  const { buffer, contentType, filename } = await readSingleFile(ctx, [type]);
  const saved = await saveUpload({
    ownerId: ctx.user.id, category: type, buffer, declaredMime: contentType,
    originalName: filename, bucket: 'chat', purpose: 'stories',
  });
  if (type === 'video') {
    const { queueVideoProcessing } = await import('../media/upload.js');
    queueVideoProcessing({ mediaId: saved.mediaId, buffer, ownerId: ctx.user.id });
  }
  writeJson(res, 201, {
    media: { ...saved, url: `/api/media/stream?key=${encodeURIComponent(`${saved.bucket}/${saved.key}`)}` },
  });
}), { auth: true, rate: 'upload' });

router.post('/api/stories', endpoint(async (ctx, res) => {
  const type = v.oneOf(ctx.body.type ?? 'image', ['image', 'video', 'text'], { field: 'type', fallback: 'image' });
  const mediaId = ctx.body.mediaId ? v.id(ctx.body.mediaId, { field: 'mediaId' }) : null;
  if (mediaId) {
    const media = get('SELECT owner_id FROM media WHERE id = ?', { id: mediaId });
    if (!media) throw notFound('media_not_found', 'Midia nao encontrada');
    if (media.owner_id !== ctx.user.id) throw forbidden('not_media_owner', 'Esta midia nao e sua');
  }
  const story = createStory({
    authorId: ctx.user.id,
    type,
    mediaId,
    text: v.plainText(ctx.body.text ?? '', { field: 'text', max: 300, required: false }),
    background: v.str(ctx.body.background ?? '#111111', { field: 'background', max: 32, required: false }),
    durationMs: v.int(ctx.body.durationMs ?? 5000, { field: 'durationMs', min: 2000, max: 15000, required: false, fallback: 5000 }),
    soundId: ctx.body.soundId ? v.id(ctx.body.soundId, { field: 'soundId' }) : null,
  });
  writeJson(res, 201, { story });
}), { auth: true, rate: 'write' });

router.post('/api/stories/:id/view', endpoint(async (ctx, res) => {
  writeJson(res, 200, markStoryViewed({ storyId: v.id(ctx.params.id, { field: 'id' }), viewerId: ctx.user.id }));
}), { auth: true, rate: 'write' });

router.post('/api/stories/:id/reply', endpoint(async (ctx, res) => {
  writeJson(res, 201, replyStory({
    storyId: v.id(ctx.params.id, { field: 'id' }),
    authorId: ctx.user.id,
    body: v.plainText(ctx.body.body ?? '', { field: 'body', max: 300, required: false }),
    reaction: v.str(ctx.body.reaction ?? '', { field: 'reaction', max: 16, required: false }),
  }));
}), { auth: true, rate: 'write' });

router.delete('/api/stories/:id', endpoint(async (ctx, res) => {
  writeJson(res, 200, deleteStory({
    storyId: v.id(ctx.params.id, { field: 'id' }), userId: ctx.user.id, actorRole: 'user',
  }));
}), { auth: true, rate: 'write' });

// --------------------------------------------------------------------------
// Busca
// --------------------------------------------------------------------------
router.get('/api/search', endpoint(async (ctx, res) => {
  const query = v.str(ctx.query.q, { field: 'q', max: 120, required: false });
  const limit = v.int(ctx.query.limit, { field: 'limit', min: 1, max: 50, required: false, fallback: 20 });
  const types = ctx.query.types
    ? String(ctx.query.types).split(',').filter((t) => ['people', 'posts', 'hashtags', 'sounds'].includes(t))
    : ['all'];
  writeJson(res, 200, search({ query, viewer: ctx.user, limit, types: types.length ? types : ['all'] }));
}), { auth: true, rate: 'search' });

router.get('/api/search/quick', endpoint(async (ctx, res) => {
  const query = v.str(ctx.query.q, { field: 'q', max: 80, required: false });
  writeJson(res, 200, { results: quickSearch({ query, viewer: ctx.user, limit: 10 }) });
}), { auth: true, rate: 'search' });

router.get('/api/explore', endpoint(async (ctx, res) => {
  writeJson(res, 200, explore({ viewer: ctx.user }));
}), { auth: true });

// --------------------------------------------------------------------------
// GIFs / stickers (GIPHY via backend; a chave nunca chega ao frontend)
// --------------------------------------------------------------------------
router.get('/api/giphy/search', endpoint(async (ctx, res) => {
  const q = v.str(ctx.query.q ?? '', { field: 'q', max: 80, required: false });
  writeJson(res, 200, await searchGifs({
    query: q,
    offset: v.int(ctx.query.offset, { field: 'offset', min: 0, max: 5000, required: false, fallback: 0 }),
    limit: v.int(ctx.query.limit, { field: 'limit', min: 1, max: 50, required: false, fallback: 24 }),
    rating: ctx.query.rating || 'pg',
    language: ctx.query.lang || 'pt',
    kind: v.oneOf(ctx.query.kind ?? 'gifs', ['gifs', 'stickers'], { field: 'kind', fallback: 'gifs' }),
  }));
}), { rate: 'search' });

router.get('/api/giphy/trending', endpoint(async (ctx, res) => {
  writeJson(res, 200, await trendingGifs({
    limit: v.int(ctx.query.limit, { field: 'limit', min: 1, max: 50, required: false, fallback: 24 }),
    rating: ctx.query.rating || 'pg',
    language: ctx.query.lang || 'pt',
    kind: v.oneOf(ctx.query.kind ?? 'gifs', ['gifs', 'stickers'], { field: 'kind', fallback: 'gifs' }),
  }));
}), { rate: 'search' });

router.get('/api/giphy/gif/:id', endpoint(async (ctx, res) => {
  writeJson(res, 200, { gif: await gifById(v.str(ctx.params.id, { field: 'id', max: 64 })) });
}), { rate: 'search' });

router.get('/api/giphy/status', endpoint(async (ctx, res) => {
  writeJson(res, 200, giphyStatus());
}));

// --------------------------------------------------------------------------
// Sons
// --------------------------------------------------------------------------
router.get('/api/sounds', endpoint(async (ctx, res) => {
  const { limit, offset } = v.pagination(ctx.query, { defaultLimit: 30, maxLimit: 100 });
  writeJson(res, 200, { sounds: listSounds({ limit, offset }), trending: popularSounds({ limit: 20 }) });
}));

router.post('/api/sounds/upload', endpoint(async (ctx, res) => {
  const { buffer, contentType, filename } = await readSingleFile(ctx, ['audio']);
  const saved = await saveUpload({
    ownerId: ctx.user.id, category: 'audio', buffer, declaredMime: contentType,
    originalName: filename, bucket: 'sounds', purpose: 'sounds',
  });
  const title = v.str(ctx.query.title ?? 'Som original', { field: 'title', max: 80, required: false });
  const sound = createSound({
    ownerId: ctx.user.id,
    title,
    artist: ctx.user.display_name,
    mediaId: saved.mediaId,
    isOriginal: true,
    license: 'user',
    durationMs: saved.durationMs ?? 0,
  });
  writeJson(res, 201, { sound, media: saved });
}), { auth: true, rate: 'upload' });

router.post('/api/sounds/:id/save', endpoint(async (ctx, res) => {
  writeJson(res, 200, saveSound({ userId: ctx.user.id, soundId: v.id(ctx.params.id, { field: 'id' }) }));
}), { auth: true, rate: 'write' });

router.delete('/api/sounds/:id/save', endpoint(async (ctx, res) => {
  writeJson(res, 200, unsaveSound({ userId: ctx.user.id, soundId: v.id(ctx.params.id, { field: 'id' }) }));
}), { auth: true, rate: 'write' });

router.get('/api/me/sounds', endpoint(async (ctx, res) => {
  writeJson(res, 200, { sounds: savedSounds(ctx.user.id) });
}), { auth: true });

// --------------------------------------------------------------------------
// Colecoes
// --------------------------------------------------------------------------
router.post('/api/collections', endpoint(async (ctx, res) => {
  const collection = createCollection({
    userId: ctx.user.id,
    name: v.str(ctx.body.name, { field: 'name', min: 1, max: 60 }),
    description: v.plainText(ctx.body.description ?? '', { field: 'description', max: 300, required: false }),
    privacy: v.oneOf(ctx.body.privacy ?? 'private', ['public', 'private', 'followers'], { field: 'privacy', fallback: 'private' }),
  });
  writeJson(res, 201, { collection });
}), { auth: true, rate: 'write' });

router.post('/api/collections/:id/items', endpoint(async (ctx, res) => {
  writeJson(res, 200, addToCollection({
    collectionId: v.id(ctx.params.id, { field: 'id' }),
    userId: ctx.user.id,
    postId: v.id(ctx.body.postId, { field: 'postId' }),
  }));
}), { auth: true, rate: 'write' });

router.delete('/api/collections/:id/items/:postId', endpoint(async (ctx, res) => {
  writeJson(res, 200, removeFromCollection({
    collectionId: v.id(ctx.params.id, { field: 'id' }),
    userId: ctx.user.id,
    postId: v.id(ctx.params.postId, { field: 'postId' }),
  }));
}), { auth: true, rate: 'write' });

router.patch('/api/collections/:id', endpoint(async (ctx, res) => {
  const changes = {};
  if (ctx.body.name !== undefined) changes.name = v.str(ctx.body.name, { field: 'name', min: 1, max: 60 });
  if (ctx.body.description !== undefined) changes.description = v.plainText(ctx.body.description, { field: 'description', max: 300, required: false });
  if (ctx.body.privacy !== undefined) changes.privacy = v.oneOf(ctx.body.privacy, ['public', 'private', 'followers'], { field: 'privacy' });
  writeJson(res, 200, { collection: updateCollection({ collectionId: v.id(ctx.params.id, { field: 'id' }), userId: ctx.user.id, changes }) });
}), { auth: true, rate: 'write' });

router.delete('/api/collections/:id', endpoint(async (ctx, res) => {
  writeJson(res, 200, deleteCollection({ collectionId: v.id(ctx.params.id, { field: 'id' }), userId: ctx.user.id }));
}), { auth: true, rate: 'write' });

// --------------------------------------------------------------------------
// Configuracoes
// --------------------------------------------------------------------------
router.get('/api/me/settings', endpoint(async (ctx, res) => {
  writeJson(res, 200, {
    settings: fullSettings(ctx.user.id),
    recommendation: recommendationSettings(ctx.user.id),
    stats: watchStats(ctx.user.id),
    interests: interests(ctx.user.id),
    unreadMessages: totalUnread(ctx.user.id),
  });
}), { auth: true });

router.patch('/api/me/settings', endpoint(async (ctx, res) => {
  writeJson(res, 200, { settings: updateSettings(ctx.user.id, ctx.body) });
}), { auth: true, rate: 'write' });

router.patch('/api/me/privacy', endpoint(async (ctx, res) => {
  writeJson(res, 200, { settings: updatePrivacy(ctx.user.id, ctx.body) });
}), { auth: true, rate: 'write' });

router.get('/api/me/export', endpoint(async (ctx, res) => {
  writeJson(res, 200, dataExport(ctx.user.id));
}), { auth: true });

router.post('/api/me/deletion-request', endpoint(async (ctx, res) => {
  const result = requestAccountDeletion(ctx.user.id, { passwordConfirmed: v.bool(ctx.body.confirmed) });
  writeJson(res, 200, result);
}), { auth: true });

router.post('/api/me/delete', endpoint(async (ctx, res) => {
  const { verifyPassword } = await import('../lib/crypto.js');
  const password = v.str(ctx.body.password, { field: 'password', min: 1, max: 200 });
  if (!(await verifyPassword(password, ctx.user.password_hash))) {
    throw unauthorized('invalid_credentials', 'Senha incorreta');
  }
  softDeleteAccount(ctx.user.id);
  writeJson(res, 200, { ok: true });
}), { auth: true });
