const elements = {
  cardBoard: document.querySelector("[data-card-board]"),
  cardGrid: document.querySelector("[data-card-grid]"),
  messages: document.querySelector("[data-messages]"),
  flowList: document.querySelector("[data-flow-list]"),
  totalProgress: document.querySelector("[data-total-progress]"),
  selectedTask: document.querySelector("[data-selected-task]"),
  runStatus: document.querySelector("[data-run-status]"),
  runStatusText: document.querySelector("[data-run-status-text]"),
  instruction: document.querySelector("[data-instruction]"),
  stop: document.querySelector("[data-stop]"),
  submit: document.querySelector("[data-submit]"),
  testRun: document.querySelector("[data-test-run]"),
  composer: document.querySelector("[data-composer]"),
  rail: document.querySelector("[data-rail]"),
};

const statusText = {
  idle: "未启动",
  loading: "等待",
  running: "执行中",
  stopping: "停止中",
  complete: "完成",
  fail: "失败",
  stopped: "已停止",
};

const statusSymbol = {
  idle: "○",
  loading: "○",
  running: "…",
  stopping: "!",
  complete: "✓",
  fail: "×",
  stopped: "!",
};

const cardUiState = new Map();
let latestSnapshot;
let selectedTaskId;
let requestPending = false;
let policeWorkflowConfig;
let policeWorkflowPromise;

setupControlPanel();
setupComposer();
setupCardColumns();
connectEvents();
void initializePoliceWorkflow();
updateActionState();

function setupControlPanel() {
  for (const button of document.querySelectorAll("[data-toggle-control]")) {
    button.addEventListener("click", () => {
      if (button instanceof HTMLElement && button.dataset.dragged === "true") {
        button.dataset.dragged = "false";
        return;
      }
      document.body.classList.toggle("control-collapsed");
    });
  }

  if (!(elements.rail instanceof HTMLElement)) {
    return;
  }

  let dragOffsetY = 0;
  let startX = 0;
  let startY = 0;

  elements.rail.addEventListener("pointerdown", (event) => {
    elements.rail.setPointerCapture(event.pointerId);
    elements.rail.dataset.dragged = "false";
    startX = event.clientX;
    startY = event.clientY;
    dragOffsetY = event.clientY - elements.rail.getBoundingClientRect().top;
  });

  elements.rail.addEventListener("pointermove", (event) => {
    if (!elements.rail.hasPointerCapture(event.pointerId)) {
      return;
    }
    const minTop = 70;
    const maxTop = window.innerHeight - elements.rail.offsetHeight - 18;
    const nextTop = Math.max(minTop, Math.min(maxTop, event.clientY - dragOffsetY));
    if (Math.abs(event.clientY - startY) > 3 || Math.abs(event.clientX - startX) > 8) {
      elements.rail.dataset.dragged = "true";
    }
    document.documentElement.style.setProperty("--rail-top", `${nextTop}px`);
  });

  elements.rail.addEventListener("pointerup", (event) => {
    if (Math.abs(event.clientX - startX) <= 8) {
      return;
    }
    document.body.classList.toggle("control-edge-left", event.clientX < window.innerWidth / 2);
    document.body.classList.toggle("control-edge-right", event.clientX >= window.innerWidth / 2);
  });
}

function setupComposer() {
  if (window.matchMedia("(max-width: 760px)").matches) {
    document.body.classList.add("control-collapsed");
  }

  if (elements.composer instanceof HTMLFormElement) {
    elements.composer.addEventListener("submit", (event) => {
      event.preventDefault();
      const instruction = elements.instruction instanceof HTMLTextAreaElement ? elements.instruction.value.trim() : "";
      if (!latestSnapshot || instruction.length === 0 || requestPending) {
        return;
      }
      const runPath = latestSnapshot.run.status === "idle" ? "/runs/start" : "/runs/replace";
      void postRun(runPath, instruction);
    });
  }

  if (elements.stop instanceof HTMLButtonElement) {
    elements.stop.addEventListener("click", () => {
      if (requestPending) {
        return;
      }
      void postStop();
    });
  }

  if (elements.testRun instanceof HTMLButtonElement) {
    elements.testRun.addEventListener("click", () => {
      const instruction = elements.instruction instanceof HTMLTextAreaElement ? elements.instruction.value.trim() : "";
      if (instruction.length === 0) {
        window.alert("请输入指令后再测试。");
        return;
      }
      if (requestPending) {
        return;
      }
      void startPoliceWorkflowTest(instruction);
    });
  }

  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      collapseMaximizedCards();
    }
  });
}

function setupCardColumns() {
  if (!(elements.cardBoard instanceof HTMLElement)) {
    return;
  }
  const resizeObserver = new ResizeObserver(([entry]) => {
    const width = entry?.contentRect.width ?? elements.cardBoard.clientWidth;
    const columns = width >= 1060 ? 3 : width >= 700 ? 2 : 1;
    document.documentElement.style.setProperty("--card-columns", String(columns));
  });
  resizeObserver.observe(elements.cardBoard);
}

async function postRun(path, instruction) {
  setRequestPending(true);
  try {
    const payload = { steps: getSelectedStepsPayload(), userInstruction: instruction };
    await performRunRequest(path, payload);
  } catch (error) {
    renderLocalError(error instanceof Error ? error.message : String(error));
  } finally {
    setRequestPending(false);
  }
}

async function startPoliceWorkflowTest(instruction) {
  setRequestPending(true);
  try {
    const workflow = await loadPoliceWorkflowConfig();
    await performRunRequest("/runs/start", {
      steps: workflow.steps,
      userInstruction: instruction,
    });
  } catch (error) {
    renderLocalError(error instanceof Error ? error.message : String(error));
  } finally {
    setRequestPending(false);
  }
}

async function postStop() {
  setRequestPending(true);
  try {
    const response = await fetch("/runs/stop", { method: "POST" });
    if (!response.ok) {
      renderLocalError(`停止失败：${response.status}`);
    }
  } catch (error) {
    renderLocalError(error instanceof Error ? error.message : String(error));
  } finally {
    setRequestPending(false);
  }
}

async function performRunRequest(path, payload) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    renderLocalError(`请求失败：${response.status}`);
  }
}

async function initializePoliceWorkflow() {
  try {
    const workflow = await loadPoliceWorkflowConfig();
    if (elements.instruction instanceof HTMLTextAreaElement && elements.instruction.value.trim().length === 0) {
      elements.instruction.value = workflow.defaultUserInstruction;
    }
  } catch (error) {
    renderLocalError(error instanceof Error ? error.message : String(error));
  } finally {
    updateActionState();
  }
}

async function loadPoliceWorkflowConfig() {
  if (policeWorkflowConfig) {
    return policeWorkflowConfig;
  }
  if (!policeWorkflowPromise) {
    policeWorkflowPromise = fetch("/police-workflow.json")
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`公安 workflow 加载失败：${response.status}`);
        }
        return response.json();
      })
      .then((payload) => {
        if (!payload || !Array.isArray(payload.steps) || typeof payload.defaultUserInstruction !== "string") {
          throw new Error("公安 workflow 响应格式无效");
        }
        policeWorkflowConfig = payload;
        return payload;
      })
      .catch((error) => {
        policeWorkflowPromise = undefined;
        throw error;
      });
  }
  return policeWorkflowPromise;
}

function connectEvents() {
  const source = new EventSource("/events");
  source.addEventListener("snapshot", (event) => {
    renderSnapshot(JSON.parse(event.data));
  });
  source.addEventListener("error", () => {
    renderLocalError("SSE 连接中断，正在等待浏览器重连。");
  });
}

function renderSnapshot(snapshot) {
  latestSnapshot = snapshot;
  updateSelectedTask(snapshot.run.steps);
  renderRunStatus(snapshot.run.status);
  renderMessages(snapshot);
  renderFlow(snapshot.run.steps);
  renderCards(snapshot.cards);
  updateActionState();
}

function renderRunStatus(status) {
  if (!(elements.runStatus instanceof HTMLElement) || !(elements.runStatusText instanceof HTMLElement)) {
    return;
  }
  elements.runStatus.className = `status ${escapeCssClass(status)}`;
  elements.runStatus.title = statusText[status] ?? status;
  elements.runStatus.setAttribute("aria-label", `运行状态：${statusText[status] ?? status}`);
  const symbol = elements.runStatus.querySelector(".status-symbol");
  if (symbol instanceof HTMLElement) {
    symbol.textContent = statusSymbol[status] ?? "○";
  }
  elements.runStatusText.textContent = statusText[status] ?? status;
}

function renderMessages(snapshot) {
  if (!(elements.messages instanceof HTMLElement)) {
    return;
  }
  const fragment = document.createDocumentFragment();

  for (const receipt of snapshot.receipts ?? []) {
    const node = document.createElement("article");
    node.className = receipt.level === "error" ? "message system error" : "message system";
    if (receipt.level === "error") {
      node.setAttribute("role", "alert");
      node.setAttribute("aria-label", `错误回执：${receipt.message}`);
    }
    node.innerHTML = `<strong>${receipt.level === "error" ? "错误回执" : "系统回执"}</strong><p>${escapeHtml(receipt.message)}</p>`;
    fragment.append(node);
  }

  for (const message of snapshot.conversationMessages ?? []) {
    const node = document.createElement("article");
    node.className = "message task";
    node.innerHTML = `<strong>${escapeHtml(resolveTaskTitle(snapshot.run.steps, message.taskId))}</strong><p>${escapeHtml(message.content)}</p>`;
    fragment.append(node);
  }

  if (fragment.childNodes.length === 0) {
    const empty = document.createElement("article");
    empty.className = "message system empty-message";
    empty.innerHTML = "<p>等待后端回执。</p>";
    fragment.append(empty);
  }

  elements.messages.replaceChildren(fragment);
  elements.messages.scrollTop = elements.messages.scrollHeight;
}

function renderLocalError(message) {
  if (!(elements.messages instanceof HTMLElement)) {
    return;
  }
  const node = document.createElement("article");
  node.className = "message system error";
  node.setAttribute("role", "alert");
  node.setAttribute("aria-label", `前端错误：${message}`);
  node.innerHTML = `<strong>前端错误</strong><p>${escapeHtml(message)}</p>`;
  elements.messages.append(node);
}

function renderFlow(steps) {
  if (!(elements.flowList instanceof HTMLElement)) {
    return;
  }

  const allTasks = steps.flatMap((step) => step.tasks);
  const doneTasks = allTasks.filter((task) => task.status === "complete").length;
  if (elements.totalProgress instanceof HTMLElement) {
    elements.totalProgress.textContent = `${doneTasks} / ${allTasks.length}`;
    elements.totalProgress.title = `已完成 ${doneTasks} 个，共 ${allTasks.length} 个`;
  }

  syncOrderedChildren(
    elements.flowList,
    steps.map((step) => step.id),
    "stepId",
    (stepId) => getOrCreateStepNode(steps.find((step) => step.id === stepId)),
  );

  for (const step of steps) {
    const stepNode = elements.flowList.querySelector(`[data-step-id="${cssEscape(step.id)}"]`);
    if (stepNode instanceof HTMLElement) {
      updateStepNode(stepNode, step);
    }
  }
}

function getOrCreateStepNode(step) {
  if (!step) {
    throw new Error("Cannot create a workflow step without step data");
  }
  const existing = elements.flowList?.querySelector(`[data-step-id="${cssEscape(step.id)}"]`);
  if (existing instanceof HTMLElement) {
    return existing;
  }
  const node = document.createElement("article");
  node.className = "phase-group";
  node.dataset.stepId = step.id;
  node.innerHTML = `
    <div class="phase-row">
      <div><h3></h3></div>
      <span class="phase-progress"></span>
    </div>
    <div data-task-list></div>
  `;
  return node;
}

function updateStepNode(stepNode, step) {
  const title = stepNode.querySelector("h3");
  if (title instanceof HTMLElement) {
    title.textContent = step.title;
  }
  const done = step.tasks.filter((task) => task.status === "complete").length;
  const progress = stepNode.querySelector(".phase-progress");
  if (progress instanceof HTMLElement) {
    progress.textContent = `${done} / ${step.tasks.length}`;
    progress.title = `阶段进度：${done} / ${step.tasks.length}`;
  }
  const taskList = stepNode.querySelector("[data-task-list]");
  if (!(taskList instanceof HTMLElement)) {
    return;
  }

  syncOrderedChildren(
    taskList,
    step.tasks.map((task) => task.id),
    "taskId",
    (taskId) => getOrCreateTaskNode(taskList, taskId),
  );

  for (const task of step.tasks) {
    const taskNode = taskList.querySelector(`[data-task-id="${cssEscape(task.id)}"]`);
    if (taskNode instanceof HTMLButtonElement) {
      updateTaskNode(taskNode, task);
    }
  }
}

function getOrCreateTaskNode(taskList, taskId) {
  const existing = taskList.querySelector(`[data-task-id="${cssEscape(taskId)}"]`);
  if (existing instanceof HTMLButtonElement) {
    return existing;
  }
  const taskNode = document.createElement("button");
  taskNode.className = "flow-row";
  taskNode.type = "button";
  taskNode.dataset.taskId = taskId;
  taskNode.innerHTML = `
    <span class="flow-marker"></span>
    <div>
      <h4></h4>
      <p></p>
    </div>
  `;
  taskNode.addEventListener("click", () => {
    selectedTaskId = taskId;
    renderFlow(latestSnapshot?.run.steps ?? []);
  });
  return taskNode;
}

function syncOrderedChildren(parent, expectedIds, datasetKey, createNode) {
  const expectedIdSet = new Set(expectedIds);
  for (const child of [...parent.children]) {
    if (child instanceof HTMLElement && !expectedIdSet.has(child.dataset[datasetKey] ?? "")) {
      child.remove();
    }
  }

  if (!hasChildOrderChanged(parent, expectedIds, datasetKey)) {
    return;
  }

  for (const id of expectedIds) {
    parent.append(createNode(id));
  }
}

function hasChildOrderChanged(parent, expectedIds, datasetKey) {
  const currentIds = [...parent.children]
    .map((child) => (child instanceof HTMLElement ? child.dataset[datasetKey] ?? "" : ""))
    .filter((id) => id.length > 0);
  return currentIds.length !== expectedIds.length || currentIds.some((id, index) => id !== expectedIds[index]);
}

function updateTaskNode(taskNode, task) {
  const status = statusText[task.status] ?? task.status;
  const symbol = statusSymbol[task.status] ?? "○";
  const isSelected = selectedTaskId === task.id;
  taskNode.className = `flow-row ${escapeCssClass(task.status)}${isSelected ? " selected" : ""}`;
  taskNode.title = `${task.title}：${status}`;
  taskNode.setAttribute("aria-label", `${task.title}，状态：${status}`);
  taskNode.setAttribute("aria-current", isSelected ? "true" : "false");
  const marker = taskNode.querySelector(".flow-marker");
  if (marker instanceof HTMLElement) {
    marker.textContent = symbol;
    marker.title = status;
    marker.setAttribute("aria-label", status);
  }
  const title = taskNode.querySelector("h4");
  if (title instanceof HTMLElement) {
    title.textContent = task.title;
  }
  const text = taskNode.querySelector("p");
  if (text instanceof HTMLElement) {
    text.textContent = status;
  }
}

function renderCards(cards) {
  if (!(elements.cardGrid instanceof HTMLElement)) {
    return;
  }
  if (!Array.isArray(cards) || cards.length === 0) {
    elements.cardGrid.innerHTML = '<div class="empty-state" data-empty-state>暂无业务卡片</div>';
    return;
  }
  const liveIds = new Set(cards.map((card) => card.id));
  for (const key of [...cardUiState.keys()]) {
    if (!liveIds.has(key)) {
      cardUiState.delete(key);
    }
  }
  elements.cardGrid.innerHTML = cards.map(renderCard).join("");
  bindCardActions();
}

function renderCard(card) {
  const uiState = cardUiState.get(card.id) ?? { collapsed: false, maximized: false };
  const classes = ["card", uiState.collapsed ? "collapsed" : "", uiState.maximized ? "maximized" : ""]
    .filter(Boolean)
    .join(" ");
  const status = statusText[card.status] ?? card.status;
  return `
    <article class="${classes}" data-card data-card-id="${escapeHtml(card.id)}">
      <div class="card-head">
        <div class="card-title">
          <h3>${escapeHtml(card.title)}</h3>
          <p>${escapeHtml(card.type)} · ${escapeHtml(status)}</p>
        </div>
        <div class="card-actions">
          <button class="card-action" type="button" data-collapse aria-label="${uiState.collapsed ? "展开" : "收起"}${escapeHtml(card.title)}" title="${uiState.collapsed ? "展开" : "收起"}">${uiState.collapsed ? "▾" : "▴"}</button>
          <button class="card-action" type="button" data-maximize aria-label="${uiState.maximized ? "还原" : "最大化"}${escapeHtml(card.title)}" title="${uiState.maximized ? "还原" : "最大化"}">${uiState.maximized ? "×" : "□"}</button>
        </div>
      </div>
      <div class="card-body">${renderCardBody(card)}</div>
    </article>
  `;
}

function renderCardBody(card) {
  if (card.type === "media") {
    const gbids = Array.isArray(card.data?.gbids) ? card.data.gbids : [];
    return `
      <div class="media-frame">监控引用数据，不拉取视频流字节</div>
      <div class="metrics">
        <div class="metric"><strong>${gbids.length}</strong>GBID</div>
        <div class="metric"><strong>引用</strong>数据源</div>
      </div>
      <div class="media-list">
        ${gbids.map((gbid) => `<div class="media-ref">${escapeHtml(gbid)}</div>`).join("")}
      </div>
    `;
  }
  if (card.type === "map") {
    const markers = Array.isArray(card.data?.markers) ? card.data.markers : [];
    return `
      <div class="map-card">
        <div class="map-points">
          ${markers.map((marker) => `<span class="point">${escapeHtml(marker.label ?? "点位")} ${escapeHtml(String(marker.lng ?? ""))}, ${escapeHtml(String(marker.lat ?? ""))}</span>`).join("")}
        </div>
      </div>
    `;
  }
  if (card.type === "table") {
    const rows = Array.isArray(card.data?.rows) ? card.data.rows : [];
    const columns = Array.isArray(card.data?.columns) && card.data.columns.length > 0
      ? card.data.columns
      : Object.keys(rows[0] ?? {}).map((key) => ({ key, label: key }));
    return `
      <div class="table-scroll">
        <table>
          <thead><tr>${columns.map((column) => `<th>${escapeHtml(column.label)}</th>`).join("")}</tr></thead>
          <tbody>${rows.map((row) => `<tr>${columns.map((column) => `<td>${escapeHtml(String(row[column.key] ?? ""))}</td>`).join("")}</tr>`).join("")}</tbody>
        </table>
      </div>
    `;
  }
  if (card.type === "text") {
    return `<div class="summary-stack"><div class="summary-block">${escapeHtml(card.data?.text ?? "")}</div></div>`;
  }
  return `<div class="json-stack"><div class="json-line">${escapeHtml(JSON.stringify(card.data, null, 2))}</div></div>`;
}

function bindCardActions() {
  const cards = document.querySelectorAll("[data-card]");
  for (const card of cards) {
    if (!(card instanceof HTMLElement)) {
      continue;
    }
    const cardId = card.dataset.cardId;
    if (!cardId) {
      continue;
    }
    const collapseButton = card.querySelector("[data-collapse]");
    const maximizeButton = card.querySelector("[data-maximize]");
    if (collapseButton instanceof HTMLButtonElement) {
      collapseButton.addEventListener("click", () => {
        const state = readCardState(cardId);
        state.collapsed = !state.collapsed;
        state.maximized = false;
        cardUiState.set(cardId, state);
        renderCards(latestSnapshot?.cards ?? []);
      });
    }
    if (maximizeButton instanceof HTMLButtonElement) {
      maximizeButton.addEventListener("click", () => {
        const state = readCardState(cardId);
        const nextMaximized = !state.maximized;
        for (const [key, value] of cardUiState) {
          cardUiState.set(key, { ...value, maximized: false });
        }
        cardUiState.set(cardId, { ...state, collapsed: false, maximized: nextMaximized });
        renderCards(latestSnapshot?.cards ?? []);
      });
    }
  }
}

function collapseMaximizedCards() {
  let changed = false;
  for (const [key, value] of cardUiState) {
    if (value.maximized) {
      cardUiState.set(key, { ...value, maximized: false });
      changed = true;
    }
  }
  if (changed) {
    renderCards(latestSnapshot?.cards ?? []);
  }
}

function readCardState(cardId) {
  return cardUiState.get(cardId) ?? { collapsed: false, maximized: false };
}

function updateSelectedTask(steps) {
  const tasks = steps.flatMap((step) => step.tasks);
  const current = tasks.find((task) => task.id === selectedTaskId);
  if (!current) {
    selectedTaskId =
      tasks.find((task) => task.status === "running")?.id ??
      tasks.find((task) => task.status === "loading")?.id ??
      tasks[0]?.id;
  }
  const selected = tasks.find((task) => task.id === selectedTaskId);
  if (elements.selectedTask instanceof HTMLElement) {
    const status = selected ? statusText[selected.status] ?? selected.status : "";
    const text = selected ? `${selected.title} · ${status}` : "暂无任务";
    elements.selectedTask.textContent = text;
    elements.selectedTask.title = text;
    elements.selectedTask.setAttribute(
      "aria-label",
      selected ? `当前任务：${selected.title}，状态：${status}` : "当前任务：暂无任务",
    );
  }
}

function updateActionState() {
  const status = latestSnapshot?.run.status ?? "idle";
  const hasSnapshot = Boolean(latestSnapshot);
  const isRunning = status === "running" || status === "stopping";
  if (elements.submit instanceof HTMLButtonElement) {
    elements.submit.disabled = !hasSnapshot || requestPending || status === "stopping";
  }
  if (elements.stop instanceof HTMLButtonElement) {
    elements.stop.disabled = !hasSnapshot || requestPending || !isRunning || status === "stopping";
  }
  if (elements.testRun instanceof HTMLButtonElement) {
    elements.testRun.disabled = requestPending || status === "stopping";
  }
  if (elements.instruction instanceof HTMLTextAreaElement) {
    elements.instruction.disabled = requestPending || status === "stopping";
  }
}

function setRequestPending(value) {
  requestPending = value;
  updateActionState();
}

function getSelectedStepsPayload() {
  const steps = latestSnapshot?.run?.steps;
  return Array.isArray(steps) ? steps : [];
}

function resolveTaskTitle(steps, taskId) {
  for (const step of steps) {
    const task = step.tasks.find((candidate) => candidate.id === taskId);
    if (task) {
      return task.title;
    }
  }
  return "任务消息";
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function cssEscape(value) {
  return window.CSS?.escape ? window.CSS.escape(value) : String(value).replaceAll('"', '\\"');
}

function escapeCssClass(value) {
  return String(value).replace(/[^a-z0-9_-]/gi, "");
}
