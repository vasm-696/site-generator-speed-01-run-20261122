// A faster drop-in for makefun-site 1.0.0, written from its README and reference
// behaviour. Same outputs, byte for byte; different machinery underneath:
//  - Markdown is rendered in one pass over the lines (no token array, no
//    per-character escape calls: inline text is copied in slices and only the
//    few special characters are handled).
//  - Templates are compiled once per case into small JS functions (new
//    Function) instead of being tree-walked on every page render. Scopes are
//    prototype-chained objects, which reproduces the reference's
//    nearest-scope lookup, including `loop` shadowing the loop variable.
//  - slugify / long-date results are memoised per case; word counting scans
//    without allocating a words array.
// Nothing is cached from one case to the next: every run() call rebuilds its
// caches, templates and state from its input alone.

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_RE = /[&<>"']/g;
const RESERVED = ['posts', 'tags', 'page'];

const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

let slugCache;
let dateCache;

function esc(s) {
  return s.replace(ESC_RE, (c) => ESCAPES[c]);
}

// ---------------------------------------------------------------- text

function slugifyRaw(text) {
  let plain = text;
  let ascii = true;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) >= 128) { ascii = false; break; }
  }
  // NFKD is the identity on ASCII, and ASCII holds no combining marks.
  if (!ascii) plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
  let out = '';
  let gap = false;
  for (let i = 0; i < plain.length; i++) {
    const ch = plain[i];
    let keep = null;
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === null) { gap = out.length > 0; continue; }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  out = out.slice(0, 64).replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}

function slugify(text) {
  const c = slugCache.get(text);
  if (c !== undefined) return c;
  const s = slugifyRaw(text);
  slugCache.set(text, s);
  return s;
}

function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

function longDate(date) {
  let v = dateCache.get(date);
  if (v !== undefined) return v;
  const p = date.split('-');
  v = `${Number(p[2])} ${MONTHS[Number(p[1]) - 1]} ${p[0]}`;
  dateCache.set(date, v);
  return v;
}

/** Runs of non-whitespace characters, counted without allocating. */
function wordsOf(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    const ws = c === 32 || c === 9 || c === 10 || c === 11 || c === 12 || c === 13 ||
      c === 160 || c === 5760 || (c >= 8192 && c <= 8202) || c === 8232 || c === 8233 ||
      c === 8239 || c === 8287 || c === 12288 || c === 65279;
    if (ws) inWord = false;
    else if (!inWord) { inWord = true; n++; }
  }
  return n;
}

// ---------------------------------------------------------------- front matter

const KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];
const LINE = /^([a-z_]+):(?: (.*))?$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const NAME = /^[a-z0-9-]+$/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TAG = /^[^"[\]]+$/;
const BLANK = /^[ \t]*$/;

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

function stringOf(raw) {
  if (raw[0] === '"') {
    if (raw.length < 2 || raw[raw.length - 1] !== '"') return { error: 'a quoted string is not closed' };
    const out = [];
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out.push(n);
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out.push(c);
    }
    return { value: out.join('') };
  }
  if (raw[0] === '[') return { error: 'a bare string opens on [' };
  return { value: raw };
}

function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = DATE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (!raw.startsWith('[') || !raw.endsWith(']')) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      if (tags.some((t) => t === '' || !TAG.test(t))) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return NAME.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return SLUG.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

function parseFrontMatter(text) {
  const nl = text.indexOf('\n');
  const first = nl === -1 ? text : text.slice(0, nl);
  if (first !== '---') return { error: 'no front matter' };
  // Find the closing --- line.
  let pos = nl === -1 ? text.length : nl + 1;
  let closeStart = -1;
  let closeEnd = -1;
  while (pos < text.length) {
    const e = text.indexOf('\n', pos);
    const line = e === -1 ? text.slice(pos) : text.slice(pos, e);
    if (line === '---') { closeStart = pos; closeEnd = e; break; }
    pos = e === -1 ? text.length : e + 1;
  }
  if (closeStart === -1) return { error: 'the front matter is not closed' };
  const data = {};
  let region = text.slice(nl === -1 ? text.length : nl + 1, closeStart);
  if (region.endsWith('\n')) region = region.slice(0, -1);
  const fmLines = region === '' ? [] : region.split('\n');
  for (let k = 0; k < fmLines.length; k++) {
    const line = fmLines[k];
    const lineNo = k + 2;
    if (line === '' || ((line[0] === ' ' || line[0] === '\t') && BLANK.test(line)) || line[0] === '#') continue;
    const m = LINE.exec(line);
    if (!m) return { error: `line ${lineNo} is not "key: value"` };
    const key = m[1];
    const raw = (m[2] ?? '').replace(/[ \t]+$/, '');
    if (!KEYS.includes(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: closeEnd === -1 ? '' : text.slice(closeEnd + 1) };
}

// ---------------------------------------------------------------- markdown

const FENCE_OPEN = /^```([A-Za-z0-9_+-]*)[ \t]*$/;
const FENCE_CLOSE = /^```[ \t]*$/;
const HEADING = /^(#{1,6})[ \t]+(.*?)[ \t]*$/;
const HR = /^(?:---|\*\*\*)[ \t]*$/;
const BULLET = /^[-*] (.*)$/;
const ORDERED = /^(\d{1,9})\. (.*)$/;
const CONTINUED = /^ {2,}\S/;
const INLINE_RE = /[\\`*\[&<>"']/g;
const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);

function headingOf(line) {
  const m = HEADING.exec(line);
  return m === null || m[2] === '' ? null : { depth: m[1].length, text: m[2] };
}

function endsParagraph(line) {
  if (line === '') return true;
  const c = line[0];
  if ((c === ' ' || c === '\t') && BLANK.test(line)) return true;
  if (c === '`' && FENCE_OPEN.test(line)) return true;
  if (c === '#' && headingOf(line) !== null) return true;
  if ((c === '-' || c === '*') && HR.test(line)) return true;
  return false;
}

/** Spaces/tabs at either end dropped, without a regex or a copy when unneeded. */
function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return a === 0 && b === line.length ? line : line.slice(a, b);
}

function findUnescaped(s, what, from) {
  for (let j = from; j <= s.length - what.length; j++) {
    if (s[j] === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

function findSingleStar(s, from) {
  for (let j = from; j < s.length; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (c !== '*') continue;
    if (s[j + 1] === '*') {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

/** Inline rendering of `s`, appended to `out`. `link` resolves link targets. */
function inline(s, link, out) {
  let i = 0;
  const n = s.length;
  while (i < n) {
    INLINE_RE.lastIndex = i;
    const m = INLINE_RE.exec(s);
    const j = m ? m.index : n;
    if (j > i) out.push(s.slice(i, j));
    if (j >= n) { i = n; break; }
    const c = s[j];
    if (c === '&') { out.push('&amp;'); i = j + 1; }
    else if (c === '<') { out.push('&lt;'); i = j + 1; }
    else if (c === '>') { out.push('&gt;'); i = j + 1; }
    else if (c === '"') { out.push('&quot;'); i = j + 1; }
    else if (c === "'") { out.push('&#39;'); i = j + 1; }
    else if (c === '\\') {
      if (j + 1 < n && ESCAPABLE.has(s[j + 1])) {
        const ch = s[j + 1];
        out.push(ch === '>' ? '&gt;' : ch);
        i = j + 2;
      } else {
        out.push('\\');
        i = j + 1;
      }
    } else if (c === '`') {
      const k = s.indexOf('`', j + 1);
      if (k > j + 1) {
        out.push('<code>');
        out.push(esc(s.slice(j + 1, k)));
        out.push('</code>');
        i = k + 1;
      } else {
        out.push('`');
        i = j + 1;
      }
    } else if (c === '*') {
      if (s[j + 1] === '*') {
        const k = findUnescaped(s, '**', j + 2);
        if (k > j + 2) {
          out.push('<strong>');
          inline(s.slice(j + 2, k), link, out);
          out.push('</strong>');
          i = k + 2;
        } else {
          out.push('**');
          i = j + 2;
        }
      } else {
        const k = findSingleStar(s, j + 1);
        if (k > j + 1) {
          out.push('<em>');
          inline(s.slice(j + 1, k), link, out);
          out.push('</em>');
          i = k + 1;
        } else {
          out.push('*');
          i = j + 1;
        }
      }
    } else if (c === '[') {
      const k = findUnescaped(s, ']', j + 1);
      const mm = (k !== -1 && s[k + 1] === '(') ? s.indexOf(')', k + 2) : -1;
      const target = mm === -1 ? '' : s.slice(k + 2, mm);
      if (target !== '' && !/\s/.test(target)) {
        out.push('<a href="');
        out.push(esc(link(target)));
        out.push('">');
        inline(s.slice(j + 1, k), link, out);
        out.push('</a>');
        i = mm + 1;
      } else {
        out.push('[');
        i = j + 1;
      }
    }
  }
}

function renderMarkdown(src, link) {
  const lines = src.split('\n');
  const out = [];
  const toc = [];
  let excerpt = '';
  let hasExcerpt = false;
  const ids = new Set();
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i];
    if (line === '' || ((line[0] === ' ' || line[0] === '\t') && BLANK.test(line))) { i++; continue; }
    if (line.startsWith('```')) {
      const fence = FENCE_OPEN.exec(line);
      if (fence !== null) {
        i++;
        const body = [];
        while (i < n && !FENCE_CLOSE.test(lines[i])) body.push(lines[i++]);
        i++;
        out.push('<pre><code' + (fence[1] === '' ? '' : ' class="language-' + esc(fence[1]) + '"') + '>');
        if (body.length > 0) out.push(esc(body.join('\n')) + '\n');
        out.push('</code></pre>\n');
        continue;
      }
    }
    if (line[0] === '#') {
      const hd = headingOf(line);
      if (hd !== null) {
        const id = uniqueSlug(slugify(hd.text), ids);
        if (hd.depth === 2 || hd.depth === 3) {
          const tmp = [];
          inline(hd.text, link, tmp);
          const html = tmp.join('');
          out.push(`<h${hd.depth} id="${id}">${html}</h${hd.depth}>\n`);
          toc.push({ level: hd.depth, id, html });
        } else {
          out.push(`<h${hd.depth} id="${id}">`);
          inline(hd.text, link, out);
          out.push(`</h${hd.depth}>\n`);
        }
        i++;
        continue;
      }
    }
    if ((line[0] === '-' || line[0] === '*') && HR.test(line)) { out.push('<hr>\n'); i++; continue; }
    if (line[0] === '>') {
      const body = [];
      while (i < n && lines[i][0] === '>') body.push(lines[i++].replace(/^> ?/, ''));
      const kept = [];
      for (const l of body) {
        const t = trimLine(l);
        if (t !== '') kept.push(t);
      }
      if (kept.length === 0) out.push('<blockquote>\n</blockquote>\n');
      else {
        out.push('<blockquote>\n<p>');
        inline(kept.join('\n'), link, out);
        out.push('</p>\n</blockquote>\n');
      }
      continue;
    }
    const bullet = (line[0] === '-' || line[0] === '*') ? BULLET.exec(line) : null;
    const ordered = bullet === null && line[0] >= '0' && line[0] <= '9' ? ORDERED.exec(line) : null;
    if (bullet !== null || ordered !== null) {
      const isOrdered = ordered !== null;
      const marker = isOrdered ? ORDERED : BULLET;
      const items = [];
      let start = 1;
      if (isOrdered) start = Number(ordered[1]);
      while (i < n) {
        const mm = marker.exec(lines[i]);
        if (mm !== null) {
          items.push([trimLine(isOrdered ? mm[2] : mm[1])]);
          i++;
        } else if (lines[i][0] === ' ' && lines[i][1] === ' ' && CONTINUED.test(lines[i])) {
          items[items.length - 1].push(trimLine(lines[i]));
          i++;
        } else break;
      }
      out.push(isOrdered && start !== 1 ? `<ol start="${start}">\n` : isOrdered ? '<ol>\n' : '<ul>\n');
      for (const parts of items) {
        out.push('<li>');
        inline(parts.join('\n'), link, out);
        out.push('</li>\n');
      }
      out.push(isOrdered ? '</ol>\n' : '</ul>\n');
      continue;
    }
    const body = [trimLine(line)];
    i++;
    while (i < n && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
    const text = body.join('\n');
    if (!hasExcerpt) {
      const tmp = [];
      inline(text, link, tmp);
      excerpt = tmp.join('');
      hasExcerpt = true;
      out.push('<p>' + excerpt + '</p>\n');
    } else {
      out.push('<p>');
      inline(text, link, out);
      out.push('</p>\n');
    }
  }
  return { html: out.join(''), toc, excerpt };
}

// ---------------------------------------------------------------- templates

class TemplateError extends Error {}

const PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF = /^if (not )?(\S+)$/;
const INCLUDE = /^include "([a-z0-9-]+)"$/;

function pathOf(name, text) {
  if (!PATH.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

// Template value helpers: the reference's lookup / textOf / truthy.
function g1(S, a) { return a in S ? S[a] : undefined; }
function g2(S, a, b) {
  const v = a in S ? S[a] : undefined;
  if (v === null || typeof v !== 'object') return undefined;
  return Object.hasOwn(v, b) ? v[b] : undefined;
}
function g3(S, a, b, c) {
  let v = a in S ? S[a] : undefined;
  if (v === null || typeof v !== 'object' || !Object.hasOwn(v, b)) return undefined;
  v = v[b];
  if (v === null || typeof v !== 'object' || !Object.hasOwn(v, c)) return undefined;
  return v[c];
}
function gN(S, path) {
  let v = path[0] in S ? S[path[0]] : undefined;
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}
function txt(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) {
    let s = '';
    for (let i = 0; i < v.length; i++) {
      if (i > 0) s += ', ';
      s += txt(v[i]);
    }
    return s;
  }
  return '';
}
function ex(v) { return esc(txt(v)); }
function tr(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/** Compile a parsed template tree to a function (S, D, O) appending to O. */
function compileTemplate(nodes, compiled) {
  let uid = 0;
  const pathCall = (path, S) => {
    if (path.length === 1) return 'g1(' + S + ',' + JSON.stringify(path[0]) + ')';
    if (path.length === 2) return 'g2(' + S + ',' + JSON.stringify(path[0]) + ',' + JSON.stringify(path[1]) + ')';
    if (path.length === 3) return 'g3(' + S + ',' + JSON.stringify(path[0]) + ',' + JSON.stringify(path[1]) + ',' + JSON.stringify(path[2]) + ')';
    return 'gN(' + S + ',' + JSON.stringify(path) + ')';
  };
  const gen = (ns, S) => {
    let code = '';
    let pend = [];
    const flush = () => {
      if (pend.length > 0) { code += 'O.push(' + pend.join(',') + ');'; pend = []; }
    };
    for (const n of ns) {
      if (n.kind === 'text') pend.push(JSON.stringify(n.text));
      else if (n.kind === 'var') pend.push('ex(tx(' + pathCall(n.path, S) + '))');
      else if (n.kind === 'raw') pend.push('tx(' + pathCall(n.path, S) + ')');
      else if (n.kind === 'if') {
        flush();
        code += 'if(tr(' + pathCall(n.path, S) + ')!==' + (n.not ? 'true' : 'false') + '){' + gen(n.then, S) + '}';
        if (n.else !== null) code += 'else{' + gen(n.else, S) + '}';
      } else if (n.kind === 'for') {
        flush();
        const id = uid++;
        const xs = '_x' + id, sc = '_s' + id, lp = '_l' + id, kk = '_k' + id;
        code += '{const ' + xs + '=' + pathCall(n.path, S) + ';if(Array.isArray(' + xs + ')){const ' + sc + '=Object.create(' + S + ');const ' + lp + '={index:0,first:false,last:false,length:' + xs + '.length};for(let ' + kk + '=0;' + kk + '<' + xs + '.length;' + kk + '++){' + sc + '[' + JSON.stringify(n.name) + ']=' + xs + '[' + kk + '];' + lp + '.index=' + kk + '+1;' + lp + '.first=' + kk + '===0;' + lp + '.last=' + kk + '===' + xs + '.length-1;' + sc + '.loop=' + lp + ';' + gen(n.body, sc) + '}}}';
      } else if (n.kind === 'include') {
        flush();
        const id = uid++;
        code += '{const _t' + id + '=TPL.get(' + JSON.stringify(n.name) + ');if(_t' + id + '!==undefined&&D<8)_t' + id + '(' + S + ',D+1,O);}';
      }
    }
    flush();
    return code;
  };
  const factory = new Function('TPL', 'g1', 'g2', 'g3', 'gN', 'tx', 'ex', 'tr', 'return function(S,D,O){' + gen(nodes, 'S') + '}');
  return factory(compiled, g1, g2, g3, gN, txt, ex, tr);
}

// ---------------------------------------------------------------- build

function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

export function run(input) {
  slugCache = new Map();
  dateCache = new Map();
  const report = [];
  const compiled = new Map();
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      compiled.set(name, compileTemplate(parseTemplate(name, input.templates[name]), compiled));
    } catch (err) {
      if (err instanceof TemplateError) { report.push(err.message); compiled.delete(name); }
      else throw err;
    }
  }

  const base = input.site.base_url.replace(/\/+$/, '');
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) sources.push({ path: f.path, text: f.content.indexOf('\r') === -1 ? f.content : f.content.replace(/\r\n?/g, '\n') });
    else statics.push(f);
  }

  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) { report.push(`refused ${s.path}: ${fm.error}`); continue; }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    const own = s.path.startsWith('tags/') ? 'tags' : s.path.startsWith('page/') ? 'page' : undefined;
    if (own !== undefined) { report.push(`refused ${s.path}: ${own}/ is the generator's own`); continue; }
    if (s.post && !Object.hasOwn(s.data, 'date')) { report.push(`refused ${s.path}: a post needs a date`); continue; }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!compiled.has(layout)) { report.push(`refused ${s.path}: layout "${layout}" is no template that parses`); continue; }
    s.layout = layout;
    if (s.data.draft === true) { report.push(`draft ${s.path}`); continue; }
    kept.push(s);
  }

  const bySource = new Map();
  const taken = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) { set = new Set(dir === '' ? RESERVED : []); taken.set(dir, set); }
    s.slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), set);
    s.outDir = dir === '' ? s.slug : `${dir}/${s.slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  for (const s of kept) {
    const dir = dirOf(s.path);
    const link = (target) => {
      if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
      const hash = target.indexOf('#');
      const rel = hash === -1 ? target : target.slice(0, hash);
      const frag = hash === -1 ? '' : target.slice(hash);
      const path = rel === '' ? null : resolvePath(dir, rel);
      if (path !== null && bySource.has(path)) return bySource.get(path).url + frag;
      if (path !== null && staticPaths.has(path)) return `${base}/${path}${frag}`;
      broken.add(`broken-link ${s.path} -> ${target}`);
      return target;
    };
    const md = renderMarkdown(s.body, link);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of (s.data.tags ?? [])) {
      const slug = slugify(name);
      if (seen.has(slug)) continue;
      seen.add(slug);
      out.push(name);
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name);
      let tag = bySlug.get(slug);
      if (tag === undefined) { tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] }; bySlug.set(slug, tag); }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) {
    if (!s.post) {
      s.tagRefs = ownTags(s).map((name) => {
        const slug = slugify(name);
        return bySlug.get(slug) ?? { name, slug, url: '', posts: [] };
      });
    }
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });
  const cardOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  });
  const cards = new Map(posts.map((p) => [p, cardOf(p)]));

  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const output = {};
  const render = (name, vars) => {
    const fn = compiled.get(name);
    if (fn === undefined) return null;
    const S = Object.create(null);
    S.site = site;
    S.tags = allTags;
    S.recent = recent;
    Object.assign(S, vars);
    const O = [];
    fn(S, 0, O);
    return O.join('');
  };

  for (const s of kept) {
    const card = s.post ? cards.get(s) : cardOf(s);
    const page = { ...card, slug: s.slug, content: s.html, toc: s.toc, newer: linkOf(s.newer ?? null), older: linkOf(s.older ?? null), is_post: s.post };
    output[`${s.outDir}/index.html`] = render(s.layout, { page });
  }
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', { tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) } });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  const lines = [...report, ...broken].sort(byCodeUnits);
  const pagesCount = kept.filter((s) => !s.post).length;
  lines.push(`built ${pagesCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = `${lines.join('\n')}\n`;
  return output;
}
