export const viewerHtml = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="color-scheme" content="light">
    <title>Kilin workflow viewer</title>
    <link rel="stylesheet" href="/assets/viewer.css">
    <script type="module" src="/assets/client.js"></script>
  </head>
  <body>
    <div id="app-shell" class="app-shell" aria-busy="true">
      <header class="topbar">
        <div class="brand-block">
          <span class="brand-mark" aria-hidden="true"><svg width="30" height="30" viewBox="0 0 128 128"><rect width="128" height="128" rx="24" fill="#24262B"/><g stroke="#FAFBFC" stroke-width="11" fill="none"><path d="M47 30 L47 98"/><path d="M81 30 L47 64 L81 98"/></g><g fill="#FAFBFC"><circle cx="47" cy="30" r="12"/><circle cx="47" cy="98" r="12"/><circle cx="81" cy="30" r="12"/><circle cx="81" cy="98" r="12"/></g><circle cx="47" cy="64" r="12" fill="#C9A25E"/></svg></span>
          <div>
            <p class="eyebrow">Workflow viewer</p>
            <h1 id="app-title">Kilin</h1>
          </div>
        </div>
        <button type="button" id="decision-needed-banner" class="decision-needed-banner" hidden></button>
        <div class="connection-block">
          <p id="connection-status" class="connection-status" role="status" aria-live="polite">Connecting…</p>
          <button type="button" id="refresh-button" class="quiet-button">Refresh</button>
        </div>
        <p id="selection-announcement" class="sr-only" role="status" aria-live="polite"></p>
        <p id="approval-status" class="sr-only" role="status" aria-live="polite"></p>
      </header>

      <div class="viewer-layout">
        <aside class="history-region" aria-labelledby="history-heading">
          <div class="region-heading history-heading-row">
            <div>
              <p id="history-count" class="eyebrow">Run history</p>
              <h2 id="history-heading">Run history</h2>
            </div>
            <button id="current-workflow-button" class="quiet-button" type="button">Current</button>
          </div>
          <ol id="history-list" class="history-list"></ol>
          <p id="history-empty" class="empty-copy" hidden>No stored runs yet.</p>
        </aside>

        <main class="graph-region" aria-labelledby="graph-heading">
          <div class="region-heading graph-heading-row">
            <div>
              <p id="graph-context" class="eyebrow">Current workflow</p>
              <h2 id="graph-heading">Workflow</h2>
            </div>
            <span id="graph-status" class="status-chip">Loading</span>
          </div>
          <div id="diagnostics" class="diagnostics" aria-live="polite"></div>
          <div class="graph-strip">
            <svg id="workflow-graph" class="workflow-graph" role="group" aria-labelledby="workflow-graph-title" aria-describedby="workflow-graph-description"></svg>
          </div>
          <section class="execution-equivalent sr-only" aria-labelledby="execution-heading">
            <h3 id="execution-heading">Execution order</h3>
            <ol id="execution-list"></ol>
          </section>
          <section id="output-section" class="evidence-stage" aria-labelledby="output-heading" hidden>
            <header class="evidence-header">
              <h3 id="output-heading">Evidence</h3>
              <div class="evidence-controls">
                <div class="evidence-control-group">
                  <span class="control-label" aria-hidden="true">Stream</span>
                  <div id="output-tabs" class="output-tabs" role="tablist" aria-label="Captured output streams"></div>
                </div>
                <div class="evidence-control-group">
                  <span class="control-label" aria-hidden="true">View</span>
                  <div class="evidence-view-toggle" role="group" aria-label="Evidence rendering">
                    <button id="evidence-view-rendered" type="button" aria-pressed="true">Rendered</button>
                    <button id="evidence-view-raw" type="button" aria-pressed="false">Raw</button>
                  </div>
                </div>
              </div>
            </header>
            <p id="evidence-banner" class="evidence-banner" hidden></p>
            <div id="output-panel" class="evidence-body" role="tabpanel" tabindex="0"></div>
            <p id="output-meta" class="output-meta"></p>
          </section>
          <section id="decision-dock" class="decision-dock" aria-labelledby="decision-heading" hidden></section>
          <p id="evidence-placeholder" class="empty-copy evidence-placeholder">Select a stored run to inspect its evidence.</p>
        </main>

        <aside class="inspector-region" aria-labelledby="inspector-heading">
          <div class="region-heading">
            <p class="eyebrow">Selection</p>
            <h2 id="inspector-heading">Inspector</h2>
          </div>
          <div id="run-inspector" class="inspector-section"></div>
          <div id="node-inspector" class="inspector-section"></div>
          <section id="loop-iterations-section" class="inspector-section" aria-labelledby="loop-iterations-heading" hidden>
            <h3 id="loop-iterations-heading">Loop iterations</h3>
            <div id="loop-iterations-list"></div>
          </section>
          <section id="lineage-section" class="inspector-section" aria-labelledby="lineage-heading" hidden>
            <h3 id="lineage-heading">Run lineage</h3>
            <ol id="lineage-list" class="lineage-list"></ol>
          </section>
        </aside>
      </div>
    </div>
    <div id="fatal-error" class="fatal-error" role="alert" hidden>
      <h1>Viewer unavailable</h1>
      <p id="fatal-error-message"></p>
    </div>
  </body>
</html>`;

export const viewerCss = `:root {
  color: #24262b;
  background: #f6f7f8;
  font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  font-synthesis: none;
  line-height: 1.45;
  --border: #e2e4e8;
  --muted: #6b707b;
  --panel: #ffffff;
  --subdued: #f3f4f6;
  --danger: #b42318;
  --danger-soft: #fff0ee;
  --success: #18794e;
  --success-soft: #e9f6ef;
  --running: #3659b5;
  --running-soft: #edf2ff;
  --gate: #c02c7e;
  --gate-soft: #fdf4fa;
  --interrupted: #d0763a;
  --interrupted-ink: #9a4d13;
  --interrupted-soft: #fdf1e7;
  --dim: #8d929d;
  --dim-ink: #555a65;
  --dim-soft: #eff0f2;
  --selection: #3d4351;
  --selection-soft: #eef0f3;
  --hairline: #ecedf0;
  --code-surface: #f5f6f8;
}

.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  padding: 0;
  overflow: hidden;
  border: 0;
  clip-path: inset(50%);
  white-space: nowrap;
}

* {
  box-sizing: border-box;
}

html,
body {
  width: 100%;
  height: 100%;
  margin: 0;
  overflow: hidden;
}

button {
  min-width: 44px;
  min-height: 44px;
  border: 0;
  border-radius: 7px;
  color: inherit;
  background: transparent;
  font: inherit;
  cursor: pointer;
}

button:hover {
  background: #e9eaed;
}

button:focus-visible,
[tabindex]:focus-visible {
  outline: 3px solid var(--selection);
  outline-offset: 2px;
}

button:disabled {
  cursor: default;
}

.app-shell {
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  height: 100%;
}

.topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 4px 12px;
  min-width: 0;
  min-height: 56px;
  padding: 4px 16px;
  border-bottom: 1px solid var(--border);
  background: color-mix(in srgb, var(--panel) 92%, transparent);
}

.brand-block {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

.brand-mark {
  display: grid;
  place-items: center;
  width: 30px;
  height: 30px;
}

.brand-mark svg {
  display: block;
}

h1,
h2,
h3,
p {
  margin: 0;
}

h1 {
  font-size: 15px;
  font-weight: 650;
}

h2 {
  font-size: 14px;
  font-weight: 650;
}

h3 {
  margin-bottom: 8px;
  color: #494d57;
  font-size: 12px;
  font-weight: 650;
  letter-spacing: 0.02em;
  text-transform: uppercase;
}

.eyebrow {
  color: var(--muted);
  font-size: 10px;
  font-weight: 650;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.connection-block {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.connection-block button {
  flex: none;
}

.connection-status {
  max-width: 50vw;
  min-width: 0;
  overflow: hidden;
  color: var(--muted);
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.decision-needed-banner {
  display: flex;
  align-items: center;
  gap: 8px;
  max-width: 100%;
  padding: 6px 12px;
  border: 1px solid var(--gate);
  color: var(--gate);
  background: var(--gate-soft);
  font-size: 12px;
  font-weight: 650;
}

.decision-needed-banner:hover {
  color: #7c1f56;
  background: #f9e3f1;
}

.decision-needed-countdown {
  color: var(--muted);
  font-weight: 500;
}

.decision-needed-countdown.urgent {
  color: var(--danger);
  font-weight: 650;
}

.viewer-layout {
  display: grid;
  grid-template-columns: 224px minmax(360px, 1fr) 304px;
  min-width: 0;
  min-height: 0;
}

.history-region,
.graph-region,
.inspector-region {
  min-width: 0;
  min-height: 0;
  overflow: auto;
}

.history-region {
  padding: 14px 10px;
  border-right: 1px solid var(--border);
  background: var(--subdued);
}

.graph-region {
  display: flex;
  flex-direction: column;
  padding: 16px;
  background: var(--panel);
}

.inspector-region {
  padding: 14px;
  border-left: 1px solid var(--border);
  background: #fafafa;
}

.region-heading {
  flex: 0 0 auto;
  margin-bottom: 12px;
}

.history-heading-row,
.graph-heading-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.quiet-button {
  min-height: 44px;
  padding: 0 10px;
  color: #565b66;
  font-size: 12px;
  font-weight: 600;
}

.quiet-button[aria-pressed="true"] {
  color: var(--selection);
  background: var(--selection-soft);
}

.history-list,
.lineage-list,
.execution-equivalent ol,
.loop-execution-list {
  margin: 0;
  padding: 0;
  list-style: none;
}

.loop-iteration-item {
  margin: 6px 0 8px;
}

.loop-iteration-group + .loop-iteration-group {
  margin-top: 12px;
}

.loop-iteration-group h4 {
  margin: 0 0 6px;
  font-size: 12px;
}

.loop-iteration {
  padding: 7px 8px;
  border-left: 2px solid var(--border);
  font-size: 11px;
}

.loop-iteration summary {
  min-height: 44px;
  cursor: pointer;
  font-weight: 600;
}

.loop-execution-list {
  display: grid;
  gap: 5px;
  padding-top: 5px;
}

.loop-execution-button {
  width: 100%;
  min-height: 44px;
  padding: 5px 7px;
  text-align: left;
}

.loop-execution-provenance {
  display: block;
  margin: 3px 7px 0;
  color: var(--muted);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  overflow-wrap: anywhere;
}

.run-metadata-list {
  display: grid;
  gap: 4px;
  margin: 6px 0 10px;
  padding-left: 18px;
  color: var(--muted);
  font-size: 11px;
  overflow-wrap: anywhere;
}

.history-item {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 44px;
  align-items: start;
}

.history-item + .history-item {
  margin-top: 4px;
}

.history-button {
  display: grid;
  grid-template-columns: 14px minmax(0, 1fr);
  gap: 8px;
  width: 100%;
  padding: 7px 8px;
  text-align: left;
}

.history-button[aria-current="true"] {
  background: #e7e8ec;
}

.status-glyph {
  flex: 0 0 auto;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-weight: 600;
  font-style: normal;
  line-height: 1.2;
  color: var(--dim-ink);
}

.status-glyph.succeeded {
  color: var(--success);
}

.status-glyph.failed {
  color: var(--danger);
}

.status-glyph.interrupted {
  color: var(--interrupted-ink);
}

.status-glyph.running {
  color: var(--running);
}

.status-glyph.waiting_for_approval {
  color: var(--gate);
}

.history-workflow,
.history-meta,
.history-run-id {
  display: block;
  min-width: 0;
}

.history-workflow {
  overflow: hidden;
  font-size: 12px;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.history-meta {
  margin-top: 2px;
  color: var(--muted);
  font-size: 10px;
  overflow-wrap: anywhere;
}

.history-run-id {
  margin-top: 3px;
  color: var(--muted);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 9.5px;
  overflow-wrap: anywhere;
}

.copy-run-id {
  align-self: start;
  padding: 0;
  color: var(--muted);
  font-size: 13px;
}

.empty-copy {
  padding: 16px 8px;
  color: var(--muted);
  font-size: 12px;
}

.status-chip {
  display: inline-flex;
  flex: 0 0 auto;
  gap: 5px;
  align-items: center;
  padding: 4px 9px;
  border-radius: 999px;
  color: var(--dim-ink);
  background: var(--dim-soft);
  font-size: 11px;
  font-weight: 650;
}

.status-chip .status-glyph {
  color: inherit;
}

.status-chip.succeeded {
  color: var(--success);
  background: var(--success-soft);
}

.status-chip.failed,
.status-chip.invalid {
  color: var(--danger);
  background: var(--danger-soft);
}

.status-chip.interrupted {
  color: var(--interrupted-ink);
  background: var(--interrupted-soft);
}

.status-chip.running {
  color: var(--running);
  background: var(--running-soft);
}

.status-chip.waiting_for_approval {
  color: var(--gate);
  background: var(--gate-soft);
}

.status-chip.running .status-glyph {
  animation: kilin-pulse 1.6s ease-in-out infinite;
}

@keyframes kilin-pulse {
  0%,
  100% {
    opacity: 1;
  }

  50% {
    opacity: 0.35;
  }
}

@keyframes kilin-flow {
  to {
    stroke-dashoffset: -20;
  }
}

.diagnostics:empty {
  display: none;
}

.diagnostics {
  flex: 0 0 auto;
  margin-bottom: 12px;
  border: 1px solid #f0c7c1;
  border-radius: 8px;
  background: #fff7f5;
}

.diagnostic {
  padding: 9px 10px;
  color: #792e26;
  font-size: 12px;
}

.diagnostic + .diagnostic {
  border-top: 1px solid #f3d8d4;
}

.diagnostic-path {
  color: var(--muted);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}

.graph-strip {
  flex: 0 0 auto;
  min-width: 0;
  max-height: clamp(160px, 34vh, 340px);
  overflow: auto;
  border: 1px solid var(--border);
  border-radius: 10px;
  background-color: #fafbfc;
  background-image: radial-gradient(#dcdfe4 0.7px, transparent 0.7px);
  background-size: 16px 16px;
}

.workflow-graph {
  display: block;
}

.dag-edge {
  fill: none;
  stroke: #aeb3bd;
  stroke-width: 1.5;
}

.dag-arrow-head {
  fill: #aeb3bd;
}

.dag-arrow-running-head {
  fill: var(--running);
}

.dag-edge.running {
  stroke: var(--running);
  stroke-dasharray: 7 5;
  animation: kilin-flow 1.1s linear infinite;
}

.dag-node {
  cursor: pointer;
}

.dag-node:focus-visible {
  outline: none;
}

.dag-node-body {
  fill: white;
  stroke: #cfd3da;
  stroke-width: 1.5;
}

.dag-node-selection {
  fill: none;
  stroke: none;
}

.dag-node text {
  pointer-events: none;
  fill: #292c33;
  font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}

.dag-node .dag-node-title {
  font-size: 13px;
  font-weight: 650;
}

.dag-node .dag-node-meta {
  fill: #777c87;
  font-size: 10px;
}

.dag-node.succeeded .dag-node-body {
  stroke: var(--success);
}

.dag-node.failed .dag-node-body {
  stroke: var(--danger);
}

.dag-node.interrupted .dag-node-body {
  stroke: var(--interrupted);
}

.dag-node.cancelled .dag-node-body {
  stroke: var(--dim);
}

.dag-node.pending .dag-node-body,
.dag-node.skipped .dag-node-body {
  stroke: var(--dim);
  stroke-dasharray: 4 4;
}

.dag-node.skipped {
  opacity: 0.55;
}

.dag-node.running .dag-node-body {
  stroke: var(--running);
  stroke-width: 2;
  stroke-dasharray: 7 5;
  animation: kilin-flow 1.1s linear infinite;
}

.dag-node.waiting_for_approval .dag-node-body {
  fill: var(--gate-soft);
  stroke: var(--gate);
  stroke-width: 2;
}

.dag-node.succeeded .dag-node-meta {
  fill: var(--success);
}

.dag-node.failed .dag-node-meta {
  fill: var(--danger);
}

.dag-node.running .dag-node-meta {
  fill: var(--running);
}

.dag-node.interrupted .dag-node-meta {
  fill: var(--interrupted-ink);
}

.dag-node.waiting_for_approval .dag-node-meta {
  fill: var(--gate);
}

.dag-node.cancelled .dag-node-meta,
.dag-node.pending .dag-node-meta,
.dag-node.skipped .dag-node-meta {
  fill: var(--dim-ink);
}

.dag-node:hover .dag-node-body,
.dag-node[aria-selected="true"] .dag-node-body {
  fill: var(--selection-soft);
}

.dag-node.waiting_for_approval:hover .dag-node-body,
.dag-node.waiting_for_approval[aria-selected="true"] .dag-node-body {
  fill: var(--gate-soft);
}

.dag-node[aria-selected="true"] .dag-node-selection {
  stroke: var(--selection);
  stroke-width: 1.5;
}

.dag-node:focus-visible .dag-node-selection {
  stroke: var(--selection);
  stroke-width: 3;
}

.inspector-section {
  padding: 12px 0;
  border-top: 1px solid var(--border);
}

.inspector-section:first-of-type {
  border-top: 0;
}

.inspector-title {
  margin-bottom: 10px;
  font-size: 15px;
  font-weight: 650;
  overflow-wrap: anywhere;
}

.property-list {
  display: grid;
  grid-template-columns: minmax(72px, auto) minmax(0, 1fr);
  gap: 7px 10px;
  margin: 0;
  font-size: 12px;
}

.property-list dt {
  color: var(--muted);
}

.property-list dd {
  min-width: 0;
  margin: 0;
  overflow-wrap: anywhere;
}

.failure-copy {
  margin-top: 10px;
  padding: 8px;
  border-radius: 6px;
  color: #792e26;
  background: var(--danger-soft);
  font-size: 12px;
  overflow-wrap: anywhere;
}

.failure-reference {
  margin-top: 10px;
  color: var(--muted);
  font-size: 11px;
  overflow-wrap: anywhere;
}

.property-list dd.urgent {
  color: var(--danger);
  font-weight: 650;
}

.approval-commands {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 6px;
  margin-top: 12px;
  padding: 10px;
  border: 1px solid #f0c9e1;
  border-radius: 7px;
  color: #7c1f56;
  background: var(--gate-soft);
  font-size: 11px;
}

.approval-commands code {
  display: block;
  padding: 7px;
  overflow-x: auto;
  color: #5c163f;
  background: #f9e3f1;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  white-space: nowrap;
}

.run-commands {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 6px;
  margin-top: 12px;
  padding: 10px;
  border: 1px solid var(--border);
  border-radius: 7px;
  color: var(--muted);
  background: var(--subdued);
  font-size: 11px;
}

.run-commands code {
  display: block;
  padding: 7px;
  color: var(--dim-ink);
  background: var(--code-surface);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.lineage-list {
  display: grid;
  gap: 4px;
}

.lineage-button {
  width: 100%;
  padding: 7px 8px;
  overflow: hidden;
  text-align: left;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11px;
}

.lineage-button[aria-current="true"] {
  color: var(--selection);
  background: var(--selection-soft);
}

.evidence-stage {
  display: grid;
  grid-template-rows: auto auto minmax(0, 1fr) auto;
  flex: 1 1 0;
  min-height: 180px;
  margin-top: 14px;
  overflow: hidden;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: #fafbfc;
}

.evidence-header {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 14px;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  border-bottom: 1px solid var(--hairline);
  background: var(--panel);
}

.evidence-header h3 {
  margin-bottom: 0;
}

.evidence-controls {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 14px;
}

.evidence-control-group {
  display: inline-flex;
  gap: 7px;
  align-items: center;
}

.control-label {
  color: var(--muted);
  font-size: 10px;
  font-weight: 650;
  letter-spacing: 0.07em;
  text-transform: uppercase;
}

.output-tabs {
  display: inline-flex;
  gap: 3px;
  padding: 3px;
  border-radius: 8px;
  background: #eceef1;
}

.evidence-view-toggle {
  display: inline-flex;
  overflow: hidden;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--panel);
}

.output-tab,
.evidence-view-toggle button {
  min-height: 44px;
  padding: 0 12px;
  color: #565b66;
  font-size: 11px;
  font-weight: 600;
}

.evidence-view-toggle button {
  border-radius: 0;
}

.evidence-view-toggle button + button {
  border-left: 1px solid var(--border);
}

.output-tab[aria-selected="true"] {
  color: var(--selection);
  background: white;
}

.evidence-view-toggle button[aria-pressed="true"] {
  color: var(--panel);
  background: var(--selection);
}

.evidence-banner {
  margin: 0;
  padding: 6px 12px;
  border-bottom: 1px solid var(--hairline);
  color: #565b66;
  background: var(--panel);
  font-size: 11px;
}

.evidence-body {
  min-height: 0;
  padding: 14px 16px;
  overflow: auto;
  background: #fafbfc;
  overflow-wrap: anywhere;
}

.evidence-error {
  display: grid;
  justify-items: start;
  gap: 10px;
}

.evidence-error > :first-child {
  margin-top: 0;
}

.evidence-retry {
  border: 1px solid var(--border);
  background: var(--panel);
}

.evidence-placeholder {
  flex: 0 0 auto;
  align-self: start;
  margin-top: 14px;
  padding: 16px;
  border: 1px dashed var(--border);
  border-radius: 10px;
}

.decision-dock {
  display: grid;
  grid-template-rows: auto minmax(0, 1fr) auto;
  flex: 1 1 0;
  min-height: 240px;
  margin-top: 14px;
  overflow: hidden;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: #fafbfc;
}

.dock-header {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 14px;
  align-items: baseline;
  justify-content: space-between;
  padding: 10px 14px;
  border-bottom: 1px solid var(--hairline);
  background: var(--panel);
}

.dock-headline {
  min-width: 0;
}

.dock-header .eyebrow {
  color: var(--gate);
}

.dock-deadline {
  flex: 0 0 auto;
  padding: 3px 9px;
  border-radius: 999px;
  color: var(--dim-ink);
  background: var(--dim-soft);
  font-size: 11px;
  font-weight: 650;
}

.dock-deadline.urgent {
  color: var(--danger);
  background: var(--danger-soft);
}

.decision-footer {
  display: grid;
  gap: 8px;
  padding: 12px 16px;
  border-top: 1px solid var(--hairline);
  background: var(--panel);
}

.dock-question {
  margin-top: 2px;
  color: #24262b;
  font-size: 14px;
  font-weight: 650;
  letter-spacing: 0;
  text-transform: none;
}

.dock-body {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 12px;
  align-content: start;
  min-height: 0;
  padding: 14px 16px;
  overflow: auto;
}

.dock-evidence {
  padding: 10px 12px;
  border: 1px solid var(--hairline);
  border-radius: 8px;
  background: var(--panel);
}

.dock-evidence-label {
  margin-bottom: 6px;
  color: var(--muted);
  font-size: 10px;
  font-weight: 650;
  letter-spacing: 0.07em;
  text-transform: uppercase;
}

.dock-evidence-bound {
  margin-bottom: 6px;
  color: #565b66;
  font-size: 11px;
}

.decision-controls {
  display: grid;
  gap: 8px;
  padding: 12px;
  border: 1px solid #f0c9e1;
  border-radius: 8px;
  background: var(--gate-soft);
}

.decision-note-label {
  color: #7c1f56;
  font-size: 11px;
  font-weight: 650;
}

.decision-note {
  min-height: 44px;
  padding: 0 10px;
  border: 1px solid #e6b7d3;
  border-radius: 7px;
  color: inherit;
  background: white;
  font: inherit;
  font-size: 12px;
}

.decision-note:focus-visible {
  outline: 3px solid color-mix(in srgb, var(--gate) 55%, white);
  outline-offset: 1px;
}

.decision-actions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
}

.reject-button {
  padding: 0 14px;
  color: #7c1f56;
  font-weight: 600;
}

.reject-button:hover {
  background: #f9e3f1;
}

.approve-button {
  padding: 0 18px;
  color: white;
  background: var(--gate);
  font-weight: 650;
}

.approve-button:hover {
  background: #a82370;
}

.approve-button:disabled,
.reject-button:disabled {
  opacity: 0.6;
}

.decision-status {
  color: #7c1f56;
  font-size: 12px;
}

.decision-status:empty {
  display: none;
}

.decision-record {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
  padding: 10px 12px;
  border: 1px solid var(--hairline);
  border-radius: 8px;
  background: var(--panel);
  font-size: 12px;
}

.decision-chip {
  padding: 2px 9px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 650;
}

.decision-chip.approved {
  color: var(--success);
  background: #e9f6ef;
}

.decision-chip.rejected {
  color: var(--danger);
  background: #fff0ee;
}

.copy-command {
  display: flex;
  gap: 6px;
  align-items: center;
}

.copy-command code {
  flex: 1 1 auto;
  min-width: 0;
}

.copy-button {
  flex: 0 0 auto;
  padding: 0 10px;
  color: var(--dim-ink);
  background: white;
  border: 1px solid var(--muted);
  font-size: 11px;
  font-weight: 600;
}

.approval-commands .copy-button {
  color: #7c1f56;
  border-color: #e6b7d3;
}

.decision-packet {
  display: grid;
  gap: 12px;
  min-width: 0;
  color: #33363d;
  overflow-wrap: anywhere;
}

.decision-packet-header {
  padding: 2px 2px 10px;
  border-bottom: 1px solid var(--hairline);
}

.decision-packet-header h3 {
  margin: 3px 0;
  color: #24262b;
  font-size: 17px;
  letter-spacing: 0;
  text-transform: none;
}

.packet-subject-type,
.packet-objective {
  margin: 3px 0 0;
}

.packet-subject-type {
  color: var(--muted);
  font-size: 11px;
}

.packet-objective {
  max-width: 76ch;
  font-size: 13px;
  line-height: 1.5;
}

.decision-packet-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
  align-items: stretch;
  min-width: 0;
}

.decision-packet-section {
  min-width: 0;
  padding: 12px;
  border: 1px solid var(--hairline);
  border-radius: 9px;
  background: var(--panel);
}

.decision-packet-section h4 {
  margin: 0 0 8px;
  color: #24262b;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

.packet-list {
  display: grid;
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.packet-list-item {
  display: grid;
  gap: 3px;
  min-width: 0;
}

.packet-list-item + .packet-list-item {
  padding-top: 8px;
  border-top: 1px solid var(--hairline);
}

.packet-item-title,
.packet-item-detail,
.packet-item-meta,
.packet-evaluation,
.packet-subheading,
.packet-boundary {
  margin: 0;
}

.packet-item-title {
  color: #2c2f35;
  font-size: 12px;
  font-weight: 650;
}

.packet-item-detail,
.packet-evaluation {
  font-size: 12px;
  line-height: 1.5;
  white-space: pre-wrap;
}

.packet-item-meta {
  color: var(--muted);
  font-size: 10px;
  line-height: 1.45;
}

.packet-evaluation {
  margin-bottom: 9px;
  color: #565b66;
}

.packet-subheading {
  margin: 11px 0 6px;
  color: var(--muted);
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.05em;
  text-transform: uppercase;
}

.packet-boundary {
  margin-bottom: 8px;
  padding: 5px 7px;
  border-radius: 6px;
  color: #5d4051;
  background: var(--gate-soft);
  font-size: 10px;
  font-weight: 650;
  line-height: 1.4;
}

.packet-metrics {
  margin-top: 5px;
  padding: 7px;
  border-radius: 7px;
  background: #f6f7f9;
}

.packet-status {
  justify-self: start;
  padding: 2px 7px;
  border-radius: 999px;
  font-size: 9px;
  font-weight: 700;
  text-transform: uppercase;
}

.packet-status-pass {
  color: var(--success);
  background: var(--success-soft);
}

.packet-status-fail {
  color: var(--danger);
  background: var(--danger-soft);
}

.packet-status-unknown {
  color: var(--dim-ink);
  background: var(--dim-soft);
}

.dock-evidence .decision-packet-grid {
  grid-template-columns: minmax(0, 1fr);
}

.stream-text {
  margin: 0;
  padding: 8px;
  border-radius: 6px;
  color: #33363d;
  background: var(--code-surface);
  font: 11px/1.55 ui-monospace, SFMono-Regular, Menlo, monospace;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.structured-text {
  overflow-x: auto;
  white-space: pre;
  overflow-wrap: normal;
}

.activity-log {
  display: grid;
  margin: 0;
  padding: 0;
  list-style: none;
  font-size: 12px;
}

.activity-row {
  display: grid;
  grid-template-columns: 58px minmax(0, 1fr);
  gap: 8px;
  padding: 7px 2px;
}

.activity-row + .activity-row {
  border-top: 1px solid var(--hairline);
}

.row-tag {
  padding-top: 1px;
  color: #7a7f8a;
  font-size: 9px;
  font-weight: 650;
  letter-spacing: 0.07em;
  text-transform: uppercase;
}

.row-body {
  display: grid;
  gap: 4px;
  min-width: 0;
}

.reason-title {
  display: block;
  color: #565b66;
}

.message-text {
  white-space: pre-wrap;
}

.run-header {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
}

.run-details > summary {
  cursor: pointer;
}

.run-details > summary::marker {
  color: #8d929d;
  font-size: 10px;
}

.run-command {
  min-width: 0;
  overflow-wrap: anywhere;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px;
}

.run-output {
  margin: 6px 0 0;
  padding: 8px;
  max-height: 200px;
  overflow: auto;
  border-radius: 6px;
  color: #33363d;
  background: var(--code-surface);
  font: 11px/1.55 ui-monospace, SFMono-Regular, Menlo, monospace;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.exit-badge {
  flex: 0 0 auto;
  padding: 1px 7px;
  border-radius: 999px;
  font-size: 10px;
  font-weight: 650;
  color: #555a65;
  background: #eff0f2;
}

.exit-badge.exit-fail {
  color: var(--danger);
  background: #fff0ee;
}

.exit-badge.exit-running {
  color: var(--running);
  background: #edf2ff;
}

.tool-label {
  font-weight: 600;
}

.tool-detail {
  display: block;
  color: var(--muted);
  font-size: 11px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.usage-chip {
  justify-self: start;
  padding: 1px 7px;
  border: 1px solid var(--hairline);
  border-radius: 999px;
  color: #565b66;
  background: white;
  font-size: 10px;
  font-weight: 650;
}

.raw-line {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.result-document {
  max-width: 68ch;
  font-size: 13px;
  line-height: 1.6;
}

.result-document h1,
.result-document h2,
.result-document h3,
.result-document h4,
.result-document h5,
.result-document h6 {
  margin: 14px 0 6px;
  color: #24262b;
  letter-spacing: 0;
  text-transform: none;
}

.result-document h1 {
  font-size: 17px;
}

.result-document h2 {
  font-size: 15px;
}

.result-document h3 {
  font-size: 13px;
}

.result-document h4,
.result-document h5,
.result-document h6 {
  font-size: 12px;
}

.result-document > :first-child {
  margin-top: 0;
}

.result-document p {
  margin: 6px 0;
}

.result-document ul,
.result-document ol {
  margin: 6px 0;
  padding-left: 22px;
}

.result-document li {
  margin: 3px 0;
}

.result-document code {
  padding: 1px 4px;
  border-radius: 4px;
  background: var(--code-surface);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11.5px;
}

.md-code-block {
  margin: 8px 0;
  padding: 9px;
  overflow: auto;
  border-radius: 6px;
  background: #f6f7f9;
}

.md-code-block code {
  padding: 0;
  background: transparent;
  white-space: pre;
}

.md-link {
  display: inline-block;
  padding: 0 6px;
  border: 1px solid var(--hairline);
  border-radius: 999px;
  color: #3c414d;
  background: white;
  font-size: 11.5px;
}

.output-meta {
  margin: 0;
  padding: 6px 12px;
  border-top: 1px solid var(--hairline);
  color: var(--muted);
  background: var(--panel);
  font-size: 10px;
}

.output-meta:empty {
  display: none;
}

.fatal-error {
  width: min(480px, calc(100% - 32px));
  margin: 15vh auto 0;
  padding: 22px;
  border: 1px solid #f0c7c1;
  border-radius: 10px;
  background: white;
  box-shadow: 0 14px 40px rgb(28 32 40 / 10%);
}

.fatal-error h1 {
  margin-bottom: 8px;
  font-size: 18px;
}

.fatal-error p {
  color: var(--muted);
  overflow-wrap: anywhere;
}

[hidden] {
  display: none !important;
}

@media (max-width: 820px) {
  html,
  body {
    height: auto;
    min-height: 100%;
    overflow-x: hidden;
    overflow-y: auto;
  }

  .app-shell {
    display: block;
    min-height: 100vh;
  }

  .topbar {
    position: sticky;
    top: 0;
    z-index: 2;
    height: auto;
    min-height: 56px;
  }

  .viewer-layout {
    display: flex;
    flex-direction: column;
  }

  .graph-region,
  .inspector-region,
  .history-region {
    overflow: visible;
    border: 0;
    border-bottom: 1px solid var(--border);
  }

  .graph-region {
    order: 1;
  }

  .inspector-region {
    order: 2;
  }

  .history-region {
    order: 3;
  }

  .graph-strip {
    max-height: 200px;
  }

  .evidence-stage,
  .decision-dock {
    flex: 0 0 auto;
  }

  .evidence-body {
    max-height: 70vh;
  }

  .dock-body {
    max-height: 60vh;
  }

  .decision-packet-grid {
    grid-template-columns: minmax(0, 1fr);
  }
}

@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    scroll-behavior: auto !important;
    transition-duration: 0.01ms !important;
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
  }
}`;
