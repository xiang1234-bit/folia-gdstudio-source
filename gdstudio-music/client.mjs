// gdstudio-music/client.mjs
// Client entry for the GD Music Studio (music.gdstudio.xyz) Folium 2 audio source mod.
// Registers the `gdstudio` audio source synchronously before any await, plus settings and playlist import commands.

const DEFAULT_API_URL = 'https://music-api.gdstudio.xyz/api.php';
const NETEASE_NUMERIC_ID = /^[1-9]\d{0,19}$/;

const UPSTREAM_OPTIONS = [
    { value: 'netease', label: { 'zh-CN': '网易云音乐 (netease · 推荐)', en: 'NetEase Cloud Music (netease)' } },
    { value: 'joox', label: { 'zh-CN': 'JOOX (joox)', en: 'JOOX (joox)' } },
    { value: 'bilibili', label: { 'zh-CN': '哔哩哔哩 (bilibili)', en: 'Bilibili (bilibili)' } },
    { value: 'tencent', label: { 'zh-CN': 'QQ 音乐 (tencent · 视接口状态)', en: 'QQ Music (tencent)' } },
    { value: 'kuwo', label: { 'zh-CN': '酷我音乐 (kuwo · 视接口状态)', en: 'Kuwo (kuwo)' } },
    { value: 'kugou', label: { 'zh-CN': '酷狗音乐 (kugou · 视接口状态)', en: 'Kugou (kugou)' } },
    { value: 'tidal', label: { 'zh-CN': 'TIDAL (tidal · 视接口状态)', en: 'TIDAL (tidal)' } },
    { value: 'qobuz', label: { 'zh-CN': 'Qobuz (qobuz · 视接口状态)', en: 'Qobuz (qobuz)' } },
    { value: 'apple', label: { 'zh-CN': 'Apple Music (apple · 视接口状态)', en: 'Apple Music (apple)' } },
    { value: 'ytmusic', label: { 'zh-CN': 'YouTube Music (ytmusic · 视接口状态)', en: 'YouTube Music (ytmusic)' } },
    { value: 'spotify', label: { 'zh-CN': 'Spotify (spotify · 视接口状态)', en: 'Spotify (spotify)' } },
];

const clip = (value, max = 512) => (typeof value === 'string' ? value.slice(0, max) : '');

const counterpartForNetease = (song) => {
    if (!song || typeof song !== 'object' || song.sourceId !== 'netease') return null;
    const rawId = typeof song.id === 'string' ? song.id.trim() : '';
    const title = clip(song.title).trim();
    if (!NETEASE_NUMERIC_ID.test(rawId) || !title) return null;

    const artists = (Array.isArray(song.artists) ? song.artists : [])
        .map((name) => clip(name).trim())
        .filter(Boolean)
        .slice(0, 32);
    const albumName = clip(song.album).trim();
    const coverUrl = /^https?:\/\//i.test(clip(song.coverUrl, 2048)) ? clip(song.coverUrl, 2048) : '';
    const durationMs = typeof song.durationMs === 'number' && Number.isFinite(song.durationMs) && song.durationMs > 0
        ? Math.round(song.durationMs)
        : 0;

    return {
        id: `netease:${rawId}`,
        title,
        artists: artists.length > 0 ? artists.map((name) => ({ id: '', name, ref: false })) : [{ id: '', name: 'Unknown Artist', ref: false }],
        ...(albumName || coverUrl ? { album: { id: '', name: albumName, ref: false, ...(coverUrl ? { coverUrl } : {}) } } : {}),
        ...(durationMs ? { durationMs } : {}),
        ...(coverUrl ? { coverUrl } : {}),
        lyricIds: { netease: rawId },
        data: {
            upstream: 'netease',
            trackId: rawId,
            urlId: rawId,
            picId: '',
            lyricId: rawId,
        },
    };
};

export default function activate(folium) {
    const { sources, i18n } = folium;

    const section = folium.registries.settingsSections.register({
        id: 'gdstudio-settings',
        label: { 'zh-CN': 'GD 音乐台设置', en: 'GD Music Studio Settings' },
        description: {
            'zh-CN': '配置 GD 音乐台 (music.gdstudio.xyz) 的接口地址、搜索上游与歌单同步。公开接口存在频率限制（约 5 分钟 50 次请求），仅供个人学习研究使用。',
            en: 'Configure GD Music Studio (music.gdstudio.xyz) API endpoint, search upstream, and playlist sync. Public API is rate-limited (~50 req / 5 min).',
        },
        settings: [
            {
                key: 'upstream',
                type: 'select',
                label: { 'zh-CN': '搜索上游平台', en: 'Search upstream platform' },
                description: {
                    'zh-CN': '搜索时使用的 GD 音乐台上游音源（部分平台随官方接口维护变动，已加入歌单/队列的歌曲会保留原上游）。',
                    en: 'Upstream source used for searches (queued tracks keep their original upstream).',
                },
                defaultValue: 'netease',
                options: UPSTREAM_OPTIONS,
            },
            {
                key: 'customUpstream',
                type: 'text',
                label: { 'zh-CN': '自定义上游代号（可选）', en: 'Custom upstream code (optional)' },
                description: {
                    'zh-CN': '留空则使用上方下拉选择；填写后优先作为 source 参数发送（例如 netease_album）。',
                    en: 'Leave blank to use the selection above; when set, overrides the API source parameter.',
                },
                placeholder: 'netease',
                defaultValue: '',
            },
            {
                key: 'neteaseUid',
                type: 'text',
                label: { 'zh-CN': '同步歌单的网易云用户 UID', en: 'NetEase User UID for playlist sync' },
                description: {
                    'zh-CN': '与 GD 音乐台网页端「我的歌单[导入]」相同：填写公开可见的网易云 UID，将在 GD 音乐台发现页展示该用户的全部公开歌单。',
                    en: 'Same as GD Music Studio web import: enter a public NetEase UID to display their playlists on the Explore page.',
                },
                placeholder: '例如 32953014',
                defaultValue: '',
            },
            {
                key: 'playlistIds',
                type: 'text',
                label: { 'zh-CN': '歌单 ID / 链接（多个用逗号分隔）', en: 'Playlist IDs or URLs (comma-separated)' },
                description: {
                    'zh-CN': '填写单个或多个网易云歌单 ID 或链接（如 3778678, 19723756），将在 GD 音乐台发现页直接显示。',
                    en: 'Enter one or more NetEase playlist IDs or URLs to pin on the GD Music Studio Explore page.',
                },
                placeholder: '3778678, https://music.163.com/#/playlist?id=19723756',
                defaultValue: '',
            },
            {
                key: 'apiUrl',
                type: 'text',
                label: { 'zh-CN': 'API 接口地址', en: 'API endpoint URL' },
                description: {
                    'zh-CN': '默认使用官方独立 API 域名 https://music-api.gdstudio.xyz/api.php，也可替换为兼容的镜像地址。',
                    en: 'Defaults to https://music-api.gdstudio.xyz/api.php.',
                },
                placeholder: DEFAULT_API_URL,
                defaultValue: DEFAULT_API_URL,
            },
            {
                key: 'loadCovers',
                type: 'boolean',
                label: { 'zh-CN': '按需加载专辑封面', en: 'Load album covers on demand' },
                description: {
                    'zh-CN': '通过本地缓存代理按需获取封面图；若经常触发限流可关闭此项以节省请求额度。',
                    en: 'Lazily fetch album covers via cached proxy; disable to save API quota if rate-limited.',
                },
                defaultValue: true,
            },
        ],
    });

    const readConfig = () => {
        const values = section.settings.get();
        const custom = typeof values.customUpstream === 'string' ? values.customUpstream.trim().toLowerCase() : '';
        const selected = typeof values.upstream === 'string' && values.upstream ? values.upstream : 'netease';
        const apiUrl = typeof values.apiUrl === 'string' && values.apiUrl.trim() ? values.apiUrl.trim() : DEFAULT_API_URL;
        const loadCovers = values.loadCovers !== false;
        const neteaseUid = typeof values.neteaseUid === 'string' ? values.neteaseUid.trim() : '';
        const playlistIds = typeof values.playlistIds === 'string' ? values.playlistIds.trim() : '';
        return {
            apiUrl,
            upstream: custom || selected,
            loadCovers,
            neteaseUid,
            playlistIds,
        };
    };

    const toSourceError = (res) => {
        const code = res && typeof res.code === 'string' ? res.code : 'unavailable';
        const message = res && typeof res.message === 'string' ? res.message : 'GD Music Studio request failed';
        const details = {};
        if (res && typeof res.httpStatus === 'number') details.httpStatus = res.httpStatus;
        if (code === 'rate-limited') details.retryAfterMs = 60_000;

        let foliumCode = 'unavailable';
        if (code === 'not-playable') foliumCode = 'not-playable';
        else if (code === 'network') foliumCode = 'network';
        else if (code === 'invalid-response') foliumCode = 'invalid-response';
        else if (code === 'unsupported-source') foliumCode = 'unsupported';
        else if (code === 'playlist-not-found') foliumCode = 'not-public';

        const err = sources.error(foliumCode, message, details);
        err.gdCode = code;
        err.gdUpstream = res && res.upstream ? String(res.upstream) : '';
        return err;
    };

    const callRpc = async (method, ...args) => {
        const res = await folium.rpc.call(method, ...args);
        if (!res || typeof res !== 'object') {
            throw sources.error('invalid-response', 'Empty RPC response from GD Music Studio backend');
        }
        if (res.ok !== true) {
            throw toSourceError(res);
        }
        return res.data;
    };

    const syncConfigToMain = () => {
        folium.rpc.call('configure', readConfig()).catch((error) => {
            folium.log.warn('[GDStudio] failed to sync config to main process', error);
        });
    };

    let signedOut = false;

    const currentUser = () => {
        if (signedOut) return null;
        const uid = readConfig().neteaseUid;
        return {
            id: uid || 'gdstudio',
            nickname: uid ? `GD 音乐台 (UID ${uid})` : 'GD 音乐台',
        };
    };

    const sourceHandle = sources.register({
        id: 'gdstudio',
        displayName: i18n.key('source.name'),
        shortName: i18n.key('source.short'),
        mark: { letter: 'G', color: '#3b82f6' },
        getAvailability: () => AVAILABLE,
        describeFailure: (_operation, error) => {
            if (!error || typeof error !== 'object') return null;
            if (error.gdCode === 'rate-limited') {
                return { case: 'retry-later', httpStatus: error.httpStatus, retryAfterMs: 60_000, message: i18n.text('failure.rateLimited') };
            }
            if (error.gdCode === 'unsupported-source') {
                return {
                    case: 'not-configured',
                    message: i18n.text('failure.unsupportedSource', { upstream: error.gdUpstream || readConfig().upstream }),
                };
            }
            if (error.gdCode === 'cloudflare') {
                return { case: 'refused', httpStatus: error.httpStatus, message: i18n.text('failure.cloudflare') };
            }
            if (error.gdCode === 'playlist-not-found') {
                return { case: 'not-public', message: i18n.text('failure.playlistNotFound') };
            }
            if (error.gdCode === 'not-playable' || error.code === 'not-playable') {
                return { case: 'no-audio', message: i18n.text('failure.noAudio') };
            }
            return null;
        },
        capabilities: {
            'search@1': {
                searchSongs: async (query, limit, offset) => {
                    const cfg = readConfig();
                    return callRpc('searchSongs', {
                        query,
                        limit,
                        offset,
                        upstream: cfg.upstream,
                        config: cfg,
                    });
                },
            },
            'songs@1': {
                metadataMatch: true,
                getSong: async (id) => callRpc('getSong', id),
                counterpartSources: ['netease'],
                getCounterparts: async (foreignSongs) => (
                    Array.isArray(foreignSongs) ? foreignSongs.map(counterpartForNetease) : []
                ),
            },
            'playback.audio@1': {
                audioQualityLevels: ['standard', 'high', 'lossless', 'hires'],
                getAudioSource: async (song, quality) => callRpc('getAudioSource', song, quality, readConfig()),
            },
            'lyrics@1': {
                crossSource: {
                    linesOnly: true,
                    name: i18n.key('lyricSource.name'),
                },
                getLyrics: async (song) => {
                    const res = await callRpc('getLyrics', song, readConfig());
                    if (!res || !res.lyric) return null;
                    return {
                        main: {
                            format: 'lrc',
                            text: res.lyric,
                            ...(res.translation ? { translationText: res.translation } : {}),
                        },
                    };
                },
            },
            'auth@1': {
                getLoginStatus: async () => currentUser(),
                logout: async () => {
                    signedOut = true;
                },
                getLoginTexts: () => ({
                    title: i18n.key('login.title'),
                    note: i18n.key('login.note'),
                }),
                getLoginForm: () => ({
                    fields: [
                        {
                            key: 'uid',
                            type: 'text',
                            label: i18n.key('login.uidLabel'),
                            placeholder: i18n.key('login.uidPlaceholder'),
                            required: false,
                        },
                    ],
                    submitLabel: i18n.key('login.submit'),
                }),
                submitLoginForm: async (values) => {
                    const rawUid = values && typeof values.uid === 'string' ? values.uid.trim() : '';
                    signedOut = false;
                    if (rawUid) {
                        const res = await callRpc('importUserPlaylists', rawUid, readConfig());
                        section.settings.set({ neteaseUid: res.uid });
                        syncConfigToMain();
                    }
                    return currentUser();
                },
            },
            'library@1': {
                getUserPlaylists: async (_userId, limit, offset) => (
                    callRpc('getUserPlaylists', limit, offset, readConfig())
                ),
            },
            'catalog@1': {
                getPlaylistDetail: async (id, collection) => {
                    const detail = await callRpc('getPlaylistDetail', id, readConfig());
                    return detail ?? collection ?? null;
                },
                getPlaylistTracks: async (id, limit, offset) => (
                    callRpc('getPlaylistTracks', id, limit, offset, readConfig())
                ),
            },
            'explore@1': {
                async getFeed(cursor) {
                    if (cursor) return { sections: [] };
                    const feed = await callRpc('getExploreFeed', readConfig());
                    const sections = [];
                    if (Array.isArray(feed.imported) && feed.imported.length > 0) {
                        sections.push({
                            id: 'imported',
                            title: i18n.key('explore.imported'),
                            items: feed.imported.map((collection) => ({ kind: 'collection', collection })),
                        });
                    }
                    if (Array.isArray(feed.userPlaylists) && feed.userPlaylists.length > 0) {
                        sections.push({
                            id: 'user-playlists',
                            title: i18n.key('explore.userPlaylists'),
                            items: feed.userPlaylists.map((collection) => ({ kind: 'collection', collection })),
                        });
                    }
                    if (Array.isArray(feed.charts) && feed.charts.length > 0) {
                        sections.push({
                            id: 'charts',
                            title: i18n.key('explore.charts'),
                            items: feed.charts.map((collection) => ({ kind: 'collection', collection })),
                        });
                    }
                    return { sections, refreshReadsAnew: true };
                },
            },
        },
    });

    const commands = [
        folium.registries.commands.register({
            id: 'import-playlist',
            label: { 'zh-CN': 'GD 音乐台：导入歌单（ID / 链接）', en: 'GD Music Studio: Import playlist (ID / URL)' },
            description: {
                'zh-CN': '输入网易云歌单 ID 或链接（如 3778678），通过 GD 音乐台接口拉取并保存到发现页。',
                en: 'Import a playlist by NetEase playlist ID or URL via GD Music Studio API.',
            },
            keywords: ['gdstudio', 'gd', 'playlist', '歌单', '导入'],
            params: [
                {
                    key: 'playlist',
                    type: 'text',
                    label: { 'zh-CN': '歌单 ID 或链接', en: 'Playlist ID or URL' },
                    placeholder: 'https://music.163.com/#/playlist?id=3778678',
                    defaultValue: '',
                },
            ],
            async run({ values }) {
                const res = await callRpc('importPlaylistById', String(values.playlist || ''), readConfig());
                return { message: i18n.text('import.playlistDone', { name: res.name, count: res.count }) };
            },
        }),
        folium.registries.commands.register({
            id: 'import-user',
            label: { 'zh-CN': 'GD 音乐台：导入用户歌单（网易云 UID）', en: 'GD Music Studio: Import user playlists (UID)' },
            description: {
                'zh-CN': '与 GD 音乐台网页端一致：输入网易云用户 UID，同步该用户所有公开歌单（需先在网易云设为所有人可见）。',
                en: 'Import all public playlists of a NetEase user UID via GD Music Studio API.',
            },
            keywords: ['gdstudio', 'gd', 'uid', 'user', '歌单', '导入', '网易云'],
            params: [
                {
                    key: 'uid',
                    type: 'text',
                    label: { 'zh-CN': '网易云用户 UID 或主页链接', en: 'NetEase UID or profile URL' },
                    placeholder: '32953014',
                    defaultValue: readConfig().neteaseUid,
                },
            ],
            async run({ values }) {
                const res = await callRpc('importUserPlaylists', String(values.uid || ''), readConfig());
                section.settings.set({ neteaseUid: res.uid });
                return { message: i18n.text('import.userDone', { uid: res.uid, count: res.count }) };
            },
        }),
        folium.registries.commands.register({
            id: 'import-json',
            label: { 'zh-CN': 'GD 音乐台：从 JSON 文件导入本地歌单…', en: 'GD Music Studio: Import local playlist from JSON…' },
            description: {
                'zh-CN': '选择从 GD 音乐台网页端导出的歌单 / localStorage 备份 JSON 文件，导入并保存在发现页播放。',
                en: 'Pick a JSON playlist or localStorage backup exported from GD Music Studio web.',
            },
            keywords: ['gdstudio', 'gd', 'json', 'file', '歌单', '导入', '本地'],
            async run() {
                const res = await callRpc('importJsonFile', readConfig());
                if (res.cancelled) return { message: i18n.text('import.cancelled') };
                if (!res.playlists) return { message: i18n.text('import.jsonEmpty') };
                return { message: i18n.text('import.jsonDone', { playlists: res.playlists, tracks: res.tracks }) };
            },
        }),
        folium.registries.commands.register({
            id: 'clear-imported',
            label: { 'zh-CN': 'GD 音乐台：清空已导入的歌单', en: 'GD Music Studio: Clear imported playlists' },
            keywords: ['gdstudio', 'gd', 'playlist', '歌单', '清空'],
            async run() {
                const res = await callRpc('clearImportedPlaylists');
                return { message: i18n.text('import.cleared', { count: res.count }) };
            },
        }),
        folium.registries.commands.register({
            id: 'switch-upstream',
            label: { 'zh-CN': 'GD 音乐台：切换搜索上游平台', en: 'GD Music Studio: Switch search upstream' },
            description: {
                'zh-CN': '快速切换 GD 音乐台搜索使用的上游音源（如网易云、JOOX、Bilibili）。',
                en: 'Quickly switch the upstream platform used by GD Music Studio search.',
            },
            keywords: ['gdstudio', 'gd', 'music', '音乐台', '音源', '切换'],
            params: [
                {
                    key: 'upstream',
                    type: 'select',
                    label: { 'zh-CN': '上游平台', en: 'Upstream' },
                    defaultValue: readConfig().upstream,
                    options: UPSTREAM_OPTIONS,
                },
            ],
            async run({ values }) {
                const next = typeof values.upstream === 'string' && values.upstream ? values.upstream : 'netease';
                section.settings.set({ upstream: next, customUpstream: '' });
                syncConfigToMain();
                return { message: i18n.text('switch.done', { upstream: next }) };
            },
        }),
    ];

    const stopWatchingSettings = section.settings.onChange(() => {
        syncConfigToMain();
    });

    syncConfigToMain();

    return () => {
        stopWatchingSettings();
        commands.forEach((cmd) => cmd.unregister());
        section.unregister();
        sourceHandle.unregister();
    };
}

const AVAILABLE = Object.freeze({ configured: true });
