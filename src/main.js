let isSearching = false;
let historyEnabled = localStorage.getItem("historyEnabled") !== "false";
let searchHistory = JSON.parse(localStorage.getItem("searchHistory") || "[]");
let lastResults = [];
let lastQuery = "";
let selectedFolder = "";
let progressUnlisten = null;
let resultsUnlisten = null;
let currentKeywords = [];
let resultsRendered = 0;
let resultsHeaderReady = false;

// =====================
// DOSSIER & DRAG DROP
// =====================

function setFolder(path) {
  selectedFolder = path;
  const dropZone = document.getElementById("drop-zone");
  const dropZoneText = document.getElementById("drop-zone-text");
  const dropZonePath = document.getElementById("drop-zone-path");

  dropZone.classList.add("has-path");
  dropZoneText.style.display = "none";
  dropZonePath.style.display = "block";
  dropZonePath.textContent = "📂 " + path;
}

async function selectFolder() {
  try {
    const selected = await window.__TAURI__.dialog.open({
      directory: true,
      multiple: false,
      title: "Sélectionner un dossier"
    });
    if (selected) setFolder(selected);
  } catch (error) {
    alert("Erreur: " + error);
  }
}

function initDropZone() {
  const dropZone = document.getElementById("drop-zone");

  dropZone.addEventListener("dragover", (e) => {
    e.preventDefault();
    dropZone.classList.add("dragover");
  });

  dropZone.addEventListener("dragleave", () => {
    dropZone.classList.remove("dragover");
  });

  dropZone.addEventListener("drop", (e) => {
    e.preventDefault();
    dropZone.classList.remove("dragover");
  });

  dropZone.addEventListener("click", selectFolder);

  // Tauri v2 drag & drop
  try {
    window.__TAURI__.webview.getCurrentWebview().onDragDropEvent((event) => {
      if (event.payload.type === "drop") {
        const paths = event.payload.paths;
        if (paths && paths.length > 0) {
          setFolder(paths[0]);
        }
      } else if (event.payload.type === "over") {
        dropZone.classList.add("dragover");
      } else if (event.payload.type === "leave") {
        dropZone.classList.remove("dragover");
      }
    });
  } catch (e) {
    console.log("Drag drop Tauri non disponible:", e);
  }
}

// =====================
// HISTORIQUE
// =====================

function saveToHistory(query) {
  if (!historyEnabled) return;
  searchHistory = searchHistory.filter((h) => h !== query);
  searchHistory.unshift(query);
  if (searchHistory.length > 10) searchHistory = searchHistory.slice(0, 10);
  localStorage.setItem("searchHistory", JSON.stringify(searchHistory));
  renderHistory();
}

function deleteFromHistory(query) {
  searchHistory = searchHistory.filter((h) => h !== query);
  localStorage.setItem("searchHistory", JSON.stringify(searchHistory));
  renderHistory();
}

function renderHistory() {
  const container = document.getElementById("history-container");
  const group = document.getElementById("history-group");
  const toggle = document.getElementById("history-toggle");
  const toggleLabel = document.getElementById("history-toggle-label");

  toggle.checked = historyEnabled;
  toggleLabel.textContent = historyEnabled ? "Activé" : "Désactivé";
  group.style.display = "block";

  if (!historyEnabled || searchHistory.length === 0) {
    container.innerHTML = historyEnabled
      ? "<span style='color:var(--text-secondary);font-size:12px;'>Aucune recherche récente.</span>"
      : "<span style='color:var(--text-secondary);font-size:12px;'>L'historique est désactivé.</span>";
    return;
  }

  container.innerHTML = "";
  searchHistory.forEach((query) => {
    const tag = document.createElement("span");
    tag.className = "history-tag";

    const label = document.createElement("span");
    label.textContent = "🕐 " + query;
    label.addEventListener("click", () => {
      document.getElementById("search-query").value = query;
      startSearch();
    });

    const deleteBtn = document.createElement("button");
    deleteBtn.className = "history-delete";
    deleteBtn.textContent = "✕";
    deleteBtn.title = "Supprimer cette recherche";
    deleteBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      deleteFromHistory(query);
    });

    tag.appendChild(label);
    tag.appendChild(deleteBtn);
    container.appendChild(tag);
  });
}

function toggleHistory() {
  historyEnabled = document.getElementById("history-toggle").checked;
  localStorage.setItem("historyEnabled", historyEnabled);
  if (!historyEnabled) {
    searchHistory = [];
    localStorage.removeItem("searchHistory");
  }
  renderHistory();
}

// =====================
// EXTENSIONS
// =====================

function getSelectedExtensions() {
  const checkboxes = document.querySelectorAll(".extensions-row input[type='checkbox']:checked");
  return Array.from(checkboxes).map((cb) => cb.value);
}

function initExtToggle() {
  const toggle = document.getElementById("ext-toggle");
  const label = document.getElementById("ext-toggle-label");

  toggle.addEventListener("change", () => {
    const checked = toggle.checked;
    document.querySelectorAll(".extensions-row input[type='checkbox']")
      .forEach((cb) => cb.checked = checked);
    label.textContent = checked ? "Tout cocher" : "Tout décocher";
  });
}

// =====================
// PROGRESSION
// =====================

function showProgress() {
  document.getElementById("progress-section").style.display = "block";
  document.getElementById("progress-bar").style.width = "0%";
  document.getElementById("progress-stats").textContent = "";
  document.getElementById("progress-label").textContent = "⏳ Analyse en cours...";
}

function hideProgress() {
  document.getElementById("progress-section").style.display = "none";
}

function formatBytes(n) {
  if (n >= 1073741824) return (n / 1073741824).toFixed(2) + " Go";
  if (n >= 1048576) return (n / 1048576).toFixed(1) + " Mo";
  if (n >= 1024) return (n / 1024).toFixed(0) + " Ko";
  return n + " o";
}

function updateProgress(data) {
  const pct = data.bytes_total > 0
    ? Math.round((data.bytes_done / data.bytes_total) * 100)
    : (data.files_total > 0 ? Math.round((data.files_scanned / data.files_total) * 100) : 0);
  document.getElementById("progress-bar").style.width = pct + "%";

  let stats = `${data.files_scanned} / ${data.files_total} fichiers · ${data.results_found} résultat(s)`;
  if (data.bytes_total > 0) stats += ` · ${formatBytes(data.bytes_done)} / ${formatBytes(data.bytes_total)}`;
  document.getElementById("progress-stats").textContent = stats;

  // "Terminée" est posé par finalizeSearch (à la vraie fin de la recherche), PAS ici :
  // sinon le libellé s'affiche trop tôt alors que des résultats arrivent encore.
  document.getElementById("progress-label").textContent =
    data.current_file ? "⏳ " + data.current_file : "⏳ Analyse en cours...";
}

// =====================
// SELECTION RESULTATS
// =====================

function getSelectedResults() {
  const checkboxes = document.querySelectorAll(".result-checkbox:checked");
  if (checkboxes.length === 0) return null;
  return Array.from(checkboxes).map((cb) => parseInt(cb.dataset.index));
}

function updateSelectedCount() {
  const checked = document.querySelectorAll(".result-checkbox:checked").length;
  const total = document.querySelectorAll(".result-checkbox").length;
  const countEl = document.getElementById("selected-count");
  if (countEl) {
    countEl.textContent = checked > 0 ? `${checked} / ${total} sélectionné(s)` : "";
  }
}

function updateSelectAllState() {
  const all = document.querySelectorAll(".result-checkbox");
  const checked = document.querySelectorAll(".result-checkbox:checked");
  const selectAllBtn = document.getElementById("select-all-results-btn");
  const deselectAllBtn = document.getElementById("deselect-all-results-btn");
  if (!selectAllBtn) return;
  selectAllBtn.style.display = checked.length === all.length ? "none" : "inline-block";
  deselectAllBtn.style.display = checked.length === 0 ? "none" : "inline-block";
}

// =====================
// EXPORT
// =====================

async function exportTxt() {
  const selectedIndexes = getSelectedResults();
  if (selectedIndexes === null) {
    showError("Cochez au moins un résultat à exporter.");
    return;
  }
  const toExport = selectedIndexes.map((i) => lastResults[i]);
  try {
    const savePath = await window.__TAURI__.dialog.save({
      title: "Exporter en TXT",
      defaultPath: `searchflow_export.txt`,
      filters: [{ name: "Fichier texte", extensions: ["txt"] }],
    });
    if (!savePath) return;

    const lines = [];
    lines.push("SearchFlow — Résultats de recherche");
    lines.push(`Recherche : "${lastQuery}"`);
    lines.push(`Date : ${new Date().toLocaleString("fr-FR")}`);
    lines.push(`Nombre de résultats exportés : ${toExport.length}`);
    lines.push("=".repeat(60));
    lines.push("");

    toExport.forEach((r, i) => {
      lines.push(`[${i + 1}] ${r.file_name}`);
      lines.push(`Chemin : ${r.file_path}`);
      lines.push(`Ligne ${r.line_number} : ${r.line_content}`);
      lines.push("-".repeat(40));
    });

    await window.__TAURI__.core.invoke("save_file", {
      path: savePath,
      content: lines.join("\n"),
    });
    showToast("Fichier TXT exporté !");
  } catch (error) {
    alert("Erreur lors de l'export : " + error);
  }
}

async function exportCsv() {
  const selectedIndexes = getSelectedResults();
  if (selectedIndexes === null) {
    showError("Cochez au moins un résultat à exporter.");
    return;
  }
  const toExport = selectedIndexes.map((i) => lastResults[i]);
  try {
    const savePath = await window.__TAURI__.dialog.save({
      title: "Exporter en CSV",
      defaultPath: `searchflow_export.csv`,
      filters: [{ name: "Fichier CSV", extensions: ["csv"] }],
    });
    if (!savePath) return;

    const sanitize = (val) => {
      const str = String(val);
      const dangerous = ["=", "+", "-", "@"];
      if (dangerous.some(c => str.startsWith(c))) return "'" + str;
      return str.replace(/"/g, '""');
    };

    const lines = [];
    lines.push("Fichier;Chemin complet;Ligne;Contenu");
    toExport.forEach((r) => {
      lines.push(`"${sanitize(r.file_name)}";"${sanitize(r.file_path)}";"${r.line_number}";"${sanitize(r.line_content)}"`);
    });

    await window.__TAURI__.core.invoke("save_file", {
      path: savePath,
      content: lines.join("\n"),
    });
    showToast("Fichier CSV exporté !");
  } catch (error) {
    alert("Erreur lors de l'export : " + error);
  }
}

// =====================
// MENU CONTEXTUEL
// =====================

let contextMenu = null;
let currentResultPath = null;

function createContextMenu() {
  const menu = document.createElement("div");
  menu.id = "context-menu";
  menu.innerHTML = `
    <div class="ctx-item" id="ctx-open-file">📄 Ouvrir le fichier</div>
    <div class="ctx-item" id="ctx-open-folder">📁 Ouvrir le dossier contenant</div>
    <div class="ctx-divider"></div>
    <div class="ctx-item" id="ctx-copy-path">📋 Copier le chemin</div>
  `;
  document.body.appendChild(menu);

  document.getElementById("ctx-open-file").addEventListener("click", async () => {
    const pathToOpen = currentResultPath;
    hideContextMenu();
    if (!pathToOpen) return;
    try {
      const fileSize = await window.__TAURI__.core.invoke("get_file_size", { filePath: pathToOpen });
      const fileSizeMb = fileSize / (1024 * 1024);
      if (fileSizeMb > 50) {
        const confirmed = await window.__TAURI__.dialog.confirm(
          `Ce fichier fait ${fileSizeMb.toFixed(1)} Mo. L'ouvrir pourrait ralentir votre PC. Continuer ?`,
          { title: "Fichier volumineux", kind: "warning" }
        );
        if (!confirmed) return;
      }
      await window.__TAURI__.opener.openPath(pathToOpen);
    } catch (error) {
      alert("Impossible d'ouvrir le fichier : " + error);
    }
  });

  document.getElementById("ctx-open-folder").addEventListener("click", async () => {
    const pathToOpen = currentResultPath;
    hideContextMenu();
    if (!pathToOpen) return;
    try {
      await window.__TAURI__.opener.revealItemInDir(pathToOpen);
    } catch (error) {
      alert("Impossible d'ouvrir le dossier : " + error);
    }
  });

  document.getElementById("ctx-copy-path").addEventListener("click", () => {
    const pathToOpen = currentResultPath;
    hideContextMenu();
    if (!pathToOpen) return;
    navigator.clipboard.writeText(pathToOpen);
    showToast("Chemin copié !");
  });

  document.addEventListener("click", (e) => {
    if (contextMenu && !contextMenu.contains(e.target)) {
      hideContextMenu();
      currentResultPath = null;
    }
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      hideContextMenu();
      currentResultPath = null;
    }
  });

  return menu;
}

function showContextMenu(x, y, filePath) {
  currentResultPath = filePath;
  if (!contextMenu) contextMenu = createContextMenu();
  contextMenu.style.display = "block";

  const menuWidth = 220;
  const menuHeight = 120;
  let finalX = x;
  let finalY = y;
  if (x + menuWidth > window.innerWidth) finalX = window.innerWidth - menuWidth - 10;
  if (y + menuHeight > window.innerHeight) finalY = window.innerHeight - menuHeight - 10;
  contextMenu.style.left = finalX + "px";
  contextMenu.style.top = finalY + "px";
}

function hideContextMenu() {
  if (contextMenu) contextMenu.style.display = "none";
}

// =====================
// RECHERCHE
// =====================

function setSearchingUI(searching) {
  const searchBtn = document.getElementById("search-btn");
  const stopBtn = document.getElementById("stop-btn");
  if (searchBtn) searchBtn.style.display = searching ? "none" : "flex";
  if (stopBtn) stopBtn.style.display = searching ? "flex" : "none";
}

async function cancelSearch() {
  try {
    await window.__TAURI__.core.invoke("cancel_search");
  } catch (e) {
    console.log("cancel_search:", e);
  }
}

async function startSearch() {
  if (isSearching) return;

  const query = document.getElementById("search-query").value.trim();
  const searchMode = document.getElementById("search-mode").value;
  const extensions = getSelectedExtensions();
  const caseSensitive = document.getElementById("case-sensitive").checked;
  const ignoreAccents = document.getElementById("ignore-accents").checked;
  const searchSubdirs = document.getElementById("search-subdirs").checked;

  if (!selectedFolder) {
    showError("Veuillez sélectionner un dossier.");
    return;
  }
  if (!query) {
    showError("Veuillez entrer un terme de recherche.");
    return;
  }
  if (extensions.length === 0) {
    showError("Veuillez sélectionner au moins un type de fichier.");
    return;
  }

  isSearching = true;
  lastQuery = query;
  currentKeywords = query.toLowerCase().split(/\s+/).filter(Boolean);
  showLoading(true);
  showProgress();
  clearResults();
  setSearchingUI(true);

  if (progressUnlisten) { progressUnlisten(); progressUnlisten = null; }
  if (resultsUnlisten) { resultsUnlisten(); resultsUnlisten = null; }

  // Progression + résultats arrivent en direct via événements.
  progressUnlisten = await window.__TAURI__.event.listen("search-progress", (event) => {
    updateProgress(event.payload);
  });
  resultsUnlisten = await window.__TAURI__.event.listen("search-results", (event) => {
    onResultsBatch(event.payload);
  });

  const startTime = Date.now();

  try {
    const summary = await window.__TAURI__.core.invoke("search_files", {
      folderPath: selectedFolder,
      query,
      searchMode,
      extensions,
      caseSensitive,
      ignoreAccents,
      searchSubdirs,
    });

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
    saveToHistory(query);
    finalizeSearch(summary, elapsed);
  } catch (error) {
    showError("Erreur : " + error);
    hideProgress();
  } finally {
    isSearching = false;
    showLoading(false);
    setSearchingUI(false);
    if (progressUnlisten) { progressUnlisten(); progressUnlisten = null; }
    if (resultsUnlisten) { resultsUnlisten(); resultsUnlisten = null; }
  }
}

// =====================
// AFFICHAGE RESULTATS
// =====================

// Crée la barre de sélection/export une seule fois, au premier résultat reçu.
function ensureResultsHeader() {
  if (resultsHeaderReady) return;
  resultsHeaderReady = true;

  const container = document.getElementById("results-container");
  document.getElementById("export-btns").style.display = "flex";

  const selectionBar = document.createElement("div");
  selectionBar.className = "selection-bar";
  selectionBar.innerHTML = `
    <span class="selection-label">Sélection pour export :</span>
    <button id="select-all-results-btn" class="btn-tiny">✅ Tout cocher</button>
    <button id="deselect-all-results-btn" class="btn-tiny" style="display:none;">☐ Tout décocher</button>
    <span id="selected-count" style="color:var(--text-secondary);font-size:12px;"></span>
  `;
  container.appendChild(selectionBar);

  document.getElementById("select-all-results-btn").addEventListener("click", () => {
    document.querySelectorAll(".result-checkbox").forEach((cb) => cb.checked = true);
    updateSelectedCount();
    updateSelectAllState();
  });
  document.getElementById("deselect-all-results-btn").addEventListener("click", () => {
    document.querySelectorAll(".result-checkbox").forEach((cb) => cb.checked = false);
    updateSelectedCount();
    updateSelectAllState();
  });
}

// Reçoit un paquet de résultats (envoyé en direct par le backend) et l'affiche.
function onResultsBatch(batch) {
  if (!batch || batch.length === 0) return;
  ensureResultsHeader();

  const container = document.getElementById("results-container");
  const countEl = document.getElementById("result-count");
  const frag = document.createDocumentFragment();

  batch.forEach((result) => {
    const index = lastResults.length;
    lastResults.push(result);
    frag.appendChild(renderResultCard(result, index));
    resultsRendered++;
  });
  container.appendChild(frag);

  countEl.textContent = `${lastResults.length} résultat(s) trouvé(s)…`;
  countEl.style.color = "var(--success)";
  updateSelectAllState();
}

// Construit la carte DOM d'un résultat.
function renderResultCard(result, index) {
  const card = document.createElement("div");
  card.className = "result-card";

  const safeFileName = escapeHtml(result.file_name);
  const safeFilePath = escapeHtml(result.file_path);
  const highlightedLine = highlightKeywords(result.line_content, currentKeywords, lastQuery);

  card.innerHTML = `
    <div class="result-header">
      <div class="result-header-left">
        <input type="checkbox" class="result-checkbox" data-index="${index}" title="Sélectionner pour export">
        <span class="file-name">📄 ${safeFileName}</span>
      </div>
      <span class="line-badge">Ligne ${result.line_number}</span>
    </div>
    <div class="result-path">${safeFilePath}</div>
    <div class="result-line">${highlightedLine}</div>
  `;

  card.querySelector(".result-checkbox").addEventListener("change", () => {
    updateSelectedCount();
    updateSelectAllState();
  });

  card.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    e.stopPropagation();
    showContextMenu(e.clientX, e.clientY, result.file_path);
  });

  card.addEventListener("click", (e) => {
    if (e.target.type === "checkbox") return;
    navigator.clipboard.writeText(result.file_path);
    showToast("Chemin copié !");
  });

  return card;
}

// Appelée quand la recherche se termine : stats finales + état (annulée/plafond).
function finalizeSearch(summary, elapsed) {
  const countEl = document.getElementById("result-count");
  const statsEl = document.getElementById("search-stats");
  const exportBtns = document.getElementById("export-btns");
  const progressLabel = document.getElementById("progress-label");

  let statsText = `${summary.files_scanned} fichier(s) analysé(s) en ${elapsed}s`;
  if (summary.files_skipped > 0) {
    statsText += ` · ⚠️ ${summary.files_skipped} fichier(s) ignoré(s) (PDF/DOCX trop volumineux ou illisibles)`;
  }
  statsEl.textContent = statsText;
  if (progressLabel) {
    progressLabel.textContent = summary.cancelled ? "⏹️ Recherche annulée" : "✅ Analyse terminée";
  }

  if (lastResults.length === 0) {
    countEl.textContent = summary.cancelled ? "Recherche annulée — aucun résultat." : "Aucun résultat trouvé.";
    countEl.style.color = "var(--danger)";
    exportBtns.style.display = "none";
    return;
  }

  let msg = `${lastResults.length} résultat(s) trouvé(s)`;
  if (summary.truncated) {
    msg += ` — plafond de ${lastResults.length} atteint, affinez votre recherche pour des résultats plus précis`;
    countEl.style.color = "var(--highlight-text)";
  } else if (summary.cancelled) {
    msg += " (recherche annulée)";
    countEl.style.color = "var(--success)";
  } else {
    countEl.style.color = "var(--success)";
  }
  countEl.textContent = msg;

  updateSelectedCount();
  updateSelectAllState();
}

function highlightKeywords(text, keywords, query) {
  let result = escapeHtml(text);
  keywords.forEach((keyword) => {
    if (!keyword) return;
    const regex = new RegExp(`(${escapeRegex(keyword)})`, "gi");
    result = result.replace(regex, '<mark class="highlight">$1</mark>');
  });
  return result;
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function clearResults() {
  document.getElementById("results-container").innerHTML = "";
  document.getElementById("result-count").textContent = "";
  document.getElementById("search-stats").textContent = "";
  document.getElementById("export-btns").style.display = "none";
  lastResults = [];
  resultsRendered = 0;
  resultsHeaderReady = false;
}

function showLoading(show) {
  document.getElementById("loading").style.display = show ? "flex" : "none";
  document.getElementById("search-btn").disabled = show;
}

function showError(msg) {
  const countEl = document.getElementById("result-count");
  countEl.textContent = msg;
  countEl.style.color = "#e74c3c";
}

function showToast(msg) {
  const toast = document.getElementById("toast");
  toast.textContent = msg;
  toast.classList.add("show");
  setTimeout(() => toast.classList.remove("show"), 2000);
}

// =====================
// AIDE
// =====================

function showHelp() {
  document.getElementById("help-overlay").style.display = "flex";
}

function hideHelp() {
  document.getElementById("help-overlay").style.display = "none";
}

function showAbout() {
  document.getElementById("about-overlay").style.display = "flex";
}

function hideAbout() {
  document.getElementById("about-overlay").style.display = "none";
}

async function openGithub() {
  const url = "https://github.com/karkarofff/searchflow";
  try {
    await window.__TAURI__.opener.openUrl(url);
  } catch (e) {
    // Repli : si l'ouverture externe échoue, on copie le lien.
    try {
      await navigator.clipboard.writeText(url);
      showToast("Lien GitHub copié !");
    } catch (_) {
      console.log("openGithub:", e);
    }
  }
}

// =====================
// INIT
// =====================

document.addEventListener("DOMContentLoaded", () => {
  initDropZone();
  initExtToggle();
  renderHistory();

  document.getElementById("folder-btn").addEventListener("click", selectFolder);
  document.getElementById("search-btn").addEventListener("click", startSearch);
  document.getElementById("help-btn").addEventListener("click", showHelp);
  document.getElementById("help-close").addEventListener("click", hideHelp);
  document.getElementById("about-btn").addEventListener("click", showAbout);
  document.getElementById("about-close").addEventListener("click", hideAbout);
  document.getElementById("about-github").addEventListener("click", openGithub);
  document.getElementById("export-txt-btn").addEventListener("click", exportTxt);
  document.getElementById("export-csv-btn").addEventListener("click", exportCsv);
  const stopBtn = document.getElementById("stop-btn");
  if (stopBtn) stopBtn.addEventListener("click", cancelSearch);

  document.getElementById("help-overlay").addEventListener("click", (e) => {
    if (e.target === document.getElementById("help-overlay")) hideHelp();
  });

  document.getElementById("about-overlay").addEventListener("click", (e) => {
    if (e.target === document.getElementById("about-overlay")) hideAbout();
  });

  document.getElementById("history-toggle").addEventListener("change", toggleHistory);

  document.getElementById("search-query").addEventListener("keydown", (e) => {
    if (e.key === "Enter") startSearch();
  });
});