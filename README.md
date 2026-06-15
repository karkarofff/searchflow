# SearchFlow

**Recherche puissante de texte à l'intérieur de vos fichiers.**

SearchFlow est une application de bureau (Windows) qui cherche du texte *dans* le contenu
des fichiers d'un dossier et de ses sous-dossiers. Contrairement à la recherche Windows qui
se limite aux noms de fichiers, SearchFlow lit l'intérieur de chaque fichier.

Son point fort : la recherche dans de **très gros fichiers** (logs, dumps, fichiers de
plusieurs Go) sans saturer la mémoire ni planter.

100 % local : aucune donnée n'est envoyée sur Internet.

---

## Fonctionnalités

- **Aucune limite de taille** sur les fichiers texte : lecture en streaming ligne par ligne,
  mémoire constante (gère le multi-Go).
- **Quatre modes de recherche** : tous les mots (ET), au moins un mot (OU), phrase exacte,
  et recherche avancée par expressions régulières (regex).
- **Options** : respecter la casse, ignorer les accents (jerome trouve Jérôme), inclure ou non
  les sous-dossiers.
- **Recherche parallèle** (multi-cœurs) avec affichage des résultats en direct.
- **Barre de progression en octets**, fluide même au sein d'un seul gros fichier.
- **Bouton Stop** qui interrompt vite tout en gardant les résultats déjà trouvés.
- **Détection d'encodage** : UTF-8, UTF-16 (LE/BE), repli Windows-1252.
- **Formats pris en charge** : .txt, .log, .csv, .md, .json, .xml, .ini, .cfg, .bat, .ps1,
  ainsi que .pdf et .docx (plafonnés à 200 Mo car non streamables).
- **Export** des résultats sélectionnés en TXT ou CSV.
- **Menu contextuel** : ouvrir le fichier, ouvrir le dossier contenant, copier le chemin.
- **Historique** des dernières recherches.
- **Interface en français**, thème violet.

---

## Captures d'écran

> A ajouter : déposez ici une ou deux captures de l'application
> (par exemple `docs/screenshot.png`) puis référencez-les ci-dessous.

```
![SearchFlow](docs/screenshot.png)
```

---

## Installation (utilisateurs)

1. Rendez-vous dans la section **Releases** du dépôt (à droite de la page GitHub).
2. Dans la dernière version, vous trouverez deux fichiers d'installation. Choisissez celui
   qui vous convient (voir juste en dessous), puis téléchargez-le.
3. Double-cliquez sur le fichier téléchargé et laissez-vous guider par l'installation.

### Quel fichier choisir : `.exe` ou `.msi` ?

Les deux installent exactement la même application. Ce sont simplement deux formats
d'installateur Windows différents.

- **`.exe` (recommandé)** : l'installateur classique, le plus simple. Il fonctionne pour
  tout le monde et ne demande en général pas de droits administrateur. Si vous ne savez pas
  lequel prendre, prenez celui-ci.
- **`.msi`** : un format d'installation plutôt destiné aux entreprises, utile surtout
  lorsqu'un service informatique doit installer le logiciel sur plusieurs ordinateurs d'un
  coup. Il demande souvent les droits administrateur. Pour un usage personnel, vous n'en avez
  pas besoin.

### Note SmartScreen

L'exécutable n'est pas signé numériquement. A la première exécution, Windows peut afficher un
avertissement bleu **"Windows a protégé votre PC"**. C'est normal pour une application
non signée.

Pour continuer : cliquez sur **Informations complémentaires**, puis sur
**Exécuter quand même**.

---

## Compilation depuis les sources (développeurs)

### Prérequis

- [Rust](https://rustup.rs/) (toolchain stable)
- [Node.js](https://nodejs.org/) (LTS recommandée) avec npm
- Sous Windows : **Microsoft C++ Build Tools** et **WebView2** (généralement déjà présent
  sur Windows 10/11). Voir les prérequis Tauri pour Windows si besoin.

### Étapes

```bash
# 1. Cloner le dépôt
git clone https://github.com/karkarofff/searchflow.git
cd searchflow

# 2. Installer les dépendances frontend
npm install

# 3. Lancer en mode développement
npm run tauri dev

# 4. Compiler une version finale (installateur dans src-tauri/target/release/bundle)
npm run tauri build
```

> Le CLI Tauri est fourni via npm (script `tauri`), il n'est pas utilisé en sous-commande
> cargo.

---

## Stack technique

- **Tauri v2** : backend Rust, frontend HTML / CSS / JavaScript classique.
- **Backend Rust** : `rayon` (parallélisme), `walkdir` (parcours de dossiers),
  `aho-corasick` (recherche multi-motifs rapide), `regex`, `unicode-normalization`
  (gestion des accents), `pdf-extract` et `docx-rs` (lecture PDF / DOCX).

---

## Licence

SearchFlow est un logiciel propriétaire. Le code est consultable publiquement,
mais **tous droits réservés** : l'application est libre d'utilisation (usage
personnel et professionnel gratuit), mais sa redistribution, sa modification
republiée et tout usage commercial sont interdits sans accord écrit de l'auteur.
Voir le fichier [LICENSE](LICENSE) pour le détail.

---

Développé par **karkarofff**.
