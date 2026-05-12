#!/usr/bin/env node
// DOM scraper for Twitter historical tweets via date-filtered search
// Usage: node dom-scrape-twitter.js [--since 2025-08-01] [--until 2026-02-01]

const { execFileSync, execSync } = require('child_process');
const Database = require('/root/memory/web/node_modules/better-sqlite3');

const db = new Database('/root/memory/palace.db');
const insert = db.prepare(
  'INSERT OR IGNORE INTO entries (ts, kind, author, content, tags, mood, source_hash) VALUES (?, ?, ?, ?, ?, ?, ?)'
);
const hashExists = db.prepare('SELECT 1 FROM entries WHERE source_hash = ? LIMIT 1');

const hashOf = id => 'tweet:' + id;

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

function bbEval(jsCode) {
  try {
    const out = execFileSync('bb-browser', ['eval', jsCode], {
      encoding: 'utf8', timeout: 30000, maxBuffer: 5 * 1024 * 1024
    });
    return out.trim();
  } catch (e) {
    return null;
  }
}

const EXTRACT_JS = `(function() {
  var articles = document.querySelectorAll('article[data-testid="tweet"]');
  var result = [];
  for (var i = 0; i < articles.length; i++) {
    var a = articles[i];
    var textEl = a.querySelector('[data-testid="tweetText"]');
    var timeEl = a.querySelector('time');
    var links = Array.from(a.querySelectorAll('a[href*="/status/"]'));
    var statusLink = links.find(function(l) { return /\\/status\\/\\d+$/.test(l.href); });
    if (!statusLink) continue;
    var idMatch = statusLink.href.match(/\\/status\\/(\\d+)$/);
    if (!idMatch) continue;
    var id = idMatch[1];
    var likeEl = a.querySelector('[data-testid="like"] span span');
    var rtEl = a.querySelector('[data-testid="retweet"] span span');
    var replyEl = a.querySelector('[data-testid="reply"] span span');
    result.push({
      id: id,
      text: textEl ? textEl.innerText : '',
      time: timeEl ? timeEl.getAttribute('datetime') : '',
      url: statusLink.href,
      likes: parseInt((likeEl && likeEl.innerText) || '0') || 0,
      retweets: parseInt((rtEl && rtEl.innerText) || '0') || 0,
      replies: parseInt((replyEl && replyEl.innerText) || '0') || 0
    });
  }
  return JSON.stringify(result);
})()`;

const SCROLL_JS = `window.scrollBy(0, 3000); document.querySelectorAll('article[data-testid="tweet"]').length`;

// Parse args
const args = process.argv.slice(2);
const sinceArg = args.find((a, i) => args[i - 1] === '--since') || '2025-08-01';
const untilArg = args.find((a, i) => args[i - 1] === '--until') || '2026-02-20';

function monthRanges(since, until) {
  const ranges = [];
  let cur = new Date(since);
  const end = new Date(until);
  while (cur < end) {
    const next = new Date(cur);
    next.setMonth(next.getMonth() + 1);
    const s = cur.toISOString().slice(0, 10);
    const e = (next > end ? end : next).toISOString().slice(0, 10);
    ranges.push([s, e]);
    cur = next;
  }
  return ranges;
}

const ranges = monthRanges(sinceArg, untilArg);
console.log(`Scraping ${ranges.length} monthly ranges from ${sinceArg} to ${untilArg}`);

let grandTotal = 0;

for (const [since, until] of ranges) {
  console.log(`\n=== ${since} → ${until} ===`);
  const q = encodeURIComponent(`from:Bunnyloustin since:${since} until:${until}`);
  const url = `https://x.com/search?q=${q}&src=typed_query&f=live`;

  execFileSync('bb-browser', ['open', url], { encoding: 'utf8', timeout: 30000 });
  execSync('sleep 5');

  const seen = new Set();
  let monthInserted = 0;
  let staleRounds = 0;
  let prevSeen = 0;

  for (let scroll = 0; scroll < 60; scroll++) {
    const raw = bbEval(EXTRACT_JS);
    if (!raw) { console.log('  eval failed'); break; }

    let tweets;
    try { tweets = JSON.parse(raw); } catch { console.log('  parse failed'); break; }

    let newThisRound = 0;
    for (const t of tweets) {
      if (!t.id || !t.time || seen.has(t.id)) continue;
      seen.add(t.id);
      const hash = hashOf(t.id);
      if (!hashExists.get(hash)) {
        const ts = new Date(t.time).toISOString().replace('T', ' ').slice(0, 19);
        const r = insert.run(ts, 'tweet', 'bunny-public',
          buildContent(t), autoTag(t.text), autoMood(t.text), hash);
        if (r.changes > 0) { monthInserted++; grandTotal++; newThisRound++; }
      }
    }

    if (scroll % 5 === 0 || newThisRound > 0) {
      process.stdout.write(`  scroll ${scroll + 1}: ${tweets.length} visible, ${seen.size} unique seen, +${newThisRound} new\n`);
    }

    bbEval(SCROLL_JS);
    execSync('sleep 2');

    if (seen.size === prevSeen) {
      staleRounds++;
      if (staleRounds >= 4) {
        console.log('  No new tweets after 4 stale rounds, done with this month');
        break;
      }
    } else {
      staleRounds = 0;
      prevSeen = seen.size;
    }
  }

  console.log(`  → Inserted ${monthInserted} new tweets for ${since}`);
}

console.log(`\nTotal new tweets inserted: ${grandTotal}`);
const total = db.prepare("SELECT COUNT(*) as c FROM entries WHERE kind='tweet'").get().c;
const oldest = db.prepare("SELECT MIN(ts) as t FROM entries WHERE kind='tweet'").get().t;
console.log(`Total tweets in Palace: ${total} | Oldest: ${oldest}`);
