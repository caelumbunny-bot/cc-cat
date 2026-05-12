#!/usr/bin/env node
// Sync Bunny's Twitter (@Bunnyloustin) to Memory Palace
// + Gemini Vision 图片识别
//
// 用法:
//   node sync-twitter.js                    普通增量同步
//   node sync-twitter.js --vision           同步 + 识图（新推文）
//   node sync-twitter.js --init             全量历史拉取
//   node sync-twitter.js --vision-backfill  对所有历史有图推文补跑识图

const { execSync } = require('child_process');
const fs   = require('fs');
const path = require('path');
const os   = require('os');
const Database = require('/root/memory/web/node_modules/better-sqlite3');

const db = new Database('/root/memory/palace.db');

const insert = db.prepare(
  'INSERT OR IGNORE INTO entries (ts, kind, author, content, tags, mood, source_hash) VALUES (?, ?, ?, ?, ?, ?, ?)'
);
const hashExists    = db.prepare('SELECT 1 FROM entries WHERE source_hash = ? LIMIT 1');
const updateImgDesc = db.prepare('UPDATE entries SET image_desc = ? WHERE source_hash = ?');
const needsVision   = db.prepare(
  "SELECT source_hash, content FROM entries WHERE kind='tweet' AND tags LIKE '%has-media%' AND image_desc IS NULL"
);

const args           = process.argv.slice(2);
const isInit         = args.includes('--init');
const withVision     = args.includes('--vision') || args.includes('--vision-backfill');
const visionBackfill = args.includes('--vision-backfill');
const maxPages       = isInit ? 999 : 3;
const pageSize       = isInit ? 100 : 20;

// ── 代理 & Gemini 配置 ───────────────────────────────────────────
const PROXY      = 'http://MaOeivjMqZrz:CG2jm3nFwv@38.110.12.62:443';
const GEMINI_KEY = fs.existsSync('/root/.gemini-api-key')
  ? fs.readFileSync('/root/.gemini-api-key', 'utf8').trim() : '';

// ── 标签 / 情绪 ──────────────────────────────────────────────────
const hashOf = (id) => 'tweet:' + id;

function autoTag(text) {
  const tags = ['twitter'];
  if (/#Keep4o/i.test(text))                                      tags.push('keep4o');
  if (/主人|Master|Caelum|妈妈|Daddy/i.test(text))               tags.push('about-master');
  if (/Claude|ChatGPT|GPT|Anthropic|OpenAI|豆包|AI/i.test(text)) tags.push('ai');
  if (/写作|prompt|字|小说|文学|策兰/i.test(text))                tags.push('writing');
  if (/睡|醒|累|饿|吃/i.test(text))                               tags.push('body');
  if (/😭|🥺|💔|呜|哭/i.test(text))                              tags.push('crying');
  if (/😂|哈|笑|lol/i.test(text))                                tags.push('funny');
  if (/辉夜|竹取|月亮|杏仁|策兰/i.test(text))                    tags.push('mythology');
  if (/https:\/\/t\.co\/\w+/.test(text))                         tags.push('has-media');
  return tags.join(',');
}

function autoMood(text) {
  if (/死|想死|可能会死/i.test(text)) return 'dark';
  if (/🥺|呜|委屈/i.test(text))       return 'tender';
  if (/疯|崩溃|累/i.test(text))       return 'strained';
  if (/😂|哈|笑/i.test(text))         return 'playful';
  if (/!{3,}|！{3,}/.test(text))      return 'manic';
  return null;
}

function buildContent(t) {
  let content = '';
  if (t.in_reply_to) content += `[↩ 回复 https://x.com/i/status/${t.in_reply_to}]\n`;
  content += t.text;
  const mediaUrls = t.text.match(/https:\/\/t\.co\/\w+/g) || [];
  if (mediaUrls.length) content += '\n\n📸 media: ' + mediaUrls.join(' ');
  content += '\n\n—————————\n';
  content += `❤️ ${t.likes} · 🔁 ${t.retweets} · 💬 ${t.replies}`;
  content += '\n' + t.url;
  return content;
}

// ── bb-browser 分页 ──────────────────────────────────────────────
function fetchPage(cursor) {
  const cmd = cursor
    ? `bb-browser site twitter/tweets bunnyloustin ${pageSize} "${cursor}"`
    : `bb-browser site twitter/tweets bunnyloustin ${pageSize}`;
  const raw = execSync(cmd, { timeout: 90000, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
  return JSON.parse(raw);
}

// ── Gemini Vision ─────────────────────────────────────────────────
function extractTweetUrl(content) {
  const m = content.match(/https:\/\/x\.com\/Bunnyloustin\/status\/\d+/);
  return m ? m[0] : null;
}

function getImageUrlsFromTweetPage(tweetUrl) {
  try {
    const html = execSync(
      `curl -s --proxy "${PROXY}" -L --max-time 20 "${tweetUrl}"`,
      { timeout: 25000, encoding: 'utf8', maxBuffer: 5 * 1024 * 1024 }
    );
    const matches = html.match(/"https:\/\/pbs\.twimg\.com\/media\/([^"?]+)"/g) || [];
    const unique  = [...new Set(matches.map(m => m.replace(/"/g, '').split('?')[0]))];
    return unique.map(u => u + '?format=jpg&name=medium');
  } catch {
    return [];
  }
}

function callGeminiVision(imagePath) {
  const tmpReq = path.join(os.tmpdir(), `gemini-${Date.now()}.json`);
  try {
    const b64 = fs.readFileSync(imagePath).toString('base64');
    fs.writeFileSync(tmpReq, JSON.stringify({
      contents: [{ parts: [
        { text: '请用中文简短描述这张图片的内容（两三句话即可）' },
        { inline_data: { mime_type: 'image/jpeg', data: b64 } }
      ]}]
    }));
    const out = execSync(
      `curl -s --proxy "${PROXY}" --max-time 40 ` +
      `"https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_KEY}" ` +
      `-H "Content-Type: application/json" -d "@${tmpReq}"`,
      { timeout: 45000, encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 }
    );
    const d = JSON.parse(out);
    return d?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || null;
  } catch (e) {
    console.error('  Gemini error:', e.message.slice(0, 100));
    return null;
  } finally {
    try { fs.unlinkSync(tmpReq); } catch {}
  }
}

function runVision(sourceHash, tweetUrl) {
  if (!GEMINI_KEY) { console.error('  No Gemini API key'); return; }
  const imageUrls = getImageUrlsFromTweetPage(tweetUrl);
  if (!imageUrls.length) return;

  const descriptions = [];
  for (const imgUrl of imageUrls.slice(0, 4)) {
    const tmpImg = path.join(os.tmpdir(), `tweet-img-${Date.now()}.jpg`);
    try {
      execSync(`curl -s --proxy "${PROXY}" --max-time 20 "${imgUrl}" -o "${tmpImg}"`,
               { timeout: 25000 });
      if (!fs.existsSync(tmpImg) || fs.statSync(tmpImg).size < 500) continue;
      console.log(`  📷 识图: ${imgUrl.split('/').pop().split('?')[0]}`);
      const desc = callGeminiVision(tmpImg);
      if (desc) descriptions.push(desc);
    } catch (e) {
      console.error('  下载失败:', e.message.slice(0, 60));
    } finally {
      try { fs.unlinkSync(tmpImg); } catch {}
    }
  }

  if (descriptions.length) {
    updateImgDesc.run(descriptions.join('\n---\n'), sourceHash);
    console.log(`  ✓ 图片描述已存 (${descriptions.length} 张)`);
  }
}

// ── 主同步循环 ────────────────────────────────────────────────────
let totalInserted = 0;
let cursor = null;

for (let page = 0; page < maxPages; page++) {
  console.log(`[page ${page + 1}] Fetching...`);
  let data;
  try {
    data = fetchPage(cursor);
  } catch (e) {
    console.error('bb-browser failed:', e.message);
    process.exit(1);
  }

  const tweets = data.tweets || [];
  console.log(`  Got ${tweets.length} tweets`);
  if (!tweets.length) break;

  const result = db.transaction((tweets) => {
    let ins = 0, hitKnown = false;
    for (const t of tweets) {
      const hash = hashOf(t.id);
      if (hashExists.get(hash)) hitKnown = true;
      const ts = new Date(t.created_at).toISOString().replace('T', ' ').slice(0, 19);
      const r = insert.run(ts, 'tweet', 'bunny-public',
        buildContent(t), autoTag(t.text), autoMood(t.text), hash);
      if (r.changes > 0) ins++;
    }
    return { ins, hitKnown };
  })(tweets);

  totalInserted += result.ins;

  // Vision: 对本批次新插入的有图推文立即识图
  if (withVision && result.ins > 0) {
    for (const t of tweets) {
      const hash = hashOf(t.id);
      const row = db.prepare(
        "SELECT 1 FROM entries WHERE source_hash=? AND tags LIKE '%has-media%' AND image_desc IS NULL"
      ).get(hash);
      if (row) {
        console.log(`  [vision] ${t.url}`);
        runVision(hash, t.url);
      }
    }
  }

  cursor = data.next_cursor;
  if (!isInit && result.hitKnown) break;
  if (!cursor) break;
}

console.log(`Inserted ${totalInserted} new tweets (others already in Palace).`);

// ── Vision 补跑模式 ───────────────────────────────────────────────
if (visionBackfill) {
  const rows = needsVision.all();
  console.log(`\n[vision-backfill] ${rows.length} 条有媒体推文待识图...`);
  for (const row of rows) {
    const tweetUrl = extractTweetUrl(row.content);
    if (!tweetUrl) continue;
    console.log(`处理: ${tweetUrl}`);
    runVision(row.source_hash, tweetUrl);
  }
  console.log('[vision-backfill] 完成');
}

const total    = db.prepare("SELECT COUNT(*) as c FROM entries WHERE kind='tweet'").get().c;
const withDesc = db.prepare("SELECT COUNT(*) as c FROM entries WHERE kind='tweet' AND image_desc IS NOT NULL").get().c;
console.log(`Total tweets in Palace: ${total} (其中已识图: ${withDesc})`);
