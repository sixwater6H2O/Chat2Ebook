import { saveSettingsDebounced } from "../../../../script.js";
import { extension_settings } from "../../../extensions.js";
import { getPresetManager } from "../../../preset-manager.js";


const extensionName = "chat2ebook";

// === CDN 配置 ===
const LIB_SOURCES = {
    jszip: [ "https://npm.elemecdn.com/jszip@3.10.1/dist/jszip.min.js", "https://unpkg.com/jszip@3.10.1/dist/jszip.min.js" ],
    showdown: [ "https://npm.elemecdn.com/showdown@2.1.0/dist/showdown.min.js", "https://unpkg.com/showdown@2.1.0/dist/showdown.min.js" ],
    htmlDocx: [ "https://npm.elemecdn.com/html-docx-js@0.3.1/dist/html-docx.js", "https://unpkg.com/html-docx-js@0.3.1/dist/html-docx.js" ]
};

const defaultSettings = {
    title: "Chat2Ebook", author: "", exportStart: 0, exportEnd: 99999,
    exportUser: false, exportAI: true, hideAIName: true, chapterSplit: 1
};

let settings = {};
let dependenciesLoaded = false;
let lastSystemUser = ""; 

// ==========================================
// 1. 基础工具
// ==========================================
async function loadScriptChain(id, urls) {
    if (document.getElementById(id)) return Promise.resolve();
    return new Promise(async (resolve, reject) => {
        for (const url of urls) {
            try {
                await new Promise((res, rej) => {
                    const script = document.createElement('script');
                    script.id = id; script.src = url; script.onload = res;
                    script.onerror = () => { document.head.removeChild(script); rej(); };
                    document.head.appendChild(script);
                });
                resolve(); return;
            } catch (e) { continue; }
        }
        reject(`All sources failed for ${id}`);
    });
}

async function loadDependencies() {
    if (dependenciesLoaded) return;
    if (window.JSZip && window.showdown && window.htmlDocx) { dependenciesLoaded = true; return; }
    toastr.info('正在连接组件服务器...', 'Chat2Ebook');
    try {
        await Promise.all([
            window.JSZip ? Promise.resolve() : loadScriptChain('c2e-zip', LIB_SOURCES.jszip),
            window.showdown ? Promise.resolve() : loadScriptChain('c2e-showdown', LIB_SOURCES.showdown),
            window.htmlDocx ? Promise.resolve() : loadScriptChain('c2e-docx', LIB_SOURCES.htmlDocx)
        ]);
        dependenciesLoaded = true;
        toastr.success('导出引擎就绪');
    } catch (error) { toastr.error('组件加载失败'); }
}

function downloadFile(content, filename, mimeType) {
    const blob = content instanceof Blob ? content : new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

function getContextCompat() {
    try { if (typeof SillyTavern !== 'undefined' && SillyTavern.getContext) return SillyTavern.getContext(); } catch(e) {}
    if (typeof getContext === 'function') return getContext();
    if (typeof characters !== 'undefined' && typeof this_chid !== 'undefined') return { characters: characters, characterId: this_chid, chat: window.chat };
    return null;
}

function getSTUserName() {
    const ctx = getContextCompat();
    return (ctx && ctx.name1) ? ctx.name1 : "User";
}

// 通用清洗函数
function cleanHtml(htmlContent, mode = 'epub') {
    const tempDiv = document.createElement("div");
    tempDiv.innerHTML = htmlContent;
    
    const badTags = tempDiv.querySelectorAll('style, script, link, meta, title, object, embed, iframe, svg, canvas');
    for (let i = 0; i < badTags.length; i++) {
        badTags[i].remove();
    }
    
    if (mode === 'txt') {
        return tempDiv.innerText.trim();
    }

    if (mode === 'docx') {
        const allElements = tempDiv.querySelectorAll('*');
        for (let i = 0; i < allElements.length; i++) {
            allElements[i].removeAttribute('style');
            allElements[i].removeAttribute('class');
            allElements[i].removeAttribute('id');
        }
    }

    return tempDiv.innerHTML.trim();
}

// ==========================================
// 2. 核心：正则引擎
// ==========================================

function normalizeScript(script) {
    const pattern = script.regex || script.findRegex || script.find_regex || "";
    let replace = "";
    if (script.replaceString !== undefined) replace = script.replaceString;
    else if (script.replace_string !== undefined) replace = script.replace_string;
    else if (script.replacement !== undefined) replace = script.replacement;
    const flags = script.regexOptions || script.regexFlags || 'g';
    
    let finalPattern = pattern;
    let finalFlags = flags;
    if (typeof pattern === 'string' && pattern.startsWith('/') && pattern.lastIndexOf('/') > 0) {
        const match = pattern.match(/^\/(.*?)\/([gimsuy]*)$/);
        if (match) { finalPattern = match[1]; finalFlags = match[2] || flags; }
    }

    let placement = script.placement || [];
    if (!placement.length && script.source) {
        if (script.source.user_input) placement.push(1);
        if (script.source.ai_output) placement.push(2);
    }

    return {
        ...script,
        _name: script.scriptName || script.script_name || "Unknown",
        _pattern: finalPattern,
        _replace: replace,
        _flags: finalFlags,
        _placement: placement,
        _original: pattern,
        _minDepth: script.minDepth !== undefined ? script.minDepth : null,
        _maxDepth: script.maxDepth !== undefined ? script.maxDepth : null
    };
}

function getTextGenPresetScripts() {
    try {
        const manager = getPresetManager('openai');
        if (!manager) return [];
        const currentName = manager.getSelectedPresetName();
        if (!currentName) return [];
        
        const listData = manager.getPresetList();
        const presets = listData.presets;
        const nameMap = listData.preset_names;
        let presetObj = null;

        if (Array.isArray(nameMap)) {
            const idx = nameMap.indexOf(currentName);
            if (idx !== -1) presetObj = presets[idx];
        } else {
            const idx = nameMap[currentName];
            if (idx !== undefined) presetObj = presets[idx];
        }

        if (presetObj && presetObj.extensions && Array.isArray(presetObj.extensions.regex_scripts)) {
            console.log(`📦 [API] 成功提取预设 [${currentName}] 的 ${presetObj.extensions.regex_scripts.length} 个绑定正则`);
            return presetObj.extensions.regex_scripts.map(s => ({ ...s, _source: `Preset: ${currentName}` }));
        }
    } catch (e) { console.error(e); }
    return [];
}

function getAllRegexScripts() {
    let allScripts = [];
    const globalSettings = (typeof window !== 'undefined' && window.extension_settings) ? window.extension_settings : extension_settings;
    if (globalSettings) {
        if (Array.isArray(globalSettings.regex)) {
            allScripts = allScripts.concat(globalSettings.regex.map(s => ({...s, _source: 'Global'})));
        } else if (Array.isArray(globalSettings.regex_scripts)) {
            allScripts = allScripts.concat(globalSettings.regex_scripts.map(s => ({...s, _source: 'Global_Old'})));
        }
    }

    const ctx = getContextCompat();
    let charId = ctx ? ctx.characterId : (typeof this_chid !== 'undefined' ? this_chid : undefined);
    const charList = (ctx && ctx.characters) ? ctx.characters : (typeof characters !== 'undefined' ? characters : null);
    if (charId !== undefined && charList && charList[charId] && charList[charId].data?.extensions?.regex_scripts) {
        allScripts = allScripts.concat(charList[charId].data.extensions.regex_scripts.map(s => ({...s, _source: 'Character'})));
    }

    const presetScripts = getTextGenPresetScripts();
    allScripts = allScripts.concat(presetScripts);

    let normalized = allScripts.map(normalizeScript);
    const active = normalized.filter(s => !s.disabled && s.enabled !== false && s._pattern);
    return active;
}

function applyScript(text, script, debugMode = false) {
    try {
        if (!script._pattern) return text;
        const re = new RegExp(script._pattern, script._flags);
        const newText = text.replace(re, script._replace);
        if (debugMode && newText !== text) {
            console.log(`%c   ⚡ [HIT] ${script._name}`, 'color: #0f0; font-weight: bold');
        }
        return newText;
    } catch (e) { return text; }
}

function renderText(rawText, isUser, scripts, depth, debugMode = false) {
    if (!rawText) return "";
    let text = rawText;
    
    if (debugMode) console.groupCollapsed(`📝 Msg (Depth: ${depth})`);

    scripts.forEach(script => {
        const p = script._placement;
        const isTarget = (!p || p.length === 0) || (isUser ? p.includes(1) : p.includes(2));
        
        let depthMatch = true;
        if (script._minDepth !== null && depth < script._minDepth) depthMatch = false;

        if (isTarget && depthMatch) {
            text = applyScript(text, script, debugMode);
        }
    });

    const converter = new showdown.Converter({ simpleLineBreaks: true, strikethrough: true, emoji: true, tables: true, literalMidWordUnderscores: true });
    let html = converter.makeHtml(text);
    
    if (debugMode) console.groupEnd();
    return html;
}

function getProcessedData() {
    const ctx = getContextCompat();
    const fullChat = ctx ? ctx.chat : (window.chat || []);
    if (!fullChat || fullChat.length === 0) return [];

    const activeScripts = getAllRegexScripts();
    const start = Math.max(0, settings.exportStart);
    const end = Math.min(fullChat.length - 1, settings.exportEnd);
    let data = [];
    let debugCounter = 0;

    for (let i = start; i <= end; i++) {
        const rawMsg = fullChat[i];
        if (!rawMsg) continue;

        const depth = fullChat.length - 1 - i;
        const isUser = rawMsg.is_user;
        if (isUser && !settings.exportUser) continue;
        if (!isUser && !settings.exportAI) continue;

        const name = rawMsg.name || (isUser ? "You" : "AI");
        
        const isDebug = debugCounter < 3;
        const htmlContent = renderText(rawMsg.mes || "", isUser, activeScripts, depth, isDebug);
        if (isDebug) debugCounter++;

        data.push({ index: i, speaker: name, isUser: isUser, html: htmlContent, text: rawMsg.mes || "" });
    }
    return data;
}

// [修复] 字数统计逻辑
function countTotalWords(data) { 
    let c = 0; 
    data.forEach(i => { 
        if (i.html) {
            // 使用 cleanHtml 提取纯文本长度，这样才能排除被正则隐藏的内容和HTML标签
            // 之前的 i.text 是 rawMsg，包含了所有隐藏内容
            c += cleanHtml(i.html, 'txt').length; 
        }
    }); 
    return c; 
}

// --- Exports ---
async function exportEPUB() {
    if (!window.JSZip || !window.showdown) { await loadDependencies(); if(!window.JSZip) return; }
    const chaptersData = getProcessedData();
    if (!chaptersData.length) return toastr.warning('无内容');
    const zip = new JSZip();
    const title = settings.title || "Chat2Ebook";
    const author = settings.author || "SillyTavern";
    const uuid = `urn:uuid:${Date.now()}`;
    const dateStr = new Date().toLocaleString();
    const totalWords = countTotalWords(chaptersData);
    const splitCount = settings.chapterSplit > 0 ? settings.chapterSplit : 1;
    const estimatedChapters = Math.ceil(chaptersData.length / splitCount);
    
    const fixXHTML = (html) => {
        if (!html) return "";
        return html.replace(/<br\s*\/?>/gi, "<br />").replace(/<hr\s*\/?>/gi, "<hr />").replace(/<img([^>]*)>/gi, (m,c)=>c.trim().endsWith('/')?m:`<img${c} />`);
    };

    const coverXhtml = `<?xml version="1.0" encoding="utf-8"?><!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml"><head><title>Cover</title><style>body{text-align:center;margin-top:30%;font-family:sans-serif;}</style></head><body><h1 style="font-size:2.5em;margin-bottom:0.5em;">${title}</h1><p style="font-size:1.5em;color:#555;">${author}</p></body></html>`;
    const infoXhtml = `<?xml version="1.0" encoding="utf-8"?><!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml"><head><title>Info</title><style>body{padding:10%;font-family:sans-serif;line-height:1.8;}</style></head><body><h2 style="border-bottom:1px solid #ccc;padding-bottom:10px;">书籍信息</h2><p><strong>书名：</strong> ${title}</p><p><strong>作者：</strong> ${author}</p><p><strong>章节数：</strong> 共 ${estimatedChapters} 章 (${chaptersData.length} 条对话)</p><p><strong>总字数：</strong> 约 ${totalWords} 字</p><p><strong>导出时间：</strong> ${dateStr}</p><p><strong>生成工具：</strong> Chat2Ebook</p></body></html>`;
    let currentMsgs = [];
    let chapterIndex = 1;
    const chapterFiles = [];
    
    for (let i = 0; i < chaptersData.length; i++) {
        currentMsgs.push(chaptersData[i]);
        if (currentMsgs.length >= splitCount || i === chaptersData.length - 1) {
            let bodyContent = '';
            const chapterTitle = `第 ${chapterIndex} 章`;
            if (splitCount > 1 || chapterIndex === 1) bodyContent += `<h2 style="text-align:center;margin-bottom:1.5em;color:#555">${chapterTitle}</h2><hr/>`;
            currentMsgs.forEach(ch => {
                const color = ch.isUser ? "#2c3e50" : "#800000";
                let speakerLabel = `<strong style="color:${color};display:block;margin-bottom:0.2em;">${ch.speaker}:</strong>`;
                if (settings.hideAIName && !ch.isUser) speakerLabel = '';
                const safeHtml = fixXHTML(cleanHtml(ch.html, 'epub'));
                bodyContent += `<div class="msg" style="margin-bottom:1.5em;">${speakerLabel}<div class="text" style="line-height:1.6;">${safeHtml}</div></div>`;
            });
            const xhtml = `<?xml version="1.0" encoding="utf-8"?><!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml"><head><title>${title}</title><style>body{font-family:sans-serif;padding:5%;}img{max-width:100%;}</style></head><body>${bodyContent}</body></html>`;
            chapterFiles.push({ id: `ch${chapterIndex}`, title: chapterTitle, filename: `chapter${chapterIndex}.xhtml`, content: xhtml });
            currentMsgs = [];
            chapterIndex++;
        }
    }
    zip.file("mimetype", "application/epub+zip", { compression: "STORE" });
    zip.folder("META-INF").file("container.xml", `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`);
    const oebps = zip.folder("OEBPS");
    oebps.file("cover.xhtml", coverXhtml);
    oebps.file("info.xhtml", infoXhtml);
    let manifest = `<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/><item id="cover" href="cover.xhtml" media-type="application/xhtml+xml"/><item id="info" href="info.xhtml" media-type="application/xhtml+xml"/>`;
    let spine = `<itemref idref="cover"/><itemref idref="info"/>`;
    let navMap = `<navPoint id="nav_cover" playOrder="0"><navLabel><text>封面</text></navLabel><content src="cover.xhtml"/></navPoint><navPoint id="nav_info" playOrder="0"><navLabel><text>信息页</text></navLabel><content src="info.xhtml"/></navPoint>`;
    chapterFiles.forEach((ch, idx) => {
        manifest += `<item id="${ch.id}" href="${ch.filename}" media-type="application/xhtml+xml"/>`;
        spine += `<itemref idref="${ch.id}"/>`;
        navMap += `<navPoint id="nav${idx+1}" playOrder="${idx+1}"><navLabel><text>${ch.title}</text></navLabel><content src="${ch.filename}"/></navPoint>`;
        oebps.file(ch.filename, ch.content);
    });
    const opf = `<?xml version="1.0" encoding="UTF-8"?><package xmlns="http://www.idpf.org/2007/opf" unique-identifier="BookID" version="2.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${title}</dc:title><dc:creator>${author}</dc:creator><dc:language>zh-CN</dc:language><dc:identifier id="BookID">${uuid}</dc:identifier></metadata><manifest>${manifest}</manifest><spine toc="ncx">${spine}</spine></package>`;
    oebps.file("content.opf", opf);
    oebps.file("toc.ncx", `<?xml version="1.0" encoding="UTF-8"?><ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><head><meta name="dtb:uid" content="${uuid}"/></head><docTitle><text>${title}</text></docTitle><navMap>${navMap}</navMap></ncx>`);
    zip.generateAsync({ type: "blob" }).then(c => downloadFile(c, `${title}.epub`, "application/octet-stream"));
    toastr.success(`EPUB 导出成功`);
}

function exportHTML() {
    if (!window.showdown) { loadDependencies().then(exportHTML); return; }
    const data = getProcessedData();
    if (!data.length) return toastr.warning('无内容');
    const dateStr = new Date().toLocaleString();
    const totalWords = countTotalWords(data);
    const estimatedChapters = Math.ceil(data.length / (settings.chapterSplit || 1));
    let coverHTML = `<div style="height:90vh;display:flex;flex-direction:column;justify-content:center;align-items:center;text-align:center;page-break-after:always;"><h1 style="font-size:3em;margin-bottom:20px;">${settings.title}</h1><p style="font-size:1.5em;color:#555;">${settings.author}</p></div>`;
    let infoHTML = `<div style="padding:40px;margin:40px auto;max-width:600px;border:1px solid #eee;border-radius:8px;page-break-after:always;"><h2 style="border-bottom:1px solid #ddd;padding-bottom:10px;">书籍信息</h2><p><strong>书名：</strong> ${settings.title}</p><p><strong>作者：</strong> ${settings.author}</p><p><strong>章节数：</strong> 共 ${estimatedChapters} 章 (${data.length} 条对话)</p><p><strong>总字数：</strong> 约 ${totalWords} 字</p><p><strong>导出时间：</strong> ${dateStr}</p></div>`;
    let chatHTML = `<div style="max-width:800px;margin:0 auto;">`;
    data.forEach(ch => {
        const bg = ch.isUser ? "#f0f0f0" : "#fff";
        const border = ch.isUser ? "1px solid #ddd" : "1px solid transparent";
        let label = (settings.hideAIName && !ch.isUser) ? "" : `<b style="color:${ch.isUser?'#2c3e50':'#900'}">${ch.speaker}:</b>`;
        const safeHtml = ch.html; 
        chatHTML += `<div style="padding:15px;margin-bottom:15px;background:${bg};border-radius:5px;border:${border}">${label}<div style="margin-top:5px;white-space:pre-wrap;line-height:1.6;">${safeHtml}</div></div>`;
    });
    chatHTML += "</div>";
    downloadFile(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>${settings.title}</title><style>body{font-family:'Segoe UI',sans-serif;padding:20px;}</style></head><body>${coverHTML + infoHTML + chatHTML}</body></html>`, `${settings.title}.html`, 'text/html');
}

async function exportDOCX() {
    if (!window.htmlDocx || !window.showdown) { await loadDependencies(); if(!window.htmlDocx) { toastr.error('DOCX组件加载失败'); return; } }
    const data = getProcessedData();
    if (!data.length) return toastr.warning('无内容');
    const dateStr = new Date().toLocaleString();
    const totalWords = countTotalWords(data);
    const estimatedChapters = Math.ceil(data.length / (settings.chapterSplit || 1));
    let content = `<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body><div style="text-align:center;margin-bottom:50px;"><h1 style="font-size:24pt;">${settings.title}</h1><p style="font-size:16pt;color:#555;">${settings.author}</p></div><br style="page-break-after:always;" /><div style="margin-bottom:50px;"><h2>书籍信息</h2><p><b>书名：</b> ${settings.title}</p><p><b>作者：</b> ${settings.author}</p><p><strong>章节数：</strong> 共 ${estimatedChapters} 章 (${data.length} 条对话)</p><p><strong>总字数：</strong> 约 ${totalWords} 字</p><p><b>导出时间：</b> ${dateStr}</p></div><br style="page-break-after:always;" />`;
    
    data.forEach(ch => {
        let label = (settings.hideAIName && !ch.isUser) ? "" : `<p style="margin-bottom:0;font-weight:bold;color:${ch.isUser ? '#2c3e50' : '#800000'}">${ch.speaker}:</p>`;
        const safeHtml = cleanHtml(ch.html, 'docx');
        content += `<div style="margin-bottom:12px;">${label}<div>${safeHtml}</div></div>`;
    });
    
    content += "</body></html>";
    try {
        const converted = window.htmlDocx.asBlob(content, { orientation: 'portrait', margins: { top: 720, right: 720, bottom: 720, left: 720 } });
        downloadFile(converted, `${settings.title}.docx`, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
        toastr.success('Word (.docx) 导出成功');
    } catch(e) { toastr.error('DOCX 生成失败'); }
}

function exportTXT() {
    if (!window.showdown) { loadDependencies().then(exportTXT); return; }
    const data = getProcessedData();
    if (!data.length) return toastr.warning('无内容');
    const dateStr = new Date().toLocaleString();
    const totalWords = countTotalWords(data);
    const estimatedChapters = Math.ceil(data.length / (settings.chapterSplit || 1));
    const separator = "=".repeat(30);
    let text = `\n${separator}\n      ${settings.title}\n      By ${settings.author}\n${separator}\n\n【书籍信息】\n书名：${settings.title}\n作者：${settings.author}\n章节数：共 ${estimatedChapters} 章 (${data.length} 条对话)\n总字数：约 ${totalWords} 字\n导出时间：${dateStr}\n生成工具：Chat2Ebook\n\n${separator}\n【正文开始】\n\n`;
    
    data.forEach(ch => {
        let label = (settings.hideAIName && !ch.isUser) ? "" : `${ch.speaker}:\n`;
        const cleanContent = cleanHtml(ch.html, 'txt');
        text += `${label}${cleanContent}\n\n${'-'.repeat(20)}\n\n`;
    });
    downloadFile(text, `${settings.title}.txt`, 'text/plain');
    toastr.success('TXT 导出成功');
}

// UI
function updateUI() {
    $('#c2e-title').val(settings.title);
    $('#c2e-author').val(settings.author);
    $('#c2e-start').val(settings.exportStart);
    $('#c2e-end').val(settings.exportEnd);
    $('#c2e-chapter-split').val(settings.chapterSplit);
    $('#c2e-user').prop('checked', settings.exportUser);
    $('#c2e-ai').prop('checked', settings.exportAI);
    $('#c2e-hide-ai-name').prop('checked', settings.hideAIName);
    updateTotalFloors();
}
function getTotalFloors() { const ctx = getContextCompat(); return (ctx && ctx.chat) ? ctx.chat.length : 0; }

function updateTotalFloors() { 
    $('#c2e-total-count').text(`共 ${getTotalFloors()} 条记录`); 
    const currentUser = getSTUserName();
    if (currentUser !== lastSystemUser) {
        if (settings.author === lastSystemUser || settings.author === "SillyTavern User") {
            settings.author = currentUser;
            $('#c2e-author').val(currentUser);
            saveSettingsDebounced();
        }
        lastSystemUser = currentUser;
    }
}

function createUI() {
    const html = `
    <div class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header"><b>📖 Chat2Ebook：所见即所得</b><div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div></div>
        <div class="inline-drawer-content">
            <div class="c2e-panel">
                <div id="c2e-total-count" style="text-align:center; margin-bottom:15px; background:rgba(0,0,0,0.2); padding:8px; border-radius:4px; font-size:0.9em;">统计中...</div>
                <div class="c2e-grid"><div class="c2e-input-group"><label>书名</label><input type="text" id="c2e-title" class="text_pole"></div><div class="c2e-input-group"><label>作者</label><input type="text" id="c2e-author" class="text_pole" placeholder="默认使用用户名"></div></div>
                <div class="c2e-grid"><div class="c2e-input-group"><label>起始楼层</label><input type="number" id="c2e-start" class="text_pole"></div><div class="c2e-input-group"><label>结束楼层</label><input type="number" id="c2e-end" class="text_pole"></div></div>
                <div class="c2e-grid"><div class="c2e-input-group"><label>EPUB 分章 (每章楼层数)</label><input type="number" id="c2e-chapter-split" class="text_pole" placeholder="默认 1"></div></div>
                <div class="c2e-vertical-group">
                    <label class="c2e-checkbox-label"><span class="fa-solid fa-user" style="width:16px; text-align:center;"></span><input type="checkbox" id="c2e-user"> 包含用户</label>
                    <label class="c2e-checkbox-label"><span class="fa-solid fa-robot" style="width:16px; text-align:center;"></span><input type="checkbox" id="c2e-ai"> 包含 AI</label>
                    <label class="c2e-checkbox-label" style="color:#ffaaaa;"><span class="fa-solid fa-eye-slash" style="width:16px; text-align:center;"></span><input type="checkbox" id="c2e-hide-ai-name"> 隐藏 AI 名</label>
                </div>
                <hr class="c2e-divider">
                <div class="c2e-section-title">电子书格式</div>
                <div class="c2e-btn-group"><div id="btn-epub" class="c2e-btn btn-primary">📱 EPUB</div><div id="btn-html" class="c2e-btn btn-primary">🌐 HTML</div></div>
                <div class="c2e-section-title">办公格式</div>
                <div class="c2e-btn-group"><div id="btn-word" class="c2e-btn btn-office">📘 Word (.docx)</div><div id="btn-txt" class="c2e-btn btn-txt">📄 TXT</div></div>
            </div>
        </div>
    </div>`;
    $('#extensions_settings').append(html);
    $('#c2e-title').on('input', function(){ settings.title = $(this).val(); saveSettingsDebounced(); });
    $('#c2e-author').on('input', function(){ settings.author = $(this).val(); saveSettingsDebounced(); });
    $('#c2e-start').on('change', function(){ settings.exportStart = Number($(this).val()); saveSettingsDebounced(); });
    $('#c2e-end').on('change', function(){ settings.exportEnd = Number($(this).val()); saveSettingsDebounced(); });
    $('#c2e-chapter-split').on('change', function(){ settings.chapterSplit = Number($(this).val()); saveSettingsDebounced(); });
    $('#c2e-user').on('change', function(){ settings.exportUser = $(this).prop('checked'); saveSettingsDebounced(); });
    $('#c2e-ai').on('change', function(){ settings.exportAI = $(this).prop('checked'); saveSettingsDebounced(); });
    $('#c2e-hide-ai-name').on('change', function(){ settings.hideAIName = $(this).prop('checked'); saveSettingsDebounced(); });
    $('#btn-epub').click(exportEPUB);
    $('#btn-html').click(exportHTML);
    $('#btn-word').click(exportDOCX);
    $('#btn-txt').click(exportTXT);
    setInterval(updateTotalFloors, 2000);
}

jQuery(async () => {
    extension_settings[extensionName] = extension_settings[extensionName] || {};
    settings = Object.assign({}, defaultSettings, extension_settings[extensionName]);
    const ctx = getContextCompat();
    
    // 初始化默认值
    if (!settings.title || settings.title === "Chat Export") settings.title = (ctx && ctx.name2) ? ctx.name2 : "Chat2Ebook";
    
    // 初始化作者名
    lastSystemUser = getSTUserName();
    if (!settings.author || settings.author === "SillyTavern User") settings.author = lastSystemUser;

    createUI();
    updateUI();
    loadDependencies();
    console.log('[Chat2Ebook] V0.0.2 Loaded');
});
