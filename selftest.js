// 自测脚本：从 index.html 里抽出真正在页面里跑的那段引擎代码，再跑四项检查。
// 用法：node D:/aa/c2/site/selftest.js
'use strict';
const fs = require('fs');
const path = require('path');

const HTML_PATH = path.join(__dirname, 'index.html');
const html = fs.readFileSync(HTML_PATH, 'utf8');

const BEGIN = '/* ===== ENGINE:BEGIN ===== */';
const END = '/* ===== ENGINE:END ===== */';
const i0 = html.indexOf(BEGIN);
const i1 = html.indexOf(END);
if (i0 < 0 || i1 < 0) { console.error('找不到引擎标记'); process.exit(1); }
const engineSrc = html.slice(i0 + BEGIN.length, i1);

// 在沙箱里执行页面里的原样代码
const sandbox = {};
new Function('exports', engineSrc + '\n;exports.Redactor = Redactor;')(sandbox);
const R = sandbox.Redactor;

const PASS = [];
const FAIL = [];
function check(name, ok, detail) {
  (ok ? PASS : FAIL).push(name);
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name);
  if (detail) console.log('        ' + detail.replace(/\n/g, '\n        '));
}

function diffIndex(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return a.length === b.length ? -1 : n;
}

// ---------------------------------------------------------------- 测试 1
console.log('\n[1] 样例：3 个人名、2 个单位名、1 个手机号、1 个邮箱 → 全部换成占位符');
const S1 = '11 月 3 日下午，北京华信科技有限公司的项目经理把一份带客户名单的故障报告，整段粘进了对话框。\n\n' +
  '报告里提到：张某负责对接，李经理审批，王某复核；对方公司的联系人叫张总。他的邮箱是 zhang.zong@huaxin-tech.com，手机 13800138000。\n\n' +
  '同一份报告还抄送给了深圳前海数据研究院，附件编号 REF-2023-0917，金额 128,000 元。';

const r1 = R.redact(S1);
console.log('  --- 脱敏稿 ---');
console.log(r1.plain.split('\n').map(l => '  | ' + l).join('\n'));
console.log('  --- 占位符 ---');
console.log('  ' + JSON.stringify(r1.map, null, 0).replace(/","/g, '", "'));

const persons = ['张某', '李经理', '王某', '张总'];
const orgs = ['北京华信科技有限公司', '深圳前海数据研究院'];
const missP = persons.filter(p => r1.plain.indexOf(p) >= 0);
const missO = orgs.filter(o => r1.plain.indexOf(o) >= 0);
const phoneGone = r1.plain.indexOf('13800138000') < 0;
const mailGone = r1.plain.indexOf('zhang.zong@huaxin-tech.com') < 0;

check('1a 人名全部被替换（4 个写法）', missP.length === 0, missP.length ? '漏了：' + missP.join('、') : '张某 / 李经理 / 王某 / 张总 均已替换');
check('1b 单位名全部被替换（2 个）', missO.length === 0, missO.length ? '漏了：' + missO.join('、') : '北京华信科技有限公司 / 深圳前海数据研究院 均已替换');
check('1c 手机号被替换', phoneGone);
check('1d 邮箱被替换', mailGone);
check('1e 数字（日期、编号、金额）一个没动',
  r1.plain.indexOf('11 月 3 日') >= 0 && r1.plain.indexOf('REF-2023-0917') >= 0 && r1.plain.indexOf('128,000 元') >= 0,
  '11 月 3 日 / REF-2023-0917 / 128,000 元 原样保留');

// ---------------------------------------------------------------- 测试 2
console.log('\n[2] 点还原 → 逐字回到原文');
const back1 = R.restore(r1.plain, r1.map);
const d1 = diffIndex(back1, S1);
check('2a 还原结果与原文完全一致', d1 === -1,
  d1 === -1 ? '长度 ' + S1.length + ' 字符，逐字相同，差异位置：无' : '第 ' + d1 + ' 个字符起不同');

// 含身份证 + 重复出现的同一单位
const S2 = '身份证号 11010119900307001X，单位：华信科技有限公司。华信科技有限公司的联系人还是张某。';
const r2 = R.redact(S2);
const back2 = R.restore(r2.plain, r2.map);
console.log('  额外样例脱敏后：' + r2.plain);
check('2b 身份证号被替换', r2.plain.indexOf('11010119900307001X') < 0);
check('2c 同一单位复用同一编号', (r2.plain.match(/\[单位1\]/g) || []).length === 2);
check('2d 额外样例也能逐字还原', diffIndex(back2, S2) === -1);

// ---------------------------------------------------------------- 测试 3
console.log('\n[3] 纯英文技术文档 → 一个字都不改');
const S3 = 'According to GB/T 22239-2019 and ISO/IEC 27001:2022, the API gateway must validate\n' +
  'every request before it reaches the backend. See section 4.2.1 for details.\n' +
  'Version 2.0.3 was released on 2023-05-11 by the platform team. Latency budget: 250 ms p99.\n' +
  'Run `kubectl apply -f deploy.yaml` and check the rollout status. TLS 1.3 only.';
const r3 = R.redact(S3);
const d3 = diffIndex(r3.plain, S3);
check('3a 输出与输入逐字相同', d3 === -1,
  d3 === -1 ? '未替换任何字符，命中 0 处' : '第 ' + d3 + ' 个字符起被改动');
check('3b 替换计数为 0', r3.matches === 0);

// 中文正文里夹英文缩写，也不能动
const S3b = '接口按 GB/T 35273 和 ISO 27001 做了改造，API 版本号 2.0.3，缓存 128 MB。';
const r3b = R.redact(S3b);
check('3c 中文夹英文缩写不动', r3b.plain === S3b, r3b.matches === 0 ? '命中 0 处' : '误伤 ' + r3b.matches + ' 处：' + r3b.plain);

// ---------------------------------------------------------------- 测试 4
console.log('\n[4] 断网可用 → 静态自检（页面里没有任何对外请求）');
const networkPatterns = [
  [/https?:\/\//gi, 'http/https 网址'],
  [/<script[^>]+\bsrc=/gi, '外链 script'],
  [/<link[^>]+href=/gi, '外链样式/字体'],
  [/@import/gi, '@import'],
  [/url\(/gi, 'CSS url()'],
  [/\bfetch\s*\(/gi, 'fetch()'],
  [/XMLHttpRequest/gi, 'XMLHttpRequest'],
  [/WebSocket/gi, 'WebSocket'],
  [/sendBeacon/gi, 'sendBeacon'],
  [/<img\b/gi, '<img>'],
  [/<iframe\b/gi, '<iframe>'],
  [/importScripts/gi, 'importScripts'],
  [/navigator\.serviceWorker/gi, 'serviceWorker']
];
let netHits = [];
for (const [re, label] of networkPatterns) {
  const m = html.match(re);
  if (m) netHits.push(label + ' ×' + m.length);
}
check('4a 无任何外链或网络调用', netHits.length === 0, netHits.length ? '发现：' + netHits.join('，') : '14 项扫描全部为 0');
check('4b 有 CSP 兜底（default-src none）', /Content-Security-Policy[^>]*default-src 'none'/.test(html));
check('4c 单文件：无外部文件引用', (html.match(/\bsrc\s*=\s*["'](?!data:)/g) || []).length === 0);
check('4d 页面脚本语法可解析', (() => {
  try {
    const scripts = html.match(/<script>[\s\S]*?<\/script>/g) || [];
    scripts.forEach(s => new Function(s.replace(/^<script>/, '').replace(/<\/script>$/, '')));
    return scripts.length > 0;
  } catch (e) { return false; }
})());
check('4e 只依赖系统字体（无 @font-face）', !/@font-face/.test(html));

// ---------------------------------------------------------------- 汇总
console.log('\n================================================');
console.log('通过 ' + PASS.length + ' 项，失败 ' + FAIL.length + ' 项');
if (FAIL.length) { console.log('失败项：\n  - ' + FAIL.join('\n  - ')); process.exitCode = 1; }
else console.log('全部通过。');
console.log('================================================');
