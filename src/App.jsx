import React, { useMemo, useState, useEffect } from "react";
import { FileText, Download } from "lucide-react";
import * as JSPDFNS from "jspdf";

// Small, reliable jsPDF handle
const JsPDF = JSPDFNS.jsPDF || JSPDFNS.default || JSPDFNS;

// --- App metadata ---
const APP_VERSION = "1.1.3";

// --- Static assets (logo) ---
// Put your logo file at: /public/icons/icon-512.png (in Vite), so it serves from /icons/icon-512.png
const LOGO_SRC = "/icons/icon-512.png";

// --- Formatting helpers ---
const fmt = (n) => new Intl.NumberFormat(undefined, { style: "currency", currency: "USD" }).format(isFinite(n) ? n : 0);
const toNum = (v) => (isFinite(+v) ? +v : 0);

const sanitizePart = (s) => {
  const allowed = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const norm = (s || "").trim().replaceAll(" ", "_");
  let out = "";
  for (const ch of norm) if (allowed.includes(ch)) out += ch;
  return out.slice(0, 60);
};
const buildFileName = (customer, po, dateStr) => {
  const c = sanitizePart(customer);
  const p = sanitizePart(po);
  return (c || p) ? `${c || "Customer"}-${p || "PO"}-${dateStr}.pdf` : `Quote-${dateStr}.pdf`;
};

// --- Math helpers ---
const PANEL_SQFT_PER_LF = 1.3333; // 1 linear foot of panel covers 1.3333 sqft
const sticksPlusOne = (lf) => { const pieces = Math.ceil(Math.max(0, lf) / 10); return pieces > 0 ? pieces + 1 : 0; };
const sticksNoExtra  = (lf) => Math.ceil(Math.max(0, lf) / 10);

// --- Price book ---
const PRICES = {
  panelLF: { "26": 2.5, "24": 3.5 },
  trim24:  { hip: 39.08, ridge: 39.08, gable: 28.76, drip: 25.87, svalley: 69.01, sidewall: 31.63, endwall: 37.38, transition: 43.14 },
  trim26:  { hip: 24.02, ridge: 24.02, gable: 23.98, drip: 21.68, svalley: 66.26, sidewall: 23.85, endwall: 29.63, transition: 29.63 },
  z:      { "24": 9.96, "26": 9.74 },        // 10' each
  zPerf:  { "24": 27.41, "26": 26.43 },     // 10' each
  iws: {
    standard: { label: "Polyglass", price: 64.29, coverSqft: 185, stock: "Out of Stock" },
    butyl:    { label: "GripRite",  price: 129.60, coverSqft: 185, stock: "In Stock" },
  },
  clips:   { pricePerBox: 246.17, piecesPerBox: 1000, lfPerPiece: 2 },
  screws:  { pricePerBag: 18.91,  piecesPerBag: 250,  lfPerPiece: 1 },
  staples: { pricePerBox: 48.79,  sqftPerBox: 1500 },
};

export default function MetalRoofQuoteApp() {
  // ===== Header fields =====
  const [customer, setCustomer] = useState("");
  const [po, setPo]           = useState("");
  const [notes, setNotes]     = useState("");

  // Style (affects panel clips usage)
  const STYLE_OPTIONS = ['1.5" Mechanical Standing Seam', '1.5" Lock Seam', '1" Snap Lock'];
  const [style, setStyle] = useState(STYLE_OPTIONS[0]);

  // Ice & Water choice
  const [iwsChoice, setIwsChoice] = useState("butyl"); // default GripRite (in stock) // 'none' supported

  // Fasteners choice (mutually exclusive behavior in calc)
  const [fastenerChoice, setFastenerChoice] = useState("Plastic Cap Nails");

  // Persisted modifiers
  const [markupPct, setMarkupPct] = useState(() => {
    const saved = localStorage.getItem("lastMarkup");
    return saved ? Number(saved) : 0;
  });
  useEffect(() => { localStorage.setItem("lastMarkup", String(markupPct)); }, [markupPct]);
  const taxPct = 7.25; // locked

  // ===== Logo for PDF (DataURL for reliable embedding) =====
  const [pdfLogoDataUrl, setPdfLogoDataUrl] = useState(null);
  useEffect(() => {
    try {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => {
        try {
          const canvas = document.createElement("canvas");
          canvas.width = img.naturalWidth || 512; canvas.height = img.naturalHeight || 512;
          const ctx = canvas.getContext("2d");
          ctx.drawImage(img, 0, 0);
          setPdfLogoDataUrl(canvas.toDataURL("image/png"));
        } catch {}
      };
      img.src = LOGO_SRC;
    } catch {}
  }, []);

  // ===== Measurements =====
  const [inputs, setInputs] = useState({
    sqft: 0, wastePct: 0,
    hips: 0, ridges: 0, gables: 0, eaves: 0,
    svalleys: 0, sidewalls: 0, endwalls: 0, transitions: 0,
  });
  const update = (k, v) => setInputs((s) => ({ ...s, [k]: toNum(v) }));

  // ===== Local Save / Load (device) =====
  const QUOTES_KEY = "mrq_quotes_v1";
  const loadAllQuotes = () => { try { return JSON.parse(localStorage.getItem(QUOTES_KEY) || "[]"); } catch { return []; } };
  const persistQuotes = (list) => { try { localStorage.setItem(QUOTES_KEY, JSON.stringify(list)); } catch {} };
  const [isManagerOpen, setIsManagerOpen] = useState(false);
  const [quoteList, setQuoteList] = useState([]);

  const onSaveQuote = () => {
    const now = new Date();
    const suggested = `${customer || "Customer"} - ${po || "PO"} - ${now.toLocaleString()}`;
    const name = window.prompt("Name this quote", suggested);
    if (!name) return;
    const record = {
      id: String(Date.now()), name, createdAt: now.toISOString(), version: APP_VERSION,
      data: { customer, po, notes, style, iwsChoice, fastenerChoice, markupPct, taxPct, pdfHidePrices, inputs }
    };
    const list = loadAllQuotes(); list.unshift(record); persistQuotes(list);
    alert("Quote saved on this device.");
  };
  const openManager = () => { setQuoteList(loadAllQuotes()); setIsManagerOpen(true); };
  const deleteQuote = (id) => { const list = loadAllQuotes().filter(q => q.id !== id); persistQuotes(list); setQuoteList(list); };
  const loadQuoteIntoForm = (rec) => {
    try {
      const d = rec?.data || {};
      setCustomer(d.customer || ""); setPo(d.po || ""); setNotes(d.notes || "");
      setStyle(d.style || STYLE_OPTIONS[0]); setIwsChoice(d.iwsChoice || "butyl");
      setFastenerChoice(d.fastenerChoice || "Plastic Cap Nails");
      setMarkupPct(typeof d.markupPct === 'number' ? d.markupPct : markupPct);
      if (typeof d.pdfHidePrices === 'boolean') setPdfHidePrices(d.pdfHidePrices);
      setInputs({
        sqft: d.inputs?.sqft ?? 0, wastePct: d.inputs?.wastePct ?? 0,
        hips: d.inputs?.hips ?? 0, ridges: d.inputs?.ridges ?? 0, gables: d.inputs?.gables ?? 0, eaves: d.inputs?.eaves ?? 0,
        svalleys: d.inputs?.svalleys ?? 0, sidewalls: d.inputs?.sidewalls ?? 0, endwalls: d.inputs?.endwalls ?? 0, transitions: d.inputs?.transitions ?? 0,
      });
      setIsManagerOpen(false);
    } catch { alert("Couldn't load that quote."); }
  };

  // ===== Hide-price option for PDF =====
  const [pdfHidePrices, setPdfHidePrices] = useState(() => {
    try { return localStorage.getItem("pdfHidePrices") === "1"; } catch { return false; }
  });
  useEffect(() => { try { localStorage.setItem("pdfHidePrices", pdfHidePrices ? "1" : "0"); } catch {} }, [pdfHidePrices]);

  // ===== Calculator =====
  const calcForGauge = (gauge) => {
    const wasteFactor = 1 + (toNum(inputs.wastePct) / 100);
    const effSqft = inputs.sqft * wasteFactor;            // waste applies to panels only
    const panelLF  = effSqft / PANEL_SQFT_PER_LF;         // keep fractional for clips/screws
    const panelCost = panelLF * (PRICES.panelLF[gauge] ?? 0);

    const trimPrices = (gauge === "24") ? PRICES.trim24 : PRICES.trim26;
    const pieces = {
      hip: sticksPlusOne(inputs.hips),       ridge: sticksPlusOne(inputs.ridges),
      gable: sticksPlusOne(inputs.gables),   drip: sticksPlusOne(inputs.eaves),
      svalley: sticksPlusOne(inputs.svalleys),
      sidewall: sticksPlusOne(inputs.sidewalls), endwall: sticksPlusOne(inputs.endwalls),
      transition: sticksPlusOne(inputs.transitions),
    };
    const trimCost = Object.entries(pieces).reduce((s, [k, q]) => s + q * (trimPrices[k] ?? 0), 0);

    // Ice & Water (raw sqft, +1 roll)
    const iws = iwsChoice === 'none'
      ? { label: 'Ice & Water (None)', price: 0, coverSqft: 185 }
      : (PRICES.iws[iwsChoice] || { label: 'Ice & Water', price: 0, coverSqft: 185 });
    const iwsQty = iwsChoice === 'none' ? 0 : (inputs.sqft > 0 ? Math.ceil(inputs.sqft / iws.coverSqft) + 1 : 0);
    const iwsCost = iwsQty * iws.price;

    // Panel clips: not used for 1" Snap Lock
    const clipsRequired   = style !== '1" Snap Lock';
    const clipPiecesNeed  = clipsRequired ? panelLF / PRICES.clips.lfPerPiece : 0;
    const clipBoxes       = clipsRequired && clipPiecesNeed > 0 ? Math.ceil(clipPiecesNeed / PRICES.clips.piecesPerBox) : 0;
    const clipCost        = clipBoxes * PRICES.clips.pricePerBox;

    // Screws: 1 per LF
    const screwBags = panelLF > 0 ? Math.ceil(panelLF / PRICES.screws.piecesPerBag) : 0;
    const screwCost = screwBags * PRICES.screws.pricePerBag;

    // Z metal: double hips + add 1 piece for each 10' of sidewall, endwall, transition (each rounded separately)
    const zExtraWalls = sticksNoExtra(inputs.sidewalls) + sticksNoExtra(inputs.endwalls) + sticksNoExtra(inputs.transitions);
    const zQty   = sticksNoExtra(inputs.hips * 2) + zExtraWalls;
    const zCost  = zQty * (PRICES.z[gauge] ?? 0);

    // Perforated Z: double ridge
    const zPerfQty  = sticksNoExtra(inputs.ridges * 2);
    const zPerfCost = zPerfQty * (PRICES.zPerf[gauge] ?? 0);

    // Staples (raw sqft)
    let stapleBoxes = inputs.sqft > 0 ? Math.ceil(inputs.sqft / PRICES.staples.sqftPerBox) : 0;
    let stapleCost  = stapleBoxes * PRICES.staples.pricePerBox;

    // Fastener exclusivity
    if (fastenerChoice !== 'Crossfire Staples') { stapleBoxes = 0; stapleCost = 0; }

    if (fastenerChoice === 'Plastic Cap Nails') { stapleBoxes = 0; stapleCost = 0; }

    const subtotal   = panelCost + trimCost + iwsCost + clipCost + screwCost + zCost + zPerfCost + stapleCost;
    const markupAmt  = (toNum(markupPct) / 100) * subtotal;
    const taxable    = subtotal + markupAmt;
    const taxAmt     = (toNum(taxPct) / 100) * taxable;
    const grandTotal = taxable + taxAmt;

    return {
      gauge,
      panelLF,
      lines: [
        { label: `Panels (${panelLF.toFixed(0)} lf)${toNum(inputs.wastePct) > 0 ? ` (w/ ${toNum(inputs.wastePct)}% waste)` : ""}`, qty: panelLF, unit: "lf", price: PRICES.panelLF[gauge] ?? 0, total: panelCost },
        { label: "Hip",        qty: pieces.hip,        unit: "10' pcs", price: trimPrices.hip,       total: pieces.hip * trimPrices.hip },
        { label: "Ridge",      qty: pieces.ridge,      unit: "10' pcs", price: trimPrices.ridge,     total: pieces.ridge * trimPrices.ridge },
        { label: "Gable Rake", qty: pieces.gable,      unit: "10' pcs", price: trimPrices.gable,     total: pieces.gable * trimPrices.gable },
        { label: "Drip Edge",  qty: pieces.drip,       unit: "10' pcs", price: trimPrices.drip,      total: pieces.drip * trimPrices.drip },
        { label: "Valleys",    qty: pieces.svalley,    unit: "10' pcs", price: trimPrices.svalley,   total: pieces.svalley * trimPrices.svalley },
        { label: "Sidewall",   qty: pieces.sidewall,   unit: "10' pcs", price: trimPrices.sidewall,  total: pieces.sidewall * trimPrices.sidewall },
        { label: "Endwall",    qty: pieces.endwall,    unit: "10' pcs", price: trimPrices.endwall,   total: pieces.endwall * trimPrices.endwall },
        { label: "Transition", qty: pieces.transition, unit: "10' pcs", price: trimPrices.transition,total: pieces.transition * (trimPrices.transition ?? 0) },
        { label: `${iws.label}`,qty: iwsQty,            unit: "rolls",   price: iws.price,           total: iwsCost },
        { label: "Panel Clips",qty: clipBoxes,         unit: "box",     price: PRICES.clips.pricePerBox, total: clipCost },
        { label: "Pancake Screws", qty: screwBags,     unit: "bag",     price: PRICES.screws.pricePerBag, total: screwCost },
        { label: "Z Metal",    qty: zQty,              unit: "10' pcs", price: PRICES.z[gauge] ?? 0,     total: zCost },
        { label: "Perforated Z Metal", qty: zPerfQty,  unit: "10' pcs", price: PRICES.zPerf[gauge] ?? 0, total: zPerfCost },
        { label: "Staple Pack",qty: stapleBoxes,       unit: "box",     price: PRICES.staples.pricePerBox, total: stapleCost },
      ],
      subtotal, markupAmt, taxableBase: taxable, taxAmt, grandTotal,
    };
  };

  const result24 = useMemo(() => calcForGauge("24"), [inputs, iwsChoice, markupPct, style, fastenerChoice]);
  const result26 = useMemo(() => calcForGauge("26"), [inputs, iwsChoice, markupPct, style, fastenerChoice]);

  // ===== PDF =====
  const buildPdfDoc = () => {
    if (!JsPDF) throw new Error("jsPDF missing");
    const doc = new JsPDF({ unit: "pt", format: "a4" });
    const pw = doc.internal.pageSize.getWidth();
    const ph = doc.internal.pageSize.getHeight();

    const left = 40, top = 40, bottom = 48, gap = 40, colW = (pw - left * 2 - gap) / 2;
    let titleY = top;

    // Logo
    try {
      if (pdfLogoDataUrl) {
        let w = 0, h = 0;
        try {
          const p = doc.getImageProperties(pdfLogoDataUrl);
          const s = Math.min((pw - 80) / p.width, 90 / p.height);
          w = p.width * s; h = p.height * s;
        } catch { w = Math.min(260, pw - 80); h = 60; }
        const x = (pw - w) / 2, y = 20;
        doc.addImage(pdfLogoDataUrl, "PNG", x, y, w, h);
        titleY = y + h + 24;
      }
    } catch {}

    // Title & To
    doc.setFontSize(16); doc.text("Metal Roofing Quote", left, titleY);
    doc.setFontSize(10);
    const now = new Date(); const dateStr = now.toISOString().slice(0, 10);
    let y = titleY + 14;
    doc.text(`Generated: ${now.toLocaleDateString()} ${now.toLocaleTimeString()}`, left, y); y += 14;
    if (customer) { doc.text(`Customer: ${customer}`, left, y); y += 14; }
    if (po)       { doc.text(`PO: ${po}`, left, y); y += 14; }
    doc.text(`Waste: ${toNum(inputs.wastePct)}% (applied to panels only)`, left, y); y += 14;
    const eff = Math.round(toNum(inputs.sqft) * (1 + toNum(inputs.wastePct) / 100));
    doc.text(`Total Square Feet (including waste): ${eff.toLocaleString()}`, left, y); y += 14;

    if (notes && notes.trim()) {
      doc.setFontSize(11); doc.text("Notes:", left, y); y += 14; doc.setFontSize(10);
      const lines = doc.splitTextToSize(notes, pw - left * 2);
      for (const line of lines) { doc.text(line, left, y); y += 12; }
    }

    const yStart = Math.max(y + 16, top + 70);

    const drawCol = (x, title, res) => {
      let cy = yStart;
      doc.setFontSize(13); doc.text(title, x, cy); cy += 16;
      doc.setFontSize(10); doc.text("Items:", x, cy); cy += 12;

      (res?.lines || []).filter(l => l.qty > 0 && l.total > 0).forEach(ln => {
        const qtyStr = `${(ln.qty % 1 === 0 ? ln.qty : Math.round(ln.qty))} ${ln.unit || ""}`;
        const leftText = pdfHidePrices ? `${ln.label}  (${qtyStr})` : `${ln.label}  (${qtyStr} × ${fmt(ln.price)})`;
        doc.text(leftText, x, cy);
        if (!pdfHidePrices) doc.text(fmt(ln.total), x + colW - 8, cy, { align: "right" });
        cy += 12;
        if (cy > ph - bottom - 80) { doc.addPage(); cy = top; }
      });

      cy += 8; doc.line(x, cy, x + colW, cy); cy += 12;

      const dispSub = pdfHidePrices ? (Number(res.subtotal || 0) + Number(res.markupAmt || 0)) : Number(res.subtotal || 0);
      doc.text(`Subtotal: ${fmt(dispSub)}`, x, cy); cy += 12;
      if (!pdfHidePrices) {
        doc.text(`Markup (${markupPct}%): ${fmt(res.markupAmt || 0)}`, x, cy); cy += 12;
        doc.text(`Taxable: ${fmt(res.taxableBase || 0)}`, x, cy); cy += 12;
      }
      doc.text(`Tax (${taxPct}%): ${fmt(res.taxAmt || 0)}`, x, cy); cy += 12;
      doc.setFontSize(12); doc.text(`Grand Total: ${fmt(res.grandTotal || 0)}`, x, cy);
    };

    // Draw both columns
    drawCol(left,            "24 Gauge", result24);
    drawCol(left + colW + gap, "26 Gauge", result26);

    // Footer on each page
    const pages = doc.getNumberOfPages();
    for (let i = 1; i <= pages; i++) {
      doc.setPage(i);
      const H = doc.internal.pageSize.getHeight();
      doc.setFontSize(9);
      doc.text("Powered by Empire Supply - 801-391-7549", pw / 2, H - 24, { align: "center" });
    }

    return { doc, dateStr };
  };

  const exportPDF = () => {
    try {
      const { doc, dateStr } = buildPdfDoc();
      const fileName = buildFileName(customer, po, dateStr);
      try {
        const blob = doc.output("blob");
        const url  = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url; a.download = fileName; a.rel = "noopener";
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1500);
      } catch {
        const url = doc.output("bloburl");
        window.open(url, "_blank");
      }
    } catch (e) { console.error("PDF export failed", e); alert("PDF export failed."); }
  };

  const [isPreviewOpen, setIsPreviewOpen] = useState(false);
  const [previewUrl, setPreviewUrl] = useState("");
  const closePreview = () => { try { if (previewUrl?.startsWith("blob:")) URL.revokeObjectURL(previewUrl); } catch {} setPreviewUrl(""); setIsPreviewOpen(false); };
  useEffect(() => () => { try { if (previewUrl?.startsWith("blob:")) URL.revokeObjectURL(previewUrl); } catch {} }, [previewUrl]);
  const previewPDF = () => {
    try {
      const { doc } = buildPdfDoc();
      try { const b = doc.output("blob"); const url = URL.createObjectURL(b); setPreviewUrl(url); setIsPreviewOpen(true); return; } catch {}
      try { const d = doc.output("datauristring"); setPreviewUrl(d); setIsPreviewOpen(true); return; } catch {}
      exportPDF();
    } catch (e) { console.error("preview fail", e); exportPDF(); }
  };

  // ===== UI =====
  return (
    <div className="p-4 max-w-5xl mx-auto">
      <div className="flex items-center gap-3">
        <img src={LOGO_SRC} alt="Empire Supply" className="h-12 w-auto" />
        <h2 className="text-base font-bold flex items-center gap-2">
          <FileText className="w-5 h-5"/> Metal Roofing Quote <span className="ml-2 text-slate-500">v{APP_VERSION}</span>
        </h2>
      </div>
      <hr className="my-4 border-t border-slate-200/60"/>

      {/* Job Details */}
      <div className="mt-4 mb-6 bg-white border border-slate-200/60 rounded-2xl overflow-hidden ring-1 ring-slate-200/50 shadow-sm">
        <div className="px-3 py-2 text-base font-bold uppercase bg-slate-50 border-b border-slate-200/60">Job Details</div>
        <div className="px-3 divide-y divide-slate-200/60">
          <Row label="Customer"><input id="field-customer" className="input" placeholder="Customer name" value={customer} onChange={e=>setCustomer(e.target.value)}/></Row>
          <Row label="PO"><input id="field-po" className="input" placeholder="PO #" value={po} onChange={e=>setPo(e.target.value)}/></Row>
          <Row label="Style">
            <select id="field-style" className="input" value={style} onChange={e=>setStyle(e.target.value)}>
              {STYLE_OPTIONS.map(opt => <option key={opt} value={opt}>{opt}</option>)}
            </select>
          </Row>
          <Row label="Markup %"><input id="field-markup" type="number" inputMode="decimal" className="input" value={markupPct} onChange={e=>setMarkupPct(toNum(e.target.value))}/></Row>
        </div>
      </div>

      <hr className="my-4 border-t border-slate-200/60"/>

      {/* Measurements */}
      <div className="bg-white border border-slate-200/60 rounded-2xl overflow-hidden ring-1 ring-slate-200/50 shadow-sm">
        <div className="px-3 py-2 text-base font-bold uppercase bg-slate-50 border-b border-slate-200/60">Measurements</div>
        <div className="px-3 divide-y divide-slate-200/60">
          <Row label="Total Square Feet"><Num id="field-sqft" v={inputs.sqft}  onCh={v=>update("sqft", v)} /></Row>
          <Row label="Waste %"><Num id="field-waste" v={inputs.wastePct} onCh={v=>update("wastePct", v)} /></Row>
          <Row label="Type of Ice & Water">
            <select id="field-iws" className="input" value={iwsChoice} onChange={e=>setIwsChoice(e.target.value)}>
              <option value="butyl">{`${PRICES.iws.butyl.label} (${PRICES.iws.butyl.stock})`}</option>
              <option value="standard">{`${PRICES.iws.standard.label} (${PRICES.iws.standard.stock})`}</option>
              <option value="none">None</option>
            </select>
          </Row>
          <Row label="Nails / Staples">
            <select id="field-fasteners" className="input" value={fastenerChoice} onChange={e=>setFastenerChoice(e.target.value)}>
              <option value="Plastic Cap Nails">Plastic Cap Nails</option>
              <option value="Crossfire Staples">Crossfire Staples</option>
              <option value="None">None</option>
            </select>
          </Row>
          <Row label="Hips (lf)"><Num id="field-hips" v={inputs.hips} onCh={v=>update("hips", v)} /></Row>
          <Row label="Ridges (lf)"><Num id="field-ridges" v={inputs.ridges} onCh={v=>update("ridges", v)} /></Row>
          <Row label="Gable Rakes (lf)"><Num id="field-gables" v={inputs.gables} onCh={v=>update("gables", v)} /></Row>
          <Row label="Drip Edge / Eaves (lf)"><Num id="field-eaves" v={inputs.eaves} onCh={v=>update("eaves", v)} /></Row>
          <Row label="Valleys (lf)"><Num id="field-svalleys" v={inputs.svalleys} onCh={v=>update("svalleys", v)} /></Row>
          <Row label="Sidewall (lf)"><Num id="field-sidewalls" v={inputs.sidewalls} onCh={v=>update("sidewalls", v)} /></Row>
          <Row label="Endwall (lf)"><Num id="field-endwalls" v={inputs.endwalls} onCh={v=>update("endwalls", v)} /></Row>
          <Row label="Transition (lf)"><Num id="field-transitions" v={inputs.transitions} onCh={v=>update("transitions", v)} /></Row>
        </div>
      </div>

      {/* Notes */}
      <div className="mt-4">
        <label htmlFor="field-notes" className="text-sm font-medium block mb-1">Notes</label>
        <textarea id="field-notes" className="border border-slate-300/60 focus:border-slate-400/50 focus:ring-1 focus:ring-slate-400/30 p-3 rounded-md w-full h-28 bg-white" placeholder="Add any job notes (special trims, etc.)" value={notes} onChange={e=>setNotes(e.target.value)} />
      </div>

      <hr className="my-4 border-t border-slate-200/60"/>

      {/* Results */}
      <div className="mt-6 grid md:grid-cols-2 gap-4">
        {[result24, result26].map(res => (
          <div key={res.gauge} className="bg-white border border-slate-200/60 rounded-2xl p-4">
            <h2 className="font-semibold text-lg">{res.gauge} Gauge</h2>
            {res?.lines?.length ? (
              <table className="w-full text-sm mt-3">
                <thead>
                  <tr className="text-left border-b border-slate-200/60">
                    <th className="py-1">Item</th>
                    <th className="py-1 text-right">Qty × Unit</th>
                    <th className="py-1 text-right">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {res.lines.filter(l => l.qty > 0 && l.total > 0).map((ln, idx) => (
                    <tr key={idx} className="border-b border-slate-200/60">
                      <td className="py-1">{ln.label}</td>
                      <td className="py-1 text-right">{`${(ln.qty % 1 === 0 ? ln.qty : Math.round(ln.qty))} ${ln.unit || ""}`} × {fmt(ln.price)}</td>
                      <td className="py-1 text-right">{fmt(ln.total)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <div className="text-sm text-slate-500 mt-2">Enter measurements to see pricing.</div>
            )}

            <div className="mt-3 grid grid-cols-2 gap-1 text-sm">
              <div className="text-slate-600">Subtotal</div><div className="text-right font-medium">{fmt(res.subtotal || 0)}</div>
              <div className="text-slate-600">Markup ({markupPct}%)</div><div className="text-right font-medium">{fmt(res.markupAmt || 0)}</div>
              <div className="text-slate-600">Taxable</div><div className="text-right font-medium">{fmt(res.taxableBase || 0)}</div>
              <div className="text-slate-600">Tax ({taxPct}%)</div><div className="text-right font-medium">{fmt(res.taxAmt || 0)}</div>
              <div className="col-span-2 border-t border-slate-200/60 pt-2 flex items-center">
                <div className="text-base font-semibold">Grand Total</div>
                <div className="ml-auto text-base font-semibold">{fmt(res.grandTotal || 0)}</div>
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Actions */}
      <div className="mt-4">
        <button type="button" onClick={exportPDF} className="btn-primary"><Download className="w-4 h-4"/>Export PDF</button>
        <button type="button" onClick={previewPDF} className="btn-secondary ml-2">Preview PDF</button>
        <label className="ml-3 inline-flex items-center gap-2 text-sm align-middle">
          <input type="checkbox" className="h-4 w-4" checked={pdfHidePrices} onChange={e=>setPdfHidePrices(e.target.checked)} />
          Hide line prices & markup on PDF
        </label>
        <div className="mt-3 flex flex-wrap gap-2">
          <button type="button" onClick={onSaveQuote} className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-emerald-600 text-white hover:bg-emerald-700">Save Quote on Device</button>
          <button type="button" onClick={openManager} className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-white border border-slate-300/60 hover:bg-slate-50">Open Saved Quote</button>
        </div>
      </div>

      <div className="h-6"/><div className="h-6"/>
      <footer className="text-center text-sm text-slate-500">Powered by Empire Supply - 801-391-7549</footer>
      <div className="h-6"/><div className="h-6"/>

      {/* Saved Quotes Manager */}
      {isManagerOpen && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center" onClick={() => setIsManagerOpen(false)}>
          <div className="bg-white w-[95vw] max-w-3xl rounded-xl shadow-xl overflow-hidden" onClick={e=>e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Saved Quotes">
            <div className="px-4 py-3 border-b border-slate-200/60 flex items-center justify-between">
              <div className="font-semibold">Saved Quotes</div>
              <div className="flex gap-2"><button type="button" className="text-xs px-3 py-1 rounded bg-slate-900 text-white" onClick={() => setIsManagerOpen(false)}>Close</button></div>
            </div>
            <div className="max-h-[65vh] overflow-y-auto">
              {quoteList.length === 0 ? (
                <div className="p-4 text-sm text-slate-600">No saved quotes on this device yet.</div>
              ) : (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left border-b border-slate-200/60"><th className="py-2 px-3">Name</th><th className="py-2 px-3">Created</th><th className="py-2 px-3 text-right">Actions</th></tr>
                  </thead>
                  <tbody>
                    {quoteList.map(q => (
                      <tr key={q.id} className="border-b border-slate-100">
                        <td className="py-2 px-3 align-top">{q.name}</td>
                        <td className="py-2 px-3 align-top">{new Date(q.createdAt).toLocaleString()}</td>
                        <td className="py-2 px-3 text-right">
                          <button className="text-xs px-2 py-1 border rounded mr-2 hover:bg-slate-50" onClick={() => loadQuoteIntoForm(q)}>Load</button>
                          <button className="text-xs px-2 py-1 border rounded hover:bg-slate-50" onClick={() => { if (confirm('Delete this saved quote?')) deleteQuote(q.id); }}>Delete</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </div>
      )}

      {/* PDF Preview Modal */}
      {isPreviewOpen && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center" onClick={closePreview}>
          <div className="bg-white w-[95vw] max-w-5xl rounded-xl shadow-xl overflow-hidden" onClick={(e)=>e.stopPropagation()} role="dialog" aria-modal="true" aria-label="PDF Preview">
            <div className="px-4 py-3 border-b border-slate-200/60 flex items-center justify-between">
              <div className="font-semibold">PDF Preview</div>
              <div className="flex gap-2">
                <button type="button" className="text-xs px-3 py-1 border rounded hover:bg-slate-50" onClick={()=>{ try { window.open(previewUrl, '_blank'); } catch {} }}>Open in New Tab</button>
                <button type="button" className="text-xs px-3 py-1 border rounded hover:bg-slate-50" onClick={exportPDF}>Download PDF</button>
                <button type="button" className="text-xs px-3 py-1 rounded bg-slate-900 text-white" onClick={closePreview}>Close</button>
              </div>
            </div>
            <div className="h-[75vh]"><iframe title="PDF Preview" src={previewUrl} className="w-full h-full" style={{ border: 0 }} /></div>
          </div>
        </div>
      )}
    </div>
  );
}

// --- Tiny UI helpers (keeps JSX short and Canvas-safe) ---
function Row({ label, children }) {
  return (
    <div className="flex items-center justify-between gap-3 py-2">
      <label className="text-sm font-medium whitespace-nowrap">{label}</label>
      <div className="w-48 max-w-[60vw]">{children}</div>
    </div>
  );
}
function Num({ id, v, onCh }) {
  return (
    <input id={id} type="number" inputMode="decimal" className="input" value={v} onChange={e=>onCh(e.target.value)} />
  );
}

// --- Reusable Tailwind classes ---
// (Using small class aliases to reduce repetition/size for Canvas limit)
const _style = document.createElement('style');
_style.textContent = `
  .input{ border:1px solid rgba(100,116,139,.6); background:white; border-radius:.375rem; height:2.5rem; padding:.5rem; width:100%; }
  .input:focus{ outline:none; box-shadow:0 0 0 2px rgba(100,116,139,.3); border-color:rgba(100,116,139,.5) }
  .btn-primary{ display:inline-flex; align-items:center; gap:.5rem; padding:.5rem 1rem; border-radius:1rem; background:#0f172a; color:white }
  .btn-primary:hover{ filter:brightness(1.05) }
  .btn-secondary{ display:inline-flex; align-items:center; gap:.5rem; padding:.5rem 1rem; border-radius:1rem; background:white; border:1px solid rgba(100,116,139,.6) }
`;
if (typeof document !== 'undefined') document.head.appendChild(_style);
