(function () {
  "use strict";

  const API = "/api/rabbits";

  function cloneRecords(records) {
    return records.map((record) => {
      if (!record || typeof record !== "object" || Array.isArray(record)) {
        throw new Error("Cloud rabbit data was not in the expected format.");
      }
      return typeof structuredClone === "function"
        ? structuredClone(record)
        : JSON.parse(JSON.stringify(record));
    });
  }

  function requestMessage(error) {
    if (error?.status === 401) {
      return "Cloudflare Access authentication is required. Sign in, then try again.";
    }
    if (error?.status === 403) {
      return "The Development D1 environment could not be verified.";
    }
    if (error?.offline) {
      return "Cloud rabbits could not be reached. Check the internet connection and try again.";
    }
    return "Cloud rabbits could not be loaded. Try again; local rabbits were not changed.";
  }

  function createController({ fetchImpl, render }) {
    let source = "local";
    let status = "idle";
    let records = [];
    let message = "";
    let requestVersion = 0;

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
        let response;
        try {
          response = await fetchImpl(API, {
            credentials: "same-origin",
            cache: "no-store",
            headers: { Accept: "application/json" }
          });
        } catch (cause) {
          const error = new Error("Network request failed", { cause });
          error.offline = true;
          throw error;
        }

        let body;
        try { body = await response.json(); } catch { body = null; }
        if (!response.ok) {
          const error = new Error("Cloud request failed");
          error.status = response.status;
          throw error;
        }
        if (!body || !Array.isArray(body.rabbits)) {
          throw new Error("Invalid cloud rabbit response");
        }

        const current = cloneRecords(body.rabbits);
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

    return { getState: snapshot, reset, selectLocal, selectCloud };
  }

  window.twCloudRabbitSource = { createController, requestMessage };

  if (typeof window.render !== "function" || typeof window.nav !== "function") return;

  const priorRender = window.render;
  const priorNav = window.nav;
  let search = "";
  let selectedRecord = null;

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
      "Local is the normal editable browser data. Development D1 is a temporary read-only view and never changes local records or photographs.",
      "muted"
    );
    const controls = node("div", undefined, "row");
    controls.style.justifyContent = "flex-start";
    controls.style.flexWrap = "wrap";

    const local = node("button", "Local rabbits");
    local.type = "button";
    if (state.source === "local") local.className = "primary";
    local.setAttribute("aria-pressed", String(state.source === "local"));
    local.onclick = () => { search = ""; selectedRecord = null; controller.selectLocal(); };

    const cloud = node("button", "Development D1 (read-only)");
    cloud.type = "button";
    if (state.source === "cloud") cloud.className = "primary";
    cloud.setAttribute("aria-pressed", String(state.source === "cloud"));
    cloud.disabled = state.status === "loading";
    cloud.onclick = () => { search = ""; selectedRecord = null; controller.selectCloud(); };

    controls.append(local, cloud);
    section.append(heading, help, controls);
    return section;
  }

  function rabbitLabel(rabbit) {
    return [rabbit.Prefix, rabbit.Name].filter(Boolean).join(" ") || "Unnamed rabbit";
  }

  function renderCloudDetail(view, state, rabbit) {
    const back = node("button", "← Development D1 rabbits");
    back.type = "button";
    back.onclick = () => { selectedRecord = null; window.render(); };
    const heading = node("h2", rabbitLabel(rabbit));
    const notice = node("p", "Development D1 — read-only. Editing, deletion, importing, restoring, and photograph changes are unavailable.", "tw-cloud-app-banner");
    const card = node("div", undefined, "card");
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

  function renderCloudList(view, state) {
    view.append(sourceControls(state));
    const heading = node("h2", "Rabbits — Development D1 (read-only)");
    const notice = node("p", "This temporary view cannot change cloud or local records. Cloud photographs are not available.", "tw-cloud-app-banner");
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

  function renderCloudListResults(view, state) {
    const results = view.querySelector("#twCloudRabbitResults");
    const count = view.querySelector("#twCloudRabbitCount");
    if (!results || !count) return;
    const term = search.trim().toLowerCase();
    const fields = ["Prefix", "Name", "Breed", "Tattoo", "Father", "Mother", "Status"];
    const matches = state.records.filter((rabbit) => !term || fields.some((field) => String(rabbit[field] || "").toLowerCase().includes(term)));
    count.textContent = `${matches.length} rabbit${matches.length === 1 ? "" : "s"}`;
    results.replaceChildren();
    for (const rabbit of matches) {
      const button = node("button", undefined, "listitem");
      button.type = "button";
      const title = node("strong", rabbitLabel(rabbit));
      const summary = node("span", [rabbit.Sex, rabbit.Breed, rabbit.Tattoo].filter(Boolean).join(" · "), "muted");
      button.append(title, summary);
      button.onclick = () => { selectedRecord = rabbit; window.render(); };
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
    if (selectedRecord && state.status === "ready") renderCloudDetail(view, state, selectedRecord);
    else renderCloudList(view, state);
    return result;
  };

  window.nav = function (target) {
    if (target !== "Rabbits") {
      controller.reset();
      search = "";
      selectedRecord = null;
    }
    return priorNav.apply(this, arguments);
  };

  if (page === "Rabbits") window.render();
})();
