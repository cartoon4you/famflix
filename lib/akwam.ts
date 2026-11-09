import * as cheerio from 'cheerio';
import https from 'node:https';

const BASE_URL = 'https://akwam.ss';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Referer': 'https://akwam.ss/',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
  'Accept-Language': 'ar,en-US;q=0.9,en;q=0.8'
};

// Fast In-Memory Cache with TTL
interface CacheEntry<T> {
  data: T;
  expiry: number;
}
const pageCache = new Map<string, CacheEntry<string>>();
// Direct video tokens on downet.net expire quickly (~5-10 mins), keep linksCache TTL short (2 mins)
const linksCache = new Map<string, CacheEntry<VideoLink[]>>();

function getFromCache<T>(cache: Map<string, CacheEntry<T>>, key: string): T | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiry) {
    cache.delete(key);
    return null;
  }
  return entry.data;
}

function setInCache<T>(cache: Map<string, CacheEntry<T>>, key: string, data: T, ttlMs: number) {
  // Prevent unbounded memory growth
  if (cache.size > 200) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey) cache.delete(oldestKey);
  }
  cache.set(key, { data, expiry: Date.now() + ttlMs });
}

export interface MediaItem {
  title: string;
  url: string;
  image: string;
  rating?: string;
  quality?: string;
}

export interface VideoLink {
  quality: string;
  url: string;
}

/**
 * Normalizes URL to use the active Akwam domain and properly encodes non-ASCII (Arabic) characters
 */
function normalizeUrl(url: string): string {
  let cleanUrl = url.trim();
  if (cleanUrl.startsWith('/')) {
    cleanUrl = `${BASE_URL}${cleanUrl}`;
  } else if (cleanUrl.startsWith('http://ak.sv') || cleanUrl.startsWith('https://ak.sv')) {
    cleanUrl = cleanUrl.replace(/^https?:\/\/ak\.sv/i, BASE_URL);
  } else if (cleanUrl.startsWith('http://akwam.to') || cleanUrl.startsWith('https://akwam.to')) {
    cleanUrl = cleanUrl.replace(/^https?:\/\/akwam\.to/i, BASE_URL);
  }

  try {
    // Decode first to prevent double-encoding, then safely encode
    return encodeURI(decodeURI(cleanUrl));
  } catch {
    return encodeURI(cleanUrl);
  }
}

/**
 * Low-level HTTP GET using Node.js native https module.
 * This bypasses fetch/undici issues on Vercel Serverless:
 *  - accept TLS certificates with incomplete CA chains
 *  - avoid undici.Agent dispatcher incompatibilities
 */
function fetchPageRaw(url: string, timeoutMs = 12000): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };

    const req = https.get(
      url,
      {
        headers: HEADERS,
        rejectUnauthorized: false, // تجاهل التحقق من شهادة TLS غير المكتملة
        timeout: timeoutMs,
      },
      (res) => {
        // Follow simple redirects (3xx)
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          const nextUrl = new URL(res.headers.location, url).toString();
          fetchPageRaw(nextUrl, timeoutMs).then(
            (html) => finish(() => resolve(html)),
            (err) => finish(() => reject(err))
          );
          return;
        }

        if (res.statusCode && res.statusCode >= 400) {
          res.resume();
          finish(() => reject(new Error(`HTTP Error ${res.statusCode}: ${res.statusMessage || ''}`)));
          return;
        }

        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          finish(() => resolve(data));
        });
        res.on('error', (err) => {
          finish(() => reject(err));
        });
      }
    );

    req.on('timeout', () => {
      req.destroy(new Error('timeout'));
    });
    req.on('error', (err) => {
      finish(() => reject(err));
    });
  });
}

async function fetchPage(url: string, timeoutMs = 12000): Promise<string> {
  const targetUrl = normalizeUrl(url);

  // Check cache (5 min TTL)
  const cached = getFromCache(pageCache, targetUrl);
  if (cached) return cached;

  try {
    const text = await fetchPageRaw(targetUrl, timeoutMs);

    // تشخيص مؤقت — يظهر في Vercel Logs
    console.log('[AKWAM-DEBUG]', {
      url: targetUrl,
      length: text.length,
      hasEntryTitle: text.includes('entry-title'),
      hasJustAMoment:
        text.includes('Just a moment') || text.includes('challenge-platform'),
    });

    setInCache(pageCache, targetUrl, text, 5 * 60 * 1000);
    return text;
  } catch (error: any) {
    console.error(`[AKWAM-FETCH-ERROR] ${targetUrl}`, {
      message: error?.message,
      code: error?.code,
      cause: (error as any)?.cause?.code,
    });
    throw new Error(`فشل في جلب الصفحة من المصدر: ${error?.message || 'تعذر الاتصال'}`);
  }
}

function extractItemsFromHtml(html: string): MediaItem[] {
  const $ = cheerio.load(html);
  const items: MediaItem[] = [];
  const seenUrls = new Set<string>();

  // Select all possible card containers in Akwam layouts
  $('div.col-lg-auto, div.entry-box, div.col-6, div.widget-body .row > div, div.col-md-4, div.col-sm-6').each((_, el) => {
    const $el = $(el);

    // Find title and link
    const $link = $el.find('h3.entry-title a, .entry-title a, a.entry-title, a[href*="/movie/"], a[href*="/series/"], a[href*="/show/"]').first();
    const title = $link.text().trim() || $el.find('h3.entry-title, .entry-title').text().trim();
    let url = $link.attr('href') || $el.find('a').attr('href') || '';

    if (!url || !title || url.startsWith('#') || url.startsWith('javascript')) return;

    // Normalize URL
    if (url.startsWith('/')) {
      url = `${BASE_URL}${url}`;
    }

    if (seenUrls.has(url)) return;

    // Image
    const $img = $el.find('img').first();
    const image = $img.attr('data-src') || $img.attr('src') || '';

    // Rating & Quality
    const rating = $el.find('.rating, [class*="rating"]').first().text().replace(/[^0-9.]/g, '').trim();
    const quality = $el.find('.quality, [class*="quality"], .badge').first().text().replace(/\s+/g, ' ').trim();

    seenUrls.add(url);
    items.push({
      title,
      url,
      image,
      rating: rating || undefined,
      quality: quality || undefined
    });
  });

  return items;
}

export async function getMovies(page: number = 1): Promise<MediaItem[]> {
  const html = await fetchPage(`${BASE_URL}/movies?page=${page}`);
  return extractItemsFromHtml(html);
}

export async function getSeries(page: number = 1): Promise<MediaItem[]> {
  const html = await fetchPage(`${BASE_URL}/series?page=${page}`);
  return extractItemsFromHtml(html);
}

export async function search(keyword: string): Promise<MediaItem[]> {
  const html = await fetchPage(`${BASE_URL}/search?q=${encodeURIComponent(keyword)}`);
  return extractItemsFromHtml(html);
}

export async function getSeriesEpisodes(seriesUrl: string): Promise<MediaItem[]> {
  const html = await fetchPage(seriesUrl);
  const $ = cheerio.load(html);
  const episodes: MediaItem[] = [];
  const seenUrls = new Set<string>();

  $('a[href*="/episode/"]').each((_, el) => {
    let url = $(el).attr('href') || '';
    if (!url) return;

    if (url.startsWith('/')) {
      url = `${BASE_URL}${url}`;
    }

    if (seenUrls.has(url)) return;

    let title = $(el).text().replace(/\s+/g, ' ').trim();
    if (!title) {
      title = $(el).parent().text().replace(/\s+/g, ' ').trim();
    }

    if (title && url) {
      seenUrls.add(url);
      episodes.push({
        title,
        url,
        image: ''
      });
    }
  });

  return episodes;
}

function isVideoUrl(url: string): boolean {
  if (!url || typeof url !== 'string') return false;
  const lower = url.toLowerCase();
  // Filter out image assets and non-video resources
  if (
    lower.includes('img.downet.net') ||
    lower.endsWith('.jpg') ||
    lower.endsWith('.jpeg') ||
    lower.endsWith('.png') ||
    lower.endsWith('.webp') ||
    lower.endsWith('.gif') ||
    lower.endsWith('.svg') ||
    lower.endsWith('.ico')
  ) {
    return false;
  }
  return (
    lower.includes('.mp4') ||
    lower.includes('.mkv') ||
    lower.includes('.webm') ||
    lower.includes('.m3u8') ||
    lower.includes('downet.net/download/')
  );
}

function parseQualityRank(q: string): number {
  const match = q.match(/(\d+)/);
  if (match) return parseInt(match[1], 10);
  if (q.toLowerCase().includes('4k') || q.toLowerCase().includes('2160')) return 2160;
  if (q.toLowerCase().includes('1080')) return 1080;
  if (q.toLowerCase().includes('720')) return 720;
  if (q.toLowerCase().includes('480')) return 480;
  if (q.toLowerCase().includes('360')) return 360;
  return 0;
}

function cleanQualityLabel(qualityLabel: string, fallbackUrl: string): string {
  let formatted = qualityLabel.replace(/\s+/g, ' ').trim();

  // Extract number if present
  const numMatch = formatted.match(/(1080|720|480|360|2160|4k)/i);
  if (numMatch) {
    const val = numMatch[1].toLowerCase();
    return val === '4k' ? '4K' : `${val}p`;
  }

  // Check in URL
  const urlMatch = fallbackUrl.match(/(1080|720|480|360|2160)/i);
  if (urlMatch) {
    return `${urlMatch[1]}p`;
  }

  if (formatted.includes('تحميل') || formatted.includes('مشاهدة') || !formatted) {
    return 'HD';
  }

  return formatted;
}

export async function getCleanLink(pageUrl: string): Promise<VideoLink[]> {
  const targetUrl = normalizeUrl(pageUrl);

  // Check cache (15 min TTL)
  const cached = getFromCache(linksCache, targetUrl);
  if (cached && cached.length > 0) {
    return cached;
  }

  try {
    const html = await fetchPage(targetUrl, 12000);
    const $ = cheerio.load(html);

    const directUrls: VideoLink[] = [];
    const seenLinks = new Set<string>();

    const addLink = (rawUrl: string, qualityLabel: string) => {
      if (!rawUrl || !isVideoUrl(rawUrl)) return;

      let clean = rawUrl
        .replace(/^(https:\/\/ak\.svvlc:\/\/|https:\/\/akwam\.ssvlc:\/\/|intent:\/\/|intent:|vlc:\/\/)/i, '')
        .trim();

      if (clean.includes('#Intent;')) {
        clean = clean.split('#Intent;')[0];
      }

      if (clean && clean.startsWith('http') && !seenLinks.has(clean)) {
        seenLinks.add(clean);
        const formattedQuality = cleanQualityLabel(qualityLabel, clean);

        directUrls.push({
          quality: formattedQuality,
          url: clean
        });
      }
    };

    // 1. Direct <video><source src="..."> elements
    $('video source, source').each((_, el) => {
      const src = $(el).attr('src');
      const size = $(el).attr('size') || $(el).attr('data-quality') || $(el).attr('title') || '';
      if (src) {
        addLink(src, size ? `${size}p` : 'HD');
      }
    });

    // 2. Direct video links on the current page
    $('a').each((_, el) => {
      const href = $(el).attr('href') || '';
      const text = $(el).text().replace(/\s+/g, ' ').trim();
      if (isVideoUrl(href)) {
        addLink(href, text || 'Direct');
      }
    });

    // 3. If no direct video streams found on this page (e.g. it is a /movie/ or /episode/ page),
    // probe the sub /watch/ and /download/ links in parallel
    if (directUrls.length === 0) {
      const seenProbeUrls = new Set<string>();

      // Collect watch sub-pages first, or download sub-pages if no watch URLs found
      const watchTargets: { url: string; label: string }[] = [];
      const downloadTargets: { url: string; label: string }[] = [];

      $('a[href*="/watch/"]').each((_, el) => {
        let href = $(el).attr('href') || '';
        if (!href) return;
        if (href.startsWith('/')) {
          href = `${BASE_URL}${href}`;
        }
        if (seenProbeUrls.has(href)) return;
        seenProbeUrls.add(href);

        const text = $(el).text().replace(/\s+/g, ' ').trim();
        const parentCard = $(el).closest('.download-item, .col-lg-auto, tr, li, div');
        const qualityText = parentCard.find('.badge, .quality, span.badge, [class*="quality"]').text().replace(/\s+/g, ' ').trim();

        watchTargets.push({
          url: href,
          label: qualityText || text || 'HD'
        });
      });

      $('a[href*="/download/"]').each((_, el) => {
        let href = $(el).attr('href') || '';
        if (!href) return;
        if (href.startsWith('/')) {
          href = `${BASE_URL}${href}`;
        }
        if (seenProbeUrls.has(href)) return;
        seenProbeUrls.add(href);

        const text = $(el).text().replace(/\s+/g, ' ').trim();
        const parentCard = $(el).closest('.download-item, .col-lg-auto, tr, li, div');
        const qualityText = parentCard.find('.badge, .quality, span.badge, [class*="quality"]').text().replace(/\s+/g, ' ').trim();

        downloadTargets.push({
          url: href,
          label: qualityText || text || 'HD'
        });
      });

      // Combine both watch and download sub-pages (up to 4 max to avoid rate-limiting)
      const probeTargets = [...watchTargets, ...downloadTargets].slice(0, 6);

      if (probeTargets.length > 0) {
        // Fetch sub-pages in parallel with generous 12s timeout
        const settledResults = await Promise.allSettled(
          probeTargets.map((t) => fetchPage(t.url, 12000))
        );

        settledResults.forEach((res, index) => {
          if (res.status === 'fulfilled') {
            const $sub = cheerio.load(res.value);
            const targetMeta = probeTargets[index];

            // Direct video sources
            $sub('video source, source').each((_, el) => {
              const src = $sub(el).attr('src');
              const size = $sub(el).attr('size') || $sub(el).attr('data-quality') || targetMeta.label;
              if (src && isVideoUrl(src)) {
                addLink(src, size);
              }
            });

            // Video download links
            $sub('a').each((_, el) => {
              const href = $sub(el).attr('href') || '';
              const text = $sub(el).text().replace(/\s+/g, ' ').trim();
              if (isVideoUrl(href)) {
                addLink(href, targetMeta.label || text);
              }
            });
          } else {
            console.warn(`Sub-page fetch failed for ${probeTargets[index].url}:`, res.reason?.message);
          }
        });
      }
    }

    // Sort links by quality descending (1080p, 720p, 480p, 360p)
    directUrls.sort((a, b) => parseQualityRank(b.quality) - parseQualityRank(a.quality));

    // Deduplicate and label mirrors cleanly
    const finalLinks: VideoLink[] = [];
    const qualityCount = new Map<string, number>();

    for (const link of directUrls) {
      const baseQ = link.quality;
      const count = (qualityCount.get(baseQ) || 0) + 1;
      qualityCount.set(baseQ, count);

      if (count === 1) {
        finalLinks.push(link);
      } else if (count === 2) {
        finalLinks.push({
          quality: `${baseQ} (سيرفر ${count})`,
          url: link.url
        });
      }
    }

    if (finalLinks.length > 0) {
      setInCache(linksCache, targetUrl, finalLinks, 2 * 60 * 1000);
      return finalLinks;
    }

    throw new Error('لم يتم العثور على روابط تشغيل مباشرة لهذا المحتوى حالياً');
  } catch (error: any) {
    console.error(`Error getting links for ${pageUrl}:`, error?.message || error);
    throw new Error(error?.message || 'فشل في استخراج الروابط من الصفحة');
  }
}
