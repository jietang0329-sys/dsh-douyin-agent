// 按关键词批量采：搜索 → 取前几个作品 → 逐个把评论区滚进视口读正文 → 按契约落盘。
//
// 用法：
//   node verification/probe-search-comments.mjs --sink <observations.jsonl> \
//     --search workbuddy --search "codex 作品" --max-videos 2 --login-wait 40
//
// 仍然是只读：不点赞、不评论、不关注，只读页面上当时可见的评论正文。
// 登录由你在弹出的 Edge 窗口里完成（脚本开头会留一段时间给你）。

import { chromium } from 'playwright-core';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { appendObservation, readVisibleCommentTexts } from '../observation-writer.mjs';

const argv = process.argv.slice(2);
const getAll = (name) => {
  const values = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === `--${name}` && argv[index + 1]) values.push(argv[index + 1]);
  }
  return values;
};
const getArg = (name, fallback = '') => getAll(name)[0] ?? fallback;

const keywords = getAll('search');
const sinkPath = getArg('sink');
const maxVideos = Math.min(Number(getArg('max-videos', '2')), 5); // 单轮最多 5 个作品
const loginWait = Number(getArg('login-wait', '40'));
const profileDir = getArg('profile', 'C:\\Users\\Administrator\\AppData\\Local\\Temp\\probe-edge-profile');

// 风控用的两个本地文件（都在 data/ 下，data/ 已入库忽略，不进 Git）
const dataDir = getArg('data-dir', 'data');
const riskFile = `${dataDir}\\risk-block.json`;
const runLogFile = `${dataDir}\\probe-runs.json`;
const MAX_RUNS_PER_DAY = 3; // 一天最多跑 3 轮，超过就停

if (!keywords.length) {
  console.error('至少给一个 --search "<关键词>"');
  process.exit(1);
}

/** 冒烟闸①：如果上一轮留下了"被风控拦住"的记录，直接拒绝启动，等你人工清掉 */
function assertNotBlocked() {
  if (existsSync(riskFile)) {
    const detail = readFileSync(riskFile, 'utf8');
    console.error(`上一轮被风控拦住过，脚本拒绝启动。记录在 ${riskFile}：`);
    console.error(detail);
    console.error('确认账号正常、验证也已完成后，手动删除这个文件，再重新运行。');
    process.exit(2);
  }
}

/** 冒烟闸②：一天最多 3 轮，防止手抖连续跑 */
function countRunOnce() {
  mkdirSync(dataDir, { recursive: true });
  const today = new Date().toISOString().slice(0, 10);
  const log = existsSync(runLogFile) ? JSON.parse(readFileSync(runLogFile, 'utf8')) : {};
  const used = log[today] ?? 0;
  if (used >= MAX_RUNS_PER_DAY) {
    console.error(`今天已经跑了 ${used} 轮（上限 ${MAX_RUNS_PER_DAY} 轮），停下来。明天再说。`);
    process.exit(3);
  }
  log[today] = used + 1;
  writeFileSync(runLogFile, JSON.stringify(log, null, 2));
  return log[today];
}

/** 熔断：一旦看到验证/登录墙/空白页，就写记录并立刻退出，后面一个作品都不碰 */
function tripRisk(page, reason) {
  mkdirSync(dataDir, { recursive: true });
  const record = {
    at: new Date().toISOString(),
    reason,
    url: page?.url?.() ?? '',
  };
  writeFileSync(riskFile, JSON.stringify(record, null, 2));
  console.error(`\n[熔断] ${reason}（${record.url}）`);
  console.error(`已写入 ${riskFile}，本轮到此为止，不再做任何页面操作。`);
  process.exit(4);
}

/**
 * 检查页面是不是在拦我们。
 * 只看"有没有拦"和"页面是不是空的"，绝不点击、绝不关闭任何弹窗——弹窗留给你处理。
 */
async function detectRisk(page) {
  const probe = await page
    .evaluate(() => {
      const text = (document.body?.innerText || '').slice(0, 2000);
      const html = document.documentElement.innerHTML.slice(0, 200000);
      return {
        textLength: (document.body?.innerText || '').length,
        verifyWords: /请完成验证|安全验证|验证码|拖动滑块|滑块验证|人机验证|captcha/i.test(text),
        hasCaptchaBox: /captcha|verify-container|slider/i.test(html),
        loginWall: /登录后(查看|评论)|扫码登录|请先登录/.test(text),
        commentRows: document.querySelectorAll('[data-e2e="comment-item"]').length,
      };
    })
    .catch(() => null);
  if (!probe) return '页面读取失败（可能已被拦或未加载）';
  if (probe.verifyWords || probe.hasCaptchaBox) return '出现验证码/滑块';
  if (probe.loginWall) return '出现登录墙';
  if (probe.textLength === 0) return '页面是空的（疑似被拦）';
  return null;
}

const sleep = (page, ms) => page.waitForTimeout(ms);

/** 把评论区滚进视口：详情页里评论行常在视频下方，不滚就全算"不可见" */
async function scrollCommentsIntoView(page) {
  await page
    .evaluate(() => {
      const row = document.querySelector('[data-e2e="comment-item"]');
      const list = document.querySelector('[data-e2e="comment-list"]');
      (row ?? list)?.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
    })
    .catch(() => {});
}

/** 读标题与作者（作者在 user-info 文本里，形如「昵称粉丝27.1万获赞187.4万关注」） */
async function readVideoMeta(page) {
  return page
    .evaluate(() => {
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
    })
    .catch(() => ({ title: '', author: '' }));
}

/**
 * 从搜索结果页里捞作品号。
 * 结果卡片会以 /video/<号> 或 modal_id=<号> 的形式出现在 HTML 里，两种都收。
 */
async function collectVideoIds(page, limit) {
  const ids = await page.evaluate(() => {
    const html = document.documentElement.innerHTML;
    const found = new Set();
    for (const match of html.matchAll(/\/video\/(\d{8,})/g)) found.add(match[1]);
    for (const match of html.matchAll(/modal_id=(\d{8,})/g)) found.add(match[1]);
    return [...found];
  });
  return ids.filter((id) => /^\d{8,}$/.test(id)).slice(0, limit);
}

const context = await chromium.launchPersistentContext(profileDir, {
  channel: 'msedge', // 用本机已装 Edge，不下内核
  headless: false,
  args: ['--no-first-run', '--no-default-browser-check'],
});
const page = context.pages()[0] ?? (await context.newPage());

const summary = [];

// 闸门先过一遍：上一轮被拦过 / 今天跑够了，都不许再启动浏览器
assertNotBlocked();
const runIndex = countRunOnce();

try {
  await page.goto('https://www.douyin.com/', { waitUntil: 'domcontentloaded', timeout: 60_000 });
  console.log(`（今天第 ${runIndex} 轮）Edge 已打开抖音。请在窗口里用小号登录（有 ${loginWait} 秒时间），登录完它会自己开始搜。`);
  for (let left = loginWait; left > 0; left -= 10) {
    console.log(`  …还剩 ${left} 秒`);
    await sleep(page, Math.min(10_000, left * 1000));
  }
  // 登录这段是你手动操作的，先看一眼页面有没有弹验证；有就直接停，绝不代你点
  const loginRisk = await detectRisk(page);
  if (loginRisk) tripRisk(page, `登录阶段就发现：${loginRisk}`);

  let doneVideos = 0; // 单轮总作品数上限 5

  for (const keyword of keywords) {
    const searchUrl = `https://www.douyin.com/search/${encodeURIComponent(keyword)}?type=video`;
    console.log(`\n=== 搜索「${keyword}」 ===`);
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await sleep(page, 5_000);

    // 页面刚打开就先查一次风控：这一步能拦住"搜索直接被挡"的情况
    const searchRisk = await detectRisk(page);
    if (searchRisk) tripRisk(page, `搜索「${keyword}」时：${searchRisk}`);

    const ids = await collectVideoIds(page, Math.max(0, Math.min(maxVideos, 5 - doneVideos)));
    console.log(`捞到候选作品 ${ids.length} 个：${ids.join('、') || '（一个都没捞到）'}`);

    if (!ids.length) {
      const head = await page.evaluate(() => (document.body?.innerText || '').trim().slice(0, 120).replace(/\n+/g, ' ⏎ '));
      console.log(`  搜索结果页正文开头：${head}`);
      summary.push({ keyword, videoId: '—', comments: 0, note: '搜索结果里没捞到作品号' });
      continue;
    }

    for (const videoId of ids) {
      if (doneVideos >= 5) break;
      // 人和人之间的节奏：作品之间随机停 8–20 秒
      const pause = 8_000 + Math.floor(Math.random() * 12_000);
      console.log(`  等 ${Math.round(pause / 1000)} 秒再打开下一个作品…`);
      await sleep(page, pause);

      const url = `https://www.douyin.com/video/${videoId}`;
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      await sleep(page, 5_000);
      doneVideos += 1;

      // 详情页也查一次：出现验证/登录墙就整轮熔断
      const videoRisk = await detectRisk(page);
      if (videoRisk) tripRisk(page, `打开作品 ${videoId} 时：${videoRisk}`);

      // 评论是异步渲染的：滚一次读一次，最多试 5 轮
      let texts = [];
      for (let round = 1; round <= 5 && texts.length === 0; round += 1) {
        await scrollCommentsIntoView(page);
        await sleep(page, 1_200);
        texts = await page.evaluate(readVisibleCommentTexts, { maxComments: 20, maxLength: 512 }).catch(() => []);
      }

      if (!texts.length) {
        console.log(`  作品 ${videoId}：没读到可见评论（评论区未展开/已收起）`);
        summary.push({ keyword, videoId, comments: 0, note: '无可见评论' });
        continue;
      }

      const meta = await readVideoMeta(page);
      if (sinkPath) {
        appendObservation(sinkPath, {
          videoId,
          url,
          title: meta.title,
          author: meta.author,
          observedAt: new Date().toISOString(),
          comments: texts,
        });
      }
      console.log(`  作品 ${videoId}｜${meta.author || '作者未知'}｜${texts.length} 条评论 → 已落盘`);
      for (const text of texts.slice(0, 3)) console.log(`     · ${text.slice(0, 60)}`);
      summary.push({ keyword, videoId, comments: texts.length, note: meta.author || '' });
    }
  }

  console.log('\n=== 汇总 ===');
  for (const row of summary) console.log(`${row.keyword}｜${row.videoId}｜${row.comments} 条｜${row.note}`);
  const total = summary.reduce((sum, row) => sum + row.comments, 0);
  console.log(`共写入 ${summary.filter((row) => row.comments > 0).length} 个作品、${total} 条评论。`);
} finally {
  await Promise.race([context.close().catch(() => {}), new Promise((resolve) => setTimeout(resolve, 8_000))]);
}
