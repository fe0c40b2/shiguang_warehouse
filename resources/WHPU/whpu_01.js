// 武汉轻工大学 (whpu.edu.cn) 拾光课程表适配脚本
// 教务系统: 正方教务 (https://jwglxt.whpu.edu.cn)
// 适用页面: 信息查询 -> 学生课表查询  /kbcx/xskbcx_cxXskbcxIndex.html?gnmkdm=N253508&layout=default
//
// 页面结构(正方课表网格):
//   table#kbgrid_table_0 > tbody > tr
//     td[id="星期-起始节次"][rowspan=连续节次数] > div.timetable_con
//       span.title                              课程名(末尾 ★/○/◆ 表示讲课/实验/讨论…)
//       p > span[title=节/周]    -> "(1-2节)18周" / "(3-4节)5-17周(单)"
//       p > span[title=上课地点] -> "常青花园 积学楼（原科教大楼）0402"
//       p > span[title=教师]     -> "陈高波"
//       p > span[title=教学班名称] -> "(2026-2027-1)-MATH2215-11"
//       p > span[title=学分]     -> "5.0"
//   待筛选(未选上)的课程用红色斜体标记, 导入时跳过。
//
// 说明: 2026-2027 学年校历 第1学期 2026-09-07 开学, 18 周(第18周为期末考试周);
//       作息时间取教务处公布的秋冬春季/夏季两套时间表, 默认秋冬春季(9月30日之后执行)。

// ========== 常量与兜底数据 ==========
// 2026-2027 学年第 1 学期第 1 周周一(校历: 9月7日正式上课)
const WHPU_SEMESTER_START = "2026-09-07";
const WHPU_TOTAL_WEEKS = 18;

// 教务处作息时间表: 秋冬春季(默认) / 夏季(5月1日-9月30日)
// 冬季第8节原文写作"第8节课 17:50—18:35", 按相邻节次(第7节 16:45-17:30)推算应为 17:40-18:25
const WHPU_TIME_SLOTS_WINTER = [
    { number: 1, startTime: "08:00", endTime: "08:45" },
    { number: 2, startTime: "08:55", endTime: "09:40" },
    { number: 3, startTime: "10:10", endTime: "10:55" },
    { number: 4, startTime: "11:05", endTime: "11:50" },
    { number: 5, startTime: "14:00", endTime: "14:45" },
    { number: 6, startTime: "14:55", endTime: "15:40" },
    { number: 7, startTime: "15:50", endTime: "16:35" },
    { number: 8, startTime: "16:45", endTime: "17:30" },
    { number: 9, startTime: "18:15", endTime: "19:00" },
    { number: 10, startTime: "19:10", endTime: "19:55" },
    { number: 11, startTime: "20:05", endTime: "20:50" }
];
const WHPU_TIME_SLOTS_SUMMER = [
    { number: 1, startTime: "08:00", endTime: "08:45" },
    { number: 2, startTime: "08:55", endTime: "09:40" },
    { number: 3, startTime: "10:10", endTime: "10:55" },
    { number: 4, startTime: "11:05", endTime: "11:50" },
    { number: 5, startTime: "14:30", endTime: "15:15" },
    { number: 6, startTime: "15:25", endTime: "16:10" },
    { number: 7, startTime: "16:20", endTime: "17:05" },
    { number: 8, startTime: "17:15", endTime: "18:00" },
    { number: 9, startTime: "18:45", endTime: "19:30" },
    { number: 10, startTime: "19:40", endTime: "20:25" },
    { number: 11, startTime: "20:35", endTime: "21:20" }
];

// ========== 通用小工具 ==========
// 调试开关: 控制台执行 __WHPU_DEBUG__ = true 后重新导入, 会打印解析细节
function debugLog() {
    if (typeof window !== "undefined" && window.__WHPU_DEBUG__) {
        console.log.apply(console, ["[WHPU]"].concat(Array.prototype.slice.call(arguments)));
    }
}

function normText(s) {
    return String(s === null || s === undefined ? "" : s)
        .replace(/\u00a0|\u3000/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

// 周次文本 -> 周次数组; 支持 "18周" "4-17周" "5-17周(单)" "6-13周(双)" "4-18周"
function parseWeeks(weekStr) {
    const weeks = new Set();
    const text = normText(weekStr);
    if (!text) return [];
    if (/^[01]{6,}$/.test(text)) {
        for (let i = 0; i < text.length; i++) if (text[i] === "1") weeks.add(i + 1);
        return Array.from(weeks).sort((a, b) => a - b);
    }

    const isOdd = text.indexOf("单") !== -1;
    const isEven = text.indexOf("双") !== -1;
    const pure = text.replace(/[第周单双全()（）]/g, "").replace(/[，,;；、\s]+/g, ",");
    pure.split(",").forEach(seg => {
        const range = seg.match(/^(\d+)\s*[-~至]\s*(\d+)$/);
        if (range) {
            const start = parseInt(range[1], 10);
            const end = parseInt(range[2], 10);
            for (let w = Math.min(start, end); w <= Math.max(start, end); w++) {
                if (isOdd && w % 2 === 0) continue;
                if (isEven && w % 2 !== 0) continue;
                weeks.add(w);
            }
            return;
        }
        const nums = seg.match(/\d+/g);
        if (nums) {
            nums.forEach(n => {
                const w = parseInt(n, 10);
                if (w > 0 && w < 100) {
                    if (isOdd && w % 2 === 0) return;
                    if (isEven && w % 2 !== 0) return;
                    weeks.add(w);
                }
            });
        }
    });
    return Array.from(weeks).sort((a, b) => a - b);
}

// "节/周" 文本 -> {startSection, endSection, weeks}
//   "(1-2节)18周" / "(3-4节)5-17周(单)" / "(9-11节)4-14周"
// 注意: 必须只截掉 "(x-y节)" 这一段, 否则 "18周" 这种单周次会被误删首位数字
function parseSectionWeek(text) {
    const raw = normText(text);
    const section = raw.match(/[(（]?\s*(\d+)\s*[-~至]\s*(\d+)\s*节\s*[)）]?/);
    const sectionSingle = raw.match(/[(（]?\s*(\d+)\s*节\s*[)）]?/);
    const startSection = section ? parseInt(section[1], 10) : (sectionSingle ? parseInt(sectionSingle[1], 10) : null);
    const endSection = section ? parseInt(section[2], 10) : startSection;
    const weekPart = section ? raw.replace(section[0], "") : raw.replace(sectionSingle ? sectionSingle[0] : "", "");
    return { startSection: startSection, endSection: endSection, weeks: parseWeeks(weekPart || raw) };
}

// 地点规整:
//  "常青花园 积学楼（原科教大楼）0402" -> "常青花园积学楼（原科教大楼）0402"
//  "常青花园 常青花园体育场"          -> "常青花园体育场"(校区名重复时去掉冗余的那个)
function cleanPosition(raw) {
    const pos = normText(raw).replace(/\s+/g, "");
    if (!pos) return "";
    const parts = normText(raw).split(" ");
    if (parts.length === 2 && parts[1].indexOf(parts[0]) === 0) return parts[1];
    return pos;
}

// 课程名去掉末尾的课程性质符号(★讲课 ○实验 ◆讨论 ◇上机 ●实践 ※其他)
function cleanCourseName(raw) {
    return normText(raw).replace(/[★○◆◇●※]+$/g, "").replace(/[★○◆◇●※]/g, "").trim();
}

function toFloatOrNull(v) {
    const t = normText(v).replace(/[^\d.]/g, "");
    if (!t) return null;
    const n = parseFloat(t);
    return isNaN(n) ? null : n;
}

// ========== 页面解析 ==========
// 取 div.timetable_con 里某个字段(span[title=xxx] 之后的文本节点)
function fieldOf(div, titlePrefix) {
    const spans = Array.prototype.slice.call(div.querySelectorAll("span[title]"));
    const hit = spans.filter(s => normText(s.getAttribute("title")).indexOf(titlePrefix) === 0)[0];
    if (!hit) return "";
    let text = "";
    let node = hit.nextSibling;
    while (node) {
        if (node.nodeType === 1 && node.tagName === "SPAN" && node.getAttribute && node.getAttribute("title")) break;
        text += node.textContent || "";
        node = node.nextSibling;
    }
    return normText(text);
}

// 是否为"待筛选"(未选上)课程: 页面提示"红色斜体为待筛选"
function isPendingCourse(div) {
    const fonts = Array.prototype.slice.call(div.querySelectorAll("font"));
    if (!fonts.length) return false;
    return fonts.some(f => normText(f.getAttribute("color")).toLowerCase() === "red");
}

function findGridTable() {
    const tables = Array.prototype.slice.call(document.querySelectorAll("table"));
    return tables.filter(t => /(^|\s)timetable1(\s|$)/.test(t.className) || /^kbgrid_table/.test(t.id || ""))[0] || null;
}

function parseCoursesFromDom() {
    const table = findGridTable();
    if (!table) return { courses: [], found: false };

    const courses = [];
    const tds = Array.prototype.slice.call(table.querySelectorAll("td[id]"));
    tds.forEach(td => {
        const m = /^(\d+)-(\d+)$/.exec(normText(td.id));
        if (!m) return;
        const day = parseInt(m[1], 10);
        if (day < 1 || day > 7) return;

        Array.prototype.slice.call(td.children).forEach(child => {
            if (!child.classList || !child.classList.contains("timetable_con")) return;
            if (isPendingCourse(child)) {
                debugLog("跳过待筛选课程:", normText(child.querySelector(".title") ? child.querySelector(".title").textContent : ""));
                return;
            }

            const titleEl = child.querySelector(".title");
            const name = cleanCourseName(titleEl ? titleEl.textContent : "");
            if (!name) return;

            const sectionWeek = fieldOf(child, "节/周");
            const parsed = parseSectionWeek(sectionWeek);
            const startSection = parsed.startSection || parseInt(m[2], 10);
            const endSection = parsed.endSection || startSection;
            if (!parsed.weeks.length) {
                debugLog("跳过(无周次):", name, sectionWeek);
                return;
            }

            courses.push({
                name: name,
                teacher: normText(fieldOf(child, "教师")),
                position: cleanPosition(fieldOf(child, "上课地点")),
                day: day,
                startSection: startSection,
                endSection: endSection,
                weeks: parsed.weeks,
                credit: toFloatOrNull(fieldOf(child, "学分")),
                classCode: normText(fieldOf(child, "教学班名称"))
            });
        });
    });

    return { courses: courses, found: true };
}

// 同一门课在同一星期同一节次、且地点与教师都相同时合并周次; 否则各自成条
function mergeCourses(list) {
    const groups = [];
    list.forEach(c => {
        const exists = groups.filter(g =>
            g.name === c.name && g.day === c.day && g.startSection === c.startSection &&
            g.endSection === c.endSection && g.position === c.position && g.teacher === c.teacher
        )[0];
        if (exists) {
            exists.weeks = Array.from(new Set(exists.weeks.concat(c.weeks))).sort((a, b) => a - b);
            if (exists.credit === null && c.credit !== null) exists.credit = c.credit;
            return;
        }
        groups.push({
            name: c.name,
            teacher: c.teacher,
            position: c.position || "未知地点",
            day: c.day,
            startSection: c.startSection,
            endSection: c.endSection,
            weeks: c.weeks.slice(),
            credit: c.credit
        });
    });

    return groups
        .filter(c => c.name && c.weeks.length && c.endSection >= c.startSection)
        .sort((a, b) => a.day - b.day || a.startSection - b.startSection || a.name.localeCompare(b.name, "zh"));
}

function buildTimeSlots() {
    return WHPU_TIME_SLOTS_WINTER.map(s => ({ number: s.number, startTime: s.startTime, endTime: s.endTime }));
}

// 从页面里找学期标题(如 "2026-2027学年第1学期"), 用于判断是否需要夏季作息
function detectSummerSchedule() {
    const titleEl = document.querySelector(".timetable_title");
    const text = normText(titleEl ? titleEl.textContent : document.title);
    // 只有明确是"第2学期(春季/夏季)"时才用夏季作息; 无法判断时用秋冬春季
    const isSecondTerm = /第\s*2\s*学期|第二学期|春学期|夏学期/.test(text);
    return isSecondTerm;
}

// ========== 流程控制 ==========
async function promptUserToStart() {
    return await window.shiguangBridgePromise.showAlert(
        "武汉轻工大学课表导入",
        "请先登录教务系统, 打开【信息查询 - 学生课表查询】并确认能看到课表, 再点击下面的按钮。\n" +
        "导入会读取当前课表页面, 并自动带入作息时间。",
        "开始导入"
    );
}

function hasScheduleTable() {
    try {
        return !!(findGridTable() && document.querySelectorAll("td[id] .timetable_con").length);
    } catch (e) {
        return false;
    }
}

async function waitForScheduleRender(attempts) {
    for (let i = 0; i < attempts; i++) {
        if (hasScheduleTable()) return true;
        await new Promise(resolve => setTimeout(resolve, 800));
    }
    return hasScheduleTable();
}

async function fetchAndParseJwData() {
    const parsed = parseCoursesFromDom();
    if (!parsed.found) return null;
    const courses = mergeCourses(parsed.courses);
    if (!courses.length) return { courses: [], timeSlots: buildTimeSlots(), config: null };

    const summer = detectSummerSchedule();
    const timeSlots = summer ? WHPU_TIME_SLOTS_SUMMER.map(s => ({ number: s.number, startTime: s.startTime, endTime: s.endTime })) : buildTimeSlots();
    debugLog("作息:", summer ? "夏季" : "秋冬春季", "| 课程条数:", courses.length);
    courses.forEach(c => debugLog("  周" + c.day + " " + c.startSection + "-" + c.endSection + "节 " + c.name + " | " + c.teacher + " | " + c.position + " | 周次 " + c.weeks.join(",")));

    return {
        courses: courses,
        timeSlots: timeSlots,
        config: {
            semesterStartDate: WHPU_SEMESTER_START,
            semesterTotalWeeks: Math.max(WHPU_TOTAL_WEEKS, ...courses.reduce((acc, c) => acc.concat(c.weeks), [0])),
            firstDayOfWeek: 1,
            defaultClassDuration: 45,
            defaultBreakDuration: 10
        }
    };
}

async function saveToApp(result) {
    const courseSaved = await window.shiguangBridgePromise.saveImportedCourses(JSON.stringify(result.courses));
    if (!courseSaved) return false;

    try {
        if (result.timeSlots && result.timeSlots.length) {
            await window.shiguangBridgePromise.savePresetTimeSlots(JSON.stringify(result.timeSlots));
        }
    } catch (e) {
        console.warn("时间段保存失败:", e);
    }
    try {
        if (result.config) {
            await window.shiguangBridgePromise.saveCourseConfig(JSON.stringify(result.config));
        }
    } catch (e) {
        console.warn("课表配置保存失败:", e);
    }
    return true;
}

async function runImportFlow() {
    try {
        const confirmed = await promptUserToStart();
        if (!confirmed) return;

        await waitForScheduleRender(3);
        window.shiguangBridge.showToast("正在读取武汉轻工大学课表...");
        let result = await fetchAndParseJwData();

        if (!result || !result.courses.length) {
            for (let attempt = 0; attempt < 3 && (!result || !result.courses.length); attempt++) {
                const retry = await window.shiguangBridgePromise.showAlert(
                    "未检测到课表数据",
                    "当前页面没有解析到课程。\n" +
                    "请确认: 1) 已登录教务系统; 2) 已打开【信息查询 - 学生课表查询】且能看到课表。\n" +
                    "页面刚打开时可等课表显示出来, 再点下面的按钮重试。",
                    "继续导入"
                );
                if (!retry) return;
                await waitForScheduleRender(3);
                result = await fetchAndParseJwData();
            }
            if (!result || !result.courses.length) {
                window.shiguangBridge.showToast("仍未解析到课表, 请进入【学生课表查询】页面后重新执行导入");
                return;
            }
        }

        if (await saveToApp(result)) {
            window.shiguangBridge.showToast("武汉轻工大学课表导入成功: 共 " + result.courses.length + " 条课程安排");
            window.shiguangBridge.notifyTaskCompletion();
        }
    } catch (e) {
        console.error("武汉轻工大学课表导入失败:", e);
        window.shiguangBridge.showToast("导入失败: " + (e && e.message ? e.message : e));
    }
}

runImportFlow();
