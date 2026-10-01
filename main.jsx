import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors
} from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  rectSortingStrategy,
  arrayMove
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { PDFDocument, degrees } from "pdf-lib";
import * as pdfjsLib from "pdfjs-dist";
import "./styles.css";

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.mjs",
  import.meta.url
).toString();

const MAX_FILE_MB = 100;
const PRESETS = {
  high: { label: "High Quality", value: 15 },
  balanced: { label: "Recommended", value: 50 },
  extreme: { label: "Extreme", value: 85 }
};

const clamp = (n, min, max) => Math.min(max, Math.max(min, n));

function uid() {
  return crypto.randomUUID?.() || `${Date.now()}-${Math.random()}`;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(2)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

function rotateValue(current, delta) {
  return ((current + delta) % 360 + 360) % 360;
}

async function readPdf(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const pdf = await PDFDocument.load(bytes, { ignoreEncryption: false });
  const pdfjs = await pdfjsLib.getDocument({ data: bytes.slice() }).promise;

  const pages = [];
  for (let i = 0; i < pdf.getPageCount(); i++) {
    const p = pdf.getPage(i);
    pages.push({
      id: uid(),
      sourceId: uid(),
      sourcePageIndex: i,
      width: p.getWidth(),
      height: p.getHeight(),
      rotation: 0,
      thumb: null
    });
  }

  return {
    id: uid(),
    name: file.name,
    size: file.size,
    bytes,
    pdf,
    pdfjs,
    pages
  };
}

async function renderThumbnail(pdfjs, pageIndex, rotation = 0, width = 220) {
  const page = await pdfjs.getPage(pageIndex + 1);
  const base = page.getViewport({ scale: 1, rotation });
  const scale = width / base.width;
  const viewport = page.getViewport({ scale, rotation });
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const ctx = canvas.getContext("2d", { alpha: false });
  await page.render({ canvasContext: ctx, viewport }).promise;
  return canvas.toDataURL("image/jpeg", 0.84);
}

function pageLabel(page, index) {
  return `Page ${index + 1}`;
}

function blankThumbnail() {
  const canvas = document.createElement("canvas");
  canvas.width = 360; canvas.height = 500;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = "#d8dee9"; ctx.strokeRect(1, 1, canvas.width - 2, canvas.height - 2);
  return canvas.toDataURL("image/jpeg", 0.85);
}

async function buildPdf({ pages, docs, compress = false, compression = 50, onProgress }) {
  if (!pages.length) throw new Error("There are no pages to export.");

  const out = await PDFDocument.create();

  if (!compress || compression <= 0) {
    for (let i = 0; i < pages.length; i++) {
      const item = pages[i];
      if (item.blank) {
        const blank = out.addPage(
          item.rotation % 180 === 0 ? [item.width, item.height] : [item.height, item.width]
        );
        onProgress?.((i + 1) / pages.length);
        continue;
      }
      const source = docs.find((d) => d.id === item.docId);
      const copied = await out.copyPages(source.pdf, [item.sourcePageIndex]);
      const page = copied[0];
      page.setRotation(degrees(item.rotation));
      out.addPage(page);
      onProgress?.((i + 1) / pages.length);
    }
    return await out.save({ useObjectStreams: true });
  }

  // Browser-safe compression path:
  // PDF.js rasterizes each page and pdf-lib writes JPEG images into a new PDF.
  // This trades selectable text/vector content for smaller files.
  const quality = 0.95 - (compression / 100) * 0.60; // 0.95 -> 0.35
  const dpi = 144 - (compression / 100) * 84;        // 144 -> 60
  const scale = dpi / 72;

  for (let i = 0; i < pages.length; i++) {
    const item = pages[i];
    if (item.blank) {
      out.addPage(
        item.rotation % 180 === 0 ? [item.width, item.height] : [item.height, item.width]
      );
      onProgress?.((i + 1) / pages.length);
      continue;
    }
    const source = docs.find((d) => d.id === item.docId);
    const pdfPage = await source.pdfjs.getPage(item.sourcePageIndex + 1);
    const viewport = pdfPage.getViewport({ scale, rotation: item.rotation });

    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.ceil(viewport.width));
    canvas.height = Math.max(1, Math.ceil(viewport.height));
    const ctx = canvas.getContext("2d", { alpha: false });
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await pdfPage.render({ canvasContext: ctx, viewport }).promise;

    const jpegUrl = canvas.toDataURL("image/jpeg", quality);
    const base64 = jpegUrl.split(",")[1];
    const binary = atob(base64);
    const jpg = new Uint8Array(binary.length);
    for (let j = 0; j < binary.length; j++) jpg[j] = binary.charCodeAt(j);

    const image = await out.embedJpg(jpg);
    const w = item.width * (item.rotation % 180 === 0 ? 1 : 1);
    const h = item.height;
    const outPage = out.addPage(
      item.rotation % 180 === 0 ? [w, h] : [h, w]
    );
    outPage.drawImage(image, {
      x: 0,
      y: 0,
      width: outPage.getWidth(),
      height: outPage.getHeight()
    });

    onProgress?.((i + 1) / pages.length);
  }

  return await out.save({ useObjectStreams: true });
}

function estimateSize(originalBytes, pageCount, compression) {
  if (!originalBytes || !pageCount) return 0;
  if (compression <= 0) return originalBytes;
  const ratio = 0.96 - 0.82 * (compression / 100);
  // Estimate is deliberately conservative and clearly labelled as an estimate.
  return Math.max(pageCount * 18_000, originalBytes * ratio);
}

function SortablePage({ page, index, selected, onSelect, onRotate }) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging
  } = useSortable({ id: page.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    zIndex: isDragging ? 10 : undefined
  };

  return (
    <article
      ref={setNodeRef}
      style={style}
      className={`page-card ${selected ? "selected" : ""} ${isDragging ? "dragging" : ""}`}
    >
      <div className="page-thumb-wrap" {...attributes} {...listeners}>
        {page.thumb ? (
          <img
            className="page-thumb"
            src={page.thumb}
            alt={`PDF page ${index + 1}`}
          />
        ) : (
          <div className="thumb-loading">Rendering…</div>
        )}

        <div className="thumb-toolbar">
          <button
            title="Rotate counter-clockwise"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); onRotate(page.id, -90); }}
          >↶</button>
          <button
            title="Rotate clockwise"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); onRotate(page.id, 90); }}
          >↷</button>
          <button
            title="Rotate 180°"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); onRotate(page.id, 180); }}
          >180°</button>
        </div>

        <div className="page-select">
          <input
            type="checkbox"
            checked={selected}
            onChange={(e) => onSelect(page.id, e.target.checked)}
            onPointerDown={(e) => e.stopPropagation()}
            aria-label={`Select page ${index + 1}`}
          />
        </div>
      </div>

      <div className="page-meta">
        <span>{pageLabel(page, index)}</span>
        <span className="rotation-pill">{page.rotation}°</span>
      </div>
    </article>
  );
}

function Dropzone({ onFiles }) {
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef(null);

  const accept = (files) => {
    const pdfs = [...files].filter((f) => f.type === "application/pdf" || /\.pdf$/i.test(f.name));
    if (pdfs.length) onFiles(pdfs);
  };

  return (
    <div
      className={`dropzone ${dragging ? "dragging" : ""}`}
      onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        accept(e.dataTransfer.files);
      }}
      onClick={() => inputRef.current?.click()}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") inputRef.current?.click(); }}
    >
      <input
        ref={inputRef}
        type="file"
        accept="application/pdf,.pdf"
        multiple
        hidden
        onChange={(e) => accept(e.target.files || [])}
      />
      <div className="drop-icon">↑</div>
      <h2>Drop PDF files here</h2>
      <p>or click to browse • multiple PDFs supported • up to {MAX_FILE_MB} MB each</p>
    </div>
  );
}

function App() {
  const [docs, setDocs] = useState([]);
  const [activeDocId, setActiveDocId] = useState(null);
  const [selected, setSelected] = useState(new Set());
  const [compression, setCompression] = useState(50);
  const [theme, setTheme] = useState(() => localStorage.getItem("pdf-theme") || "dark");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [history, setHistory] = useState([]);
  const [future, setFuture] = useState([]);
  const [showMergeMenu, setShowMergeMenu] = useState(false);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  const activeDoc = docs.find((d) => d.id === activeDocId) || docs[0] || null;
  const pages = activeDoc?.pages || [];

  const selectedCount = selected.size;
  const estimate = useMemo(
    () => estimateSize(activeDoc?.size, pages.length, compression),
    [activeDoc, pages.length, compression]
  );

  const snapshot = useCallback(() => {
    if (!activeDoc) return null;
    return {
      docId: activeDoc.id,
      pages: activeDoc.pages.map((p) => ({ ...p }))
    };
  }, [activeDoc]);

  const restoreSnapshot = useCallback((snap) => {
    if (!snap) return;
    setDocs((prev) => prev.map((d) => d.id === snap.docId ? { ...d, pages: snap.pages } : d));
    setSelected(new Set());
  }, []);

  const pushHistory = useCallback(() => {
    const snap = snapshot();
    if (!snap) return;
    setHistory((h) => [...h.slice(-24), snap]);
    setFuture([]);
  }, [snapshot]);

  useEffect(() => {
    localStorage.setItem("pdf-theme", theme);
  }, [theme]);

  useEffect(() => {
    const onKey = (e) => {
      const tag = document.activeElement?.tagName;
      if (["INPUT", "TEXTAREA", "SELECT"].includes(tag)) return;

      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        const last = history.at(-1);
        if (!last) return;
        const current = snapshot();
        if (current) setFuture((f) => [...f.slice(-24), current]);
        setHistory((h) => h.slice(0, -1));
        restoreSnapshot(last);
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") {
        e.preventDefault();
        const next = future.at(-1);
        if (!next) return;
        const current = snapshot();
        if (current) setHistory((h) => [...h.slice(-24), current]);
        setFuture((f) => f.slice(0, -1));
        restoreSnapshot(next);
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") {
        e.preventDefault();
        setSelected(new Set(pages.map((p) => p.id)));
      } else if (e.key === "Delete" || e.key === "Backspace") {
        if (selected.size) deleteSelected();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [history, future, snapshot, restoreSnapshot, pages, selected]);

  async function loadFiles(files) {
    setBusy(true);
    setStatus("Loading PDF files…");
    try {
      const loaded = [];
      for (const file of files) {
        if (file.size > MAX_FILE_MB * 1024 * 1024) {
          throw new Error(`${file.name} exceeds the ${MAX_FILE_MB} MB limit.`);
        }
        const doc = await readPdf(file);
        doc.pages = await Promise.all(
          doc.pages.map(async (p) => ({
            ...p,
            docId: doc.id,
            thumb: await renderThumbnail(doc.pdfjs, p.sourcePageIndex, p.rotation)
          }))
        );
        loaded.push(doc);
      }
      setDocs((prev) => [...prev, ...loaded]);
      setActiveDocId((id) => id || loaded[0]?.id || null);
      setSelected(new Set());
      setStatus(`${loaded.length} PDF${loaded.length === 1 ? "" : "s"} loaded locally.`);
    } catch (err) {
      setStatus(err.message || "Unable to load PDF.");
    } finally {
      setBusy(false);
    }
  }

  function reorderPages(oldIndex, newIndex) {
    if (oldIndex === newIndex) return;
    pushHistory();
    setDocs((prev) => prev.map((d) => {
      if (d.id !== activeDoc.id) return d;
      return { ...d, pages: arrayMove(d.pages, oldIndex, newIndex) };
    }));
  }

  function onDragEnd({ active, over }) {
    if (!over || active.id === over.id) return;
    const oldIndex = pages.findIndex((p) => p.id === active.id);
    const newIndex = pages.findIndex((p) => p.id === over.id);
    reorderPages(oldIndex, newIndex);
  }

  function toggleSelected(id, value) {
    setSelected((prev) => {
      const next = new Set(prev);
      value ? next.add(id) : next.delete(id);
      return next;
    });
  }

  function deleteSelected() {
    if (!activeDoc || !selected.size) return;
    pushHistory();
    setDocs((prev) => prev.map((d) => d.id === activeDoc.id
      ? { ...d, pages: d.pages.filter((p) => !selected.has(p.id)) }
      : d
    ));
    setSelected(new Set());
    setStatus("Selected pages deleted.");
  }

  async function rotatePages(ids, delta) {
    if (!activeDoc || !ids.length) return;
    pushHistory();
    const nextPages = await Promise.all(activeDoc.pages.map(async (p) => {
      if (!ids.includes(p.id)) return p;
      const nextRotation = rotateValue(p.rotation, delta);
      return {
        ...p,
        rotation: nextRotation,
        thumb: p.blank ? blankThumbnail() : await renderThumbnail(activeDoc.pdfjs, p.sourcePageIndex, nextRotation)
      };
    }));
    setDocs((prev) => prev.map((d) => d.id === activeDoc.id ? { ...d, pages: nextPages } : d));
  }

  function selectAll() {
    setSelected(new Set(pages.map((p) => p.id)));
  }

  function insertBlank() {
    if (!activeDoc) return;
    pushHistory();
    const blank = {
      id: uid(),
      sourceId: null,
      sourcePageIndex: null,
      docId: activeDoc.id,
      width: 595.28,
      height: 841.89,
      rotation: 0,
      blank: true,
      thumb: blankThumbnail()
    };
    setDocs((prev) => prev.map((d) => d.id === activeDoc.id
      ? { ...d, pages: [...d.pages, blank] }
      : d
    ));
    setStatus("Blank page added.");
  }

  async function mergeOtherDocuments() {
    if (!activeDoc || docs.length < 2) return;
    const others = docs.filter((d) => d.id !== activeDoc.id);
    pushHistory();

    let newPages = [...activeDoc.pages];
    for (const d of others) {
      newPages = [
        ...newPages,
        ...(await Promise.all(d.pages.map(async (p) => ({
          ...p,
          id: uid(),
          docId: d.id,
          thumb: p.thumb || await renderThumbnail(d.pdfjs, p.sourcePageIndex, p.rotation)
        }))))
      ];
    }
    setDocs((prev) => prev.map((d) => d.id === activeDoc.id ? { ...d, pages: newPages } : d));
    setStatus(`Appended ${others.length} uploaded PDF${others.length > 1 ? "s" : ""}.`);
    setShowMergeMenu(false);
  }

  async function exportPdf({ compressed = false, split = false } = {}) {
    if (!activeDoc || !pages.length) {
      setStatus("Load a PDF first.");
      return;
    }

    setBusy(true);
    setProgress(0);
    setStatus(compressed ? "Compressing in your browser…" : "Building PDF…");

    try {
      const bytes = await buildPdf({
        pages,
        docs,
        compress: compressed,
        compression,
        onProgress: setProgress
      });

      const blob = new Blob([bytes], { type: "application/pdf" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      const base = activeDoc.name.replace(/\.pdf$/i, "");
      a.download = split
        ? `${base}-selected.pdf`
        : compressed
          ? `${base}-compressed.pdf`
          : `${base}-edited.pdf`;
      a.click();
      URL.revokeObjectURL(url);
      setStatus(`Exported ${formatBytes(bytes.length)} PDF locally.`);
    } catch (err) {
      setStatus(err.message || "Export failed.");
    } finally {
      setBusy(false);
      setProgress(0);
    }
  }

  async function exportSelected() {
    if (!selected.size) {
      setStatus("Select one or more pages first.");
      return;
    }
    const selectedPages = pages.filter((p) => selected.has(p.id));
    setBusy(true);
    setStatus("Exporting selected pages…");
    try {
      const bytes = await buildPdf({
        pages: selectedPages,
        docs,
        compress: false,
        compression: 0,
        onProgress: setProgress
      });
      const blob = new Blob([bytes], { type: "application/pdf" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${activeDoc.name.replace(/\.pdf$/i, "")}-selected.pdf`;
      a.click();
      URL.revokeObjectURL(url);
      setStatus(`Exported ${selectedPages.length} selected page(s).`);
    } catch (err) {
      setStatus(err.message || "Export failed.");
    } finally {
      setBusy(false);
      setProgress(0);
    }
  }

  function resetChanges() {
    if (!activeDoc) return;
    setDocs((prev) => prev.map((d) => {
      if (d.id !== activeDoc.id) return d;
      const original = d.pages
        .filter((p) => !p.blank)
        .sort((a, b) => a.sourcePageIndex - b.sourcePageIndex)
        .map((p) => ({ ...p, rotation: 0 }));
      return { ...d, pages: original };
    }));
    setSelected(new Set());
    setHistory([]);
    setFuture([]);
    setStatus("Changes reset for the active document.");
  }

  async function downloadCompressed() {
    await exportPdf({ compressed: true });
  }

  const compressionLabel =
    compression < 25 ? "High Quality" :
    compression < 70 ? "Balanced" :
    "Extreme Compression";

  return (
    <div className={`app ${theme}`}>
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark">PDF</div>
          <div>
            <strong>PDF Workspace</strong>
            <small>Private • Browser-only processing</small>
          </div>
        </div>

        <div className="top-actions">
          <button className="ghost" onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>
            {theme === "dark" ? "☀ Light" : "☾ Dark"}
          </button>
          <button className="ghost" onClick={() => history.at(-1) && (() => {
            const last = history.at(-1);
            const current = snapshot();
            if (current) setFuture((f) => [...f.slice(-24), current]);
            setHistory((h) => h.slice(0, -1));
            restoreSnapshot(last);
          })()}>
            ↶ Undo
          </button>
          <button className="ghost" onClick={() => future.at(-1) && (() => {
            const next = future.at(-1);
            const current = snapshot();
            if (current) setHistory((h) => [...h.slice(-24), current]);
            setFuture((f) => f.slice(0, -1));
            restoreSnapshot(next);
          })()}>
            ↷ Redo
          </button>
        </div>
      </header>

      <main>
        {!docs.length ? (
          <section className="landing">
            <div className="hero">
              <span className="eyebrow">100% client-side</span>
              <h1>Your PDF desk, without uploading your documents.</h1>
              <p>Reorder, rotate, merge, split, extract, and compress PDF pages locally in your browser.</p>
            </div>
            <Dropzone onFiles={loadFiles} />
            <div className="feature-strip">
              <span>🔒 No server upload</span>
              <span>↕ Drag to reorder</span>
              <span>⟳ Rotate pages</span>
              <span>◉ Compress locally</span>
              <span>⌘ Keyboard shortcuts</span>
            </div>
          </section>
        ) : (
          <>
            <section className="workspace-head">
              <div>
                <span className="eyebrow">Document workspace</span>
                <h1>{activeDoc?.name}</h1>
                <p>{pages.length} pages • {formatBytes(activeDoc?.size)} source • {status || "Ready"}</p>
              </div>
              <div className="workspace-actions">
                <label className="secondary-button">
                  + Add PDF
                  <input type="file" accept=".pdf,application/pdf" multiple hidden onChange={(e) => loadFiles(e.target.files || [])} />
                </label>
                <button className="secondary-button" onClick={insertBlank}>＋ Blank page</button>
                <div className="merge-wrap">
                  <button className="secondary-button" onClick={() => setShowMergeMenu((v) => !v)}>Merge / Append ▾</button>
                  {showMergeMenu && (
                    <div className="merge-menu">
                      <button onClick={mergeOtherDocuments}>Append all other uploaded PDFs</button>
                    </div>
                  )}
                </div>
              </div>
            </section>

            <div className="document-tabs">
              {docs.map((d) => (
                <button
                  key={d.id}
                  className={d.id === activeDoc?.id ? "active" : ""}
                  onClick={() => { setActiveDocId(d.id); setSelected(new Set()); }}
                >
                  {d.name}
                </button>
              ))}
            </div>

            <section className="toolbar card">
              <div className="toolbar-group">
                <button onClick={selectAll}>Select all</button>
                <button disabled={!selectedCount} onClick={deleteSelected}>Delete ({selectedCount})</button>
                <button disabled={!selectedCount} onClick={exportSelected}>Extract selected</button>
              </div>
              <div className="toolbar-group">
                <button disabled={!selectedCount} onClick={() => rotatePages([...selected], 90)}>↷ Rotate selected</button>
                <button onClick={() => rotatePages(pages.map((p) => p.id), 90)}>⟳ Rotate all</button>
              </div>
              <div className="toolbar-hint">Drag thumbnails to change page sequence</div>
            </section>

            <section className="compression card">
              <div className="compression-top">
                <div>
                  <span className="eyebrow">Compression</span>
                  <h2>{compressionLabel}</h2>
                  <p>0% = maximum quality; 100% = maximum compression.</p>
                </div>
                <div className="estimate">
                  <span>Estimated output</span>
                  <strong>{formatBytes(estimate)}</strong>
                  <small>estimate only</small>
                </div>
              </div>

              <input
                className="compression-slider"
                type="range"
                min="0"
                max="100"
                value={compression}
                onChange={(e) => setCompression(Number(e.target.value))}
              />

              <div className="range-labels"><span>0% Quality</span><span>{compression}%</span><span>100% Compression</span></div>

              <div className="preset-row">
                {Object.entries(PRESETS).map(([key, preset]) => (
                  <button
                    key={key}
                    className={compression === preset.value ? "active" : ""}
                    onClick={() => setCompression(preset.value)}
                  >
                    {preset.label} <span>{preset.value}%</span>
                  </button>
                ))}
                <button className="primary" onClick={downloadCompressed} disabled={busy}>Apply compression & download</button>
              </div>
            </section>

            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
              <section className="page-grid">
                <SortableContext items={pages.map((p) => p.id)} strategy={rectSortingStrategy}>
                  {pages.map((page, index) => (
                    <SortablePage
                      key={page.id}
                      page={page}
                      index={index}
                      selected={selected.has(page.id)}
                      onSelect={toggleSelected}
                      onRotate={(id, delta) => rotatePages([id], delta)}
                    />
                  ))}
                </SortableContext>
              </section>
            </DndContext>

            {busy && (
              <div className="progress-overlay">
                <div className="progress-card">
                  <strong>{status}</strong>
                  <div className="progress-track"><span style={{ width: `${Math.round(progress * 100)}%` }} /></div>
                  <small>{Math.round(progress * 100)}%</small>
                </div>
              </div>
            )}
          </>
        )}
      </main>

      {docs.length > 0 && (
        <div className="action-bar">
          <div>
            <strong>{selectedCount || pages.length} page{(selectedCount || pages.length) === 1 ? "" : "s"}</strong>
            <span>{status || "All processing stays on this device."}</span>
          </div>
          <div className="action-buttons">
            <button className="secondary-button" onClick={resetChanges}>Reset changes</button>
            <button className="secondary-button" onClick={() => exportPdf({ split: false })}>Download edited PDF</button>
            <button className="primary" onClick={downloadCompressed}>Apply compression</button>
          </div>
        </div>
      )}
    </div>
  );
}

createRoot(document.getElementById("root")).render(<App />);
