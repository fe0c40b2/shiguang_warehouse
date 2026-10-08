// 上海海洋大学 (shou.edu.cn) 拾光课程表适配脚本
// 教务系统: URP 综合教务 (https://urp.shou.edu.cn)
// 适用页面: 学生选课 -> 本学期课表  /student/courseSelect/thisSemesterCurriculum/index
//
// 解析策略(两路都跑, 结果取并集, 避免单一来源漏数据):
//   A. 教务 JSON 接口 /student/courseSelect/thisSemesterCurriculum/*/ajaxStudentSchedule/curr/callback
//      —— 与页面自身渲染课表用的是同一份数据, 字段最全(教师、周次描述、校区+教学楼+教室)
//   B. 当前页面已渲染的课表 DOM (#courseTableBody 内的 td[id="星期_节次"] > div.class_div)
//      —— 接口取不到时兜底; 同一门课在同星期同节次的不同周次/教室会合并, 教室不同的写入备注
//
// 说明: 上海海洋大学 2025-2026 学年校历 秋季/春夏季学期均为 18 周(第19-21周为暑期),
//       故默认 semesterTotalWeeks = 18; 作息时间优先从课表表头(第(xx:xx-xx:xx))动态读取。

// ========== 常量与兜底数据 ==========
const SHOU_TOTAL_WEEKS = 18;

// 兜底作息(上海海洋大学教务处编印校历"上课时间", 与课表表头一致)
const SHOU_TIME_SLOTS = [
    { number: 1, startTime: "08:15", endTime: "09:00" },
    { number: 2, startTime: "09:05", endTime: "09:50" },
    { number: 3, startTime: "10:05", endTime: "10:50" },
    { number: 4, startTime: "10:55", endTime: "11:40" },
    { number: 5, startTime: "13:00", endTime: "13:45" },
    { number: 6, startTime: "13:50", endTime: "14:35" },
    { number: 7, startTime: "14:45", endTime: "15:30" },
    { number: 8, startTime: "15:35", endTime: "16:20" },
    { number: 9, startTime: "18:00", endTime: "18:45" },
    { number: 10, startTime: "18:50", endTime: "19:35" },
    { number: 11, startTime: "19:45", endTime: "20:30" },
    { number: 12, startTime: "20:35", endTime: "21:20" }
];

// ========== 通用小工具 ==========
// 调试开关: 在控制台执行 __SHOU_DEBUG__ = true 后重新导入, 可看到接口/页面两路解析的详细日志
function debugLog() {
    if (typeof window !== "undefined" && window.__SHOU_DEBUG__) {
        console.log.apply(console, ["[SHOU]"].concat(Array.prototype.slice.call(arguments)));
    }
}

function normText(s) {
    return String(s === null || s === undefined ? "" : s)
        .replace(/\u00a0|\u3000/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

// 周次文本 -> 周次数组; 支持 "1-18周" "第4周" "7-9,11-14,16-17周" "4-18周 单周" "1-17周单周"
function parseWeeks(weekStr) {
    const weeks = new Set();
    const text = normText(weekStr);
    if (!text) return [];

    // 形如 "111111111100000000" 的周次位图(接口 classWeek 字段)
    if (/^[01]{6,}$/.test(text)) return parseWeekBitmap(text);

    const pure = text.replace(/[第周]/g, "").replace(/[，,;；、\s]+/g, ",");
    // 单双周标记可能写在整段末尾(如 "4-18周 单周"), 先摘出来
    const isOdd = pure.indexOf("单") !== -1;
    const isEven = pure.indexOf("双") !== -1;
    pure.replace(/[单双全]/g, "")
        .split(",")
        .forEach(seg => {
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
                    if (w > 0 && w < 100) weeks.add(w);
                });
            }
        });
    return Array.from(weeks).sort((a, b) => a - b);
}

// 位图周次: 第 n 位为 1 表示第 n 周上课(URP 的 classWeek 字段)
function parseWeekBitmap(bitmap) {
    const weeks = [];
    for (let i = 0; i < bitmap.length; i++) {
        if (bitmap[i] === "1") weeks.push(i + 1);
    }
    return weeks;
}

// 节次文本 -> {startSection, endSection}; 支持 "1-2节" "第3节" "9-11节"
function parseSections(sectionStr) {
    const text = normText(sectionStr).replace(/节/g, "");
    const range = text.match(/(\d+)\s*[-~至]\s*(\d+)/);
    if (range) return { startSection: parseInt(range[1], 10), endSection: parseInt(range[2], 10) };
    const single = text.match(/\d+/);
    if (single) return { startSection: parseInt(single[0], 10), endSection: parseInt(single[0], 10) };
    return null;
}

// 从 "HHmm" / "HH:mm" 归一化为 "HH:mm"
function normClock(v) {
    const text = normText(v).replace(/[^\d:]/g, "");
    if (/^\d{2}:\d{2}$/.test(text)) return text;
    if (/^\d{4}$/.test(text)) return text.slice(0, 2) + ":" + text.slice(2);
    return "";
}

// ========== DOM 解析 (策略 B) ==========
// 页面表头把下午/晚上的时间写成 12 小时制(第5-6节显示 "01:00-01:45", 第11节显示 "07:45-08:30"),
// 且"上午/下午/晚上"标签只出现在该时段第一行(rowspan 占位), 需要按顺序继承标签再修正为 24 小时制
function parseTimeSlotsFromDom() {
    const rows = [];
    document.querySelectorAll('th[id^="0_"]').forEach(th => {
        const number = parseInt(String(th.id).split("_")[1], 10);
        const m = normText(th.textContent).match(/\(?\s*(\d{1,2}):(\d{2})\s*[-~至]\s*(\d{1,2}):(\d{2})\s*\)?/);
        if (isNaN(number) || !m) return;
        rows.push({ number: number, text: normText(th.parentElement ? th.parentElement.textContent : ""), m: m });
    });
    rows.sort((a, b) => a.number - b.number);

    const to24 = (h, mi, period, prevEnd) => {
        let hour = parseInt(h, 10);
        if (hour === 12) hour = 0;
        if (period === "下午" || period === "晚上") {
            let minutes = hour * 60 + parseInt(mi, 10);
            // 12 小时制无法区分 07:45 与 19:45, 用上一节次的结束时间判断是否需要 +12 小时
            if (minutes < prevEnd && minutes + 720 > prevEnd) minutes += 720;
            hour = Math.floor(minutes / 60);
            return { clock: (hour < 10 ? "0" : "") + hour + ":" + mi, minutes: minutes };
        }
        const minutes = hour * 60 + parseInt(mi, 10);
        return { clock: (hour < 10 ? "0" : "") + hour + ":" + mi, minutes: minutes };
    };

    const slots = [];
    let period = "";
    let prevEnd = -1;
    rows.forEach(row => {
        if (row.text.indexOf("上午") !== -1) period = "上午";
        else if (row.text.indexOf("下午") !== -1) period = "下午";
        else if (row.text.indexOf("晚") !== -1) period = "晚上";

        const start = to24(row.m[1], row.m[2], period, prevEnd);
        const end = to24(row.m[3], row.m[4], period, start.minutes);
        if (end.minutes <= start.minutes) return;
        prevEnd = end.minutes;
        slots.push({ number: row.number, startTime: start.clock, endTime: end.clock });
    });
    return slots;
}

// 解析 class_div 上的 onclick="toClickInfo('计划号','课程号','课序号',...)" 参数
function parseOnClickArgs(div) {
    const link = div.querySelector("a[onclick]");
    if (!link) return [];
    const m = String(link.getAttribute("onclick") || "").match(/toClick\w*\(([^)]*)\)/);
    if (!m) return [];
    return (m[1].match(/"([^"]*)"|'([^']*)'/g) || []).map(s => s.slice(1, -1));
}

// 课程名去掉页面拼接的 "_课序号" 后缀
function cleanCourseName(rawName, seq) {
    let name = normText(rawName);
    if (seq && name.endsWith("_" + seq)) name = name.slice(0, -(String(seq).length + 1));
    return name.replace(/_\d+$/, "").trim();
}

function parseCoursesFromDom() {
    const blocks = [];
    // 单元格 id 形如 "星期_节次"(如 2_1), 课程序号也用于定位课程块
    document.querySelectorAll('td[id]').forEach(td => {
        const idParts = String(td.id).split("_");
        if (idParts.length !== 2) return;
        const day = parseInt(idParts[0], 10);
        if (isNaN(day) || day < 1 || day > 7) return;

        td.querySelectorAll("div.class_div").forEach(div => {
            const pTags = Array.from(div.querySelectorAll("p")).map(p => normText(p.textContent));
            if (pTags.length < 4) return;

            // 页面上课程块结构固定为: 课程名 / 教师 / 周次 / 节次 / 地点
            const args = parseOnClickArgs(div);
            const courseNumber = args[1] || "";
            const seqNumber = args[2] || "";

            const name = cleanCourseName(pTags[0], seqNumber);
            const teacher = cleanTeacher(pTags[1]);
            const weeks = parseWeeks(pTags[2]);
            const section = parseSections(pTags[3]);
            const position = pTags[4] || "";

            if (!name || !weeks.length || !section) return;
            blocks.push({
                name: name,
                teacher: teacher,
                position: position,
                day: day,
                startSection: section.startSection,
                endSection: section.endSection,
                weeks: weeks,
                remark: "",
                key: (courseNumber ? courseNumber + "_" + seqNumber : name + "|" + teacher)
            });
        });
    });
    return blocks;
}

// ========== 教务 JSON 接口解析 (策略 A) ==========
function findScheduleCallbackUrl() {
    // 页面里出现的随机串路径(如 /student/courseSelect/thisSemesterCurriculum/sl7028fk2t/...)由学校定制,
    // 这里从页面自身脚本中提取, 取不到则用通用路径
    const scripts = Array.from(document.querySelectorAll("script")).map(s => s.textContent || "").join("\n");
    const m = scripts.match(/["'](\/student\/courseSelect\/thisSemesterCurriculum\/[A-Za-z0-9]+\/ajaxStudentSchedule\/[A-Za-z0-9_]+\/callback)["']/);
    if (m) return m[1];
    const m2 = scripts.match(/["'](\/student\/courseSelect\/thisSemesterCurriculum\/ajaxStudentSchedule\/[A-Za-z0-9_]+\/callback)["']/);
    if (m2) return m2[1];
    return "/student/courseSelect/thisSemesterCurriculum/ajaxStudentSchedule/curr/callback";
}

function pick(obj, names) {
    for (const n of names) {
        if (obj && obj[n] !== undefined && obj[n] !== null && String(obj[n]).trim() !== "") return obj[n];
    }
    return "";
}

// 教师名清洗: 去掉页面/接口加的星号与多余空格
function cleanTeacher(v) {
    return normText(v).replace(/\*+/g, " ").replace(/\s+/g, " ").trim();
}

// 教师字段可能为空或只是占位符(如 "无"), 这时从 rlFlag("无,教师名 无|...") 里取名字
function teacherFromFallbackFlag(flag) {
    if (!flag) return "";
    for (const seg of String(flag).split("|")) {
        const m = normText(seg).match(/[,，]\s*([^,，]+?)\s+无\s*$/);
        if (m) {
            const name = cleanTeacher(m[1]);
            if (name && name !== "无" && name.indexOf("无") !== 0) return name;
        }
    }
    return "";
}

function resolveTeacher(course) {
    const direct = cleanTeacher(pick(course, ["attendClassTeacher", "teacherName", "teacher", "jsxm"]));
    if (direct && direct !== "无" && direct !== "（无）") return direct;
    return teacherFromFallbackFlag(pick(course, ["rlFlag", "dgFlag", "ywdgFlag"]));
}

// 教务接口返回的课程列表层级因版本而异(xkxx 可能是对象、对象里再套数组等), 这里递归收集课程对象
function collectCourseObjects(root) {
    const list = [];
    const seen = new Set();
    const walk = (v, depth) => {
        if (!v || typeof v !== "object" || depth > 5) return;
        if (seen.has(v)) return; // 兼容引用复用, 防止死循环
        seen.add(v);
        if (Array.isArray(v)) {
            v.forEach(item => walk(item, depth + 1));
            return;
        }
        if (v.courseName || v.coureNumber || v.timeAndPlaceList || v.attendClassTeacher) {
            list.push(v);
            return;
        }
        Object.keys(v).forEach(k => walk(v[k], depth + 1));
    };
    walk(root, 0);
    return list;
}

function parseCoursesFromApi(data) {
    const blocks = [];
    if (!data || typeof data !== "object") return blocks;

    // 课程列表: 不同版本可能挂在 xkxx / dateList[].selectCourseList 下
    let list = collectCourseObjects(data.xkxx);
    if (!list.length && Array.isArray(data.dateList)) {
        list = collectCourseObjects(data.dateList);
    }

    list.forEach(course => {
        if (!course || typeof course !== "object") return;
        const idObj = course.id && typeof course.id === "object" ? course.id : course;
        const courseNumber = normText(pick(idObj, ["coureNumber", "courseNumber", "kch"]));
        const seqNumber = normText(pick(idObj, ["coureSequenceNumber", "coureSequence", "courseSequenceNumber", "kxh"]));
        const name = normText(pick(course, ["courseName", "kcmc", "name"]));
        if (!name) return;

        const teacher = resolveTeacher(course);

        const places = Array.isArray(course.timeAndPlaceList) ? course.timeAndPlaceList
            : (Array.isArray(course.timeAndPlace) ? course.timeAndPlace : []);
        places.forEach(tp => {
            if (!tp || typeof tp !== "object") return;
            const day = parseInt(pick(tp, ["classDay", "day", "xq"]), 10);
            const startSection = parseInt(pick(tp, ["classSessions", "startSection", "jc"]), 10);
            const continueSession = parseInt(pick(tp, ["continuingSession", "continueSession", "lianxu"]), 10);
            if (isNaN(day) || day < 1 || day > 7 || isNaN(startSection)) return;
            const endSection = startSection + (isNaN(continueSession) || continueSession < 1 ? 1 : continueSession) - 1;

            const weeks = parseWeeks(pick(tp, ["classWeek", "weeks", "weekDescription"]));
            if (!weeks.length) return;

            const position = normText(
                normText(pick(tp, ["campusName", "xqmc"])) +
                normText(pick(tp, ["teachingBuildingName", "jxlmc"])) +
                normText(pick(tp, ["classroomName", "jsmc"]))
            );
            blocks.push({
                name: name,
                teacher: teacher,
                position: position,
                day: day,
                startSection: startSection,
                endSection: endSection,
                weeks: weeks,
                remark: "",
                key: (courseNumber ? courseNumber + "_" + seqNumber : name + "|" + teacher)
            });
        });
    });
    return blocks;
}

function parseTimeSlotsFromApi(data) {
    const raw = (data && (data.jcsjbs || data.timeSlots || data.jcsj)) || null;
    if (!Array.isArray(raw)) return [];
    const slots = [];
    raw.forEach(item => {
        if (!item || typeof item !== "object") return;
        const number = parseInt(pick(item, ["jc", "number", "section"]), 10);
        const startTime = normClock(pick(item, ["kssj", "startTime", "start"]));
        const endTime = normClock(pick(item, ["jssj", "endTime", "end"]));
        if (!isNaN(number) && startTime && endTime) slots.push({ number: number, startTime: startTime, endTime: endTime });
    });
    return slots.sort((a, b) => a.number - b.number);
}

async function fetchScheduleJson() {
    const url = findScheduleCallbackUrl();
    const resp = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded; charset=UTF-8" },
        body: "",
        credentials: "include"
    });
    if (!resp || !resp.ok) throw new Error("教务接口返回异常(HTTP " + (resp ? resp.status : "?") + ")");
    const data = await resp.json();
    if (data && data.errorMessage) throw new Error(String(data.errorMessage));
    return data;
}

// ========== 合并 / 规整 ==========
// 地点规整:
//  1. 去掉校区前缀"临"(上海海洋大学临港校区, 所有教室都带这个前缀)
//  2. 合并两路数据里写法不同的同一地点:
//     - 接口给 "临"+"公共实验楼"+"A309" -> "临公共实验楼A309"
//     - 页面(或另一路)可能给 "公共实验楼A309"
//     去掉前缀后前者变成 "公共实验楼A309", 与后者一致, 于是不会出现重复地点
function cleanPosition(raw) {
    let pos = normText(raw);
    if (!pos) return "";
    pos = pos.replace(/^(临港校区|临港|临)\s*/, "");
    return pos.trim();
}

// 周次数组 -> "4-18周" / "5-6,8周" 这样的紧凑文本(调试输出用)
function formatWeekRanges(weeks) {
    const arr = Array.from(new Set(weeks)).sort((a, b) => a - b);
    const parts = [];
    let start = null;
    let prev = null;
    arr.forEach(w => {
        if (start === null) { start = w; prev = w; return; }
        if (w === prev + 1) { prev = w; return; }
        parts.push(start === prev ? String(start) : start + "-" + prev);
        start = w;
        prev = w;
    });
    if (start !== null) parts.push(start === prev ? String(start) : start + "-" + prev);
    return parts.join(",") + "周";
}
// 调试提示: 控制台执行 __SHOU_DEBUG__ = true 后重新导入, 会打印每条课程的周次与地点
debugLog("适配脚本已加载; 如需详细日志请在控制台执行 __SHOU_DEBUG__ = true");

// 同一门课在同一星期同一节次有多个地点/教师时, 拆成多条独立记录(周次各自保留),
// 这样应用里可以分别看到每一条的地点、教师和上课周次, 不会被并成一条
function buildEntries(block) {
    const groups = [];
    block.positions.forEach(p => {
        const weeks = Array.from(new Set(p.weeks)).sort((a, b) => a - b);
        if (!weeks.length) return;
        const position = cleanPosition(p.position);
        const teacher = normText(p.teacher);
        let g = groups.find(x => x.position === position && x.teacher === teacher);
        if (!g) {
            g = { position: position, teacher: teacher, weeks: [] };
            groups.push(g);
        }
        g.weeks = Array.from(new Set(g.weeks.concat(weeks))).sort((a, b) => a - b);
    });
    if (!groups.length) return [];

    return groups.map(g => ({
        name: block.name,
        teacher: g.teacher,
        position: g.position || "未知地点",
        day: block.day,
        startSection: block.startSection,
        endSection: block.endSection,
        weeks: g.weeks,
        remark: "",
        isCustomTime: false
    }));
}

// 单一路解析结果: 先按 课程号+课序号(无课程号时用名称+教师) 分组, 只合并周次,
// 保留每个地点及其对应周次, 交给 buildEntries 按"地点+教师"拆分
function mergeBlocks(blocks) {
    const groups = new Map();
    blocks.forEach(b => {
        const gk = [b.key, b.day, b.startSection, b.endSection].join("#");
        if (!groups.has(gk)) groups.set(gk, []);
        groups.get(gk).push(b);
    });

    const entries = [];
    groups.forEach(list => {
        const first = list[0];
        const block = {
            name: first.name,
            day: first.day,
            startSection: first.startSection,
            endSection: first.endSection,
            positions: []
        };
        list.forEach(b => {
            const pos = normText(b.position);
            let p = block.positions.find(x => x.position === pos);
            if (!p) {
                p = { position: pos, teacher: normText(b.teacher), weeks: [] };
                block.positions.push(p);
            }
            if (!p.teacher && b.teacher) p.teacher = normText(b.teacher);
            p.weeks = p.weeks.concat(b.weeks);
        });
        entries.push.apply(entries, buildEntries(block));
    });

    return entries
        .filter(c => c.name && c.weeks.length && c.day >= 1 && c.day <= 7 && c.endSection >= c.startSection)
        .sort((a, b) => a.day - b.day || a.startSection - b.startSection || a.name.localeCompare(b.name, "zh"));
}

// 把两条信息量不同的同一条记录合并(接口与页面存在写法差异时用)
function mergeEntryPair(a, b) {
    a.weeks = Array.from(new Set(a.weeks.concat(b.weeks))).sort((x, y) => x - y);
    if (a._names.indexOf(b.name) === -1) a._names.push(b.name);
    if (!a.teacher && b.teacher) a.teacher = b.teacher;
    if (!normText(a.position) && normText(b.position)) a.position = b.position;
    return a;
}

// 两路解析结果合并: 逐条比较, 同一条(名称+教师+地点+星期+节次)只保留一份并合并周次,
// 而不是把不同地点/不同时段并成一条 —— 保证应用里每条课程都能区分
function mergeCourseSources(apiCourses, domCourses) {
    const index = new Map();
    const order = [];
    const normName = s => normText(s).replace(/[\s_()（）]/g, "").replace(/-\d+$/, "");
    const normTeacher = s => normText(s).replace(/[\s*]/g, "");

    [apiCourses, domCourses].forEach(list => {
        list.forEach(c => {
            const key = [
                normName(c.name),
                normTeacher(c.teacher),
                normText(c.position),
                c.day,
                c.startSection,
                c.endSection
            ].join("#");
            const exist = index.get(key);
            if (!exist) {
                const copy = Object.assign({}, c);
                copy._names = [c.name];
                copy._weeks = c.weeks.slice();
                index.set(key, copy);
                order.push(copy);
                return;
            }
            mergeEntryPair(exist, c);
        });
    });

    debugLog("合并后课程条目:", order.length);
    order.forEach(c => debugLog("  " + c.name + " | " + cleanPosition(c.position) + " | " + formatWeekRanges(c._weeks)));

    return order.map(c => {
        c.weeks = c._weeks;
        return {
            name: c._names[0],
            teacher: c.teacher,
            position: c.position || "未知地点",
            day: c.day,
            startSection: c.startSection,
            endSection: c.endSection,
            weeks: c.weeks,
            remark: "",
            isCustomTime: false
        };
    }).sort((a, b) => a.day - b.day || a.startSection - b.startSection || a.name.localeCompare(b.name, "zh"));
}

// 整理时间段: 编号必须从 1 开始连续、开始时间早于结束时间、且互不重叠, 否则应用会拒绝导入
function buildTimeSlots(apiSlots, domSlots) {
    const source = (apiSlots && apiSlots.length ? apiSlots : (domSlots && domSlots.length ? domSlots : SHOU_TIME_SLOTS));
    const sorted = source
        .filter(s => s && !isNaN(s.number) && /^\d{2}:\d{2}$/.test(s.startTime) && /^\d{2}:\d{2}$/.test(s.endTime))
        .map(s => ({ number: s.number, startTime: s.startTime, endTime: s.endTime }))
        .sort((a, b) => a.number - b.number);

    const clean = [];
    sorted.forEach(s => {
        // 编号跳号时先用兜底作息补齐, 保证编号从 1 连续(否则应用会拒绝整张时间段表)
        while (s.number > clean.length + 1) {
            const fallback = SHOU_TIME_SLOTS[clean.length];
            if (!fallback) break;
            const prev = clean[clean.length - 1];
            if (prev && fallback.startTime < prev.endTime) break;
            if (fallback.startTime >= s.startTime) break;
            clean.push({ number: clean.length + 1, startTime: fallback.startTime, endTime: fallback.endTime });
        }
        const prev = clean[clean.length - 1];
        if (prev && s.startTime < prev.endTime) return; // 与上一节次重叠, 丢弃该条
        clean.push({ number: clean.length + 1, startTime: s.startTime, endTime: s.endTime });
    });

    return clean.length ? clean : SHOU_TIME_SLOTS.slice();
}

// ========== 流程控制 ==========
async function promptUserToStart() {
    return await window.shiguangBridgePromise.showAlert(
        "上海海洋大学课表导入",
        "请先登录 URP 教务系统, 并打开【学生选课 - 本学期课表】页面后再点击下面的按钮。\n" +
        "导入会同时读取教务接口与当前页面, 自动补全作息时间。",
        "开始导入"
    );
}

// 通用工具(test.js)入口的网址是 about:blank, 用户可能还没进课表页就点了"执行导入",
// 这里先探测一次: 没数据就提示先打开课表页, 允许用户翻页后直接点"继续导入"重试
function hasScheduleTable() {
    try {
        return document.querySelectorAll('div.class_div').length > 0;
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
    let apiData = null;
    let apiCourses = [];
    let domCourses = [];
    let domSlots = [];

    // 策略 B: 当前页面已渲染的课表
    try {
        domCourses = mergeBlocks(parseCoursesFromDom());
        domSlots = parseTimeSlotsFromDom();
    } catch (e) {
        console.warn("页面课表解析失败:", e);
    }

    // 策略 A: 教务接口(与页面同一份数据)
    try {
        apiData = await fetchScheduleJson();
        apiCourses = mergeBlocks(parseCoursesFromApi(apiData));
        debugLog("教务接口课程条数:", apiCourses.length);
    } catch (e) {
        console.warn("教务接口解析失败, 改用页面课表:", e);
        apiData = null;
    }
    debugLog("页面课表课程条数:", domCourses.length, "时间段:", domSlots.length);

    if (!apiCourses.length && !domCourses.length) return null;

    const timeSlots = buildTimeSlots(parseTimeSlotsFromApi(apiData), domSlots);
    const courses = mergeCourseSources(apiCourses, domCourses);

    return {
        courses: courses,
        timeSlots: timeSlots,
        config: {
            // 校历第 1 周日期教务页面未提供, 交由用户在应用内设置
            semesterStartDate: null,
            semesterTotalWeeks: Math.max(SHOU_TOTAL_WEEKS, ...courses.reduce((acc, c) => acc.concat(c.weeks), [0])),
            firstDayOfWeek: 1,
            defaultClassDuration: 45,
            defaultBreakDuration: 10
        }
    };
}

async function saveToApp(result) {
    const courseSaved = await window.shiguangBridgePromise.saveImportedCourses(JSON.stringify(result.courses));
    if (!courseSaved) return false;

    // 时间段/配置失败不阻断课程导入
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

        // 首次点击时课表可能还没渲染完(或用户还没进课表页), 稍等一下再解析
        await waitForScheduleRender(3);

        window.shiguangBridge.showToast("正在读取上海海洋大学课表...");
        const result = await fetchAndParseJwData();

        if (!result || !result.courses.length) {
            // 允许反复重试: 用户可以一边翻到【本学期课表】页面, 一边点"继续导入"
            let data = null;
            for (let attempt = 0; attempt < 3 && !data; attempt++) {
                const retry = await window.shiguangBridgePromise.showAlert(
                    "未检测到课表数据",
                    "当前页面没有解析到课程。\n" +
                    "请确认: 1) 已登录 URP 教务系统; 2) 已进入【学生选课 - 本学期课表】且能看到课表。\n" +
                    "页面刚打开时可等课表显示出来, 再点下面的按钮重试。",
                    "继续导入"
                );
                if (!retry) return;
                await waitForScheduleRender(3);
                data = await fetchAndParseJwData();
            }
            if (!data || !data.courses.length) {
                window.shiguangBridge.showToast("仍未解析到课表, 请进入【本学期课表】页面后重新执行导入");
                return;
            }
            result = data;
        }

        if (await saveToApp(result)) {
            window.shiguangBridge.showToast("上海海洋大学课表导入成功: 共 " + result.courses.length + " 条课程安排");
            window.shiguangBridge.notifyTaskCompletion();
        }
    } catch (e) {
        console.error("上海海洋大学课表导入失败:", e);
        window.shiguangBridge.showToast("导入失败: " + (e && e.message ? e.message : e));
    }
}

runImportFlow();
