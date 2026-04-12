/**
 * XHS Article-to-Image Renderer
 *
 * Converts markdown article content into multiple XiaoHongShu-style
 * PNG image cards (1080×1440, 3:4 portrait) using Playwright.
 *
 * Input: JSON via argv[2] with { pages, title, author, accentColor, bgColor, outputDir, coverImage }
 * Output: PNG files written to outputDir, JSON result to stdout.
 */
import { chromium } from 'playwright';
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, resolve } from 'path';

const WIDTH = 1080;
const HEIGHT = 1440;

const input = JSON.parse(process.argv[2]);
const {
  pages,
  title = 'Untitled',
  author = '',
  accentColor = '#1a1a1a',
  bgColor = '#fafaf8',
  outputDir,
  coverImage = '',
} = input;

mkdirSync(outputDir, { recursive: true });

/**
 * Generate the HTML for the cover (first) page.
 *
 * @param {string} title - Article title
 * @param {string} author - Author name
 * @param {string} accentColor - Accent color hex
 * @param {string} bgColor - Background color hex
 * @param {string} coverImage - Optional cover image URL/path
 * @param {number} totalPages - Total page count
 * @returns {string} Complete HTML string
 */
function buildCoverHTML(title, author, accentColor, bgColor, coverImage, totalPages) {
  const imageBlock = coverImage
    ? `<div class="cover-image"><img src="${coverImage}" alt="cover" /></div>`
    : '';

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
${getBaseStyles(bgColor, accentColor)}

.cover-container {
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: center;
  height: 100%;
  padding: 100px 80px;
  box-sizing: border-box;
  text-align: center;
}

.cover-decoration-top {
  width: 60px;
  height: 4px;
  background: ${accentColor};
  margin-bottom: 50px;
  border-radius: 2px;
}

.cover-title {
  font-size: 72px;
  font-weight: 900;
  line-height: 1.4;
  color: ${accentColor};
  letter-spacing: -1px;
  margin-bottom: 40px;
  max-width: 900px;
  word-break: break-word;
  padding: 0 20px;
}

.cover-container::before {
  content: '';
  position: absolute;
  top: 0; left: 0; right: 0; height: 15px;
  background: ${accentColor};
}

.cover-decoration-bottom {
  width: 120px;
  height: 2px;
  background: ${accentColor}33;
  margin-bottom: 40px;
}

.cover-author {
  font-size: 28px;
  color: #888;
  font-weight: 400;
  letter-spacing: 2px;
}

.cover-image {
  width: 100%;
  max-width: 700px;
  margin-bottom: 50px;
  border-radius: 16px;
  overflow: hidden;
}

.cover-image img {
  width: 100%;
  height: auto;
  display: block;
  object-fit: cover;
  max-height: 500px;
}

.page-indicator {
  position: absolute;
  bottom: 50px;
  right: 80px;
  font-size: 22px;
  color: #ccc;
  font-weight: 300;
}
</style>
</head>
<body>
<div class="cover-container">
  <div class="cover-decoration-top"></div>
  ${imageBlock}
  <div class="cover-title">${escapeHTML(title)}</div>
  <div class="cover-decoration-bottom"></div>
  ${author ? `<div class="cover-author">${escapeHTML(author)}</div>` : ''}
</div>
<div class="page-indicator">1 / ${totalPages}</div>
</body>
</html>`;
}

/**
 * Generate the HTML for a content page.
 *
 * @param {string} contentHTML - Pre-rendered HTML content for this page
 * @param {number} pageNum - Current page number (1-based)
 * @param {number} totalPages - Total page count
 * @param {string} title - Article title (shown as header)
 * @param {string} accentColor - Accent color hex
 * @param {string} bgColor - Background color hex
 * @returns {string} Complete HTML string
 */
function buildContentPageHTML(contentHTML, pageNum, totalPages, title, accentColor, bgColor) {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
${getBaseStyles(bgColor, accentColor)}

.page-header {
  padding: 60px 80px 0 80px;
  display: flex;
  align-items: center;
  gap: 16px;
}

.page-header-line {
  width: 30px;
  height: 3px;
  background: ${accentColor};
  border-radius: 2px;
  flex-shrink: 0;
}

.page-header-title {
  font-size: 20px;
  font-weight: 600;
  color: #bbb;
  letter-spacing: 1px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.content-area {
  padding: 40px 80px 80px 80px;
  flex: 1;
}

.content-area h2 {
  font-size: 42px;
  font-weight: 800;
  color: ${accentColor};
  margin: 0 0 28px 0;
  line-height: 1.35;
  letter-spacing: -0.5px;
}

.content-area h3 {
  font-size: 34px;
  font-weight: 700;
  color: ${accentColor};
  margin: 0 0 22px 0;
  line-height: 1.35;
}

.content-area p {
  font-size: 30px;
  line-height: 1.75;
  color: #333;
  margin: 0 0 24px 0;
  font-weight: 400;
}

.content-area ul, .content-area ol {
  padding-left: 40px;
  margin: 0 0 24px 0;
}

.content-area li {
  font-size: 30px;
  line-height: 1.7;
  color: #333;
  margin-bottom: 12px;
}

.content-area strong {
  font-weight: 700;
  color: ${accentColor};
}

.content-area em {
  font-style: italic;
  color: #555;
}

.content-area blockquote {
  border-left: 4px solid ${accentColor}44;
  margin: 0 0 24px 0;
  padding: 16px 24px;
  background: ${accentColor}08;
  border-radius: 0 12px 12px 0;
}

.content-area blockquote p {
  font-size: 28px;
  color: #555;
  margin: 0;
  font-style: italic;
}

.content-area img {
  max-width: 100%;
  border-radius: 12px;
  margin: 16px 0;
}

.content-area code {
  background: #f0f0f0;
  padding: 2px 8px;
  border-radius: 4px;
  font-size: 26px;
  font-family: 'SF Mono', 'Menlo', monospace;
}

.page-indicator {
  position: absolute;
  bottom: 50px;
  right: 80px;
  font-size: 22px;
  color: #ccc;
  font-weight: 300;
}

.page-footer-decoration {
  position: absolute;
  bottom: 45px;
  left: 80px;
  width: 40px;
  height: 3px;
  background: ${accentColor}22;
  border-radius: 2px;
}
</style>
</head>
<body>
<div class="page-header">
  <div class="page-header-line"></div>
  <div class="page-header-title">${escapeHTML(title)}</div>
</div>
<div class="content-area">
  ${contentHTML}
</div>
<div class="page-footer-decoration"></div>
<div class="page-indicator">${pageNum} / ${totalPages}</div>
</body>
</html>`;
}

/**
 * Shared base CSS styles for all pages.
 *
 * @param {string} bgColor - Background color
 * @param {string} accentColor - Accent/text color
 * @returns {string} CSS string
 */
function getBaseStyles(bgColor, accentColor) {
  return `
@import url('https://fonts.googleapis.com/css2?family=Noto+Sans+SC:wght@300;400;500;600;700;800;900&display=swap');

* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}

body {
  width: ${WIDTH}px;
  height: ${HEIGHT}px;
  background: ${bgColor};
  font-family: 'Noto Sans SC', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', -apple-system, BlinkMacSystemFont, sans-serif;
  overflow: hidden;
  position: relative;
}
`;
}

/**
 * Escape HTML special characters.
 *
 * @param {string} str - Raw string
 * @returns {string} Escaped HTML string
 */
function escapeHTML(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Simple markdown to HTML converter.
 * Handles: h1-h3, bold, italic, lists, blockquotes, images, links, code, paragraphs.
 *
 * @param {string} md - Markdown text
 * @returns {string} HTML string
 */
function markdownToHTML(md) {
  let html = md;

  // Images: ![alt](url)
  html = html.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1" />');

  // Links: [text](url) → just text (no clickable links in images)
  html = html.replace(/\[([^\]]+)\]\([^)]+\)/g, '<strong>$1</strong>');

  // Bold: **text** or __text__
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/__(.+?)__/g, '<strong>$1</strong>');

  // Italic: *text* or _text_
  html = html.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '<em>$1</em>');
  html = html.replace(/(?<!_)_(?!_)(.+?)(?<!_)_(?!_)/g, '<em>$1</em>');

  // Inline code: `code`
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

  // Process line by line
  const lines = html.split('\n');
  const result = [];
  let inList = false;
  let listType = '';
  let inBlockquote = false;
  let blockquoteLines = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // End blockquote
    if (inBlockquote && !trimmed.startsWith('>')) {
      result.push(`<blockquote><p>${blockquoteLines.join('<br/>')}</p></blockquote>`);
      blockquoteLines = [];
      inBlockquote = false;
    }

    // End list
    if (inList && !trimmed.match(/^[-*]\s/) && !trimmed.match(/^\d+\.\s/) && trimmed !== '') {
      result.push(listType === 'ul' ? '</ul>' : '</ol>');
      inList = false;
    }

    // Skip empty lines
    if (trimmed === '') {
      if (inList) {
        result.push(listType === 'ul' ? '</ul>' : '</ol>');
        inList = false;
      }
      continue;
    }

    // Headers (skip h1 — it's the title, shown on cover)
    if (trimmed.startsWith('### ')) {
      result.push(`<h3>${trimmed.slice(4)}</h3>`);
    } else if (trimmed.startsWith('## ')) {
      result.push(`<h2>${trimmed.slice(3)}</h2>`);
    } else if (trimmed.startsWith('# ')) {
      // Skip h1 (title page handles it)
      continue;
    }
    // Blockquote
    else if (trimmed.startsWith('>')) {
      inBlockquote = true;
      blockquoteLines.push(trimmed.slice(1).trim());
    }
    // Unordered list
    else if (trimmed.match(/^[-*]\s/)) {
      if (!inList || listType !== 'ul') {
        if (inList) result.push(listType === 'ul' ? '</ul>' : '</ol>');
        result.push('<ul>');
        inList = true;
        listType = 'ul';
      }
      result.push(`<li>${trimmed.slice(2)}</li>`);
    }
    // Ordered list
    else if (trimmed.match(/^\d+\.\s/)) {
      if (!inList || listType !== 'ol') {
        if (inList) result.push(listType === 'ul' ? '</ul>' : '</ol>');
        result.push('<ol>');
        inList = true;
        listType = 'ol';
      }
      result.push(`<li>${trimmed.replace(/^\d+\.\s/, '')}</li>`);
    }
    // Horizontal rule → page break hint (handled at split level)
    else if (trimmed.match(/^[-*_]{3,}$/)) {
      result.push('<hr/>');
    }
    // Paragraph
    else {
      result.push(`<p>${trimmed}</p>`);
    }
  }

  // Close any open structures
  if (inBlockquote) {
    result.push(`<blockquote><p>${blockquoteLines.join('<br/>')}</p></blockquote>`);
  }
  if (inList) {
    result.push(listType === 'ul' ? '</ul>' : '</ol>');
  }

  return result.join('\n');
}

/**
 * Split markdown content into pages.
 * Splits on --- (horizontal rules) first, then by approximate character count.
 *
 * @param {string} markdown - Full markdown (without title line)
 * @param {number} maxChars - Max chars per page
 * @returns {string[]} Array of markdown chunks, one per page
 */
function splitIntoPages(markdown, maxChars) {
  // First split on explicit --- page breaks
  const explicitSections = markdown.split(/\n---\n/).filter((s) => s.trim());

  const pages = [];

  for (const section of explicitSections) {
    // If section fits, keep as one page
    if (section.length <= maxChars) {
      pages.push(section.trim());
      continue;
    }

    // Split further by paragraphs (double newline)
    const blocks = section.split(/\n\n/).filter((b) => b.trim());
    let currentPage = '';

    for (const block of blocks) {
      // If adding this block exceeds limit, start a new page
      if (currentPage.length > 0 && currentPage.length + block.length > maxChars) {
        pages.push(currentPage.trim());
        currentPage = block;
      } else {
        currentPage += (currentPage ? '\n\n' : '') + block;
      }
    }

    if (currentPage.trim()) {
      pages.push(currentPage.trim());
    }
  }

  return pages.length > 0 ? pages : [markdown.trim()];
}

/**
 * Extract the title from markdown content (first # heading).
 *
 * @param {string} markdown - Full markdown content
 * @returns {{ title: string, body: string }} Extracted title and remaining body
 */
function extractTitle(markdown) {
  const lines = markdown.split('\n');
  let title = '';
  let bodyStart = 0;

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith('# ') && !trimmed.startsWith('## ')) {
      title = trimmed.slice(2).trim();
      bodyStart = i + 1;
      break;
    }
    if (trimmed !== '') {
      // No h1 found before content — use first non-empty line
      break;
    }
  }

  const body = lines.slice(bodyStart).join('\n').trim();
  return { title, body };
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const totalContentPages = pages.length;
  const totalPages = totalContentPages + 1; // +1 for cover

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: WIDTH, height: HEIGHT },
    deviceScaleFactor: 2, // Retina for crisp text
  });

  const filePaths = [];

  try {
    // Page 1: Cover
    const coverHTML = buildCoverHTML(title, author, accentColor, bgColor, coverImage, totalPages);
    const coverPage = await context.newPage();
    await coverPage.setContent(coverHTML, { waitUntil: 'networkidle' });
    // Wait for fonts to load
    await coverPage.waitForTimeout(500);
    const coverPath = join(outputDir, 'page-01.png');
    await coverPage.screenshot({ path: coverPath, type: 'png' });
    filePaths.push(coverPath);
    await coverPage.close();

    // Content pages
    for (let i = 0; i < pages.length; i++) {
      const pageNum = i + 2; // 1-based, after cover
      const contentHTML = markdownToHTML(pages[i]);
      const pageHTML = buildContentPageHTML(
        contentHTML,
        pageNum,
        totalPages,
        title,
        accentColor,
        bgColor
      );

      const contentPage = await context.newPage();
      await contentPage.setContent(pageHTML, { waitUntil: 'networkidle' });
      await contentPage.waitForTimeout(300);

      const pagePath = join(outputDir, `page-${String(pageNum).padStart(2, '0')}.png`);
      await contentPage.screenshot({ path: pagePath, type: 'png' });
      filePaths.push(pagePath);
      await contentPage.close();
    }
  } finally {
    await browser.close();
  }

  return {
    success: true,
    totalPages,
    files: filePaths,
    dimensions: { width: WIDTH, height: HEIGHT },
    outputDir: resolve(outputDir),
  };
}

main()
  .then((result) => {
    console.log(JSON.stringify(result));
    process.exit(0);
  })
  .catch((err) => {
    console.error(JSON.stringify({ success: false, error: err.message }));
    process.exit(1);
  });
