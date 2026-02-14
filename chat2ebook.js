import { saveSettingsDebounced } from "../../../../script.js";
import { extension_settings } from "../../../extensions.js";

const extensionName = "chat2ebook";
const JSZIP_URL = "https://npm.elemecdn.com/jszip@3.10.1/dist/jszip.min.js";

const defaultSettings = {
    title: "Chat2Ebook",
    author: "", 
    exportStart: 0,
    exportEnd: 99999,
    exportUser: false,
    exportAI: true,
    hideAIName: true,
    chapterSplit: 1
};

let settings = {};
let jszipLoaded = false;

// ==========================================
// 1. 基础工具 & 依赖加载
// ==========================================
async function loadDependencies() {
    if (window.JSZip) { jszipLoaded = true; return; }
    if (document.getElementById('c2e-loader-jszip')) return;

    const script = document.createElement('script');
    script.id = 'c2e-loader-jszip';
    script.src = JSZIP_URL;
    script.onload = () => { jszipLoaded = true; toastr.success('EPUB 组件加载完成'); };
    script.onerror = () => toastr.error('EPUB 组件加载失败，检查网络');
    document.head.appendChild(script);
}

function downloadFile(content, filename, mimeType) {
    const blob = content instanceof Blob ? content : new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

function getSTContext() {
    try {
        if (typeof SillyTavern !== 'undefined' && SillyTavern.getContext) return SillyTavern.getContext();
    } catch(e) {}
    if (typeof getContext === 'function') return getContext();
    return null;
}

function getSTUserName() {
    const ctx = getSTContext();
    return ctx ? (ctx.name1 || "User") : "User";
}

function countTotalWords(data) {
    let count = 0;
    data.forEach(item => {
        if (item.text) count += item.text.length;
    });
    return count;
}

// === 新增：XHTML 修复函数 (EPUB 专用) ===
function fixXHTML(html) {
    if (!html) return "";
    return html
        // 1. 强制闭合 <br> -> <br />
        .replace(/<br\s*\/?>/gi, "<br />")
        // 2. 强制闭合 <hr> -> <hr />
        .replace(/<hr\s*\/?>/gi, "<hr />")
        // 3. 强制闭合 <img> -> <img ... />
        // 浏览器 innerHTML 通常返回 <img src="...">，我们需要把它变成 <img src="..." />
        // 这里使用简单的正则替换，避免复杂的 DOM 解析
        .replace(/<img([^>]*)>/gi, (match, capture) => {
            if (capture.trim().endsWith('/')) return match; // 已经闭合了
            return `<img${capture} />`;
        });
}

// ==========================================
// 2. 核心：数据抓取
// ==========================================
function getChatData() {
    const ctx = getSTContext();
    const fullChat = ctx ? ctx.chat : [];
    const domMsgs = document.querySelectorAll('#chat .mes');
    
    if (!fullChat || fullChat.length === 0) {
        return getDomOnlyData(domMsgs);
    }

    const offset = fullChat.length - domMsgs.length;
    const start = Math.max(0, settings.exportStart);
    const end = Math.min(fullChat.length - 1, settings.exportEnd);

    let data = [];

    for (let i = start; i <= end; i++) {
        const rawMsg = fullChat[i];
        if (!rawMsg) continue;

        const isUser = rawMsg.is_user;
        if (isUser && !settings.exportUser) continue;
        if (!isUser && !settings.exportAI) continue;

        const name = rawMsg.name || (isUser ? "You" : "AI");
        let htmlContent = "";
        let textContent = rawMsg.mes || "";

        if (i >= offset) {
            const domIndex = i - offset;
            const domEl = domMsgs[domIndex];
            if (domEl) {
                const textEl = domEl.querySelector('.mes_text');
                if (textEl) {
                    if (textEl.innerHTML && textEl.innerHTML.trim() !== "") {
                        htmlContent = textEl.innerHTML;
                    }
                    if (textEl.innerText && textEl.innerText.trim() !== "") {
                        textContent = textEl.innerText;
                    }
                }
            }
        }

        // 兜底逻辑：手动构建 HTML
        if (!htmlContent) {
            htmlContent = (rawMsg.mes || "")
                .replace(/&/g, "&amp;")
                .replace(/</g, "&lt;")
                .replace(/>/g, "&gt;")
                .replace(/\n/g, "<br />"); // 修复：这里直接使用 <br />
        }

        data.push({
            index: i,
            speaker: name,
            isUser: isUser,
            html: htmlContent, // 注意：这里的 HTML 可能还是不规范的，在导出 EPUB 时会再次 fix
            text: textContent
        });
    }

    return data;
}

function getDomOnlyData(domMsgs) {
    let data = [];
    domMsgs.forEach((msg, index) => {
        const isUser = msg.getAttribute('is_user') === 'true';
        if (isUser && !settings.exportUser) return;
        if (!isUser && !settings.exportAI) return;

        const nameDiv = msg.querySelector('.ch_name .name_text') || msg.querySelector('.ch_name');
        const name = nameDiv ? nameDiv.innerText.trim() : (isUser ? "You" : "AI");
        const contentDiv = msg.querySelector('.mes_text');
        
        if (contentDiv) {
            data.push({
                index,
                speaker: name,
                isUser,
                html: contentDiv.innerHTML,
                text: contentDiv.innerText
            });
        }
    });
    return data;
}

// ==========================================
// 3. 导出格式实现
// ==========================================

// --- [A] EPUB ---
async function exportEPUB() {
    if (!window.JSZip) {
        toastr.info('EPUB 组件加载中...');
        await loadDependencies();
        return;
    }
    const chaptersData = getChatData();
    if (!chaptersData.length) return toastr.warning('无内容');

    const zip = new JSZip();
    const title = settings.title || "Chat2Ebook";
    const author = settings.author || "SillyTavern";
    const uuid = `urn:uuid:${Date.now()}`;
    const dateStr = new Date().toLocaleString();
    const totalWords = countTotalWords(chaptersData);
    const splitCount = settings.chapterSplit > 0 ? settings.chapterSplit : 1;
    const estimatedChapters = Math.ceil(chaptersData.length / splitCount);

    const chapterFiles = [];

    // --- 1. 封面页 (cover.xhtml) ---
    const coverXhtml = `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml">
<head><title>Cover</title><style>body{text-align:center; margin-top:30%; font-family:sans-serif;}</style></head>
<body>
    <h1 style="font-size:2.5em; margin-bottom:0.5em;">${title}</h1>
    <p style="font-size:1.5em; color:#555;">${author}</p>
</body></html>`;

    // --- 2. 信息页 (info.xhtml) ---
    const infoXhtml = `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml">
<head><title>Info</title><style>body{padding:10%; font-family:sans-serif; line-height:1.8;}</style></head>
<body>
    <h2 style="border-bottom:1px solid #ccc; padding-bottom:10px;">书籍信息</h2>
    <p><strong>书名：</strong> ${title}</p>
    <p><strong>作者：</strong> ${author}</p>
    <p><strong>章节数：</strong> 共 ${estimatedChapters} 章 (${chaptersData.length} 条对话)</p>
    <p><strong>总字数：</strong> 约 ${totalWords} 字</p>
    <p><strong>导出时间：</strong> ${dateStr}</p>
    <p><strong>生成工具：</strong> Chat2Ebook for SillyTavern</p>
</body></html>`;

    // --- 3. 正文分章 ---
    let currentMsgs = [];
    let chapterIndex = 1;

    for (let i = 0; i < chaptersData.length; i++) {
        currentMsgs.push(chaptersData[i]);
        if (currentMsgs.length >= splitCount || i === chaptersData.length - 1) {
            let bodyContent = '';
            const chapterTitle = `第 ${chapterIndex} 章`;
            
            if (splitCount > 1 || chapterIndex === 1) {
                bodyContent += `<h2 style="text-align:center; margin-bottom:1.5em; color:#555">${chapterTitle}</h2><hr/>`;
            }

            currentMsgs.forEach(ch => {
                const color = ch.isUser ? "#2c3e50" : "#800000";
                let speakerLabel = `<strong style="color:${color}; display:block; margin-bottom:0.2em;">${ch.speaker}:</strong>`;
                if (settings.hideAIName && !ch.isUser) speakerLabel = '';
                
                // 关键修复：在写入 EPUB 前，调用 fixXHTML 处理所有标签
                const safeHtml = fixXHTML(ch.html);
                
                bodyContent += `<div class="msg" style="margin-bottom: 1.5em;">${speakerLabel}<div class="text" style="line-height:1.6;">${safeHtml}</div></div>`;
            });

            const xhtml = `<?xml version="1.0" encoding="utf-8"?><!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml"><head><title>${title}</title><style>body{font-family:sans-serif;padding:5%;}img{max-width:100%;}</style></head><body>${bodyContent}</body></html>`;
            
            chapterFiles.push({ 
                id: `ch${chapterIndex}`, 
                title: chapterTitle, 
                filename: `chapter${chapterIndex}.xhtml`, 
                content: xhtml 
            });
            
            currentMsgs = [];
            chapterIndex++;
        }
    }

    // --- 打包 ---
    zip.file("mimetype", "application/epub+zip", { compression: "STORE" });
    zip.folder("META-INF").file("container.xml", `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`);
    const oebps = zip.folder("OEBPS");

    oebps.file("cover.xhtml", coverXhtml);
    oebps.file("info.xhtml", infoXhtml);

    let manifest = `
        <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
        <item id="cover" href="cover.xhtml" media-type="application/xhtml+xml"/>
        <item id="info" href="info.xhtml" media-type="application/xhtml+xml"/>
    `;
    let spine = `
        <itemref idref="cover"/>
        <itemref idref="info"/>
    `;
    let navMap = `
        <navPoint id="nav_cover" playOrder="0"><navLabel><text>封面</text></navLabel><content src="cover.xhtml"/></navPoint>
        <navPoint id="nav_info" playOrder="0"><navLabel><text>信息页</text></navLabel><content src="info.xhtml"/></navPoint>
    `;

    chapterFiles.forEach((ch, idx) => {
        manifest += `<item id="${ch.id}" href="${ch.filename}" media-type="application/xhtml+xml"/>`;
        spine += `<itemref idref="${ch.id}"/>`;
        navMap += `<navPoint id="nav${idx+1}" playOrder="${idx+1}"><navLabel><text>${ch.title}</text></navLabel><content src="${ch.filename}"/></navPoint>`;
        oebps.file(ch.filename, ch.content);
    });

    const opf = `<?xml version="1.0" encoding="UTF-8"?><package xmlns="http://www.idpf.org/2007/opf" unique-identifier="BookID" version="2.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${title}</dc:title><dc:creator>${author}</dc:creator><dc:language>zh-CN</dc:language><dc:identifier id="BookID">${uuid}</dc:identifier></metadata><manifest>${manifest}</manifest><spine toc="ncx">${spine}</spine></package>`;
    oebps.file("content.opf", opf);
    oebps.file("toc.ncx", `<?xml version="1.0" encoding="UTF-8"?><ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><head><meta name="dtb:uid" content="${uuid}"/></head><docTitle><text>${title}</text></docTitle><navMap>${navMap}</navMap></ncx>`);

    // 强制二进制流下载，防止手机改名
    zip.generateAsync({ type: "blob" }).then(c => downloadFile(c, `${title}.epub`, "application/octet-stream"));
    toastr.success(`EPUB 导出成功`);
}

// --- [B] HTML ---
function exportHTML() {
    const data = getChatData();
    if (!data.length) return toastr.warning('无内容');

    const dateStr = new Date().toLocaleString();
    const totalWords = countTotalWords(data);
    const splitCount = settings.chapterSplit > 0 ? settings.chapterSplit : 1;
    const estimatedChapters = Math.ceil(data.length / splitCount);

    let coverHTML = `
    <div style="height:90vh; display:flex; flex-direction:column; justify-content:center; align-items:center; text-align:center; page-break-after:always;">
        <h1 style="font-size:3em; margin-bottom:20px;">${settings.title}</h1>
        <p style="font-size:1.5em; color:#555;">${settings.author}</p>
    </div>
    `;

    let infoHTML = `
    <div style="padding:40px; margin:40px auto; max-width:600px; border:1px solid #eee; border-radius:8px; page-break-after:always;">
        <h2 style="border-bottom:1px solid #ddd; padding-bottom:10px;">书籍信息</h2>
        <p><strong>书名：</strong> ${settings.title}</p>
        <p><strong>作者：</strong> ${settings.author}</p>
        <p><strong>章节数：</strong> 共 ${estimatedChapters} 章 (${data.length} 条对话)</p>
        <p><strong>总字数：</strong> 约 ${totalWords} 字</p>
        <p><strong>导出时间：</strong> ${dateStr}</p>
        <p><strong>生成工具：</strong> Chat2Ebook for SillyTavern</p>
    </div>
    `;

    let chatHTML = `<div style="max-width:800px; margin:0 auto;">`;
    data.forEach(ch => {
        const bg = ch.isUser ? "#f0f0f0" : "#fff";
        const border = ch.isUser ? "1px solid #ddd" : "1px solid transparent";
        let label = (settings.hideAIName && !ch.isUser) ? "" : `<b style="color:${ch.isUser?'#2c3e50':'#900'}">${ch.speaker}:</b>`;
        chatHTML += `<div style="padding:15px;margin-bottom:15px;background:${bg};border-radius:5px;border:${border}">${label}<div style="margin-top:5px;white-space:pre-wrap;line-height:1.6;">${ch.html}</div></div>`;
    });
    chatHTML += "</div>";

    const fullBody = coverHTML + infoHTML + chatHTML;
    downloadFile(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>${settings.title}</title><style>body{font-family:'Segoe UI', sans-serif; padding:20px;}</style></head><body>${fullBody}</body></html>`, `${settings.title}.html`, 'text/html');
}

// --- [C] Word (MHTML) ---
function exportWord() {
    const data = getChatData();
    if (!data.length) return toastr.warning('无内容');

    const dateStr = new Date().toLocaleString();
    const totalWords = countTotalWords(data);
    const splitCount = settings.chapterSplit > 0 ? settings.chapterSplit : 1;
    const estimatedChapters = Math.ceil(data.length / splitCount);

    let bodyContent = `
    <div style="text-align:center; margin-top:200px;">
        <h1 style="font-size:36pt;">${settings.title}</h1>
        <p style="font-size:18pt; color:#555;">${settings.author}</p>
    </div>
    <br clear=all style='mso-special-character:line-break;page-break-before:always'>
    `;

    bodyContent += `
    <div style="margin:50px;">
        <h2>书籍信息</h2>
        <p><b>书名：</b> ${settings.title}</p>
        <p><b>作者：</b> ${settings.author}</p>
        <p><b>章节数：</b> 共 ${estimatedChapters} 章 (${data.length} 条对话)</p>
        <p><b>总字数：</b> 约 ${totalWords} 字</p>
        <p><b>导出时间：</b> ${dateStr}</p>
        <p><b>生成工具：</b> Chat2Ebook for SillyTavern</p>
    </div>
    <br clear=all style='mso-special-character:line-break;page-break-before:always'>
    `;

    data.forEach(ch => {
        let label = (settings.hideAIName && !ch.isUser) ? "" : `<p style="margin-bottom:5px; font-weight:bold; color:${ch.isUser ? '#2c3e50' : '#800000'}">${ch.speaker}:</p>`;
        bodyContent += `
            <div style="margin-bottom:15px;">
                ${label}
                <div>${ch.html}</div>
            </div>
            <br />
        `;
    });

    const mhtml = `
        <html xmlns:o='urn:schemas-microsoft-com:office:office' xmlns:w='urn:schemas-microsoft-com:office:word' xmlns='http://www.w3.org/TR/REC-html40'>
        <head>
            <meta charset="utf-8">
            <title>${settings.title}</title>
            <style>body { font-family: 'Microsoft YaHei', sans-serif; } img { max-width: 100%; }</style>
        </head>
        <body>${bodyContent}</body></html>
    `;

    downloadFile(mhtml, `${settings.title}.doc`, 'application/msword');
    toastr.success('Word 文档导出成功');
}

// --- [D] TXT ---
function exportTXT() {
    const data = getChatData();
    if (!data.length) return toastr.warning('无内容');

    const dateStr = new Date().toLocaleString();
    const totalWords = countTotalWords(data);
    const splitCount = settings.chapterSplit > 0 ? settings.chapterSplit : 1;
    const estimatedChapters = Math.ceil(data.length / splitCount);
    const separator = "=".repeat(30);

    let text = `
${separator}
      ${settings.title}
      By ${settings.author}
${separator}

【书籍信息】
书名：${settings.title}
作者：${settings.author}
章节数：共 ${estimatedChapters} 章 (${data.length} 条对话)
总字数：约 ${totalWords} 字
导出时间：${dateStr}
生成工具：Chat2Ebook for SillyTavern

${separator}
【正文开始】

`;
    
    data.forEach(ch => {
        let label = (settings.hideAIName && !ch.isUser) ? "" : `${ch.speaker}:\n`;
        text += `${label}${ch.text}\n\n${'-'.repeat(20)}\n\n`;
    });
    
    downloadFile(text, `${settings.title}.txt`, 'text/plain');
    toastr.success('TXT 导出成功');
}

// ==========================================
// 4. UI 构建
// ==========================================
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

function getTotalFloors() {
    const ctx = getSTContext();
    if (ctx && ctx.chat) return ctx.chat.length;
    return document.querySelectorAll('#chat .mes').length;
}

function updateTotalFloors() {
    const full = getTotalFloors();
    const dom = document.querySelectorAll('#chat .mes').length;
    let text = `当前已加载 ${dom} 条 (共 ${full} 条)`;
    
    if (dom < full) {
        text += `<div style="color:#990000; font-size:11px; margin-top:5px; line-height:1.4;">请手动向上滚动加载并渲染聊天记录，<br>以免导出丢失正则和渲染。</div>`;
    } else {
        text += `<div style="color:#99ff99; font-size:11px; margin-top:5px;">✅ 所有楼层已就绪</div>`;
    }
    $('#c2e-total-count').html(text);
}

function createUI() {
    const html = `
    <div class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header">
            <b>📖 Chat2Ebook：所见即所得</b>
            <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content">
            <div class="c2e-panel">
                <div id="c2e-total-count" style="text-align:center; margin-bottom:15px; background:rgba(0,0,0,0.2); padding:8px; border-radius:4px;">统计中...</div>
                
                <div class="c2e-grid">
                    <div class="c2e-input-group"><label>书名</label><input type="text" id="c2e-title" class="text_pole"></div>
                    <div class="c2e-input-group"><label>作者</label><input type="text" id="c2e-author" class="text_pole" placeholder="默认使用用户名"></div>
                </div>
                <div class="c2e-grid">
                    <div class="c2e-input-group"><label>起始楼层</label><input type="number" id="c2e-start" class="text_pole"></div>
                    <div class="c2e-input-group"><label>结束楼层</label><input type="number" id="c2e-end" class="text_pole"></div>
                </div>
                <div class="c2e-grid"><div class="c2e-input-group"><label>EPUB 分章 (每章楼层数)</label><input type="number" id="c2e-chapter-split" class="text_pole" placeholder="默认 1"></div></div>

                <div class="c2e-vertical-group">
                    <label class="c2e-checkbox-label">
                        <span class="fa-solid fa-user" style="width:16px; text-align:center;"></span>
                        <input type="checkbox" id="c2e-user"> 包含用户
                    </label>
                    <label class="c2e-checkbox-label">
                        <span class="fa-solid fa-robot" style="width:16px; text-align:center;"></span>
                        <input type="checkbox" id="c2e-ai"> 包含 AI
                    </label>
                    <label class="c2e-checkbox-label" style="color:#ffaaaa;">
                        <span class="fa-solid fa-eye-slash" style="width:16px; text-align:center;"></span>
                        <input type="checkbox" id="c2e-hide-ai-name"> 隐藏 AI 名
                    </label>
                </div>

                <hr class="c2e-divider">

                <div class="c2e-section-title">电子书格式</div>
                <div class="c2e-btn-group">
                    <div id="btn-epub" class="c2e-btn btn-primary">📱 EPUB</div>
                    <div id="btn-html" class="c2e-btn btn-primary">🌐 HTML</div>
                </div>
                
                <div class="c2e-section-title">办公格式</div>
                <div class="c2e-btn-group">
                    <div id="btn-word" class="c2e-btn btn-office">📘 Word</div>
                    <div id="btn-txt" class="c2e-btn btn-txt">📄 TXT</div>
                </div>
            </div>
        </div>
    </div>`;

    $('#extensions_settings').append(html);

    // Bindings
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
    $('#btn-word').click(exportWord);
    $('#btn-txt').click(exportTXT);

    setInterval(updateTotalFloors, 2000);
}

jQuery(async () => {
    extension_settings[extensionName] = extension_settings[extensionName] || {};
    settings = Object.assign({}, defaultSettings, extension_settings[extensionName]);
    
    if (!settings.title || settings.title === "Chat Export") {
        settings.title = "Chat2Ebook";
    }
    if (!settings.author || settings.author === "SillyTavern User") {
        settings.author = getSTUserName();
    }

    createUI();
    updateUI();
    loadDependencies();
    console.log('[Chat2Ebook] V0.0.1 Loaded');
});
