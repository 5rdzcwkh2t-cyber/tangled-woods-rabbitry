(function () {
  "use strict";
  const PREVIEW_PROJECT = "tangled-woods-rabbitry.pages.dev";
  const NO_ELIGIBLE_BREEDINGS = "No eligible breedings are available. All Kindled breedings have already been used to create litters, or no breedings are marked Kindled.";
  const clone = value => typeof structuredClone === "function" ? structuredClone(value) : JSON.parse(JSON.stringify(value));
  const isObject = value => value !== null && typeof value === "object" && !Array.isArray(value);
  function isDevelopmentPreviewHost(hostname) {
    const host = String(hostname || "").trim().toLowerCase().replace(/\.$/, "");
    return host === `cloud-development.${PREVIEW_PROJECT}` || new RegExp(`^[a-f0-9]{8}\\.${PREVIEW_PROJECT.replace(/\./g, "\\.")}$`).test(host);
  }
  function identityKey(entry, rabbitryId) {
    if (typeof entry?.metadata?.typedId !== "string") throw new TypeError("Litter identity is unavailable");
    return JSON.stringify(["versioned-litter", rabbitryId, entry.metadata.typedId]);
  }
  function eligibleBreedings(breedings, claimedBreedingTypedIds) {
    if (!Array.isArray(breedings)) throw new TypeError("Cloud breedings must be an array");
    const linked = new Set(claimedBreedingTypedIds);
    return breedings.filter(entry => isObject(entry?.record) && typeof entry?.metadata?.typedId === "string" &&
      entry.record.status === "Kindled" && !linked.has(entry.metadata.typedId));
  }
  function applyLitterFields(base, values) {
    const record = clone(base);
    for (const [key, value] of Object.entries(values)) {
      if (["Total Kits", "Sold Kits", "Died Kits"].includes(key) && value === "") delete record[key];
      else record[key] = value;
    }
    return record;
  }
  function rabbitName(rabbits, typedId, fallback) {
    const rabbit = rabbits.find(entry => entry?.metadata?.typedId === typedId);
    return rabbit ? [rabbit.record.Prefix, rabbit.record.Name].filter(Boolean).join(" ") || fallback : fallback;
  }
  function breedingLabel(breeding, rabbits) {
    const record = breeding.record;
    return `${rabbitName(rabbits, record.doeTypedId, "Unavailable doe")} × ${rabbitName(rabbits, record.buckTypedId, "Unavailable buck")} · ${record.date}`;
  }
  function createController({ fetchImpl, render, litterClient = window.twVersionedLitterClient,
    breedingClient = window.twVersionedBreedingClient, rabbitClient = window.twVersionedRabbitClient }) {
    const rabbitryId = litterClient?.DEFAULT_RABBITRY_ID || "dev-auth-test";
    let source = "local", status = "idle", message = "", litters = [], breedings = [], rabbits = [], selectedKey = null;
    let claims = new Set();
    let requestVersion = 0, createPromise = null, updatePromise = null, deletePromise = null;
    const selected = () => litters.find(entry => identityKey(entry, rabbitryId) === selectedKey) || null;
    const snapshot = () => ({
      source, status, rabbitryId, litters: litters.slice(), breedings: breedings.slice(),
      rabbits: rabbits.slice(), selected: selected(),
      eligible: eligibleBreedings(breedings, claims),
      message: status === "ready"
        ? `${litters.length} development cloud litter${litters.length === 1 ? "" : "s"}.`
        : message,
      addUnavailableMessage: status === "ready" && !eligibleBreedings(breedings, claims).length
        ? NO_ELIGIBLE_BREEDINGS : ""
    });
    const redraw = () => { if (typeof render === "function") render(snapshot()); };
    function reset() { requestVersion += 1; source = "local"; status = "idle"; message = ""; litters = []; breedings = []; rabbits = []; selectedKey = null; }
    function selectLocal() { reset(); redraw(); }
    async function selectCloud() {
      const version = ++requestVersion; source = "cloud"; status = "loading"; message = "Loading development cloud litters...";
      litters = []; breedings = []; rabbits = []; claims.clear(); selectedKey = null; redraw();
      try {
        if (!litterClient?.listLitters || !breedingClient?.listBreedings) throw new Error("Cloud clients unavailable");
        const loaded = await Promise.all([litterClient.listLitters({ fetchImpl, rabbitryId }), breedingClient.listBreedings({ fetchImpl, rabbitryId }),
          rabbitClient?.listRabbits ? rabbitClient.listRabbits({ fetchImpl, rabbitryId }) : Promise.resolve([])]);
        if (version !== requestVersion || source !== "cloud") return;
        claims = new Set(loaded[0].claimedBreedingTypedIds);
        litters = loaded[0].litters.map(clone); breedings = loaded[1].map(clone); rabbits = loaded[2].map(clone); status = "ready";
      } catch (error) { if (version !== requestVersion || source !== "cloud") return; status = "error"; message = litterClient?.requestMessage?.(error) || "Cloud litters could not be loaded."; }
      redraw();
    }
    function initialize(hostname) { return isDevelopmentPreviewHost(hostname) ? selectCloud() : Promise.resolve(snapshot()); }
    function selectRecord(entry) { const key = identityKey(entry, rabbitryId); if (!litters.some(x => identityKey(x, rabbitryId) === key)) throw new TypeError("Litter is not loaded"); selectedKey = key; return selected(); }
    async function loadDetail(entry) {
      selectRecord(entry); if (!litterClient?.getLitter) return selected();
      const key = selectedKey, version = requestVersion;
      const detail = await litterClient.getLitter({ fetchImpl, rabbitryId, typedId: entry.metadata.typedId });
      if (version === requestVersion && source === "cloud" && selectedKey === key) return upsert(detail);
      return detail;
    }
    function clearSelection() { selectedKey = null; }
    function upsert(entry) { const key = identityKey(entry, rabbitryId); const i = litters.findIndex(x => identityKey(x, rabbitryId) === key); if (i < 0) litters.push(clone(entry)); else litters[i] = clone(entry); selectedKey = key; return selected(); }
    function createCloud(breedingTypedId, record) {
      if (source !== "cloud" || !litterClient?.createLitter) return Promise.reject(new Error("Cloud litter creation is unavailable"));
      if (!eligibleBreedings(breedings, claims).some(x => x.metadata.typedId === breedingTypedId)) return Promise.reject(new Error("Select an eligible breeding that has never been claimed"));
      if (createPromise) return createPromise; const version = requestVersion;
      createPromise = litterClient.createLitter({ fetchImpl, rabbitryId, breedingTypedId, record }).then(entry => {
        if (version === requestVersion && source === "cloud") {
          claims.add(breedingTypedId);
          return upsert(entry);
        }
        return entry;
      }).finally(() => { createPromise = null; }); return createPromise;
    }
    function updateCloud(entry, record) {
      if (source !== "cloud" || !litterClient?.updateLitter) return Promise.reject(new Error("Cloud litter editing is unavailable"));
      for (const key of ["_id", "breedingTypedId", "damTypedId", "sireTypedId", "Dam", "Sire", "Bred"]) {
        if (!Object.is(entry?.record?.[key], record?.[key])) return Promise.reject(new Error("Litter identity or parent relationship changed"));
      }
      if (updatePromise) return updatePromise; const context = identityKey(entry, rabbitryId), version = requestVersion;
      updatePromise = litterClient.updateLitter({ fetchImpl, rabbitryId, baseRevision: entry.metadata.revision, record }).then(updated => {
        if (version === requestVersion && source === "cloud" && selectedKey === context) return upsert(updated); return updated;
      }).finally(() => { updatePromise = null; }); return updatePromise;
    }
    function deleteCloud(entry) {
      if (source !== "cloud" || !litterClient?.deleteLitter) return Promise.reject(new Error("Cloud litter deletion is unavailable"));
      if (deletePromise) return deletePromise; const key = identityKey(entry, rabbitryId), version = requestVersion;
      deletePromise = litterClient.deleteLitter({ fetchImpl, rabbitryId, typedId: entry.metadata.typedId,
        baseRevision: entry.metadata.revision, id: entry.record._id }).then(result => {
        if (version === requestVersion && source === "cloud" && selectedKey === key) { litters = litters.filter(x => identityKey(x, rabbitryId) !== key); selectedKey = null; }
        return result;
      }).finally(() => { deletePromise = null; }); return deletePromise;
    }
    return { getState: snapshot, initialize, reset, selectLocal, selectCloud, selectRecord, loadDetail, clearSelection, createCloud, updateCloud, deleteCloud };
  }
  window.twCloudLitterSource = { applyLitterFields, breedingLabel, createController, eligibleBreedings, isDevelopmentPreviewHost };
  if (typeof window.render !== "function" || typeof window.nav !== "function" || !window.document) return;
  const priorRender = window.render, priorNav = window.nav;
  const controller = createController({ fetchImpl: (...args) => fetch(...args), render: () => window.render() });
  let initialized = false, viewMode = "list", draft = null;
  const cloudFirst = isDevelopmentPreviewHost(window.location?.hostname);
  const node = (tag, text, className) => { const x = document.createElement(tag); if (text !== undefined) x.textContent = text; if (className) x.className = className; return x; };
  const field = (form, label, name, value = "", type = "text") => { const wrap = node("label", label); const input = node(type === "textarea" ? "textarea" : "input"); input.name = name; if (type !== "textarea") input.type = type; input.value = value ?? ""; wrap.append(input); form.append(wrap); return input; };
  function controls(state) {
    const box = node("div", undefined, "tw-litter-source-controls");
    for (const [label, source] of [["Development cloud", "cloud"], ["Local litters", "local"]]) {
      const button = node("button", label, state.source === source ? "primary" : ""); button.type = "button";
      button.onclick = () => { viewMode = "list"; draft = null; source === "cloud" ? controller.selectCloud() : controller.selectLocal(); }; box.append(button);
    } return box;
  }
  function value(record, key) { const v = record[key]; return v === undefined || v === null || v === "" ? "—" : String(v); }
  function summary(entry) { const r = entry.record; return `${value(r, "Name")} · born ${value(r, "Born")} · ${value(r, "Total Kits")} kits`; }
  function editRecord(form, base) {
    const values = {}; for (const [name, key] of [["Name", "Name"], ["Born", "Born"], ["Breed", "Breed"], ["TotalKits", "Total Kits"], ["SoldKits", "Sold Kits"], ["DiedKits", "Died Kits"], ["Notes", "Notes"]]) {
      const element = form.elements[name]; if (element) values[key] = element.value;
    } return applyLitterFields(base, values);
  }
  function renderForm(view, state, editing) {
    const entry = editing ? state.selected : null, form = node("form", undefined, "card tw-litter-form");
    form.append(node("h3", editing ? "Edit cloud litter" : "Create cloud litter"));
    let breedingSelect;
    if (!editing) { const label = node("label", "Eligible kindled breeding"); breedingSelect = node("select"); breedingSelect.name = "Breeding";
      const eligible = state.eligible; for (const b of eligible) { const option = node("option", breedingLabel(b, state.rabbits)); option.value = b.metadata.typedId; breedingSelect.append(option); }
      if (!eligible.length) breedingSelect.append(Object.assign(node("option", "No eligible kindled breedings"), { value: "" })); label.append(breedingSelect); form.append(label);
    } else { const r = entry.record; form.append(node("p", `Breeding ${value(r, "Bred")} · Doe: ${value(r, "Dam")} · Buck: ${value(r, "Sire")}`, "muted")); }
    const r = entry?.record || {}; field(form, "Litter name", "Name", r.Name); field(form, "Birth date", "Born", r.Born, "date"); field(form, "Breed", "Breed", r.Breed);
    field(form, "Total kits", "TotalKits", r["Total Kits"] ?? "", "number"); field(form, "Sold kits", "SoldKits", r["Sold Kits"] ?? "", "number"); field(form, "Died kits", "DiedKits", r["Died Kits"] ?? "", "number"); field(form, "Notes", "Notes", r.Notes, "textarea");
    const actions = node("div", undefined, "tw-litter-actions"), saveButton = node("button", "Save", "primary"), cancel = node("button", "Cancel"); saveButton.type = "submit"; cancel.type = "button";
    cancel.onclick = () => { viewMode = editing ? "detail" : "list"; window.render(); }; actions.append(saveButton, cancel); form.append(actions);
    const feedback = node("p", "", "muted"); form.append(feedback);
    form.onsubmit = async event => { event.preventDefault(); saveButton.disabled = true; feedback.textContent = "Saving...";
      try { if (editing) { const updated = editRecord(form, entry.record); await controller.updateCloud(entry, updated); }
        else { const record = editRecord(form, { _id: window.twVersionedLitterClient.createLitterId() }); await controller.createCloud(breedingSelect.value, record); }
        viewMode = "detail"; draft = null; window.render();
      } catch (error) { feedback.textContent = window.twVersionedLitterClient.requestMessage?.(error) || error.message; saveButton.disabled = false; }
    }; view.append(form);
  }
  function renderCloud(state) {
    const view = document.getElementById("view"); if (!view) return; view.replaceChildren();
    const top = node("div", undefined, "row"); top.append(node("h2", "Litters"), controls(state)); view.append(top);
    const status = node("p", state.message, state.status === "error" ? "tw-litter-error" : "muted"); status.setAttribute("role", "status"); view.append(status);
    if (state.status !== "ready") return;
    if (viewMode === "create") return renderForm(view, state, false);
    if ((viewMode === "detail" || viewMode === "edit" || viewMode === "confirm-delete") && !state.selected) viewMode = "list";
    if (viewMode === "edit") return renderForm(view, state, true);
    if (viewMode === "confirm-delete") { const card = node("div", undefined, "card"); card.append(node("h3", "Soft-delete this cloud litter?"), node("p", `${summary(state.selected)}. History will be retained.`));
      const yes = node("button", "Soft-delete litter", "danger"), no = node("button", "Cancel"); yes.type = no.type = "button"; const feedback = node("p", "", "muted");
      yes.onclick = async () => { yes.disabled = true; try { await controller.deleteCloud(state.selected); viewMode = "list"; window.render(); } catch (error) { feedback.textContent = window.twVersionedLitterClient.requestMessage?.(error) || error.message; yes.disabled = false; } };
      no.onclick = () => { viewMode = "detail"; window.render(); }; card.append(yes, no, feedback); return view.append(card); }
    if (viewMode === "detail") { const e = state.selected, r = e.record, card = node("div", undefined, "card"); card.append(node("h3", value(r, "Name")));
      for (const [label, key] of [["Birth date", "Born"], ["Breed", "Breed"], ["Total kits", "Total Kits"], ["Sold kits", "Sold Kits"], ["Died kits", "Died Kits"], ["Doe", "Dam"], ["Buck", "Sire"], ["Breeding date", "Bred"], ["Notes", "Notes"]]) card.append(node("p", `${label}: ${value(r, key)}`));
      card.append(node("p", `Revision ${e.metadata.revision} · ${e.metadata.typedId}`, "muted")); const edit = node("button", "Edit", "primary"), del = node("button", "Delete"), back = node("button", "Back");
      edit.onclick = () => { viewMode = "edit"; window.render(); }; del.onclick = () => { viewMode = "confirm-delete"; window.render(); }; back.onclick = () => { controller.clearSelection(); viewMode = "list"; window.render(); }; card.append(edit, del, back); return view.append(card); }
    const add = node("button", "+ Add from breeding", "primary");
    add.type = "button";
    add.disabled = Boolean(state.addUnavailableMessage);
    if (add.disabled) {
      add.style.opacity = "0.55";
      add.style.cursor = "not-allowed";
    }
    add.onclick = () => { viewMode = "create"; window.render(); };
    view.append(add);
    if (state.addUnavailableMessage) view.append(node("p", state.addUnavailableMessage, "muted"));
    if (!state.litters.length) return view.append(node("p", "No live development cloud litters.", "muted"));
    const list = node("div", undefined, "tw-litter-list"); for (const entry of state.litters) { const button = node("button", summary(entry), "card"); button.type = "button"; button.onclick = async () => { button.disabled = true; try { await controller.loadDetail(entry); viewMode = "detail"; window.render(); } catch (error) { status.textContent = window.twVersionedLitterClient.requestMessage?.(error) || error.message; button.disabled = false; } }; list.append(button); } view.append(list);
  }
  window.render = function (...args) {
    if (typeof page !== "undefined" && page === "Litters" && cloudFirst && !initialized) {
      initialized = true; controller.initialize(window.location.hostname); return;
    }
    const result = priorRender.apply(this, args); if (window.page !== "Litters" && typeof page !== "undefined" && page !== "Litters") return result;
    const state = controller.getState();
    if (state.source === "cloud") renderCloud(state); else { const view = document.getElementById("view"); if (view) { view.prepend(controls(state)); const old = document.getElementById("twCreateTestLitter"); old?.remove(); } }
    return result;
  };
  window.nav = function (target, ...args) {
    if (target !== "Litters") { initialized = false; viewMode = "list"; draft = null; controller.reset(); }
    return priorNav.call(this, target, ...args);
  };
  const style = node("style"); style.textContent = ".tw-litter-source-controls,.tw-litter-actions{display:flex;gap:.6rem;flex-wrap:wrap}.tw-litter-list{display:grid;gap:.75rem;margin-top:1rem}.tw-litter-list button{text-align:left;width:100%;min-height:48px}.tw-litter-form{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:1rem}.tw-litter-form h3,.tw-litter-form p,.tw-litter-form .tw-litter-actions,.tw-litter-form label:last-of-type{grid-column:1/-1}.tw-litter-form input,.tw-litter-form select,.tw-litter-form textarea{width:100%;min-height:44px}.tw-litter-error{color:#8b1e1e}@media(max-width:760px){.tw-litter-form{grid-template-columns:1fr}.tw-litter-source-controls{width:100%}.tw-litter-source-controls button{flex:1;min-height:48px}}"; document.head.append(style);
  if (typeof page !== "undefined" && page === "Litters") window.render();
})();
