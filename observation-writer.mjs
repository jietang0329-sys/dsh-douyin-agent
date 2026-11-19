// 观察落盘：把"本次观察页面上真实可见的公开评论"追加写进一份 JSONL，供 idea-radar 入库。
//
// 三条硬边界（对应 idea-radar #12 的验收）：
// 1. 只追加，不改写、不删行：文件是流水账，丢了就补不回来，写坏了也没人敢删；
// 2. 只落"当次观察页面真实可见"的评论，不翻页、不穷举、不补写看不见的；
// 3. 只取正文，绝不写评论者昵称、头像或主页 id —— 页面上的作者信息一个字节都不带出来。
//
// 默认关闭：不设 IDEA_RADAR_OBSERVATIONS_PATH 就什么都不做。
// 这样上游代码的默认行为完全不变，只有你显式开环境变量才会多出一份落盘文件。

import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

/** 一次观察最多落多少条评论：页面首屏就那么几条，再多就是翻页了 */
const MAX_COMMENTS = 20;

/** 单条评论正文上限，和契约守卫（idea-radar 02）的 512 字保持一致 */
const MAX_TEXT_LENGTH = 512;

/** 落盘开关：返回文件路径；没配就是 null（整条链路直接跳过） */
export function observationSinkPath(env = process.env) {
  const configured = typeof env.IDEA_RADAR_OBSERVATIONS_PATH === 'string' ? env.IDEA_RADAR_OBSERVATIONS_PATH.trim() : '';
  return configured === '' ? null : configured;
}

/**
 * 在页面里读"当前可见"的评论正文。
 * 这段函数会被 page.evaluate 拿去浏览器里跑，所以不能引用外面的变量。
 * 只读 [data-e2e="comment-item"] 下 comment-content 的纯文字，跳过隐藏行和回复二级行。
 */
function readVisibleCommentTexts(maxComments, maxLength) {
  const visible = (element) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return (
      rect.width > 0 &&
      rect.height > 0 &&
      rect.bottom > 0 &&
      rect.right > 0 &&
      rect.top < innerHeight &&
      rect.left < innerWidth &&
      style.display !== 'none' &&
      style.visibility !== 'hidden' &&
      Number(style.opacity) !== 0
    );
  };

  const texts = [];
  for (const row of document.querySelectorAll('[data-e2e="comment-item"]')) {
    // 不可见的不算"页面可见"；嵌在另一条评论里的回复行也不算首层评论
    if (!visible(row) || row.parentElement?.closest('[data-e2e="comment-item"]')) continue;

    // 只在"属于这一行"的内容块里取字，避免把按钮文案、时间、"展开回复"混进来。
    // 选择器与上游 comment-browser.mjs 的 readCommentDom 保持一致：
    // data-e2e 是稳定契约，后两个是抖音改版时可能顶上的混淆类名兜底。
    const contents = [...row.querySelectorAll('[data-e2e="comment-content"],.comment-item-content,.FduGc_lz > .Sh1Da424')].filter(
      (element) => element.closest('[data-e2e="comment-item"]') === row,
    );
    if (contents.length !== 1) continue;

    const raw = String(contents[0].innerText ?? '').replace(/\r/g, '');
    const text = raw.trim();
    if (text === '' || text.length > maxLength) continue;
    if (texts.includes(text)) continue; // 同一句重复出现只算一次
    texts.push(text);
    if (texts.length >= maxComments) break;
  }
  return texts;
}

/**
 * 追加一行观察。字段名与 idea-radar 的上游契约一致（camelCase），
 * 少一个字段守卫就拒，所以这里逐项显式写出，不做对象展开。
 */
export function appendObservation(sinkPath, { videoId, url, title, author, observedAt, comments }) {
  const line = {
    videoId,
    url,
    title,
    author,
    observedAt,
    comments: comments.map((text) => ({ text })),
  };
  mkdirSync(path.dirname(sinkPath), { recursive: true });
  // 一次写一行、带换行：并发追加时最多交错，不会互相覆盖
  appendFileSync(sinkPath, `${JSON.stringify(line)}\n`, 'utf8');
}

/**
 * 观察收尾时调用的入口：读一次可见评论，有内容就追加一行。
 * 任何异常都吞掉并只留一句提示——落盘失败绝不能影响"刷视频"这件事本身。
 */
export async function recordRadarObservation({ page, video, state, now = new Date(), env = process.env, onEvent } = {}) {
  const sinkPath = observationSinkPath(env);
  if (sinkPath === null || !page || !video) return null;

  try {
    // 作品、账号、登录态有一个不对就不落：宁可少一条，也不落一条身份可疑的观察
    if (!video.id || state?.loginRequired || state?.verificationRequired || state?.privateChatVisible || state?.unsupportedPage) {
      return null;
    }

    // 取字只在浏览器里做一次：函数是自包含的（不引用外部变量），参数由调用方显式传
    const list = await page.evaluate(readVisibleCommentTexts, MAX_COMMENTS, MAX_TEXT_LENGTH);
    if (!Array.isArray(list) || list.length === 0) return null;

    appendObservation(sinkPath, {
      videoId: String(video.id),
      url: typeof video.url === 'string' ? video.url : '',
      title: typeof video.title === 'string' ? video.title : '',
      author: typeof video.author === 'string' ? video.author : '',
      observedAt: now.toISOString(),
      comments: list,
    });

    onEvent?.({ type: 'radar.observation-written', videoId: String(video.id), commentCount: list.length });
    return { videoId: String(video.id), commentCount: list.length };
  } catch (error) {
    onEvent?.({ type: 'radar.observation-skipped', message: '本次观察没有写入落盘文件，不影响继续观看。', code: error?.code });
    return null;
  }
}

// 保留一个显式导出，方便契约侧自检时直接拿到读取函数
export { readVisibleCommentTexts };
