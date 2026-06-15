#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs;
use std::io::Read;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;
use walkdir::WalkDir;
use serde::{Deserialize, Serialize};
use tauri::Emitter;
use rayon::prelude::*;
use aho_corasick::AhoCorasick;

#[derive(Serialize, Deserialize, Clone, Debug)]
struct SearchResult {
    file_path: String,
    file_name: String,
    line_number: usize,
    line_content: String,
}

#[derive(Serialize)]
struct SearchSummary {
    files_scanned: usize,
    results_found: usize,
    truncated: bool,
    cancelled: bool,
    files_skipped: usize,
}

// État partagé entre commandes : permet à `cancel_search` d'interrompre
// une recherche déjà lancée par `search_files`.
struct CancelFlag(Arc<AtomicBool>);

#[derive(Serialize, Deserialize, Clone)]
struct SearchProgress {
    files_scanned: usize,
    files_total: usize,
    results_found: usize,
    current_file: String,
    bytes_done: u64,
    bytes_total: u64,
}

// Plafond appliqué UNIQUEMENT au PDF/DOCX : ces formats sont chargés en RAM
// par leurs bibliothèques, on ne peut pas les lire en streaming.
// Les fichiers texte n'ont plus aucune limite de taille (lecture ligne par ligne).
const MAX_FILE_SIZE: u64 = 200 * 1024 * 1024;

// On émet la progression "octets" toutes les ~16 Mo pour éviter de spammer la webview.
const PROGRESS_STEP: u64 = 16 * 1024 * 1024;

// Plafond de résultats : au-delà, la recherche s'arrête (protège la RAM et l'UI).
// Une recherche qui dépasse ce seuil est de toute façon trop large pour être exploitable.
const RESULT_CAP: usize = 10_000;

// Les résultats sont envoyés au frontend par paquets de cette taille (affichage progressif).
const BATCH_SIZE: usize = 200;

#[tauri::command]
fn get_file_size(file_path: String) -> u64 {
    fs::metadata(&file_path).map(|m| m.len()).unwrap_or(0)
}

#[tauri::command]
fn save_file(path: String, content: String) -> Result<(), String> {
    fs::write(&path, content.as_bytes()).map_err(|e| e.to_string())
}

fn extract_text_from_pdf(path: &std::path::Path) -> Option<String> {
    if fs::metadata(path).map(|m| m.len()).unwrap_or(0) > MAX_FILE_SIZE {
        return None;
    }
    let bytes = fs::read(path).ok()?;
    let result = std::panic::catch_unwind(|| pdf_extract::extract_text_from_mem(&bytes));
    match result {
        Ok(Ok(text)) => Some(text),
        _ => None,
    }
}

fn extract_text_from_docx(path: &std::path::Path) -> Option<String> {
    if fs::metadata(path).map(|m| m.len()).unwrap_or(0) > MAX_FILE_SIZE {
        return None;
    }
    let mut file = fs::File::open(path).ok()?;
    let mut buf = Vec::new();
    file.read_to_end(&mut buf).ok()?;
    let docx = docx_rs::read_docx(&buf).ok()?;
    let mut text = String::new();
    for child in docx.document.children {
        if let docx_rs::DocumentChild::Paragraph(para) = child {
            for child in para.children {
                if let docx_rs::ParagraphChild::Run(run) = child {
                    for child in run.children {
                        if let docx_rs::RunChild::Text(t) = child {
                            text.push_str(&t.text);
                            text.push(' ');
                        }
                    }
                }
            }
            text.push('\n');
        }
    }
    Some(text)
}

// Décodage d'un seul octet en Windows-1252 (fallback ANSI).
fn win1252_char(b: u8) -> char {
    if b < 0x80 {
        b as char
    } else {
        match b {
            0x80 => '€', 0x82 => '‚', 0x83 => 'ƒ', 0x84 => '„',
            0x85 => '…', 0x86 => '†', 0x87 => '‡', 0x88 => 'ˆ',
            0x89 => '‰', 0x8A => 'Š', 0x8B => '‹', 0x8C => 'Œ',
            0x8E => 'Ž', 0x91 => '\u{2018}', 0x92 => '\u{2019}',
            0x93 => '\u{201C}', 0x94 => '\u{201D}', 0x95 => '•',
            0x96 => '–', 0x97 => '—', 0x98 => '˜', 0x99 => '™',
            0x9A => 'š', 0x9B => '›', 0x9C => 'œ', 0x9E => 'ž',
            0x9F => 'Ÿ',
            _ => b as char,
        }
    }
}

// Décode une ligne brute : UTF-8 si possible, sinon fallback Windows-1252.
fn decode_line_lossy(bytes: &[u8]) -> String {
    match std::str::from_utf8(bytes) {
        Ok(s) => s.to_string(),
        Err(_) => bytes.iter().map(|&b| win1252_char(b)).collect(),
    }
}

// Retire les accents/diacritiques (é→e, ç→c, ô→o…) SANS toucher à la casse.
// Utilisé uniquement quand l'option "Ignorer les accents" est activée.
fn strip_accents(s: &str) -> String {
    use unicode_normalization::UnicodeNormalization;
    s.nfd()
        .filter(|c| !('\u{0300}'..='\u{036f}').contains(c))
        .collect()
}

/// Parcourt un fichier texte ligne par ligne, en mémoire constante (aucune limite de taille).
/// `should_stop` est vérifié à chaque ligne : permet d'interrompre la lecture d'un gros fichier.
/// `on_line(index_ligne, contenu)` est appelé pour chaque ligne.
/// `on_progress(octets_lus)` est appelé régulièrement avec le nombre d'octets traités.
fn for_each_text_line<F, P>(
    path: &std::path::Path,
    should_stop: &AtomicBool,
    mut on_line: F,
    mut on_progress: P,
) where
    F: FnMut(usize, &str),
    P: FnMut(u64),
{
    use std::io::{BufRead, BufReader};

    let file = match fs::File::open(path) {
        Ok(x) => x,
        Err(_) => return,
    };
    let mut reader = BufReader::with_capacity(64 * 1024, file);

    // Détection du BOM sans consommer le contenu.
    let (bom_len, utf16_le, utf16_be) = {
        let buf = reader.fill_buf().unwrap_or(&[]);
        if buf.len() >= 3 && buf[0] == 0xEF && buf[1] == 0xBB && buf[2] == 0xBF {
            (3usize, false, false) // UTF-8 avec BOM
        } else if buf.len() >= 2 && buf[0] == 0xFF && buf[1] == 0xFE {
            (2usize, true, false) // UTF-16 LE
        } else if buf.len() >= 2 && buf[0] == 0xFE && buf[1] == 0xFF {
            (2usize, false, true) // UTF-16 BE
        } else {
            (0usize, false, false)
        }
    };
    reader.consume(bom_len);
    if bom_len > 0 {
        on_progress(bom_len as u64);
    }

    if utf16_le || utf16_be {
        // UTF-16 : cas rare (double la taille des fichiers), lu en entier.
        let mut rest = Vec::new();
        if reader.read_to_end(&mut rest).is_err() {
            return;
        }
        on_progress(rest.len() as u64);
        let units: Vec<u16> = rest
            .chunks_exact(2)
            .map(|b| {
                if utf16_le {
                    u16::from_le_bytes([b[0], b[1]])
                } else {
                    u16::from_be_bytes([b[0], b[1]])
                }
            })
            .collect();
        let text = String::from_utf16_lossy(&units);
        for (i, l) in text.lines().enumerate() {
            if should_stop.load(Ordering::Relaxed) { break; }
            on_line(i, l);
        }
        return;
    }

    // UTF-8 / ANSI / Windows-1252 : streaming ligne par ligne, mémoire constante.
    let mut line_idx = 0usize;
    let mut buf: Vec<u8> = Vec::with_capacity(256);
    loop {
        if should_stop.load(Ordering::Relaxed) { break; }
        buf.clear();
        let n = match reader.read_until(b'\n', &mut buf) {
            Ok(0) => break, // fin de fichier
            Ok(n) => n,
            Err(_) => break,
        };
        on_progress(n as u64);
        // Retire le(s) caractère(s) de fin de ligne.
        while matches!(buf.last(), Some(b'\n') | Some(b'\r')) {
            buf.pop();
        }
        let line = decode_line_lossy(&buf);
        on_line(line_idx, &line);
        line_idx += 1;
    }
}

fn run_search(
    window: tauri::Window,
    cancel: Arc<AtomicBool>,
    folder_path: String,
    query: String,
    search_mode: String,
    extensions: Vec<String>,
    case_sensitive: bool,
    ignore_accents: bool,
    search_subdirs: bool,
) -> Result<SearchSummary, String> {
    if folder_path.is_empty() || query.is_empty() || extensions.is_empty() {
        return Ok(SearchSummary {
            files_scanned: 0,
            results_found: 0,
            truncated: false,
            cancelled: false,
            files_skipped: 0,
        });
    }

    // REGEX reste géré par la crate `regex` (case-insensitive Unicode-aware).
    let regex_pattern = if search_mode == "REGEX" {
        let pattern = if case_sensitive {
            regex::Regex::new(&query).map_err(|e| format!("Regex invalide : {}", e))?
        } else {
            regex::RegexBuilder::new(&query)
                .case_insensitive(true)
                .build()
                .map_err(|e| format!("Regex invalide : {}", e))?
        };
        Some(pattern)
    } else {
        None
    };

    // ET / OU / EXACT : un seul automate Aho-Corasick pour tous les motifs.
    // Avantages : scan en un seul passage, insensible à la casse en natif
    // (donc plus aucune allocation `to_lowercase()` par ligne).
    // `nb_motifs` sert au mode ET (vérifier que TOUS les motifs sont présents).
    let matcher: Option<(AhoCorasick, usize)> = match search_mode.as_str() {
        "ET" | "OU" => {
            let pats: Vec<String> = query
                .split_whitespace()
                .map(|s| if ignore_accents { strip_accents(s) } else { s.to_string() })
                .collect();
            if pats.is_empty() {
                None
            } else {
                let ac = AhoCorasick::builder()
                    .ascii_case_insensitive(!case_sensitive)
                    .build(&pats)
                    .map_err(|e| format!("Erreur interne (recherche) : {}", e))?;
                Some((ac, pats.len()))
            }
        }
        "EXACT" => {
            let pat = if ignore_accents { strip_accents(&query) } else { query.clone() };
            let ac = AhoCorasick::builder()
                .ascii_case_insensitive(!case_sensitive)
                .build([pat.as_str()])
                .map_err(|e| format!("Erreur interne (recherche) : {}", e))?;
            Some((ac, 1))
        }
        _ => None,
    };

    let walker = WalkDir::new(&folder_path)
        .follow_links(true)
        .max_depth(if search_subdirs { usize::MAX } else { 1 });

    let all_entries: Vec<_> = walker
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| {
            if !e.path().is_file() { return false; }
            let ext = e.path().extension()
                .and_then(|x| x.to_str())
                .unwrap_or("")
                .to_lowercase();
            extensions.contains(&ext)
        })
        .collect();

    let files_total = all_entries.len();
    // Total des octets à traiter : permet une barre de progression fluide,
    // y compris à l'intérieur d'un seul gros fichier.
    let bytes_total: u64 = all_entries
        .iter()
        .map(|e| fs::metadata(e.path()).map(|m| m.len()).unwrap_or(0))
        .sum();

    let files_scanned = Arc::new(AtomicUsize::new(0));
    let results_found = Arc::new(AtomicUsize::new(0));
    let bytes_done = Arc::new(AtomicU64::new(0));
    let truncated = Arc::new(AtomicBool::new(false));
    // Compte les PDF/DOCX qui n'ont pas pu être lus (trop volumineux > MAX_FILE_SIZE,
    // ou illisibles/corrompus). Sert à informer l'utilisateur en fin de recherche.
    let files_skipped = Arc::new(AtomicUsize::new(0));
    let window_arc = Arc::new(window);

    all_entries.par_iter().for_each(|entry| {
        // Si l'utilisateur a annulé (ou si le plafond est atteint), on n'ouvre plus de fichier.
        if cancel.load(Ordering::Relaxed) { return; }

        let path = entry.path();
        let extension = path.extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_lowercase();

        let scanned = files_scanned.fetch_add(1, Ordering::Relaxed) + 1;

        // Émission "par fichier" (utile quand il y a beaucoup de petits fichiers).
        if scanned % 20 == 0 || scanned == files_total {
            let _ = window_arc.emit("search-progress", SearchProgress {
                files_scanned: scanned,
                files_total,
                results_found: results_found.load(Ordering::Relaxed),
                current_file: path.file_name().unwrap_or_default().to_string_lossy().to_string(),
                bytes_done: bytes_done.load(Ordering::Relaxed),
                bytes_total,
            });
        }

        let mut local_results: Vec<SearchResult> = Vec::new();

        // Envoie un paquet de résultats au frontend (affichage progressif),
        // en respectant le plafond global. Au-delà du plafond, on arrête tout.
        let flush = |batch: &mut Vec<SearchResult>| {
            if batch.is_empty() { return; }
            let prior = results_found.fetch_add(batch.len(), Ordering::Relaxed);
            if prior >= RESULT_CAP {
                batch.clear();
                truncated.store(true, Ordering::Relaxed);
                cancel.store(true, Ordering::Relaxed);
                return;
            }
            if prior + batch.len() > RESULT_CAP {
                batch.truncate(RESULT_CAP - prior);
                truncated.store(true, Ordering::Relaxed);
                cancel.store(true, Ordering::Relaxed);
            }
            let _ = window_arc.emit("search-results", &*batch);
            batch.clear();
        };

        // --- Logique de correspondance appliquée à une ligne ---
        // On compare directement la ligne brute : l'automate gère la casse,
        // donc plus aucune allocation `to_lowercase()` par ligne.
        let mut handle_line = |line_idx: usize, line: &str| {
            let line_trimmed = line.trim();
            if line_trimmed.is_empty() { return; }

            // Si "ignorer les accents" est actif, on compare sur une version sans accents
            // (les motifs ont déjà été repliés de la même façon plus haut).
            let folded = if ignore_accents { Some(strip_accents(line_trimmed)) } else { None };
            let hay: &str = folded.as_deref().unwrap_or(line_trimmed);

            let matched = match search_mode.as_str() {
                "OU" | "EXACT" => matcher.as_ref().map_or(false, |(ac, _)| ac.is_match(hay)),
                "ET" => {
                    if let Some((ac, n)) = matcher.as_ref() {
                        // Tous les motifs doivent apparaître (recherche avec chevauchement).
                        let mut seen = vec![false; *n];
                        for m in ac.find_overlapping_iter(hay) {
                            seen[m.pattern().as_usize()] = true;
                        }
                        seen.iter().all(|&b| b)
                    } else {
                        false
                    }
                }
                // Le mode REGEX n'est pas affecté par l'option "ignorer les accents".
                "REGEX" => regex_pattern.as_ref().map_or(false, |re| re.is_match(line_trimmed)),
                _ => false,
            };

            if matched {
                local_results.push(SearchResult {
                    file_path: path.to_string_lossy().to_string(),
                    file_name: path.file_name().unwrap_or_default()
                        .to_string_lossy().to_string(),
                    line_number: line_idx + 1,
                    line_content: line_trimmed.to_string(),
                });

                // Affichage en temps réel : on envoie dès qu'un paquet est plein.
                if local_results.len() >= BATCH_SIZE {
                    flush(&mut local_results);
                }
            }
        };

        // --- Progression "par octets" (fluide même sur un fichier de plusieurs Go) ---
        let mut on_progress = |add: u64| {
            let prev = bytes_done.fetch_add(add, Ordering::Relaxed);
            let now = prev + add;
            // On n'émet qu'au franchissement d'un palier de 16 Mo.
            if prev / PROGRESS_STEP != now / PROGRESS_STEP {
                let _ = window_arc.emit("search-progress", SearchProgress {
                    files_scanned: files_scanned.load(Ordering::Relaxed),
                    files_total,
                    results_found: results_found.load(Ordering::Relaxed),
                    current_file: path.file_name().unwrap_or_default().to_string_lossy().to_string(),
                    bytes_done: now,
                    bytes_total,
                });
            }
        };

        match extension.as_str() {
            "pdf" => {
                if let Some(t) = extract_text_from_pdf(path) {
                    for (i, l) in t.lines().enumerate() {
                        if cancel.load(Ordering::Relaxed) { break; }
                        handle_line(i, l);
                    }
                } else {
                    files_skipped.fetch_add(1, Ordering::Relaxed);
                }
                on_progress(fs::metadata(path).map(|m| m.len()).unwrap_or(0));
            }
            "docx" => {
                if let Some(t) = extract_text_from_docx(path) {
                    for (i, l) in t.lines().enumerate() {
                        if cancel.load(Ordering::Relaxed) { break; }
                        handle_line(i, l);
                    }
                } else {
                    files_skipped.fetch_add(1, Ordering::Relaxed);
                }
                on_progress(fs::metadata(path).map(|m| m.len()).unwrap_or(0));
            }
            _ => {
                for_each_text_line(path, &cancel, &mut handle_line, &mut on_progress);
            }
        }

        // Dernier paquet du fichier.
        flush(&mut local_results);
    });

    // Distingue "annulé par l'utilisateur" de "plafond atteint" (les deux posent cancel).
    let cancelled = cancel.load(Ordering::Relaxed) && !truncated.load(Ordering::Relaxed);

    // Émission finale.
    let _ = window_arc.emit("search-progress", SearchProgress {
        files_scanned: files_scanned.load(Ordering::Relaxed),
        files_total,
        results_found: results_found.load(Ordering::Relaxed),
        current_file: String::new(),
        bytes_done: if cancelled { bytes_done.load(Ordering::Relaxed) } else { bytes_total },
        bytes_total,
    });

    Ok(SearchSummary {
        files_scanned: files_scanned.load(Ordering::Relaxed),
        results_found: results_found.load(Ordering::Relaxed),
        truncated: truncated.load(Ordering::Relaxed),
        cancelled,
        files_skipped: files_skipped.load(Ordering::Relaxed),
    })
}

// Commande appelée par le bouton "Stop" du frontend : pose le drapeau d'annulation.
#[tauri::command]
fn cancel_search(state: tauri::State<CancelFlag>) {
    state.0.store(true, Ordering::Relaxed);
}

// Commande async : elle ne fait que déléguer le gros travail (bloquant, CPU)
// à un thread dédié via spawn_blocking. Le thread principal reste donc libre
// pour livrer les événements au frontend EN DIRECT (progression + résultats),
// au lieu de tout délivrer d'un coup à la fin.
#[tauri::command]
async fn search_files(
    window: tauri::Window,
    state: tauri::State<'_, CancelFlag>,
    folder_path: String,
    query: String,
    search_mode: String,
    extensions: Vec<String>,
    case_sensitive: bool,
    ignore_accents: bool,
    search_subdirs: bool,
) -> Result<SearchSummary, String> {
    // On récupère l'Arc du drapeau et on le remet à zéro avant de lancer la recherche.
    let cancel = state.0.clone();
    cancel.store(false, Ordering::Relaxed);

    tauri::async_runtime::spawn_blocking(move || {
        run_search(
            window,
            cancel,
            folder_path,
            query,
            search_mode,
            extensions,
            case_sensitive,
            ignore_accents,
            search_subdirs,
        )
    })
    .await
    .map_err(|e| format!("Erreur d'exécution : {e}"))?
}

fn main() {
    tauri::Builder::default()
        .manage(CancelFlag(Arc::new(AtomicBool::new(false))))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            search_files,
            cancel_search,
            get_file_size,
            save_file
        ])
        .run(tauri::generate_context!())
        .expect("Erreur au démarrage de l'application");
}