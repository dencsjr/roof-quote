import React, { useMemo, useState, useEffect } from "react";
import { FileText, Download } from "lucide-react";
import * as JSPDFNS from "jspdf";

// Resolve jsPDF constructor across module variations
const JsPDF = JSPDFNS.jsPDF || JSPDFNS.default || JSPDFNS;

// --- App Version ---
const APP_VERSION = "1.1.3"; // fix: closed JSX properly, restored inputs, stable in-app preview

// --- Embedded logo (placeholder) ---
// Tip: Upload your real PNG/JPEG using the "Upload Logo" control below.
const LOGO_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgYAAAAAMAASsJTYQAAAAASUVORK5CYII="; // 1x1 transparent
const isValidDataUrl = (s) => typeof s === "string" && s.startsWith("data:image/") && s.length > 128;

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
  z: { "24": 9.96, "26": 9.74 }, // 10' each, NO extra piece
  zPerf: { "24": 27.41, "26": 26.43 }, // 10' each, NO extra piece
  iws: {
    standard: { label: "High Temp Ice & Water", price: 64.29, coverSqft: 185 },
    butyl: { label: "Butyl based High Temp Ice & Water", price: 129.60, coverSqft: 185 },
  },
  clips: { pricePerBox: 246.17, piecesPerBox: 1000, lfPerPiece: 2 }, // 1 piece per 2 lf panels
  screws: { pricePerBag: 18.91, piecesPerBag: 250, lfPerPiece: 1 }, // 1 screw per lf panels
  staples: { pricePerBox: 48.79, sqftPerBox: 1500 },
};

export default function MetalRoofQuoteApp() {
  // Header fields
  const [customer, setCustomer] = useState("");
  const [po, setPo] = useState("");
  const [iwsChoice, setIwsChoice] = useState("standard"); // standard | butyl
  const [notes, setNotes] = useState("");

  // Logo state (persist custom uploads in localStorage)
  const [logoDataUrl, setLogoDataUrl] = useState(() => {
    const saved = localStorage.getItem("customLogoDataUrl");
    return saved && saved.startsWith("data:image/") ? saved : LOGO_DATA_URL;
  });
  useEffect(() => {
    if (logoDataUrl && logoDataUrl.startsWith("data:image/")) {
      localStorage.setItem("customLogoDataUrl", logoDataUrl);
    }
  }, [logoDataUrl]);

  // In-app preview state
  const [isPreviewOpen, setIsPreviewOpen] = useState(false);
  const [previewUrl, setPreviewUrl] = useState("");
  const closePreview = () => {
    try { if (previewUrl && previewUrl.startsWith("blob:")) URL.revokeObjectURL(previewUrl); } catch {}
    setPreviewUrl(""); setIsPreviewOpen(false);
  };
  useEffect(() => () => { try { if (previewUrl && previewUrl.startsWith("blob:")) URL.revokeObjectURL(previewUrl); } catch {} }, [previewUrl]);

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
    const panelLF = inputs.sqft / PANEL_SQFT_PER_LF; // do not round; keep raw for clips/screws
    const panelCost = panelLF * PRICES.panelLF[gauge];

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

    // Ice & Water (choose one)
    const iws = PRICES.iws[iwsChoice];
    const iwsQty = inputs.sqft > 0 ? Math.ceil(inputs.sqft / iws.coverSqft) + 1 : 0; // +1 roll
    const iwsCost = iwsQty * iws.price;

    // Panel clips (1 per 2 LF of panels)
    const clipPiecesNeeded = panelLF / PRICES.clips.lfPerPiece;
    const clipBoxes = clipPiecesNeeded > 0 ? Math.ceil(clipPiecesNeeded / PRICES.clips.piecesPerBox) : 0;
    const clipCost = clipBoxes * PRICES.clips.pricePerBox;

    // Pancake screws (1 per LF of panels)
    const screwBags = panelLF > 0 ? Math.ceil(panelLF / PRICES.screws.piecesPerBag) : 0;
    const screwCost = screwBags * PRICES.screws.pricePerBag;

    // Z metals (NO extra piece)
    const zQty = sticksNoExtra(inputs.hips * 2); // double hips, round up to 10'
    const zCost = zQty * PRICES.z[gauge];

    const zPerfQty = sticksNoExtra(inputs.ridges * 2); // double ridge, round up to 10'
    const zPerfCost = zPerfQty * PRICES.zPerf[gauge];

    // Staples
    const stapleBoxes = inputs.sqft > 0 ? Math.ceil(inputs.sqft / PRICES.staples.sqftPerBox) : 0;
    const stapleCost = stapleBoxes * PRICES.staples.pricePerBox;

    const subtotal = panelCost + trimCost + iwsCost + clipCost + screwCost + zCost + zPerfCost + stapleCost;
    const markupAmt = (toNum(markupPct) / 100) * subtotal;
    const taxableBase = subtotal + markupAmt; // tax after markup
    const taxAmt = (toNum(taxPct) / 100) * taxableBase;
    const grandTotal = taxableBase + taxAmt;

    return {
      gauge,
      panelLF,
      lines: [
        { label: `Panels (${panelLF.toFixed(0)} lf)`, qty: panelLF, unit: "lf", price: PRICES.panelLF[gauge], total: panelCost },
        { label: `Hip`, qty: pieces.hip, unit: "10' pcs", price: trimPrices.hip, total: pieces.hip * trimPrices.hip },
        { label: `Ridge`, qty: pieces.ridge, unit: "10' pcs", price: trimPrices.ridge, total: pieces.ridge * trimPrices.ridge },
        { label: `Gable Rake`, qty: pieces.gable, unit: "10' pcs", price: trimPrices.gable, total: pieces.gable * trimPrices.gable },
        { label: `Drip Edge`, qty: pieces.drip, unit: "10' pcs", price: trimPrices.drip, total: pieces.drip * trimPrices.drip },
        { label: `S-Valley`, qty: pieces.svalley, unit: "10' pcs", price: trimPrices.svalley, total: pieces.svalley * trimPrices.svalley },
        { label: `Sidewall`, qty: pieces.sidewall, unit: "10' pcs", price: trimPrices.sidewall, total: pieces.sidewall * trimPrices.sidewall },
        { label: `Endwall`, qty: pieces.endwall, unit: "10' pcs", price: trimPrices.endwall, total: pieces.endwall * trimPrices.endwall },
        { label: `Transition`, qty: pieces.transition, unit: "10' pcs", price: trimPrices.transition, total: pieces.transition * (trimPrices.transition ?? 0) },
        { label: `${iws.label}`, qty: iwsQty, unit: "rolls", price: iws.price, total: iwsCost },
        { label: `Panel Clips`, qty: clipBoxes, unit: "box", price: PRICES.clips.pricePerBox, total: clipCost },
        { label: `Pancake Screws`, qty: screwBags, unit: "bag", price: PRICES.screws.pricePerBag, total: screwCost },
        { label: `Z Metal`, qty: zQty, unit: "10' pcs", price: PRICES.z[gauge], total: zCost },
        { label: `Perforated Z Metal`, qty: zPerfQty, unit: "10' pcs", price: PRICES.zPerf[gauge], total: zPerfCost },
        { label: `Staple Pack`, qty: stapleBoxes, unit: "box", price: PRICES.staples.pricePerBox, total: stapleCost },
      ],
      subtotal, markupAmt, taxableBase, taxAmt, grandTotal,
    };
  };

  const result24 = useMemo(() => calcForGauge("24"), [inputs, iwsChoice, markupPct]);
  const result26 = useMemo(() => calcForGauge("26"), [inputs, iwsChoice, markupPct]);

  // --- Minimal self-tests (console) ---
  useEffect(() => {
    const approx = (a, b, eps = 1e-4) => Math.abs(a - b) < eps;
    console.assert(approx(100 / PANEL_SQFT_PER_LF, 75.0075), "Panels LF conversion");
    console.assert(sticksPlusOne(0) === 0, "sticksPlusOne(0) -> 0");
    console.assert(sticksPlusOne(10) === 2, "10lf => 1 + 1 extra = 2");
    console.assert(sticksPlusOne(0.1) === 2, "very small lf still rounds up then +1");
    console.assert(sticksPlusOne(9.9) === 2, "round-up then +1 for trims (<10lf)");
    console.assert(sticksNoExtra(19) === 2, "round-up to 10' sticks");
    console.assert(sticksNoExtra(0) === 0, "no sticks when length is zero");
    console.assert(sticksNoExtra(30) === 3, "double hips/ridge math produces correct stick count");
    // filename tests
    console.assert(buildFileName("ACME Roofing", "PO123", "2025-08-19") === "ACME_Roofing-PO123-2025-08-19.pdf", "filename format");
    console.assert(buildFileName("", "", "2025-08-19").startsWith("Quote-"), "fallback filename format");
  }, []);

  // Build the PDF content once so we can reuse for download or preview
  const buildPdfDoc = () => {
    if (!JsPDF) throw new Error("jsPDF is not available");
    const doc = new JsPDF({ unit: "pt", format: "a4" });
    const pageWidth = doc.internal.pageSize.getWidth();
    const pageHeight = doc.internal.pageSize.getHeight();
    const left = 40, top = 40, bottom = 48, colGap = 40, colWidth = (pageWidth - left * 2 - colGap) / 2;

    // Header logo + title
    try {
      if (logoDataUrl && logoDataUrl.startsWith("data:image/")) {
        const header = logoDataUrl.split(",", 1)[0];
        const mime = /jpeg/i.test(header) ? "JPEG" : "PNG";
        doc.addImage(logoDataUrl, mime, pageWidth / 2 - 130, 16, 260, 60);
      }
    } catch (e) { console.warn("Logo skipped in PDF:", e?.message); }

    doc.setFontSize(16); doc.text("Metal Roofing Quote", left, top);
    doc.setFontSize(10);
    const now = new Date(); const dateStr = now.toISOString().slice(0, 10);
    doc.text(`Generated: ${now.toLocaleDateString()} ${now.toLocaleTimeString()}`, left, top + 14);
    if (customer) doc.text(`Customer: ${customer}`, left, top + 28);
    if (po) doc.text(`PO: ${po}`, left, top + 42);

    const yStart = top + 70; // body starts here; notes go in footer later

    const drawCol = (x, title, res) => {
      let y = yStart;
      doc.setFontSize(13); doc.text(title, x, y); y += 16;
      doc.setFontSize(10); doc.text(`Panels: ${res.panelLF.toFixed(0)} lf`, x, y); y += 14;
      doc.text("Items:", x, y); y += 12;

      const lines = (res?.lines || []).filter((l) => l.qty > 0 && l.total > 0);
      lines.forEach((ln) => {
        const qtyStr = `${ln.qty % 1 === 0 ? ln.qty : Math.round(ln.qty)} ${ln.unit || ""}`;
        const leftText = `${ln.label}  (${qtyStr} × ${fmt(ln.price)})`;
        doc.text(leftText, x, y);
        doc.text(fmt(ln.total), x + colWidth - 8, y, { align: "right" });
        y += 12;
        if (y > pageHeight - bottom - 80) { doc.addPage(); y = top; }
      });

      y += 8; doc.line(x, y, x + colWidth, y); y += 12;
      doc.text(`Subtotal: ${fmt(res.subtotal || 0)}`, x, y); y += 12;
      doc.text(`Markup (${markupPct}%): ${fmt(res.markupAmt || 0)}`, x, y); y += 12;
      doc.text(`Taxable: ${fmt(res.taxableBase || 0)}`, x, y); y += 12;
      doc.text(`Tax (${taxPct}%): ${fmt(res.taxAmt || 0)}`, x, y); y += 12;
      doc.setFontSize(12); doc.text(`Grand Total: ${fmt(res.grandTotal || 0)}`, x, y);
    };

    // Draw both columns
    drawCol(left, "24 Gauge", result24);
    drawCol(left + colWidth + colGap, "26 Gauge", result26);

    // Footer Notes pinned to bottom of last page
    if (notes && notes.trim()) {
      const usableWidth = pageWidth - left * 2;
      const wrapped = doc.splitTextToSize(notes, usableWidth);
      const lineHeight = 12;
      const blockHeight = 16 /*title*/ + wrapped.length * lineHeight;
      let y = pageHeight - bottom - blockHeight;
      const lastPage = doc.getNumberOfPages();
      doc.setPage(lastPage);
      if (y < top + 10) { doc.addPage(); const ph = doc.internal.pageSize.getHeight(); y = ph - bottom - blockHeight; }
      doc.setFontSize(11); doc.text("Notes:", left, y); y += 16;
      doc.setFontSize(10); wrapped.forEach((line) => { doc.text(line, left, y); y += lineHeight; });
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

  // Logo upload helpers
  const handleLogoFile = (e) => {
    const file = e.target.files?.[0]; if (!file) return;
    if (!/^image\/(png|jpeg)$/.test(file.type)) { alert("Please choose a PNG or JPEG image."); e.target.value = ""; return; }
    const reader = new FileReader(); reader.onload = () => setLogoDataUrl(String(reader.result)); reader.readAsDataURL(file); e.target.value = "";
  };
  const resetLogo = () => { localStorage.removeItem("customLogoDataUrl"); setLogoDataUrl(LOGO_DATA_URL); };

  return (
    <div className="p-4 max-w-5xl mx-auto">
      <div className="flex items-center gap-3">
        {logoDataUrl && logoDataUrl.startsWith("data:image/") ? (
          <img src={logoDataUrl} alt="Empire Supply" className="h-12 w-auto" />
        ) : (
          <div className="h-12 w-40 flex items-center justify-center text-xs text-slate-500 border rounded">Logo</div>
        )}
        <h1 className="text-xl font-bold flex items-center gap-2"><FileText className="w-5 h-5"/> Metal Roofing Quote <span className="ml-2 text-xs text-slate-500">v{APP_VERSION}</span></h1>
      </div>

      <div className="mt-2 flex items-center gap-2">
        <label className="text-xs px-3 py-1 border rounded cursor-pointer hover:bg-slate-50">
          Upload Logo
          <input type="file" accept="image/png,image/jpeg" className="hidden" onChange={handleLogoFile} />
        </label>
        <button type="button" onClick={resetLogo} className="text-xs px-3 py-1 border rounded hover:bg-slate-50">Reset Logo</button>
      </div>

      {/* Header inputs */}
      <div className="mt-4 grid md:grid-cols-4 gap-3">
        <label className="text-sm">Customer
          <input className="border p-2 rounded w-full" placeholder="Customer name" value={customer} onChange={(e) => setCustomer(e.target.value)} />
        </label>
        <label className="text-sm">PO
          <input className="border p-2 rounded w-full" placeholder="PO #" value={po} onChange={(e) => setPo(e.target.value)} />
        </label>
        <label className="text-sm">Ice & Water
          <select className="border p-2 rounded w-full" value={iwsChoice} onChange={(e) => setIwsChoice(e.target.value)}>
            <option value="standard">High Temp Ice & Water</option>
            <option value="butyl">Butyl based High Temp Ice & Water</option>
          </select>
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label className="text-sm">Markup %
            <input type="number" className="border p-2 rounded w-full" value={markupPct} onChange={(e) => setMarkupPct(toNum(e.target.value))} />
          </label>
          <label className="text-sm">Tax % (locked)
            <input type="number" disabled className="border p-2 rounded w-full bg-gray-100" value={taxPct} />
          </label>
        </div>
      </div>

      {/* Notes */}
      <div className="mt-4">
        <label className="text-sm block">Notes
          <textarea className="border p-2 rounded w-full" rows={3} placeholder="Add any job notes (delivery, special trims, etc.)" value={notes} onChange={(e)=>setNotes(e.target.value)} />
        </label>
      </div>

      {/* Measurements */}
      <div className="mt-4 grid md:grid-cols-3 gap-3">
        <label className="text-sm">Total Square Feet
          <input type="number" className="border p-2 rounded w-full" value={inputs.sqft} onChange={(e) => update("sqft", e.target.value)} />
        </label>
        <label className="text-sm">Hips (lf)
          <input type="number" className="border p-2 rounded w-full" value={inputs.hips} onChange={(e) => update("hips", e.target.value)} />
        </label>
        <label className="text-sm">Ridges (lf)
          <input type="number" className="border p-2 rounded w-full" value={inputs.ridges} onChange={(e) => update("ridges", e.target.value)} />
        </label>
        <label className="text-sm">Gable Rakes (lf)
          <input type="number" className="border p-2 rounded w-full" value={inputs.gables} onChange={(e) => update("gables", e.target.value)} />
        </label>
        <label className="text-sm">Drip Edge / Eaves (lf)
          <input type="number" className="border p-2 rounded w-full" value={inputs.eaves} onChange={(e) => update("eaves", e.target.value)} />
        </label>
        <label className="text-sm">S-Valleys (lf)
          <input type="number" className="border p-2 rounded w-full" value={inputs.svalleys} onChange={(e) => update("svalleys", e.target.value)} />
        </label>
        <label className="text-sm">Sidewall (lf)
          <input type="number" className="border p-2 rounded w-full" value={inputs.sidewalls} onChange={(e) => update("sidewalls", e.target.value)} />
        </label>
        <label className="text-sm">Endwall (lf)
          <input type="number" className="border p-2 rounded w-full" value={inputs.endwalls} onChange={(e) => update("endwalls", e.target.value)} />
        </label>
        <label className="text-sm">Transition (lf)
          <input type="number" className="border p-2 rounded w-full" value={inputs.transitions} onChange={(e) => update("transitions", e.target.value)} />
        </label>
      </div>

      {/* Side-by-side comparison */}
      <div className="mt-6 grid md:grid-cols-2 gap-4">
        {[result24, result26].map((res) => (
          <div key={res.gauge} className="bg-white border rounded-2xl p-4">
            <h2 className="font-semibold text-lg">{res.gauge} Gauge</h2>
            <div className="text-sm text-slate-600">Panels: {Number.isFinite(res?.panelLF) ? res.panelLF.toFixed(0) : 0} lf</div>
            {res && res.lines ? (
              <table className="w-full text-sm mt-3">
                <thead>
                  <tr className="text-left border-b">
                    <th className="py-1">Item</th>
                    <th className="py-1 text-right">Qty × Unit</th>
                    <th className="py-1 text-right">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {res.lines.filter((l) => l.qty > 0 && l.total > 0).map((ln, idx) => (
                    <tr key={idx} className="border-b">
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
                <div className="text-slate-600">Subtotal</div><div className="text-right font-medium">{fmt(res.subtotal || 0)}</div>
                <div className="text-slate-600">Markup ({markupPct}%)</div><div className="text-right font-medium">{fmt(res.markupAmt || 0)}</div>
                <div className="text-slate-600">Taxable</div><div className="text-right font-medium">{fmt(res.taxableBase || 0)}</div>
                <div className="text-slate-600">Tax ({taxPct}%)</div><div className="text-right font-medium">{fmt(res.taxAmt || 0)}</div>
                <div className="col-span-2 border-t pt-2 flex items-center">
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
          <Download className="w-4 h-4"/>Export PDF
        </button>
        <button
          type="button"
          onClick={previewPDF}
          aria-label="Preview quote PDF"
          title="Preview quote PDF"
          className="ml-2 inline-flex items-center gap-2 px-4 py-2 rounded-2xl bg-white border text-slate-900 cursor-pointer hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-slate-500"
        >
          Preview PDF
        </button>
      </div>

      {isPreviewOpen && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center" onClick={closePreview}>
          <div className="bg-white w-[95vw] max-w-5xl rounded-xl shadow-xl overflow-hidden" onClick={(e)=>e.stopPropagation()} role="dialog" aria-modal="true" aria-label="PDF Preview">
            <div className="px-4 py-3 border-b flex items-center justify-between">
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

