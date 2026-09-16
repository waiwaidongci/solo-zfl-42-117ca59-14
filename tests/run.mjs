import http from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { chromium } from "playwright";

process.env.LD_LIBRARY_PATH =
  "/tmp/chromelibs/usr/lib/aarch64-linux-gnu:/tmp/chromelibs/lib/aarch64-linux-gnu" +
  (process.env.LD_LIBRARY_PATH ? ":" + process.env.LD_LIBRARY_PATH : "");

const ROOT = "/workspace";
const server = http.createServer(async (req, res) => {
  const path = req.url === "/" ? "/index.html" : decodeURIComponent(req.url.split("?")[0]);
  try {
    const data = await readFile(ROOT + path);
    res.writeHead(200, { "content-type": path.endsWith(".html") ? "text/html; charset=utf-8" : "application/octet-stream" });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end("not found");
  }
});
await new Promise(r => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

let passed = 0;
function assert(cond, msg) {
  if (!cond) throw new Error("断言失败：" + msg);
  passed++;
  console.log("  ✔", msg);
}
async function shot(page, name) {
  try { await page.screenshot({ path: `/tmp/zfl-fail-${name}.png`, fullPage: true }); } catch {}
}
async function toastText(page, re) {
  await page.waitForFunction(({ source, flags }) => {
    const el = document.querySelector("#toast");
    return el.classList.contains("show") && new RegExp(source, flags).test(el.textContent);
  }, { source: re.source, flags: re.flags || "" }, { timeout: 8000 });
  return page.locator("#toast").textContent();
}
const getState = page => page.evaluate(() => JSON.parse(JSON.stringify(window.ZFL.state)));
const certBy = (st, id) => st.certs.find(c => c.certId === id);
const holdersOf = (st, id) => certBy(st, id).holders.map(h => `${h.name}:${h.share}`).sort().join(",");
const sumOf = (st, id) => certBy(st, id).holders.reduce((a, h) => a + h.share, 0);

const browser = await chromium.launch();
let scenario = "init";
try {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const pageErrors = [];
  page.on("pageerror", e => pageErrors.push(e.message));

  /* ---------- S0 页面加载与哈希自检 ---------- */
  scenario = "S0-加载";
  await page.goto(base, { waitUntil: "load" });
  assert(await page.evaluate(() => window.ZFL.sha256Hex("abc")) === "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", "页面内 SHA-256 自检通过（abc）");
  assert(await page.evaluate(() => window.ZFL.sha256Hex("漆线雕")) === "9ad4bd68724234f74a4d989276b853c97a141841eabccb865f55bb8a9967ec7b", "页面内 SHA-256 中文向量自检通过");
  const seedWorks = (await getState(page)).works.length;
  assert(seedWorks === 4, `种子作品 4 件（实际 ${seedWorks}）`);
  assert(await page.locator("#issuableList .item").count() === 1, "可签发列表含 1 件待交付作品（麒麟献瑞）");

  /* ---------- S1 签发证书（含共有份额） ---------- */
  scenario = "S1-签发";
  await page.fill("#operatorInput", "工坊主");
  await page.locator("#issuableList .item:has-text('麒麟献瑞') button").click();
  await page.waitForSelector("#issueDialog[open]");
  let rows = page.locator("#holderRows .holder-row");
  await rows.nth(0).locator(".h-name").fill("张三");
  await rows.nth(0).locator(".h-share").fill("60");
  await page.click("#addHolderRow");
  rows = page.locator("#holderRows .holder-row");
  await rows.nth(1).locator(".h-name").fill("李四");
  await rows.nth(1).locator(".h-share").fill("40");
  await page.click("#confirmIssue");
  let txt = await toastText(page, /证书已签发：ZFL-\d{4}-0001/);
  assert(/证书已签发：ZFL-\d{4}-0001/.test(txt), `签发成功 toast：${txt}`);
  const certA = "ZFL-2026-0001";
  let st = await getState(page);
  assert(certBy(st, certA).status === "active", "证书 A 状态有效");
  assert(holdersOf(st, certA) === "张三:60,李四:40", "证书 A 共有人 张三60%/李四40%");
  assert(certBy(st, certA).fingerprint.length === 64 && certBy(st, certA).seal.length === 64, "指纹与签章已生成");
  assert(st.audit.length === 1 && st.audit[0].action === "签发证书", "台账记录签发事件");
  assert(await page.locator("#issuableList .item").count() === 0, "签发后作品从可签发列表移除");
  const dup = await page.evaluate(id => window.ZFL.txIssue(id, [{ name: "甲", share: 100 }]), st.works.find(w => w.theme === "麒麟献瑞").id);
  assert(!dup.ok && /不能覆盖|已有有效证书/.test(dup.error), `重复签发被拒绝：${dup.error}`);
  assert(await page.evaluate(id => window.ZFL.verifyCert(id).authentic, certA), "证书 A 校验为真");

  /* ---------- S2 份额校验 + 新增作品直接签发 ---------- */
  scenario = "S2-份额校验";
  await page.locator("#workForm input[name=base]").fill("木胎插屏");
  await page.locator("#workForm input[name=theme]").fill("松鹤延年");
  await page.locator("#workForm select[name=status]").selectOption("待交付");
  await page.locator("#workForm button[type=submit]").click();
  txt = await toastText(page, /作品已加入工坊/);
  assert(/作品已加入工坊/.test(txt), "新增待交付作品成功");
  await page.locator("#issuableList .item:has-text('松鹤延年') button").click();
  await page.waitForSelector("#issueDialog[open]");
  await page.locator("#holderRows .holder-row .h-name").fill("测试员");
  await page.locator("#holderRows .holder-row .h-share").fill("60");
  await page.click("#confirmIssue");
  txt = await toastText(page, /份额合计必须等于 100%/);
  assert(/份额合计必须等于 100%/.test(txt), `份额不足 100% 被拒绝：${txt}`);
  assert(await page.locator("#issueDialog[open]").isVisible(), "校验失败后对话框保持打开且未写入");
  await page.locator("#holderRows .holder-row .h-share").fill("100");
  await page.click("#confirmIssue");
  txt = await toastText(page, /证书已签发：ZFL-\d{4}-0002/);
  assert(/证书已签发：ZFL-\d{4}-0002/.test(txt), `修改后签发成功：${txt}`);
  const certB = "ZFL-2026-0002";
  st = await getState(page);
  assert(st.certs.length === 2 && st.transfers.length === 0, "失败签发未留下任何痕迹（全部不写）");
  assert(await page.evaluate(id => window.ZFL.verifyCert(id).authentic, certB), "证书 B 校验为真");

  /* ---------- S3 转移：越权拒绝、确认生效、重复确认拒绝 ---------- */
  scenario = "S3-转移确认";
  await page.fill("#operatorInput", "张三");
  await page.locator(`.cert[data-cert="${certA}"] >> button:has-text("发起转移")`).click();
  await page.waitForSelector("#transferDialog[open]");
  await page.selectOption("#tFrom", "张三");
  await page.fill("#tTo", "王五");
  await page.fill("#tShare", "30");
  await page.click("#submitTransfer");
  txt = await toastText(page, /待 王五 确认/);
  assert(/待 王五 确认/.test(txt), `转移单已提交：${txt}`);
  st = await getState(page);
  const t1 = st.transfers[0].id;
  await page.fill("#operatorInput", "李四");
  await page.locator(`#pendingList .item:has-text("张三 → 王五") >> button:has-text("受让方确认")`).click();
  txt = await toastText(page, /越权操作/);
  assert(/越权操作/.test(txt), `非受让方确认被拒绝：${txt}`);
  st = await getState(page);
  assert(holdersOf(st, certA) === "张三:60,李四:40", "越权确认后份额未变");
  await page.fill("#operatorInput", "王五");
  await page.locator(`#pendingList .item:has-text("张三 → 王五") >> button:has-text("受让方确认")`).click();
  txt = await toastText(page, /转移完成：张三 → 王五 30%/);
  assert(/转移完成：张三 → 王五 30%/.test(txt), `受让方确认成功：${txt}`);
  st = await getState(page);
  assert(holdersOf(st, certA) === "张三:30,李四:40,王五:30", "确认后份额 张三30/李四40/王五30");
  const again = await page.evaluate(id => window.ZFL.txConfirm(id), t1);
  assert(!again.ok && /重复确认|只能变更一次/.test(again.error), `重复确认被拒绝：${again.error}`);
  st = await getState(page);
  assert(holdersOf(st, certA) === "张三:30,李四:40,王五:30" && sumOf(st, certA) === 100, "重复确认后份额未变");

  /* ---------- S4 两页并发：同时提交与同时确认，产权只变更一次 ---------- */
  scenario = "S4-两页并发";
  const page2 = await ctx.newPage();
  await page2.goto(base, { waitUntil: "load" });
  await page.evaluate(n => window.ZFL.setOperator(n), "张三");
  await page2.evaluate(n => window.ZFL.setOperator(n), "张三");
  const initArgs = [certA, "张三", "赵六", 30];
  const initResults = await Promise.all([
    page.evaluate(a => window.ZFL.txInitiate(a[0], a[1], a[2], a[3], "普通转让", ""), initArgs),
    page2.evaluate(a => window.ZFL.txInitiate(a[0], a[1], a[2], a[3], "普通转让", ""), initArgs)
  ]);
  const initOk = initResults.filter(r => r.ok);
  const initRej = initResults.find(r => !r.ok);
  assert(initOk.length === 1, `两页同时提交转移单，仅 1 笔成功（另一笔：${initRej ? initRej.error : "无"}）`);
  st = await getState(page);
  const pendings = st.transfers.filter(t => t.state === "pending" && t.to === "赵六");
  assert(pendings.length === 1, "待确认转移单只有 1 笔（无重复提交）");
  const t2 = pendings[0].id;
  await page.evaluate(n => window.ZFL.setOperator(n), "赵六");
  await page2.evaluate(n => window.ZFL.setOperator(n), "赵六");
  const confResults = await Promise.all([
    page.evaluate(id => window.ZFL.txConfirm(id), t2),
    page2.evaluate(id => window.ZFL.txConfirm(id), t2)
  ]);
  const confOk = confResults.filter(r => r.ok);
  const confRej = confResults.find(r => !r.ok);
  assert(confOk.length === 1, `两页同时确认，仅 1 次生效（另一次：${confRej ? confRej.error : "无"}）`);
  st = await getState(page);
  assert(st.audit.filter(a => a.action === "转移确认" && a.detail.transferId === t2).length === 1, "台账中该转移确认仅记录一次");
  assert(holdersOf(st, certA) === "李四:40,王五:30,赵六:30" && sumOf(st, certA) === 100, "产权只变更一次：张三退出，赵六 30%");
  await page2.close();

  /* ---------- S5 共有份额分别转移（含继承过户） ---------- */
  scenario = "S5-共有分别转移";
  await page.evaluate(n => window.ZFL.setOperator(n), "李四");
  const i1 = await page.evaluate(a => window.ZFL.txInitiate(a[0], a[1], a[2], a[3], "普通转让", "买卖合同2026-09"), [certA, "李四", "钱七", 20]);
  assert(i1.ok, "李四发起 20% 转移");
  await page.evaluate(n => window.ZFL.setOperator(n), "王五");
  const i2 = await page.evaluate(a => window.ZFL.txInitiate(a[0], a[1], a[2], a[3], "继承过户", "继承公证书(2026)闽证字第001号"), [certA, "王五", "孙八", 10]);
  assert(i2.ok, "王五发起 10% 继承过户");
  st = await getState(page);
  assert(st.transfers.filter(t => t.state === "pending").length === 2, "两笔不同份额的转移单可同时待确认");
  await page.evaluate(n => window.ZFL.setOperator(n), "钱七");
  const c1 = await page.evaluate(id => window.ZFL.txConfirm(id), i1.result.id);
  assert(c1.ok, "钱七确认受让 20%");
  await page.evaluate(n => window.ZFL.setOperator(n), "孙八");
  const c2 = await page.evaluate(id => window.ZFL.txConfirm(id), i2.result.id);
  assert(c2.ok, "孙八确认继承 10%");
  st = await getState(page);
  assert(holdersOf(st, certA) === "孙八:10,李四:20,王五:20,赵六:30,钱七:20" && sumOf(st, certA) === 100, "共有份额分别转移完成，合计仍为 100%");
  assert(st.audit.some(a => a.action === "继承过户完成"), "继承过户已留痕");

  /* ---------- S6 质押冻结：冻结拒绝一切转移，解冻恢复 ---------- */
  scenario = "S6-质押冻结";
  await page.evaluate(n => window.ZFL.setOperator(n), "赵六");
  const i3 = await page.evaluate(a => window.ZFL.txInitiate(a[0], a[1], a[2], a[3], "普通转让", ""), [certA, "赵六", "周九", 5]);
  assert(i3.ok, "冻结前发起赵六→周九 5% 转移单");
  await page.evaluate(n => window.ZFL.setOperator(n), "工坊主");
  const badFreeze = await page.evaluate(a => window.ZFL.txFreeze(a[0], "某银行", "贷款"), [certA]);
  assert(!badFreeze.ok && /越权操作/.test(badFreeze.error), `非持有人质押被拒绝：${badFreeze.error}`);
  await page.evaluate(n => window.ZFL.setOperator(n), "李四");
  await page.locator(`.cert[data-cert="${certA}"] >> button:has-text("质押冻结")`).click();
  await page.waitForSelector("#freezeDialog[open]");
  await page.fill("#fPledgee", "平安银行");
  await page.fill("#fReason", "经营贷款质押");
  await page.click("#submitFreeze");
  txt = await toastText(page, /已质押冻结/);
  assert(/已质押冻结/.test(txt), "持有人办理质押冻结成功");
  assert(await page.locator(`.cert[data-cert="${certA}"] .badge.frozen`).isVisible(), "证书卡片显示质押冻结徽标");
  await page.evaluate(n => window.ZFL.setOperator(n), "周九");
  const frozenConfirm = await page.evaluate(id => window.ZFL.txConfirm(id), i3.result.id);
  assert(!frozenConfirm.ok && /冻结/.test(frozenConfirm.error), `冻结期间确认被拒绝：${frozenConfirm.error}`);
  await page.evaluate(n => window.ZFL.setOperator(n), "赵六");
  const frozenInit = await page.evaluate(a => window.ZFL.txInitiate(a[0], a[1], a[2], a[3], "普通转让", ""), [certA, "赵六", "周九", 5]);
  assert(!frozenInit.ok && /冻结/.test(frozenInit.error), `冻结期间发起转移被拒绝：${frozenInit.error}`);
  st = await getState(page);
  assert(holdersOf(st, certA) === "孙八:10,李四:20,王五:20,赵六:30,钱七:20", "冻结期间份额未发生任何变化");
  await page.evaluate(n => window.ZFL.setOperator(n), "李四");
  await page.locator(`.cert[data-cert="${certA}"] >> button:has-text("解除冻结")`).click();
  txt = await toastText(page, /已解除质押冻结/);
  assert(/已解除质押冻结/.test(txt), "解除冻结成功");
  await page.evaluate(n => window.ZFL.setOperator(n), "周九");
  const okConfirm = await page.evaluate(id => window.ZFL.txConfirm(id), i3.result.id);
  assert(okConfirm.ok, "解冻后转移单确认成功");
  st = await getState(page);
  assert(holdersOf(st, certA) === "周九:5,孙八:10,李四:20,王五:20,赵六:25,钱七:20" && sumOf(st, certA) === 100, "解冻后份额正确变更");
  assert(st.audit.some(a => a.action === "质押冻结") && st.audit.some(a => a.action === "解除冻结"), "质押冻结与解冻均留痕");

  /* ---------- S7 撤销与重签 ---------- */
  scenario = "S7-撤销重签";
  await page.evaluate(n => window.ZFL.setOperator(n), "李四");
  await page.locator(`.cert[data-cert="${certA}"] >> button:has-text("撤销证书")`).click();
  await page.waitForSelector("#revokeDialog[open]");
  await page.fill("#rReason", "持有人信息登记错误");
  await page.click("#submitRevoke");
  txt = await toastText(page, /证书已撤销/);
  assert(/证书已撤销/.test(txt), "证书撤销成功");
  assert(await page.locator(`.cert[data-cert="${certA}"] .badge.revoked`).isVisible(), "证书卡片显示已撤销徽标");
  const revokedInit = await page.evaluate(a => window.ZFL.txInitiate(a[0], a[1], a[2], a[3], "普通转让", ""), [certA, "李四", "吴十", 5]);
  assert(!revokedInit.ok && /撤销/.test(revokedInit.error), `已撤销证书禁止转移：${revokedInit.error}`);
  await page.locator(`.cert[data-cert="${certA}"] >> button:has-text("重签证书")`).click();
  txt = await toastText(page, /已重签新证书：ZFL-\d{4}-\d{4}/);
  const m = txt.match(/已重签新证书：(ZFL-\d{4}-\d{4})/);
  assert(m, `重签成功：${txt}`);
  const certA2 = m[1];
  st = await getState(page);
  assert(certBy(st, certA2).status === "active" && certBy(st, certA2).supersedes === certA, "新证书承接旧证书并标记来源");
  assert(holdersOf(st, certA2) === "周九:5,孙八:10,李四:20,王五:20,赵六:25,钱七:20", "重签后持有人与原证书一致");
  assert(certBy(st, certA).status === "revoked", "旧证书保留为已撤销状态");
  await page.fill("#verifyInput", certA);
  await page.click("#verifyBtn");
  await page.waitForSelector("#verifyDialog[open]");
  let vtxt = await page.locator("#verifyResult").textContent();
  assert(/校验通过：真实证书/.test(vtxt) && /已撤销/.test(vtxt), "历史（已撤销）证书仍可校验为真");
  await page.click("#closeVerify");
  await page.fill("#verifyInput", certA2);
  await page.click("#verifyBtn");
  await page.waitForSelector("#verifyDialog[open]");
  vtxt = await page.locator("#verifyResult").textContent();
  assert(/校验通过：真实证书/.test(vtxt) && /有效/.test(vtxt), "重签新证书校验为真且状态有效");
  await page.click("#closeVerify");

  /* ---------- S8 篡改校验：改存储即判伪，台账链可验 ---------- */
  scenario = "S8-篡改校验";
  const snapshot = await page.evaluate(() => localStorage.getItem("zfl42State"));
  await page.evaluate(cid => {
    const s = JSON.parse(localStorage.getItem("zfl42State"));
    s.certs.find(c => c.certId === cid).holders[0].name = "篡改者";
    localStorage.setItem("zfl42State", JSON.stringify(s));
  }, certA2);
  await page.reload({ waitUntil: "load" });
  await page.locator(`.cert[data-cert="${certA2}"] >> button:has-text("校验")`).click();
  await page.waitForSelector("#verifyDialog[open]");
  vtxt = await page.locator("#verifyResult").textContent();
  assert(/校验未通过/.test(vtxt) && /持有人与产权台账回放结果不符/.test(vtxt), "篡改持有人被判为伪证书");
  await page.click("#closeVerify");
  await page.evaluate(() => {
    const s = JSON.parse(localStorage.getItem("zfl42State"));
    s.audit[1].actor = "黑客";
    localStorage.setItem("zfl42State", JSON.stringify(s));
  });
  await page.reload({ waitUntil: "load" });
  await page.click("#verifyChainBtn");
  txt = await toastText(page, /台账链第 \d+ 条记录起被篡改/);
  assert(/台账链第 \d+ 条记录起被篡改/.test(txt), `篡改台账记录被链式校验发现：${txt}`);
  await page.evaluate(snap => localStorage.setItem("zfl42State", snap), snapshot);
  await page.reload({ waitUntil: "load" });
  await page.click("#verifyChainBtn");
  txt = await toastText(page, /台账链完整/);
  assert(/台账链完整/.test(txt), "恢复原始数据后台账链重新校验完整");
  assert(await page.evaluate(() => window.ZFL.verifyAll().badCerts.length === 0), "恢复后全部证书校验为真");

  /* ---------- S9 旧数据补发（迁移 + 历史不重算） ---------- */
  scenario = "S9-旧数据补发";
  const ctx2 = await browser.newContext();
  await ctx2.addInitScript(() => {
    localStorage.setItem("zfl42Works", JSON.stringify([
      { id: "old-1", base: "脱胎观音", theme: "童子拜观音", line: "细线", progress: 100, dryDate: "2025-12-01", gold: "已上金粉", defect: "", delivery: "2026-01-15", status: "待交付", note: "老客户回购", logs: ["2025-11-20 创建作品", "2026-01-15 交付"] }
    ]));
  });
  const page3 = await ctx2.newPage();
  await page3.goto(base, { waitUntil: "load" });
  const migrated = await getState(page3);
  assert(migrated.works.length === 1 && migrated.works[0].legacy === true, "旧格式数据已迁移并标记为旧作品");
  assert(await page3.evaluate(() => localStorage.getItem("zfl42Works") === null && !!localStorage.getItem("zfl42State")), "旧存储键已迁移至统一状态");
  assert(await page3.locator("#issuableList .item:has-text('童子拜观音') >> button:has-text('补发证书')").isVisible(), "旧已交付作品显示补发入口");
  await page3.locator("#issuableList .item:has-text('童子拜观音') button").click();
  await page3.waitForSelector("#issueDialog[open]");
  assert(/补发防伪证书/.test(await page3.locator("#issueTitle").textContent()), "补发对话框标题正确");
  await page3.locator("#holderRows .holder-row .h-name").fill("林传承人");
  await page3.locator("#holderRows .holder-row .h-share").fill("100");
  await page3.click("#confirmIssue");
  txt = await toastText(page3, /证书已签发：ZFL-\d{4}-0001/);
  assert(/证书已签发：ZFL-\d{4}-0001/.test(txt), `旧作品补发成功：${txt}`);
  const st3 = await getState(page3);
  const oldCert = st3.certs[0];
  assert(oldCert.backfilled === true, "补发证书带有补发标记");
  assert(oldCert.features.delivery === "2026-01-15" && oldCert.features.dryDate === "2025-12-01", "补发绑定作品原始特征，历史日期不重算");
  const logs = st3.works[0].logs;
  assert(logs[0] === "2025-11-20 创建作品" && logs[1] === "2026-01-15 交付" && logs.length === 3, "作品原始历史日志完整保留，仅追加补发记录");
  assert(st3.audit.length === 1 && st3.audit[0].action === "补发证书", "补发事件已入台账");
  assert(await page3.evaluate(() => window.ZFL.verifyAll().badCerts.length === 0), "补发证书校验为真");
  await ctx2.close();

  /* ---------- S10 刷新 / 导出 / 恢复一致性 ---------- */
  scenario = "S10-刷新导出恢复";
  await page.reload({ waitUntil: "load" });
  st = await getState(page);
  assert(st.certs.length === 3 && holdersOf(st, certA2) === "周九:5,孙八:10,李四:20,王五:20,赵六:25,钱七:20", "刷新后证书与产权保持一致");
  const auditLen = st.audit.length;
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.click("#exportBtn")
  ]);
  const dlPath = await download.path();
  const exported = JSON.parse(await readFile(dlPath, "utf8"));
  assert(exported.app === "zfl42" && exported.state.certs.length === 3 && exported.state.audit.length === auditLen, "导出包含完整作品、证书与台账");
  const ctx3 = await browser.newContext();
  const page4 = await ctx3.newPage();
  await page4.goto(base, { waitUntil: "load" });
  await page4.setInputFiles("#importFile", dlPath);
  txt = await toastText(page4, /导入完成/);
  assert(/导入完成/.test(txt) && /台账链完整/.test(txt), `导入恢复成功：${txt}`);
  const st4 = await getState(page4);
  assert(st4.certs.length === 3 && st4.works.length === st.works.length, "恢复后作品与证书数量一致");
  assert(holdersOf(st4, certA2) === holdersOf(st, certA2) && holdersOf(st4, certA) === holdersOf(st, certA), "恢复后各证书持有人一致");
  assert(st4.audit.length === auditLen + 1 && st4.audit[st4.audit.length - 1].action === "导入恢复", "恢复事件追加台账且历史未重算");
  assert(await page4.evaluate(() => window.ZFL.verifyAll().badCerts.length === 0), "恢复后全部证书校验为真");
  assert(JSON.stringify(st4.certs.map(c => [c.certId, c.seal])) === JSON.stringify(st.certs.map(c => [c.certId, c.seal])), "恢复后证书签章与导出前完全一致");
  await ctx3.close();

  /* ---------- S11 销毁授权边界：撤销/重签仅当前持有人可执行 ---------- */
  scenario = "S11-销毁授权边界";
  const ctx4 = await browser.newContext();
  const page5 = await ctx4.newPage();
  await page5.goto(base, { waitUntil: "load" });
  const snap5 = () => page5.evaluate(() => localStorage.getItem("zfl42State"));
  await page5.evaluate(() => window.ZFL.setOperator("工坊主"));
  const wid5 = await page5.evaluate(() => window.ZFL.state.works.find(w => w.status === "待交付").id);
  const iss5 = await page5.evaluate(id => window.ZFL.txIssue(id, [{ name: "张三", share: 60 }, { name: "李四", share: 40 }]), wid5);
  assert(iss5.ok, "准备：证书签发成功（张三60/李四40）");
  const cid5 = iss5.result.certId;
  // 攻击者（非持有人）通过界面尝试撤销
  await page5.evaluate(() => window.ZFL.setOperator("路人甲"));
  let before5 = await snap5();
  await page5.locator(`#certList .cert[data-cert="${cid5}"] >> button:has-text("撤销证书")`).click();
  await page5.waitForSelector("#revokeDialog[open]");
  await page5.fill("#rReason", "恶意销毁");
  await page5.click("#submitRevoke");
  txt = await toastText(page5, /越权操作/);
  assert(/越权操作：只有当前持有人可以撤销证书/.test(txt), `攻击者撤销被拒绝：${txt}`);
  await page5.click("#cancelRevoke");
  assert(await snap5() === before5, "拒绝后证书状态与台账不变（攻击者撤销）");
  assert(await page5.locator(`#certList .cert[data-cert="${cid5}"] .badge:not(.revoked)`).isVisible(), "证书仍为有效状态");
  // 张三转走全部份额，成为已无份额的原持有人
  await page5.evaluate(() => window.ZFL.setOperator("张三"));
  const it5 = await page5.evaluate(c => window.ZFL.txInitiate(c, "张三", "王五", 60, "普通转让", ""), cid5);
  assert(it5.ok, "准备：张三转出全部 60% 份额");
  await page5.evaluate(() => window.ZFL.setOperator("王五"));
  assert((await page5.evaluate(t => window.ZFL.txConfirm(t), it5.result.id)).ok, "准备：王五确认受让");
  await page5.evaluate(() => window.ZFL.setOperator("张三"));
  before5 = await snap5();
  let r5 = await page5.evaluate(c => window.ZFL.txRevoke(c, "报复性销毁"), cid5);
  assert(!r5.ok && /越权操作/.test(r5.error), `已无份额的原持有人撤销被拒绝：${r5.error}`);
  assert(await snap5() === before5, "拒绝后证书状态与台账不变（无份额主体）");
  // 冻结中禁止撤销与重签
  await page5.evaluate(() => window.ZFL.setOperator("李四"));
  assert((await page5.evaluate(c => window.ZFL.txFreeze(c, "平安银行", "贷款质押"), cid5)).ok, "准备：持有人质押冻结成功");
  before5 = await snap5();
  r5 = await page5.evaluate(c => window.ZFL.txRevoke(c, "冻结中销毁"), cid5);
  assert(!r5.ok && /冻结/.test(r5.error), `冻结中撤销被拒绝：${r5.error}`);
  let r6 = await page5.evaluate(c => window.ZFL.txReissue(c), cid5);
  assert(!r6.ok && /仅已撤销/.test(r6.error), `冻结中重签被拒绝：${r6.error}`);
  assert(await snap5() === before5, "拒绝后证书状态与台账不变（冻结中）");
  // 解冻 → 持有人撤销成功 → 非持有人重签被拒 → 持有人重签成功
  assert((await page5.evaluate(c => window.ZFL.txUnfreeze(c), cid5)).ok, "解冻成功");
  r5 = await page5.evaluate(c => window.ZFL.txRevoke(c, "登记信息错误"), cid5);
  assert(r5.ok, "当前持有人撤销成功");
  await page5.evaluate(() => window.ZFL.setOperator("路人甲"));
  before5 = await snap5();
  r5 = await page5.evaluate(c => window.ZFL.txReissue(c), cid5);
  assert(!r5.ok && /越权操作/.test(r5.error), `非持有人重签被拒绝：${r5.error}`);
  assert(await snap5() === before5, "拒绝后证书状态与台账不变（非持有人重签）");
  await page5.evaluate(() => window.ZFL.setOperator("王五"));
  r5 = await page5.evaluate(c => window.ZFL.txReissue(c), cid5);
  assert(r5.ok, "当前持有人重签成功");
  const st5 = await page5.evaluate(() => JSON.parse(JSON.stringify(window.ZFL.state)));
  assert(st5.audit.filter(a => a.action === "撤销证书").length === 1, "台账中仅有一次成功撤销记录（被拒绝的尝试未留痕）");
  assert(st5.audit.filter(a => a.action === "撤销重签").length === 1, "台账中仅有一次成功重签记录");
  assert(await page5.evaluate(() => window.ZFL.verifyAll().badCerts.length === 0), "全部证书校验为真");
  await ctx4.close();

  /* ---------- S12 导入校验：先校验后恢复，异常导入零影响 ---------- */
  scenario = "S12-导入校验";
  const ctx5 = await browser.newContext();
  const page6 = await ctx5.newPage();
  await page6.goto(base, { waitUntil: "load" });
  await page6.evaluate(() => window.ZFL.setOperator("工坊主"));
  const wid6 = await page6.evaluate(() => window.ZFL.state.works.find(w => w.status === "待交付").id);
  const iss6 = await page6.evaluate(id => window.ZFL.txIssue(id, [{ name: "张三", share: 100 }]), wid6);
  assert(iss6.ok, "准备：签发成功");
  const [dl6] = await Promise.all([page6.waitForEvent("download"), page6.click("#exportBtn")]);
  const validPath = await dl6.path();
  const validJson = JSON.parse(await readFile(validPath, "utf8"));
  const clone = () => JSON.parse(JSON.stringify(validJson));
  const stateStr = () => page6.evaluate(() => localStorage.getItem("zfl42State"));
  async function badImport(obj, re, label) {
    const p = `/tmp/zfl-bad-${label}.json`;
    await writeFile(p, JSON.stringify(obj));
    const before = await stateStr();
    await page6.setInputFiles("#importFile", p);
    const t = await toastText(page6, re);
    assert(re.test(t), `${label}被拒绝：${t}`);
    assert(await stateStr() === before, `${label}后作品、证书、转移单与台账保持原样`);
  }
  await badImport({ app: "zfl42", state: { works: [], certs: "x", transfers: [], audit: [], meta: { certSeq: 0 } } }, /导入失败：备份格式不正确/, "格式错误");
  await badImport({ app: "fake", state: validJson.state }, /导入失败：文件格式不正确/, "非法文件标识");
  const tamperAudit = clone();
  tamperAudit.state.audit[0].actor = "黑客";
  await badImport(tamperAudit, /导入失败：台账哈希链第 \d+ 条记录起被篡改/, "台账链篡改");
  const tamperCert = clone();
  tamperCert.state.certs[0].features.theme = "赝品";
  await badImport(tamperCert, /导入失败：证书 ZFL-\d{4}-\d{4} 特征指纹校验失败/, "证书特征篡改");
  const tamperOwner = clone();
  tamperOwner.state.certs[0].holders = [{ name: "篡改者", share: 100 }];
  await badImport(tamperOwner, /导入失败：证书 ZFL-\d{4}-\d{4} 的产权人与台账回放不符/, "产权关系篡改");
  // 正常导入
  await page6.setInputFiles("#importFile", validPath);
  txt = await toastText(page6, /导入完成：作品 \d+ · 证书 \d+，台账链完整/);
  assert(/导入完成/.test(txt), `正常备份导入成功：${txt}`);
  const st6 = await page6.evaluate(() => JSON.parse(JSON.stringify(window.ZFL.state)));
  assert(st6.certs.length === validJson.state.certs.length && st6.works.length === validJson.state.works.length, "恢复后作品与证书数量一致");
  assert(st6.audit.length === validJson.state.audit.length + 1 && st6.audit[st6.audit.length - 1].action === "导入恢复", "恢复事件追加台账且历史不变");
  assert(await page6.evaluate(() => window.ZFL.verifyAll().badCerts.length === 0), "恢复后全部证书校验为真");
  await ctx5.close();

  /* ---------- S13 转移单台账回放：防改回待确认与字段篡改 ---------- */
  scenario = "S13-转移单回放校验";
  const ctx6 = await browser.newContext();
  const page7 = await ctx6.newPage();
  await page7.goto(base, { waitUntil: "load" });
  await page7.evaluate(() => window.ZFL.setOperator("工坊主"));
  const widA = await page7.evaluate(() => window.ZFL.state.works.find(w => w.status === "待交付").id);
  const issA = await page7.evaluate(id => window.ZFL.txIssue(id, [{ name: "张三", share: 100 }]), widA);
  const certA13 = issA.result.certId;
  await page7.evaluate(() => window.ZFL.setOperator("张三"));
  const t13a = (await page7.evaluate(c => window.ZFL.txInitiate(c, "张三", "李四", 40, "普通转让", ""), certA13)).result.id;
  await page7.evaluate(() => window.ZFL.setOperator("李四"));
  assert((await page7.evaluate(t => window.ZFL.txConfirm(t), t13a)).ok, "准备：转移单 t13a 已确认");
  await page7.evaluate(() => window.ZFL.setOperator("张三"));
  const t13b = (await page7.evaluate(c => window.ZFL.txInitiate(c, "张三", "王五", 20, "普通转让", ""), certA13)).result.id;
  const t13c = (await page7.evaluate(c => window.ZFL.txInitiate(c, "张三", "赵六", 10, "普通转让", ""), certA13)).result.id;
  assert((await page7.evaluate(t => window.ZFL.txCancelTransfer(t), t13c)).ok, "准备：转移单 t13c 已撤销");
  await page7.locator("#workForm input[name=base]").fill("木胎插屏");
  await page7.locator("#workForm input[name=theme]").fill("松鹤延年");
  await page7.locator("#workForm select[name=status]").selectOption("待交付");
  await page7.locator("#workForm button[type=submit]").click();
  await toastText(page7, /作品已加入工坊/);
  const widB = await page7.evaluate(() => window.ZFL.state.works.find(w => w.theme === "松鹤延年").id);
  const issB = await page7.evaluate(id => window.ZFL.txIssue(id, [{ name: "孙八", share: 100 }]), widB);
  const certB13 = issB.result.certId;
  await page7.evaluate(() => window.ZFL.setOperator("孙八"));
  const t13d = (await page7.evaluate(c => window.ZFL.txInitiate(c, "孙八", "钱七", 30, "普通转让", ""), certB13)).result.id;
  assert((await page7.evaluate(c => window.ZFL.txRevoke(c, "信息登记错误"), certB13)).ok, "准备：证书 B 撤销，转移单 t13d 失效");
  const [dl7] = await Promise.all([page7.waitForEvent("download"), page7.click("#exportBtn")]);
  const valid7Path = await dl7.path();
  const valid7 = JSON.parse(await readFile(valid7Path, "utf8"));
  const clone7 = () => JSON.parse(JSON.stringify(valid7));
  const stateStr7 = () => page7.evaluate(() => localStorage.getItem("zfl42State"));
  async function badImport7(obj, re, label) {
    const p = `/tmp/zfl-bad13-${label}.json`;
    await writeFile(p, JSON.stringify(obj));
    const before = await stateStr7();
    await page7.setInputFiles("#importFile", p);
    const t = await toastText(page7, re);
    assert(re.test(t), `${label}被拒绝：${t}`);
    assert(await stateStr7() === before, `${label}后作品、证书、转移单与台账保持原样`);
  }
  const backToPending = clone7();
  delete backToPending.state.transfers.find(t => t.id === t13a).confirmedAt;
  backToPending.state.transfers.find(t => t.id === t13a).state = "pending";
  await badImport7(backToPending, /导入失败：转移单 .* 的状态与台账回放不符/, "已确认改回待确认");
  const rejToPending = clone7();
  delete rejToPending.state.transfers.find(t => t.id === t13d).rejectedReason;
  rejToPending.state.transfers.find(t => t.id === t13d).state = "pending";
  await badImport7(rejToPending, /导入失败：转移单 .* 的状态与台账回放不符/, "已失效改回待确认");
  const badFrom = clone7();
  badFrom.state.transfers.find(t => t.id === t13a).from = "黑客";
  await badImport7(badFrom, /导入失败：转移单 .* 的来源、受让方、份额或类型与台账不符/, "篡改转让人");
  const badTo = clone7();
  badTo.state.transfers.find(t => t.id === t13a).to = "黑客";
  await badImport7(badTo, /导入失败：转移单 .* 的来源、受让方、份额或类型与台账不符/, "篡改受让方");
  const badShare = clone7();
  badShare.state.transfers.find(t => t.id === t13a).share = 99;
  await badImport7(badShare, /导入失败：转移单 .* 的来源、受让方、份额或类型与台账不符/, "篡改份额");
  // 正常恢复
  await page7.setInputFiles("#importFile", valid7Path);
  txt = await toastText(page7, /导入完成：作品 \d+ · 证书 \d+，台账链完整/);
  assert(/导入完成/.test(txt), `正常恢复成功：${txt}`);
  const reconfirm = await page7.evaluate(t => window.ZFL.txConfirm(t), t13a);
  assert(!reconfirm.ok && /重复确认|只能变更一次/.test(reconfirm.error), `恢复后已确认转移单再确认被拒绝：${reconfirm.error}`);
  let st7 = await page7.evaluate(() => JSON.parse(JSON.stringify(window.ZFL.state)));
  assert(holdersOf(st7, certA13) === "张三:60,李四:40", "恢复后证书持有人未被重复确认改变");
  const rejConfirm = await page7.evaluate(t => window.ZFL.txConfirm(t), t13d);
  assert(!rejConfirm.ok && /失效|不能确认/.test(rejConfirm.error), `恢复后失效转移单确认被拒绝：${rejConfirm.error}`);
  await page7.evaluate(() => window.ZFL.setOperator("王五"));
  assert((await page7.evaluate(t => window.ZFL.txConfirm(t), t13b)).ok, "恢复后正常待确认转移单仍可按流程确认");
  st7 = await page7.evaluate(() => JSON.parse(JSON.stringify(window.ZFL.state)));
  assert(holdersOf(st7, certA13) === "张三:40,李四:40,王五:20", "确认后份额正确（张三40/李四40/王五20）");
  await page7.reload({ waitUntil: "load" });
  st7 = await page7.evaluate(() => JSON.parse(JSON.stringify(window.ZFL.state)));
  assert(holdersOf(st7, certA13) === "张三:40,李四:40,王五:20" && st7.transfers.find(t => t.id === t13a).state === "confirmed", "刷新后转移单状态与产权保持一致");
  assert(await page7.evaluate(() => window.ZFL.verifyAll().badCerts.length === 0), "刷新后全部证书校验为真");
  await ctx6.close();

  /* ---------- S14 转移单改挂证书：绑定一致性 ---------- */
  scenario = "S14-转移单改挂证书";
  const ctx7 = await browser.newContext();
  const page8 = await ctx7.newPage();
  await page8.goto(base, { waitUntil: "load" });
  await page8.evaluate(() => window.ZFL.setOperator("工坊主"));
  const widA8 = await page8.evaluate(() => window.ZFL.state.works.find(w => w.status === "待交付").id);
  const issA8 = await page8.evaluate(id => window.ZFL.txIssue(id, [{ name: "张三", share: 100 }]), widA8);
  const certA8 = issA8.result.certId;
  await page8.locator("#workForm input[name=base]").fill("木胎插屏");
  await page8.locator("#workForm input[name=theme]").fill("松鹤延年");
  await page8.locator("#workForm select[name=status]").selectOption("待交付");
  await page8.locator("#workForm button[type=submit]").click();
  await toastText(page8, /作品已加入工坊/);
  const widB8 = await page8.evaluate(() => window.ZFL.state.works.find(w => w.theme === "松鹤延年").id);
  const issB8 = await page8.evaluate(id => window.ZFL.txIssue(id, [{ name: "张三", share: 100 }]), widB8);
  const certB8 = issB8.result.certId;
  assert(certA8 !== certB8, "准备：两张同名持有人（张三）的证书");
  await page8.evaluate(() => window.ZFL.setOperator("张三"));
  const tA8 = (await page8.evaluate(c => window.ZFL.txInitiate(c, "张三", "李四", 40, "普通转让", ""), certA8)).result.id;
  const [dl8] = await Promise.all([page8.waitForEvent("download"), page8.click("#exportBtn")]);
  const valid8Path = await dl8.path();
  const valid8 = JSON.parse(await readFile(valid8Path, "utf8"));
  const clone8 = () => JSON.parse(JSON.stringify(valid8));
  const stateStr8 = () => page8.evaluate(() => localStorage.getItem("zfl42State"));
  async function badImport8(obj, re, label) {
    const p = `/tmp/zfl-bad14-${label}.json`;
    await writeFile(p, JSON.stringify(obj));
    const before = await stateStr8();
    await page8.setInputFiles("#importFile", p);
    const t = await toastText(page8, re);
    assert(re.test(t), `${label}被拒绝：${t}`);
    assert(await stateStr8() === before, `${label}后作品、证书、转移单与台账保持原样`);
  }
  const rebind = clone8();
  rebind.state.transfers.find(t => t.id === tA8).certId = certB8;
  await badImport8(rebind, /导入失败：转移单 .* 的证书绑定与台账不符/, "改挂到同名持有人证书");
  const rebindGhost = clone8();
  rebindGhost.state.transfers.find(t => t.id === tA8).certId = "ZFL-2099-9999";
  await badImport8(rebindGhost, /导入失败：转移单 .* 引用了不存在的证书/, "改挂到不存在证书");
  const noBind = clone8();
  delete noBind.state.transfers.find(t => t.id === tA8).certId;
  await badImport8(noBind, /导入失败：转移单 .* 缺失证书绑定/, "缺失证书绑定");
  const dupBind = clone8();
  dupBind.state.transfers.push({ ...dupBind.state.transfers.find(t => t.id === tA8), certId: certB8 });
  await badImport8(dupBind, /导入失败：转移单编号缺失或重复绑定/, "重复绑定转移单");
  // 正常恢复
  await page8.setInputFiles("#importFile", valid8Path);
  txt = await toastText(page8, /导入完成：作品 \d+ · 证书 \d+，台账链完整/);
  assert(/导入完成/.test(txt), `正常恢复成功：${txt}`);
  let st8 = await page8.evaluate(() => JSON.parse(JSON.stringify(window.ZFL.state)));
  const tA8after = st8.transfers.find(t => t.id === tA8);
  assert(tA8after.state === "pending" && tA8after.certId === certA8, "恢复后原证书的待确认关系不变");
  assert(holdersOf(st8, certB8) === "张三:100", "其他证书持有人未受影响");
  await page8.evaluate(() => window.ZFL.setOperator("李四"));
  assert((await page8.evaluate(t => window.ZFL.txConfirm(t), tA8)).ok, "恢复后待确认转移单确认成功");
  st8 = await page8.evaluate(() => JSON.parse(JSON.stringify(window.ZFL.state)));
  assert(holdersOf(st8, certA8) === "张三:60,李四:40", "确认后证书 A 份额正确（张三60/李四40）");
  assert(holdersOf(st8, certB8) === "张三:100", "确认后证书 B 未被误改");
  await page8.evaluate(() => window.ZFL.setOperator("张三"));
  const tC8 = (await page8.evaluate(c => window.ZFL.txInitiate(c, "张三", "王五", 10, "普通转让", ""), certA8)).result.id;
  assert((await page8.evaluate(t => window.ZFL.txCancelTransfer(t), tC8)).ok, "恢复后发起与取消转移单仍按原流程工作");
  await page8.reload({ waitUntil: "load" });
  st8 = await page8.evaluate(() => JSON.parse(JSON.stringify(window.ZFL.state)));
  assert(holdersOf(st8, certA8) === "张三:60,李四:40" && holdersOf(st8, certB8) === "张三:100", "刷新后两张证书产权保持一致");
  assert(await page8.evaluate(() => window.ZFL.verifyAll().badCerts.length === 0), "刷新后全部证书校验为真");
  await ctx7.close();

  assert(pageErrors.length === 0, `全程无页面脚本错误${pageErrors.length ? "：" + pageErrors[0] : ""}`);
  console.log(`\n全部场景通过，共 ${passed} 项断言。`);
} catch (e) {
  console.error(`\n✘ 场景 ${scenario} 失败：`, e.message);
  await shot(await browser.contexts()[0]?.pages()[0], scenario).catch(() => {});
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
