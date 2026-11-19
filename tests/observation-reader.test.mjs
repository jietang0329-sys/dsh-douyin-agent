// 观察落盘的读取逻辑自测：不需要浏览器、不需要装依赖，`node --test` 直接跑。
//
// 为什么要这层自测：真机验收要装 playwright + 登录抖音，网吧或临时机器上代价太大。
// 但"读得对不对"里的绝大部分其实是纯逻辑——可见性、跳过回复行、去重、条数/字数上界——
// 这些用假 DOM 就能证明，只有"抖音到底还叫不叫 comment-content"必须看真页面。
//
// 假 DOM 是手写的普通对象，只实现这段读取逻辑真正用到的几件事：
// closest / parentElement / querySelectorAll / innerText / getBoundingClientRect / getComputedStyle。

import assert from 'node:assert/strict';
import test from 'node:test';

import { readVisibleCommentTexts } from '../observation-writer.mjs';

/** 可见元素的默认几何：宽高正常、落在视口内 */
const visibleBox = { width: 800, height: 24, top: 10, left: 10, right: 810, bottom: 34 };
const hiddenBox = { width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 };
const visibleStyle = { display: 'block', visibility: 'visible', opacity: '1' };
const hiddenStyle = { display: 'none', visibility: 'visible', opacity: '1' };

/**
 * 极简节点。tag 就是 data-e2e 的值（comment-item / comment-content）。
 * 其它选择器一律匹配不到：宁可查不到，也不要让没实现的选择器看上去"通过了"。
 */
function node(tag, { text = '', box = visibleBox, style = visibleStyle, children = [] } = {}) {
  const self = {
    tag,
    innerText: text,
    parentElement: null,
    childElementCount: children.length,
    getBoundingClientRect: () => box,
    getComputedStyle: () => style,
    closest(selector) {
      if (selector !== '[data-e2e="comment-item"]') return null;
      let cursor = self;
      while (cursor) {
        if (cursor.tag === 'comment-item') return cursor;
        cursor = cursor.parentElement;
      }
      return null;
    },
    querySelectorAll(selector) {
      // 真 DOM 支持逗号并列选择器（取并集），读取逻辑正依赖这一点，替身也要支持
      const tests = selector.split(',').map((part) => part.trim());
      const matches = (candidate) =>
        tests.some((part) => {
          const dataE2e = /^\[data-e2e="([a-z-]+)"\]$/.exec(part)?.[1];
          if (dataE2e) return candidate.tag === dataE2e;
          const className = /^\.([\w-]+)$/.exec(part)?.[1];
          if (className) return candidate.className === className;
          return false; // 复合选择器（如 .A > .B）在替身里不模拟，一律不匹配
        });
      const found = [];
      // 模拟真实 DOM：后代里的同类节点也会被查到——嵌套回复行正是靠这一点被排除
      const walk = (current) => {
        for (const child of current.childNodes) {
          if (matches(child)) found.push(child);
          walk(child);
        }
      };
      walk(self);
      return found;
    },
  };
  self.childNodes = children;
  for (const child of children) child.parentElement = self;
  return self;
}

/** 把假 DOM 挂到全局：读取函数是照着浏览器全局写的 */
function withFakeDom(page, run) {
  const previous = {
    document: globalThis.document,
    getComputedStyle: globalThis.getComputedStyle,
    innerHeight: globalThis.innerHeight,
    innerWidth: globalThis.innerWidth,
  };
  globalThis.document = page;
  globalThis.getComputedStyle = (element) => element.getComputedStyle();
  globalThis.innerHeight = 900;
  globalThis.innerWidth = 1440;
  try {
    return run();
  } finally {
    Object.assign(globalThis, previous);
  }
}

const MAX_COMMENTS = 20;
const MAX_TEXT_LENGTH = 512;

/** 造一页：rows 是 [文字, 选项] 的数组，按顺序拼成评论列表 */
function pageOf(rows) {
  const items = rows.map(([text, options = {}]) => node('comment-item', { ...options, children: [node('comment-content', { text })] }));
  return { querySelectorAll: (selector) => (selector === '[data-e2e="comment-item"]' ? items : []) };
}

const readFrom = (page) => withFakeDom(page, () => readVisibleCommentTexts(MAX_COMMENTS, MAX_TEXT_LENGTH));

test('按页面顺序读出可见评论正文', () => {
  const page = pageOf([['有没有现成的工具能自动整理素材'], ['这个软件用不了，注册不了']]);
  assert.deepEqual(readFrom(page), ['有没有现成的工具能自动整理素材', '这个软件用不了，注册不了']);
});

test('隐藏的行不算页面可见，直接跳过', () => {
  const page = pageOf([
    ['看得见的一条', {}],
    ['被折叠看不见的一条', { box: hiddenBox }],
    ['被 display:none 藏起来的一条', { style: hiddenStyle }],
  ]);
  assert.deepEqual(readFrom(page), ['看得见的一条']);
});

test('嵌在别的评论里的回复行不当作首层评论', () => {
  const outer = node('comment-item', { children: [node('comment-content', { text: '一级评论' })] });
  const reply = node('comment-item', { children: [node('comment-content', { text: '这条是回复' })] });
  reply.parentElement = outer;
  outer.childNodes.push(reply);

  const page = { querySelectorAll: (selector) => (selector === '[data-e2e="comment-item"]' ? [outer, reply] : []) };
  assert.deepEqual(readFrom(page), ['一级评论']);
});

test('同一句重复出现只留一条', () => {
  const page = pageOf([['有没有现成的模板', {}], ['有没有现成的模板', {}], ['另一句', {}]]);
  assert.deepEqual(readFrom(page), ['有没有现成的模板', '另一句']);
});

test('超过 20 条就截断，不多读（不翻页穷举）', () => {
  const rows = Array.from({ length: 30 }, (_, index) => [`第 ${index + 1} 条评论`, {}]);
  const texts = readFrom(pageOf(rows));
  assert.equal(texts.length, MAX_COMMENTS);
  assert.equal(texts[0], '第 1 条评论');
  assert.equal(texts[MAX_COMMENTS - 1], `第 ${MAX_COMMENTS} 条评论`);
});

test('超过 512 字的长评论整条跳过，不截断造半句', () => {
  const longText = '啊'.repeat(MAX_TEXT_LENGTH + 1);
  const edgeText = '啊'.repeat(MAX_TEXT_LENGTH);
  const page = pageOf([[longText, {}], [edgeText, {}]]);
  assert.deepEqual(readFrom(page), [edgeText]);
});

test('一行里出现两个内容块（结构异常）就跳过这一行', () => {
  const weird = node('comment-item', {
    children: [node('comment-content', { text: '第一块' }), node('comment-content', { text: '第二块' })],
  });
  const normal = node('comment-item', { children: [node('comment-content', { text: '正常一行' })] });
  const page = { querySelectorAll: (selector) => (selector === '[data-e2e="comment-item"]' ? [weird, normal] : []) };
  assert.deepEqual(readFrom(page), ['正常一行']);
});
