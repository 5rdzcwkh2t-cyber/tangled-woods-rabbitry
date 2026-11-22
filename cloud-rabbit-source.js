(function () {
  "use strict";

  const PREVIEW_PROJECT = "tangled-woods-rabbitry.pages.dev";
  const CLOUD_VIEWS = Object.freeze(["list", "detail", "create", "edit", "confirm-delete"]);
  const CLOUD_ARCHIVE_FILTERS = Object.freeze(["active", "archived"]);
  const CLOUD_PROFILE_FIELDS = Object.freeze([
    "Prefix", "Name", "Sex", "Tattoo", "Breed", "Color", "DoB", "Father", "Mother",
    "Weight", "Status", "Bio", "WeanedDate", "Notes"
  ]);

  function isArchivedRabbit(record) {
    return record?.Archived === true;
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

  function nextCloudView(current, action) {
    if (!CLOUD_VIEWS.includes(current)) throw new TypeError("Invalid cloud rabbit view");
    if (action === "reset") return "list";
    const transitions = {
      list: { select: "detail", create: "create" },
      detail: { back: "list", edit: "edit", delete: "confirm-delete" },
      create: { cancel: "list", success: "detail" },
      edit: { cancel: "detail", success: "detail" },
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
    if (window.twVersionedRabbitClient?.requestMessage) {
      return window.twVersionedRabbitClient.requestMessage(error);
    }
    return "Cloud rabbits could not be loaded. Try again; local rabbits were not changed.";
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
    }

    function createCloud(record) {
      if (management.getState().source.key !== cloudSource.key || !client || typeof client.createRabbit !== "function") {
        return Promise.reject(new Error("Cloud rabbit creation is unavailable"));
      }
      if (createPromise) return createPromise;
      const version = requestVersion;
      createPromise = client.createRabbit({
        fetchImpl,
        rabbitryId: client.DEFAULT_RABBITRY_ID || "dev-auth-test",
        record
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

    function updateCloud(entry, record) {
      if (management.getState().source.key !== cloudSource.key || !client || typeof client.updateRabbit !== "function") {
        return Promise.reject(new Error("Cloud rabbit editing is unavailable"));
      }
      if (!entry || !entry.metadata || !Object.is(entry.metadata.id, record?._id)) {
        return Promise.reject(new Error("Cloud rabbit identity changed"));
      }
      if (updatePromise) return updatePromise;
      const version = requestVersion;
      updatePromise = client.updateRabbit({
        fetchImpl,
        rabbitryId: client.DEFAULT_RABBITRY_ID || "dev-auth-test",
        baseRevision: entry.metadata.revision,
        record
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

    function clearSelection() {
      management.clearSelection();
    }

    return {
      getState: snapshot, reset, initialize, selectLocal, selectCloud,
      createCloud, updateCloud, deleteCloud, selectRecord, clearSelection
    };
  }

  window.twCloudRabbitSource = {
    CLOUD_ARCHIVE_FILTERS, CLOUD_PROFILE_FIELDS, CLOUD_VIEWS, createArchiveRevision,
    createController, filterCloudRecords, isArchivedRabbit, isDevelopmentPreviewHost,
    nextCloudView, requestMessage
  };

  if (typeof window.render !== "function" || typeof window.nav !== "function") return;

  const priorRender = window.render;
  const priorNav = window.nav;
  let search = "";
  let archiveFilter = "active";
  let viewMode = "list";
  let createDraft = null;
  let editDraft = null;
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
    return [rabbit.Prefix, rabbit.Name].filter(Boolean).join(" ") || "Unnamed rabbit";
  }

  function renderCloudDetail(view, state, entry) {
    const rabbit = entry.record;
    const back = node("button", "← Rabbits");
    back.type = "button";
    back.onclick = () => { controller.clearSelection(); move("back"); window.render(); };
    const heading = node("h2", rabbitLabel(rabbit));
    const notice = node("p", "Development cloud rabbit.", "tw-cloud-app-banner");
    notice.textContent = "Development cloud rabbit. Editing or soft deletion creates a new revision. Breeding, litters, pedigrees, photographs, importing, and restoring remain local-only.";
    const card = node("div", undefined, "card");
    if (state.message) {
      const status = node("p", state.message, "muted");
      status.setAttribute("role", "status");
      card.append(status);
    }
    const revision = node("p", `Cloud revision ${entry.metadata.revision}`, "muted");
    card.append(revision);
    const edit = node("button", "Edit rabbit", "primary");
    edit.type = "button";
    edit.onclick = () => {
      editDraft = structuredClone(entry.record);
      move("edit");
      window.render();
    };
    card.append(edit);
    const archive = node("button", isArchivedRabbit(rabbit) ? "Unarchive rabbit" : "Archive rabbit");
    archive.type = "button";
    const archiveStatus = node("p", "", "muted");
    archiveStatus.setAttribute("role", "status");
    archive.onclick = async () => {
      if (archive.disabled) return;
      const context = operationContext(state, entry.metadata.identityKey);
      archive.disabled = true;
      edit.disabled = true;
      archiveStatus.textContent = isArchivedRabbit(rabbit) ? "Unarchiving cloud rabbit..." : "Archiving cloud rabbit...";
      try {
        const updated = await controller.updateCloud(entry, createArchiveRevision(rabbit, !isArchivedRabbit(rabbit)));
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
          archive.disabled = false;
          edit.disabled = false;
        }
      }
    };
    card.append(archive, archiveStatus);
    const remove = node("button", "Delete rabbit");
    remove.type = "button";
    remove.onclick = () => { move("delete"); window.render(); };
    card.append(remove);
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
    view.append(sourceControls(state), back, heading, notice, card);
  }

  function renderCloudDeleteConfirmation(view, state, entry) {
    view.append(sourceControls(state));
    const heading = node("h2", "Confirm versioned rabbit deletion");
    const warning = node("p", `Delete \"${rabbitLabel(entry.record)}\"? This hides the rabbit by creating revision ${entry.metadata.revision + 1}; its complete history is preserved.`, "tw-cloud-app-banner");
    const controls = node("div", undefined, "row");
    controls.style.justifyContent = "flex-start";
    const cancel = node("button", "Cancel");
    cancel.type = "button";
    cancel.onclick = () => { move("cancel"); window.render(); };
    const remove = node("button", "Delete versioned rabbit", "primary");
    remove.type = "button";
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
    for (const field of fields) {
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
        const saved = editing
          ? await controller.updateCloud(entry, draft)
          : await controller.createCloud(draft);
        if (contextIsCurrent(context, editing)) {
          if (editing) editDraft = null;
          else {
            createDraft = null;
            controller.selectRecord(saved);
          }
          move("success");
          window.render();
        }
      } catch (error) {
        if (contextIsCurrent(context, editing)) {
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

  function renderCloudList(view, state) {
    view.append(sourceControls(state));
    const heading = node("h2", "Rabbits");
    const notice = node("p", "This temporary view cannot change cloud or local records. Cloud photographs are not available.", "tw-cloud-app-banner");
    const badge = node("span", "Development cloud", "muted");
    badge.setAttribute("aria-label", "Rabbit source: Development cloud");
    notice.textContent = "Versioned cloud rabbits are isolated from local and legacy cloud records. Relationship-dependent actions and photographs remain local-only.";
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
    else if (viewMode === "confirm-delete" && state.selected && state.status === "ready") renderCloudDeleteConfirmation(view, state, state.selected);
    else if (viewMode === "detail" && state.selected && state.status === "ready") renderCloudDetail(view, state, state.selected);
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

  if (page === "Rabbits") window.render();
})();
