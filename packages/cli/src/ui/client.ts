import type {
  AgentNodeRunDto,
  ApprovalDecisionRequest,
  ApprovalDecisionResponse,
  ApprovalNodeRunDto,
  ApprovalWorkflowNodeDto,
  BoundedOutputResponse,
  CurrentWorkflowResponse,
  LoopIterationDto,
  LoopWorkflowNodeDto,
  NodeRunDto,
  OutputStream,
  RunSummaryDto,
  ScopedRunDetailResponse,
  ScopedRunListResponse,
  SessionBootstrapResponse,
  ViewerApiErrorResponse,
  ViewerApprovalDecision,
  ViewerFailureDto,
  WorkflowGraphDto,
  WorkflowNodeDto,
} from "./contracts.js";

const svgNamespace = "http://www.w3.org/2000/svg";
const minimumPollIntervalMs = 1_000;
const maximumBackoffMs = 30_000;
const maximumApprovalNoteCharacters = 1_000;
const maximumHistoryRuns = 50;
const urgentDeadlineMs = 900_000;
const minuteMs = 60_000;
const hourMs = 3_600_000;
const dayMs = 86_400_000;
const liveTickIntervalMs = 1_000;
const copyFeedbackMs = 1_500;

const routes = {
  session: "/session",
  resumeSession: "/session/resume",
  workflow: "/api/workflow",
  runs: "/api/runs",
  run: (runId: string): string => `/api/runs/${encodeURIComponent(runId)}`,
  output: (runId: string, ordinal: number, stream: OutputStream): string =>
    `/api/runs/${encodeURIComponent(runId)}/nodes/${String(ordinal)}/output/${stream}`,
  decision: (runId: string, nodeId: string): string =>
    `/api/runs/${encodeURIComponent(runId)}/nodes/${encodeURIComponent(nodeId)}/decision`,
} as const;

type ViewMode = "current" | "run";

type EvidenceView = "rendered" | "raw";

interface OutputSelection {
  readonly key: string;
  readonly response: BoundedOutputResponse;
  readonly fetchedWhileRunning: boolean;
}

interface ViewerState {
  session: SessionBootstrapResponse | undefined;
  currentWorkflow: CurrentWorkflowResponse | undefined;
  runList: ScopedRunListResponse | undefined;
  runDetail: ScopedRunDetailResponse | undefined;
  viewMode: ViewMode;
  selectedRunId: string | undefined;
  selectedNodeId: string | undefined;
  selectedExecutionId: string | undefined;
  selectedOutputStream: OutputStream;
  evidenceView: EvidenceView;
  graphExpanded: boolean;
  followTail: boolean;
  output: OutputSelection | undefined;
  outputError: string | undefined;
  outputLoading: boolean;
  decisionNoteDraft: string;
  decisionSubmitting: boolean;
  decisionError: string | undefined;
  pollFailures: number;
}

const state: ViewerState = {
  session: undefined,
  currentWorkflow: undefined,
  runList: undefined,
  runDetail: undefined,
  viewMode: "current",
  selectedRunId: undefined,
  selectedNodeId: undefined,
  selectedExecutionId: undefined,
  selectedOutputStream: "result",
  evidenceView: "rendered",
  graphExpanded: false,
  followTail: true,
  output: undefined,
  outputError: undefined,
  outputLoading: false,
  decisionNoteDraft: "",
  decisionSubmitting: false,
  decisionError: undefined,
  pollFailures: 0,
};

type ElementConstructor<ElementType extends Element> = abstract new () => ElementType;

const requiredElement = <ElementType extends Element>(
  selector: string,
  constructor: ElementConstructor<ElementType>,
): ElementType => {
  const element = document.querySelector(selector);
  if (element === null) {
    throw new Error(
      `The Viewer could not load because "${selector}" is missing. This is a defect in Kilin. Report it at https://github.com/kilin-space/kilin/issues.`,
    );
  }
  if (!(element instanceof constructor)) {
    throw new Error(
      `The Viewer could not load because "${selector}" did not resolve to the expected element type. This is a defect in Kilin. Report it at https://github.com/kilin-space/kilin/issues.`,
    );
  }
  return element;
};

const elements = {
  approvalStatus: requiredElement("#approval-status", HTMLElement),
  appShell: requiredElement("#app-shell", HTMLElement),
  appTitle: requiredElement("#app-title", HTMLElement),
  connectionStatus: requiredElement("#connection-status", HTMLElement),
  currentWorkflowButton: requiredElement("#current-workflow-button", HTMLButtonElement),
  diagnostics: requiredElement("#diagnostics", HTMLElement),
  decisionDock: requiredElement("#decision-dock", HTMLElement),
  decisionNeededBanner: requiredElement("#decision-needed-banner", HTMLButtonElement),
  evidenceBanner: requiredElement("#evidence-banner", HTMLElement),
  evidencePlaceholder: requiredElement("#evidence-placeholder", HTMLElement),
  evidenceViewRaw: requiredElement("#evidence-view-raw", HTMLButtonElement),
  evidenceViewRendered: requiredElement("#evidence-view-rendered", HTMLButtonElement),
  executionList: requiredElement("#execution-list", HTMLOListElement),
  fatalError: requiredElement("#fatal-error", HTMLElement),
  fatalErrorMessage: requiredElement("#fatal-error-message", HTMLElement),
  graph: requiredElement("#workflow-graph", SVGSVGElement),
  graphContext: requiredElement("#graph-context", HTMLElement),
  graphExpandToggle: requiredElement("#graph-expand-toggle", HTMLButtonElement),
  graphHeading: requiredElement("#graph-heading", HTMLElement),
  graphStatus: requiredElement("#graph-status", HTMLElement),
  graphStrip: requiredElement("#graph-strip", HTMLElement),
  historyCount: requiredElement("#history-count", HTMLElement),
  historyEmpty: requiredElement("#history-empty", HTMLElement),
  historyList: requiredElement("#history-list", HTMLOListElement),
  inspectorHeading: requiredElement("#inspector-heading", HTMLElement),
  lineageList: requiredElement("#lineage-list", HTMLOListElement),
  lineageSection: requiredElement("#lineage-section", HTMLElement),
  loopIterationsList: requiredElement("#loop-iterations-list", HTMLElement),
  loopIterationsSection: requiredElement("#loop-iterations-section", HTMLElement),
  nodeInspector: requiredElement("#node-inspector", HTMLElement),
  outputMeta: requiredElement("#output-meta", HTMLElement),
  outputPanel: requiredElement("#output-panel", HTMLElement),
  outputSection: requiredElement("#output-section", HTMLElement),
  outputTabs: requiredElement("#output-tabs", HTMLElement),
  refreshButton: requiredElement("#refresh-button", HTMLButtonElement),
  runInspector: requiredElement("#run-inspector", HTMLElement),
  selectionAnnouncement: requiredElement("#selection-announcement", HTMLElement),
};

interface HashRunSelection {
  readonly runId: string;
  readonly nodeId?: string;
  readonly stream?: OutputStream;
  readonly view?: EvidenceView;
}

type HashSelection =
  { readonly kind: "definition" } | ({ readonly kind: "run" } & HashRunSelection);

let pollTimer: number | undefined;
let pollController: AbortController | undefined;
let pollInProgress = false;
let runDetailRequestGeneration = 0;
let outputRequestGeneration = 0;
let initialSelectionPending = true;
type RenderedEvidence =
  | {
      readonly kind: "stream";
      readonly key: string;
      readonly view: EvidenceView;
      readonly text: string;
    }
  | { readonly kind: "failure"; readonly key: string; readonly message: string };

let renderedEvidence: RenderedEvidence | undefined;

type ViewerFocusTarget =
  | { readonly type: "current-workflow" }
  | { readonly type: "history"; readonly runId: string }
  | { readonly type: "history-copy"; readonly runId: string }
  | { readonly type: "graph"; readonly cardKey: string }
  | { readonly type: "lineage"; readonly runId: string }
  | { readonly type: "loop-execution"; readonly executionId: string }
  | { readonly type: "output"; readonly stream: OutputStream }
  | { readonly type: "evidence-view"; readonly view: EvidenceView }
  | { readonly type: "evidence-retry" }
  | {
      readonly type: "decision-note";
      readonly selectionStart: number;
      readonly selectionEnd: number;
      readonly selectionDirection: HTMLTextAreaElement["selectionDirection"];
    }
  | { readonly type: "decision-action"; readonly decision: ViewerApprovalDecision }
  | { readonly type: "command-copy"; readonly command: string }
  | { readonly type: "decision-needed"; readonly runId: string; readonly graphNodeId: string };

class ViewerRequestError extends Error {
  public constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "ViewerRequestError";
  }
}

const setText = (element: Element, text: string): void => {
  element.textContent = text;
};

const focusedAttribute = (
  element: Element | null,
  className: string,
  attribute: string,
): string | undefined => {
  if (element?.classList.contains(className) !== true) {
    return undefined;
  }
  return element.getAttribute(attribute) ?? undefined;
};

/** Identifies a graph card: a top-level node id, or `loopNodeId/bodyNodeId` for a loop body card. */
const composeCardKey = (loopNodeId: string, bodyNodeId: string): string =>
  `${loopNodeId}/${bodyNodeId}`;

const containerCardKey = (cardKey: string): string => cardKey.split("/")[0] ?? cardKey;

const graphCardKey = (card: Element): string => {
  const bodyNodeId = card.getAttribute("data-body-node-id");
  if (bodyNodeId === null) {
    return card.getAttribute("data-node-id") ?? "";
  }
  return composeCardKey(card.getAttribute("data-loop-node-id") ?? "", bodyNodeId);
};

const graphCards = (): SVGGElement[] =>
  Array.from(elements.graph.querySelectorAll<SVGGElement>(".dag-node"));

const graphCardIndex = (cards: readonly SVGGElement[], cardKey: string | undefined): number =>
  cards.findIndex((card) => graphCardKey(card) === cardKey);

const setRovingTabIndex = (cards: readonly SVGGElement[], focusedIndex: number): void => {
  for (const [index, card] of cards.entries()) {
    card.setAttribute("tabindex", index === focusedIndex ? "0" : "-1");
  }
};

const captureViewerFocus = (): ViewerFocusTarget | undefined => {
  const activeElement = document.activeElement;
  if (activeElement === elements.currentWorkflowButton) {
    return { type: "current-workflow" };
  }
  if (activeElement === elements.decisionNeededBanner) {
    const runId = elements.decisionNeededBanner.getAttribute("data-run-id");
    const graphNodeId = elements.decisionNeededBanner.getAttribute("data-graph-node-id");
    if (runId !== null && graphNodeId !== null) {
      return { type: "decision-needed", runId, graphNodeId };
    }
    return undefined;
  }
  const historyRunId = focusedAttribute(activeElement, "history-button", "data-run-id");
  if (historyRunId !== undefined) {
    return { type: "history", runId: historyRunId };
  }
  const copiedRunId = focusedAttribute(activeElement, "copy-run-id", "data-run-id");
  if (copiedRunId !== undefined) {
    return { type: "history-copy", runId: copiedRunId };
  }
  if (activeElement?.classList.contains("dag-node") === true) {
    return { type: "graph", cardKey: graphCardKey(activeElement) };
  }
  const lineageRunId = focusedAttribute(activeElement, "lineage-button", "data-run-id");
  if (lineageRunId !== undefined) {
    return { type: "lineage", runId: lineageRunId };
  }
  const loopExecutionId = focusedAttribute(
    activeElement,
    "loop-execution-button",
    "data-execution-id",
  );
  if (loopExecutionId !== undefined) {
    return { type: "loop-execution", executionId: loopExecutionId };
  }
  const outputStream = focusedAttribute(activeElement, "output-tab", "data-output-stream");
  if (isOutputStream(outputStream)) {
    return { type: "output", stream: outputStream };
  }
  if (activeElement === elements.evidenceViewRendered) {
    return { type: "evidence-view", view: "rendered" };
  }
  if (activeElement === elements.evidenceViewRaw) {
    return { type: "evidence-view", view: "raw" };
  }
  if (activeElement?.classList.contains("evidence-retry") === true) {
    return { type: "evidence-retry" };
  }
  if (activeElement instanceof HTMLTextAreaElement && activeElement.id === "decision-note") {
    return {
      type: "decision-note",
      selectionStart: activeElement.selectionStart,
      selectionEnd: activeElement.selectionEnd,
      selectionDirection: activeElement.selectionDirection,
    };
  }
  if (activeElement instanceof HTMLElement && activeElement.id === "decision-approve") {
    return { type: "decision-action", decision: "approved" };
  }
  if (activeElement instanceof HTMLElement && activeElement.id === "decision-reject") {
    return { type: "decision-action", decision: "rejected" };
  }
  const copyCommand = focusedAttribute(activeElement, "copy-button", "data-copy-command");
  if (copyCommand !== undefined) {
    return { type: "command-copy", command: copyCommand };
  }
  return undefined;
};

const matchingElement = (
  parent: ParentNode,
  selector: string,
  attribute: string,
  value: string,
): Element | undefined =>
  Array.from(parent.querySelectorAll(selector)).find(
    (element) => element.getAttribute(attribute) === value,
  );

const restoreViewerFocus = (target: ViewerFocusTarget | undefined): void => {
  if (target === undefined) {
    return;
  }
  if (target.type === "current-workflow") {
    elements.currentWorkflowButton.focus();
    return;
  }
  if (target.type === "history") {
    const button = matchingElement(
      elements.historyList,
      ".history-button",
      "data-run-id",
      target.runId,
    );
    if (button instanceof HTMLButtonElement) {
      button.focus();
    }
    return;
  }
  if (target.type === "history-copy") {
    const button = matchingElement(
      elements.historyList,
      ".copy-run-id",
      "data-run-id",
      target.runId,
    );
    if (button instanceof HTMLButtonElement) {
      button.focus();
    }
    return;
  }
  if (target.type === "graph") {
    const cards = graphCards();
    const index = graphCardIndex(cards, target.cardKey);
    const fallbackIndex =
      index >= 0 ? index : graphCardIndex(cards, containerCardKey(target.cardKey));
    if (fallbackIndex >= 0) {
      updateGraphRovingFocus(cards, fallbackIndex);
    }
    return;
  }
  if (target.type === "lineage") {
    const buttons = Array.from(
      elements.lineageList.querySelectorAll<HTMLButtonElement>(".lineage-button"),
    );
    const button = buttons.find(
      (candidate) => candidate.getAttribute("data-run-id") === target.runId,
    );
    if (button !== undefined) {
      for (const candidate of buttons) {
        candidate.setAttribute("tabindex", candidate === button ? "0" : "-1");
      }
      button.focus();
    }
    return;
  }
  if (target.type === "loop-execution") {
    const button = matchingElement(
      elements.loopIterationsList,
      ".loop-execution-button",
      "data-execution-id",
      target.executionId,
    );
    if (button instanceof HTMLButtonElement) {
      button.focus();
    }
    return;
  }
  if (target.type === "output") {
    const tabs = Array.from(elements.outputTabs.querySelectorAll<HTMLButtonElement>(".output-tab"));
    const tab = tabs.find(
      (candidate) => candidate.getAttribute("data-output-stream") === target.stream,
    );
    if (tab !== undefined) {
      for (const candidate of tabs) {
        candidate.setAttribute("tabindex", candidate === tab ? "0" : "-1");
      }
      tab.focus();
    }
    return;
  }
  if (target.type === "evidence-view") {
    const toggle = target.view === "raw" ? elements.evidenceViewRaw : elements.evidenceViewRendered;
    if (!toggle.disabled) {
      toggle.focus();
    }
    return;
  }
  if (target.type === "evidence-retry") {
    const retry = elements.outputPanel.querySelector<HTMLButtonElement>(".evidence-retry");
    (retry ?? elements.outputPanel).focus();
    return;
  }
  if (target.type === "decision-note") {
    const note = elements.decisionDock.querySelector<HTMLTextAreaElement>("#decision-note");
    if (note !== null) {
      note.focus();
      note.setSelectionRange(target.selectionStart, target.selectionEnd, target.selectionDirection);
    }
    return;
  }
  if (target.type === "decision-action") {
    const identifier = target.decision === "approved" ? "#decision-approve" : "#decision-reject";
    elements.decisionDock.querySelector<HTMLButtonElement>(identifier)?.focus();
    return;
  }
  if (target.type === "decision-needed") {
    if (!elements.decisionNeededBanner.hidden) {
      elements.decisionNeededBanner.focus();
      return;
    }
    if (state.viewMode === "run" && state.selectedRunId === target.runId) {
      const cards = graphCards();
      const index = cards.findIndex(
        (card) => card.getAttribute("data-node-id") === target.graphNodeId,
      );
      if (index >= 0) {
        updateGraphRovingFocus(cards, index);
        return;
      }
    }
    const button = matchingElement(
      elements.historyList,
      ".history-button",
      "data-run-id",
      target.runId,
    );
    if (button instanceof HTMLButtonElement) {
      button.focus();
      return;
    }
    elements.currentWorkflowButton.focus();
    return;
  }
  const copyButton = matchingElement(document, ".copy-button", "data-copy-command", target.command);
  if (copyButton instanceof HTMLButtonElement) {
    copyButton.focus();
  }
};

const formatTimestamp = (timestamp: string): string =>
  new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(timestamp));

const formatElapsed = (elapsedMs: number): string => {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1_000));
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes === 0) {
    return `${String(seconds)}s`;
  }
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);
  if (hours === 0) {
    return `${String(minutes)}m ${String(seconds).padStart(2, "0")}s`;
  }
  return `${String(hours)}h ${String(minutes).padStart(2, "0")}m`;
};

const formatDuration = (durationMs: number | undefined): string => {
  if (durationMs === undefined) {
    return "In progress";
  }
  if (durationMs < 1_000) {
    return `${String(durationMs)} ms`;
  }
  if (durationMs < minuteMs) {
    return `${String(Math.round(durationMs / 100) / 10)} s`;
  }
  return formatElapsed(durationMs);
};

const formatRelativeTime = (timestamp: string, now: number): string => {
  const elapsedMs = now - Date.parse(timestamp);
  if (elapsedMs < minuteMs) {
    return "just now";
  }
  if (elapsedMs < hourMs) {
    return `${String(Math.floor(elapsedMs / minuteMs))} min ago`;
  }
  if (elapsedMs < dayMs) {
    return `${String(Math.floor(elapsedMs / hourMs))} hr ago`;
  }
  const days = Math.floor(elapsedMs / dayMs);
  return `${String(days)} day${days === 1 ? "" : "s"} ago`;
};

interface DeadlineCopy {
  readonly text: string;
  readonly urgent: boolean;
}

const deadlineCopy = (deadlineAt: string, now: number): DeadlineCopy => {
  const absolute = formatTimestamp(deadlineAt);
  const remainingMs = Date.parse(deadlineAt) - now;
  if (Number.isNaN(remainingMs)) {
    return { text: absolute, urgent: false };
  }
  if (remainingMs <= 0) {
    return { text: `${absolute} · overdue by ${formatElapsed(-remainingMs)}`, urgent: true };
  }
  return {
    text: `${absolute} · ${formatElapsed(remainingMs)} left`,
    urgent: remainingMs <= urgentDeadlineMs,
  };
};

const updateLiveElements = (): void => {
  const now = Date.now();
  for (const element of Array.from(document.querySelectorAll<HTMLElement>("[data-live-elapsed]"))) {
    const startedAt = element.dataset.liveElapsed;
    if (startedAt === undefined) {
      continue;
    }
    const startedMs = Date.parse(startedAt);
    setText(element, Number.isNaN(startedMs) ? "In progress" : formatElapsed(now - startedMs));
  }
  for (const element of Array.from(
    document.querySelectorAll<HTMLElement>("[data-live-relative]"),
  )) {
    const timestamp = element.dataset.liveRelative;
    if (timestamp === undefined) {
      continue;
    }
    setText(element, formatRelativeTime(timestamp, now));
  }
  for (const element of Array.from(
    document.querySelectorAll<HTMLElement>("[data-live-deadline]"),
  )) {
    const deadlineAt = element.dataset.liveDeadline;
    if (deadlineAt === undefined) {
      continue;
    }
    const label = element.dataset.liveDeadlineLabel;
    const { text, urgent } = deadlineCopy(deadlineAt, now);
    setText(element, label === undefined ? text : `${label} ${text}`);
    element.classList.toggle("urgent", urgent);
  }
};

const formatBytes = (bytes: number): string => {
  if (bytes < 1_024) {
    return `${String(bytes)} B`;
  }
  return `${String(Math.round((bytes / 1_024) * 10) / 10)} KiB`;
};

const shortId = (id: string): string => (id.length > 14 ? `${id.slice(0, 12)}…` : id);

const formatStatus = (status: string): string => status.replaceAll("_", " ");

interface StatusPresentation {
  readonly glyph: string;
  readonly label: string;
}

const statusPresentations: Readonly<Record<string, StatusPresentation>> = {
  pending: { glyph: "◌", label: "Pending" },
  running: { glyph: "◐", label: "Running" },
  waiting_for_approval: { glyph: "◇", label: "Waiting for approval" },
  succeeded: { glyph: "✓", label: "Succeeded" },
  failed: { glyph: "✕", label: "Failed" },
  cancelled: { glyph: "⊘", label: "Cancelled" },
  interrupted: { glyph: "⚠", label: "Interrupted" },
  skipped: { glyph: "▹", label: "Skipped" },
};

const statusGlyph = (status: string): string => statusPresentations[status]?.glyph ?? "";

const statusLabel = (status: string): string =>
  statusPresentations[status]?.label ?? formatStatus(status);

const statusGlyphElement = (status: string): HTMLSpanElement => {
  const element = document.createElement("span");
  element.className = `status-glyph ${status}`;
  element.setAttribute("aria-hidden", "true");
  setText(element, statusGlyph(status));
  return element;
};

const renderStatusChip = (element: HTMLElement, status: string, label: string): void => {
  element.className = `status-chip ${status}`;
  if (statusGlyph(status) === "") {
    setText(element, label);
    return;
  }
  element.replaceChildren(statusGlyphElement(status), document.createTextNode(label));
};

const definitionLabel = (definitionState: CurrentWorkflowResponse["state"] | ""): string => {
  if (definitionState === "") {
    return "Loading";
  }
  return definitionState === "valid" ? "Definition valid" : "Definition invalid";
};

const relationLabel = (run: RunSummaryDto): string => {
  if (run.recoveryMode === "resume") {
    return "resumed";
  }
  if (run.recoveryMode === "retry") {
    return "retried";
  }
  return run.rerunOfRunId === undefined ? "origin" : "rerun";
};

const responseErrorMessage = async (response: Response): Promise<string> => {
  try {
    const payload: unknown = await response.json();
    const errorResponse = payload as ViewerApiErrorResponse;
    if (typeof errorResponse.error.message === "string") {
      return errorResponse.error.message;
    }
  } catch {
    return `The viewer request failed with HTTP ${String(response.status)}. Restart Kilin UI and try again.`;
  }
  return `The viewer request failed with HTTP ${String(response.status)}. Restart Kilin UI and try again.`;
};

const readJson = async <ResponseType>(response: Response): Promise<ResponseType> => {
  if (!response.ok) {
    throw new ViewerRequestError(await responseErrorMessage(response), response.status);
  }
  return (await response.json()) as ResponseType;
};

const postSession = async (
  route: string,
  body: Readonly<Record<string, string>>,
): Promise<SessionBootstrapResponse> => {
  const response = await fetch(route, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return readJson<SessionBootstrapResponse>(response);
};

const apiGet = async <ResponseType>(route: string, signal?: AbortSignal): Promise<ResponseType> => {
  const csrfToken = state.session?.csrfToken;
  if (csrfToken === undefined) {
    throw new Error("The viewer is not ready. Restart Kilin UI and try again.");
  }
  const request: RequestInit = {
    method: "GET",
    credentials: "same-origin",
    headers: { "X-Kilin-CSRF": csrfToken },
  };
  if (signal !== undefined) {
    request.signal = signal;
  }
  const response = await fetch(route, request);
  return readJson<ResponseType>(response);
};

const apiPost = async <ResponseType>(route: string, body: unknown): Promise<ResponseType> => {
  const csrfToken = state.session?.csrfToken;
  if (csrfToken === undefined) {
    throw new Error("The viewer is not ready. Restart Kilin UI and try again.");
  }
  const response = await fetch(route, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", "X-Kilin-CSRF": csrfToken },
    body: JSON.stringify(body),
  });
  return readJson<ResponseType>(response);
};

const appendProperty = (list: HTMLDListElement, label: string, value: string): void => {
  const term = document.createElement("dt");
  const description = document.createElement("dd");
  setText(term, label);
  setText(description, value);
  list.append(term, description);
};

const createPropertyList = (): HTMLDListElement => {
  const list = document.createElement("dl");
  list.className = "property-list";
  return list;
};

const appendLiveProperty = (
  list: HTMLDListElement,
  label: string,
  dataset: Readonly<Record<string, string>>,
): void => {
  const term = document.createElement("dt");
  setText(term, label);
  const description = document.createElement("dd");
  for (const [key, value] of Object.entries(dataset)) {
    description.dataset[key] = value;
  }
  list.append(term, description);
};

const appendDurationProperty = (
  list: HTMLDListElement,
  durationMs: number | undefined,
  startedAt: string | undefined,
  finishedAt: string | undefined,
): void => {
  if (durationMs === undefined && startedAt !== undefined && finishedAt === undefined) {
    appendLiveProperty(list, "Elapsed", { liveElapsed: startedAt });
    return;
  }
  appendProperty(list, "Duration", formatDuration(durationMs));
};

const appendFailure = (container: HTMLElement, failure: ViewerFailureDto | undefined): void => {
  if (failure === undefined) {
    return;
  }
  const message = document.createElement("p");
  message.className = "failure-copy";
  setText(message, `${failure.code}: ${failure.message}`);
  container.append(message);
};

const sameFailure = (
  left: ViewerFailureDto | undefined,
  right: ViewerFailureDto | undefined,
): boolean =>
  left !== undefined &&
  right !== undefined &&
  left.code === right.code &&
  left.message === right.message &&
  left.path === right.path;

const currentGraph = (): WorkflowGraphDto | undefined => {
  if (state.viewMode === "run") {
    return state.runDetail?.revision.workflow;
  }
  return state.currentWorkflow?.state === "valid" ? state.currentWorkflow.workflow : undefined;
};

const currentNodeRuns = (): ReadonlyMap<string, NodeRunDto> =>
  new Map(
    state.runDetail?.nodes
      .filter(({ loopNodeId }) => loopNodeId === undefined)
      .map((node) => [node.nodeId, node]) ?? [],
  );

const selectedWorkflowNode = (): WorkflowNodeDto | undefined => {
  const graph = currentGraph();
  if (graph === undefined) {
    return undefined;
  }
  const nodeRun = selectedNodeRun();
  if (nodeRun?.loopNodeId !== undefined) {
    const loop = graph.nodes.find((node) => node.kind === "loop" && node.id === nodeRun.loopNodeId);
    return loop?.kind === "loop"
      ? loop.body.nodes.find((node) => node.id === nodeRun.nodeId)
      : undefined;
  }
  return graph.nodes.find((node) => node.id === state.selectedNodeId);
};

const selectedNodeRun = (): NodeRunDto | undefined => {
  if (state.viewMode !== "run") {
    return undefined;
  }
  return state.runDetail?.nodes.find(
    (node) => node.executionId === (state.selectedExecutionId ?? state.selectedNodeId),
  );
};

const selectedGraphCardKey = (): string | undefined => {
  const nodeRun = selectedNodeRun();
  if (nodeRun?.loopNodeId === undefined) {
    return state.selectedNodeId;
  }
  return composeCardKey(nodeRun.loopNodeId, nodeRun.nodeId);
};

const ensureNodeSelection = (): void => {
  const graph = currentGraph();
  if (graph === undefined || graph.nodes.length === 0) {
    state.selectedNodeId = undefined;
    state.selectedExecutionId = undefined;
    return;
  }
  const orderedNodes = graph.executionOrder
    .map((nodeId) => graph.nodes.find((node) => node.id === nodeId))
    .filter((node): node is WorkflowNodeDto => node !== undefined);
  if (!orderedNodes.some((node) => node.id === state.selectedNodeId)) {
    state.selectedNodeId = orderedNodes[0]?.id;
    state.selectedExecutionId = state.selectedNodeId;
  }
};

const historyCountCopy = (runs: readonly RunSummaryDto[] | undefined): string => {
  if (runs === undefined) {
    return "Loading";
  }
  if (runs.length === 0) {
    return "No runs";
  }
  if (runs.length >= maximumHistoryRuns) {
    return `Newest ${String(runs.length)} runs`;
  }
  return `${String(runs.length)} run${runs.length === 1 ? "" : "s"}`;
};

const copyRunIdButton = (runId: string): HTMLButtonElement => {
  const button = document.createElement("button");
  const idle = (): void => {
    button.setAttribute("aria-label", `Copy run id ${runId}`);
    setText(button, "⧉");
  };
  button.type = "button";
  button.className = "copy-run-id";
  button.setAttribute("data-run-id", runId);
  idle();
  button.addEventListener("click", () => {
    navigator.clipboard.writeText(runId).then(
      () => {
        button.setAttribute("aria-label", `Copied run id ${runId}`);
        setText(button, "✓");
        window.setTimeout(idle, copyFeedbackMs);
      },
      () => {
        button.setAttribute("aria-label", `Run id ${runId} could not be copied`);
        setText(button, "✕");
      },
    );
  });
  return button;
};

const appendHistoryDuration = (row: HTMLElement, run: RunSummaryDto): void => {
  if (run.durationMs !== undefined) {
    row.append(document.createTextNode(` · ${formatDuration(run.durationMs)}`));
    return;
  }
  if (run.status !== "running") {
    return;
  }
  row.append(document.createTextNode(" · "));
  const elapsed = document.createElement("span");
  elapsed.dataset.liveElapsed = run.startedAt;
  row.append(elapsed);
};

const presentedRunStatus = (run: Pick<RunSummaryDto, "status" | "waitingForApproval">): string =>
  run.status === "running" && run.waitingForApproval === true ? "waiting_for_approval" : run.status;

const renderHistory = (): void => {
  elements.historyList.replaceChildren();
  const runs = state.runList?.runs ?? [];
  elements.historyEmpty.hidden = runs.length !== 0;
  setText(elements.historyCount, historyCountCopy(state.runList?.runs));
  for (const run of runs) {
    const presentedStatus = presentedRunStatus(run);
    const item = document.createElement("li");
    item.className = "history-item";
    const button = document.createElement("button");
    button.className = "history-button";
    button.type = "button";
    button.setAttribute("data-run-id", run.runId);
    button.setAttribute(
      "aria-label",
      `Run ${run.runId}, ${formatStatus(presentedStatus)}, ${run.workflowId}, started ${formatTimestamp(run.startedAt)}`,
    );
    button.setAttribute(
      "aria-current",
      String(state.viewMode === "run" && state.selectedRunId === run.runId),
    );
    button.addEventListener("click", () => {
      void selectRun(run.runId);
    });

    const copy = document.createElement("span");
    const workflow = document.createElement("span");
    workflow.className = "history-workflow";
    setText(workflow, run.workflowId);
    const statusRow = document.createElement("span");
    statusRow.className = "history-meta";
    setText(statusRow, statusLabel(presentedStatus));
    appendHistoryDuration(statusRow, run);
    const startedRow = document.createElement("span");
    startedRow.className = "history-meta";
    const started = document.createElement("span");
    started.dataset.liveRelative = run.startedAt;
    started.title = formatTimestamp(run.startedAt);
    startedRow.append(started, document.createTextNode(` · ${relationLabel(run)}`));
    const runId = document.createElement("span");
    runId.className = "history-run-id";
    setText(runId, shortId(run.runId));
    copy.append(workflow, statusRow, startedRow, runId);
    button.append(statusGlyphElement(presentedStatus), copy);
    item.append(button, copyRunIdButton(run.runId));
    elements.historyList.append(item);
  }
  elements.currentWorkflowButton.setAttribute("aria-pressed", String(state.viewMode === "current"));
};

const renderDiagnostics = (): void => {
  elements.diagnostics.replaceChildren();
  if (state.viewMode !== "current" || state.currentWorkflow?.state !== "invalid") {
    return;
  }
  for (const diagnostic of state.currentWorkflow.diagnostics) {
    const item = document.createElement("p");
    item.className = "diagnostic";
    const message = document.createElement("span");
    setText(message, `${diagnostic.code}: ${diagnostic.message}`);
    item.append(message);
    if (diagnostic.path !== undefined) {
      const path = document.createElement("span");
      path.className = "diagnostic-path";
      setText(path, ` · ${diagnostic.path}`);
      item.append(path);
    }
    elements.diagnostics.append(item);
  }
};

interface GraphPosition {
  readonly x: number;
  readonly y: number;
}

const cardWidth = 170;
const cardHeight = 62;
const cardRankGap = 60;
const cardLaneGap = 34;
const surfacePadding = 26;
const loopStackRise = 8;
const loopStackInset = 10;
const loopStackHeight = 16;
const bodyCardWidth = 148;
const bodyCardHeight = 46;
const bodyRankGap = 42;
const bodyLaneGap = 20;
const containerPadLeft = 14;
const containerPadRight = 48;
const containerHeaderHeight = 58;
const containerFeedbackLane = 34;
const containerPadBottom = 12;
const surfaceInset = 8;
const surfaceRise = 10;

interface CardSize {
  readonly width: number;
  readonly height: number;
}

interface RankedLayout extends CardSize {
  readonly positions: ReadonlyMap<string, GraphPosition>;
}

interface GraphCardLayout extends CardSize {
  readonly position: GraphPosition;
  /** Where an outgoing edge leaves the card, relative to its top edge. */
  readonly exitY: number;
  readonly body?: RankedLayout;
}

interface LayoutNode {
  readonly id: string;
  readonly dependencies: readonly string[];
}

const rankedLayout = (
  nodes: readonly LayoutNode[],
  sizeOf: (node: LayoutNode) => CardSize,
  gaps: { readonly rank: number; readonly lane: number },
  origin: GraphPosition,
): RankedLayout => {
  const ranks = new Map<string, number>();
  const rankOf = (node: LayoutNode): number =>
    node.dependencies.length === 0
      ? 0
      : Math.max(...node.dependencies.map((dependency) => ranks.get(dependency) ?? 0)) + 1;
  let settled = false;
  let remainingPasses = nodes.length;
  while (!settled && remainingPasses > 0) {
    settled = true;
    remainingPasses -= 1;
    for (const node of nodes) {
      const rank = rankOf(node);
      if (rank !== ranks.get(node.id)) {
        ranks.set(node.id, rank);
        settled = false;
      }
    }
  }
  const columnWidths = new Map<number, number>();
  for (const node of nodes) {
    const rank = ranks.get(node.id) ?? 0;
    columnWidths.set(rank, Math.max(columnWidths.get(rank) ?? 0, sizeOf(node).width));
  }
  const columnOffsets = new Map<number, number>();
  let columnOffset = 0;
  for (const rank of Array.from(columnWidths.keys()).sort((left, right) => left - right)) {
    columnOffsets.set(rank, columnOffset);
    columnOffset += (columnWidths.get(rank) ?? 0) + gaps.rank;
  }
  const laneOffsets = new Map<number, number>();
  const positions = new Map<string, GraphPosition>();
  let width = 0;
  let height = 0;
  for (const node of nodes) {
    const rank = ranks.get(node.id) ?? 0;
    const column = columnOffsets.get(rank) ?? 0;
    const lane = laneOffsets.get(rank) ?? 0;
    const size = sizeOf(node);
    positions.set(node.id, { x: origin.x + column, y: origin.y + lane });
    laneOffsets.set(rank, lane + size.height + gaps.lane);
    width = Math.max(width, origin.x + column + size.width);
    height = Math.max(height, origin.y + lane + size.height);
  }
  return { positions, width, height };
};

const orderedGraphNodes = (graph: WorkflowGraphDto): readonly WorkflowNodeDto[] => {
  const nodesById = new Map(graph.nodes.map((node) => [node.id, node] as const));
  return graph.executionOrder
    .map((nodeId) => nodesById.get(nodeId))
    .filter((node): node is WorkflowNodeDto => node !== undefined);
};

const loopBodyLayout = (loop: LoopWorkflowNodeDto): RankedLayout =>
  rankedLayout(
    loop.body.nodes,
    () => ({ width: bodyCardWidth, height: bodyCardHeight }),
    { rank: bodyRankGap, lane: bodyLaneGap },
    { x: containerPadLeft, y: containerHeaderHeight },
  );

const containerSize = (body: RankedLayout): CardSize => ({
  width: body.width + containerPadRight,
  height: body.height + containerFeedbackLane + containerPadBottom,
});

const graphLayout = (
  graph: WorkflowGraphDto,
  expandedLoopId: string | undefined,
): {
  readonly cards: ReadonlyMap<string, GraphCardLayout>;
  readonly width: number;
  readonly height: number;
} => {
  const nodes = orderedGraphNodes(graph);
  const expandedLoop = nodes.find(
    (node): node is LoopWorkflowNodeDto => node.kind === "loop" && node.id === expandedLoopId,
  );
  const expandedBody = expandedLoop === undefined ? undefined : loopBodyLayout(expandedLoop);
  const sizeOf = (node: LayoutNode): CardSize =>
    node.id === expandedLoopId && expandedBody !== undefined
      ? containerSize(expandedBody)
      : { width: cardWidth, height: cardHeight };
  const ranked = rankedLayout(
    nodes,
    sizeOf,
    { rank: cardRankGap, lane: cardLaneGap },
    { x: surfacePadding, y: surfacePadding },
  );
  const cards = new Map<string, GraphCardLayout>();
  for (const node of nodes) {
    const position = ranked.positions.get(node.id);
    if (position === undefined) {
      continue;
    }
    const size = sizeOf(node);
    const body = node.id === expandedLoopId ? expandedBody : undefined;
    const decision = node.kind === "loop" ? body?.positions.get(node.decision.nodeId) : undefined;
    cards.set(node.id, {
      position,
      ...size,
      exitY: decision === undefined ? size.height / 2 : decision.y + bodyCardHeight / 2,
      ...(body === undefined ? {} : { body }),
    });
  }
  return {
    cards,
    width: Math.max(320, ranked.width + surfacePadding),
    height: ranked.height + surfacePadding,
  };
};

const sizeGraphSurface = (width: number, height: number): void => {
  elements.graph.setAttribute("viewBox", `0 0 ${String(width)} ${String(height)}`);
  elements.graph.style.width = `${String(width)}px`;
  elements.graph.style.height = `${String(height)}px`;
};

const createSvgElement = <TagName extends keyof SVGElementTagNameMap>(
  name: TagName,
): SVGElementTagNameMap[TagName] => document.createElementNS(svgNamespace, name);

const nodeKindCopy = (node: WorkflowNodeDto): string => {
  if (node.kind === "agent") {
    return `${node.runtime} · ${node.access.replace("_", " ")}`;
  }
  if (node.kind === "approval") {
    return "approval";
  }
  return `loop · up to ${String(node.maxIterations)}`;
};

const dependencyCopy = (node: WorkflowNodeDto): string =>
  node.dependencies.length === 0 ? "starts first" : `after ${node.dependencies.join(", ")}`;

interface LoopIterationView {
  readonly iteration: number;
  readonly executions: ReadonlyMap<string, NodeRunDto>;
}

/**
 * Presentation counts iterations from one. The node inspector still reports the stored
 * zero-based `LoopIterationDto.iteration` beside the other occurrence provenance, because that is
 * the value `kilin runs show --json` returns.
 */
const iterationOrdinal = (iteration: number): number => iteration + 1;

const iterationHasStarted = (iteration: LoopIterationDto): boolean =>
  iteration.executions.some(({ status }) => status !== "pending" && status !== "skipped");

const currentLoopIteration = (loopNodeId: string): LoopIterationView | undefined => {
  const iterations = state.viewMode === "run" ? (state.runDetail?.loopIterations ?? []) : [];
  const started = iterations.filter(
    (iteration) => iteration.loopNodeId === loopNodeId && iterationHasStarted(iteration),
  );
  const shown =
    started.find((iteration) =>
      iteration.executions.some(({ executionId }) => executionId === state.selectedExecutionId),
    ) ??
    started.reduce<LoopIterationDto | undefined>(
      (highest, iteration) =>
        highest === undefined || iteration.iteration > highest.iteration ? iteration : highest,
      undefined,
    );
  if (shown === undefined) {
    return undefined;
  }
  return {
    iteration: shown.iteration,
    executions: new Map(shown.executions.map((execution) => [execution.nodeId, execution])),
  };
};

const renderExecutionList = (graph: WorkflowGraphDto | undefined): void => {
  elements.executionList.replaceChildren();
  if (graph === undefined) {
    return;
  }
  const nodeRuns = currentNodeRuns();
  for (const node of orderedGraphNodes(graph)) {
    const item = document.createElement("li");
    const status = nodeRuns.get(node.id)?.status;
    setText(
      item,
      `${String(node.ordinal + 1)}. ${node.id} · ${status === undefined ? dependencyCopy(node) : formatStatus(status)}`,
    );
    if (node.kind === "loop") {
      const iteration = currentLoopIteration(node.id);
      const bodyList = document.createElement("ol");
      for (const bodyNode of node.body.nodes) {
        const bodyItem = document.createElement("li");
        const bodyStatus = iteration?.executions.get(bodyNode.id)?.status;
        setText(
          bodyItem,
          `${bodyNode.id} · ${nodeKindCopy(bodyNode)} · ${bodyStatus === undefined ? dependencyCopy(bodyNode) : formatStatus(bodyStatus)}`,
        );
        bodyList.append(bodyItem);
      }
      item.append(bodyList);
    }
    elements.executionList.append(item);
  }
};

const isActiveIterationStatus = (status: string): boolean =>
  status === "pending" || status === "running" || status === "waiting_for_approval";

const renderLoopIterations = (): void => {
  const expansionByIteration = new Map<string, boolean>(
    Array.from(
      elements.loopIterationsList.querySelectorAll<HTMLDetailsElement>("details.loop-iteration"),
      (details) =>
        [
          `${details.dataset.loopNodeId ?? ""}:${details.dataset.iteration ?? ""}`,
          details.open,
        ] as const,
    ),
  );
  elements.loopIterationsList.replaceChildren();
  const graph = currentGraph();
  const iterations = state.viewMode === "run" ? (state.runDetail?.loopIterations ?? []) : [];
  const loops = (graph?.nodes ?? []).filter(
    (node): node is LoopWorkflowNodeDto => node.kind === "loop",
  );
  elements.loopIterationsSection.hidden = loops.length === 0;
  for (const loop of loops) {
    const scopedIterations = iterations.filter(({ loopNodeId }) => loopNodeId === loop.id);
    const group = document.createElement("section");
    group.className = "loop-iteration-group";
    group.setAttribute("aria-labelledby", `loop-iteration-group-${loop.id}`);
    const heading = document.createElement("h4");
    heading.id = `loop-iteration-group-${loop.id}`;
    setText(heading, loop.id);
    if (scopedIterations.length === 0) {
      const empty = document.createElement("p");
      empty.className = "empty-copy";
      setText(
        empty,
        `No iterations recorded yet. Body: ${loop.body.nodes.map(({ id }) => id).join(" → ")}.`,
      );
      group.append(heading, empty);
      elements.loopIterationsList.append(group);
      continue;
    }
    const iterationList = document.createElement("ol");
    iterationList.className = "loop-execution-list";
    for (const iteration of scopedIterations) {
      const iterationItem = document.createElement("li");
      iterationItem.className = "loop-iteration-item";
      const details = document.createElement("details");
      details.className = "loop-iteration";
      const expansionKey = `${loop.id}:${String(iteration.iteration)}`;
      details.open =
        expansionByIteration.get(expansionKey) ?? isActiveIterationStatus(iteration.status);
      details.setAttribute("data-loop-node-id", loop.id);
      details.setAttribute("data-iteration-status", iteration.status);
      details.setAttribute("data-iteration", String(iteration.iteration));
      const summary = document.createElement("summary");
      setText(
        summary,
        `Iteration ${String(iterationOrdinal(iteration.iteration))} · ${formatStatus(iteration.status)}`,
      );
      const executions = document.createElement("ol");
      executions.className = "loop-execution-list";
      for (const execution of iteration.executions) {
        const executionItem = document.createElement("li");
        const button = document.createElement("button");
        button.type = "button";
        button.className = "loop-execution-button";
        button.setAttribute("data-execution-id", execution.executionId);
        button.setAttribute(
          "aria-label",
          `${execution.nodeId}, loop ${iteration.loopNodeId}, iteration ${String(iterationOrdinal(iteration.iteration))}, execution ${execution.executionId}, ${formatStatus(execution.status)}`,
        );
        setText(button, `${execution.nodeId} · ${formatStatus(execution.status)}`);
        button.addEventListener("click", () => {
          selectLoopExecution(iteration.loopNodeId, execution.executionId, false);
        });
        const provenance = document.createElement("span");
        provenance.className = "loop-execution-provenance";
        setText(
          provenance,
          `executionId ${execution.executionId} · bodyNodeId ${execution.nodeId} · loopNodeId ${iteration.loopNodeId}`,
        );
        executionItem.append(button, provenance);
        executions.append(executionItem);
      }
      details.append(summary, executions);
      iterationItem.append(details);
      iterationList.append(iterationItem);
    }
    group.append(heading, iterationList);
    elements.loopIterationsList.append(group);
  }
};

const cubicEdgePath = (startX: number, startY: number, endX: number, endY: number): string => {
  const midpoint = (startX + endX) / 2;
  return `M ${String(startX)} ${String(startY)} C ${String(midpoint)} ${String(startY)}, ${String(midpoint)} ${String(endY)}, ${String(endX)} ${String(endY)}`;
};

/**
 * A back-edge that dips through the feedback lane. Both control points sit on `controlY`, so the
 * curve stays within its control hull however far apart the two cards are vertically.
 */
const feedbackEdgePath = (
  startX: number,
  startY: number,
  endX: number,
  endY: number,
  controlY: number,
): string =>
  `M ${String(startX)} ${String(startY)} C ${String(startX)} ${String(controlY)}, ${String(endX)} ${String(controlY)}, ${String(endX)} ${String(endY)}`;

const feedbackEdgeApexY = (startY: number, endY: number, controlY: number): number =>
  (startY + endY) / 8 + 0.75 * controlY;

const expandedLoopNodeId = (graph: WorkflowGraphDto): string | undefined => {
  const selected = graph.nodes.find((node) => node.id === state.selectedNodeId);
  return selected?.kind === "loop" ? selected.id : undefined;
};

const statusCardCopy = (status: string): string => `${statusGlyph(status)} ${statusLabel(status)}`;

interface GraphCardSummary {
  readonly meta: string;
  readonly aria: string;
}

const graphCardSummary = (
  node: WorkflowNodeDto,
  status: string | undefined,
  iteration: LoopIterationView | undefined,
): GraphCardSummary => {
  if (node.kind !== "loop") {
    return status === undefined
      ? { meta: nodeKindCopy(node), aria: nodeKindCopy(node) }
      : { meta: statusCardCopy(status), aria: formatStatus(status) };
  }
  const bound = String(node.maxIterations);
  if (status === undefined) {
    return { meta: nodeKindCopy(node), aria: `loop, up to ${bound} iterations` };
  }
  const shown = String(iteration === undefined ? 0 : iterationOrdinal(iteration.iteration));
  return {
    meta: `loop · ${shown}/${bound} · ${statusCardCopy(status)}`,
    aria: `loop, iteration ${shown} of ${bound}, ${formatStatus(status)}`,
  };
};

const activateGraphCard = (
  card: SVGGElement,
  cards: readonly SVGGElement[],
  activate: () => void,
): void => {
  card.addEventListener("click", activate);
  card.addEventListener("focus", () => {
    setRovingTabIndex(cards, cards.indexOf(card));
  });
  card.addEventListener("keydown", (event: KeyboardEvent) => {
    const position = cards.indexOf(card);
    let nextIndex: number | undefined;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      nextIndex = (position + 1) % cards.length;
    } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      nextIndex = (position - 1 + cards.length) % cards.length;
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = cards.length - 1;
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      activate();
      return;
    }
    if (nextIndex !== undefined) {
      event.preventDefault();
      updateGraphRovingFocus(cards, nextIndex);
    }
  });
};

const appendLoopBody = (
  container: SVGGElement,
  loop: LoopWorkflowNodeDto,
  card: GraphCardLayout,
  iteration: LoopIterationView | undefined,
  cards: SVGGElement[],
): void => {
  const body = card.body;
  if (body === undefined) {
    return;
  }
  const surface = createSvgElement("rect");
  surface.classList.add("dag-loop-surface");
  surface.setAttribute("x", String(surfaceInset));
  surface.setAttribute("y", String(containerHeaderHeight - surfaceRise));
  surface.setAttribute("width", String(card.width - surfaceInset * 2));
  surface.setAttribute(
    "height",
    String(card.height - containerHeaderHeight + surfaceRise - surfaceInset),
  );
  surface.setAttribute("rx", "8");
  container.append(surface);

  for (const edge of loop.body.edges) {
    const from = body.positions.get(edge.from);
    const to = body.positions.get(edge.to);
    if (from === undefined || to === undefined) {
      continue;
    }
    const path = createSvgElement("path");
    path.classList.add("dag-edge");
    path.setAttribute(
      "d",
      cubicEdgePath(
        from.x + bodyCardWidth,
        from.y + bodyCardHeight / 2,
        to.x,
        to.y + bodyCardHeight / 2,
      ),
    );
    path.setAttribute("marker-end", "url(#dag-arrow)");
    container.append(path);
  }

  const feedbackFrom = body.positions.get(loop.feedback.fromNodeId);
  const feedbackTo = body.positions.get(loop.feedback.toNodeId);
  if (feedbackFrom !== undefined && feedbackTo !== undefined) {
    const selfFeedback = loop.feedback.fromNodeId === loop.feedback.toNodeId;
    const spread = selfFeedback ? bodyCardWidth / 3 : 0;
    const startX = feedbackFrom.x + bodyCardWidth / 2 + spread;
    const endX = feedbackTo.x + bodyCardWidth / 2 - spread;
    const startY = feedbackFrom.y + bodyCardHeight;
    const endY = feedbackTo.y + bodyCardHeight;
    const controlY = body.height + containerFeedbackLane;
    const path = createSvgElement("path");
    path.classList.add("dag-edge", "dag-loop-feedback");
    path.setAttribute("d", feedbackEdgePath(startX, startY, endX, endY, controlY));
    path.setAttribute("marker-end", "url(#dag-arrow)");
    const label = createSvgElement("text");
    label.classList.add("dag-loop-edge-label");
    label.setAttribute("x", String((startX + endX) / 2));
    label.setAttribute("y", String(feedbackEdgeApexY(startY, endY, controlY) + 10));
    setText(label, `${loop.decision.reviseChoice} · ${loop.feedback.input}`);
    container.append(path, label);
  }

  const decision = body.positions.get(loop.decision.nodeId);
  if (decision !== undefined) {
    const startX = decision.x + bodyCardWidth;
    const centreY = decision.y + bodyCardHeight / 2;
    const path = createSvgElement("path");
    path.classList.add("dag-edge");
    path.setAttribute(
      "d",
      `M ${String(startX)} ${String(centreY)} L ${String(card.width)} ${String(centreY)}`,
    );
    path.setAttribute("marker-end", "url(#dag-arrow)");
    const label = createSvgElement("text");
    label.classList.add("dag-loop-edge-label");
    label.setAttribute("x", String((startX + card.width) / 2));
    label.setAttribute("y", String(centreY - 7));
    setText(label, loop.decision.passChoice);
    container.append(path, label);
  }

  for (const bodyNode of loop.body.nodes) {
    const position = body.positions.get(bodyNode.id);
    if (position === undefined) {
      continue;
    }
    const execution = iteration?.executions.get(bodyNode.id);
    const group = createSvgElement("g");
    group.classList.add("dag-body-node");
    group.setAttribute(
      "transform",
      `translate(${String(card.position.x + position.x)} ${String(card.position.y + position.y)})`,
    );
    group.setAttribute("data-loop-node-id", loop.id);
    group.setAttribute("data-body-node-id", bodyNode.id);
    if (iteration === undefined || execution === undefined) {
      group.setAttribute("aria-hidden", "true");
    } else {
      group.classList.add("dag-node", execution.status);
      group.setAttribute("role", "button");
      group.setAttribute("data-execution-id", execution.executionId);
      group.setAttribute(
        "aria-selected",
        String(execution.executionId === state.selectedExecutionId),
      );
      group.setAttribute(
        "aria-label",
        `${bodyNode.id}, loop ${loop.id} body step ${String(bodyNode.ordinal + 1)}, iteration ${String(iterationOrdinal(iteration.iteration))}, ${formatStatus(execution.status)}`,
      );
    }
    const selection = createSvgElement("rect");
    selection.classList.add("dag-node-selection");
    selection.setAttribute("x", "-4");
    selection.setAttribute("y", "-4");
    selection.setAttribute("width", String(bodyCardWidth + 8));
    selection.setAttribute("height", String(bodyCardHeight + 8));
    selection.setAttribute("rx", "10");
    const rectangle = createSvgElement("rect");
    rectangle.classList.add("dag-node-body");
    rectangle.setAttribute("width", String(bodyCardWidth));
    rectangle.setAttribute("height", String(bodyCardHeight));
    rectangle.setAttribute("rx", "7");
    const bodyTitle = createSvgElement("text");
    bodyTitle.classList.add("dag-node-title");
    bodyTitle.setAttribute("x", "12");
    bodyTitle.setAttribute("y", "21");
    setText(bodyTitle, bodyNode.id);
    const metadata = createSvgElement("text");
    metadata.classList.add("dag-node-meta");
    metadata.setAttribute("x", "12");
    metadata.setAttribute("y", "36");
    setText(
      metadata,
      execution === undefined ? nodeKindCopy(bodyNode) : statusCardCopy(execution.status),
    );
    group.append(selection, rectangle, bodyTitle, metadata);
    elements.graph.append(group);
    if (execution !== undefined) {
      activateGraphCard(group, cards, () => {
        selectLoopExecution(loop.id, execution.executionId, true);
      });
      cards.push(group);
    }
  }
};

const updateGraphRovingFocus = (cards: readonly SVGGElement[], nextIndex: number): void => {
  if (cards.length === 0) {
    return;
  }
  const normalizedIndex = Math.min(Math.max(nextIndex, 0), cards.length - 1);
  setRovingTabIndex(cards, normalizedIndex);
  cards[normalizedIndex]?.focus();
};

const renderGraph = (): void => {
  const graph = currentGraph();
  elements.graph.replaceChildren();
  renderExecutionList(graph);
  if (graph === undefined) {
    const title = createSvgElement("title");
    title.id = "workflow-graph-title";
    setText(title, "Workflow graph unavailable");
    const description = createSvgElement("desc");
    description.id = "workflow-graph-description";
    setText(description, "Correct the workflow diagnostics to display its graph.");
    elements.graph.append(title, description);
    sizeGraphSurface(560, 148);
    return;
  }

  const title = createSvgElement("title");
  title.id = "workflow-graph-title";
  setText(title, `${graph.name} workflow graph`);
  const description = createSvgElement("desc");
  description.id = "workflow-graph-description";
  const loopSentences = graph.nodes
    .filter((node): node is LoopWorkflowNodeDto => node.kind === "loop")
    .map(
      (loop) =>
        ` Loop ${loop.id} repeats up to ${String(loop.maxIterations)} times over ${loop.body.nodes
          .map(({ id }) => id)
          .join(", ")}.`,
    )
    .join("");
  setText(
    description,
    `${String(graph.nodes.length)} nodes in execution order: ${graph.executionOrder.join(", ")}.${loopSentences} Use arrow keys to move between nodes and Enter to inspect one.`,
  );

  const definitions = createSvgElement("defs");
  for (const markerId of ["dag-arrow", "dag-arrow-running"] as const) {
    const marker = createSvgElement("marker");
    marker.id = markerId;
    marker.setAttribute("markerWidth", "8");
    marker.setAttribute("markerHeight", "8");
    marker.setAttribute("refX", "7");
    marker.setAttribute("refY", "4");
    marker.setAttribute("orient", "auto");
    const arrow = createSvgElement("path");
    arrow.classList.add(`${markerId}-head`);
    arrow.setAttribute("d", "M 0 0 L 8 4 L 0 8 Z");
    marker.append(arrow);
    definitions.append(marker);
  }

  const layout = graphLayout(graph, expandedLoopNodeId(graph));
  const nodeRuns = currentNodeRuns();
  sizeGraphSurface(layout.width, layout.height);
  elements.graph.append(title, description, definitions);

  for (const edge of graph.edges) {
    const from = layout.cards.get(edge.from);
    const to = layout.cards.get(edge.to);
    if (from === undefined || to === undefined) {
      continue;
    }
    const path = createSvgElement("path");
    const feedsRunningNode = nodeRuns.get(edge.to)?.status === "running";
    path.classList.add("dag-edge");
    if (feedsRunningNode) {
      path.classList.add("running");
    }
    path.setAttribute(
      "d",
      cubicEdgePath(
        from.position.x + from.width,
        from.position.y + from.exitY,
        to.position.x,
        to.position.y + to.height / 2,
      ),
    );
    path.setAttribute(
      "marker-end",
      feedsRunningNode ? "url(#dag-arrow-running)" : "url(#dag-arrow)",
    );
    elements.graph.append(path);
  }

  const cards: SVGGElement[] = [];
  const selectedBodyLoopId = selectedNodeRun()?.loopNodeId;
  for (const node of orderedGraphNodes(graph)) {
    const card = layout.cards.get(node.id);
    if (card === undefined) {
      continue;
    }
    const status = nodeRuns.get(node.id)?.status;
    const iteration = node.kind === "loop" ? currentLoopIteration(node.id) : undefined;
    const group = createSvgElement("g");
    group.classList.add("dag-node");
    if (status !== undefined) {
      group.classList.add(status);
    }
    group.setAttribute(
      "transform",
      `translate(${String(card.position.x)} ${String(card.position.y)})`,
    );
    group.setAttribute("role", "button");
    group.setAttribute("data-node-id", node.id);
    group.setAttribute(
      "aria-selected",
      String(node.id === state.selectedNodeId && node.id !== selectedBodyLoopId),
    );
    const summary = graphCardSummary(node, status, iteration);
    group.setAttribute(
      "aria-label",
      `${node.id}, step ${String(node.ordinal + 1)}, ${summary.aria}`,
    );

    const stackRise = node.kind === "loop" ? loopStackRise : 0;
    const selection = createSvgElement("rect");
    selection.classList.add("dag-node-selection");
    selection.setAttribute("x", "-4");
    selection.setAttribute("y", String(-4 - stackRise));
    selection.setAttribute("width", String(card.width + 8));
    selection.setAttribute("height", String(card.height + 8 + stackRise));
    selection.setAttribute("rx", "11");
    group.append(selection);
    if (node.kind === "loop") {
      const stack = createSvgElement("rect");
      stack.classList.add("dag-loop-stack");
      stack.setAttribute("x", String(loopStackInset));
      stack.setAttribute("y", String(-loopStackRise));
      stack.setAttribute("width", String(card.width - loopStackInset * 2));
      stack.setAttribute("height", String(loopStackHeight));
      stack.setAttribute("rx", "7");
      group.append(stack);
    }
    const rectangle = createSvgElement("rect");
    rectangle.classList.add("dag-node-body");
    rectangle.setAttribute("width", String(card.width));
    rectangle.setAttribute("height", String(card.height));
    rectangle.setAttribute("rx", "8");
    const nodeTitle = createSvgElement("text");
    nodeTitle.classList.add("dag-node-title");
    nodeTitle.setAttribute("x", "14");
    nodeTitle.setAttribute("y", "26");
    setText(nodeTitle, node.id);
    const metadata = createSvgElement("text");
    metadata.classList.add("dag-node-meta");
    metadata.setAttribute("x", "14");
    metadata.setAttribute("y", "45");
    setText(metadata, summary.meta);
    group.append(rectangle, nodeTitle, metadata);
    activateGraphCard(group, cards, () => {
      selectNode(node.id, true);
    });
    cards.push(group);
    elements.graph.append(group);
    if (node.kind === "loop") {
      appendLoopBody(group, node, card, iteration, cards);
    }
  }

  setRovingTabIndex(cards, Math.max(0, graphCardIndex(cards, selectedGraphCardKey())));
};

const renderGraphExpansion = (): void => {
  elements.graphStrip.classList.toggle("expanded", state.graphExpanded);
  elements.graphExpandToggle.setAttribute("aria-pressed", String(state.graphExpanded));
  const graphOverflowsStrip = elements.graphStrip.scrollHeight > elements.graphStrip.clientHeight;
  const keepsFocus = document.activeElement === elements.graphExpandToggle;
  elements.graphExpandToggle.hidden = !state.graphExpanded && !keepsFocus && !graphOverflowsStrip;
};

const renderRunInspector = (): void => {
  elements.runInspector.replaceChildren();
  const title = document.createElement("p");
  title.className = "inspector-title";
  if (state.viewMode === "current") {
    setText(title, "Current definition");
    elements.runInspector.append(title);
    if (state.currentWorkflow?.state === "valid") {
      const list = createPropertyList();
      appendProperty(list, "Workflow", state.currentWorkflow.workflow.workflowId);
      appendProperty(list, "Revision (content hash)", shortId(state.currentWorkflow.contentHash));
      appendProperty(list, "Nodes", String(state.currentWorkflow.workflow.nodes.length));
      elements.runInspector.append(list);
    } else {
      const copy = document.createElement("p");
      copy.className = "empty-copy";
      setText(
        copy,
        "The current definition cannot be displayed until its diagnostics are resolved.",
      );
      elements.runInspector.append(copy);
    }
    return;
  }

  const detail = state.runDetail;
  if (detail === undefined) {
    setText(title, "Loading run…");
    elements.runInspector.append(title);
    return;
  }
  setText(title, detail.run.runId);
  const list = createPropertyList();
  const runStatus = presentedRunStatus(detail.run);
  appendProperty(list, "Status", statusCardCopy(runStatus));
  appendProperty(list, "Started", formatTimestamp(detail.run.startedAt));
  appendDurationProperty(list, detail.run.durationMs, detail.run.startedAt, detail.run.finishedAt);
  appendProperty(list, "Revision (content hash)", shortId(detail.revision.contentHash));
  appendProperty(list, "Directory", detail.run.cwd);
  if (detail.run.rerunOfRunId !== undefined) {
    appendProperty(list, "Rerun of", detail.run.rerunOfRunId);
  }
  if (detail.run.recoveryOfRunId !== undefined) {
    appendProperty(
      list,
      detail.run.recoveryMode === "resume" ? "Resumed from" : "Retried from",
      detail.run.recoveryOfRunId,
    );
  }
  if (detail.run.cancelRequestedAt !== undefined) {
    appendProperty(list, "Cancellation requested", formatTimestamp(detail.run.cancelRequestedAt));
  }
  appendProperty(list, "Attempts", String(detail.attempts.length));
  appendProperty(list, "Provisioned", String(detail.workspaces.length));
  elements.runInspector.append(title, list);
  if (detail.run.status === "running" && detail.run.cancelRequestedAt === undefined) {
    elements.runInspector.append(cancelCommand(detail.run.runId));
  }
  if (detail.attempts.length > 0) {
    const attempts = document.createElement("details");
    const summary = document.createElement("summary");
    setText(summary, "Attempt history");
    const attemptList = document.createElement("ul");
    attemptList.className = "run-metadata-list";
    for (const attempt of detail.attempts) {
      const item = document.createElement("li");
      setText(
        item,
        `${attempt.executionId} · attempt ${String(attempt.attempt)} · ${formatStatus(attempt.status)}`,
      );
      attemptList.append(item);
    }
    attempts.append(summary, attemptList);
    elements.runInspector.append(attempts);
  }
  if (detail.workspaces.length > 0) {
    const workspaces = document.createElement("details");
    const summary = document.createElement("summary");
    setText(summary, "Provisioned workspaces");
    const workspaceList = document.createElement("ul");
    workspaceList.className = "run-metadata-list";
    for (const workspace of detail.workspaces) {
      const item = document.createElement("li");
      setText(
        item,
        `${workspace.workspaceId} · ${workspace.status} · base ${shortId(workspace.baseCommit)}`,
      );
      workspaceList.append(item);
    }
    workspaces.append(summary, workspaceList);
    elements.runInspector.append(workspaces);
  }
  const failure = detail.run.failure;
  const owningNodes = detail.nodes.filter((node) => sameFailure(node.failure, failure));
  const owningNode = owningNodes.length === 1 ? owningNodes[0] : undefined;
  const selectedNodeOwnsFailure = sameFailure(selectedNodeRun()?.failure, failure);
  if (failure !== undefined && owningNode !== undefined && selectedNodeOwnsFailure) {
    const reference = document.createElement("p");
    reference.className = "failure-reference";
    setText(reference, `${failure.code} at node ${owningNode.nodeId}. See the node section below.`);
    elements.runInspector.append(reference);
    return;
  }
  appendFailure(elements.runInspector, failure);
};

const renderNodeInspector = (): void => {
  elements.nodeInspector.replaceChildren();
  const node = selectedWorkflowNode();
  if (node === undefined) {
    const copy = document.createElement("p");
    copy.className = "empty-copy";
    setText(copy, "Select an available workflow node to inspect it.");
    elements.nodeInspector.append(copy);
    return;
  }
  const title = document.createElement("p");
  title.className = "inspector-title";
  setText(title, node.id);
  const list = createPropertyList();
  appendProperty(list, "Order", String(node.ordinal + 1));
  if (node.kind === "agent") {
    appendProperty(list, "Runtime", node.runtime);
    appendProperty(list, "Access", node.access.replace("_", " "));
    appendProperty(list, "Model", node.model ?? "Runtime default");
    appendProperty(list, "Output", node.outputType ?? "None declared");
    if (node.artifactPath !== undefined) {
      appendProperty(list, "Artifact path", node.artifactPath);
    }
  } else if (node.kind === "approval") {
    appendProperty(list, "Question", node.question);
  } else {
    appendProperty(list, "Iteration bound", String(node.maxIterations));
    appendProperty(
      list,
      "Decision",
      `${node.decision.nodeId}: ${node.decision.passChoice} / ${node.decision.reviseChoice}`,
    );
    appendProperty(
      list,
      "Feedback",
      `${node.feedback.fromNodeId} → ${node.feedback.toNodeId} (${node.feedback.input})`,
    );
    appendProperty(list, "Result", node.resultNodeId);
    appendProperty(list, "Body", node.body.nodes.map(({ id }) => id).join(", "));
  }
  appendProperty(list, "Depends on", node.dependencies.join(", ") || "None");
  for (const edge of currentGraph()?.edges ?? []) {
    if (edge.to === node.id && edge.input !== undefined) {
      appendProperty(list, `Input ${edge.input}`, edge.from);
    }
  }

  const nodeRun = selectedNodeRun();
  if (nodeRun !== undefined) {
    appendProperty(list, "Status", statusCardCopy(nodeRun.status));
    if (nodeRun.kind === "agent") {
      appendDurationProperty(list, nodeRun.durationMs, nodeRun.startedAt, nodeRun.finishedAt);
      appendProperty(
        list,
        "Exit code",
        nodeRun.exitCode === undefined ? "—" : String(nodeRun.exitCode),
      );
      appendProperty(list, "Effective", nodeRun.effectiveModel ?? nodeRun.requestedModel ?? "—");
    } else if (nodeRun.kind === "approval") {
      appendDurationProperty(list, nodeRun.durationMs, nodeRun.requestedAt, nodeRun.finishedAt);
      appendProperty(
        list,
        "Requested",
        nodeRun.requestedAt === undefined ? "—" : formatTimestamp(nodeRun.requestedAt),
      );
      if (nodeRun.deadlineAt === undefined) {
        appendProperty(list, "Deadline", "—");
      } else if (nodeRun.decision === undefined && nodeRun.status === "waiting_for_approval") {
        appendLiveProperty(list, "Deadline", { liveDeadline: nodeRun.deadlineAt });
      } else {
        appendProperty(list, "Deadline", formatTimestamp(nodeRun.deadlineAt));
      }
      appendProperty(list, "Decision", nodeRun.decision?.decision ?? "Pending");
      if (nodeRun.decision !== undefined) {
        appendProperty(list, "Actor", nodeRun.decision.actor);
        appendProperty(list, "Decided", formatTimestamp(nodeRun.decision.decidedAt));
        appendProperty(list, "Note", nodeRun.decision.note ?? "—");
      }
    } else {
      appendDurationProperty(list, nodeRun.durationMs, nodeRun.startedAt, nodeRun.finishedAt);
      appendProperty(
        list,
        "Started",
        nodeRun.startedAt === undefined ? "—" : formatTimestamp(nodeRun.startedAt),
      );
    }
    appendProperty(list, "Execution ID", nodeRun.executionId);
    if (nodeRun.loopNodeId !== undefined && nodeRun.iteration !== undefined) {
      appendProperty(list, "Body node ID", nodeRun.nodeId);
      appendProperty(list, "Loop node ID", nodeRun.loopNodeId);
      appendProperty(list, "Iteration", String(nodeRun.iteration));
    }
  }
  elements.nodeInspector.append(title, list);
  appendFailure(elements.nodeInspector, nodeRun?.failure);
};

const renderLineage = (): void => {
  elements.lineageList.replaceChildren();
  const lineage = state.viewMode === "run" ? state.runDetail?.lineage : undefined;
  if (lineage === undefined || lineage.runs.length <= 1) {
    elements.lineageSection.hidden = true;
    return;
  }
  elements.lineageSection.hidden = false;
  for (const [index, run] of lineage.runs.entries()) {
    const presentedStatus = presentedRunStatus(run);
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.className = "lineage-button";
    button.type = "button";
    button.setAttribute("data-run-id", run.runId);
    button.setAttribute("aria-current", String(index === lineage.selectedRunIndex));
    button.setAttribute("tabindex", index === lineage.selectedRunIndex ? "0" : "-1");
    button.setAttribute(
      "aria-label",
      `Inspect lineage run ${run.runId}, ${formatStatus(presentedStatus)}`,
    );
    const relation =
      run.recoveryMode === "resume"
        ? "resumed"
        : run.recoveryMode === "retry"
          ? "retried"
          : run.rerunOfRunId === undefined
            ? "origin"
            : "rerun";
    setText(
      button,
      `${String(index + 1)}. ${shortId(run.runId)} · ${relation} · ${formatStatus(presentedStatus)}`,
    );
    button.addEventListener("click", () => {
      void selectRun(run.runId);
    });
    button.addEventListener("keydown", handleLineageKeydown);
    item.append(button);
    elements.lineageList.append(item);
  }
};

const handleLineageKeydown = (event: KeyboardEvent): void => {
  const buttons = Array.from(elements.lineageList.querySelectorAll<HTMLButtonElement>("button"));
  const currentIndex = buttons.findIndex((button) => button === event.currentTarget);
  if (currentIndex === -1 || buttons.length === 0) {
    return;
  }
  let nextIndex: number | undefined;
  if (event.key === "ArrowDown" || event.key === "ArrowRight") {
    nextIndex = (currentIndex + 1) % buttons.length;
  } else if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
    nextIndex = (currentIndex - 1 + buttons.length) % buttons.length;
  } else if (event.key === "Home") {
    nextIndex = 0;
  } else if (event.key === "End") {
    nextIndex = buttons.length - 1;
  }
  if (nextIndex === undefined) {
    return;
  }
  event.preventDefault();
  for (const [index, button] of buttons.entries()) {
    button.setAttribute("tabindex", index === nextIndex ? "0" : "-1");
  }
  buttons[nextIndex]?.focus();
};

const outputKey = (runId: string, ordinal: number, stream: OutputStream): string =>
  `${runId}:${String(ordinal)}:${stream}`;

const isOutputStream = (value: string | null | undefined): value is OutputStream =>
  value === "result" || value === "stdout" || value === "stderr";

const nodeAvailableOutputs = (nodeRun: NodeRunDto | undefined): readonly OutputStream[] =>
  nodeRun?.kind === "agent" ? nodeRun.availableOutputs : [];

const streamPresentationOrder: readonly OutputStream[] = ["result", "stdout", "stderr"];

const streamLabels: Readonly<Record<OutputStream, string>> = {
  result: "Result",
  stdout: "Activity",
  stderr: "Stderr",
};

type ActivityTone = "ok" | "fail" | "running";

type ActivityRow =
  | { readonly kind: "reason"; readonly titles: readonly string[] }
  | { readonly kind: "message"; readonly text: string }
  | {
      readonly kind: "run";
      readonly rowKey: string | undefined;
      readonly command: string;
      readonly output: string;
      readonly badge: string;
      readonly tone: ActivityTone;
    }
  | { readonly kind: "tool"; readonly label: string; readonly detail: string }
  | { readonly kind: "turn"; readonly usage: string }
  | { readonly kind: "raw"; readonly line: string };

type ActivityOperation =
  | { readonly op: "row"; readonly key?: string; readonly row: ActivityRow }
  | {
      readonly op: "attach";
      readonly key: string;
      readonly output: string;
      readonly isError: boolean;
    };

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const asString = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

const asNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const formatTokenCount = (tokens: number): string => {
  if (tokens >= 1_000_000) {
    return `${String(Math.round(tokens / 100_000) / 10)}M`;
  }
  if (tokens >= 1_000) {
    return `${String(Math.round(tokens / 100) / 10)}K`;
  }
  return String(tokens);
};

const usageChipText = (usage: Record<string, unknown>): string | undefined => {
  const input = asNumber(usage.input_tokens);
  const output = asNumber(usage.output_tokens);
  if (input === undefined && output === undefined) {
    return undefined;
  }
  const parts: string[] = [];
  if (input !== undefined) {
    parts.push(`${formatTokenCount(input)} in`);
  }
  if (output !== undefined) {
    parts.push(`${formatTokenCount(output)} out`);
  }
  return parts.join(" · ");
};

const reasoningTitle = (text: string): string => {
  const firstLine = text.split("\n", 1)[0] ?? "";
  return firstLine.replaceAll("**", "").trim();
};

const commandRunRow = (item: Record<string, unknown>, rowKey: string | undefined): ActivityRow => {
  const exitCode = asNumber(item.exit_code);
  const status = asString(item.status);
  let tone: ActivityTone;
  let badge: string;
  if (exitCode === undefined) {
    if (status === "completed" || status === "failed") {
      tone = "fail";
      badge = "failed";
    } else {
      tone = "running";
      badge = "running";
    }
  } else if (exitCode === 0) {
    tone = "ok";
    badge = "exit 0";
  } else {
    tone = "fail";
    badge = `exit ${String(exitCode)}`;
  }
  return {
    kind: "run",
    rowKey,
    command: asString(item.command) ?? "",
    output: asString(item.aggregated_output) ?? "",
    badge,
    tone,
  };
};

const codexItemOperation = (line: string, event: Record<string, unknown>): ActivityOperation => {
  const item = asRecord(event.item);
  const itemType = asString(item?.type);
  if (item === undefined || itemType === undefined) {
    return { op: "row", row: { kind: "raw", line } };
  }
  const itemId = asString(item.id);
  const entryKey = itemId === undefined ? undefined : `codex:${itemId}`;
  const identity = entryKey === undefined ? {} : { key: entryKey };
  if (itemType === "reasoning") {
    return {
      op: "row",
      ...identity,
      row: { kind: "reason", titles: [reasoningTitle(asString(item.text) ?? "")] },
    };
  }
  if (itemType === "agent_message") {
    return { op: "row", ...identity, row: { kind: "message", text: asString(item.text) ?? "" } };
  }
  if (itemType === "command_execution") {
    return { op: "row", ...identity, row: commandRunRow(item, entryKey) };
  }
  if (itemType === "collab_tool_call") {
    const status = asString(item.status);
    return {
      op: "row",
      ...identity,
      row: {
        kind: "tool",
        label: asString(item.tool) ?? "collab tool",
        detail: status === undefined ? "" : status.replaceAll("_", " "),
      },
    };
  }
  return { op: "row", row: { kind: "raw", line } };
};

const toolResultText = (content: unknown): string => {
  const direct = asString(content);
  if (direct !== undefined) {
    return direct;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((block) => asString(asRecord(block)?.text) ?? "")
    .filter((text) => text !== "")
    .join("\n");
};

const claudeContentOperations = (event: Record<string, unknown>): ActivityOperation[] => {
  const content = asRecord(event.message)?.content;
  if (!Array.isArray(content)) {
    return [];
  }
  const operations: ActivityOperation[] = [];
  for (const rawBlock of content) {
    const block = asRecord(rawBlock);
    const blockType = asString(block?.type);
    if (block === undefined || blockType === undefined) {
      continue;
    }
    if (blockType === "thinking") {
      operations.push({
        op: "row",
        row: { kind: "reason", titles: [reasoningTitle(asString(block.thinking) ?? "")] },
      });
    } else if (blockType === "text") {
      operations.push({ op: "row", row: { kind: "message", text: asString(block.text) ?? "" } });
    } else if (blockType === "tool_use") {
      const id = asString(block.id);
      const entryKey = id === undefined ? undefined : `claude:${id}`;
      const identity = entryKey === undefined ? {} : { key: entryKey };
      const name = asString(block.name) ?? "tool";
      const input = asRecord(block.input);
      const bashCommand = asString(input?.command);
      if (name === "Bash" && bashCommand !== undefined) {
        operations.push({
          op: "row",
          ...identity,
          row: {
            kind: "run",
            rowKey: entryKey,
            command: bashCommand,
            output: "",
            badge: "running",
            tone: "running",
          },
        });
      } else {
        const detail = input === undefined ? "" : JSON.stringify(input);
        operations.push({
          op: "row",
          ...identity,
          row: {
            kind: "tool",
            label: name,
            detail: detail.length > 160 ? `${detail.slice(0, 160)}…` : detail,
          },
        });
      }
    } else if (blockType === "tool_result") {
      const id = asString(block.tool_use_id);
      if (id !== undefined) {
        operations.push({
          op: "attach",
          key: `claude:${id}`,
          output: toolResultText(block.content),
          isError: block.is_error === true,
        });
      }
    }
  }
  return operations;
};

const lineOperations = (line: string): ActivityOperation[] => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return [{ op: "row", row: { kind: "raw", line } }];
  }
  const event = asRecord(parsed);
  const eventType = asString(event?.type);
  if (event === undefined || eventType === undefined) {
    return [{ op: "row", row: { kind: "raw", line } }];
  }
  if (eventType === "thread.started" || eventType === "turn.started" || eventType === "system") {
    return [];
  }
  if (eventType === "turn.completed" || eventType === "result") {
    const usage = asRecord(event.usage);
    const chip = usage === undefined ? undefined : usageChipText(usage);
    if (chip === undefined) {
      return [{ op: "row", row: { kind: "raw", line } }];
    }
    return [{ op: "row", row: { kind: "turn", usage: chip } }];
  }
  if (
    eventType === "item.started" ||
    eventType === "item.updated" ||
    eventType === "item.completed"
  ) {
    return [codexItemOperation(line, event)];
  }
  if (eventType === "assistant" || eventType === "user") {
    return claudeContentOperations(event);
  }
  return [{ op: "row", row: { kind: "raw", line } }];
};

interface ActivityEntry {
  key: string | undefined;
  row: ActivityRow;
}

const attachToolOutput = (entry: ActivityEntry, output: string, isError: boolean): void => {
  if (entry.row.kind === "run") {
    entry.row = {
      ...entry.row,
      output,
      badge: isError ? "error" : "ok",
      tone: isError ? "fail" : "ok",
    };
    return;
  }
  if (entry.row.kind === "tool") {
    entry.row = { ...entry.row, detail: output === "" ? entry.row.detail : output };
  }
};

const collapseReasonRows = (rows: readonly ActivityRow[]): readonly ActivityRow[] => {
  const collapsed: ActivityRow[] = [];
  for (const row of rows) {
    if (row.kind !== "reason") {
      collapsed.push(row);
      continue;
    }
    const titles = row.titles.filter((title) => title !== "");
    if (titles.length === 0) {
      continue;
    }
    const previous = collapsed[collapsed.length - 1];
    if (previous?.kind === "reason") {
      collapsed[collapsed.length - 1] = { kind: "reason", titles: [...previous.titles, ...titles] };
      continue;
    }
    collapsed.push({ kind: "reason", titles });
  }
  return collapsed;
};

const activityRows = (text: string, droppedPartialFirstLine: boolean): readonly ActivityRow[] => {
  let source = text;
  if (droppedPartialFirstLine) {
    const firstBreak = source.indexOf("\n");
    source = firstBreak === -1 ? "" : source.slice(firstBreak + 1);
  }
  const entries: ActivityEntry[] = [];
  const entryIndexByKey = new Map<string, number>();
  for (const line of source.split("\n")) {
    if (line.trim() === "") {
      continue;
    }
    for (const operation of lineOperations(line)) {
      if (operation.op === "attach") {
        const index = entryIndexByKey.get(operation.key);
        const entry = index === undefined ? undefined : entries[index];
        if (entry === undefined) {
          entries.push({
            key: undefined,
            row: { kind: "tool", label: "tool result", detail: operation.output },
          });
        } else {
          attachToolOutput(entry, operation.output, operation.isError);
        }
        continue;
      }
      const existingIndex =
        operation.key === undefined ? undefined : entryIndexByKey.get(operation.key);
      if (existingIndex !== undefined && entries[existingIndex] !== undefined) {
        entries[existingIndex].row = operation.row;
        continue;
      }
      entries.push({ key: operation.key, row: operation.row });
      if (operation.key !== undefined) {
        entryIndexByKey.set(operation.key, entries.length - 1);
      }
    }
  }
  return collapseReasonRows(entries.map((entry) => entry.row));
};

interface InlineMatch {
  readonly index: number;
  readonly consumed: number;
  readonly node: Node;
}

interface InlineMatchLocator {
  readonly index: number;
  build(): Omit<InlineMatch, "index">;
}

const italicMarkerPatterns: readonly RegExp[] = [/(?<!\*)\*(?!\*)/u, /(?<!_)_(?!_)/u];

const singleMarkerLocator = (text: string, pattern: RegExp): InlineMatchLocator | undefined => {
  const open = pattern.exec(text)?.index;
  if (open === undefined) {
    return undefined;
  }
  const closeOffset = pattern.exec(text.slice(open + 1))?.index;
  if (closeOffset === undefined) {
    return undefined;
  }
  return {
    index: open,
    build: (): Omit<InlineMatch, "index"> => {
      const element = document.createElement("em");
      appendInlineMarkdown(element, text.slice(open + 1, open + 1 + closeOffset));
      return { consumed: closeOffset + 2, node: element };
    },
  };
};

const pairedMarkerLocator = (
  text: string,
  marker: string,
  tagName: "strong" | "code",
): InlineMatchLocator | undefined => {
  const open = text.indexOf(marker);
  if (open === -1) {
    return undefined;
  }
  const close = text.indexOf(marker, open + marker.length);
  if (close === -1) {
    return undefined;
  }
  return {
    index: open,
    build: (): Omit<InlineMatch, "index"> => {
      const element = document.createElement(tagName);
      const content = text.slice(open + marker.length, close);
      if (tagName === "code") {
        setText(element, content);
      } else {
        appendInlineMarkdown(element, content);
      }
      return { consumed: close + marker.length - open, node: element };
    },
  };
};

const linkChipLocator = (text: string): InlineMatchLocator | undefined => {
  const match = /\[([^\]\n]*)\]\(([^)\s]*)\)/u.exec(text);
  if (match?.[1] === undefined || match[2] === undefined) {
    return undefined;
  }
  const label = match[1];
  const target = match[2];
  return {
    index: match.index,
    build: (): Omit<InlineMatch, "index"> => {
      const chip = document.createElement("span");
      chip.className = "md-link";
      setText(chip, label === "" ? target : label);
      chip.title = target;
      return { consumed: match[0].length, node: chip };
    },
  };
};

const appendInlineMarkdown = (parent: Node, source: string): void => {
  let remaining = source;
  while (remaining.length > 0) {
    let earliest: InlineMatchLocator | undefined;
    for (const candidate of [
      pairedMarkerLocator(remaining, "`", "code"),
      pairedMarkerLocator(remaining, "**", "strong"),
      ...italicMarkerPatterns.map((pattern) => singleMarkerLocator(remaining, pattern)),
      linkChipLocator(remaining),
    ]) {
      if (candidate !== undefined && (earliest === undefined || candidate.index < earliest.index)) {
        earliest = candidate;
      }
    }
    if (earliest === undefined) {
      parent.appendChild(document.createTextNode(remaining));
      return;
    }
    if (earliest.index > 0) {
      parent.appendChild(document.createTextNode(remaining.slice(0, earliest.index)));
    }
    const match = earliest.build();
    parent.appendChild(match.node);
    remaining = remaining.slice(earliest.index + match.consumed);
  }
};

const renderMarkdownDocument = (markdown: string): HTMLElement => {
  const article = document.createElement("article");
  article.className = "result-document";
  let paragraphLines: string[] = [];
  let list: { readonly ordered: boolean; readonly element: HTMLElement } | undefined;
  let fenceLines: string[] | undefined;

  const flushParagraph = (): void => {
    if (paragraphLines.length === 0) {
      return;
    }
    const paragraph = document.createElement("p");
    appendInlineMarkdown(paragraph, paragraphLines.join(" "));
    article.append(paragraph);
    paragraphLines = [];
  };
  const closeList = (): void => {
    list = undefined;
  };
  const flushFence = (): void => {
    if (fenceLines === undefined) {
      return;
    }
    const pre = document.createElement("pre");
    pre.className = "md-code-block";
    const code = document.createElement("code");
    setText(code, fenceLines.join("\n"));
    pre.append(code);
    article.append(pre);
    fenceLines = undefined;
  };

  for (const line of markdown.split("\n")) {
    if (fenceLines !== undefined) {
      if (/^\s*```/u.test(line)) {
        flushFence();
      } else {
        fenceLines.push(line);
      }
      continue;
    }
    if (/^\s*```/u.test(line)) {
      flushParagraph();
      closeList();
      fenceLines = [];
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/u.exec(line);
    if (heading?.[1] !== undefined && heading[2] !== undefined) {
      flushParagraph();
      closeList();
      const element = document.createElement(`h${String(heading[1].length)}`);
      appendInlineMarkdown(element, heading[2]);
      article.append(element);
      continue;
    }
    const unordered = /^\s*[-*]\s+(.*)$/u.exec(line);
    const ordered = /^\s*\d+[.)]\s+(.*)$/u.exec(line);
    const itemText = unordered?.[1] ?? ordered?.[1];
    if (itemText !== undefined) {
      flushParagraph();
      const isOrdered = unordered === null;
      if (list?.ordered !== isOrdered) {
        const element = document.createElement(isOrdered ? "ol" : "ul");
        article.append(element);
        list = { ordered: isOrdered, element };
      }
      const item = document.createElement("li");
      appendInlineMarkdown(item, itemText);
      list.element.append(item);
      continue;
    }
    if (line.trim() === "") {
      flushParagraph();
      closeList();
      continue;
    }
    closeList();
    paragraphLines.push(line.trim());
  }
  flushParagraph();
  flushFence();
  return article;
};

const activityTagLabels: Readonly<Record<ActivityRow["kind"], string>> = {
  reason: "Reason",
  message: "Message",
  run: "Run",
  tool: "Tool",
  turn: "Turn",
  raw: "Raw",
};

const exitBadge = (badge: string, tone: ActivityTone): HTMLElement => {
  const element = document.createElement("span");
  element.className = `exit-badge exit-${tone}`;
  setText(element, badge);
  return element;
};

const runRowBody = (row: ActivityRow & { kind: "run" }, fallbackKey: string): HTMLElement => {
  const command = document.createElement("code");
  command.className = "run-command";
  setText(command, row.command);
  if (row.output === "") {
    const header = document.createElement("div");
    header.className = "run-header";
    header.append(command, exitBadge(row.badge, row.tone));
    return header;
  }
  const details = document.createElement("details");
  details.className = "run-details";
  details.setAttribute("data-row-key", row.rowKey ?? fallbackKey);
  const summary = document.createElement("summary");
  summary.className = "run-header";
  summary.append(command, exitBadge(row.badge, row.tone));
  const output = document.createElement("pre");
  output.className = "run-output";
  setText(output, row.output);
  details.append(summary, output);
  return details;
};

const activityRowElement = (row: ActivityRow, index: number): HTMLLIElement => {
  const item = document.createElement("li");
  item.className = `activity-row activity-${row.kind}`;
  const tag = document.createElement("span");
  tag.className = "row-tag";
  setText(tag, activityTagLabels[row.kind]);
  const body = document.createElement("div");
  body.className = "row-body";
  if (row.kind === "reason") {
    for (const title of row.titles) {
      const line = document.createElement("span");
      line.className = "reason-title";
      setText(line, title);
      body.append(line);
    }
  } else if (row.kind === "message") {
    const text = document.createElement("div");
    text.className = "message-text";
    setText(text, row.text);
    body.append(text);
  } else if (row.kind === "run") {
    body.append(runRowBody(row, `row:${String(index)}`));
  } else if (row.kind === "tool") {
    const label = document.createElement("span");
    label.className = "tool-label";
    setText(label, row.label);
    body.append(label);
    if (row.detail !== "") {
      const detail = document.createElement("span");
      detail.className = "tool-detail";
      setText(detail, row.detail);
      body.append(detail);
    }
  } else if (row.kind === "turn") {
    const chip = document.createElement("span");
    chip.className = "usage-chip";
    setText(chip, row.usage);
    body.append(chip);
  } else {
    const line = document.createElement("code");
    line.className = "raw-line";
    setText(line, row.line);
    body.append(line);
  }
  item.append(tag, body);
  return item;
};

const emptyEvidenceCopy = (): HTMLElement => {
  const copy = document.createElement("p");
  copy.className = "empty-copy";
  setText(copy, "No captured output.");
  return copy;
};

const streamTextElement = (text: string): HTMLElement => {
  const pre = document.createElement("pre");
  pre.className = "stream-text";
  setText(pre, text);
  return pre;
};

type OutputTypeName = NonNullable<AgentNodeRunDto["outputType"]>;

const prettyJsonText = (text: string): string => {
  try {
    return JSON.stringify(JSON.parse(text) as unknown, null, 2);
  } catch {
    return text;
  }
};

const structuredTextElement = (text: string): HTMLElement => {
  const pre = document.createElement("pre");
  pre.className = "stream-text structured-text";
  setText(pre, text);
  return pre;
};

const nodeOutputType = (nodeRun: NodeRunDto | undefined): OutputTypeName | undefined =>
  nodeRun?.kind === "agent" ? nodeRun.outputType : undefined;

type DecisionPacket = NonNullable<BoundedOutputResponse["decisionPacket"]>;

const packetText = (className: string, text: string): HTMLParagraphElement => {
  const paragraph = document.createElement("p");
  paragraph.className = className;
  setText(paragraph, text);
  return paragraph;
};

const packetSection = (title: string, className: string): HTMLElement => {
  const section = document.createElement("section");
  section.className = `decision-packet-section ${className}`;
  const heading = document.createElement("h4");
  setText(heading, title);
  section.append(heading);
  return section;
};

const packetListItem = (title: string, detail: string, metadata?: string): HTMLLIElement => {
  const item = document.createElement("li");
  item.className = "packet-list-item";
  item.append(packetText("packet-item-title", title), packetText("packet-item-detail", detail));
  if (metadata !== undefined) {
    item.append(packetText("packet-item-meta", metadata));
  }
  return item;
};

const packetList = (): HTMLUListElement => {
  const list = document.createElement("ul");
  list.className = "packet-list";
  return list;
};

const renderDecisionPacket = (packet: DecisionPacket): HTMLElement => {
  const article = document.createElement("article");
  article.className = "decision-packet";
  article.setAttribute("aria-label", "Decision Packet V1");

  const header = document.createElement("header");
  header.className = "decision-packet-header";
  header.append(packetText("eyebrow", `Decision packet · v${String(packet.packetVersion)}`));
  const subject = document.createElement("h3");
  setText(subject, packet.subject.name);
  header.append(
    subject,
    packetText("packet-subject-type", `Business object · ${packet.subject.type}`),
    packetText("packet-objective", packet.objective),
  );

  const grid = document.createElement("div");
  grid.className = "decision-packet-grid";

  const observations = packetSection("Evidence", "packet-observations");
  observations.append(packetText("packet-evaluation", packet.evaluation.summary));
  const observationList = packetList();
  for (const observation of packet.observations) {
    const item = packetListItem(observation.id, observation.summary);
    const metrics = packetList();
    metrics.classList.add("packet-metrics");
    for (const metric of observation.metrics) {
      const value = `${String(metric.value)}${metric.unit === undefined ? "" : ` ${metric.unit}`}`;
      const reference =
        metric.source.reference === undefined ? "" : ` · ${metric.source.reference}`;
      const metricItem = packetListItem(
        metric.name,
        value,
        `${metric.source.label}${reference} · as of ${formatTimestamp(metric.asOf)} · ${metric.maturity}`,
      );
      metricItem.title = `Recorded at ${metric.asOf}`;
      metrics.append(metricItem);
    }
    item.append(metrics);
    observationList.append(item);
  }
  if (packet.evaluation.inferences.length > 0) {
    const inferenceLabel = packetText("packet-subheading", "Inferences");
    const inferenceList = packetList();
    for (const inference of packet.evaluation.inferences) {
      inferenceList.append(
        packetListItem(inference.summary, `Based on Observation: ${inference.basedOn.join(", ")}`),
      );
    }
    observations.append(observationList, inferenceLabel, inferenceList);
  } else {
    observations.append(observationList);
  }

  const guardrails = packetSection("Guardrails", "packet-guardrails");
  const guardrailList = packetList();
  for (const guardrail of packet.evaluation.guardrails) {
    const item = packetListItem(
      guardrail.name,
      guardrail.detail,
      `Evidence: ${guardrail.basedOn.join(", ")}`,
    );
    const badge = document.createElement("span");
    badge.className = `packet-status packet-status-${guardrail.status}`;
    setText(badge, guardrail.status);
    item.prepend(badge);
    guardrailList.append(item);
  }
  guardrails.append(guardrailList);

  const recommendation = packetSection("Recommendation", "packet-recommendation");
  recommendation.append(
    packetText("packet-boundary", "AI recommendation — not a Human Decision"),
    packetText("packet-item-title", packet.recommendation.summary),
    packetText("packet-item-detail", packet.recommendation.rationale),
    packetText("packet-subheading", "Alternatives"),
  );
  const alternativeList = packetList();
  for (const alternative of packet.alternatives) {
    alternativeList.append(packetListItem(alternative.summary, alternative.tradeoffs));
  }
  recommendation.append(alternativeList);

  const riskUnknown = packetSection("Risks and unknowns", "packet-risks-unknowns");
  const riskList = packetList();
  for (const risk of packet.risks) {
    riskList.append(packetListItem(`Risk · ${risk.severity}`, risk.summary));
  }
  for (const unknown of packet.unknowns) {
    riskList.append(packetListItem("Unknown", unknown.summary));
  }
  if (riskList.childElementCount === 0) {
    riskList.append(packetListItem("None declared", "The required arrays are empty."));
  }
  riskUnknown.append(riskList);

  const actions = packetSection("Actions", "packet-actions");
  actions.append(packetText("packet-boundary", "Proposed Actions only · no automatic execution"));
  const actionList = packetList();
  for (const action of packet.proposedActions) {
    actionList.append(packetListItem(action.summary, action.rationale, `ID: ${action.id}`));
  }
  actions.append(actionList);

  const review = packetSection("Review", "packet-review");
  review.append(
    packetText("packet-item-title", formatTimestamp(packet.review.recommendedAt)),
    packetText("packet-item-detail", packet.review.reason),
    packetText(
      "packet-boundary",
      "Run completion does not establish an effective business Outcome.",
    ),
  );

  grid.append(observations, guardrails, recommendation, riskUnknown, actions, review);
  article.append(header, grid);
  return article;
};

const resultContentElement = (
  response: BoundedOutputResponse,
  outputType: OutputTypeName | undefined,
): HTMLElement => {
  if (response.decisionPacket !== undefined) {
    return renderDecisionPacket(response.decisionPacket);
  }
  if (outputType === "text") {
    return renderMarkdownDocument(response.text);
  }
  if (outputType === "json" || outputType === "decision_packet") {
    return structuredTextElement(prettyJsonText(response.text));
  }
  return structuredTextElement(response.text);
};

const evidenceContentElement = (
  stream: OutputStream,
  view: EvidenceView,
  response: BoundedOutputResponse,
  outputType: OutputTypeName | undefined,
): HTMLElement => {
  if (response.text === "") {
    return emptyEvidenceCopy();
  }
  if (view === "raw" || stream === "stderr") {
    return streamTextElement(response.text);
  }
  if (stream === "result") {
    return resultContentElement(response, outputType);
  }
  const rows = activityRows(response.text, response.truncated);
  if (rows.length === 0) {
    return emptyEvidenceCopy();
  }
  const log = document.createElement("ol");
  log.className = "activity-log";
  for (const [index, row] of rows.entries()) {
    log.append(activityRowElement(row, index));
  }
  return log;
};

interface DockEvidenceEntry {
  readonly response?: BoundedOutputResponse;
  readonly error?: string;
}

const dockEvidenceCache = new Map<string, DockEvidenceEntry>();
const dockEvidenceAttemptCount = new Map<string, number>();
const dockEvidenceMaximumAttempts = 3;
const dockEvidenceRetryBaseDelayMs = 1_000;
let renderedDockSignature: string | undefined;

const dockStatusElement = ((): HTMLParagraphElement => {
  const status = document.createElement("p");
  status.id = "decision-status";
  status.className = "decision-status";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  return status;
})();

const ensureDockEvidence = (runId: string, ordinal: number): void => {
  const key = outputKey(runId, ordinal, "result");
  if (dockEvidenceCache.has(key)) {
    return;
  }
  const attempt = (dockEvidenceAttemptCount.get(key) ?? 0) + 1;
  dockEvidenceAttemptCount.set(key, attempt);
  dockEvidenceCache.set(key, {});
  apiGet<BoundedOutputResponse>(routes.output(runId, ordinal, "result"))
    .then((response) => {
      dockEvidenceCache.set(key, { response });
      dockEvidenceAttemptCount.delete(key);
      renderPresentation();
    })
    .catch((error: unknown) => {
      const failedEntry: DockEvidenceEntry = {
        error: error instanceof Error ? error.message : "Upstream evidence could not be loaded.",
      };
      dockEvidenceCache.set(key, failedEntry);
      renderPresentation();
      if (attempt >= dockEvidenceMaximumAttempts) {
        return;
      }
      window.setTimeout(
        () => {
          if (dockEvidenceCache.get(key) === failedEntry) {
            dockEvidenceCache.delete(key);
            renderPresentation();
          }
        },
        dockEvidenceRetryBaseDelayMs * 2 ** (attempt - 1),
      );
    });
};

const approvalDockContext = ():
  { readonly node: ApprovalWorkflowNodeDto; readonly nodeRun: ApprovalNodeRunDto } | undefined => {
  if (state.viewMode !== "run") {
    return undefined;
  }
  const node = selectedWorkflowNode();
  const nodeRun = selectedNodeRun();
  if (node?.kind !== "approval" || nodeRun?.kind !== "approval") {
    return undefined;
  }
  return { node, nodeRun };
};

const dockUpstreamAgents = (
  node: ApprovalWorkflowNodeDto,
  nodeRun: ApprovalNodeRunDto,
): readonly NodeRunDto[] => {
  const runs =
    nodeRun.loopNodeId === undefined
      ? currentNodeRuns()
      : new Map(
          state.runDetail?.nodes
            .filter(
              (candidate) =>
                candidate.loopNodeId === nodeRun.loopNodeId &&
                candidate.iteration === nodeRun.iteration,
            )
            .map((candidate) => [candidate.nodeId, candidate]) ?? [],
        );
  return node.dependencies
    .map((dependency) => runs.get(dependency))
    .filter(
      (run): run is NodeRunDto => run?.kind === "agent" && run.availableOutputs.includes("result"),
    );
};

const dockEvidenceSection = (runId: string, dependencyRun: NodeRunDto): HTMLElement => {
  const section = document.createElement("section");
  section.className = "dock-evidence";
  const label = document.createElement("p");
  label.className = "dock-evidence-label";
  setText(label, `Evidence · ${dependencyRun.nodeId} · result`);
  section.append(label);
  const entry = dockEvidenceCache.get(outputKey(runId, dependencyRun.ordinal, "result"));
  if (entry?.response !== undefined) {
    if (entry.response.truncated) {
      const bound = document.createElement("p");
      bound.className = "dock-evidence-bound";
      setText(
        bound,
        `Showing the newest ${formatBytes(entry.response.returnedBytes)} of ${formatBytes(entry.response.totalBytes)}.`,
      );
      section.append(bound);
    }
    section.append(
      entry.response.text === ""
        ? emptyEvidenceCopy()
        : resultContentElement(entry.response, nodeOutputType(dependencyRun)),
    );
  } else {
    const copy = document.createElement("p");
    copy.className = "empty-copy";
    setText(copy, entry?.error ?? "Loading upstream evidence…");
    section.append(copy);
  }
  return section;
};

const copyCommandRow = (command: string): HTMLElement => {
  const row = document.createElement("div");
  row.className = "copy-command";
  const code = document.createElement("code");
  setText(code, command);
  const button = document.createElement("button");
  button.type = "button";
  button.className = "copy-button";
  button.setAttribute("data-copy-command", command);
  setText(button, "Copy");
  button.addEventListener("click", () => {
    navigator.clipboard.writeText(command).then(
      () => {
        setText(button, "Copied");
      },
      () => {
        setText(button, "Copy failed");
      },
    );
  });
  row.append(code, button);
  return row;
};

const cancelCommand = (runId: string): HTMLElement => {
  const commands = document.createElement("section");
  commands.className = "run-commands";
  commands.setAttribute("aria-label", "Run cancellation command");
  const guidance = document.createElement("p");
  setText(guidance, "Fallback: cancel this run from your terminal:");
  commands.append(guidance, copyCommandRow(`kilin runs cancel ${runId}`));
  return commands;
};

const fallbackCommands = (runId: string, nodeId: string): HTMLElement => {
  const commands = document.createElement("section");
  commands.className = "approval-commands";
  commands.setAttribute("aria-label", "Approval decision commands");
  const guidance = document.createElement("p");
  setText(guidance, "Fallback: run one command in your terminal instead:");
  commands.append(guidance);
  for (const command of [
    `kilin runs approve ${runId} ${nodeId} --actor human`,
    `kilin runs reject ${runId} ${nodeId} --actor human`,
  ]) {
    commands.append(copyCommandRow(command));
  }
  return commands;
};

const decisionControls = (): HTMLElement => {
  const controls = document.createElement("div");
  controls.className = "decision-controls";
  const label = document.createElement("label");
  label.className = "decision-note-label";
  label.htmlFor = "decision-note";
  setText(label, "Note (optional)");
  const note = document.createElement("textarea");
  note.id = "decision-note";
  note.className = "decision-note";
  note.rows = 4;
  note.maxLength = maximumApprovalNoteCharacters;
  note.value = state.decisionNoteDraft;
  note.addEventListener("input", () => {
    state.decisionNoteDraft = note.value;
  });
  const actions = document.createElement("div");
  actions.className = "decision-actions";
  const reject = document.createElement("button");
  reject.type = "button";
  reject.id = "decision-reject";
  reject.className = "reject-button";
  reject.disabled = state.decisionSubmitting;
  setText(reject, "Reject");
  reject.addEventListener("click", () => {
    void submitDecision("rejected");
  });
  const approve = document.createElement("button");
  approve.type = "button";
  approve.id = "decision-approve";
  approve.className = "approve-button";
  approve.disabled = state.decisionSubmitting;
  setText(approve, "Approve");
  approve.addEventListener("click", () => {
    void submitDecision("approved");
  });
  actions.append(reject, approve);
  controls.append(label, note, actions);
  return controls;
};

const decisionRecordElement = (
  decision: NonNullable<ApprovalNodeRunDto["decision"]>,
): HTMLElement => {
  const record = document.createElement("p");
  record.className = "decision-record";
  const label = decision.decision === "approve" ? "approved" : "rejected";
  const chip = document.createElement("span");
  chip.className = `decision-chip ${label}`;
  setText(chip, label);
  const meta = document.createElement("span");
  setText(meta, `· ${decision.actor} · ${formatTimestamp(decision.decidedAt)}`);
  record.append(chip, meta);
  if (decision.note !== undefined) {
    const note = document.createElement("span");
    note.className = "decision-record-note";
    note.tabIndex = 0;
    setText(note, decision.note);
    record.append(note);
  }
  return record;
};

const withoutWaitingForApproval = (run: RunSummaryDto): RunSummaryDto => {
  if (run.waitingForApproval !== true) {
    return run;
  }
  const cleared = { ...run };
  delete cleared.waitingForApproval;
  return cleared;
};

const applyRecordedDecision = (response: ApprovalDecisionResponse): void => {
  pollController?.abort();
  const runList = state.runList;
  if (runList !== undefined) {
    state.runList = {
      ...runList,
      runs: runList.runs.map((run) =>
        run.runId === response.runId ? withoutWaitingForApproval(run) : run,
      ),
    };
  }
  const detail = state.runDetail;
  if (detail === undefined || detail.run.runId !== response.runId) {
    return;
  }
  state.runDetail = {
    ...detail,
    run: withoutWaitingForApproval(detail.run),
    lineage: {
      ...detail.lineage,
      runs: detail.lineage.runs.map((run) =>
        run.runId === response.runId ? withoutWaitingForApproval(run) : run,
      ),
    },
    nodes: detail.nodes.map((node) =>
      node.kind === "approval" && node.executionId === response.nodeId
        ? { ...node, decision: response.decision }
        : node,
    ),
  };
};

const submitDecision = async (decision: ViewerApprovalDecision): Promise<void> => {
  const runId = state.selectedRunId;
  const context = approvalDockContext();
  if (runId === undefined || context === undefined || state.decisionSubmitting) {
    return;
  }
  const note = state.decisionNoteDraft.trim();
  const body: ApprovalDecisionRequest = { decision, ...(note === "" ? {} : { note }) };
  state.decisionSubmitting = true;
  state.decisionError = undefined;
  renderPresentation();
  try {
    const response = await apiPost<ApprovalDecisionResponse>(
      routes.decision(runId, context.nodeRun.executionId),
      body,
    );
    state.decisionSubmitting = false;
    state.decisionNoteDraft = "";
    applyRecordedDecision(response);
  } catch (error: unknown) {
    state.decisionSubmitting = false;
    state.decisionError =
      error instanceof Error ? error.message : "The decision could not be recorded.";
  }
  renderPresentation();
};

const renderDecisionDock = (): void => {
  const runId = state.selectedRunId;
  const context = approvalDockContext();
  if (context === undefined || runId === undefined) {
    elements.decisionDock.hidden = true;
    elements.decisionDock.replaceChildren();
    renderedDockSignature = undefined;
    return;
  }
  elements.decisionDock.hidden = false;
  elements.evidencePlaceholder.hidden = true;
  const { node, nodeRun } = context;
  const upstream = dockUpstreamAgents(node, nodeRun);
  for (const dependencyRun of upstream) {
    ensureDockEvidence(runId, dependencyRun.ordinal);
  }
  const evidenceStates = upstream.map((dependencyRun) => {
    const key = outputKey(runId, dependencyRun.ordinal, "result");
    const entry = dockEvidenceCache.get(key);
    if (entry?.response !== undefined) {
      return `${key}:${String(entry.response.text.length)}`;
    }
    return `${key}:${entry?.error === undefined ? "loading" : "error"}`;
  });
  const statusText = state.decisionSubmitting
    ? "Recording the decision…"
    : (state.decisionError ?? (nodeRun.decision === undefined ? "" : "Decision recorded."));
  const signature = JSON.stringify([
    runId,
    nodeRun.executionId,
    node.question,
    nodeRun.status,
    nodeRun.decision?.decision ?? "",
    nodeRun.decision?.decidedAt ?? "",
    nodeRun.deadlineAt ?? "",
    state.decisionSubmitting,
    state.decisionError ?? "",
    evidenceStates,
  ]);
  if (renderedDockSignature === signature) {
    setText(dockStatusElement, statusText);
    return;
  }
  renderedDockSignature = signature;

  const header = document.createElement("header");
  header.className = "dock-header";
  const headline = document.createElement("div");
  headline.className = "dock-headline";
  const eyebrow = document.createElement("p");
  eyebrow.className = "eyebrow";
  setText(eyebrow, "◇ Approval gate");
  const question = document.createElement("h3");
  question.id = "decision-heading";
  question.className = "dock-question";
  setText(question, node.question);
  headline.append(eyebrow, question);
  header.append(headline);
  if (nodeRun.deadlineAt !== undefined) {
    const deadline = document.createElement("p");
    deadline.className = "dock-deadline";
    if (nodeRun.decision === undefined && nodeRun.status === "waiting_for_approval") {
      deadline.dataset.liveDeadline = nodeRun.deadlineAt;
      deadline.dataset.liveDeadlineLabel = "Deadline";
    } else {
      setText(deadline, `Deadline ${formatTimestamp(nodeRun.deadlineAt)}`);
    }
    header.append(deadline);
  }

  const body = document.createElement("div");
  body.className = "dock-body";
  for (const dependencyRun of upstream) {
    body.append(dockEvidenceSection(runId, dependencyRun));
  }
  if (upstream.length === 0) {
    const copy = document.createElement("p");
    copy.className = "empty-copy";
    setText(copy, "This gate has no upstream evidence to display.");
    body.append(copy);
  }
  if (nodeRun.decision === undefined && nodeRun.status === "waiting_for_approval") {
    body.append(fallbackCommands(runId, nodeRun.executionId));
  }

  const footer = document.createElement("div");
  footer.className = "decision-footer";
  if (nodeRun.decision !== undefined) {
    footer.append(decisionRecordElement(nodeRun.decision));
  } else if (nodeRun.status === "waiting_for_approval") {
    footer.append(decisionControls());
  } else {
    const copy = document.createElement("p");
    copy.className = "empty-copy";
    setText(copy, `This gate is ${statusLabel(nodeRun.status).toLowerCase()}.`);
    footer.append(copy);
  }
  setText(dockStatusElement, statusText);
  footer.append(dockStatusElement);
  elements.decisionDock.replaceChildren(header, body, footer);
};

const waitingApprovalNodeRun = (): ApprovalNodeRunDto | undefined => {
  const detail = state.runDetail;
  if (state.viewMode !== "run" || detail?.run.waitingForApproval !== true) {
    return undefined;
  }
  return detail.nodes.find(
    (node): node is ApprovalNodeRunDto =>
      node.kind === "approval" &&
      node.status === "waiting_for_approval" &&
      node.decision === undefined,
  );
};

const renderDecisionNeededBanner = (): void => {
  const banner = elements.decisionNeededBanner;
  const detail = state.runDetail;
  const waitingNode = waitingApprovalNodeRun();
  if (detail === undefined || waitingNode === undefined) {
    banner.hidden = true;
    banner.replaceChildren();
    return;
  }
  banner.hidden = false;
  banner.setAttribute("data-run-id", detail.run.runId);
  banner.setAttribute("data-graph-node-id", waitingNode.loopNodeId ?? waitingNode.nodeId);
  const absoluteDeadline =
    waitingNode.deadlineAt === undefined ? undefined : formatTimestamp(waitingNode.deadlineAt);
  banner.setAttribute(
    "aria-label",
    absoluteDeadline === undefined
      ? "Decision needed"
      : `Decision needed, deadline ${absoluteDeadline}`,
  );
  const glyph = document.createElement("span");
  glyph.setAttribute("aria-hidden", "true");
  setText(glyph, "◇");
  const label = document.createElement("span");
  setText(label, "Decision needed");
  const children: HTMLElement[] = [glyph, label];
  if (waitingNode.deadlineAt !== undefined) {
    const countdown = document.createElement("span");
    countdown.className = "decision-needed-countdown";
    countdown.dataset.liveDeadline = waitingNode.deadlineAt;
    countdown.dataset.liveDeadlineLabel = "Deadline";
    children.push(countdown);
  }
  banner.replaceChildren(...children);
};

interface ApprovalGateSnapshot {
  readonly runId: string;
  readonly executionId: string;
  readonly nodeId: string;
  readonly deadlineAt: string | undefined;
}

let approvalGateSnapshot: ApprovalGateSnapshot | undefined;

const announceApprovalGateTransitions = (): void => {
  const detail = state.runDetail;
  if (state.viewMode !== "run" || detail === undefined) {
    return;
  }
  const waitingNode = waitingApprovalNodeRun();
  const current: ApprovalGateSnapshot | undefined =
    waitingNode === undefined
      ? undefined
      : {
          runId: detail.run.runId,
          executionId: waitingNode.executionId,
          nodeId: waitingNode.nodeId,
          deadlineAt: waitingNode.deadlineAt,
        };
  const previous = approvalGateSnapshot;
  approvalGateSnapshot = current;
  if (current !== undefined) {
    if (
      previous === undefined ||
      previous.runId !== current.runId ||
      previous.executionId !== current.executionId ||
      previous.deadlineAt !== current.deadlineAt
    ) {
      setText(
        elements.approvalStatus,
        current.deadlineAt === undefined
          ? `Decision needed for gate ${current.nodeId}.`
          : `Decision needed for gate ${current.nodeId}, deadline ${formatTimestamp(current.deadlineAt)}.`,
      );
    }
    return;
  }
  if (previous !== undefined && state.selectedRunId === previous.runId) {
    setText(
      elements.approvalStatus,
      `Approval gate ${previous.nodeId} is no longer waiting for a decision.`,
    );
  }
};

const resetEvidencePanel = (content: Node | string): void => {
  renderedEvidence = undefined;
  elements.outputPanel.replaceChildren(content);
  elements.evidenceBanner.hidden = true;
};

const showEvidenceError = (key: string, message: string): void => {
  if (
    renderedEvidence?.kind === "failure" &&
    renderedEvidence.key === key &&
    renderedEvidence.message === message
  ) {
    return;
  }
  const failure = document.createElement("div");
  failure.className = "evidence-error";
  failure.setAttribute("role", "alert");
  const description = document.createElement("p");
  description.className = "failure-copy";
  setText(description, message);
  const retry = document.createElement("button");
  retry.type = "button";
  retry.className = "quiet-button evidence-retry";
  setText(retry, "Retry");
  retry.addEventListener("click", () => {
    void selectOutput(state.selectedOutputStream, false);
  });
  failure.append(description, retry);
  resetEvidencePanel(failure);
  renderedEvidence = { kind: "failure", key, message };
  if (document.activeElement === elements.outputPanel) {
    retry.focus();
  }
};

const renderEvidenceSelection = (selection: OutputSelection, liveNode: boolean): void => {
  const response = selection.response;
  if (response.truncated) {
    const omitsPartialLine = state.evidenceView === "rendered" && response.stream === "stdout";
    setText(
      elements.evidenceBanner,
      `Showing the newest ${formatBytes(response.returnedBytes)} of ${formatBytes(response.totalBytes)}.${omitsPartialLine ? " The leading partial line is omitted here." : ""}`,
    );
    elements.evidenceBanner.hidden = false;
  } else {
    elements.evidenceBanner.hidden = true;
  }
  const liveSuffix = liveNode ? " · live tail" : "";
  setText(
    elements.outputMeta,
    response.totalBytes === 0 && liveNode
      ? `Waiting for the first output${liveSuffix}.`
      : `${formatBytes(response.returnedBytes)} of ${formatBytes(response.totalBytes)}${liveSuffix}.`,
  );
  if (
    renderedEvidence?.kind === "stream" &&
    renderedEvidence.key === selection.key &&
    renderedEvidence.view === state.evidenceView &&
    renderedEvidence.text === response.text
  ) {
    return;
  }
  const openRowKeys = new Set(
    Array.from(elements.outputPanel.querySelectorAll("details[open]"))
      .map((details) => details.getAttribute("data-row-key"))
      .filter((rowKey): rowKey is string => rowKey !== null),
  );
  let content: HTMLElement;
  try {
    content = evidenceContentElement(
      response.stream,
      state.evidenceView,
      response,
      nodeOutputType(selectedNodeRun()),
    );
  } catch {
    content = streamTextElement(response.text);
  }
  elements.outputPanel.replaceChildren(content);
  for (const details of Array.from(
    elements.outputPanel.querySelectorAll<HTMLDetailsElement>("details"),
  )) {
    const rowKey = details.getAttribute("data-row-key");
    if (rowKey !== null && openRowKeys.has(rowKey)) {
      details.open = true;
    }
  }
  renderedEvidence = {
    kind: "stream",
    key: selection.key,
    view: state.evidenceView,
    text: response.text,
  };
  if ((liveNode || selection.fetchedWhileRunning) && state.followTail) {
    elements.outputPanel.scrollTop = elements.outputPanel.scrollHeight;
  }
};

const evidencePlaceholderCopy = (): string => {
  if (state.viewMode !== "run") {
    return "Select a stored run to inspect captured evidence.";
  }
  if (selectedWorkflowNode()?.kind === "loop") {
    return "A loop node does not capture evidence. Select a body execution under Loop iterations.";
  }
  return "This node has no captured evidence.";
};

const renderOutput = (): void => {
  const focusTarget = captureViewerFocus();
  const nodeRun = selectedNodeRun();
  const availableOutputs = nodeAvailableOutputs(nodeRun);
  const hasOutput =
    state.viewMode === "run" && nodeRun !== undefined && availableOutputs.length > 0;
  elements.outputSection.hidden = !hasOutput;
  elements.evidencePlaceholder.hidden = hasOutput;
  elements.outputTabs.replaceChildren();
  if (!hasOutput || state.selectedRunId === undefined) {
    setText(elements.evidencePlaceholder, evidencePlaceholderCopy());
    elements.outputPanel.replaceChildren();
    elements.outputMeta.textContent = "";
    elements.evidenceBanner.hidden = true;
    renderedEvidence = undefined;
    restoreViewerFocus(focusTarget);
    writeRunLocationHash();
    return;
  }
  const orderedStreams = streamPresentationOrder.filter((stream) =>
    availableOutputs.includes(stream),
  );
  if (!orderedStreams.includes(state.selectedOutputStream)) {
    state.selectedOutputStream = orderedStreams[0] ?? "stdout";
  }
  for (const stream of orderedStreams) {
    const tab = document.createElement("button");
    tab.id = `output-tab-${stream}`;
    tab.className = "output-tab";
    tab.type = "button";
    tab.setAttribute("data-output-stream", stream);
    tab.setAttribute("role", "tab");
    tab.setAttribute("aria-controls", "output-panel");
    tab.setAttribute("aria-selected", String(stream === state.selectedOutputStream));
    tab.setAttribute("tabindex", stream === state.selectedOutputStream ? "0" : "-1");
    setText(tab, streamLabels[stream]);
    tab.addEventListener("click", () => {
      void selectOutput(stream, false);
    });
    tab.addEventListener("keydown", handleOutputTabKeydown);
    elements.outputTabs.append(tab);
  }
  elements.evidenceViewRendered.setAttribute(
    "aria-pressed",
    String(state.evidenceView === "rendered"),
  );
  elements.evidenceViewRaw.setAttribute("aria-pressed", String(state.evidenceView === "raw"));
  elements.outputPanel.setAttribute("aria-labelledby", `output-tab-${state.selectedOutputStream}`);
  const key = outputKey(state.selectedRunId, nodeRun.ordinal, state.selectedOutputStream);
  if (state.output?.key === key) {
    renderEvidenceSelection(state.output, nodeRun.kind === "agent" && nodeRun.status === "running");
  } else if (state.outputError !== undefined) {
    showEvidenceError(key, state.outputError);
    setText(
      elements.outputMeta,
      "If Retry fails again, examine the terminal output, then run kilin ui again.",
    );
  } else {
    resetEvidencePanel("Loading captured output…");
    elements.outputMeta.textContent = "";
  }
  restoreViewerFocus(focusTarget);
  writeRunLocationHash();
};

const handleOutputTabKeydown = (event: KeyboardEvent): void => {
  const tabs = Array.from(elements.outputTabs.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
  const currentIndex = tabs.findIndex((tab) => tab === event.currentTarget);
  if (currentIndex === -1 || tabs.length === 0) {
    return;
  }
  let nextIndex: number | undefined;
  if (event.key === "ArrowRight") {
    nextIndex = (currentIndex + 1) % tabs.length;
  } else if (event.key === "ArrowLeft") {
    nextIndex = (currentIndex - 1 + tabs.length) % tabs.length;
  } else if (event.key === "Home") {
    nextIndex = 0;
  } else if (event.key === "End") {
    nextIndex = tabs.length - 1;
  }
  if (nextIndex === undefined) {
    return;
  }
  event.preventDefault();
  const stream = tabs[nextIndex]?.getAttribute("data-output-stream");
  if (isOutputStream(stream)) {
    void selectOutput(stream, true);
  }
};

const renderPresentation = (): void => {
  const focusTarget = captureViewerFocus();
  ensureNodeSelection();
  const graph = currentGraph();
  const run = state.runDetail?.run;
  if (state.viewMode === "current") {
    const definitionState = state.currentWorkflow?.state ?? "";
    setText(elements.graphContext, "Current workflow");
    setText(elements.graphHeading, graph?.name ?? "Workflow diagnostics");
    renderStatusChip(elements.graphStatus, definitionState, definitionLabel(definitionState));
  } else {
    setText(elements.graphContext, "Stored revision");
    setText(elements.graphHeading, graph?.name ?? "Run workflow");
    if (run === undefined) {
      renderStatusChip(elements.graphStatus, "", "Loading");
    } else {
      const status = presentedRunStatus(run);
      renderStatusChip(elements.graphStatus, status, statusLabel(status));
    }
  }
  if (graph !== undefined) {
    setText(elements.appTitle, graph.name);
  }
  renderHistory();
  renderDiagnostics();
  renderGraph();
  renderRunInspector();
  renderNodeInspector();
  renderLoopIterations();
  renderLineage();
  renderOutput();
  renderDecisionDock();
  renderDecisionNeededBanner();
  announceApprovalGateTransitions();
  updateLiveElements();
  renderGraphExpansion();
  restoreViewerFocus(focusTarget);
};

const resetExecutionSelection = (preferredStream?: OutputStream): readonly OutputStream[] => {
  outputRequestGeneration += 1;
  state.output = undefined;
  state.outputError = undefined;
  state.outputLoading = false;
  state.followTail = true;
  state.decisionNoteDraft = "";
  state.decisionError = undefined;
  state.decisionSubmitting = false;
  const nodeRun = selectedNodeRun();
  const availableOutputs = nodeAvailableOutputs(nodeRun);
  const fallbackStream = availableOutputs.includes("result") ? "result" : "stdout";
  state.selectedOutputStream =
    preferredStream !== undefined && availableOutputs.includes(preferredStream)
      ? preferredStream
      : fallbackStream;
  renderPresentation();
  return availableOutputs;
};

interface NodeSelectionTarget {
  readonly nodeId: string;
  readonly executionId?: string;
}

const applyNodeSelection = (
  target: NodeSelectionTarget,
  restoreGraphFocus: boolean,
  preferredStream?: OutputStream,
): void => {
  state.selectedNodeId = target.nodeId;
  state.selectedExecutionId = target.executionId ?? target.nodeId;
  const availableOutputs = resetExecutionSelection(preferredStream);
  if (restoreGraphFocus) {
    const cards = graphCards();
    const index = graphCardIndex(cards, selectedGraphCardKey());
    if (index >= 0) {
      updateGraphRovingFocus(cards, index);
    }
  }
  if (availableOutputs.length > 0) {
    void selectOutput(state.selectedOutputStream, false);
  }
};

const selectNode = (nodeId: string, restoreGraphFocus: boolean): void => {
  applyNodeSelection({ nodeId }, restoreGraphFocus);
};

const selectLoopExecution = (
  loopNodeId: string,
  executionId: string,
  restoreGraphFocus: boolean,
): void => {
  applyNodeSelection({ nodeId: loopNodeId, executionId }, restoreGraphFocus);
};

const selectOutput = async (
  stream: OutputStream,
  focusTab: boolean,
  silentRefresh = false,
): Promise<void> => {
  const runId = state.selectedRunId;
  const nodeRun = selectedNodeRun();
  if (
    runId === undefined ||
    nodeRun === undefined ||
    !nodeAvailableOutputs(nodeRun).includes(stream)
  ) {
    return;
  }
  const requestGeneration = outputRequestGeneration + 1;
  outputRequestGeneration = requestGeneration;
  const fetchedWhileRunning = nodeRun.kind === "agent" && nodeRun.status === "running";
  state.selectedOutputStream = stream;
  if (!silentRefresh) {
    state.outputLoading = true;
    state.output = undefined;
    state.outputError = undefined;
    state.followTail = true;
    renderOutput();
    if (focusTab) {
      requiredElement(`#output-tab-${stream}`, HTMLButtonElement).focus();
    }
  }
  const key = outputKey(runId, nodeRun.ordinal, stream);
  const isCurrentRequest = (): boolean =>
    outputRequestGeneration === requestGeneration &&
    state.selectedRunId === runId &&
    selectedNodeRun()?.ordinal === nodeRun.ordinal &&
    state.selectedOutputStream === stream;
  try {
    const response = await apiGet<BoundedOutputResponse>(
      routes.output(runId, nodeRun.ordinal, stream),
    );
    if (isCurrentRequest()) {
      state.output = { key, response, fetchedWhileRunning };
      state.outputError = undefined;
    }
  } catch (error: unknown) {
    if (isCurrentRequest() && !silentRefresh) {
      state.outputError =
        error instanceof Error ? error.message : "Captured output could not be loaded.";
    }
  } finally {
    if (isCurrentRequest()) {
      state.outputLoading = false;
      renderOutput();
      if (focusTab) {
        document.querySelector<HTMLButtonElement>(`#output-tab-${stream}`)?.focus();
      }
    }
  }
};

const maybeRefreshEvidence = (retryFailedRead = false): void => {
  if (state.viewMode !== "run" || state.selectedRunId === undefined || state.outputLoading) {
    return;
  }
  const nodeRun = selectedNodeRun();
  if (nodeRun?.kind !== "agent") {
    return;
  }
  if (!nodeAvailableOutputs(nodeRun).includes(state.selectedOutputStream)) {
    return;
  }
  const key = outputKey(state.selectedRunId, nodeRun.ordinal, state.selectedOutputStream);
  if (state.output?.key !== key) {
    if (retryFailedRead || state.outputError === undefined) {
      void selectOutput(state.selectedOutputStream, false);
    }
    return;
  }
  if (nodeRun.status === "running" || state.output.fetchedWhileRunning) {
    void selectOutput(state.selectedOutputStream, false, true);
  }
};

const definitionViewHash = "current";

const parseHashSelection = (): HashSelection | undefined => {
  const fragment = window.location.hash.slice(1);
  if (fragment === definitionViewHash) {
    return { kind: "definition" };
  }
  const params = new URLSearchParams(fragment);
  const runId = params.get("run");
  if (runId === null || runId === "") {
    return undefined;
  }
  const nodeId = params.get("node");
  const stream = params.get("stream");
  const view = params.get("view");
  return {
    kind: "run",
    runId,
    ...(nodeId === null || nodeId === "" ? {} : { nodeId }),
    ...(isOutputStream(stream) ? { stream } : {}),
    ...(view === "rendered" || view === "raw" ? { view } : {}),
  };
};

const replaceLocationHash = (fragment: string): void => {
  if (window.location.hash === `#${fragment}`) {
    return;
  }
  window.history.replaceState(null, "", `#${fragment}`);
};

const writeRunLocationHash = (): void => {
  if (state.viewMode !== "run" || state.selectedRunId === undefined) {
    return;
  }
  const params = new URLSearchParams({ run: state.selectedRunId });
  if (state.selectedNodeId !== undefined) {
    params.set("node", state.selectedNodeId);
  }
  params.set("stream", state.selectedOutputStream);
  params.set("view", state.evidenceView);
  replaceLocationHash(params.toString());
};

const nodeSelectionTarget = (nodeRun: NodeRunDto): NodeSelectionTarget => ({
  nodeId: nodeRun.loopNodeId ?? nodeRun.nodeId,
  executionId: nodeRun.executionId,
});

const statusExplainingTarget = (
  detail: ScopedRunDetailResponse,
): NodeSelectionTarget | undefined => {
  const waiting = detail.nodes.find((node) => node.status === "waiting_for_approval");
  if (waiting !== undefined) {
    return nodeSelectionTarget(waiting);
  }
  const runStatus = detail.run.status;
  if (runStatus === "failed" || runStatus === "interrupted") {
    const failed =
      detail.nodes.find((node) => sameFailure(node.failure, detail.run.failure)) ??
      detail.nodes.find((node) => node.status === "failed" || node.status === "interrupted");
    if (failed !== undefined) {
      return nodeSelectionTarget(failed);
    }
  }
  if (runStatus === "running") {
    const running = detail.nodes.find((node) => node.status === "running");
    if (running !== undefined) {
      return nodeSelectionTarget(running);
    }
  }
  return undefined;
};

const restoredNodeTarget = (
  detail: ScopedRunDetailResponse,
  nodeId: string | undefined,
): NodeSelectionTarget | undefined => {
  if (nodeId === undefined) {
    return undefined;
  }
  return detail.revision.workflow.nodes.some((node) => node.id === nodeId) ? { nodeId } : undefined;
};

const firstNodeTarget = (detail: ScopedRunDetailResponse): NodeSelectionTarget | undefined => {
  const firstNodeId = detail.revision.workflow.executionOrder[0];
  return firstNodeId === undefined ? undefined : { nodeId: firstNodeId };
};

interface InitialRunSelection {
  readonly restore: HashRunSelection | undefined;
}

const selectRun = async (runId: string, initial?: InitialRunSelection): Promise<void> => {
  const requestGeneration = runDetailRequestGeneration + 1;
  runDetailRequestGeneration = requestGeneration;
  outputRequestGeneration += 1;
  state.viewMode = "run";
  state.selectedRunId = runId;
  state.runDetail = undefined;
  state.selectedNodeId = undefined;
  state.selectedExecutionId = undefined;
  state.output = undefined;
  state.outputError = undefined;
  state.outputLoading = false;
  state.decisionNoteDraft = "";
  state.decisionError = undefined;
  state.decisionSubmitting = false;
  dockEvidenceCache.clear();
  approvalGateSnapshot = undefined;
  renderPresentation();
  setText(elements.connectionStatus, "Loading stored revision…");
  try {
    const detail = await apiGet<ScopedRunDetailResponse>(routes.run(runId));
    if (runDetailRequestGeneration === requestGeneration && state.selectedRunId === runId) {
      state.runDetail = detail;
      state.pollFailures = 0;
      setText(elements.connectionStatus, "Live");
      const restore = initial?.restore;
      if (restore?.view !== undefined) {
        state.evidenceView = restore.view;
      }
      const target =
        restoredNodeTarget(detail, restore?.nodeId) ??
        statusExplainingTarget(detail) ??
        firstNodeTarget(detail);
      if (target === undefined) {
        state.selectedNodeId = undefined;
        state.selectedExecutionId = undefined;
        renderPresentation();
      } else {
        applyNodeSelection(target, true, restore?.stream);
      }
      if (initial !== undefined) {
        const status = presentedRunStatus(detail.run);
        const nodeCopy = target === undefined ? "" : ` Selected node ${target.nodeId}.`;
        setText(
          elements.selectionAnnouncement,
          `Opened run ${detail.run.runId}, ${formatStatus(status)}.${nodeCopy}`,
        );
      }
    }
  } catch (error: unknown) {
    if (runDetailRequestGeneration === requestGeneration && state.selectedRunId === runId) {
      const message =
        error instanceof Error ? error.message : "The selected run could not be loaded.";
      setText(elements.connectionStatus, message);
    }
  }
};

const selectCurrentWorkflow = (): void => {
  runDetailRequestGeneration += 1;
  outputRequestGeneration += 1;
  state.viewMode = "current";
  state.selectedRunId = undefined;
  state.runDetail = undefined;
  state.selectedNodeId = undefined;
  state.selectedExecutionId = undefined;
  state.output = undefined;
  state.outputError = undefined;
  state.outputLoading = false;
  state.decisionNoteDraft = "";
  state.decisionError = undefined;
  state.decisionSubmitting = false;
  dockEvidenceCache.clear();
  approvalGateSnapshot = undefined;
  renderPresentation();
  replaceLocationHash(definitionViewHash);
};

const applyInitialSelectionOnce = (): void => {
  if (!initialSelectionPending) {
    return;
  }
  initialSelectionPending = false;
  const parsed = parseHashSelection();
  if (parsed?.kind === "definition") {
    return;
  }
  const runs = state.runList?.runs ?? [];
  const restore =
    parsed !== undefined && runs.some((run) => run.runId === parsed.runId) ? parsed : undefined;
  const targetRunId =
    restore?.runId ??
    (
      runs.find((run) => run.waitingForApproval === true) ??
      runs.find((run) => run.status === "running") ??
      runs[0]
    )?.runId;
  if (targetRunId === undefined) {
    return;
  }
  void selectRun(targetRunId, { restore });
};

const clearPollTimer = (): void => {
  if (pollTimer !== undefined) {
    window.clearTimeout(pollTimer);
    pollTimer = undefined;
  }
};

const schedulePoll = (): void => {
  clearPollTimer();
  if (document.hidden || state.session === undefined) {
    return;
  }
  const baseInterval = Math.max(minimumPollIntervalMs, state.session.pollIntervalMs);
  const backoff = Math.min(baseInterval * 2 ** state.pollFailures, maximumBackoffMs);
  pollTimer = window.setTimeout(() => {
    void pollViewer();
  }, backoff);
};

const pollViewer = async (): Promise<void> => {
  if (pollInProgress || document.hidden || state.session === undefined) {
    schedulePoll();
    return;
  }
  pollInProgress = true;
  pollController = new AbortController();
  const selectedRunId = state.viewMode === "run" ? state.selectedRunId : undefined;
  const detailRequestGeneration =
    selectedRunId === undefined ? undefined : runDetailRequestGeneration + 1;
  if (detailRequestGeneration !== undefined) {
    runDetailRequestGeneration = detailRequestGeneration;
  }
  try {
    const workflowPromise = apiGet<CurrentWorkflowResponse>(routes.workflow, pollController.signal);
    const runsPromise = apiGet<ScopedRunListResponse>(routes.runs, pollController.signal);
    const detailPromise =
      selectedRunId === undefined
        ? Promise.resolve<ScopedRunDetailResponse | undefined>(undefined)
        : apiGet<ScopedRunDetailResponse>(routes.run(selectedRunId), pollController.signal);
    const [workflow, runList, detail] = await Promise.all([
      workflowPromise,
      runsPromise,
      detailPromise,
    ]);
    state.currentWorkflow = workflow;
    state.runList = runList;
    if (
      detail !== undefined &&
      detailRequestGeneration === runDetailRequestGeneration &&
      state.viewMode === "run" &&
      state.selectedRunId === selectedRunId
    ) {
      state.runDetail = detail;
    }
    state.pollFailures = 0;
    setText(elements.connectionStatus, "Live");
    elements.appShell.setAttribute("aria-busy", "false");
    renderPresentation();
    maybeRefreshEvidence();
    applyInitialSelectionOnce();
  } catch (error: unknown) {
    if (!(error instanceof DOMException && error.name === "AbortError")) {
      state.pollFailures += 1;
      const message = error instanceof Error ? error.message : "Refresh failed.";
      setText(elements.connectionStatus, `${message} Retrying…`);
    }
  } finally {
    pollInProgress = false;
    pollController = undefined;
    schedulePoll();
  }
};

const refreshNow = (): void => {
  state.pollFailures = 0;
  setText(elements.connectionStatus, "Refreshing…");
  maybeRefreshEvidence(true);
  void pollViewer();
};

const launchToken = (): string | undefined => {
  if (window.location.hash.length <= 1) {
    return undefined;
  }
  return new URLSearchParams(window.location.hash.slice(1)).get("token") ?? undefined;
};

const establishSession = async (): Promise<SessionBootstrapResponse> => {
  const token = launchToken();
  if (token === undefined) {
    return postSession(routes.resumeSession, {});
  }
  window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
  return postSession(routes.session, { token });
};

const showFatalError = (error: unknown): void => {
  const message = error instanceof Error ? error.message : "The viewer could not start.";
  elements.appShell.hidden = true;
  elements.fatalError.hidden = false;
  setText(elements.fatalErrorMessage, `${message} Close this tab and run kilin ui again.`);
};

const start = async (): Promise<void> => {
  state.session = await establishSession();
  await pollViewer();
};

const setEvidenceView = (view: EvidenceView): void => {
  if (state.evidenceView === view) {
    return;
  }
  state.evidenceView = view;
  renderOutput();
};

window.setInterval(updateLiveElements, liveTickIntervalMs);

elements.currentWorkflowButton.addEventListener("click", selectCurrentWorkflow);
elements.refreshButton.addEventListener("click", refreshNow);
elements.decisionNeededBanner.addEventListener("click", () => {
  const waitingNode = waitingApprovalNodeRun();
  if (waitingNode === undefined) {
    return;
  }
  applyNodeSelection(nodeSelectionTarget(waitingNode), true);
  const approve = elements.decisionDock.querySelector<HTMLButtonElement>("#decision-approve");
  if (approve !== null) {
    approve.focus();
    return;
  }
  elements.decisionDock.querySelector<HTMLButtonElement>("button")?.focus();
});
elements.graphExpandToggle.addEventListener("click", () => {
  state.graphExpanded = !state.graphExpanded;
  renderGraphExpansion();
});
elements.evidenceViewRendered.addEventListener("click", () => {
  setEvidenceView("rendered");
});
elements.evidenceViewRaw.addEventListener("click", () => {
  setEvidenceView("raw");
});
elements.outputPanel.addEventListener("scroll", () => {
  const panel = elements.outputPanel;
  state.followTail = panel.scrollTop + panel.clientHeight >= panel.scrollHeight - 24;
});

document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    clearPollTimer();
    pollController?.abort();
    return;
  }
  void pollViewer();
});

window.addEventListener("pagehide", () => {
  clearPollTimer();
  pollController?.abort();
});

void start().catch(showFatalError);
