// gdstudio-music/index.cjs
// Main-process backend for the GD Music Studio (music.gdstudio.xyz) Folium 2 audio source mod.
// Attribution: Data provided by GD Music Studio (https://music.gdstudio.xyz/) via https://music-api.gdstudio.xyz/api.php.

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_API_URL = 'https://music-api.gdstudio.xyz/api.php';
const REFERER_URL = 'https://music.gdstudio.xyz/';
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const REQUEST_TIMEOUT_MS = 15_000;
const ISSUED_MEDIA_TTL_MS = 2 * 60 * 60 * 1000;
const PLAYLIST_CACHE_TTL_MS = 10 * 60 * 1000;
const USERLIST_CACHE_TTL_MS = 10 * 60 * 1000;
const MAX_SONG_CACHE = 1000;
const MAX_PIC_CACHE = 1000;
const MAX_LYRIC_CACHE = 200;
const MAX_PLAYLIST_CACHE = 64;
const MAX_JSON_FILE_BYTES = 10 * 1024 * 1024;
const PIC_MISS_TTL_MS = 5 * 60 * 1000;
const MAX_CONCURRENT_PICS = 3;

const STORAGE_KEY_IMPORTED = 'imported_playlists_v1';

// Built-in popular playlists/charts matching GD Music Studio's curated lists (fetched on demand via types=playlist).
const GD_BUILTIN_CHARTS = Object.freeze([
    { id: '3778678', name: '云音乐热歌榜', description: 'GD 音乐台 · 热门单曲排行' },
    { id: '3779629', name: '云音乐新歌榜', description: 'GD 音乐台 · 每日新歌速递' },
    { id: '19723756', name: '云音乐飙升榜', description: 'GD 音乐台 · 热度飙升单曲' },
    { id: '2884035', name: '网易原创歌曲榜', description: 'GD 音乐台 · 原创音乐精选' },
    { id: '2809513713', name: '云音乐欧美热歌榜', description: 'GD 音乐台 · 欧美热门单曲' },
    { id: '71385702', name: '云音乐ACG榜', description: 'GD 音乐台 · ACG 音乐精选' },
    { id: '1978921795', name: '云音乐电音榜', description: 'GD 音乐台 · 电子音乐排行' },
    { id: '2250011882', name: '抖音排行榜', description: 'GD 音乐台 · 热门流行趋势' },
]);

const QUALITY_TO_BR = Object.freeze({
    standard: 128,
    high: 320,
    ultra: 320,
    lossless: 740,
    hires: 999,
});

const brToQuality = (br) => {
    const num = Number(br);
    if (!Number.isFinite(num) || num <= 0) return 'high';
    if (num >= 999) return 'hires';
    if (num >= 700) return 'lossless';
    if (num >= 256) return 'high';
    return 'standard';
};

const normalizeApiUrl = (raw) => {
    const text = typeof raw === 'string' ? raw.trim() : '';
    if (!text) return DEFAULT_API_URL;
    try {
        const parsed = new URL(text);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return DEFAULT_API_URL;
        return parsed.href;
    } catch {
        return DEFAULT_API_URL;
    }
};

const normalizeUpstream = (raw) => {
    const text = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
    return /^[a-z0-9_-]{1,32}$/.test(text) ? text : 'netease';
};

const normalizeHttpsUrl = (raw) => {
    const text = typeof raw === 'string' ? raw.trim() : '';
    if (!text) return '';
    if (text.startsWith('//')) return `https:${text}`;
    if (text.startsWith('http://')) return `https://${text.slice(7)}`;
    return /^https?:\/\//i.test(text) ? text : '';
};

const parseSongId = (id) => {
    if (typeof id !== 'string') return null;
    const colon = id.indexOf(':');
    if (colon <= 0 || colon >= id.length - 1) return null;
    const upstream = normalizeUpstream(id.slice(0, colon));
    const trackId = id.slice(colon + 1).trim();
    if (!trackId) return null;
    return { upstream, trackId };
};

const extractNumericId = (raw) => {
    const text = typeof raw === 'string' ? raw.trim() : String(raw ?? '').trim();
    if (!text) return null;
    if (/^\d{1,20}$/.test(text)) return text;
    const queryMatch = /[?&#](?:id|uid)=(\d{1,20})\b/i.exec(text);
    if (queryMatch) return queryMatch[1];
    const pathMatch = /\/(?:playlist|user\/home)\/(\d{1,20})\b/i.exec(text);
    if (pathMatch) return pathMatch[1];
    return null;
};

const parseIdList = (raw) => {
    if (typeof raw !== 'string') return [];
    const seen = new Set();
    const ids = [];
    for (const part of raw.split(/[\s,，;；]+/)) {
        const id = extractNumericId(part);
        if (id && !seen.has(id)) {
            seen.add(id);
            ids.push(id);
        }
    }
    return ids.slice(0, 30);
};

const normalizeCoverDirectUrl = (picId, upstream) => {
    const raw = typeof picId === 'string' ? picId.trim() : '';
    if (!raw) return null;
    if (/^https?:\/\//i.test(raw)) return raw.replace(/^http:\/\//i, 'https://');
    if (raw.startsWith('//')) return `https:${raw}`;
    if (upstream === 'joox' && /^[A-Za-z0-9_-]+$/.test(raw)) {
        return `https://image.joox.com/JOOXcover/0/${encodeURIComponent(raw)}/500`;
    }
    return null;
};

const lruSet = (map, key, value, limit) => {
    if (map.has(key)) map.delete(key);
    map.set(key, value);
    while (map.size > limit) {
        map.delete(map.keys().next().value);
    }
};

const createSemaphore = (max) => {
    let active = 0;
    const queue = [];
    const acquire = () => new Promise((resolve) => {
        if (active < max) {
            active += 1;
            resolve();
        } else {
            queue.push(resolve);
        }
    });
    const release = () => {
        active = Math.max(0, active - 1);
        const next = queue.shift();
        if (next) {
            active += 1;
            next();
        }
    };
    return async (fn) => {
        await acquire();
        try {
            return await fn();
        } finally {
            release();
        }
    };
};

class GdApiError extends Error {
    constructor(code, message, extra = {}) {
        super(message);
        this.name = 'GdApiError';
        this.code = code;
        this.httpStatus = extra.httpStatus;
        this.upstream = extra.upstream;
    }
}

/** @param {import('../folia-major/mods/folium').FoliumSourceMainApi} api */
module.exports = function activate(api) {
    let config = {
        apiUrl: DEFAULT_API_URL,
        upstream: 'netease',
        loadCovers: true,
        neteaseUid: '',
        playlistIds: '',
    };

    const songCache = new Map();
    const picUrlCache = new Map();
    const inFlightPics = new Map();
    const lyricCache = new Map();
    const playlistCache = new Map(); // playlistId -> { collection, songs, expiresAt }
    const userListCache = new Map(); // uid -> { collections, expiresAt }
    const runPicLimited = createSemaphore(MAX_CONCURRENT_PICS);

    const applyConfig = (patch) => {
        if (!patch || typeof patch !== 'object') return;
        if (patch.apiUrl !== undefined) config.apiUrl = normalizeApiUrl(patch.apiUrl);
        if (patch.upstream !== undefined) config.upstream = normalizeUpstream(patch.upstream);
        if (patch.loadCovers !== undefined) config.loadCovers = Boolean(patch.loadCovers);
        if (patch.neteaseUid !== undefined) config.neteaseUid = extractNumericId(patch.neteaseUid) || '';
        if (patch.playlistIds !== undefined) config.playlistIds = typeof patch.playlistIds === 'string' ? patch.playlistIds : '';
    };

    const issuedMedia = api.media.allow({
        followRedirects: true,
        ttlMs: ISSUED_MEDIA_TTL_MS,
    });
    api.media.allow({
        hosts: [
            '*.music.126.net',
            'image.joox.com',
            '*.joox.com',
            '*.hdslb.com',
            '*.bilivideo.com',
            '*.qqmusic.qq.com',
            '*.kuwo.cn',
        ],
        resourceTypes: ['media', 'xhr', 'image'],
    });

    const fetchApiJson = async (params, apiUrlOverride) => {
        const base = normalizeApiUrl(apiUrlOverride || config.apiUrl);
        const url = new URL(base);
        for (const [k, v] of Object.entries(params)) {
            if (v !== undefined && v !== null && v !== '') {
                url.searchParams.set(k, String(v));
            }
        }
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
        try {
            const response = await api.net.fetch(url.href, {
                method: 'GET',
                credentials: 'omit',
                signal: controller.signal,
                headers: {
                    accept: 'application/json, text/plain, */*',
                    referer: REFERER_URL,
                    'user-agent': BROWSER_UA,
                },
            });
            const text = await response.text();
            if (response.status === 429) {
                throw new GdApiError('rate-limited', 'GD Music Studio API rate limit exceeded (HTTP 429)', { httpStatus: 429 });
            }
            if (response.status === 403 && /<html|just a moment|cloudflare/i.test(text)) {
                throw new GdApiError('cloudflare', 'GD Music Studio returned a Cloudflare challenge (HTTP 403)', { httpStatus: 403 });
            }
            let data;
            try {
                data = JSON.parse(text);
            } catch {
                if (/<html|just a moment|cloudflare/i.test(text)) {
                    throw new GdApiError('cloudflare', 'GD Music Studio returned an HTML challenge instead of JSON', { httpStatus: response.status });
                }
                throw new GdApiError('invalid-response', `GD Music Studio returned non-JSON response (HTTP ${response.status})`, { httpStatus: response.status });
            }
            if (!response.ok) {
                const detail = data && typeof data.detail === 'string' ? data.detail : `HTTP ${response.status}`;
                if (/source.*not supported/i.test(detail)) {
                    throw new GdApiError('unsupported-source', detail, { httpStatus: response.status, upstream: params.source });
                }
                throw new GdApiError('unavailable', detail, { httpStatus: response.status });
            }
            if (data && !Array.isArray(data) && typeof data === 'object' && typeof data.detail === 'string') {
                if (/source.*not supported/i.test(data.detail)) {
                    throw new GdApiError('unsupported-source', data.detail, { upstream: params.source });
                }
                if (/rate|limit|too many|频繁/i.test(data.detail)) {
                    throw new GdApiError('rate-limited', data.detail, { httpStatus: 429 });
                }
                throw new GdApiError('unavailable', data.detail);
            }
            return data;
        } catch (error) {
            if (error instanceof GdApiError) throw error;
            throw new GdApiError('network', error instanceof Error ? error.message : String(error));
        } finally {
            clearTimeout(timer);
        }
    };

    const resolveCoverImageUrl = async (upstream, picId, size = '500') => {
        const cacheKey = `${upstream}:${picId}:${size}`;
        const cached = picUrlCache.get(cacheKey);
        if (cached) {
            if (cached.url) return cached.url;
            if (cached.expiresAt > Date.now()) return null;
            picUrlCache.delete(cacheKey);
        }
        const existing = inFlightPics.get(cacheKey);
        if (existing) return existing;

        const promise = runPicLimited(async () => {
            try {
                const data = await fetchApiJson({
                    types: 'pic',
                    source: upstream,
                    id: picId,
                    size,
                });
                const rawUrl = data && typeof data.url === 'string' ? data.url.trim() : '';
                const resolved = normalizeHttpsUrl(rawUrl);
                if (resolved) {
                    lruSet(picUrlCache, cacheKey, { url: resolved }, MAX_PIC_CACHE);
                    issuedMedia.add(resolved);
                    return resolved;
                }
                lruSet(picUrlCache, cacheKey, { url: null, expiresAt: Date.now() + PIC_MISS_TTL_MS }, MAX_PIC_CACHE);
                return null;
            } catch (error) {
                api.log.warn(`[GDStudio] cover lookup failed for ${upstream}:${picId}: ${error.message}`);
                lruSet(picUrlCache, cacheKey, { url: null, expiresAt: Date.now() + 60_000 }, MAX_PIC_CACHE);
                return null;
            } finally {
                inFlightPics.delete(cacheKey);
            }
        });

        inFlightPics.set(cacheKey, promise);
        return promise;
    };

    api.media.serve('cover', async (read) => {
        if (!config.loadCovers) return null;
        const slash = read.path.indexOf('/');
        if (slash <= 0 || slash >= read.path.length - 1) return null;
        const upstream = normalizeUpstream(decodeURIComponent(read.path.slice(0, slash)));
        const picId = decodeURIComponent(read.path.slice(slash + 1));
        const size = /^\d{2,4}$/.test(String(read.query.size || '')) ? String(read.query.size) : '500';
        if (!picId) return null;

        const targetUrl = normalizeCoverDirectUrl(picId, upstream) || await resolveCoverImageUrl(upstream, picId, size);
        if (!targetUrl) return null;

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
        try {
            const upstreamRes = await api.net.fetch(targetUrl, {
                method: 'GET',
                credentials: 'omit',
                signal: controller.signal,
                headers: {
                    'user-agent': BROWSER_UA,
                    ...(upstream === 'bilibili' ? { referer: 'https://www.bilibili.com/' } : {}),
                },
            });
            if (!upstreamRes.ok) return null;
            const contentType = upstreamRes.headers.get('content-type') || 'image/jpeg';
            const buf = Buffer.from(await upstreamRes.arrayBuffer());
            return {
                status: 200,
                headers: {
                    'content-type': contentType,
                    'access-control-allow-origin': '*',
                    'cache-control': 'public, max-age=86400',
                },
                body: buf,
            };
        } catch {
            return null;
        } finally {
            clearTimeout(timer);
        }
    });

    const toSourceSong = (item, fallbackUpstream, loadCovers) => {
        if (!item || typeof item !== 'object') return null;

        // Support both GD Studio search/MKOnlineMusicPlayer shape ({ id, name, artist, album, pic_id, source })
        // and NetEase playlist track shape ({ id, name, ar, al, dt }).
        const rawId = item.id !== undefined && item.id !== null ? String(item.id).trim() : '';
        const title = typeof item.name === 'string'
            ? item.name.trim()
            : typeof item.title === 'string'
                ? item.title.trim()
                : '';
        if (!rawId || !title) return null;

        const upstream = normalizeUpstream(item.source || (item.data && item.data.upstream) || fallbackUpstream);
        const songId = rawId.includes(':') ? rawId : `${upstream}:${rawId}`;
        const parsed = parseSongId(songId);
        const cleanTrackId = parsed ? parsed.trackId : rawId;
        const cleanUpstream = parsed ? parsed.upstream : upstream;

        let artistNames = [];
        if (Array.isArray(item.ar)) {
            artistNames = item.ar.map((a) => (a && typeof a.name === 'string' ? a.name.trim() : '')).filter(Boolean);
        } else if (Array.isArray(item.artists)) {
            artistNames = item.artists.map((a) => (typeof a === 'string' ? a.trim() : a && typeof a.name === 'string' ? a.name.trim() : '')).filter(Boolean);
        } else if (Array.isArray(item.artist)) {
            artistNames = item.artist.map((a) => (typeof a === 'string' ? a.trim() : '')).filter(Boolean);
        } else if (typeof item.artist === 'string') {
            artistNames = item.artist.split(/\s*[/,&、]\s*/).map((s) => s.trim()).filter(Boolean);
        }
        const artists = (artistNames.length > 0 ? artistNames.slice(0, 32) : ['Unknown Artist'])
            .map((name) => ({ id: '', name, ref: false }));

        const albumName = typeof item.album === 'string'
            ? item.album.trim()
            : item.al && typeof item.al.name === 'string'
                ? item.al.name.trim()
                : item.album && typeof item.album.name === 'string'
                    ? item.album.name.trim()
                    : '';

        const picId = item.pic_id !== undefined && item.pic_id !== null
            ? String(item.pic_id).trim()
            : item.al && item.al.pic_str
                ? String(item.al.pic_str).trim()
                : '';
        const directPic = normalizeHttpsUrl(
            item.coverUrl
            || item.pic
            || (item.al && item.al.picUrl)
            || (item.album && item.album.coverUrl)
            || '',
        );

        const lyricId = item.lyric_id !== undefined && item.lyric_id !== null ? String(item.lyric_id).trim() : cleanTrackId;
        const urlId = item.url_id !== undefined && item.url_id !== null ? String(item.url_id).trim() : cleanTrackId;

        const durationMs = Number.isFinite(Number(item.dt)) && Number(item.dt) > 0
            ? Math.round(Number(item.dt))
            : Number.isFinite(Number(item.durationMs)) && Number(item.durationMs) > 0
                ? Math.round(Number(item.durationMs))
                : 0;

        let coverUrl = directPic || normalizeCoverDirectUrl(picId, cleanUpstream);
        if (coverUrl) {
            issuedMedia.add(coverUrl);
        } else if (picId && loadCovers) {
            coverUrl = api.media.url('cover', `${encodeURIComponent(cleanUpstream)}/${encodeURIComponent(picId)}`);
        }

        const song = {
            id: songId,
            title,
            artists,
            ...(albumName || coverUrl
                ? { album: { id: '', name: albumName, ref: false, ...(coverUrl ? { coverUrl } : {}) } }
                : {}),
            ...(durationMs ? { durationMs } : {}),
            ...(coverUrl ? { coverUrl } : {}),
            ...(cleanUpstream === 'netease' && /^\d+$/.test(cleanTrackId) ? { lyricIds: { netease: cleanTrackId } } : {}),
            data: {
                upstream: cleanUpstream,
                trackId: cleanTrackId,
                urlId,
                picId,
                lyricId,
            },
        };
        lruSet(songCache, songId, song, MAX_SONG_CACHE);
        return song;
    };

    // ---- Imported playlists persistence (api.storage)
    // Stored record:
    //   - remote playlist: { kind: 'remote', id: 'pl:<id>', playlistId, name, coverUrl?, description?, trackCount? }
    //   - local JSON playlist: { kind: 'local', id: 'local:<uuid>', name, coverUrl?, description?, tracks: FoliumSourceSong[] }

    const readImportedStore = async () => {
        try {
            const raw = await api.storage.get(STORAGE_KEY_IMPORTED);
            return Array.isArray(raw) ? raw.filter((item) => item && typeof item === 'object' && typeof item.id === 'string') : [];
        } catch {
            return [];
        }
    };

    const writeImportedStore = async (records) => {
        await api.storage.set(STORAGE_KEY_IMPORTED, records);
    };

    const recordToCollection = (rec) => ({
        id: rec.id,
        type: 'playlist',
        name: String(rec.name || rec.id),
        ...(rec.coverUrl ? { coverUrl: rec.coverUrl } : {}),
        ...(rec.description ? { description: rec.description } : {}),
        ...(typeof rec.trackCount === 'number'
            ? { trackCount: rec.trackCount }
            : Array.isArray(rec.tracks)
                ? { trackCount: rec.tracks.length }
                : {}),
        data: { kind: rec.kind || 'remote' },
    });

    const fetchRemotePlaylist = async (playlistId) => {
        const cached = playlistCache.get(playlistId);
        if (cached && cached.expiresAt > Date.now()) {
            return cached;
        }
        const payload = await fetchApiJson({
            types: 'playlist',
            source: 'netease',
            id: playlistId,
        });
        const pl = payload && payload.playlist && typeof payload.playlist === 'object' ? payload.playlist : null;
        if (!pl) {
            throw new GdApiError('playlist-not-found', `GD Music Studio returned no playlist for id ${playlistId}`);
        }
        const coverUrl = normalizeHttpsUrl(pl.coverImgUrl || '');
        if (coverUrl) issuedMedia.add(coverUrl);
        const rawTracks = Array.isArray(pl.tracks) ? pl.tracks : [];
        const songs = rawTracks.map((row) => toSourceSong(row, 'netease', config.loadCovers)).filter(Boolean);
        const collection = {
            id: `pl:${playlistId}`,
            type: 'playlist',
            name: typeof pl.name === 'string' && pl.name.trim() ? pl.name.trim() : `歌单 ${playlistId}`,
            ...(coverUrl ? { coverUrl } : {}),
            ...(typeof pl.description === 'string' && pl.description.trim() ? { description: pl.description.trim().slice(0, 500) } : {}),
            trackCount: songs.length || (Number(pl.trackCount) || 0),
            ...(Number.isFinite(Number(pl.playCount)) ? { playCount: Number(pl.playCount) } : {}),
            ...(pl.creator && typeof pl.creator.nickname === 'string'
                ? {
                    creator: {
                        id: String(pl.creator.userId ?? ''),
                        nickname: pl.creator.nickname,
                        ...(pl.creator.avatarUrl ? { avatarUrl: normalizeHttpsUrl(pl.creator.avatarUrl) } : {}),
                    },
                }
                : {}),
        };
        const entry = { collection, songs, expiresAt: Date.now() + PLAYLIST_CACHE_TTL_MS };
        lruSet(playlistCache, playlistId, entry, MAX_PLAYLIST_CACHE);
        return entry;
    };

    const fetchUserPlaylistsByUid = async (uid) => {
        const cleanUid = extractNumericId(uid);
        if (!cleanUid) return [];
        const cached = userListCache.get(cleanUid);
        if (cached && cached.expiresAt > Date.now()) {
            return cached.collections;
        }
        const payload = await fetchApiJson({
            types: 'userlist',
            source: 'netease',
            id: cleanUid,
        });
        const list = payload && Array.isArray(payload.playlist) ? payload.playlist : [];
        const collections = list
            .filter((pl) => pl && typeof pl === 'object' && pl.id)
            .slice(0, 50)
            .map((pl) => {
                const pid = String(pl.id);
                const coverUrl = normalizeHttpsUrl(pl.coverImgUrl || '');
                if (coverUrl) issuedMedia.add(coverUrl);
                return {
                    id: `pl:${pid}`,
                    type: 'playlist',
                    name: typeof pl.name === 'string' && pl.name.trim() ? pl.name.trim() : `歌单 ${pid}`,
                    ...(coverUrl ? { coverUrl } : {}),
                    ...(typeof pl.description === 'string' && pl.description.trim() ? { description: pl.description.trim().slice(0, 500) } : {}),
                    ...(Number.isFinite(Number(pl.trackCount)) ? { trackCount: Number(pl.trackCount) } : {}),
                    ...(Number.isFinite(Number(pl.playCount)) ? { playCount: Number(pl.playCount) } : {}),
                    ...(pl.creator && typeof pl.creator.nickname === 'string'
                        ? { creator: { id: String(pl.creator.userId ?? cleanUid), nickname: pl.creator.nickname } }
                        : {}),
                };
            });
        userListCache.set(cleanUid, { collections, expiresAt: Date.now() + USERLIST_CACHE_TTL_MS });
        return collections;
    };

    // Parse GD Music Studio / MKOnlineMusicPlayer / generic JSON exports into local playlist records.
    const tryJsonParse = (value) => {
        if (typeof value !== 'string') return value;
        const trimmed = value.trim();
        if (!(trimmed.startsWith('[') || trimmed.startsWith('{'))) return value;
        try {
            return JSON.parse(trimmed);
        } catch {
            return value;
        }
    };

    const looksLikeTrack = (item) => Boolean(
        item
        && typeof item === 'object'
        && !Array.isArray(item)
        && (item.id !== undefined && item.id !== null)
        && (typeof item.name === 'string' || typeof item.title === 'string')
        && (item.artist !== undefined || item.artists !== undefined || item.ar !== undefined || item.source !== undefined || item.url_id !== undefined),
    );

    const parseJsonIntoPlaylists = (rawText, fallbackName) => {
        const root = JSON.parse(rawText);
        const extracted = [];
        const pushPlaylist = (name, items, coverUrl = '') => {
            if (!Array.isArray(items)) return;
            const songs = items.filter(looksLikeTrack).map((row) => toSourceSong(row, config.upstream, config.loadCovers)).filter(Boolean);
            if (songs.length === 0) return;
            const cover = normalizeHttpsUrl(coverUrl) || songs.find((s) => s.coverUrl)?.coverUrl || '';
            extracted.push({
                kind: 'local',
                id: `local:${crypto.randomUUID()}`,
                name: String(name || fallbackName || 'GD 导出歌单').slice(0, 80),
                ...(cover ? { coverUrl: cover } : {}),
                trackCount: songs.length,
                tracks: songs,
            });
        };

        const inspect = (node, label) => {
            const parsed = tryJsonParse(node);
            if (!parsed || typeof parsed !== 'object') return;
            if (Array.isArray(parsed)) {
                if (parsed.some(looksLikeTrack)) {
                    pushPlaylist(label, parsed);
                    return;
                }
                // Array of playlist objects (e.g. MKOnlineMusicPlayer musicList)
                parsed.forEach((entry, idx) => {
                    const obj = tryJsonParse(entry);
                    if (!obj || typeof obj !== 'object') return;
                    const list = tryJsonParse(obj.item || obj.tracks || obj.songs || obj.list);
                    if (Array.isArray(list) && list.some(looksLikeTrack)) {
                        pushPlaylist(obj.name || obj.title || `${label} #${idx + 1}`, list, obj.cover || obj.coverUrl || obj.coverImgUrl || '');
                    }
                });
                return;
            }
            // Single playlist object { name, tracks/songs/item/list }
            const directList = tryJsonParse(parsed.tracks || parsed.songs || parsed.item || parsed.list);
            if (Array.isArray(directList) && directList.some(looksLikeTrack)) {
                pushPlaylist(parsed.name || parsed.title || label, directList, parsed.cover || parsed.coverUrl || parsed.coverImgUrl || '');
                return;
            }
            if (parsed.playlist && typeof parsed.playlist === 'object') {
                const plTracks = tryJsonParse(parsed.playlist.tracks || parsed.playlist.item);
                if (Array.isArray(plTracks) && plTracks.some(looksLikeTrack)) {
                    pushPlaylist(parsed.playlist.name || label, plTracks, parsed.playlist.coverImgUrl || '');
                    return;
                }
            }
            if (Array.isArray(parsed.playlists)) {
                inspect(parsed.playlists, label);
                return;
            }
            // Browser localStorage dump: { "mkPlayer_playing": "[...]", "mkPlayer_his": "[...]", "playlist": "..." }
            for (const [key, val] of Object.entries(parsed)) {
                const inner = tryJsonParse(val);
                if (inner && typeof inner === 'object') {
                    const niceLabel = key.replace(/^mkPlayer[_-]?/i, '') || label;
                    inspect(inner, niceLabel);
                }
            }
        };

        inspect(root, fallbackName);
        return extracted;
    };

    const failEnvelope = (error) => {
        if (error instanceof GdApiError) {
            return {
                ok: false,
                code: error.code,
                message: error.message,
                httpStatus: error.httpStatus,
                upstream: error.upstream,
            };
        }
        return {
            ok: false,
            code: 'unavailable',
            message: error instanceof Error ? error.message : String(error),
        };
    };

    api.rpc.handle('configure', async (patch) => {
        applyConfig(patch);
        return { ok: true, data: { ...config } };
    });

    api.rpc.handle('searchSongs', async (params) => {
        try {
            const input = params && typeof params === 'object' ? params : {};
            if (input.config) applyConfig(input.config);
            const query = typeof input.query === 'string' ? input.query.trim() : '';
            if (!query) return { ok: true, data: { items: [], hasMore: false } };

            const count = Math.min(Math.max(Math.trunc(Number(input.limit)) || 20, 1), 50);
            const offset = Math.max(Math.trunc(Number(input.offset)) || 0, 0);
            const pages = Math.floor(offset / count) + 1;
            const upstream = normalizeUpstream(input.upstream || config.upstream);

            const payload = await fetchApiJson({
                types: 'search',
                source: upstream,
                name: query,
                count,
                pages,
            });
            const rows = Array.isArray(payload) ? payload : [];
            const items = rows.map((row) => toSourceSong(row, upstream, config.loadCovers)).filter(Boolean);
            return {
                ok: true,
                data: {
                    items,
                    hasMore: items.length >= count,
                    nextOffset: offset + items.length,
                },
            };
        } catch (error) {
            api.log.warn(`[GDStudio] searchSongs failed: ${error.message}`);
            return failEnvelope(error);
        }
    });

    api.rpc.handle('getSong', async (id) => {
        const key = typeof id === 'string' ? id : '';
        return { ok: true, data: songCache.get(key) ?? null };
    });

    api.rpc.handle('getAudioSource', async (song, quality, cfgPatch) => {
        try {
            if (cfgPatch) applyConfig(cfgPatch);
            const songId = song && typeof song === 'object' ? song.id : '';
            const parsed = parseSongId(songId);
            const dataObj = song && typeof song === 'object' && song.data && typeof song.data === 'object' ? song.data : {};
            const upstream = normalizeUpstream(dataObj.upstream || (parsed && parsed.upstream) || config.upstream);
            const trackId = String(dataObj.urlId || dataObj.trackId || (parsed && parsed.trackId) || '').trim();
            if (!trackId) {
                throw new GdApiError('not-playable', 'Missing track ID for GD Music Studio');
            }

            const targetBr = QUALITY_TO_BR[quality] ?? 320;
            let result = await fetchApiJson({
                types: 'url',
                source: upstream,
                id: trackId,
                br: targetBr,
            });

            let audioUrl = result && typeof result.url === 'string' ? result.url.trim() : '';
            if (!audioUrl && targetBr > 320) {
                result = await fetchApiJson({
                    types: 'url',
                    source: upstream,
                    id: trackId,
                    br: 320,
                });
                audioUrl = result && typeof result.url === 'string' ? result.url.trim() : '';
            }

            if (audioUrl.startsWith('//')) audioUrl = `https:${audioUrl}`;
            if (!/^https?:\/\//i.test(audioUrl)) {
                throw new GdApiError('not-playable', `GD Music Studio returned no audio URL for ${upstream}:${trackId}`);
            }

            issuedMedia.add(audioUrl);
            const actualQuality = brToQuality(result && result.br);
            return {
                ok: true,
                data: {
                    url: audioUrl,
                    quality: actualQuality,
                    expiresAt: Date.now() + 20 * 60 * 1000,
                },
            };
        } catch (error) {
            api.log.warn(`[GDStudio] getAudioSource failed: ${error.message}`);
            return failEnvelope(error);
        }
    });

    api.rpc.handle('getLyrics', async (song, cfgPatch) => {
        try {
            if (cfgPatch) applyConfig(cfgPatch);
            const songId = song && typeof song === 'object' ? song.id : '';
            const parsed = parseSongId(songId);
            const dataObj = song && typeof song === 'object' && song.data && typeof song.data === 'object' ? song.data : {};
            const upstream = normalizeUpstream(dataObj.upstream || (parsed && parsed.upstream) || config.upstream);
            const lyricId = String(dataObj.lyricId || dataObj.trackId || (parsed && parsed.trackId) || '').trim();
            if (!lyricId) return { ok: true, data: null };

            const cacheKey = `${upstream}:${lyricId}`;
            if (lyricCache.has(cacheKey)) {
                return { ok: true, data: lyricCache.get(cacheKey) };
            }

            const payload = await fetchApiJson({
                types: 'lyric',
                source: upstream,
                id: lyricId,
            });
            const lyric = payload && typeof payload.lyric === 'string' ? payload.lyric.trim() : '';
            const tlyric = payload && typeof payload.tlyric === 'string' ? payload.tlyric.trim() : '';
            const resolved = lyric
                ? { lyric, ...(tlyric ? { translation: tlyric } : {}) }
                : null;
            lruSet(lyricCache, cacheKey, resolved, MAX_LYRIC_CACHE);
            return { ok: true, data: resolved };
        } catch (error) {
            api.log.warn(`[GDStudio] getLyrics failed: ${error.message}`);
            return failEnvelope(error);
        }
    });

    // ---- Explore, Library & Catalog (Playlists)

    const collectAllUserPlaylists = async ({ forceRefresh = false } = {}) => {
        const imported = await readImportedStore();
        const combined = new Map();

        // Keep locally imported JSON playlists at the top.
        imported
            .filter((rec) => rec.kind === 'local')
            .forEach((rec) => combined.set(rec.id, recordToCollection(rec)));

        // When syncing (offset === 0), force-refresh the configured UID's live playlists from GD Studio.
        if (config.neteaseUid) {
            try {
                if (forceRefresh) userListCache.delete(config.neteaseUid);
                const userCols = await fetchUserPlaylistsByUid(config.neteaseUid);
                userCols.forEach((col) => {
                    if (!combined.has(col.id)) combined.set(col.id, col);
                });
                if (forceRefresh && userCols.length > 0) {
                    const freshRecords = userCols.map((col) => ({
                        kind: 'remote',
                        id: col.id,
                        playlistId: col.id.replace(/^pl:/, ''),
                        name: col.name,
                        ...(col.coverUrl ? { coverUrl: col.coverUrl } : {}),
                        ...(col.description ? { description: col.description } : {}),
                        ...(typeof col.trackCount === 'number' ? { trackCount: col.trackCount } : {}),
                    }));
                    const freshIds = new Set(freshRecords.map((r) => r.id));
                    const localOnly = imported.filter((r) => r.kind === 'local');
                    const extraRemote = imported.filter((r) => r.kind !== 'local' && !freshIds.has(r.id));
                    await writeImportedStore([...localOnly, ...freshRecords, ...extraRemote]);
                }
            } catch (error) {
                api.log.warn(`[GDStudio] userlist lookup failed for uid ${config.neteaseUid}: ${error.message}`);
            }
        }

        // Merge any remaining stored remote playlists (fallback if offline/rate-limited or imported by single ID).
        imported
            .filter((rec) => rec.kind !== 'local')
            .forEach((rec) => {
                if (!combined.has(rec.id)) combined.set(rec.id, recordToCollection(rec));
            });

        for (const pid of parseIdList(config.playlistIds)) {
            const colId = `pl:${pid}`;
            if (!combined.has(colId)) {
                const cached = playlistCache.get(pid);
                combined.set(colId, cached ? cached.collection : {
                    id: colId,
                    type: 'playlist',
                    name: `歌单 ${pid}`,
                });
            }
        }

        // If user hasn't imported anything yet, show built-in GD charts so the Playlists tab is ready immediately.
        if (combined.size === 0) {
            GD_BUILTIN_CHARTS.forEach((item) => {
                const cached = playlistCache.get(item.id);
                combined.set(`pl:${item.id}`, cached ? cached.collection : {
                    id: `pl:${item.id}`,
                    type: 'playlist',
                    name: item.name,
                    description: item.description,
                });
            });
        }

        return [...combined.values()];
    };

    api.rpc.handle('getUserPlaylists', async (limit, offset, cfgPatch) => {
        try {
            if (cfgPatch) applyConfig(cfgPatch);
            const safeLimit = Math.min(Math.max(Math.trunc(Number(limit)) || 100, 1), 500);
            const safeOffset = Math.max(Math.trunc(Number(offset)) || 0, 0);
            const all = await collectAllUserPlaylists({ forceRefresh: safeOffset === 0 });
            const items = all.slice(safeOffset, safeOffset + safeLimit);
            return {
                ok: true,
                data: {
                    items,
                    total: all.length,
                    hasMore: safeOffset + items.length < all.length,
                    nextOffset: safeOffset + items.length,
                },
            };
        } catch (error) {
            api.log.warn(`[GDStudio] getUserPlaylists failed: ${error.message}`);
            return failEnvelope(error);
        }
    });

    api.rpc.handle('getExploreFeed', async (cfgPatch) => {
        try {
            if (cfgPatch) applyConfig(cfgPatch);
            const imported = await readImportedStore();
            const importedMap = new Map();
            imported.forEach((rec) => importedMap.set(rec.id, recordToCollection(rec)));

            // Also include any playlist IDs typed into settings `playlistIds`.
            for (const pid of parseIdList(config.playlistIds)) {
                const colId = `pl:${pid}`;
                if (!importedMap.has(colId)) {
                    const cached = playlistCache.get(pid);
                    importedMap.set(colId, cached ? cached.collection : {
                        id: colId,
                        type: 'playlist',
                        name: `歌单 ${pid}`,
                    });
                }
            }

            let userPlaylists = [];
            if (config.neteaseUid) {
                try {
                    userPlaylists = await fetchUserPlaylistsByUid(config.neteaseUid);
                } catch (error) {
                    api.log.warn(`[GDStudio] userlist lookup failed for uid ${config.neteaseUid}: ${error.message}`);
                }
            }

            const charts = GD_BUILTIN_CHARTS.map((item) => {
                const cached = playlistCache.get(item.id);
                return cached ? cached.collection : {
                    id: `pl:${item.id}`,
                    type: 'playlist',
                    name: item.name,
                    description: item.description,
                };
            });

            return {
                ok: true,
                data: {
                    imported: [...importedMap.values()],
                    userPlaylists,
                    charts,
                },
            };
        } catch (error) {
            api.log.warn(`[GDStudio] getExploreFeed failed: ${error.message}`);
            return failEnvelope(error);
        }
    });

    api.rpc.handle('getPlaylistDetail', async (id, cfgPatch) => {
        try {
            if (cfgPatch) applyConfig(cfgPatch);
            const rawId = typeof id === 'string' ? id.trim() : '';
            if (!rawId) return { ok: true, data: null };
            if (rawId.startsWith('local:')) {
                const imported = await readImportedStore();
                const found = imported.find((rec) => rec.id === rawId);
                return { ok: true, data: found ? recordToCollection(found) : null };
            }
            const pid = rawId.startsWith('pl:') ? rawId.slice(3) : extractNumericId(rawId);
            if (!pid) return { ok: true, data: null };
            const entry = await fetchRemotePlaylist(pid);
            return { ok: true, data: entry.collection };
        } catch (error) {
            api.log.warn(`[GDStudio] getPlaylistDetail failed: ${error.message}`);
            return failEnvelope(error);
        }
    });

    api.rpc.handle('getPlaylistTracks', async (id, limit, offset, cfgPatch) => {
        try {
            if (cfgPatch) applyConfig(cfgPatch);
            const rawId = typeof id === 'string' ? id.trim() : '';
            const safeLimit = Math.min(Math.max(Math.trunc(Number(limit)) || 100, 1), 500);
            const safeOffset = Math.max(Math.trunc(Number(offset)) || 0, 0);
            if (!rawId) return { ok: true, data: { items: [], total: 0, hasMore: false } };

            let songs = [];
            if (rawId.startsWith('local:')) {
                const imported = await readImportedStore();
                const found = imported.find((rec) => rec.id === rawId);
                songs = Array.isArray(found?.tracks) ? found.tracks : [];
                songs.forEach((s) => { if (s && s.id) lruSet(songCache, s.id, s, MAX_SONG_CACHE); });
            } else {
                const pid = rawId.startsWith('pl:') ? rawId.slice(3) : extractNumericId(rawId);
                if (!pid) return { ok: true, data: { items: [], total: 0, hasMore: false } };
                const entry = await fetchRemotePlaylist(pid);
                songs = entry.songs;
            }
            const items = songs.slice(safeOffset, safeOffset + safeLimit);
            return {
                ok: true,
                data: {
                    items,
                    total: songs.length,
                    hasMore: safeOffset + items.length < songs.length,
                    nextOffset: safeOffset + items.length,
                },
            };
        } catch (error) {
            api.log.warn(`[GDStudio] getPlaylistTracks failed: ${error.message}`);
            return failEnvelope(error);
        }
    });

    // ---- Playlist Import Commands

    api.rpc.handle('importPlaylistById', async (input, cfgPatch) => {
        try {
            if (cfgPatch) applyConfig(cfgPatch);
            const pid = extractNumericId(input);
            if (!pid) {
                throw new GdApiError('playlist-not-found', 'Invalid playlist ID or URL');
            }
            const entry = await fetchRemotePlaylist(pid);
            const imported = await readImportedStore();
            const record = {
                kind: 'remote',
                id: entry.collection.id,
                playlistId: pid,
                name: entry.collection.name,
                ...(entry.collection.coverUrl ? { coverUrl: entry.collection.coverUrl } : {}),
                ...(entry.collection.description ? { description: entry.collection.description } : {}),
                trackCount: entry.songs.length,
            };
            const next = [record, ...imported.filter((r) => r.id !== record.id)];
            await writeImportedStore(next);
            return { ok: true, data: { name: record.name, count: entry.songs.length } };
        } catch (error) {
            api.log.warn(`[GDStudio] importPlaylistById failed: ${error.message}`);
            return failEnvelope(error);
        }
    });

    api.rpc.handle('importUserPlaylists', async (uidInput, cfgPatch) => {
        try {
            if (cfgPatch) applyConfig(cfgPatch);
            const uid = extractNumericId(uidInput);
            if (!uid) {
                throw new GdApiError('playlist-not-found', 'Invalid NetEase user UID');
            }
            userListCache.delete(uid);
            const collections = await fetchUserPlaylistsByUid(uid);
            const imported = await readImportedStore();
            const newRecords = collections.map((col) => ({
                kind: 'remote',
                id: col.id,
                playlistId: col.id.replace(/^pl:/, ''),
                name: col.name,
                ...(col.coverUrl ? { coverUrl: col.coverUrl } : {}),
                ...(col.description ? { description: col.description } : {}),
                ...(typeof col.trackCount === 'number' ? { trackCount: col.trackCount } : {}),
            }));
            const newIds = new Set(newRecords.map((r) => r.id));
            const next = [...newRecords, ...imported.filter((r) => !newIds.has(r.id))];
            await writeImportedStore(next);
            return { ok: true, data: { uid, count: newRecords.length } };
        } catch (error) {
            api.log.warn(`[GDStudio] importUserPlaylists failed: ${error.message}`);
            return failEnvelope(error);
        }
    });

    api.rpc.handle('importJsonFile', async (cfgPatch) => {
        try {
            if (cfgPatch) applyConfig(cfgPatch);
            const filePath = await api.dialog.pickFile({
                filters: [{ name: 'GD Music Studio Playlist JSON', extensions: ['json', 'txt'] }],
            });
            if (!filePath) return { ok: true, data: { cancelled: true } };
            const stat = await fs.promises.stat(filePath);
            if (stat.size > MAX_JSON_FILE_BYTES) {
                throw new GdApiError('invalid-response', 'JSON file is too large (max 10 MB)');
            }
            const rawText = await fs.promises.readFile(filePath, 'utf8');
            const baseName = path.basename(filePath, path.extname(filePath));
            const parsed = parseJsonIntoPlaylists(rawText, baseName);
            if (parsed.length === 0) {
                return { ok: true, data: { cancelled: false, playlists: 0, tracks: 0 } };
            }
            const imported = await readImportedStore();
            await writeImportedStore([...parsed, ...imported]);
            const totalTracks = parsed.reduce((sum, pl) => sum + pl.tracks.length, 0);
            return { ok: true, data: { cancelled: false, playlists: parsed.length, tracks: totalTracks } };
        } catch (error) {
            api.log.warn(`[GDStudio] importJsonFile failed: ${error.message}`);
            return failEnvelope(error);
        }
    });

    api.rpc.handle('clearImportedPlaylists', async () => {
        try {
            const imported = await readImportedStore();
            await writeImportedStore([]);
            return { ok: true, data: { count: imported.length } };
        } catch (error) {
            return failEnvelope(error);
        }
    });

    api.onBeforeUnload(() => {
        inFlightPics.clear();
    });
};
