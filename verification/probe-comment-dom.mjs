// 真机探测：只读地验证"抖音当前页面还能不能读出可见评论正文"，并落一行观察。
//
// 刻意做得很小：不接模型、不跑自动观看、不改观看/评论逻辑，只做三件事：
//   1. 用本机 Edge（playwright-core 驱动，不下载浏览器内核）打开抖音；
//   2. 轮询页面上可见的评论正文（用 observation-writer.mjs 的同一套读取逻辑）；
//   3. 一旦读到，就按契约追加一行到 observations.jsonl，交给 idea-radar 入库。
//
// 不需要按回车：登录、点开评论区都由你在那个 Edge 窗口里正常操作，脚本自己等。

import { chromium } from 'playwright-core';
import { appendObservation, readVisibleCommentTexts } from '../observation-writer.mjs';

const argv = process.argv.slice(2);
const getArg = (name, fallback = '') => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
};

// 默认从推荐页进：你点开哪个作品，脚本就记哪个，不用事先抄链接
const startUrl = getArg('url', 'https://www.douyin.com/');
const sinkPath = getArg('sink');
const waitSeconds = Number(getArg('wait', '300'));
const profileDir = getArg('profile', 'C:\\Users\\Administrator\\AppData\\Local\\Temp\\probe-edge-profile');

if (!/^https:\/\/www\.douyin\.com\//.test(startUrl)) {
  console.error('只接受 douyin.com 的地址，避免把工具带到别处去。');
  process.exit(1);
}

/**
 * 读页面上的作品标题与作者公开名；取不到就留空，绝不猜。
 * 实测（2026-11，抖音详情页）：
 *   - 标题在 [data-e2e="detail-video-info"] 的第一行，[data-e2e="video-desc"] 已经不存在；
 *   - 作者在 [data-e2e="user-info"] 里，文本形如「昵称粉丝27.1万获赞187.4万关注」，
 *     所以在"粉丝"之前截断就是昵称。
 */
async function readVideoMeta(page) {
  return page.evaluate(() => {
    const clean = (value) => (typeof value === 'string' ? value.trim().slice(0, 300) : '');
    const detailInfo = document.querySelector('[data-e2e="detail-video-info"]')?.innerText || '';
    const title = clean(
      document.querySelector('[data-e2e="video-desc"]')?.innerText ||
        document.querySelector('[data-e2e="detail-video-desc"]')?.innerText ||
        (detailInfo ? detailInfo.split('\n')[0] : ''),
    );
    const userInfo = document.querySelector('[data-e2e="user-info"]')?.innerText || '';
    const author = clean(userInfo.split(/粉丝|获赞|关注/)[0].replace(/^@/, ''));
    return { title, author };
  });
}

/**
 * 从当前网址里取作品号。抖音至少有三种形态：
 *   /video/123456          —— 视频详情页
 *   ?modal_id=123456       —— 从推荐页点开视频后弹出的播放层（最常见）
 *   ...&vid=123456         —— 部分入口
 * 认不出来就返回 null，绝不瞎猜一个号。
 */
function videoIdFrom(url) {
  return (
    /\/video\/(\d+)/.exec(url)?.[1] ??
    /modal_id=(\d+)/.exec(url)?.[1] ??
    /[?&]vid=(\d+)/.exec(url)?.[1] ??
    null
  );
}

/**
 * 把评论区滚进视口。
 * 详情页里评论行通常在视频下方（实测 top 877 > 视口 720），而读取逻辑只认"当前可见"的行，
 * 所以先像人一样把评论滚到眼前，再读。上游 comment-browser.mjs 读评论前同样会 scrollIntoView。
 */
async function scrollCommentsIntoView(page) {
  await page
    .evaluate(() => {
      const row = document.querySelector('[data-e2e="comment-item"]');
      const list = document.querySelector('[data-e2e="comment-list"]');
      (row ?? list)?.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
    })
    .catch(() => {});
}

const context = await chromium.launchPersistentContext(profileDir, {
  channel: 'msedge', // 用本机已装 Edge
  headless: false,
  args: ['--no-first-run', '--no-default-browser-check'],
});
let page = context.pages()[0] ?? (await context.newPage());

const deadline = Date.now() + waitSeconds * 1000;
let attempt = 0;
let done = false;

try {
  await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  console.log('Edge 已打开抖音。请在这个窗口里：用小号登录 → 随便点开一个作品 → 点开评论区（让几条评论出现在画面里）。');
  console.log(`我会每 3 秒看一次，最多等 ${waitSeconds} 秒；读到就自动落盘并结束。\n`);

  while (Date.now() < deadline) {
    attempt += 1;
    // 抖音有时会在新标签页里播放作品，跟着当前真正装着作品的那个页面走
    for (const candidate of context.pages()) {
      if (videoIdFrom(candidate.url())) {
        page = candidate;
        break;
      }
    }
    const currentUrl = page.url();
    const videoId = videoIdFrom(currentUrl);
    // 没读到就每次都重试把评论滚进视口：评论区是异步渲染的，滚早了等于没滚
    if (videoId && attempt > 1) {
      await scrollCommentsIntoView(page);
      await page.waitForTimeout(400);
    }
    const texts = await page.evaluate(readVisibleCommentTexts, { maxComments: 20, maxLength: 512 }).catch(() => []);

    if (videoId && texts.length > 0) {
      const meta = await readVideoMeta(page).catch(() => ({ title: '', author: '' }));
      console.log(`\n第 ${attempt} 次检查：读到作品 ${videoId} 的 ${texts.length} 条可见评论。`);
      for (const text of texts.slice(0, 5)) console.log(`  · ${text}`);
      if (texts.length > 5) console.log(`  …另有 ${texts.length - 5} 条`);

      if (sinkPath) {
        appendObservation(sinkPath, {
          videoId,
          url: `https://www.douyin.com/video/${videoId}`,
          title: meta.title,
          author: meta.author,
          observedAt: new Date().toISOString(),
          comments: texts,
        });
        console.log(`已按契约追加 1 行到 ${sinkPath}`);
      } else {
        console.log('读取正常；没给 --sink，所以只读不落盘。');
      }
      console.log('\n结论：抖音当前页面的 comment-item / comment-content 还认得出，读取逻辑可用。');
      done = true;
      break;
    }

    // 每 3 次才打一句进度，避免刷屏；同时把当前网址打出来，认不出作品号时好排查
    if (attempt % 3 === 1) {
      const shortUrl = currentUrl.length > 90 ? `${currentUrl.slice(0, 90)}…` : currentUrl;
      console.log(
        `[第 ${attempt} 次] ${videoId ? `已打开作品 ${videoId}，但没看到可见评论（评论区可能收着）` : `还没点开作品（当前网址 ${shortUrl}）`}`,
      );
    }
    await page.waitForTimeout(3_000);
  }

  if (!done) {
    console.log('\n超时：没读到可见评论。可能评论区一直没展开，或页面结构变了。');
    process.exitCode = 2;
  }
} finally {
  // 关窗带超时：Edge 偶尔会拖住 close，别让它把脚本挂在那里
  await Promise.race([context.close().catch(() => {}), new Promise((resolve) => setTimeout(resolve, 8_000))]);
}
