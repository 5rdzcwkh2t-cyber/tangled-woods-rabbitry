(function () {
  "use strict";

  function requestMessage(error) {
    if (window.twVersionedRabbitClient?.requestMessage) {
      return window.twVersionedRabbitClient.requestMessage(error);
    }
    return "Cloud rabbits could not be loaded. Try again; local rabbits were not changed.";
  }

  function createController({ fetchImpl, render, client = window.twVersionedRabbitClient }) {
    let source = "local";
    let status = "idle";
    let records = [];
    let message = "";
    let requestVersion = 0;
    let createPromise = null;
    let updatePromise = null;

    const snapshot = () => ({ source, status, records: records.slice(), message });
    const redraw = () => { if (typeof render === "function") render(snapshot()); };

    function reset() {
      requestVersion += 1;
      source = "local";
      status = "idle";
      records = [];
      message = "";
    }

    function selectLocal() {
      reset();
      redraw();
    }

    async function selectCloud() {
      const version = ++requestVersion;
      source = "cloud";
      status = "loading";
      records = [];
      message = "Loading current Development D1 rabbits…";
      redraw();

      try {
        if (!client || typeof client.listRabbits !== "function") {
          throw new Error("Versioned rabbit client unavailable");
        }
        const current = await client.listRabbits({
          fetchImpl,
          rabbitryId: client.DEFAULT_RABBITRY_ID || "dev-auth-test"
        });
        if (version !== requestVersion || source !== "cloud") return;
        records = current;
        status = "ready";
        message = `${records.length} current Development D1 rabbit${records.length === 1 ? "" : "s"}.`;
      } catch (error) {
        if (version !== requestVersion || source !== "cloud") return;
        records = [];
        status = "error";
        message = requestMessage(error);
      }
      redraw();
    }

    function createCloud(record) {
      if (source !== "cloud" || !client || typeof client.createRabbit !== "function") {
        return Promise.reject(new Error("Cloud rabbit creation is unavailable"));
      }
      if (createPromise) return createPromise;
      createPromise = client.createRabbit({
        fetchImpl,
        rabbitryId: client.DEFAULT_RABBITRY_ID || "dev-auth-test",
        record
      }).then((created) => {
        if (source === "cloud") {
          records = records.concat([created]);
          message = "Cloud rabbit saved successfully.";
        }
        return created;
      }).finally(() => {
        createPromise = null;
      });
      return createPromise;
    }

    function updateCloud(entry, record) {
      if (source !== "cloud" || !client || typeof client.updateRabbit !== "function") {
        return Promise.reject(new Error("Cloud rabbit editing is unavailable"));
      }
      if (!entry || !entry.metadata || !Object.is(entry.metadata.id, record?._id)) {
        return Promise.reject(new Error("Cloud rabbit identity changed"));
      }
      if (updatePromise) return updatePromise;
      updatePromise = client.updateRabbit({
        fetchImpl,
        rabbitryId: client.DEFAULT_RABBITRY_ID || "dev-auth-test",
        baseRevision: entry.metadata.revision,
        record
      }).then((updated) => {
        if (source === "cloud") {
          const index = records.findIndex((candidate) => candidate.metadata.typedId === entry.metadata.typedId);
          if (index < 0) throw new Error("Cloud rabbit is no longer loaded");
          records = records.slice();
          records[index] = updated;
          message = "Cloud rabbit updated successfully.";
        }
        return updated;
      }).finally(() => { updatePromise = null; });
      return updatePromise;
    }

    return { getState: snapshot, reset, selectLocal, selectCloud, createCloud, updateCloud };
  }

  window.twCloudRabbitSource = { createController, requestMessage };

  if (typeof window.render !== "function" || typeof window.nav !== "function") return;

  const priorRender = window.render;
  const priorNav = window.nav;
  let search = "";
  let selectedRecord = null;
  let creating = false;
  let createDraft = null;
  let editing = false;
  let editDraft = null;

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
      "Local is the normal editable browser data. Development D1 is an isolated versioned view and never changes local records, legacy cloud records, or photographs.",
      "muted"
    );
    const controls = node("div", undefined, "row");
    controls.style.justifyContent = "flex-start";
    controls.style.flexWrap = "wrap";

    const local = node("button", "Local rabbits");
    local.type = "button";
    if (state.source === "local") local.className = "primary";
    local.setAttribute("aria-pressed", String(state.source === "local"));
    local.onclick = () => { search = ""; selectedRecord = null; editing = false; editDraft = null; controller.selectLocal(); };

    const cloud = node("button", "Development D1");
    cloud.type = "button";
    if (state.source === "cloud") cloud.className = "primary";
    cloud.setAttribute("aria-pressed", String(state.source === "cloud"));
    cloud.disabled = state.status === "loading";
    cloud.onclick = () => { search = ""; selectedRecord = null; editing = false; editDraft = null; controller.selectCloud(); };

    controls.append(local, cloud);
    section.append(heading, help, controls);
    return section;
  }

  function rabbitLabel(rabbit) {
    return [rabbit.Prefix, rabbit.Name].filter(Boolean).join(" ") || "Unnamed rabbit";
  }

  function renderCloudDetail(view, state, entry) {
    const rabbit = entry.record;
    const back = node("button", "← Development D1 rabbits");
    back.type = "button";
    back.onclick = () => { selectedRecord = null; window.render(); };
    const heading = node("h2", rabbitLabel(rabbit));
    const notice = node("p", "Development D1 — read-only. Editing, deletion, importing, restoring, and photograph changes are unavailable.", "tw-cloud-app-banner");
    notice.textContent = "Development D1 versioned rabbit. Editing creates a new revision; deletion, importing, restoring, and photograph changes are unavailable.";
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
      editing = true;
      window.render();
    };
    card.append(edit);
    const fields = ["Sex", "Tattoo", "Breed", "Color", "DOB", "DoB", "Father", "Mother", "Weight", "Status", "Notes"];
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

  function renderCloudEdit(view, state, entry) {
    view.append(sourceControls(state));
    const back = node("button", "Back to rabbit details");
    back.type = "button";
    back.onclick = () => { editing = false; editDraft = null; window.render(); };
    const heading = node("h2", `Edit ${rabbitLabel(entry.record)}`);
    const notice = node("p", `Saving creates cloud revision ${entry.metadata.revision + 1}. Local and legacy cloud rabbits are not changed.`, "tw-cloud-app-banner");
    const form = document.createElement("form");
    const dateField = Object.hasOwn(editDraft, "DOB") && !Object.hasOwn(editDraft, "DoB") ? "DOB" : "DoB";
    const fields = ["Prefix", "Name", "Sex", "Tattoo", "Breed", "Color", dateField, "Father", "Mother", "Weight", "Status", "Notes"];
    for (const field of fields) {
      const label = node("label", field);
      const input = document.createElement(field === "Notes" ? "textarea" : "input");
      input.name = field;
      input.value = editDraft[field] || "";
      input.oninput = () => { editDraft[field] = input.value; };
      label.append(input);
      form.append(label);
    }
    const saveButton = node("button", "Save new revision", "primary");
    saveButton.type = "submit";
    const status = node("p", "", "muted");
    status.setAttribute("role", "status");
    form.append(saveButton, status);
    form.onsubmit = async (event) => {
      event.preventDefault();
      if (saveButton.disabled) return;
      saveButton.disabled = true;
      status.textContent = "Saving cloud rabbit...";
      try {
        const updated = await controller.updateCloud(entry, editDraft);
        selectedRecord = updated;
        editing = false;
        editDraft = null;
        window.render();
      } catch (error) {
        status.textContent = requestMessage(error);
        saveButton.disabled = false;
      }
    };
    view.append(back, heading, notice, form);
  }

  function renderCloudList(view, state) {
    view.append(sourceControls(state));
    const heading = node("h2", "Rabbits — Development D1 (read-only)");
    const notice = node("p", "This temporary view cannot change cloud or local records. Cloud photographs are not available.", "tw-cloud-app-banner");
    heading.textContent = "Rabbits - Development D1";
    notice.textContent = "Create or edit versioned development rabbits here. Local records, legacy cloud rabbits, and photographs are not changed.";
    const status = node("p", state.message, "muted");
    status.setAttribute("role", "status");
    view.append(heading, notice, status);

    if (state.status === "loading") return;
    if (state.status === "error") {
      const retry = node("button", "Try again");
      retry.type = "button";
      retry.onclick = () => controller.selectCloud();
      view.append(retry);
      return;
    }

    const add = node("button", "+ Add rabbit", "primary");
    add.type = "button";
    add.onclick = () => {
      try {
        createDraft = { _id: window.twVersionedRabbitClient.createRabbitId() };
        creating = true;
        window.render();
      } catch (error) {
        status.textContent = requestMessage(error);
      }
    };
    view.append(add);

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
    view.append(sourceControls(state));
    const back = node("button", "← Development D1 rabbits");
    back.type = "button";
    back.onclick = () => { creating = false; createDraft = null; window.render(); };
    const heading = node("h2", "Add rabbit");
    const notice = node("p", "Save a new rabbit to the authenticated Development D1 rabbitry. Local records are not changed.", "tw-cloud-app-banner");
    const form = document.createElement("form");
    const fields = ["Prefix", "Name", "Sex", "Tattoo", "Breed", "Color", "DoB", "Father", "Mother", "Weight", "Status", "Notes"];
    for (const field of fields) {
      const label = node("label", field);
      const input = document.createElement(field === "Notes" ? "textarea" : "input");
      input.name = field;
      input.value = createDraft[field] || "";
      input.oninput = () => { createDraft[field] = input.value; };
      label.append(input);
      form.append(label);
    }
    const saveButton = node("button", "Save record", "primary");
    saveButton.type = "submit";
    const status = node("p", "", "muted");
    status.setAttribute("role", "status");
    form.append(saveButton, status);
    form.onsubmit = async (event) => {
      event.preventDefault();
      if (saveButton.disabled) return;
      saveButton.disabled = true;
      status.textContent = "Saving cloud rabbit…";
      try {
        const created = await controller.createCloud(createDraft);
        creating = false;
        createDraft = null;
        selectedRecord = created;
        window.render();
      } catch (error) {
        status.textContent = requestMessage(error);
        saveButton.disabled = false;
      }
    };
    view.append(back, heading, notice, form);
  }

  function renderCloudListResults(view, state) {
    const results = view.querySelector("#twCloudRabbitResults");
    const count = view.querySelector("#twCloudRabbitCount");
    if (!results || !count) return;
    const term = search.trim().toLowerCase();
    const fields = ["Prefix", "Name", "Breed", "Tattoo", "Father", "Mother", "Status"];
    const matches = state.records.filter((entry) => !term || fields.some((field) => String(entry.record[field] || "").toLowerCase().includes(term)));
    count.textContent = `${matches.length} rabbit${matches.length === 1 ? "" : "s"}`;
    results.replaceChildren();
    for (const entry of matches) {
      const rabbit = entry.record;
      const button = node("button", undefined, "listitem");
      button.type = "button";
      const title = node("strong", rabbitLabel(rabbit));
      const summary = node("span", [rabbit.Sex, rabbit.Breed, rabbit.Tattoo].filter(Boolean).join(" · "), "muted");
      button.append(title, summary);
      button.onclick = () => { selectedRecord = entry; window.render(); };
      results.append(button);
    }
    if (!matches.length) results.append(node("p", "No cloud rabbits match this search.", "muted"));
  }

  window.render = function () {
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
    if (creating && state.status === "ready") renderCloudCreate(view, state);
    else if (editing && selectedRecord && state.status === "ready") renderCloudEdit(view, state, selectedRecord);
    else if (selectedRecord && state.status === "ready") renderCloudDetail(view, state, selectedRecord);
    else renderCloudList(view, state);
    return result;
  };

  window.nav = function (target) {
    if (target !== "Rabbits") {
      controller.reset();
      search = "";
      selectedRecord = null;
      creating = false;
      createDraft = null;
      editing = false;
      editDraft = null;
    }
    return priorNav.apply(this, arguments);
  };

  if (page === "Rabbits") window.render();
})();
