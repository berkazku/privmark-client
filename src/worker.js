/**
 * worker.js — Web Worker that hosts the Go WASM runtime.
 *
 * Running WASM inside a Worker means Go's synchronous startup and the
 * potentially long watermark computation never block the main thread or
 * freeze the UI.
 *
 * Message protocol (main → worker):
 *   { type: 'process', id, imageBuffer, tileBuffer, tileWidth, tileHeight,
 *     seedText, strength, outputFormat, jpegQuality }
 *
 * Message protocol (worker → main):
 *   { type: 'result', id, buffer }       — success
 *   { type: 'error',  id, message }      — failure
 *   { type: 'ready' }                    — WASM loaded and initialised
 */

importScripts('./wasm_exec.js');

let wasmReady = false;

async function loadWasm() {
  const go = new Go();
  const wasmUrl = new URL('./privmark.wasm', self.location.href).href;
  let result;
  try {
    result = await WebAssembly.instantiateStreaming(fetch(wasmUrl), go.importObject);
  } catch {
    // Fall back when the server serves .wasm with an incorrect MIME type.
    const bytes = await (await fetch(wasmUrl)).arrayBuffer();
    result = await WebAssembly.instantiate(bytes, go.importObject);
  }
  go.run(result.instance); // starts the Go main() goroutine
  wasmReady = true;
  self.postMessage({ type: 'ready' });
}

loadWasm().catch(err => {
  self.postMessage({ type: 'error', id: null, message: `WASM load failed: ${err.message}` });
});

globalThis.onmessage = async (event) => {
  const msg = event.data;
  if (msg.type !== 'process') return;
  const { id, imageBuffer, tileBuffer, tileWidth, tileHeight,
    seedText, strength, outputFormat, jpegQuality } = msg;

  if (!wasmReady) {
    self.postMessage({ type: 'error', id, message: 'WASM not ready yet' });
    return;
  }

  try {
    const resultU8 = await applyWatermark(
      new Uint8Array(imageBuffer),
      new Uint8Array(tileBuffer),
      tileWidth,
      tileHeight,
      seedText,
      strength,
      outputFormat,
      jpegQuality,
    );
    // Transfer the underlying ArrayBuffer back to main thread (zero-copy)
    self.postMessage({ type: 'result', id, buffer: resultU8.buffer }, [resultU8.buffer]);
  } catch (err) {
    self.postMessage({ type: 'error', id, message: String(err) });
  }
};
