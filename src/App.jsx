import React, { useMemo, useState, useEffect } from "react";
import { FileText, Download } from "lucide-react";
import * as JSPDFNS from "jspdf";

// Resolve jsPDF constructor across module variations
const JsPDF = JSPDFNS.jsPDF || JSPDFNS.default || JSPDFNS;

// --- App Version ---
const APP_VERSION = "1.1.3"; // stable export/preview

// --- Logo asset ---
// Place your logo at /public/icons/icon-512.png so it serves from /icons/icon-512.png
const LOGO_SRC = "/icons/icon-512.png";

// --- Formatting helpers ---
const CURRENCY = "USD";
const fmt = (n) => new Intl.NumberFormat(undefined, { style: "currency", currency: CURRENCY }).format(isFinite(n) ? n : 0);
const toNum = (v) => (isFinite(+v) ? +v : 0);

// Filename helpers (portable)
const sanitizePart = (s) => {
  const allowed = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const norm = (s || "").trim().replaceAll(" ", "_");
  let out = ""; for (const ch of norm) if (allowed.includes(ch)) out += ch;
  return out.slice(0, 60);
};
const buildFileName = (customer, po, dateStr) => {
  const c = sanitizePart(customer); const p = sanitizePart(po);
  return (c || p) ? `${c || "Customer"}-${p || "PO"}-${dateStr}.pdf` : `Quote-${dateStr}.pdf`;
};

// --- Math helpers ---
const PANEL_SQFT_PER_LF = 1.3333; // 1 linear foot of panel covers 1.3333 sqft
const sticksPlusOne = (lf) => { const pieces = Math.ceil(Math.max(0, lf) / 10); return pieces > 0 ? pieces + 1 : 0; };
const sticksNoExtra = (lf) => Math.ceil(Math.max(0, lf) / 10);

// --- Price book ---
const PRICES = {
  panelLF: { "26": 2.5, "24": 3.5 },
  trim24: { hip: 39.08, ridge: 39.08, gable: 28.76, drip: 25.87, svalley: 69.01, sidewall: 31.63, endwall: 37.38, transition: 43.14 },
  trim26: { hip: 24.02, ridge: 24.02, gable: 23.98, drip: 21.68, svalley: 66.26, sidewall: 23.85, endwall: 29.63, transition: 29.63 },
  z: { "24": 9.96, "26": 9.74 }, // 10' each
  zPerf: { "24": 27.41, "26": 26.43 }, // 10' each
  iws: {
    standard: { label: "Polyglass", price: 64.29, coverSqft: 185, stock: "Out of Stock" },
    butyl: { label: "GripRite", price: 129.60, coverSqft: 185, stock: "In Stock" },
  },
  clips: { pricePerBox: 246.17, piecesPerBox: 1000, lfPerPiece: 2 }, // 1 piece per 2 lf panels
  screws: { pricePerBag: 18.91, piecesPerBag: 250, lfPerPiece: 1 }, // 1 screw per lf panels
  staples: { pricePerBox: 48.79, sqftPerBox: 1500 },
  butylRoll: { label: 'butyl roll', price: 5.20 },
  plasticCapPail: { label: 'Plastic Cap Pail', price: 18.84 }
};

export default function MetalRoofQuoteApp() {
  // Header fields
  const [customer, setCustomer] = useState("");
  const [po, setPo] = useState("");
  const [iwsChoice, setIwsChoice] = useState("butyl"); // standard | butyl (GripRite default)
  const [fastenerChoice, setFastenerChoice] = useState("Plastic Cap Nails");
  const [notes, setNotes] = useState("");

  // Roof style selection
  const STYLE_OPTIONS = ['1.5" Mechanical Standing Seam', '1.5" Lock Seam', '1" Snap Lock'];
  const [style, setStyle] = useState(STYLE_OPTIONS[0]);

  // Precompute a DataURL of the logo for embedding into the PDF (jsPDF needs a data URL for reliability)
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
          const data = canvas.toDataURL("image/png");
          setPdfLogoDataUrl(data);
        } catch (e) { console.warn("Logo toDataURL failed:", e?.message); }
      };
      img.onerror = () => console.warn("Logo failed to load from", LOGO_SRC);
      img.src = LOGO_SRC;
    } catch (e) { console.warn("Logo preload error:", e?.message); }
  }, []);

  // In-app preview state
  const [isPreviewOpen, setIsPreviewOpen] = useState(false);
  const [previewUrl, setPreviewUrl] = useState("");
  const closePreview = () => {
    try { if (previewUrl && previewUrl.startsWith("blob:")) URL.revokeObjectURL(previewUrl); } catch {}
    setPreviewUrl(""); setIsPreviewOpen(false);
  };
  useEffect(() => () => { try { if (previewUrl && previewUrl.startsWith("blob:")) URL.revokeObjectURL(previewUrl); } catch {} }, [previewUrl]);

  // PDF options
  const [pdfHidePrices, setPdfHidePrices] = useState(() => {
    try { return localStorage.getItem("pdfHidePrices") === "1"; } catch { return false; }
  });
  useEffect(() => { try { localStorage.setItem("pdfHidePrices", pdfHidePrices ? "1" : "0"); } catch {} }, [pdfHidePrices]);

  // Pricing modifiers
  const [markupPct, setMarkupPct] = useState(() => {
    const saved = localStorage.getItem("lastMarkup");
    return saved ? Number(saved) : 0;
  });
  useEffect(() => { localStorage.setItem("lastMarkup", String(markupPct)); }, [markupPct]);
  const taxPct = 7.25; // locked

  // Measurements
  const [inputs, setInputs] = useState({
    sqft: 0,
    wastePct: 0,
    hips: 0,
    ridges: 0,
    gables: 0,
    eaves: 0, // Drip Edge
    svalleys: 0,
    sidewalls: 0,
    endwalls: 0,
    transitions: 0,
  });
  const update = (k, v) => setInputs((s) => ({ ...s, [k]: toNum(v) }));

  // Core calculator for a given gauge
  const calcForGauge = (gauge) => {
    const wasteFactor = 1 + (toNum(inputs.wastePct) / 100);
    const effSqft = inputs.sqft * wasteFactor;
    const panelLF = effSqft / PANEL_SQFT_PER_LF; // do not round; keep raw for clips/screws
    const panelCost = panelLF * (PRICES.panelLF[gauge] ?? 0);

    const trimPrices = gauge === "24" ? PRICES.trim24 : PRICES.trim26;
    const pieces = {
      hip: sticksPlusOne(inputs.hips),
      ridge: sticksPlusOne(inputs.ridges),
      gable: sticksPlusOne(inputs.gables),
      drip: sticksPlusOne(inputs.eaves),
      svalley: sticksPlusOne(inputs.svalleys),
      sidewall: sticksPlusOne(inputs.sidewalls),
      endwall: sticksPlusOne(inputs.endwalls),
      transition: sticksPlusOne(inputs.transitions),
    };

    const trimCost = Object.entries(pieces).reduce((sum, [key, qty]) => sum + qty * (trimPrices[key] ?? 0), 0);

    // Ice & Water (choose one) — uses raw sqft (waste not applied)
    const iws = PRICES.iws[iwsChoice] || { label: "Ice & Water", price: 0, coverSqft: 185 };
    const iwsQty = inputs.sqft > 0 ? Math.ceil(inputs.sqft / iws.coverSqft) + 1 : 0; // +1 roll
    const iwsCost = iwsQty * iws.price;

    // Panel clips (not used for 1" Snap Lock)
    const clipsRequired = style !== '1" Snap Lock';
    const clipPiecesNeeded = clipsRequired ? panelLF / PRICES.clips.lfPerPiece : 0;
    const clipBoxes = clipsRequired && clipPiecesNeeded > 0 ? Math.ceil(clipPiecesNeeded / PRICES.clips.piecesPerBox) : 0;
    const clipCost = clipBoxes * PRICES.clips.pricePerBox;

    // Pancake screws (1 per LF of panels)
    const screwBags = panelLF > 0 ? Math.ceil(panelLF / PRICES.screws.piecesPerBag) : 0;
    const screwCost = screwBags * PRICES.screws.pricePerBag;

    // Z metals: base on double hips, plus 1 piece per each 10' of sidewall, endwall, and transition (rounded up separately). Still no universal "+1".
    const zExtraFromWalls = sticksNoExtra(inputs.sidewalls) + sticksNoExtra(inputs.endwalls) + sticksNoExtra(inputs.transitions);
    const zQty = sticksNoExtra(inputs.hips * 2) + zExtraFromWalls; // double hips + extras from walls/transitions
    const zCost = zQty * (PRICES.z[gauge] ?? 0);

    const zPerfQty = sticksNoExtra(inputs.ridges * 2); // double ridge, round up to 10'
    const zPerfCost = zPerfQty * (PRICES.zPerf[gauge] ?? 0);

    // Butyl Roll math (qty & cost only)
    // qty = ceil(((hips + ridges) * 2 + sidewall + endwall + transition) / 50)
    const totalLfForButyl =
      (toNum(inputs.hips) + toNum(inputs.ridges)) * 2 +
      toNum(inputs.sidewalls) + toNum(inputs.endwalls) + toNum(inputs.transitions);
    const butylRolls = totalLfForButyl > 0 ? Math.ceil(totalLfForButyl / 50) : 0;
    const butylRollCost = butylRolls * (PRICES.butylRoll?.price || 0);

    // Staples — uses raw sqft (waste not applied)
    let stapleBoxes = inputs.sqft > 0 ? Math.ceil(inputs.sqft / PRICES.staples.sqftPerBox) : 0;
    let stapleCost = stapleBoxes * PRICES.staples.pricePerBox;

    // Plastic Cap Pail — same quantity rule as Staple Pack (uses raw sqft, 1 pail per 1500 sqft)
    let plasticPails = inputs.sqft > 0 ? Math.ceil(inputs.sqft / PRICES.staples.sqftPerBox) : 0;
    let plasticPailCost = plasticPails * (PRICES.plasticCapPail?.price || 0);

    // Fastener selection exclusivity
    if (fastenerChoice === 'Plastic Cap Nails') {
      // Plastic cap nails selected -> no staple packs
      stapleBoxes = 0; stapleCost = 0;
    } else if (fastenerChoice === 'Crossfire Staples') {
      // Crossfire staples selected -> no plastic cap pails
      plasticPails = 0; plasticPailCost = 0;
    }

    const subtotal = panelCost + trimCost + iwsCost + clipCost + screwCost + zCost + zPerfCost + butylRollCost + stapleCost + plasticPailCost;
    const markupAmt = (toNum(markupPct) / 100) * subtotal;
    const taxableBase = subtotal + markupAmt; // tax after markup
    const taxAmt = (toNum(taxPct) / 100) * taxableBase;
    const grandTotal = taxableBase + taxAmt;

    return {
      gauge,
      panelLF,
      lines: [
        { label: `Panels (${panelLF.toFixed(0)} lf)${toNum(inputs.wastePct) > 0 ? ` (w/ ${toNum(inputs.wastePct)}% waste)` : ""}`, qty: panelLF, unit: "lf", price: PRICES.panelLF[gauge] ?? 0, total: panelCost },
        { label: `Hip`, qty: pieces.hip, unit: "10' pcs", price: trimPrices.hip, total: pieces.hip * trimPrices.hip },
        { label: `Ridge`, qty: pieces.ridge, unit: "10' pcs", price: trimPrices.ridge, total: pieces.ridge * trimPrices.ridge },
        { label: `Gable Rake`, qty: pieces.gable, unit: "10' pcs", price: trimPrices.gable, total: pieces.gable * trimPrices.gable },
        { label: `Drip Edge`, qty: pieces.drip, unit: "10' pcs", price: trimPrices.drip, total: pieces.drip * trimPrices.drip },
        { label: `Valleys`, qty: pieces.svalley, unit: "10' pcs", price: trimPrices.svalley, total: pieces.svalley * trimPrices.svalley },
        { label: `Sidewall`, qty: pieces.sidewall, unit: "10' pcs", price: trimPrices.sidewall, total: pieces.sidewall * trimPrices.sidewall },
        { label: `Endwall`, qty: pieces.endwall, unit: "10' pcs", price: trimPrices.endwall, total: pieces.endwall * trimPrices.endwall },
        { label: `Transition`, qty: pieces.transition, unit: "10' pcs", price: trimPrices.transition, total: pieces.transition * (trimPrices.transition ?? 0) },
        { label: `${iws.label}`, qty: iwsQty, unit: "rolls", price: iws.price, total: iwsCost },
        { label: `Panel Clips`, qty: clipBoxes, unit: "box", price: PRICES.clips.pricePerBox, total: clipCost },
        { label: `Pancake Screws`, qty: screwBags, unit: "bag", price: PRICES.screws.pricePerBag, total: screwCost },
        { label: `Z Metal`, qty: zQty, unit: "10' pcs", price: PRICES.z[gauge] ?? 0, total: zCost },
        { label: `Perforated Z Metal`, qty: zPerfQty, unit: "10' pcs", price: PRICES.zPerf[gauge] ?? 0, total: zPerfCost },
        { label: PRICES.butylRoll.label, qty: butylRolls, unit: "rolls", price: PRICES.butylRoll.price, total: butylRollCost },
        { label: `Staple Pack`, qty: stapleBoxes, unit: "box", price: PRICES.staples.pricePerBox, total: stapleCost },
        { label: PRICES.plasticCapPail.label, qty: plasticPails, unit: "pail", price: PRICES.plasticCapPail.price, total: plasticPailCost },
      ],
      subtotal, markupAmt, taxableBase, taxAmt, grandTotal,
    };
  };

  const result24 = useMemo(() => calcForGauge("24"), [inputs, iwsChoice, markupPct, style, fastenerChoice]);
  const result26 = useMemo(() => calcForGauge("26"), [inputs, iwsChoice, markupPct, style, fastenerChoice]);

  // --- Minimal self-tests (console) ---
  useEffect(() => {
    const approx = (a, b, eps = 1e-4) => Math.abs(a - b) < eps;
    console.assert(approx(100 / PANEL_SQFT_PER_LF, 75.0075), "Panels LF conversion");
    console.assert(sticksPlusOne(0) === 0, "sticksPlusOne(0) -> 0");
    console.assert(sticksPlusOne(10) === 2, "10lf => 1 + 1 extra = 2");
    console.assert(sticksPlusOne(20) === 3, "20lf => 2 + 1 extra = 3");
    console.assert(sticksPlusOne(0.1) === 2, "very small lf still rounds up then +1");
    console.assert(sticksPlusOne(9.9) === 2, "round-up then +1 for trims (<10lf)");
    console.assert(sticksNoExtra(19) === 2, "round-up to 10' sticks");
    console.assert(sticksNoExtra(0) === 0, "no sticks when length is zero");
    console.assert(sticksNoExtra(30) === 3, "double hips/ridge math produces correct stick count");
    // filename tests
    console.assert(buildFileName("ACME Roofing", "PO123", "2025-08-19") === "ACME_Roofing-PO123-2025-08-19.pdf", "filename format");
    console.assert(buildFileName("", "", "2025-08-19").startsWith("Quote-"), "fallback filename format");
    // ensure iws labels
    console.assert(PRICES.iws.standard.label === "Polyglass", "iws label Polyglass");
    console.assert(PRICES.iws.butyl.label === "GripRite", "iws label GripRite");
    // butyl roll sanity checks (display/config only)
    console.assert(!!PRICES.butylRoll && PRICES.butylRoll.price === 5.20, "butyl roll price present");
    console.assert(Math.ceil(((10+10)*2 + 0 + 0 + 0) / 50) === 1, "butyl roll qty rounding");
  }, []);

  // Build the PDF content once so we can reuse for download or preview
  const buildPdfDoc = () => {
    if (!JsPDF) throw new Error("jsPDF is not available");
    const doc = new JsPDF({ unit: "pt", format: "a4" });
    const pageWidth = doc.internal.pageSize.getWidth();
    const pageHeight = doc.internal.pageSize.getHeight();
    const left = 40, top = 40, bottom = 48, colGap = 40, colWidth = (pageWidth - left * 2 - colGap) / 2;

    // Header logo + title
    let titleY = top; // default if no logo
    try {
      if (pdfLogoDataUrl) {
        const maxW = pageWidth - 80; // keep side margins
        const maxH = 90;            // cap height to preserve space
        let w = 0, h = 0;
        try {
          const props = doc.getImageProperties(pdfLogoDataUrl);
          const scale = Math.min(maxW / props.width, maxH / props.height);
          w = props.width * scale;
          h = props.height * scale;
        } catch (e) {
          // Fallback if getImageProperties isn't available
          w = Math.min(260, pageWidth - 80);
          h = 60;
        }
        const x = (pageWidth - w) / 2;
        const y = 20; // place near top
        doc.addImage(pdfLogoDataUrl, "PNG", x, y, w, h);
        titleY = y + h + 24; // start title several lines below the logo
      }
    } catch (e) { console.warn("Logo skipped in PDF:", e?.message); }

    // Title
    doc.setFontSize(16);
    doc.text("Metal Roofing Quote", left, titleY);

    // Header meta
    doc.setFontSize(10);
    const now = new Date(); const dateStr = now.toISOString().slice(0, 10);
    let headerY = titleY + 14;
    // Generated first
    doc.text(`Generated: ${now.toLocaleDateString()} ${now.toLocaleTimeString()}`, left, headerY); headerY += 14;
    // Then Customer and PO
    if (customer) { doc.text(`Customer: ${customer}`, left, headerY); headerY += 14; }
    if (po) { doc.text(`PO: ${po}`, left, headerY); headerY += 14; }
    // Waste % (applied to panels only)
    doc.text(`Waste: ${toNum(inputs.wastePct)}% (applied to panels only)`, left, headerY); headerY += 14;
    // Then Notes right under PO
    if (notes && notes.trim()) {
      doc.setFontSize(11); doc.text("Notes:", left, headerY); headerY += 14;
      doc.setFontSize(10);
      const wrappedHead = doc.splitTextToSize(notes, pageWidth - left * 2);
      wrappedHead.forEach((line) => { doc.text(line, left, headerY); headerY += 12; });
    }

    const yStart = Math.max(headerY + 16, top + 70); // body starts below header/notes

    const drawCol = (x, title, res) => {
      let y = yStart;
      doc.setFontSize(13); doc.text(title, x, y); y += 16;
      doc.setFontSize(10); doc.text(`Panels: ${res.panelLF.toFixed(0)} lf`, x, y); y += 14;
      doc.text("Items:", x, y); y += 12;

      const lines = (res?.lines || []).filter((l) => l.qty > 0 && l.total > 0);
      lines.forEach((ln) => {
        const qtyStr = `${ln.qty % 1 === 0 ? ln.qty : Math.round(ln.qty)} ${ln.unit || ""}`;
        const leftText = pdfHidePrices
          ? `${ln.label}  (${qtyStr})`
          : `${ln.label}  (${qtyStr} × ${fmt(ln.price)})`;
        doc.text(leftText, x, y);
        if (!pdfHidePrices) {
          doc.text(fmt(ln.total), x + colWidth - 8, y, { align: "right" });
        }
        y += 12;
        if (y > pageHeight - bottom - 80) { doc.addPage(); y = top; }
      });

      y += 8; doc.line(x, y, x + colWidth, y); y += 12;
      doc.text(`Subtotal: ${fmt(res.subtotal || 0)}`, x, y); y += 12;
      if (!pdfHidePrices) {
        doc.text(`Markup (${markupPct}%): ${fmt(res.markupAmt || 0)}`, x, y); y += 12;
        doc.text(`Taxable: ${fmt(res.taxableBase || 0)}`, x, y); y += 12;
      }
      doc.text(`Tax (${taxPct}%): ${fmt(res.taxAmt || 0)}`, x, y); y += 12;
      doc.setFontSize(12); doc.text(`Grand Total: ${fmt(res.grandTotal || 0)}`, x, y);
    };

    // Draw both columns
    drawCol(left, "24 Gauge", result24);
    drawCol(left + colWidth + colGap, "26 Gauge", result26);

    // Global footer centered at the bottom of each page
    const totalPages = doc.getNumberOfPages();
    for (let i = 1; i <= totalPages; i++) {
      doc.setPage(i);
      const ph = doc.internal.pageSize.getHeight ? doc.internal.pageSize.getHeight() : pageHeight;
      doc.setFontSize(9);
      doc.text("Powered by Empire Supply - 801-391-7549", pageWidth / 2, ph - 24, { align: "center" });
    }
    return { doc, dateStr };
  };

  // Export: download as file (Blob first, fallback to new tab)
  const exportPDF = () => {
    try {
      const { doc, dateStr } = buildPdfDoc();
      const fileName = buildFileName(customer, po, dateStr);
      try {
        const blob = doc.output("blob");
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url; a.download = fileName; a.rel = "noopener";
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1500);
      } catch (err) {
        const url = doc.output("bloburl");
        window.open(url, "_blank");
      }
    } catch (e) {
      console.error("PDF export failed:", e);
      alert("PDF export failed. Open the browser console for details.");
    }
  };

  // Preview: in-app modal (iframe)
  const previewPDF = () => {
    try {
      const { doc } = buildPdfDoc();
      try {
        const blob = doc.output("blob");
        const url = URL.createObjectURL(blob);
        setPreviewUrl(url); setIsPreviewOpen(true);
        return;
      } catch (err) { console.warn("Blob preview failed, trying data URI:", err?.message); }
      try {
        const dataUri = doc.output("datauristring");
        setPreviewUrl(dataUri); setIsPreviewOpen(true);
        return;
      } catch (err) { console.warn("Data URI preview failed; forcing download:", err?.message); exportPDF(); }
    } catch (e) { console.error("PDF preview failed:", e); exportPDF(); }
  };

  return (
    <div className="p-4 max-w-5xl mx-auto">
      <div className="flex items-center gap-3">
        <img src={LOGO_SRC} alt="Empire Supply" className="h-12 w-auto" />
        <h2 className="text-base font-bold flex items-center gap-2"><FileText className="w-5 h-5"/> Metal Roofing Quote <span className="ml-2 text-slate-500">v{APP_VERSION}</span></h2>
      </div>
      <hr className="my-4 border-t border-slate-200/60" />

      {/* Job Details */}
      <div className="mt-4 mb-6 bg-white border border-slate-200/60 rounded-2xl overflow-hidden ring-1 ring-slate-200/50 shadow-sm">
        <div className="px-3 py-2 text-base font-bold uppercase bg-slate-50 border-b border-slate-200/60">Job Details</div>
        <div className="px-3 divide-y divide-slate-200/60">
          <div className="flex items-center justify-between gap-3 py-2">
            <label htmlFor="field-customer" className="text-sm font-medium whitespace-nowrap">Customer</label>
            <input id="field-customer" className="border border-slate-300/60 focus:border-slate-400/50 focus:ring-1 focus:ring-slate-400/30 p-2 rounded-md w-48 h-10 max-w-[60vw] bg-white" placeholder="Customer name" value={customer} onChange={(e) => setCustomer(e.target.value)} />
          </div>
          <div className="flex items-center justify-between gap-3 py-2">
            <label htmlFor="field-po" className="text-sm font-medium whitespace-nowrap">PO</label>
            <input id="field-po" className="border border-slate-300/60 focus:border-slate-400/50 focus:ring-1 focus:ring-slate-400/30 p-2 rounded-md w-48 h-10 max-w-[60vw] bg-white" placeholder="PO #" value={po} onChange={(e) => setPo(e.target.value)} />
          </div>
          <div className="flex items-center justify-between gap-3 py-2">
            <label htmlFor="field-style" className="text-sm font-medium whitespace-nowrap">Style</label>
            <select id="field-style" className="border border-slate-300/60 focus:border-slate-400/50 focus:ring-1 focus:ring-slate-400/30 p-2 rounded-md w-48 h-10 max-w-[60vw] bg-white" value={style} onChange={(e) => setStyle(e.target.value)}>
              {STYLE_OPTIONS.map((opt) => (<option key={opt} value={opt}>{opt}</option>))}
            </select>
          </div>
          <div className="flex items-center justify-between gap-3 py-2">
            <label htmlFor="field-markup" className="text-sm font-medium whitespace-nowrap">Markup %</label>
            <input id="field-markup" type="number" inputMode="decimal" className="border border-slate-300/60 focus:border-slate-400/50 focus:ring-1 focus:ring-slate-400/30 p-2 rounded-md w-48 h-10 max-w-[60vw] bg-white" value={markupPct} onChange={(e) => setMarkupPct(toNum(e.target.value))} />
          </div>
        </div>
      </div>

      <hr className="my-4 border-t border-slate-200/60" />

      {/* Measurements */}
      <div className="mt-0 bg-white border border-slate-200/60 rounded-2xl overflow-hidden ring-1 ring-slate-200/50 shadow-sm">
        <div className="px-3 py-2 text-base font-bold uppercase bg-slate-50 border-b border-slate-200/60">Measurements</div>
        <div className="px-3 divide-y divide-slate-200/60">
          <div className="flex items-center justify-between gap-3 py-2">
            <label htmlFor="field-sqft" className="text-sm font-medium whitespace-nowrap">Total Square Feet</label>
            <input id="field-sqft" type="number" inputMode="decimal" className="border border-slate-300/60 focus:border-slate-400/50 focus:ring-1 focus:ring-slate-400/30 p-2 rounded-md w-48 h-10 max-w-[60vw] bg-white" value={inputs.sqft} onChange={(e) => update("sqft", e.target.value)} />
          </div>
          <div className="flex items-center justify-between gap-3 py-2">
            <label htmlFor="field-waste" className="text-sm font-medium whitespace-nowrap">Waste %</label>
            <input id="field-waste" type="number" inputMode="decimal" className="border border-slate-300/60 focus:border-slate-400/50 focus:ring-1 focus:ring-slate-400/30 p-2 rounded-md w-48 h-10 max-w-[60vw] bg-white" value={inputs.wastePct} onChange={(e) => update("wastePct", e.target.value)} />
          </div>
          <div className="flex items-center justify-between gap-3 py-2">
            <label htmlFor="field-iws" className="text-sm font-medium whitespace-nowrap">Type of Ice & Water</label>
            <select id="field-iws" className="border border-slate-300/60 focus:border-slate-400/50 focus:ring-1 focus:ring-slate-400/30 p-2 rounded-md w-48 h-10 max-w-[60vw] bg-white" value={iwsChoice} onChange={(e) => setIwsChoice(e.target.value)}>
              <option value="butyl">{`${PRICES.iws.butyl.label} (${PRICES.iws.butyl.stock})`}</option>
              <option value="standard">{`${PRICES.iws.standard.label} (${PRICES.iws.standard.stock})`}</option>
            </select>
          </div>
          <div className="flex items-center justify-between gap-3 py-2">
            <label htmlFor="field-fasteners" className="text-sm font-medium whitespace-nowrap">Nails / Staples</label>
            <select id="field-fasteners" className="border border-slate-300/60 focus:border-slate-400/50 focus:ring-1 focus:ring-slate-400/30 p-2 rounded-md w-48 h-10 max-w-[60vw] bg-white" value={fastenerChoice} onChange={(e) => setFastenerChoice(e.target.value)}>
              <option value="Plastic Cap Nails">Plastic Cap Nails</option>
              <option value="Crossfire Staples">Crossfire Staples</option>
            </select>
          </div>
          <div className="flex items-center justify-between gap-3 py-2">
            <label htmlFor="field-hips" className="text-sm font-medium whitespace-nowrap">Hips (lf)</label>
            <input id="field-hips" type="number" inputMode="decimal" className="border border-slate-300/60 focus:border-slate-400/50 focus:ring-1 focus:ring-slate-400/30 p-2 rounded-md w-48 h-10 max-w-[60vw] bg-white" value={inputs.hips} onChange={(e) => update("hips", e.target.value)} />
          </div>
          <div className="flex items-center justify-between gap-3 py-2">
            <label htmlFor="field-ridges" className="text-sm font-medium whitespace-nowrap">Ridges (lf)</label>
            <input id="field-ridges" type="number" inputMode="decimal" className="border border-slate-300/60 focus:border-slate-400/50 focus:ring-1 focus:ring-slate-400/30 p-2 rounded-md w-48 h-10 max-w-[60vw] bg-white" value={inputs.ridges} onChange={(e) => update("ridges", e.target.value)} />
          </div>
          <div className="flex items-center justify-between gap-3 py-2">
            <label htmlFor="field-gables" className="text-sm font-medium whitespace-nowrap">Gable Rakes (lf)</label>
            <input id="field-gables" type="number" inputMode="decimal" className="border border-slate-300/60 focus:border-slate-400/50 focus:ring-1 focus:ring-slate-400/30 p-2 rounded-md w-48 h-10 max-w-[60vw] bg-white" value={inputs.gables} onChange={(e) => update("gables", e.target.value)} />
          </div>
          <div className="flex items-center justify-between gap-3 py-2">
            <label htmlFor="field-eaves" className="text-sm font-medium whitespace-nowrap">Drip Edge / Eaves (lf)</label>
            <input id="field-eaves" type="number" inputMode="decimal" className="border border-slate-300/60 focus:border-slate-400/50 focus:ring-1 focus:ring-slate-400/30 p-2 rounded-md w-48 h-10 max-w-[60vw] bg-white" value={inputs.eaves} onChange={(e) => update("eaves", e.target.value)} />
          </div>
          <div className="flex items-center justify-between gap-3 py-2">
            <label htmlFor="field-svalleys" className="text-sm font-medium whitespace-nowrap">Valleys (lf)</label>
            <input id="field-svalleys" type="number" inputMode="decimal" className="border border-slate-300/60 focus:border-slate-400/50 focus:ring-1 focus:ring-slate-400/30 p-2 rounded-md w-48 h-10 max-w-[60vw] bg-white" value={inputs.svalleys} onChange={(e) => update("svalleys", e.target.value)} />
          </div>
          <div className="flex items-center justify-between gap-3 py-2">
            <label htmlFor="field-sidewalls" className="text-sm font-medium whitespace-nowrap">Sidewall (lf)</label>
            <input id="field-sidewalls" type="number" inputMode="decimal" className="border border-slate-300/60 focus:border-slate-400/50 focus:ring-1 focus:ring-slate-400/30 p-2 rounded-md w-48 h-10 max-w-[60vw] bg-white" value={inputs.sidewalls} onChange={(e) => update("sidewalls", e.target.value)} />
          </div>
          <div className="flex items-center justify-between gap-3 py-2">
            <label htmlFor="field-endwalls" className="text-sm font-medium whitespace-nowrap">Endwall (lf)</label>
            <input id="field-endwalls" type="number" inputMode="decimal" className="border border-slate-300/60 focus:border-slate-400/50 focus:ring-1 focus:ring-slate-400/30 p-2 rounded-md w-48 h-10 max-w-[60vw] bg-white" value={inputs.endwalls} onChange={(e) => update("endwalls", e.target.value)} />
          </div>
          <div className="flex items-center justify-between gap-3 py-2">
            <label htmlFor="field-transitions" className="text-sm font-medium whitespace-nowrap">Transition (lf)</label>
            <input id="field-transitions" type="number" inputMode="decimal" className="border border-slate-300/60 focus:border-slate-400/50 focus:ring-1 focus:ring-slate-400/30 p-2 rounded-md w-48 h-10 max-w-[60vw] bg-white" value={inputs.transitions} onChange={(e) => update("transitions", e.target.value)} />
          </div>
        </div>
      </div>

      {/* Notes */}
      <div className="mt-4">
        <label htmlFor="field-notes" className="text-sm font-medium block mb-1">Notes</label>
        <textarea
          id="field-notes"
          className="border border-slate-300/60 focus:border-slate-400/50 focus:ring-1 focus:ring-slate-400/30 p-3 rounded-md w-full h-28 bg-white"
          rows={5}
          placeholder="Add any job notes (special trims, etc.)"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
        />
      </div>

      <hr className="my-4 border-t border-slate-200/60" />

      {/* Side-by-side comparison */}
      <div className="mt-6 grid md:grid-cols-2 gap-4">
        {[result24, result26].map((res) => (
          <div key={res.gauge} className="bg-white border border-slate-200/60 rounded-2xl p-4">
            <h2 className="font-semibold text-lg">{res.gauge} Gauge</h2>
            {res && res.lines ? (
              <table className="w-full text-sm mt-3">
                <thead>
                  <tr className="text-left border-b border-slate-200/60">
                    <th className="py-1">Item</th>
                    <th className="py-1 text-right">Qty × Unit</th>
                    <th className="py-1 text-right">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {res.lines
                    .filter((l) => l.qty > 0 && l.total > 0)
                    .map((ln, idx) => (
                      <tr key={idx} className="border-b border-slate-200/60">
                        <td className="py-1">{ln.label}</td>
                        <td className="py-1 text-right">{`${ln.qty % 1 === 0 ? ln.qty : Math.round(ln.qty)} ${ln.unit || ""}`} × {fmt(ln.price)}</td>
                        <td className="py-1 text-right">{fmt(ln.total)}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            ) : (
              <div className="text-sm text-slate-500 mt-2">Enter measurements to see pricing.</div>
            )}
            {res && (
              <div className="mt-3 grid grid-cols-2 gap-1 text-sm">
                <div className="text-slate-600">Subtotal</div>
                <div className="text-right font-medium">{fmt(res.subtotal || 0)}</div>
                <div className="text-slate-600">Markup ({markupPct}%)</div>
                <div className="text-right font-medium">{fmt(res.markupAmt || 0)}</div>
                <div className="text-slate-600">Taxable</div>
                <div className="text-right font-medium">{fmt(res.taxableBase || 0)}</div>
                <div className="text-slate-600">Tax ({taxPct}%)</div>
                <div className="text-right font-medium">{fmt(res.taxAmt || 0)}</div>
                <div className="col-span-2 border-t border-slate-200/60 pt-2 flex items-center">
                  <div className="text-base font-semibold">Grand Total</div>
                  <div className="ml-auto text-base font-semibold">{fmt(res.grandTotal || 0)}</div>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>

      <div className="mt-4">
        <button
          type="button"
          onClick={exportPDF}
          aria-label="Export quote to PDF"
          title="Export quote to PDF"
          className="inline-flex items-center gap-2 px-4 py-2 rounded-2xl bg-slate-900 text-white cursor-pointer pointer-events-auto relative z-10 hover:bg-slate-800 active:translate-y-px focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-slate-500"
        >
          <Download className="w-4 h-4" />
          Export PDF
        </button>
        <button
          type="button"
          onClick={previewPDF}
          aria-label="Preview quote PDF"
          title="Preview quote PDF"
          className="ml-2 inline-flex items-center gap-2 px-4 py-2 rounded-2xl bg-white border border-slate-300/60 text-slate-900 cursor-pointer hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-slate-400"
        >
          Preview PDF
        </button>
        <label className="ml-3 inline-flex items-center gap-2 text-sm align-middle">
          <input type="checkbox" className="h-4 w-4" checked={pdfHidePrices} onChange={(e)=>setPdfHidePrices(e.target.checked)} />
          Hide line prices & markup on PDF
        </label>
      </div>

      {/* Spacers and footer */}
      <div className="h-6" aria-hidden="true"></div>
      <div className="h-6" aria-hidden="true"></div>
      <footer className="text-center text-sm text-slate-500">Powered by Empire Supply - 801-391-7549</footer>
      <div className="h-6" aria-hidden="true"></div>
      <div className="h-6" aria-hidden="true"></div>

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
            <div className="h-[75vh]">
              <iframe title="PDF Preview" src={previewUrl} className="w-full h-full" style={{ border: 0 }} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
