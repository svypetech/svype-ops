// Dependency-free PDF writer for salary slips.
// Produces a real, branded document: logo, accent colour, two-column earnings and
// deductions, a net-pay band, the signatory's signature and company stamp, and a
// footer carrying both office addresses. PNG/JPEG data URLs are embedded properly,
// including transparency, so signatures and stamps sit on the page cleanly.

const zlib = require("zlib");

const PAGE_W = 595, PAGE_H = 842, M = 46;

const esc = (s) =>
  String(s == null ? "" : s)
    .replace(/[^\x20-\x7E\xA0-\xFF]/g, "")
    .replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");

const W = { " ":278,"!":278,'"':355,"#":556,"$":556,"%":889,"&":667,"'":191,"(":333,")":333,"*":389,"+":584,",":278,"-":333,".":278,"/":278,
  "0":556,"1":556,"2":556,"3":556,"4":556,"5":556,"6":556,"7":556,"8":556,"9":556,":":278,";":278,"<":584,"=":584,">":584,"?":556,"@":1015,
  A:667,B:667,C:722,D:722,E:667,F:611,G:778,H:722,I:278,J:500,K:667,L:556,M:833,N:722,O:778,P:667,Q:778,R:722,S:667,T:611,U:722,V:667,W:944,X:667,Y:667,Z:611,
  "[":278,"\\":278,"]":278,"^":469,_:556,"`":333,
  a:556,b:556,c:500,d:556,e:556,f:278,g:556,h:556,i:222,j:222,k:500,l:222,m:833,n:556,o:556,p:556,q:556,r:333,s:500,t:278,u:556,v:500,w:722,x:500,y:500,z:500,
  "{":334,"|":260,"}":334,"~":584 };
const widthOf = (t, size, bold) => {
  let w = 0;
  for (const ch of String(t ?? "")) w += (W[ch] ?? 556) * (bold ? 1.07 : 1);
  return (w / 1000) * size;
};
const fit = (t, size, bold, max) => {
  const full = String(t ?? "");
  let s = full;
  while (s.length > 3 && widthOf(s, size, bold) > max) s = s.slice(0, -2);
  return s === full ? s : s + "...";
};

// ---------- image decoding ----------
function decodePng(buf) {
  if (buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47) return null;
  let p = 8, w = 0, h = 0, depth = 0, ctype = 0, interlace = 0;
  const idat = []; let plte = null, trns = null;
  while (p + 8 <= buf.length) {
    const len = buf.readUInt32BE(p), type = buf.toString("latin1", p + 4, p + 8);
    const data = buf.slice(p + 8, p + 8 + len);
    if (type === "IHDR") {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4);
      depth = data[8]; ctype = data[9]; interlace = data[12];
    } else if (type === "PLTE") plte = data;
    else if (type === "tRNS") trns = data;
    else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    p += 12 + len;
  }
  if (!w || !h || depth !== 8 || interlace !== 0) return null;   // canvas output is 8-bit, non-interlaced
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[ctype];
  if (!channels) return null;
  let raw;
  try { raw = zlib.inflateSync(Buffer.concat(idat)); } catch { return null; }
  const bpp = channels, stride = w * bpp;
  const out = Buffer.alloc(h * stride);
  let pos = 0;
  for (let y = 0; y < h; y++) {
    if (pos >= raw.length) return null;
    const f = raw[pos++];
    const line = raw.slice(pos, pos + stride); pos += stride;
    const cur = out.slice(y * stride, (y + 1) * stride);
    const prev = y ? out.slice((y - 1) * stride, y * stride) : Buffer.alloc(stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0, x = line[i];
      let v;
      if (f === 0) v = x;
      else if (f === 1) v = x + a;
      else if (f === 2) v = x + b;
      else if (f === 3) v = x + ((a + b) >> 1);
      else if (f === 4) {
        const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
        v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
      } else return null;
      cur[i] = v & 0xff;
    }
  }
  const rgb = Buffer.alloc(w * h * 3);
  const needAlpha = ctype === 4 || ctype === 6 || (ctype === 3 && trns);
  const alpha = needAlpha ? Buffer.alloc(w * h, 255) : null;
  for (let i = 0; i < w * h; i++) {
    const s = i * channels;
    let r, g, b, a = 255;
    if (ctype === 0) { r = g = b = out[s]; }
    else if (ctype === 4) { r = g = b = out[s]; a = out[s + 1]; }
    else if (ctype === 2) { r = out[s]; g = out[s + 1]; b = out[s + 2]; }
    else if (ctype === 6) { r = out[s]; g = out[s + 1]; b = out[s + 2]; a = out[s + 3]; }
    else {
      if (!plte) return null;
      const idx = out[s];
      r = plte[idx * 3]; g = plte[idx * 3 + 1]; b = plte[idx * 3 + 2];
      if (trns && idx < trns.length) a = trns[idx];
    }
    rgb[i * 3] = r; rgb[i * 3 + 1] = g; rgb[i * 3 + 2] = b;
    if (alpha) alpha[i] = a;
  }
  return { w, h, rgb, alpha, kind: "png" };
}

function jpegSize(buf) {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let p = 2;
  while (p + 9 < buf.length) {
    if (buf[p] !== 0xff) { p++; continue; }
    const marker = buf[p + 1], len = buf.readUInt16BE(p + 2);
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker))
      return { h: buf.readUInt16BE(p + 5), w: buf.readUInt16BE(p + 7) };
    p += 2 + len;
  }
  return null;
}

// Accepts a data URL; returns something embeddable or null. Never throws — a bad
// logo must never stop a payslip from being produced.
function parseImage(dataUrl) {
  try {
    if (!dataUrl || typeof dataUrl !== "string" || !dataUrl.startsWith("data:")) return null;
    const buf = Buffer.from(dataUrl.slice(dataUrl.indexOf(",") + 1), "base64");
    if (/^data:image\/jpe?g/i.test(dataUrl)) {
      const d = jpegSize(buf);
      return d ? { w: d.w, h: d.h, jpeg: buf, kind: "jpeg" } : null;
    }
    return decodePng(buf);
  } catch { return null; }
}

const hexRgb = (hex, fb = [2, 132, 199]) => {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ""));
  if (!m) return fb;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

// ---------- amount in words ----------
const ONES = ["","One","Two","Three","Four","Five","Six","Seven","Eight","Nine","Ten","Eleven","Twelve","Thirteen","Fourteen","Fifteen","Sixteen","Seventeen","Eighteen","Nineteen"];
const TENS = ["","","Twenty","Thirty","Forty","Fifty","Sixty","Seventy","Eighty","Ninety"];
function below1000(n) {
  let s = "";
  if (n >= 100) { s += ONES[Math.floor(n / 100)] + " Hundred"; n %= 100; if (n) s += " "; }
  if (n >= 20) { s += TENS[Math.floor(n / 10)]; n %= 10; if (n) s += " " + ONES[n]; }
  else if (n) s += ONES[n];
  return s;
}
function amountInWords(n) {                 // crore / lakh / thousand
  n = Math.round(Math.abs(+n || 0));
  if (!n) return "Zero";
  const parts = [];
  const crore = Math.floor(n / 10000000); n %= 10000000;
  const lakh = Math.floor(n / 100000); n %= 100000;
  const thousand = Math.floor(n / 1000); n %= 1000;
  if (crore) parts.push(below1000(crore) + " Crore");
  if (lakh) parts.push(below1000(lakh) + " Lakh");
  if (thousand) parts.push(below1000(thousand) + " Thousand");
  if (n) parts.push(below1000(n));
  return parts.join(" ");
}

const money = (n, cur = "PKR") => `${cur} ${Math.round(+n || 0).toLocaleString("en-US")}`;
const prettyDate = (d) => {
  if (!d) return "";
  const dt = new Date(d);
  return isNaN(dt.getTime()) ? String(d) : dt.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
};

class Doc {
  constructor() { this.ops = []; this.images = []; }
  text(x, y, str, { size = 10, bold = false, gray = null, rgb = null } = {}) {
    const col = rgb
      ? `${(rgb[0] / 255).toFixed(3)} ${(rgb[1] / 255).toFixed(3)} ${(rgb[2] / 255).toFixed(3)} rg`
      : `${gray ?? 0} g`;
    this.ops.push(`${col} BT /${bold ? "F2" : "F1"} ${size} Tf 1 0 0 1 ${x.toFixed(2)} ${y.toFixed(2)} Tm (${esc(str)}) Tj ET 0 g`);
    return this;
  }
  right(xr, y, str, o = {}) { return this.text(xr - widthOf(str, o.size ?? 10, o.bold), y, str, o); }
  line(x1, y1, x2, y2, gray = 0.85, w = 0.7) {
    this.ops.push(`${gray} G ${w} w ${x1.toFixed(2)} ${y1.toFixed(2)} m ${x2.toFixed(2)} ${y2.toFixed(2)} l S 0 G`);
    return this;
  }
  band(x, y, w, h, rgb) {
    this.ops.push(`${(rgb[0] / 255).toFixed(3)} ${(rgb[1] / 255).toFixed(3)} ${(rgb[2] / 255).toFixed(3)} rg ${x.toFixed(2)} ${y.toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)} re f 0 g`);
    return this;
  }
  rect(x, y, w, h, gray = 0.97) {
    this.ops.push(`${gray} g ${x.toFixed(2)} ${y.toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)} re f 0 g`);
    return this;
  }
  frame(x, y, w, h, gray = 0.85) {
    this.ops.push(`${gray} G 0.7 w ${x.toFixed(2)} ${y.toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)} re S 0 G`);
    return this;
  }
  image(img, x, y, maxW, maxH) {
    if (!img) return this;
    const scale = Math.min(maxW / img.w, maxH / img.h);
    const w = img.w * scale, h = img.h * scale;
    const n = this.images.push(img);
    this.ops.push(`q ${w.toFixed(2)} 0 0 ${h.toFixed(2)} ${x.toFixed(2)} ${y.toFixed(2)} cm /Im${n} Do Q`);
    return this;
  }
  build() {
    const objs = [];
    const push = (body, streamBuf) => { objs.push({ body, streamBuf }); return objs.length; };
    push("<< /Type /Catalog /Pages 2 0 R >>");
    push("<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
    push("PAGE");                                   // filled in below
    const content = Buffer.from(this.ops.join("\n"), "latin1");
    push(`<< /Length ${content.length} >>`, content);
    push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
    push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>");

    const xobjects = [];
    this.images.forEach((img, i) => {
      let smaskRef = null;
      if (img.kind === "png" && img.alpha) {
        const a = zlib.deflateSync(img.alpha);
        smaskRef = push(`<< /Type /XObject /Subtype /Image /Width ${img.w} /Height ${img.h} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode /Length ${a.length} >>`, a);
      }
      let ref;
      if (img.kind === "jpeg") {
        ref = push(`<< /Type /XObject /Subtype /Image /Width ${img.w} /Height ${img.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${img.jpeg.length} >>`, img.jpeg);
      } else {
        const dz = zlib.deflateSync(img.rgb);
        ref = push(`<< /Type /XObject /Subtype /Image /Width ${img.w} /Height ${img.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length ${dz.length}${smaskRef ? ` /SMask ${smaskRef} 0 R` : ""} >>`, dz);
      }
      xobjects.push(`/Im${i + 1} ${ref} 0 R`);
    });

    objs[2].body = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /Font << /F1 5 0 R /F2 6 0 R >>${xobjects.length ? ` /XObject << ${xobjects.join(" ")} >>` : ""} >> /Contents 4 0 R >>`;

    const chunks = [Buffer.from("%PDF-1.4\n", "latin1")];
    let len = chunks[0].length;
    const offsets = [];
    objs.forEach((o, i) => {
      offsets.push(len);
      if (o.streamBuf) {
        const head = Buffer.from(`${i + 1} 0 obj\n${o.body}\nstream\n`, "latin1");
        const tail = Buffer.from("\nendstream\nendobj\n", "latin1");
        chunks.push(head, o.streamBuf, tail);
        len += head.length + o.streamBuf.length + tail.length;
      } else {
        const b = Buffer.from(`${i + 1} 0 obj\n${o.body}\nendobj\n`, "latin1");
        chunks.push(b); len += b.length;
      }
    });
    let tail = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
    offsets.forEach(o => { tail += `${String(o).padStart(10, "0")} 00000 n \n`; });
    tail += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${len}\n%%EOF`;
    chunks.push(Buffer.from(tail, "latin1"));
    return Buffer.concat(chunks);
  }
}

function buildPayslipPdf(slip = {}, brand = {}, employee = {}) {
  const d = new Doc();
  const accent = hexRgb(brand.accent);
  const soft = [Math.round(accent[0]*0.12+236), Math.round(accent[1]*0.12+240), Math.round(accent[2]*0.12+244)].map(v=>Math.min(v,250));
  const right = PAGE_W - M, innerW = right - M;
  const cur = slip.currency || "PKR";
  const WHITE = [255,255,255];

  const logo = parseImage(brand.logo);
  const sig = brand.payslipSignature || null;
  const sigImg = parseImage(sig && sig.img);
  const stampImg = parseImage(brand.payslipStamp);

  // ================= header =================
  let y = PAGE_H - 46;
  let tx = M;
  if (logo) {
    const bw = 108, bh = 54, sc = Math.min(bw / logo.w, bh / logo.h);
    d.image(logo, M, y - 40, bw, bh);
    tx = M + logo.w * sc + 16;
  }
  d.text(tx, y - 8, brand.company || "Company", { size: 21, bold: true });
  if (brand.tagline) d.text(tx, y - 23, brand.tagline, { size: 9, gray: 0.45 });

  // title bar, full bleed
  const barY = PAGE_H - 142, barH = 34;
  d.band(0, barY, PAGE_W, barH, accent);
  d.text(M, barY + 12, "SALARY SLIP", { size: 12.5, bold: true, rgb: WHITE });
  d.right(right, barY + 12, (slip.month || "").toUpperCase(), { size: 11, bold: true, rgb: WHITE });
  y = barY - 26;

  // ================= who / when =================
  const panelH = 84;
  d.rect(M, y - panelH, innerW, panelH, 0.968);
  d.band(M, y - panelH, 3, panelH, accent);          // accent spine
  const colX = M + innerW / 2 + 4;
  const labW = 96;
  const row = (x, yy, k, v) => {
    d.text(x + 14, yy, k.toUpperCase(), { size: 7.5, gray: 0.5 });
    d.text(x + labW, yy, fit(v || "-", 10, true, innerW / 2 - labW - 20), { size: 10, bold: true });
  };
  let ry = y - 22;
  row(M, ry, "Employee", slip.employee);
  row(M, ry - 22, "Designation", [employee.role, employee.dept].filter(Boolean).join(" / "));
  row(M, ry - 44, "Account / IBAN", employee.account);
  row(colX - 14, ry, "Pay period", slip.month);
  row(colX - 14, ry - 22, "Issue date", prettyDate(slip.date || new Date()));
  row(colX - 14, ry - 44, "Payment", slip.paid ? `${prettyDate(slip.paidOn)}${slip.payMethod ? ` · ${slip.payMethod}` : ""}` : "Pending");
  y -= panelH + 30;

  // ================= earnings | deductions =================
  const plus = [["Basic salary", +slip.basic || 0]];
  if (+slip.allowances) plus.push(["Allowances", +slip.allowances]);
  if (+slip.reimbursements) plus.push(["Reimbursements", +slip.reimbursements]);
  (slip.adjustments || []).filter(a => (+a.amount || 0) > 0).forEach(a => plus.push([a.reason || "Addition", +a.amount]));
  const minus = [];
  [["Income tax", slip.tax], ["EOBI", slip.eobi], ["Provident fund", slip.pf], ["Advance / loan", slip.advance]]
    .forEach(([k, v]) => { if (+v) minus.push([k, +v]); });
  (slip.adjustments || []).filter(a => (+a.amount || 0) < 0).forEach(a => minus.push([a.reason || "Deduction", Math.abs(+a.amount)]));
  const gross = plus.reduce((t, [, v]) => t + v, 0);
  const totalDed = minus.reduce((t, [, v]) => t + v, 0);

  const gap = 18, colW = (innerW - gap) / 2;
  const rowsMax = Math.max(plus.length, minus.length || 1);
  // The block below the columns is fixed in size: net pay band + amount in words +
  // the signature area + the footer. Whatever is left is what the columns may use, so
  // a slip with many lines shrinks its rows instead of running over the signature.
  const BELOW = 96 + 130 + 92;                       // net pay/words, signature block, footer
  const avail = Math.max(150, y - BELOW);
  let rowH = 21;
  const needed = () => 36 + rowsMax * rowH + 34;
  while (needed() > avail && rowH > 13) rowH -= 1;
  const colH = Math.min(Math.max(232, needed()), Math.max(avail, needed() > avail ? needed() : 0));
  const drawCol = (x, title, rows, total, totalLabel) => {
    d.rect(x, y - colH, colW, colH, 0.995);
    d.frame(x, y - colH, colW, colH, 0.86);
    d.band(x, y - 28, colW, 28, accent);
    d.text(x + 14, y - 19, title, { size: 9.5, bold: true, rgb: WHITE });
    let cy = y - 50;
    if (!rows.length) { d.text(x + 14, cy, "None", { size: 10, gray: 0.5 }); cy -= rowH; }
    rows.forEach(([k, v], i) => {
      if (i % 2 === 1) d.rect(x + 1, cy - 6, colW - 2, rowH, 0.978);
      d.text(x + 14, cy, fit(k, 10, false, colW - 118), { size: 10 });
      d.right(x + colW - 14, cy, money(v, cur), { size: 10 });
      cy -= rowH;
    });
    d.band(x + 1, y - colH + 1, colW - 2, 30, soft);
    d.line(x, y - colH + 31, x + colW, y - colH + 31, 0.86);
    d.text(x + 14, y - colH + 12, totalLabel, { size: 10, bold: true });
    d.right(x + colW - 14, y - colH + 12, money(total, cur), { size: 10.5, bold: true });
  };
  drawCol(M, "EARNINGS", plus, gross, "Total earnings");
  drawCol(M + colW + gap, "DEDUCTIONS", minus, totalDed, "Total deductions");
  y -= colH + 28;

  // ================= net pay =================
  const net = gross - totalDed;
  const nH = 56;
  d.band(M, y - nH + 16, innerW, nH, accent);
  d.text(M + 18, y - 8, "NET PAY", { size: 12, bold: true, rgb: WHITE });
  d.text(M + 18, y - 22, "amount transferred", { size: 7.5, rgb: [235, 242, 250] });
  d.right(right - 18, y - 14, money(net, cur), { size: 21, bold: true, rgb: WHITE });
  y -= nH + 14;
  d.text(M, y, "In words:", { size: 8.5, gray: 0.5 });
  d.text(M + 48, y, `${amountInWords(net)} Rupees Only`, { size: 8.5, bold: true, gray: 0.25 });

  // ================= signature & stamp (anchored near the foot) =================
  // Sit the signature below whatever the content actually needed, never on top of it.
  const sigY = Math.max(150, Math.min(226, y - 104));
  if (stampImg) d.image(stampImg, M + 60, sigY + 18, 156, 104);
  if (sigImg) d.image(sigImg, M, sigY + 26, 178, 66);
  d.line(M, sigY + 20, M + 200, sigY + 20, 0.55);
  d.text(M, sigY + 6, (sig && sig.name) || "Authorised signatory", { size: 9.5, bold: true });
  d.text(M, sigY - 6, (sig && sig.role) || "Human Resources", { size: 8, gray: 0.45 });
  // payment summary opposite the signature
  const boxX = M + innerW - 210;
  d.rect(boxX, sigY - 14, 210, 92, 0.972);
  d.frame(boxX, sigY - 14, 210, 92, 0.9);
  d.text(boxX + 14, sigY + 62, "PAYMENT DETAILS", { size: 7.5, bold: true, gray: 0.45 });
  const pRow = (yy, k, v) => { d.text(boxX + 14, yy, k, { size: 8.5, gray: 0.5 }); d.right(boxX + 196, yy, fit(v || "-", 8.5, true, 118), { size: 8.5, bold: true }); };
  pRow(sigY + 44, "Method", slip.paid ? (slip.payMethod || "-") : "Not yet paid");
  pRow(sigY + 28, "Paid on", slip.paid ? prettyDate(slip.paidOn) : "-");
  pRow(sigY + 12, "Account", employee.account || "-");
  pRow(sigY - 4, "Net paid", money(net, cur));

  // ================= footer =================
  const fH = 92;
  d.band(0, 0, PAGE_W, fH, soft);
  d.band(0, fH - 2.5, PAGE_W, 2.5, accent);
  let fy = fH - 22;
  const offices = Array.isArray(brand.offices) ? brand.offices.filter(o => o && o.address) : [];
  offices.forEach(o => {
    d.text(M, fy, `${o.city ? o.city + " — " : ""}${o.address}`, { size: 7.8, gray: 0.42 });
    fy -= 11;
  });
  const contact = [brand.phone, brand.email, brand.website].filter(Boolean).join("    ·    ");
  if (contact) { d.text(M, fy, contact, { size: 7.8, gray: 0.42 }); fy -= 11; }
  d.text(M, 16, "This is a computer-generated salary slip and is valid without a physical signature.", { size: 7, gray: 0.55 });
  d.right(right, 16, brand.company || "", { size: 7, bold: true, gray: 0.5 });

  return d.build();
}

module.exports = { buildPayslipPdf, amountInWords };
