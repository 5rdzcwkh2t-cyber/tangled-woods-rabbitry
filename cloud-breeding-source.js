(function () {
  "use strict";

  const PREVIEW_PROJECT = "tangled-woods-rabbitry.pages.dev";
  const STATUSES = Object.freeze(["Bred", "Confirmed pregnant", "Kindled", "Unsuccessful", "Cancelled"]);
  const OUTCOMES = Object.freeze([
    "Not recorded", "Live litter", "Mixed live and stillborn", "Stillborn litter", "No litter"
  ]);
  const VIEWS = Object.freeze(["list", "detail", "create", "edit", "confirm-delete"]);

  const clone = value => typeof structuredClone === "function"
    ? structuredClone(value) : JSON.parse(JSON.stringify(value));
  const isObject = value => value !== null && typeof value === "object" && !Array.isArray(value);

  function isDevelopmentPreviewHost(hostname) {
    const host = String(hostname || "").trim().toLowerCase().replace(/\.$/, "");
    if (host === `cloud-development.${PREVIEW_PROJECT}`) return true;
    return new RegExp(`^[a-f0-9]{8}\.${PREVIEW_PROJECT.replace(/\./g, "\\.")}$`).test(host);
  }

  function parseDate(value) {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
    const [year, month, day] = value.split("-").map(Number);
    const result = new Date(Date.UTC(year, month - 1, day));
    return result.getUTCFullYear() === year && result.getUTCMonth() === month - 1 && result.getUTCDate() === day
      ? result : null;
  }

  function dateText(date) {
    return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
  }

  function addDays(date, days) {
    const copy = new Date(date);
    copy.setUTCDate(copy.getUTCDate() + days);
    return copy;
  }

  function estimateKindling(value) {
    const date = parseDate(value);
    if (!date) return null;
    return Object.freeze({
      earliest: dateText(addDays(date, 28)),
      expected: dateText(addDays(date, 31)),
      latest: dateText(addDays(date, 33))
    });
  }

  function eligibleParents(rabbits, sex) {
    const expected = String(sex || "").toLowerCase();
    if (!Array.isArray(rabbits) || !["doe", "buck"].includes(expected)) throw new TypeError("Invalid parent list");
    return rabbits.filter(entry => isObject(entry) && isObject(entry.record) && isObject(entry.metadata) &&
      typeof entry.metadata.typedId === "string" && entry.record.Archived !== true &&
      String(entry.record.Sex || entry.record.sex || "").trim().toLowerCase() === expected);
  }

  function groupBreedings(entries, today = new Date()) {
    if (!Array.isArray(entries)) throw new TypeError("Breeding records must be an array");
    const todayUtc = new Date(Date.UTC(today.getFullYear(), today.getMonth(), today.getDate()));
    const groups = { upcoming: [], overdue: [], completed: [] };
    for (const entry of entries) {
      if (!isObject(entry) || !isObject(entry.record)) throw new TypeError("Breeding record is malformed");
      const record = entry.record;
      if (["Kindled", "Unsuccessful", "Cancelled"].includes(record.status) || record.kindledDate) {
        groups.completed.push(entry);
        continue;
      }
      const estimate = estimateKindling(record.date);
      if (!estimate) throw new TypeError("Breeding date is malformed");
      const due = parseDate(estimate.expected);
      (due < todayUtc ? groups.overdue : groups.upcoming).push(entry);
    }
    groups.upcoming.sort((a, b) => a.record.date.localeCompare(b.record.date));
    groups.overdue.sort((a, b) => b.record.date.localeCompare(a.record.date));
    groups.completed.sort((a, b) => b.record.date.localeCompare(a.record.date));
    return groups;
  }

  function identityKey(entry, rabbitryId) {
    if (!isObject(entry?.metadata) || typeof entry.metadata.typedId !== "string") {
      throw new TypeError("Breeding identity is unavailable");
    }
    return JSON.stringify(["versioned-breeding", rabbitryId, entry.metadata.typedId]);
  }

  function requestMessage(error) {
    return window.twVersionedBreedingClient?.requestMessage?.(error) ||
      "Cloud breedings could not be loaded. Local records were not changed.";
  }

  function createController({
    fetchImpl,
    render,
    breedingClient = window.twVersionedBreedingClient,
    rabbitClient = window.twVersionedRabbitClient
  }) {
    const rabbitryId = breedingClient?.DEFAULT_RABBITRY_ID || "dev-auth-test";
    let source = "local";
    let status = "idle";
    let message = "";
    let breedings = [];
    let rabbits = [];
    let selectedKey = null;
    let requestVersion = 0;
    let createPromise = null;
    let updatePromise = null;
    let deletePromise = null;

    const selected = () => breedings.find(entry => identityKey(entry, rabbitryId) === selectedKey) || null;
    const snapshot = () => ({
      source, status, message, rabbitryId,
      breedings: breedings.slice(), rabbits: rabbits.slice(), selected: selected()
    });
    const redraw = () => { if (typeof render === "function") render(snapshot()); };

    function reset() {
      requestVersion += 1;
      source = "local";
      status = "idle";
      message = "";
      breedings = [];
      rabbits = [];
      selectedKey = null;
    }

    function selectLocal() { reset(); redraw(); }

    async function selectCloud() {
      const version = ++requestVersion;
      source = "cloud";
      status = "loading";
      message = "Loading development cloud breedings...";
      breedings = [];
      rabbits = [];
      selectedKey = null;
      redraw();
      try {
        if (!breedingClient?.listBreedings || !rabbitClient?.listRabbits) throw new Error("Cloud clients unavailable");
        const [loadedBreedings, loadedRabbits] = await Promise.all([
          breedingClient.listBreedings({ fetchImpl, rabbitryId }),
          rabbitClient.listRabbits({ fetchImpl, rabbitryId })
        ]);
        if (version !== requestVersion || source !== "cloud") return;
        breedings = loadedBreedings.map(clone);
        rabbits = loadedRabbits.map(clone);
        status = "ready";
        message = `${breedings.length} development cloud breeding${breedings.length === 1 ? "" : "s"}.`;
      } catch (error) {
        if (version !== requestVersion || source !== "cloud") return;
        status = "error";
        message = requestMessage(error);
      }
      redraw();
    }

    function initialize(hostname) {
      return isDevelopmentPreviewHost(hostname) ? selectCloud() : Promise.resolve(snapshot());
    }

    function selectRecord(entry) {
      const key = identityKey(entry, rabbitryId);
      if (!breedings.some(candidate => identityKey(candidate, rabbitryId) === key)) {
        throw new TypeError("Breeding is not loaded");
      }
      selectedKey = key;
      return selected();
    }

    function clearSelection() { selectedKey = null; }

    function upsert(entry) {
      const key = identityKey(entry, rabbitryId);
      const index = breedings.findIndex(candidate => identityKey(candidate, rabbitryId) === key);
      if (index < 0) breedings.push(clone(entry));
      else breedings[index] = clone(entry);
      selectedKey = key;
      return selected();
    }

    function createCloud(record) {
      if (source !== "cloud" || !breedingClient?.createBreeding) return Promise.reject(new Error("Cloud breeding creation is unavailable"));
      if (createPromise) return createPromise;
      const version = requestVersion;
      createPromise = breedingClient.createBreeding({ fetchImpl, rabbitryId, record }).then(entry => {
        if (version === requestVersion && source === "cloud") return upsert(entry);
        return entry;
      }).finally(() => { createPromise = null; });
      return createPromise;
    }

    function updateCloud(entry, record) {
      if (source !== "cloud" || !breedingClient?.updateBreeding) return Promise.reject(new Error("Cloud breeding editing is unavailable"));
      if (!entry || !Object.is(entry.record?._id, record?._id)) return Promise.reject(new Error("Breeding identity changed"));
      if (updatePromise) return updatePromise;
      const contextKey = identityKey(entry, rabbitryId);
      const version = requestVersion;
      updatePromise = breedingClient.updateBreeding({
        fetchImpl, rabbitryId, baseRevision: entry.metadata.revision, record
      }).then(updated => {
        if (version === requestVersion && source === "cloud" && selectedKey === contextKey) return upsert(updated);
        return updated;
      }).finally(() => { updatePromise = null; });
      return updatePromise;
    }

    function deleteCloud(entry) {
      if (source !== "cloud" || !breedingClient?.deleteBreeding) return Promise.reject(new Error("Cloud breeding deletion is unavailable"));
      if (deletePromise) return deletePromise;
      const key = identityKey(entry, rabbitryId);
      const version = requestVersion;
      deletePromise = breedingClient.deleteBreeding({
        fetchImpl, rabbitryId, typedId: entry.metadata.typedId,
        baseRevision: entry.metadata.revision, id: entry.record._id
      }).then(result => {
        if (version === requestVersion && source === "cloud" && selectedKey === key) {
          breedings = breedings.filter(candidate => identityKey(candidate, rabbitryId) !== key);
          selectedKey = null;
        }
        return result;
      }).finally(() => { deletePromise = null; });
      return deletePromise;
    }

    return {
      getState: snapshot, initialize, reset, selectLocal, selectCloud,
      selectRecord, clearSelection, createCloud, updateCloud, deleteCloud
    };
  }

  window.twCloudBreedingSource = {
    OUTCOMES, STATUSES, VIEWS, createController, eligibleParents,
    estimateKindling, groupBreedings, isDevelopmentPreviewHost
  };

  if (typeof window.render !== "function" || typeof window.nav !== "function") return;

  const priorRender = window.render;
  const priorNav = window.nav;
  const controller = createController({ fetchImpl: (...args) => fetch(...args), render: () => window.render() });
  let initialized = false;
  let viewMode = "list";
  let draft = null;
  const cloudFirst = isDevelopmentPreviewHost(window.location?.hostname);

  function node(tag, text, className) {
    const element = document.createElement(tag);
    if (text !== undefined) element.textContent = text;
    if (className) element.className = className;
    return element;
  }

  function localCloudMode() {
    return typeof window.twIsCloudTestMode === "function" && window.twIsCloudTestMode();
  }

  function sourceControls(state) {
    const controls = node("div", undefined, "tw-breeding-source-controls");
    const cloud = node("button", "Development cloud");
    const local = node("button", "Local on this device");
    cloud.type = local.type = "button";
    cloud.setAttribute("aria-pressed", String(state.source === "cloud"));
    local.setAttribute("aria-pressed", String(state.source === "local"));
    if (state.source === "cloud") cloud.className = "primary";
    else local.className = "primary";
    cloud.onclick = () => { viewMode = "list"; draft = null; controller.selectCloud(); };
    local.onclick = () => { viewMode = "list"; draft = null; controller.selectLocal(); };
    controls.append(cloud, local);
    return controls;
  }

  function parentLabel(entry) {
    return [entry.record.Prefix, entry.record.Name].filter(Boolean).join(" ") || "Unnamed rabbit";
  }

  function parentByTypedId(state, typedId) {
    return state.rabbits.find(entry => entry.metadata.typedId === typedId) || null;
  }

  function pairingLabel(state, record) {
    const doe = parentByTypedId(state, record.doeTypedId);
    const buck = parentByTypedId(state, record.buckTypedId);
    return `${doe ? parentLabel(doe) : "Unavailable doe"} × ${buck ? parentLabel(buck) : "Unavailable buck"}`;
  }

  function renderList(view, state) {
    view.append(sourceControls(state), node("h2", "Cloud breeding planner"));
    const notice = node("p", "Versioned development records are isolated from local breedings. Cloud litter creation is not enabled.", "tw-cloud-app-banner");
    const status = node("p", state.message, "muted");
    status.setAttribute("role", "status");
    view.append(notice, status);
    if (state.status === "loading") return;
    if (state.status === "error") {
      const retry = node("button", "Try again"); retry.type = "button"; retry.onclick = () => controller.selectCloud();
      view.append(retry);
      return;
    }
    const add = node("button", "+ New cloud breeding", "primary");
    add.type = "button";
    add.onclick = () => {
      try {
        draft = { _id: window.twVersionedBreedingClient.createBreedingId(), date: dateText(new Date()),
          status: "Bred", outcome: "Not recorded", kindledDate: "", notes: "" };
        viewMode = "create";
        window.render();
      } catch (error) { status.textContent = requestMessage(error); }
    };
    view.append(add);
    let groups;
    try { groups = groupBreedings(state.breedings); }
    catch (error) { status.textContent = error.message; return; }
    const stats = node("div", undefined, "stats");
    for (const [value, label] of [[groups.upcoming.length, "Upcoming"], [groups.overdue.length, "Overdue"], [groups.completed.length, "Completed"]]) {
      const box = node("div", undefined, "stat"); box.append(node("strong", String(value)), document.createTextNode(label)); stats.append(box);
    }
    view.append(stats);
    for (const [key, title] of [["upcoming", "Upcoming kindling"], ["overdue", "Past estimated date"], ["completed", "Completed breedings"]]) {
      view.append(node("h3", title));
      const entries = groups[key];
      if (!entries.length) { view.append(node("p", "No records in this group.", "muted")); continue; }
      for (const entry of entries) {
        const button = node("button", undefined, "listitem"); button.type = "button";
        const estimate = estimateKindling(entry.record.date);
        button.append(node("strong", pairingLabel(state, entry.record)),
          node("span", `Bred ${entry.record.date} · ${entry.record.status} · estimated ${estimate?.expected || "unknown"}`, "muted"));
        button.onclick = () => { controller.selectRecord(entry); viewMode = "detail"; window.render(); };
        view.append(button);
      }
    }
  }

  function renderDetail(view, state, entry) {
    const record = entry.record;
    const back = node("button", "← Breeding planner"); back.type = "button"; back.onclick = () => { controller.clearSelection(); viewMode = "list"; window.render(); };
    view.append(sourceControls(state), back, node("h2", pairingLabel(state, record)));
    const card = node("div", undefined, "card");
    const estimate = estimateKindling(record.date);
    const fields = [
      ["Breeding date", record.date], ["Status", record.status], ["Outcome", record.outcome || "Not recorded"],
      ["Expected kindling", record.expectedKindlingDate || estimate?.expected || "Not available"],
      ["Typical range", estimate ? `${estimate.earliest}–${estimate.latest}` : "Not available"],
      ["Actual kindling", record.kindledDate || "Not recorded"], ["Notes", record.notes || "None"],
      ["Revision", String(entry.metadata.revision)]
    ];
    for (const [label, value] of fields) { const p = node("p"); p.append(node("strong", `${label}: `), document.createTextNode(value)); card.append(p); }
    view.append(card);
    const actions = node("div", undefined, "tw-breeding-actions");
    const edit = node("button", "Edit breeding", "primary"); edit.type = "button"; edit.onclick = () => { draft = clone(record); viewMode = "edit"; window.render(); };
    const remove = node("button", "Delete breeding", "tw-breeding-danger"); remove.type = "button"; remove.onclick = () => { viewMode = "confirm-delete"; window.render(); };
    actions.append(edit, remove); view.append(actions);
  }

  function option(value, text, selected) {
    const item = node("option", text); item.value = value; item.selected = selected; return item;
  }

  function renderForm(view, state, entry) {
    const creating = !entry;
    const working = draft || (creating ? {} : clone(entry.record));
    const cancel = node("button", "← Cancel"); cancel.type = "button";
    cancel.onclick = () => { draft = null; viewMode = creating ? "list" : "detail"; window.render(); };
    view.append(sourceControls(state), cancel, node("h2", creating ? "New cloud breeding" : "Edit cloud breeding"));
    const form = node("form", undefined, "card tw-breeding-form");
    const does = eligibleParents(state.rabbits, "doe");
    const bucks = eligibleParents(state.rabbits, "buck");
    const makeSelect = (labelText, name, entries, selected) => {
      const label = node("label", labelText); const select = node("select"); select.name = name; select.required = true;
      select.append(option("", `Choose ${labelText.toLowerCase()}...`, !selected));
      for (const parent of entries) select.append(option(parent.metadata.typedId, parentLabel(parent), parent.metadata.typedId === selected));
      label.append(select); form.append(label); return select;
    };
    const doe = makeSelect("Doe", "doeTypedId", does, working.doeTypedId);
    const buck = makeSelect("Buck", "buckTypedId", bucks, working.buckTypedId);
    const field = (labelText, name, type, value) => {
      const label = node("label", labelText); const input = node("input"); input.name = name; input.type = type; input.value = value || ""; label.append(input); form.append(label); return input;
    };
    const date = field("Breeding date", "date", "date", working.date); date.required = true;
    const due = node("div", undefined, "card muted");
    const updateDue = () => { const value = estimateKindling(date.value); due.textContent = value
      ? `Estimated kindling ${value.expected} · typical range ${value.earliest}–${value.latest}` : "Enter a valid breeding date."; };
    date.oninput = updateDue; updateDue(); form.append(due);
    const statusLabel = node("label", "Status"); const statusSelect = node("select"); statusSelect.name = "status";
    for (const value of STATUSES) statusSelect.append(option(value, value, value === (working.status || "Bred")));
    statusLabel.append(statusSelect); form.append(statusLabel);
    const outcomeLabel = node("label", "Outcome"); const outcomeSelect = node("select"); outcomeSelect.name = "outcome";
    for (const value of OUTCOMES) outcomeSelect.append(option(value, value, value === (working.outcome || "Not recorded")));
    outcomeLabel.append(outcomeSelect); form.append(outcomeLabel);
    const kindledDate = field("Actual kindling date (optional)", "kindledDate", "date", working.kindledDate);
    const notesLabel = node("label", "Notes"); const notes = node("textarea"); notes.name = "notes"; notes.value = working.notes || ""; notesLabel.append(notes); form.append(notesLabel);
    const save = node("button", creating ? "Create breeding" : "Save changes", "primary"); save.type = "submit";
    const saveStatus = node("p", "", "muted"); saveStatus.setAttribute("role", "status"); form.append(save, saveStatus);
    if (!does.length || !bucks.length) { save.disabled = true; saveStatus.textContent = "At least one active cloud doe and buck are required."; }
    form.onsubmit = async event => {
      event.preventDefault();
      if (doe.value === buck.value) { saveStatus.textContent = "Choose two different rabbits."; return; }
      const estimate = estimateKindling(date.value);
      if (!estimate) { saveStatus.textContent = "Enter a valid breeding date."; return; }
      const revision = { ...clone(working), _id: working._id, doeTypedId: doe.value, buckTypedId: buck.value,
        date: date.value, expectedKindlingDate: estimate.expected, kindledDate: kindledDate.value,
        status: statusSelect.value, outcome: outcomeSelect.value, notes: notes.value };
      save.disabled = true; cancel.disabled = true; saveStatus.textContent = "Saving cloud breeding...";
      try {
        const saved = creating ? await controller.createCloud(revision) : await controller.updateCloud(entry, revision);
        const current = controller.getState();
        if (current.source === "cloud" && current.selected && current.selected.metadata.typedId === saved.metadata.typedId) {
          draft = null; viewMode = "detail"; window.render();
        }
      } catch (error) {
        if (controller.getState().source === "cloud") {
          saveStatus.textContent = requestMessage(error); save.disabled = false; cancel.disabled = false;
        }
      }
    };
    view.append(form);
  }

  function renderDelete(view, state, entry) {
    view.append(sourceControls(state), node("h2", "Confirm breeding deletion"));
    const card = node("div", undefined, "card");
    card.append(node("p", `Delete ${pairingLabel(state, entry.record)} bred on ${entry.record.date}?`),
      node("p", "This creates a versioned tombstone and preserves complete history. It does not delete either rabbit.", "muted"));
    const actions = node("div", undefined, "tw-breeding-actions");
    const cancel = node("button", "Cancel"); cancel.type = "button"; cancel.onclick = () => { viewMode = "detail"; window.render(); };
    const remove = node("button", "Delete breeding", "tw-breeding-danger"); remove.type = "button";
    const status = node("p", "", "muted"); status.setAttribute("role", "status");
    remove.onclick = async () => {
      remove.disabled = cancel.disabled = true; status.textContent = "Deleting cloud breeding...";
      try {
        await controller.deleteCloud(entry);
        if (controller.getState().source === "cloud" && !controller.getState().selected) {
          viewMode = "list"; window.render();
        }
      } catch (error) {
        if (controller.getState().source === "cloud") {
          status.textContent = requestMessage(error); remove.disabled = cancel.disabled = false;
        }
      }
    };
    actions.append(cancel, remove); card.append(actions, status); view.append(card);
  }

  const style = document.createElement("style");
  style.textContent = `.tw-breeding-source-controls,.tw-breeding-actions{display:flex;flex-wrap:wrap;gap:12px;align-items:center;margin:0 0 16px}.tw-breeding-actions .tw-breeding-danger{margin-left:auto;color:#8b1e1e;border-color:#d6a0a0;background:#fff7f7}.tw-breeding-form{display:grid;gap:12px}.tw-breeding-form label{margin:0}@media(max-width:600px){.tw-breeding-actions>*{flex:1 1 100%}.tw-breeding-actions .tw-breeding-danger{margin-left:0}}`;
  document.head?.append(style);

  window.render = function () {
    if (page === "Breeding" && cloudFirst && !initialized && !localCloudMode()) {
      initialized = true;
      controller.initialize(window.location.hostname);
      return;
    }
    const result = priorRender.apply(this, arguments);
    if (page !== "Breeding" || localCloudMode()) return result;
    const state = controller.getState();
    const view = document.getElementById("view");
    if (!view) return result;
    if (state.source === "local") { view.prepend(sourceControls(state)); return result; }
    view.replaceChildren();
    if (viewMode === "create" && state.status === "ready") renderForm(view, state, null);
    else if (viewMode === "edit" && state.selected && state.status === "ready") renderForm(view, state, state.selected);
    else if (viewMode === "confirm-delete" && state.selected && state.status === "ready") renderDelete(view, state, state.selected);
    else if (viewMode === "detail" && state.selected && state.status === "ready") renderDetail(view, state, state.selected);
    else renderList(view, state);
    return result;
  };

  window.nav = function (target) {
    if (target !== "Breeding") {
      initialized = false; viewMode = "list"; draft = null; controller.reset();
    }
    return priorNav.apply(this, arguments);
  };

  if (page === "Breeding") window.render();
})();
