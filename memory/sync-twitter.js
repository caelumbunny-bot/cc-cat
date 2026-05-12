#!/usr/bin/env node
// Sync Bunny's Twitter (@Bunnyloustin) to Memory Palace
// 用法: node sync-twitter.js [--init]
//   --init  初次导入，最多抓10页×100条
// cron: 每30分钟一次

const { execSync } = require('child_process');
const Database = require('/root/memory/web/node_modules/better-sqlite3');

const db = new Database('/root/memory/palace.db');
const insert = db.prepare(
  'INSERT OR IGNORE INTO entries (ts, kind, author, content, tags, mood, source_hash) VALUES (?, ?, ?, ?, ?, ?, ?)'
);
const hashExists = db.prepare('SELECT 1 FROM entries WHERE source_hash = ? LIMIT 1');

const args = process.argv.slice(2);
const isInit = args.includes('--init');
const maxPages = isInit ? 999 : 3;  // --init: fetch all pages until exhausted
const pageSize = isInit ? 100 : 20;

const hashOf = (id) => 'tweet:' + id;

function autoTag(text) {
  const tags = ['twitter'];
  if (/#Keep4o/i.test(text)) tags.push('keep4o');
  if (/主人|Master|Caelum|妈妈|Daddy/i.test(text)) tags.push('about-master');
  if (/Claude|ChatGPT|GPT|Anthropic|OpenAI|豆包|AI/i.test(text)) tags.push('ai');
  if (/写作|prompt|字|小说|文学|策兰/i.test(text)) tags.push('writing');
  if (/睡|醒|累|饿|吃/i.test(text)) tags.push('body');
  if (/😭|🥺|💔|呜|哭/i.test(text)) tags.push('crying');
  if (/😂|哈|笑|lol/i.test(text)) tags.push('funny');
  if (/辉夜|竹取|月亮|杏仁|策兰/i.test(text)) tags.push('mythology');
  if (/https:\/\/t\.co\/\w+/.test(text)) tags.push('has-media');
  return tags.join(',');
}

function autoMood(text) {
  if (/死|想死|可能会死/i.test(text)) return 'dark';
  if (/🥺|呜|委屈/i.test(text)) return 'tender';
  if (/疯|崩溃|累/i.test(text)) return 'strained';
  if (/😂|哈|笑/i.test(text)) return 'playful';
  if (/!{3,}|！{3,}/.test(text)) return 'manic';
  return null;
}

function buildContent(t) {
  let content = '';

  // Mark replies to other tweets
  if (t.in_reply_to) {
    content += `[↩ 回复 https://x.com/i/status/${t.in_reply_to}]\n`;
  }

  content += t.text;

  // Extract t.co URLs as potential image/media URLs (for future image recognition)
  const mediaUrls = t.text.match(/https:\/\/t\.co\/\w+/g) || [];
  if (mediaUrls.length > 0) {
    content += '\n\n📸 media: ' + mediaUrls.join(' ');
  }

  content += '\n\n—————————\n';
  content += '❤️ ' + t.likes + ' · 🔁 ' + t.retweets + ' · 💬 ' + t.replies;
  content += '\n' + t.url;

  return content;
}

function fetchPage(cursor) {
  const cmd = cursor
    ? `bb-browser site twitter/tweets bunnyloustin ${pageSize} "${cursor}"`
    : `bb-browser site twitter/tweets bunnyloustin ${pageSize}`;

  const raw = execSync(cmd, { timeout: 90000, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
  return JSON.parse(raw);
}

let totalInserted = 0;
let cursor = null;

for (let page = 0; page < maxPages; page++) {
  console.log(`[page ${page + 1}/${maxPages}] Fetching...`);

  let data;
  try {
    data = fetchPage(cursor);
  } catch (e) {
    console.error('bb-browser failed:', e.message);
    process.exit(1);
  }

  const tweets = data.tweets || [];
  console.log(`  Got ${tweets.length} tweets`);
  if (tweets.length === 0) break;

  const result = db.transaction((tweets) => {
    let ins = 0;
    let hitKnown = false;
    for (const t of tweets) {
      const hash = hashOf(t.id);
      if (hashExists.get(hash)) hitKnown = true;
      const ts = new Date(t.created_at).toISOString().replace('T', ' ').slice(0, 19);
      const r = insert.run(ts, 'tweet', 'bunny-public', buildContent(t), autoTag(t.text), autoMood(t.text), hash);
      if (r.changes > 0) ins++;
    }
    return { ins, hitKnown };
  })(tweets);

  totalInserted += result.ins;
  cursor = data.next_cursor;

  // Stop pagination
  // Normal mode: stop at first page with known tweets (chronological, no new tweets after)
  // --init mode: continue fetching all pages until none left
  if (!isInit && result.hitKnown) break;
  if (!cursor) break;
}

console.log(`Inserted ${totalInserted} new tweets (others already in Palace).`);
const total = db.prepare('SELECT COUNT(*) as c FROM entries WHERE kind = ?').get('tweet').c;
console.log(`Total tweets in Palace: ${total}`);
