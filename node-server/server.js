const express = require('express');
const path = require('path');
const http = require('http');
const https = require('https');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

// ---------- 采集源配置（可在 config.json 中增删，格式：key -> { name, api, format: json|rss, cats: [分类id->名称] }）----------
const DEFAULT_SOURCES = {
  liangzi: {
    name: '量子资源',
    api: 'http://cj.lziapi.com/api.php/provide/vod/',
    format: 'json',
    cats: [
      { id: '1', name: '电影' }, { id: '2', name: '电视剧' },
      { id: '3', name: '综艺' }, { id: '4', name: '动漫' },
    ],
  },
  hongniu: {
    name: '红牛资源',
    api: 'https://www.hongniuzy2.com/api.php/provide/vod/',
    format: 'json',
    cats: [
      { id: '1', name: '电影' }, { id: '2', name: '电视剧' },
      { id: '3', name: '综艺' }, { id: '4', name: '动漫' },
    ],
  },
  feifan: {
    name: '非凡资源',
    api: 'https://cj.ffzyapi.com/api.php/provide/vod/',
    format: 'json',
    cats: [
      { id: '1', name: '电影' }, { id: '2', name: '电视剧' },
      { id: '3', name: '综艺' }, { id: '4', name: '动漫' },
    ],
  },
  tiankong: {
    name: '天空资源',
    api: 'https://api.1080zyku.com/api.php/provide/vod/',
    format: 'rss',
    cats: [],
  },
};

// ---------- 配置解析 ----------
// config.json 顶层：源 key -> {name,api,format,cats}；可选控制键：
//   remoteConfigUrl : 外部接口配置(json)链接，服务启动/每60秒拉取，拉取成功即覆盖本地源（失败沿用本地）
//   _pro            : { 源key -> {...} }，用于高级模式(/aaa 或 mode=pro)的采集源
function isSource(v) {
  return !!v && typeof v === 'object' && typeof v.api === 'string';
}

function parseConfig(raw) {
  const out = { remoteConfigUrl: '', sources: {}, sourcesPro: {} };
  if (!raw || typeof raw !== 'object') return out;
  for (const k of Object.keys(raw)) {
    const v = raw[k];
    if (k === 'remoteConfigUrl') {
      if (typeof v === 'string') out.remoteConfigUrl = v.trim();
    } else if (k === '_pro' && v && typeof v === 'object') {
      for (const pk of Object.keys(v)) if (isSource(v[pk])) out.sourcesPro[pk] = v[pk];
    } else if (isSource(v)) {
      out.sources[k] = v;
    }
  }
  return out;
}

function readLocalConfig() {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
  } catch (e) {
    return {};
  }
}

const _cfg = parseConfig(readLocalConfig());
let SOURCES = Object.assign({}, DEFAULT_SOURCES, _cfg.sources);
const REMOTE_CONFIG_URL = _cfg.remoteConfigUrl;

// 移动网络下运营商可能对采集站/媒体域名做 TLS 阻断，且部分域名后缀会被整体限制：
// 直连失败时自动回退到 CF 中转，中转按以下域名顺序尝试：
// 首选 CF 绑定自定义域名 fftv.de5.net；vod-box-dup.pages.dev 为项目 pages.dev 域名，作兜底
const RELAY_BASES = [
  'https://fftv.de5.net/api/relay',
  'https://tvgg.de5.net/api/relay',
  'https://tvdd.us.ci/api/relay',
  'https://vod-box-dup.pages.dev/api/relay',
];
const RELAY_TOKEN = 'vb-relay-7c41f0a9';
const RELAY_TIMEOUT = 6000;
let _relayPreferred = 0;

function isPublicHttpUrl(u) {
  if (!/^https?:\/\//i.test(u)) return false;
  return !/^https?:\/\/(localhost|127\.|0\.0\.0\.0|\[::1\]|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/i.test(u);
}

function isRelayUrl(u) {
  return RELAY_BASES.some((b) => u.startsWith(b));
}

// 首次成功的域名会被记住并优先使用，避免每次都先在不可用域名上等待
function orderedRelayBases() {
  if (!_relayPreferred) return RELAY_BASES;
  return RELAY_BASES.slice(_relayPreferred).concat(RELAY_BASES.slice(0, _relayPreferred));
}

function relayUrlsFor(target, referer) {
  return orderedRelayBases().map((base) => ({
    base,
    url: base + (base.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(RELAY_TOKEN)
      + '&u=' + encodeURIComponent(target)
      + (referer ? '&ref=' + encodeURIComponent(referer) : ''),
  }));
}

function markRelayOk(u) {
  const i = RELAY_BASES.findIndex((b) => u.startsWith(b));
  if (i > 0) _relayPreferred = i;
}

// 远程配置刷新（依赖下方 fetchText，调用时机晚于其定义即可）
let _remoteFetchedAt = 0;
let _remoteReady = false;
let _remoteInflight = null;
const REMOTE_REFRESH_MS = 60 * 1000;

async function refreshFromRemote(force) {
  if (!REMOTE_CONFIG_URL) return _remoteReady;
  const now = Date.now();
  // 非强制：远程已就绪且 60 秒内刚拉过则直接返回，避免每个请求都访问远程
  if (!force && _remoteReady && now - _remoteFetchedAt < REMOTE_REFRESH_MS) return true;
  // 有进行中的拉取则复用之，防止并发
  if (_remoteInflight) return _remoteInflight;
  _remoteInflight = (async () => {
    try {
      const txt = await fetchText(REMOTE_CONFIG_URL, { timeout: 8000 });
      const rem = parseConfig(JSON.parse(txt));
      // 远程配置为权威：远程提供的源集合整体替换本地；某集合为空时保留本地兜底
      if (Object.keys(rem.sources).length) SOURCES = rem.sources;
      if (Object.keys(rem.sourcesPro).length) SOURCES_PRO = rem.sourcesPro;
      _remoteFetchedAt = Date.now();
      _remoteReady = true;
      console.log(`[config] 远程接口配置已生效(${Object.keys(rem.sources).length} 个源): ${REMOTE_CONFIG_URL}`);
      return true;
    } catch (e) {
      console.error(`[config] 远程配置拉取失败，沿用本地: ${e.message}`);
      _remoteFetchedAt = Date.now();
      return false;
    }
  })();
  try {
    return await _remoteInflight;
  } finally {
    _remoteInflight = null;
  }
}

function startRemoteConfigRefresh() {
  if (!REMOTE_CONFIG_URL) return;
  refreshFromRemote(true);
  setInterval(() => refreshFromRemote(true), REMOTE_REFRESH_MS);
}

// ---------- 高级模式采集源（/aaa 路径，如意接口）----------
const DEFAULT_SOURCES_PRO = {
  ruyi: {
    name: '如意资源',
    api: 'https://cj.rycjapi.com/api.php/provide/vod/',
    format: 'json',
    cats: [
      { id: '1', name: '电影' }, { id: '2', name: '电视剧' },
      { id: '3', name: '综艺' }, { id: '4', name: '动漫' },
    ],
  },
  liangzi: {
    name: '量子资源',
    api: 'http://cj.lziapi.com/api.php/provide/vod/',
    format: 'json',
    cats: [
      { id: '1', name: '电影' }, { id: '2', name: '电视剧' },
      { id: '3', name: '综艺' }, { id: '4', name: '动漫' },
    ],
  },
};
let SOURCES_PRO = Object.assign({}, DEFAULT_SOURCES_PRO, _cfg.sourcesPro);

// ---------- 基础工具 ----------
const agent = new https.Agent({ keepAlive: true, maxSockets: 64 });

function fetchBufDirect(url, { referer, timeout = 15000, headers = {} } = {}) {
  const u = new URL(url);
  const mod = u.protocol === 'https:' ? https : http;
  const opts = {
    headers: {
      'User-Agent': UA,
      'Accept': '*/*',
      ...(referer ? { Referer: referer } : {}),
      ...headers,
    },
    method: 'GET',
    agent: u.protocol === 'https:' ? agent : undefined,
  };
  return new Promise((resolve, reject) => {
    const req = mod.request(u, opts, (res) => {
      const code = res.statusCode || 0;
      if (code >= 300 && code < 400 && res.headers.location) {
        const next = new URL(res.headers.location, u).toString();
        res.resume();
        return fetchBufDirect(next, { referer, timeout, headers }).then(resolve, reject);
      }
      if (code >= 400) {
        res.resume();
        return reject(new Error(`HTTP ${code} for ${url}`));
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.setTimeout(timeout, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });
}

// 直连失败（运营商 TLS 阻断 / 超时 / 错误状态）时，自动经 CF 中转重试（多域名按序）
async function fetchBuf(url, opts = {}) {
  try {
    return await fetchBufDirect(url, opts);
  } catch (e) {
    if (!isPublicHttpUrl(url) || isRelayUrl(url)) throw e;
    for (const r of relayUrlsFor(url, opts.referer)) {
      try {
        const buf = await fetchBufDirect(r.url, { timeout: RELAY_TIMEOUT });
        markRelayOk(r.url);
        return buf;
      } catch (e2) { /* 试下一个 */ }
    }
    throw e;
  }
}

const fetchText = async (url, o = {}) => (await fetchBuf(url, o)).toString('utf8');
const fetchTextDirect = async (url, o = {}) => (await fetchBufDirect(url, o)).toString('utf8');

// 判断采集站返回内容是否可用（移动网络下运营商可能返回 200 的拦截页，导致解析不出数据）
function looksBrokenBody(text, s) {
  const t = (text || '').trim();
  if (!t) return true;
  if (s && s.format === 'rss') return !/<(rss|list|video|channel)\b/i.test(t);
  try { return !JSON.parse(t); } catch (e) { return true; }
}

// 采集接口取数：直连失败或返回内容不可用时，强制经 CF 中转重取一次
async function fetchTextChecked(url, s) {
  const referer = originOf(s && s.api ? s.api : url);
  let text = '';
  try { text = await fetchText(url, { referer, timeout: 8000 }); } catch (e) { text = ''; }
  if (!looksBrokenBody(text, s)) return text;
  if (isPublicHttpUrl(url) && !isRelayUrl(url)) {
    for (const r of relayUrlsFor(url, referer)) {
      try {
        const t = await fetchTextDirect(r.url, { timeout: RELAY_TIMEOUT });
        if (!looksBrokenBody(t, s)) { markRelayOk(r.url); return t; }
      } catch (e) { /* 试下一个 */ }
    }
  }
  return text;
}

function originOf(u) {
  try { return new URL(u).origin; } catch (e) { return ''; }
}

function absUrl(base, rel) {
  try { return new URL(rel, base).toString(); } catch (e) { return rel; }
}

// ---------- 数据转换 ----------
function decodeEntities(s) {
  if (!s) return '';
  return s.replace(/<!\[CDATA\[(.*?)\]\]>/gs, '$1')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

function parseXmlList(xml) {
  // 从 RSS/XML 中提取 video 节点文本（宽松解析，兼容 CDATA 与实体）
  const items = [];
  const re = /<video>([\s\S]*?)<\/video>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const raw = m[1];
    const field = (tag) => {
      const fm = raw.match(new RegExp(`<${tag}>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/${tag}>`));
      return fm ? decodeEntities(fm[1].trim()) : '';
    };
    const dd = [];
    const dlRe = /<dd\s+flag="([^"]*)"(?:[^>]*)>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/dd>/g;
    let dm;
    while ((dm = dlRe.exec(raw)) !== null) dd.push({ flag: dm[1], url: decodeEntities(dm[2].trim()) });
    items.push({
      vod_id: field('id'),
      vod_name: field('name'),
      type_id: field('tid'),
      type_name: field('type'),
      vod_pic: field('pic'),
      vod_remarks: field('note'),
      vod_year: field('year'),
      vod_area: field('area'),
      vod_lang: field('lang'),
      vod_actor: field('actor'),
      vod_director: field('director'),
      vod_content: field('des'),
      vod_play_from: dd.map((d) => d.flag).join(','),
      vod_play_url: dd.map((d) => d.url).join('$$$'),
    });
  }
  return items;
}

function normalizeItem(v) {
  return {
    vod_id: String(v.vod_id || ''),
    vod_name: v.vod_name || '',
    vod_pic: v.vod_pic || '',
    vod_remarks: v.vod_remarks || '',
    type_id: String(v.type_id || ''),
    type_name: v.type_name || '',
    vod_year: v.vod_year || '',
    vod_area: v.vod_area || '',
    vod_lang: v.vod_lang || '',
    vod_director: v.vod_director || '',
    vod_actor: v.vod_actor || '',
    vod_score: v.vod_score || '',
    vod_content: (v.vod_content || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
    vod_play_from: v.vod_play_from || '',
    vod_play_url: v.vod_play_url || '',
  };
}

async function fetchVod(src, params, sources = SOURCES) {
  const s = sources[src];
  if (!s) throw new Error('未知采集源');
  const q = new URLSearchParams(params);
  const url = s.api + (s.api.includes('?') ? '&' : '?') + q.toString();
  const text = await fetchTextChecked(url, s);
  let items = [];
  let page = 1, pagecount = 1, limit = 20, total = 0;
  if (s.format === 'rss') {
    items = parseXmlList(text);
    const lm = text.match(/<list\s+([^>]*)>/);
    if (lm) {
      const a = Object.fromEntries([...(lm[1].match(/(\w+)="([^"]*)"/g) || [])].map((x) => {
        const mm = x.match(/(\w+)="([^"]*)"/); return [mm[1], mm[2]];
      }));
      page = +a.page || 1; pagecount = +a.pagecount || 1;
      limit = +a.pagesize || 20; total = +a.recordcount || 0;
    }
  } else {
    let data;
    try { data = JSON.parse(text); } catch (e) { throw new Error('采集站返回非 JSON'); }
    if (data.code !== 1 && data.code !== 200) throw new Error(data.msg || '采集站返回错误');
    items = (data.list || []).map(normalizeItem);
    page = +data.page || 1;
    pagecount = +data.pagecount || 1;
    limit = +data.limit || 20;
    total = +data.total || 0;
  }
  return { page, pagecount, limit, total, list: items.map(normalizeItem) };
}

// ---------- 播放地址解析 ----------
const DIRECT_MEDIA = /\.(m3u8|mp4|m4v|mkv|flv|webm|mov|avi|m3u8\?|mp4\?)(?:$|[?#])/i;
const resolveCache = new Map();

function isDirectMedia(u) {
  return DIRECT_MEDIA.test(u) || u.includes('.m3u8') || /\.m3u8\?/i.test(u);
}

async function resolvePlayUrl(rawUrl, refererHost) {
  if (resolveCache.has(rawUrl)) return resolveCache.get(rawUrl);
  const referer = refererHost || originOf(rawUrl);
  let resolved = null;
  if (isDirectMedia(rawUrl)) {
    resolved = { type: /\.m3u8/i.test(rawUrl) ? 'hls' : 'mp4', url: rawUrl };
  } else {
    // 解析页/接口：抓取并提取真实 m3u8 / mp4 地址
    let body = '';
    try {
      body = await fetchText(rawUrl, { referer, timeout: 15000 });
    } catch (e) { /* 忽略 */ }
    // JSON 解析口 {"url":"..."} 
    const jsonM = body.match(/"url"\s*:\s*"([^"]+\.(?:m3u8|mp4)[^"]*)"/i);
    if (jsonM) {
      resolved = { type: jsonM[1].includes('.m3u8') ? 'hls' : 'mp4', url: jsonM[1] };
    }
    if (!resolved) {
      const m3u8M = body.match(/https?:\/\/[^'"\s<>]+\.m3u8[^'"\s<>]*/i);
      if (m3u8M) resolved = { type: 'hls', url: m3u8M[0].trim() };
    }
    if (!resolved) {
      const relM = body.match(/(?:var|const|let)\s+\w+\s*=\s*['"]([^'"]+\.(?:m3u8|mp4)[^'"]*)/i);
      if (relM) {
        const u = relM[1].trim();
        resolved = { type: u.includes('.m3u8') ? 'hls' : 'mp4', url: /^https?:\/\//i.test(u) ? u : absUrl(rawUrl, u) };
      }
    }
    if (!resolved) {
      const mp4M = body.match(/https?:\/\/[^'"\s<>]+\.mp4[^'"\s<>]*/i);
      if (mp4M) resolved = { type: 'mp4', url: mp4M[0].trim() };
    }
    if (!resolved) {
      const jsonAlt = body.match(/"url"\s*:\s*"([^"]+)"/i);
      if (jsonAlt) resolved = { type: 'hls', url: jsonAlt[1] };
    }
    if (!resolved) {
      const anyM = body.match(/https?:\/\/[^'"\s<>]+\.m3u8[^'"\s<>]*/i) || body.match(/https?:\/\/[^'"\s<>]+\/hls\/[^'"\s<>]*/i);
      if (anyM) resolved = { type: 'hls', url: anyM[0].trim() };
    }
  }
  if (!resolved) {
    resolved = { type: 'hls', url: rawUrl }; // 兜底：直接把原地址当播放地址
  }
  if (resolved.url.startsWith('http')) {
    resolveCache.set(rawUrl, resolved);
    if (resolveCache.size > 800) resolveCache.delete(resolveCache.keys().next().value);
  }
  return resolved;
}

// ---------- 流媒体代理 ----------
// 直连失败时经 CF 中转重试（移动网络下媒体域名可能被运营商阻断）
function relayMedia(res, url, referer, extra) {
  const cands = relayUrlsFor(url, referer);
  const tryAt = (i) => {
    if (i >= cands.length) { try { res.status(502).send('relay stream error'); } catch (e) {} return; }
    const r = cands[i];
    const ru = new URL(r.url);
    const mod = ru.protocol === 'https:' ? https : http;
    const headers = { 'User-Agent': UA, 'Accept': '*/*' };
    if (extra && extra.Range) headers['Range'] = extra.Range;
    let settled = false;
    const req = mod.request(ru, { headers, method: 'GET', agent: ru.protocol === 'https:' ? agent : undefined }, (pRes) => {
      if ((pRes.statusCode || 0) >= 400) { settled = true; pRes.resume(); tryAt(i + 1); return; }
      settled = true;
      markRelayOk(r.url);
      res.statusCode = pRes.statusCode || 200;
      for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'cache-control']) {
        if (pRes.headers[h]) res.setHeader(h, pRes.headers[h]);
      }
      res.setHeader('Access-Control-Allow-Origin', '*');
      pRes.pipe(res);
      pRes.on('error', () => { try { res.destroy(); } catch (e) {} });
    });
    req.setTimeout(45000, () => req.destroy(new Error('timeout')));
    req.on('error', () => { if (!settled) { settled = true; tryAt(i + 1); } });
    req.end();
  };
  tryAt(0);
}

function proxyMedia(res, url, referer, extra) {
  const u = new URL(url);
  const mod = u.protocol === 'https:' ? https : http;
  const headers = {
    'User-Agent': UA,
    'Accept': '*/*',
    'Accept-Encoding': 'identity',
  };
  if (referer) headers['Referer'] = referer;
  if (extra && extra.Range) headers['Range'] = extra.Range;
  let settled = false;
  const fallback = () => {
    if (settled) return;
    settled = true;
    if (!isPublicHttpUrl(url)) { try { res.status(502).send('stream error'); } catch (e) {} return; }
    relayMedia(res, url, referer, extra);
  };
  const req = mod.request(u, { headers, method: 'GET', agent: u.protocol === 'https:' ? agent : undefined }, (pRes) => {
    if ((pRes.statusCode || 0) >= 400) { pRes.resume(); fallback(); return; }
    settled = true;
    res.statusCode = pRes.statusCode || 200;
    for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'cache-control']) {
      if (pRes.headers[h]) res.setHeader(h, pRes.headers[h]);
    }
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (pRes.statusCode === 304) { res.end(); return; }
    pRes.pipe(res);
    pRes.on('error', () => { try { res.destroy(); } catch (e) {} });
  });
  req.setTimeout(30000, () => req.destroy(new Error('timeout')));
  req.on('error', fallback);
  req.end();
}

async function proxyPlaylist(res, url, referer, depth = 0) {
  if (depth > 6) { res.status(502).send('playlist too deep'); return; }
  const text = await fetchText(url, { referer, timeout: 20000 });
  const proto = (u) => `/api/stream?u=${encodeURIComponent(u)}`;
  const out = text.split('\n').map((line) => {
    const t = line.trim();
    if (!t) return line;
    if (t.startsWith('#')) {
      if (/^#EXT-X-(KEY|MAP|MEDIA):/.test(t) && /URI=/.test(t)) {
        return t.replace(/URI="([^"]+)"/g, (mm, uu) => `URI="${proto(absUrl(url, uu))}"`);
      }
      return line;
    }
    return proto(absUrl(url, t));
  }).join('\n');
  res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.send(out);
}

// ---------- API 路由 ----------
const PRO_PWD = '666';
function proAuthed(q) { return q.mode !== 'pro' || q.pwd === PRO_PWD; }

// 网站打开时优先远程接口：配置了 remoteConfigUrl 时，首个 /api 请求会先等待远程拉取完成
// （成功即远程源优先展示，失败/超时则沿用本地 config.json，不阻塞后续访问）
app.use('/api', async (req, res, next) => {
  if (!REMOTE_CONFIG_URL) return next();
  try { await refreshFromRemote(false); } catch (e) {}
  next();
});

app.get('/api/procheck', (req, res) => {
  if (req.query.pwd === PRO_PWD) res.json({ ok: true });
  else res.status(403).json({ ok: false });
});

app.get('/api/sources', (req, res) => {
  if (!proAuthed(req.query)) { res.status(403).json({ error: 'forbidden' }); return; }
  const SRC = req.query.mode === 'pro' ? SOURCES_PRO : SOURCES;
  res.json(Object.entries(SRC).map(([key, v]) => ({ key, name: v.name, format: v.format, cats: v.cats || [] })));
});

app.get('/api/list', async (req, res) => {
  try {
    if (!proAuthed(req.query)) { res.status(403).json({ error: 'forbidden' }); return; }
    const SRC = req.query.mode === 'pro' ? SOURCES_PRO : SOURCES;
    let { src = 'liangzi', t = '', pg = 1, wd = '' } = req.query;
    if (!SRC[src]) src = Object.keys(SRC)[0] || 'liangzi';
    const data = await fetchVod(src, { ac: 'list', t, pg, wd, limit: 24 }, SRC);
    // 列表接口通常不返回图片，批量拉详情补全海报
    const need = data.list.filter((v) => !v.vod_pic).map((v) => v.vod_id);
    if (need.length) {
      try {
        const s = SRC[src];
        const params = s && s.format === 'rss'
          ? { ac: 'videolist', ids: need.join(','), pg: 1, limit: 50 }
          : { ac: 'detail', ids: need.join(',') };
        const rich = await fetchVod(src, params, SRC);
        const map = new Map(rich.list.map((v) => [String(v.vod_id), v]));
        data.list = data.list.map((v) => {
          const r = map.get(String(v.vod_id));
          if (!r) return v;
          return Object.assign({}, v, {
            vod_pic: r.vod_pic || v.vod_pic,
            vod_year: r.vod_year || v.vod_year,
            vod_area: r.vod_area || v.vod_area,
            vod_director: r.vod_director || v.vod_director,
            vod_actor: r.vod_actor || v.vod_actor,
          });
        });
      } catch (e) { /* 补图失败则保留占位图 */ }
    }
    res.json(data);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.get('/api/search', async (req, res) => {
  const { wd = '' } = req.query;
  if (!proAuthed(req.query)) { res.status(403).json({ error: 'forbidden' }); return; }
  if (!wd) { res.json({ list: [] }); return; }
  const SRC = req.query.mode === 'pro' ? SOURCES_PRO : SOURCES;
  const keys = Object.keys(SRC);
  const results = await Promise.allSettled(keys.map(async (key) => {
    try {
      const s = SRC[key];
      const data = await fetchVod(key, { ac: 'list', t: '', pg: 1, wd, limit: 12 }, SRC);
      let list = data.list;
      // 补全海报
      const need = list.filter((v) => !v.vod_pic).map((v) => v.vod_id);
      if (need.length) {
        try {
          const params = s.format === 'rss'
            ? { ac: 'videolist', ids: need.join(','), pg: 1, limit: 50 }
            : { ac: 'detail', ids: need.join(',') };
          const rich = await fetchVod(key, params, SRC);
          const map = new Map(rich.list.map((v) => [String(v.vod_id), v]));
          list = list.map((v) => {
            const r = map.get(String(v.vod_id));
            return r ? Object.assign({}, v, { vod_pic: r.vod_pic || v.vod_pic }) : v;
          });
        } catch (e) { /* 忽略 */ }
      }
      return list.map((v) => Object.assign(v, { src_key: key, src_name: s.name }));
    } catch (e) { return []; }
  }));
  const list = results.filter((r) => r.status === 'fulfilled').flatMap((r) => r.value);
  res.json({ list });
});

app.get('/api/detail', async (req, res) => {
  try {
    if (!proAuthed(req.query)) { res.status(403).json({ error: 'forbidden' }); return; }
    const { src = 'liangzi', ids } = req.query;
    if (!ids) { res.status(400).json({ error: 'missing ids' }); return; }
    const SRC = req.query.mode === 'pro' ? SOURCES_PRO : SOURCES;
    const src2 = SRC[src] ? src : (Object.keys(SRC)[0] || 'liangzi');
    const s = SRC[src2];
    const params = s && s.format === 'rss'
      ? { ac: 'videolist', ids, pg: 1, limit: 1 }
      : { ac: 'detail', ids };
    const data = await fetchVod(src2, params, SRC);
    res.json({ detail: data.list.find((x) => String(x.vod_id) === String(ids)) || data.list[0] || null });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.get('/api/resolve', async (req, res) => {
  try {
    const { u } = req.query;
    if (!u) { res.status(400).json({ error: 'missing url' }); return; }
    const r = await resolvePlayUrl(u);
    res.json(r);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.get('/api/stream', async (req, res) => {
  const u = req.query.u;
  if (!u || !/^https?:\/\//i.test(u)) { res.status(400).send('bad url'); return; }
  const referer = originOf(u);
  try {
    if (/\.m3u8($|\?)/i.test(u)) {
      await proxyPlaylist(res, u, referer);
    } else {
      proxyMedia(res, u, referer, { Range: req.headers.range });
    }
  } catch (e) {
    try { res.status(502).send('stream failed'); } catch (e2) {}
  }
});

app.get('/api/img', async (req, res) => {
  const u = req.query.u;
  if (!u || !/^https?:\/\//i.test(u)) { res.status(400).send('bad url'); return; }
  proxyMedia(res, u, originOf(u));
});

// ---------- 静态资源 ----------
// /hls.js/hls.min.js 已改为 public/hls.js/hls.min.js 静态文件提供(不再依赖 node_modules/hls.js)
app.use(express.static(path.join(__dirname, 'public')));

// SPA 回退：非 API/非静态文件路径返回首页（支持 /aaa 高级模式）
app.use((req, res, next) => {
  if (req.method === 'GET' && !req.path.startsWith('/api/') && !req.path.startsWith('/hls.js')) {
    res.sendFile(path.join(__dirname, 'public/index.html'));
    return;
  }
  next();
});

// 启动即拉取远程接口配置并每 60 秒刷新（配置了 remoteConfigUrl 才生效）
startRemoteConfigRefresh();

// nodejs-mobile (Android) 只允许本机访问，桌面版照常监听所有网卡
const HOST = process.platform === 'android' ? '127.0.0.1' : undefined;
app.listen(PORT, HOST, () => {
  console.log(`VOD Box running at http://${HOST || 'localhost'}:${PORT}`);
});
