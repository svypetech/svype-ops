// Minimal, dependency-free PDF writer for salary slips.
// Produces a real PDF file (bytes) so payslips can be emailed as an attachment —
// the browser "print to PDF" route can't be attached to anything programmatically.

const PAGE_W = 595, PAGE_H = 842, M = 48;

const esc = (s) =>
  String(s == null ? "" : s)
    .replace(/[^\x20-\x7E\xA0-\xFF]/g, "")   // keep to WinAnsi-safe characters
    .replace(/\\/g, "\\\\")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)");

// Helvetica advance widths (1000-unit em) for the ASCII range — enough to right-align money.
const W = { " ":278,"!":278,'"':355,"#":556,"$":556,"%":889,"&":667,"'":191,"(":333,")":333,"*":389,"+":584,",":278,"-":333,".":278,"/":278,
  "0":556,"1":556,"2":556,"3":556,"4":556,"5":556,"6":556,"7":556,"8":556,"9":556,":":278,";":278,"<":584,"=":584,">":584,"?":556,"@":1015,
  A:667,B:667,C:722,D:722,E:667,F:611,G:778,H:722,I:278,J:500,K:667,L:556,M:833,N:722,O:778,P:667,Q:778,R:722,S:667,T:611,U:722,V:667,W:944,X:667,Y:667,Z:611,
  "[":278,"\\":278,"]":278,"^":469,_:556,"`":333,
  a:556,b:556,c:500,d:556,e:556,f:278,g:556,h:556,i:222,j:222,k:500,l:222,m:833,n:556,o:556,p:556,q:556,r:333,s:500,t:278,u:556,v:500,w:722,x:500,y:500,z:500,
  "{":334,"|":260,"}":334,"~":584 };
const widthOf = (text, size, bold) => {
  let w = 0;
  for (const ch of String(text ?? "")) w += (W[ch] ?? 556) * (bold ? 1.06 : 1);
  return (w / 1000) * size;
};

class Doc {
  constructor() { this.ops = []; }
  text(x, y, str, { size = 10, bold = false, gray = 0 } = {}) {
    this.ops.push(`${gray} g BT /${bold ? "F2" : "F1"} ${size} Tf 1 0 0 1 ${x.toFixed(2)} ${y.toFixed(2)} Tm (${esc(str)}) Tj ET 0 g`);
    return this;
  }
  right(xRight, y, str, o = {}) {
    return this.text(xRight - widthOf(str, o.size ?? 10, o.bold), y, str, o);
  }
  line(x1, y1, x2, y2, gray = 0.82) {
    this.ops.push(`${gray} G 0.8 w ${x1.toFixed(2)} ${y1.toFixed(2)} m ${x2.toFixed(2)} ${y2.toFixed(2)} l S 0 G`);
    return this;
  }
  rect(x, y, w, h, gray = 0.95) {
    this.ops.push(`${gray} g ${x.toFixed(2)} ${y.toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)} re f 0 g`);
    return this;
  }
  build() {
    const content = this.ops.join("\n");
    const objs = [
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> /Contents 4 0 R >>`,
      `<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}\nendstream`,
      "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
      "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>",
    ];
    let out = "%PDF-1.4\n";
    const offsets = [];
    objs.forEach((body, i) => {
      offsets.push(Buffer.byteLength(out, "latin1"));
      out += `${i + 1} 0 obj\n${body}\nendobj\n`;
    });
    const xref = Buffer.byteLength(out, "latin1");
    out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
    offsets.forEach(o => { out += `${String(o).padStart(10, "0")} 00000 n \n`; });
    out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
    return Buffer.from(out, "latin1");
  }
}

const money = (n, cur = "PKR") =>
  `${cur} ${Math.round(+n || 0).toLocaleString("en-US")}`;

// slip: the payroll record; brand: { company, tagline, address, phone, email }
function buildPayslipPdf(slip = {}, brand = {}, employee = {}) {
  const d = new Doc();
  const right = PAGE_W - M;
  let y = PAGE_H - M;

  // Header
  d.text(M, y, brand.company || "Salary Slip", { size: 18, bold: true });
  y -= 16;
  if (brand.tagline) { d.text(M, y, brand.tagline, { size: 9, gray: 0.45 }); y -= 12; }
  const contact = [brand.address, brand.phone, brand.email].filter(Boolean).join("  ·  ");
  if (contact) { d.text(M, y, contact, { size: 8, gray: 0.5 }); y -= 12; }
  d.right(right, PAGE_H - M, "SALARY SLIP", { size: 12, bold: true, gray: 0.35 });
  d.right(right, PAGE_H - M - 14, slip.month || "", { size: 9, gray: 0.45 });
  y -= 6;
  d.line(M, y, right, y, 0.75);
  y -= 24;

  // Employee block
  d.rect(M, y - 46, right - M, 58, 0.965);
  const rows = [
    ["Employee", slip.employee || ""],
    ["Designation", [employee.role, employee.dept].filter(Boolean).join(" · ")],
    ["Account / IBAN", employee.account || "—"],
  ];
  let by = y;
  rows.forEach(([k, v]) => {
    d.text(M + 12, by, k, { size: 9, gray: 0.45 });
    d.text(M + 120, by, v || "—", { size: 9, bold: true });
    by -= 16;
  });
  y -= 70;

  // Earnings
  d.text(M, y, "EARNINGS", { size: 9, bold: true, gray: 0.4 });
  y -= 6; d.line(M, y, right, y); y -= 16;
  const add = (label, amount, opt = {}) => {
    d.text(M, y, label, { size: 10, gray: opt.gray ?? 0 });
    d.right(right, y, money(amount, slip.currency), { size: 10, bold: !!opt.bold, gray: opt.gray ?? 0 });
    y -= 16;
  };
  add("Basic salary", slip.basic);
  if (+slip.allowances) add("Allowances", slip.allowances);
  if (+slip.reimbursements) add("Reimbursements", slip.reimbursements);
  (slip.adjustments || []).filter(a => (+a.amount || 0) > 0).forEach(a => add(a.reason || "Addition", a.amount));

  const additions =
    (+slip.basic || 0) + (+slip.allowances || 0) + (+slip.reimbursements || 0) +
    (slip.adjustments || []).filter(a => (+a.amount || 0) > 0).reduce((s, a) => s + (+a.amount || 0), 0);
  y -= 2; d.line(M, y + 8, right, y + 8);
  d.text(M, y, "Total earnings", { size: 10, bold: true });
  d.right(right, y, money(additions, slip.currency), { size: 10, bold: true });
  y -= 30;

  // Deductions
  d.text(M, y, "DEDUCTIONS", { size: 9, bold: true, gray: 0.4 });
  y -= 6; d.line(M, y, right, y); y -= 16;
  const ded = [
    ["Income tax", slip.tax], ["EOBI", slip.eobi],
    ["Provident fund", slip.pf], ["Advance / loan", slip.advance],
  ].filter(([, v]) => +v);
  ded.forEach(([k, v]) => add(k, v));
  (slip.adjustments || []).filter(a => (+a.amount || 0) < 0).forEach(a => add(a.reason || "Deduction", Math.abs(+a.amount)));
  const negAdj = (slip.adjustments || []).filter(a => (+a.amount || 0) < 0).reduce((s, a) => s + Math.abs(+a.amount || 0), 0);
  const totalDed = (+slip.deductions || 0) + negAdj;
  if (!ded.length && !negAdj) { d.text(M, y, "None", { size: 10, gray: 0.5 }); y -= 16; }
  y -= 2; d.line(M, y + 8, right, y + 8);
  d.text(M, y, "Total deductions", { size: 10, bold: true });
  d.right(right, y, money(totalDed, slip.currency), { size: 10, bold: true });
  y -= 34;

  // Net pay
  d.rect(M, y - 12, right - M, 34, 0.93);
  d.text(M + 12, y, "NET PAY", { size: 11, bold: true });
  d.right(right - 12, y, money(additions - totalDed, slip.currency), { size: 14, bold: true });
  y -= 44;

  if (slip.paid) {
    d.text(M, y, `Paid on ${slip.paidOn || "—"}${slip.payMethod ? ` via ${slip.payMethod}` : ""}`, { size: 9, gray: 0.4 });
    y -= 14;
  }
  d.text(M, 64, "This is a computer-generated salary slip and does not require a signature.", { size: 8, gray: 0.5 });
  d.line(M, 52, right, 52);
  d.text(M, 38, `${brand.company || ""}${brand.email ? `  ·  ${brand.email}` : ""}`, { size: 8, gray: 0.5 });

  return d.build();
}

module.exports = { buildPayslipPdf };
