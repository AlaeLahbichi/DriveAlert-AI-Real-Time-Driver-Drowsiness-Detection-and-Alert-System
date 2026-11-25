# DriveAlert AI · Détection de la somnolence du conducteur en temps réel

> Projet de Fin d'Année (PFA) · EMSI
> Détection de la somnolence du conducteur en temps réel avec système d'alerte.

DriveAlert AI filme le conducteur avec une webcam et détecte :

- les **yeux fermés** trop longtemps ;
- les **bâillements** ;
- la **tête qui tombe** ;
- le **regard détourné** de la route.

Il déclenche des **alertes à 4 niveaux** : visuelles, sonores et vocales.
Tout tourne **dans le navigateur**, et aucune image n'est envoyée sur Internet.

Le projet compare **deux versions** de la détection :

| Version | Visage, points du visage, pose de la tête | Yeux ouverts / fermés et bâillement |
|---|---|---|
| **V1** | Google MediaPipe Face Landmarker | Mesures géométriques : EAR, MAR (ou scores de Google) |
| **V2** | Google MediaPipe Face Landmarker | **Notre modèle** : MobileNetV2 fine-tuné sur nos propres images |

---

## Sommaire

1. [Fonctionnalités](#fonctionnalités)
2. [Architecture](#architecture)
3. [Installation et lancement](#installation-et-lancement)
4. [Utilisation : les 4 onglets](#utilisation--les-4-onglets)
5. [Règles d'alerte](#règles-dalerte)
6. [Base de données d'images](#base-de-données-dimages)
7. [Entraînement du modèle V2](#entraînement-du-modèle-v2)
8. [Résultats](#résultats)
9. [Boîtier IoT (ESP32 · MQTT)](#boîtier-iot-esp32--mqtt)
10. [Structure du projet](#structure-du-projet)
11. [Technologies](#technologies)
12. [Limites et suite du projet](#limites-et-suite-du-projet)

---

## Fonctionnalités

- **Détection en temps réel** depuis la webcam, à environ 30 images par seconde, avec accélération GPU si possible.
- **Calibration automatique** pendant 5 s au démarrage : les seuils s'adaptent au visage de chaque conducteur.
- **4 niveaux d'alerte** : Normal, Vigilance, Alerte, Danger.
  - Niveaux 2 et 3 : cadre clignotant plein écran et bips.
  - Niveau 3 : bandeau « RÉVEILLEZ-VOUS ! » et message vocal.
- **Indicateurs affichés** :
  - EAR, MAR et PERCLOS (part du temps passé les yeux fermés sur 60 s) ;
  - clignements, bâillements, hochements de tête ;
  - angles de la tête ;
  - courbes en direct et historique des événements.
- **Tous les seuils sont réglables** dans l'interface.
- **Outil de collecte et d'étiquetage** des images pour l'entraînement : capture manuelle ou automatique, galerie de vérification, découpage entraînement / validation / test.
- **Modèle V2 fine-tuné**, qui tourne dans le navigateur avec TensorFlow.js, pour comparer directement avec la V1.
- **Boîtier IoT ESP32** (simulé dans Wokwi), relié à la plateforme par **MQTT** : LED, buzzer, écran, vibration, feux de détresse, bouton « J'ai vu », rappel de pause, journal sur carte SD et **SOS WhatsApp** si le conducteur ne répond pas.

## Architecture

```mermaid
flowchart LR
    CAM[Webcam] --> MP[Google MediaPipe<br/>Face Landmarker<br/>478 points + pose]
    MP --> V1[V1 · mesures<br/>EAR / MAR]
    MP --> CROP[Découpe 96×96<br/>yeux + bouche]
    CROP --> V2[V2 · MobileNetV2<br/>fine-tuné · TF.js]
    MP --> POSE[Pose de la tête<br/>pitch / yaw / roll]
    V1 --> ENG[Moteur de décision<br/>niveaux 0 à 3]
    V2 --> ENG
    POSE --> ENG
    ENG --> UI[Interface :<br/>visuel + son + voix]
    ENG <-->|MQTT · HiveMQ| ESP[Boîtier ESP32<br/>Wokwi]
    ESP --> ACT[LED, buzzer, LCD,<br/>vibration, relais]
    ESP -->|SOS| WA[WhatsApp<br/>Green-API]
```

Le **moteur de décision** est le même pour les deux versions. Seule change la façon de décider « yeux fermés » et « bâillement ». La comparaison V1 / V2 est donc équitable.

## Installation et lancement

**Prérequis :**

- Node.js 20 ou plus (testé avec 22) ;
- un navigateur récent (Chrome, Edge ou Safari) avec une webcam.

```bash
git clone https://github.com/AlaeLahbichi/DriveAlert-AI-Real-Time-Driver-Drowsiness-Detection-and-Alert-System.git
cd DriveAlert-AI-Real-Time-Driver-Drowsiness-Detection-and-Alert-System
npm install
npm run dev
```

Ouvrez ensuite **http://localhost:3000** et autorisez l'accès à la caméra.

Pour une version optimisée :

```bash
npm run build
npm start
```

Le modèle de Google (`public/models/face_landmarker.task`), le moteur MediaPipe (`public/mediapipe/wasm/`) et les modèles V2 (`public/models/v2/`) sont fournis dans le dépôt. Aucun téléchargement supplémentaire n'est nécessaire.

## Utilisation : les 4 onglets

Les onglets sont regroupés en haut de page : **Détection** (V1, V2), **Analyse** (Tableau de bord) et **Données** (Collecte).

Chaque page de détection suit la même disposition :

- **à gauche** : la caméra, puis les **courbes des yeux et de la bouche** (15 dernières secondes). Chaque courbe affiche sa valeur actuelle, son état (« Ouverts / Fermés », « Fermée / Bâillement »), le seuil en pointillés, les périodes anormales en rouge et la valeur au survol ;
- **à droite** : le niveau d'alerte, les indicateurs clés, puis un panneau à onglets : **Mesures**, **Boîtier IoT**, **Événements** et **Réglages**.

### 1. V1 · Modèle de Google (`/`)

1. Cliquez sur **« Démarrer la caméra »**.
2. Pendant **5 s**, regardez l'écran, yeux ouverts, bouche fermée : c'est la **calibration**.
3. Testez :
   - clignez des yeux : rien ne se passe ;
   - fermez les yeux 1 s, puis 2 s ;
   - bâillez ;
   - baissez la tête ;
   - tournez la tête.

Utilisez « Calibrer » pour recommencer la calibration et l'onglet « Réglages » pour ajuster les règles.

### 2. V2 · Mon modèle (fine-tuning) (`/mon-modele`)

Même interface que la V1, mais l'état des yeux et de la bouche est décidé par **notre modèle MobileNetV2**.

L'onglet affiche aussi :

- les **découpes 96×96** que le modèle analyse en direct (œil droit, œil gauche, bouche) ;
- les **probabilités** données par le modèle : yeux fermés et bâillement ;
- ses **scores sur les images de test**.

Le bouton **« Mon modèle / Géométrie (EAR / MAR) »** au-dessus des courbes permet de comparer les deux approches en direct.

### 3. Tableau de bord (`/tableau-de-bord`)

Les logs sont présentés sous forme de **KPI** et de **graphes**, filtrables par période (aujourd'hui, 7 jours, 30 jours, tout) et par version (V1, V2) :

- **KPI** : sessions, temps surveillé, % du temps en état normal, alertes, SOS envoyés, temps de réaction du conducteur, pauses acceptées, latence MQTT ;
- **graphes** : répartition du temps par niveau, signes de fatigue par type, chronologie d'une session, alertes par session, fatigue par heure de la journée, journal du boîtier et latence plateforme ↔ boîtier ;
- **comparaison V1 / V2** et **tableau des derniers logs** (plateforme, boîtier, conducteur), avec **export CSV**.

Les logs sont enregistrés dans le navigateur (localStorage) : aucune donnée n'est envoyée sur un serveur. Le tableau se met à jour en direct pendant une détection, même ouvert dans un autre onglet.

### 4. Collecte de données (`/collecte`)

Cet onglet construit la base d'images qui sert à entraîner la V2.

1. Renseignez :
   - le **nom de la personne** ;
   - la **lumière** : jour, faible ou nuit ;
   - les **lunettes**.
2. Démarrez la caméra. Google repère l'œil droit, l'œil gauche et la bouche, puis les découpe en carrés redressés de 96×96 pixels.
3. Étiquetez les images :
   - **Mode manuel** : maintenez une touche enfoncée pour capturer une rafale :

     | Touche | Étiquette |
     |---|---|
     | `O` | yeux ouverts |
     | `F` | yeux fermés |
     | `N` | bouche normale |
     | `B` | bâillement |

   - **Mode automatique** : les scores de Google choisissent l'étiquette, et les images douteuses sont ignorées.
4. Vérifiez les images dans la **galerie** et supprimez celles qui sont mal étiquetées.
5. Cliquez sur **« Créer le découpage »** pour séparer les images en entraînement, validation et test.

## Règles d'alerte

| Niveau | Nom | Déclencheurs (valeurs par défaut, réglables) |
|---|---|---|
| 0 | Normal | aucun signe de fatigue |
| 1 | Vigilance | bâillement d'au moins 1,5 s · PERCLOS ≥ 15 % · 1 hochement de tête récent |
| 2 | Alerte | yeux fermés ≥ 1 s · tête qui tombe · 2 hochements en 1 min · PERCLOS ≥ 30 % · regard détourné ≥ 2 s · visage perdu ≥ 2 s |
| 3 | Danger | yeux fermés ≥ 2 s · tête tombée ≥ 2 s · 3 hochements en 1 min |

Quand la cause disparaît, chaque niveau est **maintenu 1,5 s** pour éviter que l'alerte clignote.

| Mesure | Définition |
|---|---|
| **EAR** (*Eye Aspect Ratio*) | Hauteur de l'œil divisée par sa largeur, calculée sur 6 points. Seuil = 75 % de la valeur mesurée à la calibration. |
| **MAR** (*Mouth Aspect Ratio*) | Ouverture de la bouche divisée par sa largeur. |
| **PERCLOS** | Pourcentage du temps passé les yeux fermés sur les 60 dernières secondes. |
| **Pose de la tête** | Pitch (haut / bas), yaw (gauche / droite) et roll (inclinaison), tirés de la matrice de transformation de Google. |

## Base de données d'images

Le dossier `data/` est créé par l'onglet Collecte. Il **n'est pas publié** sur GitHub, car il contient des photos de visages, donc des données personnelles.

```
data/
├── yeux/ouverts/        yeux/fermes/          # découpes 96×96 des yeux
├── bouche/fermee/       bouche/baillement/    # découpes 96×96 de la bouche
├── labels.csv           # une ligne par image (voir ci-dessous)
├── split.csv            # répartition train / val / test
└── split.json           # résumé de la répartition
```

- **Nom d'un fichier :** `<personne>__<session>__<horodatage>_<partie>.png`, où la partie est `oeil_d`, `oeil_g` ou `bouche`.
- **Colonnes de `labels.csv` :**
  - fichier, classe, tâche, partie ;
  - personne, session ;
  - mode de capture, rafale ;
  - lunettes, lumière ;
  - EAR, score eyeBlink, MAR, score jawOpen (mesures de Google) ;
  - pitch, yaw, roll (angles de la tête) ;
  - date de capture.

Base utilisée pour le modèle actuel :

| Classe | Nombre d'images |
|---|---|
| Yeux ouverts | 650 |
| Yeux fermés | 574 |
| Bouche normale | 667 |
| Bâillement | 558 |
| **Total** | **2 449** |

## Entraînement du modèle V2

Le script [`training/train.py`](training/train.py) entraîne **deux classifieurs** :

| Modèle | Ce qu'il décide | Images utilisées |
|---|---|---|
| Yeux | ouvert ou fermé | œil droit et œil gauche |
| Bouche | normale ou bâillement | bouche |

**La méthode (fine-tuning) :**

1. **Modèle de base** : MobileNetV2 **pré-entraîné sur ImageNet**. Il est léger et rapide, donc adapté au temps réel dans un navigateur.
2. **Nouvelle tête** : une couche de moyenne (Global Average Pooling), un Dropout de 0,3, puis une sortie qui donne une probabilité entre 0 et 1.
3. **Étape 1** : la base MobileNetV2 est **gelée** et seule la tête apprend (Adam, taux d'apprentissage 1e-3, 12 époques maximum).
4. **Étape 2** : on **dégèle les 30 dernières couches** et on réentraîne avec un taux très faible (1e-5, 15 époques maximum).
5. **Augmentation de données** : retournement horizontal, luminosité, contraste et léger recadrage aléatoire.
6. **Arrêt anticipé** : l'entraînement s'arrête quand la perte de validation ne baisse plus, et on garde le meilleur modèle.
7. **Export vers TensorFlow.js** dans `public/models/v2/<tache>/`, pour l'utiliser directement dans le navigateur.

**Le découpage des données :** toutes les images viennent de la même personne. Pour chaque session et chaque classe, on trie donc les images **dans l'ordre du temps** :

- les 70 % premières vont à l'entraînement ;
- les 15 % suivantes à la validation ;
- les 15 % dernières au test.

Les images voisines, presque identiques, restent ainsi dans le même ensemble.

**Lancer l'entraînement :**

```bash
cd training
uv venv --python 3.11 .venv                                   # une seule fois
uv pip install --python .venv/bin/python -r requirements.txt  # une seule fois
.venv/bin/python train.py            # entraîne les deux modèles
.venv/bin/python train.py yeux       # ou un seul
```

Le script produit :

- `training/runs/<tache>/` : le rapport (`report.json`), la répartition des images, le modèle Keras ;
- `public/models/v2/` : le modèle TensorFlow.js et `metrics.json`, affiché dans l'onglet V2.

L'entraînement prend environ 2 minutes sur un Mac Apple Silicon, sans GPU dédié.

## Résultats

Scores du modèle V2 sur les images de **test**, que le modèle n'a jamais vues pendant l'entraînement :

| Modèle | Images de test | Exactitude | Précision | Rappel | F1 |
|---|---|---|---|---|---|
| Yeux (ouvert / fermé) | 185 | **96,8 %** | 95,5 % | 97,7 % | 96,6 % |
| Bouche (normale / bâillement) | 186 | **99,5 %** | 100 % | 98,8 % | 99,4 % |

Matrices de confusion (« positif » = yeux fermés ou bâillement) :

| Modèle | Vrais négatifs | Faux positifs | Faux négatifs | Vrais positifs |
|---|---|---|---|---|
| Yeux | 94 | 4 | 2 | 85 |
| Bouche | 101 | 0 | 1 | 84 |

Le modèle converti en TensorFlow.js donne **exactement les mêmes scores** que le modèle Python sur ces images.

> ⚠️ Ces scores sont optimistes : une seule personne, 3 sessions, et surtout des cas faciles. La vraie comparaison V1 / V2 doit se faire sur de **nouvelles sessions** : autre jour, autre lumière, lunettes.

## Boîtier IoT (ESP32 · MQTT)

La plateforme envoie le niveau d'alerte à un **ESP32** simulé dans **Wokwi** (extension VS Code), via le broker MQTT public `broker.hivemq.com`. Le boîtier réagit et renvoie la réponse du conducteur, son journal et son état.

### Topics MQTT

| Topic (`drivealert/pfa-alae-01/…`) | Sens | Contenu |
|---|---|---|
| `alerte` | plateforme → ESP32 | `{"niveau":3,"cause":"Yeux fermés 2.1 s","version":"v2","lat":…,"lon":…}` à chaque changement |
| `heartbeat` | plateforme → ESP32 | même format, toutes les secondes |
| `ack` | ESP32 → plateforme | le conducteur a appuyé sur le bouton (alerte ou pause) |
| `journal` | ESP32 → plateforme | chaque événement du boîtier |
| `etat` | ESP32 → plateforme | `{"enLigne":true}` (retenu) ; `false` publié par le broker si l'ESP32 disparaît (LWT) |

### Réactions du boîtier

| Niveau | LED | Buzzer | Écran | Autres |
|---|---|---|---|---|
| 0 | verte | – | « Conduite normale » | – |
| 1 | orange | 1 bip | « VIGILANCE » | – |
| 2 | rouge clignotante | 1 bip / s | « !! ALERTE !! » | vibration |
| 3 | rouge rapide | bips continus | « DANGER-ARRETEZ! » + décompte SOS | vibration, relais (feux de détresse) |

- **Niveau 3 maintenu** : le danger reste actif (boîtier et plateforme) jusqu'à l'appui sur le bouton.
- **Bouton « J'ai vu »** : au niveau 3, arrête l'alerte sur le boîtier **et** sur la plateforme (la plateforme a aussi son bouton « arrêter l'alerte ») ; aux niveaux 1-2, coupe le son et la vibration.
- **Faible latence** : accusés de réception envoyés avant tout le reste, sans délai TCP (Nagle désactivé), heartbeat chaque seconde pour resynchroniser vite.
- **SOS** : niveau 3 sans réponse pendant 5 s → message WhatsApp (Green-API) avec la cause, l'heure et la position (celle du navigateur si elle est partagée), puis rappel toutes les 2 min et message de fin.
- **Rappel de pause** : après un temps de conduite (20 s en test, 2 h en réel), alerte orange de 10 s : bouton = pause acceptée, sinon annulée.
- **Sécurité** : auto-test au démarrage, LED « Connexion », « Plateforme déconnectée » sans heartbeat depuis 5 s, reconnexion automatique.
- **Journal** : chaque événement est écrit sur la carte microSD (`/journal.csv`) avec la date et l'heure réelles (NTP).

### Lancer la simulation

```bash
uv tool install platformio                       # une seule fois
cp iot/include/secrets.example.h iot/include/secrets.h   # puis le remplir (Green-API)
cd iot && pio run                                 # compile le firmware
```

Dans VS Code : ouvrir `iot/diagram.json`, puis **« Wokwi: Start Simulator »**. Ouvrir ensuite la plateforme (onglet V1 ou V2) : l'onglet **« Boîtier IoT »** affiche l'état de l'ESP32, la réponse du conducteur et le journal.

> `iot/include/secrets.h` (identifiants Green-API, numéro) est ignoré par git. Sans identifiants, le SOS est simulé (affiché dans le moniteur série).

## Structure du projet

```
├── public/
│   ├── mediapipe/wasm/            # moteur MediaPipe (WebAssembly)
│   └── models/
│       ├── face_landmarker.task   # modèle de Google
│       └── v2/                    # nos modèles fine-tunés (TensorFlow.js) + metrics.json
├── src/
│   ├── app/
│   │   ├── page.tsx               # onglet V1
│   │   ├── mon-modele/page.tsx    # onglet V2
│   │   ├── tableau-de-bord/page.tsx # onglet Tableau de bord
│   │   ├── collecte/page.tsx      # onglet Collecte
│   │   └── api/dataset/           # API : enregistrer, lister, supprimer, découper les images
│   ├── components/
│   │   ├── DrowsinessApp.tsx      # interface de détection (V1 et V2)
│   │   ├── DataCollector.tsx      # interface de collecte et d'étiquetage
│   │   ├── LiveChart.tsx          # courbes en temps réel (yeux, bouche)
│   │   ├── Dashboard.tsx          # tableau de bord : KPI et graphes des logs
│   │   ├── charts.tsx             # graphiques du tableau de bord (SVG, sans librairie)
│   │   ├── SettingsPanel.tsx      # réglage des seuils
│   │   ├── IotPanel.tsx           # onglet « Boîtier IoT » (état, réponse, journal)
│   │   └── NavTabs.tsx            # navigation (Détection, Analyse, Données)
│   └── lib/
│       ├── metrics.ts             # EAR, MAR, angles de la tête
│       ├── engine.ts              # moteur de décision : niveaux 0 à 3, calibration, PERCLOS
│       ├── alarm.ts               # son, voix, vibration
│       ├── iot.ts                 # liaison MQTT avec le boîtier ESP32
│       ├── logStore.ts            # logs persistants (sessions, boîtier, réponses, latence)
│       ├── theme.ts               # code couleur (identique à globals.css)
│       ├── useFaceLandmarker.ts   # chargement du modèle de Google
│       ├── v2Model.ts             # chargement et exécution de notre modèle (TF.js)
│       ├── crop.ts                # découpe des yeux et de la bouche
│       ├── datasetClasses.ts      # classes de la base
│       └── datasetStore.ts        # écriture des images et du CSV (serveur)
├── training/
│   ├── train.py                   # fine-tuning MobileNetV2 + export TF.js
│   └── requirements.txt
└── iot/                           # boîtier ESP32 (PlatformIO + Wokwi)
    ├── src/main.cpp               # firmware : alertes, MQTT, journal, SOS
    ├── diagram.json               # montage Wokwi
    ├── include/secrets.example.h  # modèle des identifiants
    ├── platformio.ini
    └── wokwi.toml
```

## Technologies

| Domaine | Outils |
|---|---|
| Interface | Next.js 16 (App Router), React 19, TypeScript, Tailwind CSS 4 |
| Vision (V1) | Google MediaPipe Face Landmarker (`@mediapipe/tasks-vision`) |
| Modèle V2 | TensorFlow / Keras 2.19, MobileNetV2 (ImageNet), TensorFlow.js 4 |
| Alertes | Web Audio API, Speech Synthesis (voix en français), Vibration API |
| IoT | ESP32 (Arduino, PlatformIO), Wokwi, MQTT (HiveMQ, mqtt.js, PubSubClient), Green-API (WhatsApp) |

## Limites et suite du projet

**Limites actuelles :**

- Le modèle V2 est entraîné sur **une seule personne**. Il risque d'être moins bon sur un autre visage, alors que la V1 de Google fonctionne pour tout le monde.
- La caméra doit voir le visage de face, avec assez de lumière.
- Le broker MQTT public n'a pas de mot de passe : suffisant pour une démo, à remplacer par un broker privé (TLS + identifiants) en vrai.
- Wokwi n'a pas de GPS : la position vient du navigateur, ou d'une position simulée.

**Suite prévue :**

- [ ] Enrichir la base : plus de sessions (nuit, lunettes, tête tournée) et d'autres personnes.
- [ ] Comparer V1 et V2 sur les mêmes scénarios de test : alertes justes, fausses alertes, délai de réaction.
- [x] Envoyer le niveau d'alerte à un **ESP32** par **MQTT** (simulation Wokwi) : buzzer, LED, écran, vibration, SOS WhatsApp.
- [ ] Passer au matériel réel (ESP32, GPS NEO-6M, moteur vibrant) et mesurer le délai détection → buzzer.

---

Projet réalisé dans le cadre du PFA à l'**EMSI** par **Alae Lahbichi**.
