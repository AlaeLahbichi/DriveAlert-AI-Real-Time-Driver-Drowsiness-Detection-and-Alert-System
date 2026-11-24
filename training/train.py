"""Fine-tuning de MobileNetV2 (pré-entraîné sur ImageNet) sur la base data/.

Deux modèles séparés :
  - yeux   : 0 = ouvert, 1 = fermé       (images oeil_d / oeil_g)
  - bouche : 0 = normale, 1 = bâillement  (images bouche)

Découpage : toutes les images viennent d'une seule personne, on découpe donc dans le TEMPS.
Pour chaque (session, classe), les images sont triées par horodatage :
70 % premières -> entraînement, 15 % suivantes -> validation, 15 % dernières -> test.
Les images voisines (quasi identiques) restent ainsi dans le même ensemble.

Entraînement en 2 étapes :
  1. base gelée, on n'entraîne que la tête (GAP + Dropout + Dense sigmoïde) ;
  2. on dégèle les 30 dernières couches avec un petit taux d'apprentissage.

Export : SavedModel puis TensorFlow.js (graph model) dans public/models/v2/<tache>/.
Lancement (depuis training/) : .venv/bin/python train.py [yeux] [bouche]
"""

import os

os.environ["TF_USE_LEGACY_KERAS"] = "1"  # Keras 2 (tf_keras) : export TF.js fiable
os.environ["TF_CPP_MIN_LOG_LEVEL"] = "2"

import csv
import json
import re
import shutil
import subprocess
import sys
from pathlib import Path

import numpy as np
import tensorflow as tf
from PIL import Image
from sklearn.metrics import confusion_matrix, f1_score, precision_score, recall_score

keras = tf.keras
ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
OUT = Path(__file__).resolve().parent / "runs"
PUBLIC = ROOT / "public" / "models" / "v2"
SIZE = 96
SEED = 42
FILE_RE = re.compile(r"^([a-z0-9_-]+)__([a-z0-9_-]+)__(\d+)-(\d+)_(oeil_d|oeil_g|bouche)\.png$")

TASKS = {
    "yeux": {"neg": "yeux/ouverts", "pos": "yeux/fermes", "labels": ["ouvert", "ferme"]},
    "bouche": {"neg": "bouche/fermee", "pos": "bouche/baillement", "labels": ["normale", "baillement"]},
}

tf.keras.utils.set_random_seed(SEED)


def list_task(task):
    """[(chemin, label, session, horodatage, n)] pour une tâche."""
    rows = []
    for label, key in ((0, "neg"), (1, "pos")):
        for p in (DATA / TASKS[task][key]).glob("*.png"):
            m = FILE_RE.match(p.name)
            if m:
                rows.append((p, label, m.group(2), int(m.group(3)), int(m.group(4))))
    return rows


def split_by_time(rows):
    groups = {}
    for r in rows:
        groups.setdefault((r[2], r[1]), []).append(r)
    sets = {"train": [], "val": [], "test": []}
    for items in groups.values():
        items.sort(key=lambda r: (r[3], r[4], r[0].name))
        n = len(items)
        a, b = int(n * 0.70), int(n * 0.85)
        sets["train"] += items[:a]
        sets["val"] += items[a:b]
        sets["test"] += items[b:]
    return sets


def load(rows):
    x = np.stack([np.asarray(Image.open(r[0]).convert("RGB").resize((SIZE, SIZE)), dtype=np.float32) for r in rows])
    y = np.array([r[1] for r in rows], dtype=np.float32)
    return x, y


def augment(img, label):
    img = tf.image.random_flip_left_right(img)
    img = tf.image.random_brightness(img, 40.0)
    img = tf.image.random_contrast(img, 0.7, 1.3)
    img = tf.image.resize_with_crop_or_pad(img, SIZE + 12, SIZE + 12)  # petit décalage / recadrage
    img = tf.image.random_crop(img, (SIZE, SIZE, 3))
    return tf.clip_by_value(img, 0.0, 255.0), label


def dataset(x, y, train):
    ds = tf.data.Dataset.from_tensor_slices((x, y))
    if train:
        ds = ds.shuffle(len(x), seed=SEED).map(augment, num_parallel_calls=tf.data.AUTOTUNE)
    return ds.batch(32).prefetch(tf.data.AUTOTUNE)


def build_model():
    """Entrée : image 96x96x3 en pixels 0..255. Sortie : probabilité de la classe positive."""
    base = keras.applications.MobileNetV2(input_shape=(SIZE, SIZE, 3), include_top=False, weights="imagenet")
    base.trainable = False
    inp = keras.Input((SIZE, SIZE, 3), name="image")
    x = keras.layers.Rescaling(1 / 127.5, offset=-1.0)(inp)  # même prétraitement que MobileNetV2
    x = base(x, training=False)
    x = keras.layers.GlobalAveragePooling2D()(x)
    x = keras.layers.Dropout(0.3)(x)
    out = keras.layers.Dense(1, activation="sigmoid", name="prob")(x)
    return keras.Model(inp, out), base


def evaluate(model, x, y):
    p = model.predict(x, verbose=0).ravel()
    pred = (p >= 0.5).astype(int)
    tn, fp, fn, tp = confusion_matrix(y, pred, labels=[0, 1]).ravel()
    return {
        "n": int(len(y)),
        "accuracy": float((pred == y).mean()),
        "precision": float(precision_score(y, pred, zero_division=0)),
        "recall": float(recall_score(y, pred, zero_division=0)),
        "f1": float(f1_score(y, pred, zero_division=0)),
        "confusion": {"tn": int(tn), "fp": int(fp), "fn": int(fn), "tp": int(tp)},
    }


def train_task(task):
    print(f"\n===== {task.upper()} =====", flush=True)
    sets = split_by_time(list_task(task))
    for k, v in sets.items():
        print(f"  {k:5s}: {len(v):4d} images  (positifs {sum(r[1] for r in v)})", flush=True)
    (xtr, ytr), (xva, yva), (xte, yte) = (load(sets[k]) for k in ("train", "val", "test"))

    run = OUT / task
    run.mkdir(parents=True, exist_ok=True)
    with open(run / "split.csv", "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["file", "label", "session", "set"])
        for k, v in sets.items():
            for r in v:
                w.writerow([r[0].relative_to(DATA).as_posix(), r[1], r[2], k])

    model, base = build_model()
    loss = keras.losses.BinaryCrossentropy()
    metrics = [keras.metrics.BinaryAccuracy(name="acc"), keras.metrics.AUC(name="auc")]
    best = str(run / "best.weights.h5")

    def callbacks(patience):
        return [
            keras.callbacks.EarlyStopping(monitor="val_loss", patience=patience, restore_best_weights=True),
            keras.callbacks.ModelCheckpoint(best, monitor="val_loss", save_best_only=True, save_weights_only=True),
        ]

    print("  Étape 1 : base gelée", flush=True)
    model.compile(keras.optimizers.Adam(1e-3), loss, metrics)
    h1 = model.fit(dataset(xtr, ytr, True), validation_data=dataset(xva, yva, False), epochs=12, callbacks=callbacks(4), verbose=2)

    print("  Étape 2 : dégel des 30 dernières couches", flush=True)
    base.trainable = True
    for layer in base.layers[:-30]:
        layer.trainable = False
    for layer in base.layers:  # les BatchNorm restent figées (petite base)
        if isinstance(layer, keras.layers.BatchNormalization):
            layer.trainable = False
    model.compile(keras.optimizers.Adam(1e-5), loss, metrics)
    h2 = model.fit(dataset(xtr, ytr, True), validation_data=dataset(xva, yva, False), epochs=15, callbacks=callbacks(5), verbose=2)
    model.load_weights(best)

    report = {
        "task": task,
        "labels": TASKS[task]["labels"],
        "base": "MobileNetV2 (ImageNet), entrée 96x96",
        "split": "temporel par session et par classe (70/15/15)",
        "sizes": {k: len(v) for k, v in sets.items()},
        "val": evaluate(model, xva, yva),
        "test": evaluate(model, xte, yte),
        "history": {
            "stage1": {k: [float(x) for x in v] for k, v in h1.history.items()},
            "stage2": {k: [float(x) for x in v] for k, v in h2.history.items()},
        },
    }
    print(f"  TEST : {json.dumps(report['test'])}", flush=True)

    saved = run / "saved_model"
    if saved.exists():
        shutil.rmtree(saved)
    model.save(str(saved), include_optimizer=False)

    dest = PUBLIC / task
    if dest.exists():
        shutil.rmtree(dest)
    dest.mkdir(parents=True)
    subprocess.run(
        [
            str(Path(sys.executable).parent / "tensorflowjs_converter"),
            "--input_format=tf_saved_model",
            "--output_format=tfjs_graph_model",
            "--signature_name=serving_default",
            "--saved_model_tags=serve",
            str(saved),
            str(dest),
        ],
        check=True,
    )
    (run / "report.json").write_text(json.dumps(report, indent=2))
    return report


if __name__ == "__main__":
    summary = {}
    for t in sys.argv[1:] or list(TASKS):
        r = train_task(t)
        summary[t] = {k: r[k] for k in ("labels", "base", "split", "sizes", "val", "test")}
    PUBLIC.mkdir(parents=True, exist_ok=True)
    meta_path = PUBLIC / "metrics.json"
    meta = json.loads(meta_path.read_text()) if meta_path.exists() else {}
    meta.update(summary)
    meta_path.write_text(json.dumps(meta, indent=2, ensure_ascii=False))
    print("\nTerminé. Modèles exportés dans", PUBLIC, flush=True)
