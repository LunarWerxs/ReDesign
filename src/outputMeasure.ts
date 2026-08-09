/**
 * The height-measurement script embedded in every model-generated output HTML.
 *
 * The viewer renders each output in an iframe that is sandboxed WITHOUT allow-same-origin, so the
 * parent cannot read the document to size it. This script rides inside the output instead and
 * postMessages its height out (see src/web/src/composables/useIframeScale.ts).
 *
 * It is injected at WRITE time (runner/reimagine.ts) so the stored file is already complete and
 * /output-raw/* can stream it straight off disk with Bun.file(). It used to be injected on every
 * request instead, which forced a full synchronous read plus a regex scan of the entire document
 * for every card in the gallery. Outputs written before that change get migrated on first view
 * (http/fileServing.ts), so this module is the single source of truth for both paths.
 *
 * Lives here, not in http/, because the runner must not import from the HTTP layer.
 */

/** Marks a document as already carrying the script, so it is never injected twice. */
const OUTPUT_MEASURE_MARKER = "data-reimagine-height";

function outputHeightMeasureScript(): string {
  return `<script ${OUTPUT_MEASURE_MARKER}>
(function () {
  var messageType = 'reimagine:frame-height';
  var maxHeight = 20000;
  var lastHeight = 0;

  function finite(n) {
    return typeof n === 'number' && isFinite(n) ? n : 0;
  }

  function readHeight() {
    var d = document.documentElement;
    var b = document.body;
    return Math.ceil(Math.max(
      finite(window.innerHeight),
      finite(d && d.scrollHeight),
      finite(d && d.offsetHeight),
      finite(d && d.clientHeight),
      finite(b && b.scrollHeight),
      finite(b && b.offsetHeight),
      finite(b && b.clientHeight)
    ));
  }

  function sendHeight() {
    var height = Math.max(1, Math.min(maxHeight, readHeight()));
    if (Math.abs(height - lastHeight) < 2) return;
    lastHeight = height;
    parent.postMessage({ type: messageType, height: height }, '*');
  }

  function observe(el) {
    if (!el || !('ResizeObserver' in window)) return;
    try { new ResizeObserver(sendHeight).observe(el); } catch (_) {}
  }

  function start() {
    observe(document.documentElement);
    observe(document.body);
    sendHeight();
  }

  window.addEventListener('load', sendHeight);
  document.addEventListener('DOMContentLoaded', start);
  start();
  [0, 50, 250, 1000, 2500, 5000].forEach(function (delay) {
    setTimeout(sendHeight, delay);
  });
  var ticks = 0;
  var timer = setInterval(function () {
    sendHeight();
    ticks += 1;
    if (ticks > 12) clearInterval(timer);
  }, 1000);
})();
</script>`;
}

/** True when `html` already carries the measurement script. */
function hasOutputHeightMeasure(html: string): boolean {
  return html.includes(OUTPUT_MEASURE_MARKER);
}

/** Insert the script just before the LAST </body> (a model's document can contain the string
 *  more than once, e.g. inside an escaped code sample), falling back to appending. */
function injectOutputHeightMeasure(html: string): string {
  if (hasOutputHeightMeasure(html)) return html;
  const script = `\n${outputHeightMeasureScript()}\n`;
  const matches = Array.from(String(html).matchAll(/<\/body\s*>/gi));
  const last = matches.at(-1);
  if (last && typeof last.index === "number") return html.slice(0, last.index) + script + html.slice(last.index);
  return html + script;
}

export { OUTPUT_MEASURE_MARKER, outputHeightMeasureScript, hasOutputHeightMeasure, injectOutputHeightMeasure };
