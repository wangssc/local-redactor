// v4 功能闭环复测：引擎层（人名 / 映射表）+ 真实浏览器（复制 / 导出 / 刷新 / 导入还原）。
// 用本机 Edge 的无头模式 + DevTools 协议，只连 127.0.0.1 的调试端口，不联网。
// 用法：node D:/aa/c2/site/selftest-v4.js
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const HTML_PATH = path.join(__dirname, 'index.html');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PAGE = 'file:///D:/aa/c2/site/index.html';
const PORT = 9334;
const OUT_DIR = path.join(__dirname, 'layouts');
const DL_DIR = path.join(__dirname, '.tmp-dl');

const html = fs.readFileSync(HTML_PATH, 'utf8');
const sleep = ms => new Promise(r => setTimeout(r, ms));

const PASS = [];
const FAIL = [];
function check(name, ok, detail) {
  (ok ? PASS : FAIL).push(name);
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name);
  if (detail) console.log('        ' + String(detail).replace(/\n/g, '\n        '));
}

function diffIndex(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return a.length === b.length ? -1 : n;
}

// ---------------------------------------------------------------- 引擎
const BEGIN = '/* ===== ENGINE:BEGIN ===== */';
const END = '/* ===== ENGINE:END ===== */';
const engineSrc = html.slice(html.indexOf(BEGIN) + BEGIN.length, html.indexOf(END));
const sandbox = {};
new Function('exports', engineSrc + '\n;exports.Redactor = Redactor;')(sandbox);
const R = sandbox.Redactor;

// 测试 1 用的原文：三个全名要认出来，五个反例一个都不许动
const NAMES_TEXT =
  '11 月 3 日的复盘会由张三丰主持，李四负责对接，王小明负责记录。' +
  '会后张三丰把纪要发给了李四。\n\n' +
  '顺带一提：联系人：王先生；李女士也在名单里。地址写的是张江，' +
  '李庄和王村都在附近。屋里的陈设很简单，把嘴张开说话，' +
  '买了一斤李子，打开高德地图，《王的盛宴》看过了。';

const HIT = ['张三丰', '李四', '王小明'];
const MISS = ['王先生', '李女士', '张江', '李庄', '王村', '陈设', '张开', '李子', '高德地图', '王的盛宴'];

console.log('\n[1] 人名：全名要认，反例一个都不许动');
const r1 = R.redact(NAMES_TEXT);
console.log('  --- 脱敏稿 ---');
console.log(r1.plain.split('\n').map(l => '  | ' + l).join('\n'));
console.log('  --- 占位符 ---');
console.log('  ' + JSON.stringify(r1.map, null, 0).replace(/","/g, '", "'));

const stillThere = HIT.filter(n => r1.plain.indexOf(n) >= 0);
check('1a 张三丰 / 李四 / 王小明 三个全名都被替换', stillThere.length === 0,
  stillThere.length ? '漏了：' + stillThere.join('、') : '命中 ' + HIT.map(n => r1.map[Object.keys(r1.map).find(k => r1.map[k] === n)] || '?').join(' / '));

const hurt = MISS.filter(w => r1.plain.indexOf(w) < 0);
check('1b 十个反例一个都没动', hurt.length === 0,
  hurt.length ? '误伤：' + hurt.join('、') : MISS.join('、') + ' —— 全部原样');

check('1c 反例那段与输入逐字相同',
  r1.plain.indexOf(NAMES_TEXT.slice(NAMES_TEXT.indexOf('顺带一提'))) >= 0);

const back1 = R.restore(r1.plain, r1.map);
check('1d 全名也能逐字还原', diffIndex(back1, NAMES_TEXT) === -1);

// 原来的「姓 + 某」「姓 + 职务」不能被新规则挤掉
const r1b = R.redact('报告里提到：张某负责对接，李经理审批，王某复核，联系人叫张总。');
check('1e 原有的「姓 + 某」「姓 + 职务」仍然认',
  r1b.matches === 4 && !/张某|李经理|王某|张总/.test(r1b.plain),
  r1b.plain);

// ---------------------------------------------------------------- 浏览器
function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  const listeners = [];
  ws.addEventListener('message', ev => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id); pending.delete(msg.id);
      msg.error ? p.rej(new Error(JSON.stringify(msg.error))) : p.res(msg.result);
    } else if (msg.method) listeners.forEach(f => f(msg));
  });
  const ready = new Promise((res, rej) => {
    ws.addEventListener('open', res);
    ws.addEventListener('error', rej);
  });
  return {
    ready,
    send: (method, params = {}) => new Promise((res, rej) => {
      const i = ++id; pending.set(i, { res, rej });
      ws.send(JSON.stringify({ id: i, method, params }));
    }),
    on: f => listeners.push(f),
    close: () => ws.close()
  };
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.rmSync(DL_DIR, { recursive: true, force: true });
  fs.mkdirSync(DL_DIR, { recursive: true });

  const edge = spawn(EDGE, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${path.join(__dirname, '.edge-cdp-v4')}`,
    'about:blank'
  ], { stdio: 'ignore' });

  for (let i = 0; i < 60; i++) {
    try { await fetch(`http://127.0.0.1:${PORT}/json/version`); break; }
    catch (e) { await sleep(200); }
  }

  const ver = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
  const browser = connect(ver.webSocketDebuggerUrl);
  await browser.ready;
  let granted = '';
  try {
    await browser.send('Browser.grantPermissions', {
      permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite']
    });
    granted = '已授予 clipboardReadWrite / clipboardSanitizedWrite';
  } catch (e) {
    granted = '授权失败：' + e.message;
  }
  try {
    await browser.send('Browser.setDownloadBehavior', {
      behavior: 'allow', downloadPath: DL_DIR, eventsEnabled: true
    });
  } catch (e) {
    console.log('  (Browser.setDownloadBehavior 不可用：' + e.message + ')');
  }

  const target = await (await fetch(
    `http://127.0.0.1:${PORT}/json/new?` + encodeURIComponent(PAGE), { method: 'PUT' }
  )).json();
  const c = connect(target.webSocketDebuggerUrl);
  await c.ready;
  await c.send('Page.enable');
  await c.send('Runtime.enable');
  await c.send('DOM.enable');
  await c.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });

  async function waitLoad() {
    const p = new Promise(r => c.on(m => { if (m.method === 'Page.loadEventFired') r(); }));
    return p;
  }
  let loaded = waitLoad();
  await c.send('Page.navigate', { url: PAGE });
  await loaded;
  await sleep(300);

  const ev = async (expression, awaitPromise = false) => {
    const r = await c.send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
    return r.result.value;
  };

  // 真实鼠标点击（带 user activation，剪贴板要这个）
  async function realClick(sel) {
    const box = await ev(`(() => { const b = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect();
      return JSON.stringify({ x: b.left + b.width / 2, y: b.top + b.height / 2 }); })()`);
    const p = JSON.parse(box);
    await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y, button: 'none' });
    await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1 });
    await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: 1 });
  }

  // 截图（首屏 1280×800）
  const shot = await c.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  fs.writeFileSync(path.join(OUT_DIR, 'v4-desktop.png'), Buffer.from(shot.data, 'base64'));

  const metrics = JSON.parse(await ev(`(() => {
    const r = s => { const e = document.querySelector(s); if (!e) return null; const b = e.getBoundingClientRect();
      return { top: Math.round(b.top), bottom: Math.round(b.bottom), left: Math.round(b.left), right: Math.round(b.right) }; };
    return JSON.stringify({ vw: innerWidth, vh: innerHeight, scrollW: document.documentElement.scrollWidth,
      scrollH: document.documentElement.scrollHeight, lead: r('.hero .lead'), scene: r('.scene'),
      examples: r('.examples'), src: r('#src'), out: r('#out'), restore: r('#restore'),
      copy: r('#copy'), export: r('#export'), import: r('#import'), legend: r('.legend'), cards: r('.cards') });
  })()`));

  // ------------------------------------------------ 测试 2：复制
  console.log('\n[2] 复制脱敏稿 → 剪贴板与右侧逐字相同');
  await ev(`(() => { const t = document.getElementById('src'); t.value = ${JSON.stringify(NAMES_TEXT)};
    t.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await sleep(200);
  const outText = await ev(`document.getElementById('out').textContent`);
  const outHtml = await ev(`document.getElementById('out').innerHTML`);

  await realClick('#copy');
  await sleep(150);
  const labelNow = await ev(`document.getElementById('copy').textContent`);
  const statusNow = await ev(`document.getElementById('status').textContent`);

  let clip = null, clipMethod = '';
  try {
    clip = await ev(`navigator.clipboard.readText()`, true);
    clipMethod = 'navigator.clipboard.readText()';
  } catch (e) {
    clipMethod = '读不到（' + e.message.slice(0, 60) + '）';
  }

  if (clip === null) {
    // 读不到就退一步：把 writeText 包一层，记录它实际收到的字符串，再点一次
    await ev(`(() => { window.__copied = null; const o = navigator.clipboard.writeText.bind(navigator.clipboard);
      navigator.clipboard.writeText = function (s) { window.__copied = s; return o(s); }; })()`);
    await realClick('#copy');
    await sleep(200);
    clip = await ev(`window.__copied`);
    clipMethod += ' → 改为截获 writeText 实参';
  }
  // Windows 剪贴板会把 \n 存成 \r\n，这是系统的换行约定，不是内容差异；归一化后再逐字比
  const clipNorm = clip === null ? '' : clip.replace(/\r\n/g, '\n');
  check('2a 剪贴板内容与右侧脱敏稿逐字相同', clipNorm === outText,
    '取回方式：' + clipMethod +
    '\n剪贴板 ' + (clip === null ? 'null' : clip.length + ' 字符（归一化后 ' + clipNorm.length + '）') +
    ' / 脱敏稿 ' + outText.length + ' 字符 / 首个差异位置：' + diffIndex(clipNorm, outText) +
    (clip && clip !== clipNorm ? '\n（差异只有换行：Windows 剪贴板把 \\n 存成 \\r\\n）' : ''));
  check('2b 按钮文字变成「已复制 ✓」', labelNow === '已复制 ✓', JSON.stringify(labelNow) + ' · 状态行：' + statusNow);

  await sleep(2100);
  const labelLater = await ev(`document.getElementById('copy').textContent`);
  check('2c 2 秒后变回「复制脱敏稿」', labelLater === '复制脱敏稿', JSON.stringify(labelLater));

  // 剪贴板被拒时不能静默失败
  await ev(`(() => { window.__restore = { w: navigator.clipboard.writeText, e: document.execCommand };
    navigator.clipboard.writeText = function () { return Promise.reject(new Error('NotAllowedError')); };
    document.execCommand = function () { return false; }; })()`);
  await realClick('#copy');
  await sleep(250);
  const badStatus = await ev(`document.getElementById('status').textContent`);
  const badCls = await ev(`document.getElementById('status').className`);
  check('2d 剪贴板被拒时给出提示，不静默失败',
    /✗/.test(badStatus) && /bad/.test(badCls), badStatus);
  await ev(`(() => { navigator.clipboard.writeText = window.__restore.w; document.execCommand = window.__restore.e; })()`);

  // ------------------------------------------------ 测试 3：导出 → 刷新 → 导入
  console.log('\n[3] 下载映射表 → 刷新 → 清空 → 导入 + 贴回脱敏稿 → 逐字还原');
  const before = fs.readdirSync(DL_DIR);
  await realClick('#export');
  let dlFile = null;
  for (let i = 0; i < 40; i++) {
    await sleep(150);
    const now = fs.readdirSync(DL_DIR).filter(f => !before.includes(f) && /\.json$/.test(f));
    if (now.length) { dlFile = now[0]; break; }
  }
  check('3a 点「下载映射表」真的落了 .json 文件', !!dlFile, dlFile || '（' + DL_DIR + ' 里没出现新文件）');

  let doc = null;
  if (dlFile) {
    const raw = fs.readFileSync(path.join(DL_DIR, dlFile), 'utf8');
    doc = JSON.parse(raw);
    console.log('  --- ' + dlFile + '（' + raw.length + ' 字符）---');
    console.log(raw.split('\n').slice(0, 14).map(l => '  | ' + l).join('\n') + '\n  | ...');
  }
  const mapKeys = doc && doc.map ? Object.keys(doc.map) : [];
  check('3b json 里有 version / map，且 map 是「占位符 → 原文」',
    !!doc && doc.version === 1 && mapKeys.length > 0 && typeof doc.map[mapKeys[0]] === 'string',
    doc ? 'version=' + doc.version + '，map ' + mapKeys.length + ' 条，例如 ' + mapKeys[0] + ' → ' + doc.map[mapKeys[0]] : '没有文件');
  check('3c json 里写清了每个字段的含义',
    !!doc && doc.fields && ['version', 'map', 'format', 'createdAt', 'counts', 'generator']
      .every(k => typeof doc.fields[k] === 'string' && doc.fields[k].length > 8),
    doc && doc.fields ? Object.keys(doc.fields).join(' / ') : '没有 fields');

  // 刷新：内存里的映射表必须丢干净
  loaded = waitLoad();
  await c.send('Page.reload');
  await loaded;
  await sleep(400);
  const afterReload = JSON.parse(await ev(`(() => JSON.stringify({
    out: document.getElementById('out').textContent,
    srcLen: document.getElementById('src').value.length,
    copy: document.getElementById('copy').textContent }))()`));
  check('3d 刷新后映射表不在内存里（右栏回到默认示例）',
    afterReload.out.indexOf('[人名') >= 0 && afterReload.srcLen > 100,
    '刷新后右栏 ' + afterReload.out.length + ' 字符，左栏 ' + afterReload.srcLen + ' 字符');

  // 清空 → 贴回脱敏稿 → 导入 json
  await ev(`(() => { const t = document.getElementById('src'); t.value = '';
    t.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await sleep(120);
  const cleared = await ev(`document.getElementById('out').textContent`);
  await ev(`(() => { const t = document.getElementById('src'); t.value = ${JSON.stringify(outText)};
    t.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await sleep(200);

  const d = await c.send('DOM.getDocument', { depth: -1 });
  const q = await c.send('DOM.querySelector', { nodeId: d.root.nodeId, selector: '#mapfile' });
  await c.send('DOM.setFileInputFiles', {
    files: [path.join(DL_DIR, dlFile)], nodeId: q.nodeId
  });
  await sleep(500);
  const imported = JSON.parse(await ev(`(() => JSON.stringify({
    out: document.getElementById('out').textContent,
    status: document.getElementById('status').textContent,
    cls: document.getElementById('status').className,
    btn: document.getElementById('restore').textContent }))()`));

  check('3e 清空后右栏是空状态', /左边输入/.test(cleared), cleared);
  check('3f 导入 json + 贴回脱敏稿 → 还原结果与原文逐字一致',
    diffIndex(imported.out, NAMES_TEXT) === -1,
    '还原后 ' + imported.out.length + ' 字符 / 原文 ' + NAMES_TEXT.length + ' 字符 / 首个差异位置：' +
    diffIndex(imported.out, NAMES_TEXT) + '\n状态行：' + imported.status);
  check('3g 状态行是「已按映射表还原」且标绿',
    /✓ 已按映射表还原/.test(imported.status) && /ok/.test(imported.cls), imported.status);

  // 导入一个不是本工具的文件，要说人话
  const junk = path.join(DL_DIR, 'not-a-map.json');
  fs.writeFileSync(junk, '{"hello":1}', 'utf8');
  await c.send('DOM.setFileInputFiles', { files: [junk], nodeId: q.nodeId });
  await sleep(400);
  const junkStatus = await ev(`document.getElementById('status').textContent`);
  check('3h 导入别的 json 会被挡下并说明原因', /✗/.test(junkStatus) && /map/.test(junkStatus), junkStatus);

  // ------------------------------------------------ 手机竖屏
  console.log('\n[4] 手机竖屏 390×844：四个按钮不挤爆');
  await c.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  loaded = waitLoad();
  await c.send('Page.reload');
  await loaded;
  await sleep(400);
  const mob = JSON.parse(await ev(`(() => {
    const r = s => { const e = document.querySelector(s); if (!e) return null; const b = e.getBoundingClientRect();
      return { top: Math.round(b.top), bottom: Math.round(b.bottom), left: Math.round(b.left), right: Math.round(b.right) }; };
    const btns = [].map.call(document.querySelectorAll('.bar button'), b => {
      const q = b.getBoundingClientRect();
      return { t: b.textContent, left: Math.round(q.left), right: Math.round(q.right),
               top: Math.round(q.top), bottom: Math.round(q.bottom) }; });
    return JSON.stringify({ vw: innerWidth, scrollW: document.documentElement.scrollWidth,
      scrollH: document.documentElement.scrollHeight, bar: r('.bar'), btns: btns });
  })()`));
  const overflow = mob.btns.filter(b => b.right > mob.vw || b.left < 0);
  check('4a 390px 下没有横向溢出', mob.scrollW === 390, 'scrollWidth=' + mob.scrollW);
  check('4b 四个按钮都在视口内、没有互相压住', overflow.length === 0 && mob.btns.length === 4,
    mob.btns.map(b => b.t + ' [' + b.left + '→' + b.right + ']').join('  '));
  const rows = [...new Set(mob.btns.map(b => b.top))].length;
  check('4c 按钮换行排列，不重叠', rows >= 1 && rows <= 3, '占 ' + rows + ' 行，状态行 top=' +
    (await ev(`Math.round(document.getElementById('status').getBoundingClientRect().top)`)));

  // 截图对着按钮区滚一下，让「手机竖屏按钮长什么样」也能一眼看到
  await ev(`window.scrollTo(0, Math.max(0, document.querySelector('.bar').getBoundingClientRect().top + window.scrollY - 70))`);
  await sleep(250);
  const shotM = await c.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  fs.writeFileSync(path.join(OUT_DIR, 'v4-mobile.png'), Buffer.from(shotM.data, 'base64'));

  browser.close();
  c.close();
  await fetch(`http://127.0.0.1:${PORT}/json/close/` + target.id).catch(() => {});
  edge.kill();
  await sleep(400);
  // 清掉测试留下的临时文件：下载目录、Edge 的用户数据目录
  for (const dir of [DL_DIR, path.join(__dirname, '.edge-cdp-v4')]) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* Edge 还没退干净，留着 */ }
  }

  console.log('\n  [桌面 1280×800 实测] ' + JSON.stringify(metrics));
  console.log('  [手机 390×844 实测] scrollWidth=' + mob.scrollW + ' scrollHeight=' + mob.scrollH);
  console.log('  [剪贴板授权] ' + granted);

  console.log('\n================================================');
  console.log('通过 ' + PASS.length + ' 项，失败 ' + FAIL.length + ' 项');
  if (FAIL.length) { console.log('失败项：\n  - ' + FAIL.join('\n  - ')); process.exitCode = 1; }
  else console.log('全部通过。');
  console.log('================================================');
}

main().catch(e => { console.error('ERR', e); process.exitCode = 1; });
