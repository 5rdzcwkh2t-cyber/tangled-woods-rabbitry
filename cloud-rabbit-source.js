(function () {
  "use strict";

  const PREVIEW_PROJECT = "tangled-woods-rabbitry.pages.dev";
  const CLOUD_VIEWS = Object.freeze([
    "list", "detail", "create", "edit", "edit-weight", "edit-milestones", "confirm-delete", "pedigree"
  ]);
  const CLOUD_ARCHIVE_FILTERS = Object.freeze(["active", "archived"]);
  const MAX_WEIGHT_ENTRIES = 500;
  const MILESTONE_FIELDS = Object.freeze([
    ["weaned", "Weaned"],
    ["separated", "Separated from Doe"],
    ["readyForSale", "Ready for Sale"]
  ]);
  const CLOUD_PROFILE_FIELDS = Object.freeze([
    "Prefix", "Name", "Sex", "Tattoo", "Breed", "Color", "DoB", "Father", "Mother",
    "Weight", "Status", "Bio", "WeanedDate", "Notes"
  ]);

  function isArchivedRabbit(record) {
    return record?.Archived === true;
  }

  function eligibleParents(records, childId, role, search = "") {
    const sex = role === "Father" ? "buck" : "doe";
    const term = search.trim().toLowerCase();
    return records.filter(({ record, metadata }) =>
      !Object.is(record._id, childId) && !metadata.deletedAt && !isArchivedRabbit(record) &&
      String(record.Sex ?? record.sex ?? "").trim().toLowerCase() === sex &&
      typeof (record.Name ?? record.name) === "string" && (record.Name ?? record.name).trim() &&
      [rabbitLabel(record), record.Tattoo, record.Breed].some(value => String(value ?? "").toLowerCase().includes(term))
    ).sort((a, b) => rabbitLabel(a.record).localeCompare(rabbitLabel(b.record)));
  }

  function filterCloudRecords(records, archiveFilter) {
    if (!CLOUD_ARCHIVE_FILTERS.includes(archiveFilter)) throw new TypeError("Invalid cloud archive filter");
    return records.filter((entry) => isArchivedRabbit(entry.record) === (archiveFilter === "archived"));
  }

  function createArchiveRevision(record, archived) {
    if (!record || typeof record !== "object" || Array.isArray(record)) {
      throw new TypeError("Cloud rabbit record is unavailable");
    }
    const revision = structuredClone(record);
    revision.Archived = archived === true;
    return revision;
  }

  function isPlainObject(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === null ||
      (Object.prototype.hasOwnProperty.call(prototype, "constructor") && prototype.constructor?.name === "Object");
  }

  function isValidDate(value) {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const [year, month, day] = value.split("-").map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
  }

  function validateWeightHistory(history) {
    if (history === undefined) return [];
    if (!Array.isArray(history)) throw new TypeError("Weight history must be an array");
    if (history.length > MAX_WEIGHT_ENTRIES) throw new TypeError(`Weight history cannot exceed ${MAX_WEIGHT_ENTRIES} entries`);
    const dates = new Set();
    return history.map((entry, index) => {
      if (!isPlainObject(entry) || !isValidDate(entry.date) ||
          typeof entry.ounces !== "number" || !Number.isFinite(entry.ounces) || entry.ounces <= 0) {
        throw new TypeError(`Weight entry ${index + 1} is malformed`);
      }
      if (dates.has(entry.date)) throw new TypeError(`Weight date ${entry.date} is duplicated`);
      dates.add(entry.date);
      return structuredClone(entry);
    });
  }

  function weightFromParts(poundsValue, ouncesValue) {
    const poundsText = String(poundsValue ?? "").trim();
    const ouncesText = String(ouncesValue ?? "").trim();
    if (!poundsText && !ouncesText) throw new TypeError("Weight is required");
    const pounds = poundsText ? Number(poundsText) : 0;
    const ounces = ouncesText ? Number(ouncesText) : 0;
    if (!Number.isInteger(pounds) || pounds < 0 || !Number.isInteger(ounces) || ounces < 0 || ounces > 15) {
      throw new TypeError("Enter whole pounds and whole ounces from 0 through 15");
    }
    const total = pounds * 16 + ounces;
    if (total <= 0) throw new TypeError("Weight must be greater than zero");
    return total;
  }

  function createWeightRevision(record, history) {
    if (!isPlainObject(record)) throw new TypeError("Cloud rabbit record is unavailable");
    validateWeightHistory(record.weightHistory);
    const revision = structuredClone(record);
    revision.weightHistory = validateWeightHistory(history);
    return revision;
  }

  function buildWeightHistoryFromDraft(drafts) {
    if (!Array.isArray(drafts)) throw new TypeError("Weight draft must be an array");
    return drafts.map((draft) => {
      if (!isPlainObject(draft) || !isPlainObject(draft.entry)) throw new TypeError("Weight draft is malformed");
      if (!draft.changed) return structuredClone(draft.entry);
      return {
        ...structuredClone(draft.entry),
        date: draft.date,
        ounces: weightFromParts(draft.pounds, draft.ounces)
      };
    });
  }

  function validateMilestones(milestones) {
    if (milestones === undefined) return {};
    if (!isPlainObject(milestones)) throw new TypeError("Development milestones must be an object");
    const copy = structuredClone(milestones);
    for (const [key] of MILESTONE_FIELDS) {
      if (Object.hasOwn(copy, key) && !isValidDate(copy[key])) {
        throw new TypeError(`Development milestone ${key} is malformed`);
      }
    }
    return copy;
  }

  function createMilestoneRevision(record, changes) {
    if (!isPlainObject(record) || !isPlainObject(changes)) throw new TypeError("Cloud rabbit record is unavailable");
    const revision = structuredClone(record);
    const milestones = validateMilestones(record.kitMilestones);
    for (const [key] of MILESTONE_FIELDS) {
      if (!Object.hasOwn(changes, key)) continue;
      const value = String(changes[key] ?? "").trim();
      if (!value) delete milestones[key];
      else if (!isValidDate(value)) throw new TypeError(`Development milestone ${key} is malformed`);
      else milestones[key] = value;
    }
    revision.kitMilestones = milestones;
    return revision;
  }

  function clearMilestoneDraft(draft, key) {
    if (!isPlainObject(draft) || !MILESTONE_FIELDS.some(([field]) => field === key)) {
      throw new TypeError("Development milestone is unavailable");
    }
    draft[key] = "";
    return draft;
  }

  function nextCloudView(current, action) {
    if (!CLOUD_VIEWS.includes(current)) throw new TypeError("Invalid cloud rabbit view");
    if (action === "reset") return "list";
    const transitions = {
      list: { select: "detail", create: "create" },
      detail: { back: "list", edit: "edit", weight: "edit-weight", milestones: "edit-milestones", delete: "confirm-delete", pedigree: "pedigree" },
      pedigree: { back: "detail" },
      create: { cancel: "list", success: "detail" },
      edit: { cancel: "detail", success: "detail" },
      "edit-weight": { cancel: "detail", success: "detail" },
      "edit-milestones": { cancel: "detail", success: "detail" },
      "confirm-delete": { cancel: "detail", success: "list" }
    };
    const next = transitions[current][action];
    if (!next) throw new TypeError("Invalid cloud rabbit navigation");
    return next;
  }

  function isDevelopmentPreviewHost(hostname) {
    const host = String(hostname || "").trim().toLowerCase().replace(/\.$/, "");
    if (host === `cloud-development.${PREVIEW_PROJECT}`) return true;
    return new RegExp(`^[a-f0-9]{8}\\.${PREVIEW_PROJECT.replace(/\\./g, "\\\\.")}$`).test(host);
  }

  function requestMessage(error) {
    if (error?.category === "save-in-progress") return "Another cloud rabbit save is still in progress. Wait for it to finish, then try again.";
    if (window.twVersionedRabbitClient?.requestMessage) {
      return window.twVersionedRabbitClient.requestMessage(error);
    }
    return "Cloud rabbits could not be loaded. Try again; local rabbits were not changed.";
  }

  function pendingSaveError() {
    return Object.assign(new Error("Cloud rabbit save in progress"), { category: "save-in-progress" });
  }

  function createController({ fetchImpl, render, client = window.twVersionedRabbitClient }) {
    const boundary = window.twRabbitManagementController;
    if (!boundary || typeof boundary.createController !== "function") {
      throw new Error("Rabbit management controller unavailable");
    }
    const localSource = boundary.localSource();
    const cloudSource = boundary.versionedSource(client?.DEFAULT_RABBITRY_ID || "dev-auth-test");
    const management = boundary.createController({ source: localSource });
    let status = "idle";
    let message = "";
    let requestVersion = 0;
    let createPromise = null;
    let updatePromise = null;
    let createPayload = null;
    let updatePayload = null;
    let deletePromise = null;

    const snapshot = () => {
      const state = management.getState();
      return {
        source: state.source.kind === boundary.SOURCE_KINDS.VERSIONED ? "cloud" : "local",
        sourceIdentity: state.source,
        status,
        records: state.records,
        selected: state.selected,
        message
      };
    };
    const redraw = () => { if (typeof render === "function") render(snapshot()); };

    function reset() {
      requestVersion += 1;
      management.activate(localSource);
      status = "idle";
      message = "";
    }

    function selectLocal() {
      reset();
      redraw();
    }

    function initialize(hostname) {
      if (!isDevelopmentPreviewHost(hostname)) return Promise.resolve(snapshot());
      return selectCloud();
    }

    async function selectCloud() {
      const version = ++requestVersion;
      management.activate(cloudSource);
      status = "loading";
      message = "Loading development cloud rabbits…";
      redraw();

      try {
        if (!client || typeof client.listRabbits !== "function") {
          throw new Error("Versioned rabbit client unavailable");
        }
        const current = await client.listRabbits({
          fetchImpl,
          rabbitryId: client.DEFAULT_RABBITRY_ID || "dev-auth-test"
        });
        if (version !== requestVersion || management.getState().source.key !== cloudSource.key) return;
        management.setRecords(current);
        status = "ready";
        const count = management.getState().records.length;
        message = `${count} development cloud rabbit${count === 1 ? "" : "s"}.`;
      } catch (error) {
        if (version !== requestVersion || management.getState().source.key !== cloudSource.key) return;
        management.setRecords([]);
        status = "error";
        message = requestMessage(error);
      }
      redraw();
      return version === requestVersion && status === "ready";
    }

    function createCloud(record, parentChanges) {
      if (management.getState().source.key !== cloudSource.key || !client || typeof client.createRabbit !== "function") {
        return Promise.reject(new Error("Cloud rabbit creation is unavailable"));
      }
      const version = requestVersion;
      const payload = JSON.stringify([version, record, parentChanges]);
      if (createPromise) return payload === createPayload ? createPromise : Promise.reject(pendingSaveError());
      createPayload = payload;
      createPromise = client.createRabbit({
        fetchImpl,
        rabbitryId: client.DEFAULT_RABBITRY_ID || "dev-auth-test",
        record,
        ...(parentChanges ? { parentChanges } : {})
      }).then((created) => {
        if (version === requestVersion && management.getState().source.key === cloudSource.key) {
          created = management.upsert(created);
          message = "Cloud rabbit saved successfully.";
        }
        return created;
      }).finally(() => {
        createPromise = null;
      });
      return createPromise;
    }

    function updateCloud(entry, record, parentChanges) {
      if (management.getState().source.key !== cloudSource.key || !client || typeof client.updateRabbit !== "function") {
        return Promise.reject(new Error("Cloud rabbit editing is unavailable"));
      }
      if (!entry || !entry.metadata || !Object.is(entry.metadata.id, record?._id)) {
        return Promise.reject(new Error("Cloud rabbit identity changed"));
      }
      const version = requestVersion;
      const payload = JSON.stringify([version, entry.metadata.revision, record, parentChanges]);
      if (updatePromise) return payload === updatePayload ? updatePromise : Promise.reject(pendingSaveError());
      updatePayload = payload;
      updatePromise = client.updateRabbit({
        fetchImpl,
        rabbitryId: client.DEFAULT_RABBITRY_ID || "dev-auth-test",
        baseRevision: entry.metadata.revision,
        record,
        ...(parentChanges ? { parentChanges } : {})
      }).then((updated) => {
        if (version === requestVersion && management.getState().source.key === cloudSource.key) {
          if (!management.getState().records.some(candidate => candidate.metadata.identityKey === entry.metadata.identityKey)) {
            throw new Error("Cloud rabbit is no longer loaded");
          }
          updated = management.upsert(updated);
          message = "Cloud rabbit updated successfully.";
        }
        return updated;
      }).finally(() => { updatePromise = null; });
      return updatePromise;
    }

    function deleteCloud(entry) {
      if (management.getState().source.key !== cloudSource.key || !client || typeof client.deleteRabbit !== "function") {
        return Promise.reject(new Error("Cloud rabbit deletion is unavailable"));
      }
      if (!entry || !entry.metadata || typeof entry.metadata.typedId !== "string") {
        return Promise.reject(new Error("Cloud rabbit identity is unavailable"));
      }
      if (deletePromise) return deletePromise;
      const version = requestVersion;
      deletePromise = client.deleteRabbit({
        fetchImpl,
        rabbitryId: client.DEFAULT_RABBITRY_ID || "dev-auth-test",
        typedId: entry.metadata.typedId,
        baseRevision: entry.metadata.revision
      }).then((deleted) => {
        if (version === requestVersion && management.getState().source.key === cloudSource.key) {
          management.remove(entry.metadata.identityKey);
          message = "Cloud rabbit deleted successfully. Its revision history was preserved.";
        }
        return deleted;
      }).finally(() => { deletePromise = null; });
      return deletePromise;
    }

    function selectRecord(entry) {
      return management.select(entry?.metadata?.identityKey);
    }

    async function refreshCloudEntry(entry) {
      if (management.getState().source.key !== cloudSource.key || !client?.getRabbit) return null;
      const epoch = requestVersion;
      const { rabbitryId, typedId, identityKey } = entry.metadata;
      const fresh = await client.getRabbit({ fetchImpl, rabbitryId, typedId });
      if (epoch !== requestVersion || management.getState().source.key !== cloudSource.key) return null;
      const current = management.getState().records.find(item => item.metadata.identityKey === identityKey);
      if (!current) return null;
      return current.metadata.revision >= fresh.metadata.revision ? current : management.upsert(fresh);
    }

    function clearSelection() {
      management.clearSelection();
    }

    return {
      getState: snapshot, reset, initialize, selectLocal, selectCloud,
      createCloud, updateCloud, deleteCloud, selectRecord, clearSelection, refreshCloudEntry
    };
  }

  window.twCloudRabbitSource = {
    CLOUD_ARCHIVE_FILTERS, CLOUD_PROFILE_FIELDS, CLOUD_VIEWS, MAX_WEIGHT_ENTRIES,
    MILESTONE_FIELDS, buildWeightHistoryFromDraft, clearMilestoneDraft, createArchiveRevision, createController, createMilestoneRevision,
    createWeightRevision, filterCloudRecords, isArchivedRabbit, isDevelopmentPreviewHost,
    isValidDate, nextCloudView, requestMessage, validateMilestones, validateWeightHistory,
    weightFromParts, eligibleParents, serializeParentChange
  };

  if (typeof window.render !== "function" || typeof window.nav !== "function") return;

  const priorRender = window.render;
  const priorNav = window.nav;
  let search = "";
  let archiveFilter = "active";
  let viewMode = "list";
  let createDraft = null;
  let editDraft = null;
  let weightDraft = null;
  let milestoneDraft = null;
  let pedigreeGenerations = 3;
  const parentDrafts = new WeakMap();
  const cloudFirstPreview = isDevelopmentPreviewHost(window.location?.hostname);
  let previewInitialized = false;

  function move(action) {
    viewMode = nextCloudView(viewMode, action);
  }

  function resetCloudView() {
    viewMode = nextCloudView(viewMode, "reset");
    archiveFilter = "active";
    createDraft = null;
    editDraft = null;
    weightDraft = null;
    milestoneDraft = null;
    pedigreeGenerations = 3;
  }

  function operationContext(state, identityKey = null) {
    return { sourceKey: state.sourceIdentity.key, identityKey, viewMode };
  }

  function contextIsCurrent(context, identityRequired = false) {
    const state = controller.getState();
    return state.sourceIdentity.key === context.sourceKey &&
      viewMode === context.viewMode &&
      (!identityRequired || state.selected?.metadata?.identityKey === context.identityKey);
  }

  const controller = createController({
    fetchImpl: (...args) => fetch(...args),
    render: () => window.render()
  });

  function node(tag, text, className) {
    const item = document.createElement(tag);
    if (text !== undefined) item.textContent = text;
    if (className) item.className = className;
    return item;
  }

  function styleCloudActionRow(row) {
    row.style.justifyContent = "flex-start";
    row.style.alignItems = "center";
    row.style.flexWrap = "wrap";
    row.style.gap = "12px";
    row.style.marginBottom = "12px";
  }

  function styleCloudActionButton(button) {
    button.style.minHeight = "42px";
    button.style.padding = "10px 16px";
    button.style.borderRadius = "12px";
    button.style.display = "inline-flex";
    button.style.alignItems = "center";
    button.style.justifyContent = "center";
  }

  function styleCloudDestructiveButton(button) {
    styleCloudActionButton(button);
    button.style.background = "#f8e7e7";
    button.style.color = "#8a2f2f";
    button.style.border = "1px solid #e6b8b8";
  }

  function sourceControls(state) {
    const section = node("section", undefined, "card tw-rabbit-source no-print");
    const heading = node("strong", "Rabbit data source");
    const help = node(
      "p",
      "Development cloud and local browser rabbits remain isolated. Changing sources never copies, merges, or overwrites records.",
      "muted"
    );
    const controls = node("div", undefined, "row");
    controls.style.justifyContent = "flex-start";
    controls.style.flexWrap = "wrap";

    const local = node("button", "Local rabbits");
    local.type = "button";
    if (state.source === "local") local.className = "primary";
    local.setAttribute("aria-pressed", String(state.source === "local"));
    local.onclick = () => { search = ""; resetCloudView(); controller.selectLocal(); };

    const cloud = node("button", "Development cloud");
    cloud.type = "button";
    if (state.source === "cloud") cloud.className = "primary";
    cloud.setAttribute("aria-pressed", String(state.source === "cloud"));
    cloud.disabled = state.status === "loading";
    cloud.onclick = () => { search = ""; resetCloudView(); controller.selectCloud(); };

    controls.append(local, cloud);
    section.append(heading, help, controls);
    return section;
  }

  function rabbitLabel(rabbit) {
    return [rabbit.Prefix, rabbit.Name ?? rabbit.name].filter(Boolean).join(" ") || "Unnamed rabbit";
  }

  function serializeParentChange(currentId, currentName, selectedId, historicalName) {
    if (selectedId) return selectedId === currentId ? undefined : selectedId;
    const name = historicalName.trim();
    if (!currentId && name === (currentName || "").trim()) return undefined;
    return name ? { name } : null;
  }

  function renderParentField(state, draft, role, changes, readChanges) {
    const title = role === "Father" ? "Sire" : "Dam";
    const group = node("fieldset", undefined, "tw-cloud-parent-field");
    group.append(node("legend", title));
    if (Object.hasOwn(draft, "litterTypedId")) {
      group.append(node("p", `${draft[role] || "Unknown"} · Inherited from litter`));
      return group;
    }
    const current = draft[`${role}TypedId`];
    const searchLabel = node("label", `Search eligible ${title.toLowerCase()}s by name, tattoo or breed`);
    const search = document.createElement("input");
    search.type = "search";
    searchLabel.append(search);
    const choiceLabel = node("label", `Choose ${title.toLowerCase()}`);
    const choice = document.createElement("select");
    choiceLabel.append(choice);
    const textLabel = node("label", "Historical name (text only)");
    const text = document.createElement("input");
    text.value = current ? "" : draft[role] || "";
    textLabel.append(text);
    const result = node("p", "", "muted");
    result.setAttribute("role", "status");
    const selectedId = () => Object.hasOwn(changes, role) ? changes[role] : current;
    const syncText = () => { textLabel.hidden = !!selectedId(); };
    function appendChoice(value, label) {
      const option = node("option", label);
      option.value = value;
      choice.append(option);
    }
    function refresh() {
      const selected = selectedId();
      const matches = eligibleParents(state.records, draft._id, role, search.value);
      choice.replaceChildren();
      appendChoice("", "No linked rabbit");
      if (current) appendChoice(current, `Keep current: ${draft[role] || "Linked rabbit"}`);
      for (const candidate of matches) {
        const { record, metadata } = candidate;
        if (metadata.typedId !== current) appendChoice(metadata.typedId, `${rabbitLabel(record)} · ${record.Tattoo || "No tattoo"}`);
      }
      if (selected && ![...choice.options].some(option => option.value === selected)) {
        const retained = state.records.find(candidate => candidate.metadata.typedId === selected);
        appendChoice(selected, retained ? rabbitLabel(retained.record) : "Selected rabbit");
      }
      choice.value = selected || "";
      result.textContent = matches.length ? `${matches.length} eligible matches` : "No eligible matches";
      syncText();
    }
    search.oninput = refresh;
    choice.onchange = () => {
      const id = choice.value || null;
      if (id === (current || null)) delete changes[role];
      else changes[role] = id;
      syncText();
    };
    refresh();
    readChanges[role] = () => serializeParentChange(current, draft[role], choice.value || null, text.value);
    group.append(searchLabel, choiceLabel, result, textLabel);
    return group;
  }

  function renderCloudPedigree(view, state, entry) {
    view.append(sourceControls(state));
    const controls = node("div", undefined, "row no-print");
    const back = node("button", "Back to rabbit");
    back.type = "button";
    back.onclick = () => { move("back"); window.render(); };
    const label = node("label", "Generations");
    const select = document.createElement("select");
    for (const count of [3, 5]) {
      const option = node("option", `${count} generations`);
      option.value = String(count);
      select.append(option);
    }
    select.value = String(pedigreeGenerations);
    select.onchange = () => { pedigreeGenerations = Number(select.value); window.render(); };
    label.append(select);
    const print = node("button", "Print / Save PDF");
    print.type = "button";
    print.disabled = true;
    print.onclick = () => window.print();
    controls.append(back, label, print);
    const status = node("p", "Loading cloud pedigree…", "no-print");
    status.setAttribute("role", "status");
    view.append(controls, status);
    const generations = pedigreeGenerations;
    const context = operationContext(state, entry.metadata.identityKey);
    const current = () => status.isConnected && pedigreeGenerations === generations && contextIsCurrent(context, true);
    window.twVersionedRabbitClient.getPedigree({
      fetchImpl: (...args) => fetch(...args),
      rabbitryId: entry.metadata.rabbitryId,
      typedId: entry.metadata.typedId,
      generations
    }).then(nodes => {
      if (!current()) return;
      const byPath = new Map(nodes.map(item => [item.path, item]));
      const sheet = node("section", undefined, "tw-ped-print tw-cloud-pedigree");
      const header = node("div", undefined, "card tw-ped-head");
      const brand = node("div", undefined, "pedigree-brand");
      const logo = node("img");
      logo.src = "./tangled-woods-logo.jpg";
      logo.alt = "Tangled Woods Rabbitry";
      brand.append(logo, node("strong", `Tangled Woods Rabbitry · ${generations}-Generation Pedigree`));
      header.append(brand);
      const labels = node("div", undefined, "tw-ped-labels");
      const tree = node("div", undefined, "tw-ped-tree");
      tree.dataset.gens = String(generations);
      for (const element of [labels, tree]) element.style.setProperty("--tw-cols", generations);
      const headings = ["Rabbit", "Parents", "Grandparents", "Great-grandparents", "4th generation ancestors"];
      const statuses = { archived: "Archived", deleted: "Deleted", unavailable: "Unavailable",
        cycle: "Cycle detected", "text-only": "Historical name only", unknown: "Not recorded" };
      for (let depth = 0; depth < generations; depth++) {
        labels.append(node("div", headings[depth]));
        const column = node("div", undefined, "tw-ped-col");
        column.style.setProperty("--tw-rows", 2 ** depth);
        for (let position = 0; position < 2 ** depth; position++) {
          const path = depth ? position.toString(2).padStart(depth, "0") : "";
          const item = byPath.get(path) || { label: "Unknown", status: "unknown", details: {} };
          const cell = node("div", undefined, `tw-ped-cell ${item.status}`);
          cell.append(node("strong", item.label));
          const details = Object.entries(item.details).map(([key, value]) => `${key}: ${value}`).join(" · ");
          if (details) cell.append(node("small", details));
          if (statuses[item.status]) cell.append(node("small", statuses[item.status]));
          column.append(cell);
        }
        tree.append(column);
      }
      const scroll = node("div", undefined, "tw-cloud-pedigree-scroll");
      scroll.tabIndex = 0;
      scroll.setAttribute("role", "region");
      scroll.setAttribute("aria-label", "Pedigree tree");
      scroll.append(labels, tree);
      sheet.append(header, scroll, node("div",
        "I certify this pedigree is correct to the best of my knowledge. Signature: ________________________ Date: __________",
        "tw-ped-sign"));
      view.append(sheet);
      status.textContent = "Cloud pedigree loaded.";
      print.disabled = false;
    }).catch(error => {
      if (!current()) return;
      status.textContent = error?.offline ? "Cloud pedigree unavailable offline. Reconnect and try again."
        : error?.status === 404 ? "This cloud rabbit is no longer available. Reload cloud rabbits."
          : requestMessage(error);
      const retry = node("button", "Retry", "no-print");
      retry.type = "button";
      retry.onclick = () => window.render();
      controls.append(retry);
    });
  }

  function weightLabel(ounces) {
    const remainder = (ounces % 16).toFixed(2).replace(/\.?0+$/, "");
    return `${Math.floor(ounces / 16)} lb ${remainder} oz`;
  }

  function renderWeightGraph(history) {
    const width = 600;
    const height = 230;
    const graph = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    graph.setAttribute("viewBox", `0 0 ${width} ${height}`);
    graph.setAttribute("role", "img");
    graph.setAttribute("aria-label", "Cloud rabbit weight growth over time");
    graph.style.width = "100%";
    graph.style.maxWidth = "700px";
    graph.style.height = "auto";
    const values = history.map((entry) => entry.ounces / 16);
    const times = history.map((entry) => Date.parse(`${entry.date}T12:00:00Z`));
    const low = Math.max(0, Math.min(...values) - 0.25);
    const high = Math.max(...values) + 0.25;
    const first = Math.min(...times);
    const last = Math.max(...times);
    const x = (time) => 55 + (time - first) / (last - first) * 490;
    const y = (value) => 185 - (value - low) / (high - low) * 150;
    const svgNode = (tag, attributes, text) => {
      const item = document.createElementNS("http://www.w3.org/2000/svg", tag);
      for (const [name, value] of Object.entries(attributes)) item.setAttribute(name, value);
      if (text !== undefined) item.textContent = text;
      graph.append(item);
      return item;
    };
    svgNode("line", { x1: 55, y1: 185, x2: 545, y2: 185, stroke: "currentColor", "stroke-opacity": ".5" });
    svgNode("line", { x1: 55, y1: 35, x2: 55, y2: 185, stroke: "currentColor", "stroke-opacity": ".5" });
    const points = history.map((entry, index) => `${x(times[index])},${y(values[index])}`).join(" ");
    svgNode("polyline", { points, fill: "none", stroke: "#37876a", "stroke-width": 3, "stroke-linejoin": "round" });
    history.forEach((entry, index) => {
      const dot = svgNode("circle", { cx: x(times[index]), cy: y(values[index]), r: 4, fill: "#37876a" });
      const tip = document.createElementNS("http://www.w3.org/2000/svg", "title");
      tip.textContent = `${entry.date} — ${weightLabel(entry.ounces)}`;
      dot.append(tip);
    });
    svgNode("text", { x: 55, y: 210, "font-size": 12, fill: "currentColor" }, history[0].date);
    svgNode("text", { x: 545, y: 210, "text-anchor": "end", "font-size": 12, fill: "currentColor" }, history.at(-1).date);
    return graph;
  }

  function renderCloudWeightCard(entry) {
    const card = node("section", undefined, "card");
    card.append(node("h3", "Weight history (lb / oz)"));
    let history;
    try {
      history = validateWeightHistory(entry.record.weightHistory);
    } catch {
      card.append(node("p", "Existing cloud weight history is malformed and cannot be edited safely.", "tw-cloud-app-banner"));
      return card;
    }
    const chronological = history.slice().sort((left, right) => left.date.localeCompare(right.date));
    if (!chronological.length) card.append(node("p", "No weights recorded yet.", "muted"));
    else {
      const latest = chronological.at(-1);
      const current = node("p");
      current.append(node("strong", "Current weight: "), document.createTextNode(`${weightLabel(latest.ounces)} — ${latest.date}`));
      card.append(current);
      const list = document.createElement("ul");
      list.setAttribute("aria-label", "Dated cloud weight history");
      for (const entry of chronological) list.append(node("li", `${entry.date}: ${weightLabel(entry.ounces)}`));
      card.append(list);
      if (chronological.length >= 2) card.append(renderWeightGraph(chronological));
    }
    const edit = node("button", "Edit Weight");
    edit.type = "button";
    edit.onclick = () => {
      weightDraft = validateWeightHistory(controller.getState().selected.record.weightHistory).map((measurement) => ({
        entry: measurement,
        date: measurement.date,
        pounds: String(Math.floor(measurement.ounces / 16)),
        ounces: String(Number((measurement.ounces % 16).toFixed(6))),
        changed: false
      }));
      move("weight");
      window.render();
    };
    const actions = node("div", undefined, "row");
    actions.setAttribute("role", "group");
    actions.setAttribute("aria-label", "Weight history actions");
    actions.style.justifyContent = "flex-start";
    actions.style.marginTop = "16px";
    actions.append(edit);
    card.append(actions);
    return card;
  }

  function renderCloudMilestoneCard(entry) {
    const card = node("section", undefined, "card");
    card.append(node("h3", "Development Milestones"));
    let milestones;
    try {
      milestones = validateMilestones(entry.record.kitMilestones);
    } catch {
      card.append(node("p", "Existing cloud milestones are malformed and cannot be edited safely.", "tw-cloud-app-banner"));
      return card;
    }
    for (const [key, label] of MILESTONE_FIELDS) {
      const fallback = key === "weaned" ? entry.record.WeanedDate : "";
      card.append(node("p", `${label}: ${milestones[key] || fallback || "Not recorded"}`));
    }
    const edit = node("button", "Edit Milestones");
    edit.type = "button";
    edit.onclick = () => {
      milestoneDraft = validateMilestones(controller.getState().selected.record.kitMilestones);
      move("milestones");
      window.render();
    };
    card.append(edit);
    return card;
  }

  function renderCloudDetail(view, state, entry) {
    const rabbit = entry.record;
    const back = node("button", "← Rabbits");
    back.type = "button";
    back.onclick = () => { controller.clearSelection(); move("back"); window.render(); };
    const heading = node("h2", rabbitLabel(rabbit));
    const notice = node("p", "Development cloud rabbit.", "tw-cloud-app-banner");
    notice.textContent = "Editing, changing photographs, or soft deletion creates a new cloud revision.";
    const card = node("div", undefined, "card");
    if (state.message) {
      const status = node("p", state.message, "muted");
      status.setAttribute("role", "status");
      card.append(status);
    }
    const revision = node("p", `Cloud revision ${entry.metadata.revision}`, "muted");
    card.append(revision);
    const actions = node("div", undefined, "row");
    actions.setAttribute("role", "group");
    actions.setAttribute("aria-label", "Cloud rabbit actions");
    styleCloudActionRow(actions);
    const edit = node("button", "Edit rabbit", "primary");
    edit.type = "button";
    styleCloudActionButton(edit);
    edit.onclick = () => {
      editDraft = structuredClone(controller.getState().selected.record);
      move("edit");
      window.render();
    };
    const archive = node("button", isArchivedRabbit(rabbit) ? "Unarchive rabbit" : "Archive rabbit");
    archive.type = "button";
    styleCloudActionButton(archive);
    const archiveStatus = node("p", "", "muted");
    let galleryBusy = false;
    let archiveBusy = false;
    let profileNeedsReload = false;
    archiveStatus.setAttribute("role", "status");
    archive.onclick = async () => {
      if (archive.disabled) return;
      const current = controller.getState().selected;
      const context = operationContext(state, current.metadata.identityKey);
      const archived = isArchivedRabbit(current.record);
      archiveBusy = true;
      syncProfileButtons();
      archiveStatus.textContent = archived ? "Unarchiving cloud rabbit..." : "Archiving cloud rabbit...";
      try {
        const updated = await controller.updateCloud(current, createArchiveRevision(current.record, !archived));
        if (contextIsCurrent(context, true)) {
          controller.selectRecord(updated);
          archiveStatus.textContent = isArchivedRabbit(updated.record)
            ? "Rabbit archived in a new cloud revision."
            : "Rabbit restored to the active list in a new cloud revision.";
          window.render();
        }
      } catch (error) {
        if (contextIsCurrent(context, true)) {
          archiveStatus.textContent = requestMessage(error);
        }
      } finally {
        archiveBusy = false;
        syncProfileButtons();
      }
    };
    const remove = node("button", "Delete rabbit");
    remove.type = "button";
    remove.style.marginLeft = "auto";
    styleCloudDestructiveButton(remove);
    remove.onclick = () => { move("delete"); window.render(); };
    const pedigree = node("button", "View pedigree");
    pedigree.type = "button";
    pedigree.onclick = () => { move("pedigree"); window.render(); };
    actions.append(edit, pedigree, archive, remove);
    card.append(actions, archiveStatus);
    const fields = CLOUD_PROFILE_FIELDS.filter((field) => field !== "Prefix" && field !== "Name");
    if (Object.hasOwn(rabbit, "DOB") && !Object.hasOwn(rabbit, "DoB")) fields.splice(6, 0, "DOB");
    for (const field of fields) {
      if (rabbit[field] === undefined || rabbit[field] === "") continue;
      const line = node("p");
      const label = node("strong", `${field}: `);
      line.append(label, document.createTextNode(String(rabbit[field])));
      card.append(line);
    }
    if (!card.childNodes.length) card.append(node("p", "No additional rabbit details are available.", "muted"));
    const gallery = node("section");
    const weight = renderCloudWeightCard(entry);
    const milestones = renderCloudMilestoneCard(entry);
    const profileButtons = [edit, archive, remove, ...weight.querySelectorAll("button"), ...milestones.querySelectorAll("button")];
    function syncProfileButtons() {
      for (const button of profileButtons) button.disabled = galleryBusy || archiveBusy || profileNeedsReload;
    }
    view.append(sourceControls(state), back, heading, notice, card, gallery, weight, milestones);
    window.twCloudRabbitPhotos?.mount(gallery, entry, {
      developmentDiagnostics: state.source === "cloud" && cloudFirstPreview,
      onBusy: busy => { galleryBusy = busy; syncProfileButtons(); },
      onSnapshot: async snapshot => {
        const currentState = controller.getState();
        const current = currentState.records.find(item => item.metadata.identityKey === entry.metadata.identityKey);
        if (currentState.source !== "cloud" || !current) return;
        profileNeedsReload = current.metadata.revision < snapshot.revision;
        if (!profileNeedsReload) return;
        const fresh = await controller.refreshCloudEntry(current);
        if (!fresh) return;
        if (fresh.metadata.revision < snapshot.revision) throw new Error("Cloud rabbit revision is not yet available");
        profileNeedsReload = false;
        if (gallery.isConnected) {
          revision.textContent = `Cloud revision ${fresh.metadata.revision}`;
          archive.textContent = isArchivedRabbit(fresh.record) ? "Unarchive rabbit" : "Archive rabbit";
        } else if (viewMode === "list" && controller.getState().source === "cloud") {
          renderCloudListResults(view, controller.getState());
        }
      }
    });
  }

  function renderCloudDeleteConfirmation(view, state, entry) {
    view.append(sourceControls(state));
    const heading = node("h2", "Confirm versioned rabbit deletion");
    const warning = node("p", `Delete \"${rabbitLabel(entry.record)}\"? This hides the rabbit by creating revision ${entry.metadata.revision + 1}; its complete history is preserved.`, "tw-cloud-app-banner");
    const controls = node("div", undefined, "row");
    controls.setAttribute("role", "group");
    controls.setAttribute("aria-label", "Deletion confirmation actions");
    styleCloudActionRow(controls);
    const cancel = node("button", "Cancel");
    cancel.type = "button";
    styleCloudActionButton(cancel);
    cancel.onclick = () => { move("cancel"); window.render(); };
    const remove = node("button", "Delete versioned rabbit");
    remove.type = "button";
    styleCloudDestructiveButton(remove);
    const status = node("p", "", "muted");
    status.setAttribute("role", "status");
    remove.onclick = async () => {
      if (remove.disabled) return;
      const context = operationContext(state, entry.metadata.identityKey);
      remove.disabled = true;
      cancel.disabled = true;
      status.textContent = "Deleting cloud rabbit...";
      try {
        await controller.deleteCloud(entry);
        const current = controller.getState();
        const deleteContextCurrent = current.sourceIdentity.key === context.sourceKey &&
          viewMode === context.viewMode &&
          (!current.selected || current.selected.metadata.identityKey === context.identityKey);
        if (deleteContextCurrent) {
          controller.clearSelection();
          move("success");
          window.render();
        }
      } catch (error) {
        if (contextIsCurrent(context, true)) {
          status.textContent = requestMessage(error);
          remove.disabled = false;
          cancel.disabled = false;
        }
      }
    };
    controls.append(cancel, remove);
    view.append(heading, warning, controls, status);
  }

  function renderCloudForm(view, state, { entry = null, draft, mode }) {
    const editing = mode === "edit";
    view.append(sourceControls(state));
    const back = node("button", editing ? "Back to rabbit details" : "← Rabbits");
    back.type = "button";
    back.onclick = () => {
      if (editing) editDraft = null;
      else createDraft = null;
      move("cancel");
      window.render();
    };
    const heading = node("h2", editing ? `Edit ${rabbitLabel(entry.record)}` : "Add rabbit");
    const notice = node(
      "p",
      editing
        ? `Saving creates cloud revision ${entry.metadata.revision + 1}. Local and legacy cloud rabbits are not changed.`
        : "Save a new rabbit to the authenticated development cloud. Local records are not changed.",
      "tw-cloud-app-banner"
    );
    const form = document.createElement("form");
    const dateField = Object.hasOwn(draft, "DOB") && !Object.hasOwn(draft, "DoB") ? "DOB" : "DoB";
    const fields = CLOUD_PROFILE_FIELDS.map((field) => field === "DoB" ? dateField : field);
    const changes = parentDrafts.get(draft) || {};
    const readChanges = {};
    parentDrafts.set(draft, changes);
    for (const field of fields) {
      if (field === "Father" || field === "Mother") {
        form.append(renderParentField(state, draft, field, changes, readChanges));
        continue;
      }
      const label = node("label", field);
      const input = document.createElement(field === "Notes" || field === "Bio" ? "textarea" : "input");
      input.name = field;
      input.value = draft[field] || "";
      input.oninput = () => { draft[field] = input.value; };
      label.append(input);
      form.append(label);
    }
    const saveButton = node("button", editing ? "Save new revision" : "Save rabbit", "primary");
    saveButton.type = "submit";
    const status = node("p", "", "muted");
    status.setAttribute("role", "status");
    form.append(saveButton, status);
    form.onsubmit = async (event) => {
      event.preventDefault();
      if (saveButton.disabled) return;
      const context = operationContext(state, entry?.metadata?.identityKey || null);
      saveButton.disabled = true;
      status.textContent = "Saving cloud rabbit...";
      try {
        const commands = Object.fromEntries(Object.entries(readChanges)
          .map(([role, read]) => [role, read()]).filter(([, value]) => value !== undefined));
        const parentChanges = Object.keys(commands).length ? commands : undefined;
        const saved = editing
          ? await controller.updateCloud(entry, draft, parentChanges)
          : await controller.createCloud(draft, parentChanges);
        if (form.isConnected && contextIsCurrent(context, editing)) {
          if (editing) editDraft = null;
          else {
            createDraft = null;
            controller.selectRecord(saved);
          }
          move("success");
          window.render();
        }
      } catch (error) {
        if (form.isConnected && contextIsCurrent(context, editing)) {
          status.textContent = requestMessage(error);
          saveButton.disabled = false;
        }
      }
    };
    view.append(back, heading, notice, form);
  }

  function renderCloudEdit(view, state, entry) {
    renderCloudForm(view, state, { entry, draft: editDraft, mode: "edit" });
  }

  function renderCloudWeightEditor(view, state, entry) {
    view.append(sourceControls(state));
    const back = node("button", "Back to rabbit details");
    back.type = "button";
    back.onclick = () => { weightDraft = null; move("cancel"); window.render(); };
    const heading = node("h2", `Edit Weight History — ${rabbitLabel(entry.record)}`);
    const notice = node("p", `Saving creates cloud revision ${entry.metadata.revision + 1}. The existing Weight field is not changed.`, "tw-cloud-app-banner");
    const form = document.createElement("form");
    const rows = document.createElement("div");
    rows.setAttribute("aria-label", "Cloud weight entries");
    for (const [index, draft] of weightDraft.entries()) {
      const row = node("div", undefined, "card");
      row.style.display = "grid";
      row.style.gridTemplateColumns = "repeat(auto-fit, minmax(140px, 1fr))";
      row.style.gap = "12px";
      row.style.alignItems = "end";
      const dateLabel = node("label", "Date");
      const date = document.createElement("input");
      date.type = "date";
      date.value = draft.date;
      date.oninput = () => { draft.date = date.value; draft.changed = true; };
      dateLabel.append(date);
      const poundsLabel = node("label", "Pounds");
      const pounds = document.createElement("input");
      pounds.type = "number";
      pounds.min = "0";
      pounds.step = "1";
      pounds.value = draft.pounds;
      pounds.oninput = () => { draft.pounds = pounds.value; draft.changed = true; };
      poundsLabel.append(pounds);
      const ouncesLabel = node("label", "Whole ounces (0–15)");
      const ounces = document.createElement("input");
      ounces.type = "number";
      ounces.min = "0";
      ounces.max = "15";
      ounces.step = "1";
      ounces.value = draft.ounces;
      ounces.oninput = () => { draft.ounces = ounces.value; draft.changed = true; };
      ouncesLabel.append(ounces);
      const remove = node("button", "Remove");
      remove.type = "button";
      remove.onclick = () => { weightDraft.splice(index, 1); window.render(); };
      row.append(dateLabel, poundsLabel, ouncesLabel, remove);
      rows.append(row);
    }
    if (!weightDraft.length) rows.append(node("p", "No weight entries. Add one below.", "muted"));
    const add = node("button", "+ Add weight");
    add.type = "button";
    add.disabled = weightDraft.length >= MAX_WEIGHT_ENTRIES;
    add.onclick = () => {
      if (weightDraft.length >= MAX_WEIGHT_ENTRIES) return;
      weightDraft.push({ entry: {}, date: "", pounds: "", ounces: "", changed: true });
      window.render();
    };
    const save = node("button", "Save Weight", "primary");
    save.type = "submit";
    const cancel = node("button", "Cancel");
    cancel.type = "button";
    cancel.onclick = () => { weightDraft = null; move("cancel"); window.render(); };
    const controls = node("div", undefined, "row");
    styleCloudActionRow(controls);
    controls.append(add, save, cancel);
    const status = node("p", "", "muted");
    status.setAttribute("role", "status");
    form.append(rows, controls, status);
    form.onsubmit = async (event) => {
      event.preventDefault();
      if (save.disabled) return;
      const context = operationContext(state, entry.metadata.identityKey);
      try {
        const history = buildWeightHistoryFromDraft(weightDraft);
        const revision = createWeightRevision(entry.record, history);
        save.disabled = true;
        add.disabled = true;
        cancel.disabled = true;
        status.textContent = "Saving cloud weight history...";
        const updated = await controller.updateCloud(entry, revision);
        if (contextIsCurrent(context, true)) {
          controller.selectRecord(updated);
          weightDraft = null;
          move("success");
          window.render();
        }
      } catch (error) {
        if (contextIsCurrent(context, true)) {
          status.textContent = error instanceof TypeError ? error.message : requestMessage(error);
          save.disabled = false;
          add.disabled = weightDraft.length >= MAX_WEIGHT_ENTRIES;
          cancel.disabled = false;
        }
      }
    };
    view.append(back, heading, notice, form);
  }

  function renderCloudMilestoneEditor(view, state, entry) {
    view.append(sourceControls(state));
    const back = node("button", "Back to rabbit details");
    back.type = "button";
    back.onclick = () => { milestoneDraft = null; move("cancel"); window.render(); };
    const heading = node("h2", `Edit Development Milestones — ${rabbitLabel(entry.record)}`);
    const notice = node("p", `Saving creates cloud revision ${entry.metadata.revision + 1}. WeanedDate and relationship records are not changed.`, "tw-cloud-app-banner");
    const form = document.createElement("form");
    const inputs = {};
    for (const [key, label] of MILESTONE_FIELDS) {
      const control = document.createElement("div");
      control.style.display = "grid";
      control.style.gridTemplateColumns = "minmax(0, 1fr) auto";
      control.style.gap = "10px";
      control.style.alignItems = "end";
      control.style.marginBottom = "13px";
      const field = node("label", `${label} date (optional)`);
      const input = document.createElement("input");
      input.type = "date";
      input.value = milestoneDraft[key] || "";
      input.style.marginBottom = "0";
      input.oninput = () => { milestoneDraft[key] = input.value; };
      field.append(input);
      const clear = node("button", "×");
      clear.type = "button";
      clear.setAttribute("aria-label", `Clear ${label} date`);
      clear.title = `Clear ${label} date`;
      clear.style.minWidth = "44px";
      clear.style.minHeight = "44px";
      clear.style.padding = "0";
      clear.onclick = () => {
        clearMilestoneDraft(milestoneDraft, key);
        input.value = "";
        input.focus();
      };
      control.append(field, clear);
      form.append(control);
      inputs[key] = input;
    }
    const save = node("button", "Save Milestones", "primary");
    save.type = "submit";
    const cancel = node("button", "Cancel");
    cancel.type = "button";
    cancel.onclick = () => { milestoneDraft = null; move("cancel"); window.render(); };
    const controls = node("div", undefined, "row");
    styleCloudActionRow(controls);
    controls.append(save, cancel);
    const status = node("p", "", "muted");
    status.setAttribute("role", "status");
    form.append(controls, status);
    form.onsubmit = async (event) => {
      event.preventDefault();
      if (save.disabled) return;
      const context = operationContext(state, entry.metadata.identityKey);
      try {
        const changes = {};
        for (const [key] of MILESTONE_FIELDS) changes[key] = inputs[key].value;
        const revision = createMilestoneRevision(entry.record, changes);
        save.disabled = true;
        cancel.disabled = true;
        status.textContent = "Saving cloud milestones...";
        const updated = await controller.updateCloud(entry, revision);
        if (contextIsCurrent(context, true)) {
          controller.selectRecord(updated);
          milestoneDraft = null;
          move("success");
          window.render();
        }
      } catch (error) {
        if (contextIsCurrent(context, true)) {
          status.textContent = error instanceof TypeError ? error.message : requestMessage(error);
          save.disabled = false;
          cancel.disabled = false;
        }
      }
    };
    view.append(back, heading, notice, form);
  }

  function renderCloudList(view, state) {
    view.append(sourceControls(state));
    const heading = node("h2", "Rabbits");
    const notice = node("p", "", "tw-cloud-app-banner");
    const badge = node("span", "Development cloud", "muted");
    badge.setAttribute("aria-label", "Rabbit source: Development cloud");
    notice.textContent = "Versioned cloud rabbits and photos are isolated from local and legacy cloud records.";
    const status = node("p", state.message, "muted");
    status.setAttribute("role", "status");
    view.append(heading, badge, notice, status);

    if (state.status === "loading") return;
    if (state.status === "error") {
      const retry = node("button", "Try again");
      retry.type = "button";
      retry.onclick = () => controller.selectCloud();
      view.append(retry);
      const useLocal = node("button", "Use local rabbits on this device");
      useLocal.type = "button";
      useLocal.onclick = () => controller.selectLocal();
      view.append(useLocal);
      return;
    }

    const add = node("button", "+ Add rabbit", "primary");
    add.type = "button";
    add.onclick = () => {
      try {
        createDraft = { _id: window.twVersionedRabbitClient.createRabbitId() };
        move("create");
        window.render();
      } catch (error) {
        status.textContent = requestMessage(error);
      }
    };
    add.style.marginBottom = "14px";
    view.append(add);

    const filters = node("div", undefined, "row");
    filters.setAttribute("role", "group");
    filters.setAttribute("aria-label", "Filter cloud rabbits by archive status");
    filters.style.justifyContent = "flex-start";
    filters.style.alignItems = "center";
    filters.style.flexWrap = "wrap";
    filters.style.gap = "12px";
    filters.style.marginBottom = "8px";
    for (const value of CLOUD_ARCHIVE_FILTERS) {
      const filter = node("button", value === "active" ? "Active" : "Archived");
      filter.type = "button";
      filter.setAttribute("aria-pressed", String(archiveFilter === value));
      if (archiveFilter === value) filter.className = "primary";
      filter.onclick = () => {
        archiveFilter = value;
        window.render();
      };
      filters.append(filter);
    }
    view.append(filters);

    const input = document.createElement("input");
    input.type = "search";
    input.placeholder = "Search cloud rabbits by name, breed, tattoo, or parent";
    input.value = search;
    input.oninput = () => { search = input.value; renderCloudListResults(view, state); };
    view.append(input);
    const count = node("div", undefined, "muted");
    count.id = "twCloudRabbitCount";
    const results = node("div");
    results.id = "twCloudRabbitResults";
    view.append(count, results);
    renderCloudListResults(view, state);
  }

  function renderCloudCreate(view, state) {
    renderCloudForm(view, state, { draft: createDraft, mode: "create" });
  }

  function renderCloudListResults(view, state) {
    const results = view.querySelector("#twCloudRabbitResults");
    const count = view.querySelector("#twCloudRabbitCount");
    if (!results || !count) return;
    const term = search.trim().toLowerCase();
    const fields = ["Prefix", "Name", "Breed", "Tattoo", "Father", "Mother", "Status"];
    const matches = filterCloudRecords(state.records, archiveFilter)
      .filter((entry) => !term || fields.some((field) => String(entry.record[field] || "").toLowerCase().includes(term)));
    count.textContent = `${matches.length} rabbit${matches.length === 1 ? "" : "s"}`;
    results.replaceChildren();
    for (const entry of matches) {
      const rabbit = entry.record;
      const button = node("button", undefined, "listitem");
      button.type = "button";
      const title = node("strong", rabbitLabel(rabbit));
      const summary = node("span", [rabbit.Sex, rabbit.Breed, rabbit.Tattoo].filter(Boolean).join(" · "), "muted");
      const primary = window.twCloudRabbitPhotos?.primaryPhotoUrl(entry);
      if (primary) {
        const image = node("img", undefined, "tw-cloud-photo-card-image");
        image.alt = "";
        image.loading = "lazy";
        image.onerror = () => image.remove();
        image.src = primary;
        button.append(image);
      }
      button.append(title, summary);
      button.onclick = () => { controller.selectRecord(entry); move("select"); window.render(); };
      results.append(button);
    }
    if (!matches.length) {
      const noun = archiveFilter === "archived" ? "archived cloud rabbits" : "active cloud rabbits";
      results.append(node("p", `No ${noun} match this search.`, "muted"));
    }
  }

  window.render = function () {
    if (page === "Rabbits" && cloudFirstPreview && !previewInitialized &&
        !(typeof window.twIsCloudTestMode === "function" && window.twIsCloudTestMode())) {
      previewInitialized = true;
      controller.initialize(window.location.hostname);
      return;
    }
    const result = priorRender.apply(this, arguments);
    if (page !== "Rabbits" || (typeof window.twIsCloudTestMode === "function" && window.twIsCloudTestMode())) return result;
    const state = controller.getState();
    const view = document.getElementById("view");
    if (!view) return result;
    if (state.source === "local") {
      view.prepend(sourceControls(state));
      return result;
    }
    view.replaceChildren();
    if (viewMode === "create" && state.status === "ready") renderCloudCreate(view, state);
    else if (viewMode === "edit" && state.selected && state.status === "ready") renderCloudEdit(view, state, state.selected);
    else if (viewMode === "edit-weight" && state.selected && state.status === "ready") renderCloudWeightEditor(view, state, state.selected);
    else if (viewMode === "edit-milestones" && state.selected && state.status === "ready") renderCloudMilestoneEditor(view, state, state.selected);
    else if (viewMode === "confirm-delete" && state.selected && state.status === "ready") renderCloudDeleteConfirmation(view, state, state.selected);
    else if (viewMode === "detail" && state.selected && state.status === "ready") renderCloudDetail(view, state, state.selected);
    else if (viewMode === "pedigree" && state.selected && state.status === "ready") renderCloudPedigree(view, state, state.selected);
    else renderCloudList(view, state);
    return result;
  };

  window.nav = function (target) {
    if (target !== "Rabbits") {
      previewInitialized = false;
      controller.reset();
      search = "";
      controller.clearSelection();
      resetCloudView();
    }
    return priorNav.apply(this, arguments);
  };

  window.twCloudRabbitSource.openProfile = async function (typedId) {
    if (window.twIsCloudTestMode?.()) return false;
    previewInitialized = true;
    resetCloudView();
    window.nav("Rabbits");
    if (!await controller.selectCloud() || page !== "Rabbits") return false;
    const state = controller.getState();
    const entry = state.records.find(record => record.metadata.typedId === typedId);
    if (state.source !== "cloud" || !entry) return false;
    controller.selectRecord(entry);
    move("select");
    window.render();
    return true;
  };

  if (page === "Rabbits") window.render();
})();
