/**
 * app.js — Main-thread orchestrator for privmark.
 *
 * Responsibilities:
 *  1. Accept file input (drag-drop or click)
 *  2. Draw watermark text on an OffscreenCanvas (or regular Canvas) → get tile bytes
 *  3. Send image + tile to the WASM Web Worker
 *  4. Display the watermarked result as a download/preview
 */

// ─── Constants ────────────────────────────────────────────────────────────────
const TILE_W = 400; // Width of the watermark tile canvas
const TILE_H = 150; // Height of the watermark tile canvas
const DEFAULT_STRENGTH = 0.14;

// ─── Worker setup ─────────────────────────────────────────────────────────────
const worker = new Worker('./src/worker.js');
let workerReady = false;
let pendingJobs = new Map(); // id → { resolve, reject }
let jobIdCounter = 0;

worker.onmessage = (e) => {
  const { type, id, buffer, message } = e.data;
  if (type === 'ready') {
    workerReady = true;
    setStatus('Ready — drop an image to watermark it.', 'idle');
    return;
  }
  // WASM startup errors arrive with id===null and must be surfaced explicitly,
  // because pendingJobs.get(null) returns undefined and would otherwise be dropped.
  if (type === 'error' && id == null) {
    workerReady = false;
    console.error('[worker]', message);
    setStatus(`Worker error: ${message}`, 'error');
    return;
  }
  const job = pendingJobs.get(id);
  if (!job) return;
  pendingJobs.delete(id);
  if (type === 'result') job.resolve(buffer);
  else job.reject(new Error(message));
};

function dispatchToWorker(payload) {
  return new Promise((resolve, reject) => {
    if (!workerReady) {
      reject(new Error('WASM worker is not ready yet'));
      return;
    }
    const id = jobIdCounter++;
    pendingJobs.set(id, { resolve, reject });
    worker.postMessage({ ...payload, id }, payload.transferables ?? []);
  });
}

// ─── Tile rendering ───────────────────────────────────────────────────────────

/**
 * Render the watermark text onto a canvas and return the raw RGBA pixel data.
 * We use a regular Canvas (OffscreenCanvas has limited support in some browsers)
 * rotated -30 degrees, with the text rendered at the given opacity.
 */
function renderWatermarkTile(text, opacity = 0.35) {
  const canvas = document.createElement('canvas');
  canvas.width = TILE_W;
  canvas.height = TILE_H;
  const ctx = canvas.getContext('2d');

  ctx.clearRect(0, 0, TILE_W, TILE_H);

  // Rotate canvas around centre
  ctx.save();
  ctx.translate(TILE_W / 2, TILE_H / 2);
  ctx.rotate(-Math.PI / 6); // -30°

  // Text style
  ctx.font = 'bold 22px "Inter", "Segoe UI", Arial, sans-serif';
  ctx.fillStyle = `rgba(60, 60, 60, ${opacity})`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  ctx.fillText(text, 0, 0);
  ctx.restore();

  const imageData = ctx.getImageData(0, 0, TILE_W, TILE_H);
  return imageData.data; // Uint8ClampedArray — RGBA
}

// ─── Main processing pipeline ─────────────────────────────────────────────────

async function processFile(file) {
  const recipientEl = document.getElementById('recipient');
  const strengthEl = document.getElementById('strength');

  const recipientText = (recipientEl.value || 'Watermark').trim();
  const strength = Number.parseFloat(strengthEl.value) || DEFAULT_STRENGTH;

  // Build seed: recipient + ISO timestamp (minute-level precision for determinism)
  const now = new Date();
  const timestamp = now.toISOString().slice(0, 16).replace('T', ' '); // "2026-04-30 19:08"
  const seedText = `${recipientText} · ${timestamp}`;

  // Determine output format from input file type
  const isPng = file.type === 'image/png';
  const outputFormat = isPng ? 'png' : 'jpeg';

  setStatus('Reading file…', 'busy');

  // 1. Read file bytes
  const imageBuffer = await file.arrayBuffer();

  // 2. Render tile
  setStatus('Rendering watermark tile…', 'busy');
  const tileRGBA = renderWatermarkTile(seedText, 0.5);

  // 3. Send to worker
  setStatus('Applying watermark (WASM)…', 'busy');
  showProgress(true);

  const t0 = performance.now();

  let resultBuffer;
  try {
    resultBuffer = await dispatchToWorker({
      type: 'process',
      imageBuffer,
      tileBuffer: tileRGBA.buffer,
      tileWidth: TILE_W,
      tileHeight: TILE_H,
      seedText,
      strength,
      outputFormat,
      jpegQuality: 92,
      transferables: [imageBuffer, tileRGBA.buffer],
    });
  } catch (err) {
    setStatus(`Error: ${err.message}`, 'error');
    showProgress(false);
    return;
  }

  const elapsed = (performance.now() - t0).toFixed(0);
  setStatus(`Done in ${elapsed} ms — download ready.`, 'done');
  showProgress(false);

  // 4. Display & enable download
  renderPreview(resultBuffer, outputFormat);
  enableDownload(resultBuffer, outputFormat, recipientText);
}

// ─── UI helpers ───────────────────────────────────────────────────────────────

function setStatus(msg, state = 'idle') {
  const el = document.getElementById('status');
  el.textContent = msg;
  el.dataset.state = state;
}

function showProgress(visible) {
  document.getElementById('progress-ring').style.display = visible ? 'block' : 'none';
}

function renderPreview(buffer, format) {
  const mime = format === 'png' ? 'image/png' : 'image/jpeg';
  const blob = new Blob([buffer], { type: mime });
  const url = URL.createObjectURL(blob);

  const preview = document.getElementById('preview');
  const prevUrl = preview.src;
  preview.src = url;
  preview.style.display = 'block';
  preview.onload = () => { if (prevUrl) URL.revokeObjectURL(prevUrl); };

  document.getElementById('preview-section').style.display = 'flex';
}

function enableDownload(buffer, format, recipient) {
  const mime = format === 'png' ? 'image/png' : 'image/jpeg';
  const ext = format === 'png' ? 'png' : 'jpg';
  const blob = new Blob([buffer], { type: mime });
  const url = URL.createObjectURL(blob);

  const link = document.getElementById('download-link');
  if (link.href?.startsWith('blob:')) URL.revokeObjectURL(link.href);
  link.href = url;
  const safeRecipient = recipient.replaceAll(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40);
  link.download = `privmark_${safeRecipient}.${ext}`;
  link.style.display = 'inline-flex';
}

// ─── File input wiring ────────────────────────────────────────────────────────

function wireFileInput() {
  const dropzone = document.getElementById('dropzone');
  const fileInput = document.getElementById('file-input');

  dropzone.addEventListener('click', () => fileInput.click());

  dropzone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
      if (e.key === ' ' || e.key === 'Spacebar') e.preventDefault();
      fileInput.click();
    }
  });

  fileInput.addEventListener('change', () => {
    if (fileInput.files.length > 0) processFile(fileInput.files[0]);
  });

  dropzone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropzone.classList.add('drag-over');
  });

  dropzone.addEventListener('dragleave', () => dropzone.classList.remove('drag-over'));

  dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropzone.classList.remove('drag-over');
    const file = e.dataTransfer.files[0];
    const isValidType = file && (
      file.type === 'image/jpeg' ||
      file.type === 'image/png' ||
      /\.(jpe?g|png)$/i.test(file.name)
    );
    if (isValidType) {
      processFile(file);
    } else {
      setStatus('Please drop a JPEG or PNG image.', 'error');
    }
  });

  document.getElementById('process-btn').addEventListener('click', () => {
    if (fileInput.files.length > 0) processFile(fileInput.files[0]);
    else setStatus('Please select an image first.', 'error');
  });
}

// ─── Bootstrap ───────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  setStatus('Loading WASM module…', 'busy');
  wireFileInput();
});
