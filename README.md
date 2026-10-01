# PDF Workspace

A privacy-first browser PDF manager built with React, Vite, `pdf-lib`, PDF.js and dnd-kit.

## Features

- Local drag-and-drop PDF upload
- Multi-PDF workspace
- High-resolution page thumbnails
- Drag-and-drop page reordering
- Page selection, deletion and extraction
- Per-page ±90°/180° rotation
- Rotate selected / rotate all
- Append other uploaded PDFs
- Insert blank pages
- Export edited PDF
- Compression slider from 0–100%
- High Quality / Recommended / Extreme presets
- Dark/light mode
- Undo/redo
- Ctrl/Cmd+A and Delete shortcuts
- No application server is required for PDF processing

## Important compression note

The normal edit/export path preserves the original PDF pages.

The compression path rasterizes each page with PDF.js and writes JPEG images into a new PDF with `pdf-lib`. This is intentional: browser-side `pdf-lib` does not provide a general-purpose "recompress every embedded image in an arbitrary PDF while preserving all original PDF objects" operation.

Therefore compressed output can lose:
- selectable/searchable text
- vector graphics
- some annotations/forms
- embedded document features

Use **Download edited PDF** when structural fidelity matters, and **Apply compression** when reducing file size is the priority.

The estimated compressed size is only an estimate; the actual size is calculated after rendering.

## Local setup

```bash
npm install
npm run dev
```

Open the Vite URL shown in the terminal, usually:

```text
http://localhost:5173
```

For production:

```bash
npm run build
npm run preview
```

## Google Sites deployment

Google Sites is best used as the container/host page rather than as the build environment for a React app.

1. Build this project with `npm run build`.
2. Host the generated `dist/` folder on a static host such as GitHub Pages, Cloudflare Pages, Netlify, Vercel, or your institution's web server.
3. In Google Sites choose **Insert → Embed → By URL**.
4. Paste the deployed app URL.
5. Resize the embedded frame to the desired height.

All PDF processing still happens inside the visitor's browser. The hosting server only serves the application files.

## Privacy

PDF bytes are read with browser APIs and processed in memory. This project does not contain an upload endpoint or analytics endpoint.

For very large PDFs, browser memory and device performance become the practical limit. The default UI therefore limits individual files to 100 MB.

## Suggested production enhancements

- Add a Web Worker for compression so the UI remains responsive for very large PDFs.
- Add a cancelable job controller.
- Add a page-range parser such as `1-3,5,8-10`.
- Add PDF metadata editing.
- Add watermark/signature insertion.
- Add password-protected output where supported by the chosen PDF library.
- Add an optional "preserve text/vector" optimization path using a server-side PDF engine if required.
