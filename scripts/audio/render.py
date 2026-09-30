"""Renders every verse of an app's data (data/<app>.json) in the recorded voices, and packs them for the app.

Speech is Pocket TTS (Kyutai, Hebrew adapter by thewh1teagle, CC BY 4.0) fed with IPA from Phonikud.
The stress of each word comes from the te'amim (the U+05AB marks in the data), so mil'el words are
read mil'el; unmarked words are milra.

    cd scripts/audio
    uv run render.py omer            # renders what's missing, then packs
    uv run render.py liat --chapters 1-10
    uv run render.py omer --pack     # pack only
    uv run render.py omer --app chumash --chapters 1-3
    uv run render.py omer --app chumash --chapters 1-17 --no-pack   # several at once, then --pack

Each verse is cached as <cache>/<voice>/<ccc>-<vvv>.ogg (verse 000 is the chapter announcement).
Packing writes <out>/<voice>/<ccc>.bin, the chapter's clips back to back, and <out>/index.json with the
byte length of each clip, so the app can slice a chapter into playable files. Each app's data, cache and
output folders are in APPS (Tehillim keeps the original ones, .cache/ and audio/).
"""
import argparse, hashlib, io, json, os, re, sys, time
from pathlib import Path

import numpy as np
import soundfile as sf
from phonikud import phonemize

ROOT = Path(__file__).resolve().parents[2]
CACHE = Path(__file__).parent / ".cache"
MODEL = Path(__file__).parent / "models" / "pocket-tts-english-ipa.onnx"
VOICES = {"omer": "עומר", "liat": "ליאת"}
OPUS_LEVEL = 0.9  # libsndfile's Opus compression level; ~32 kbps for this speech

# ---------- Text -> IPA ----------
STRESS, SHVA, DAGESH, VOCAL = "֫", "ְ", "ּ", "ֽ"
MARKS = re.compile("[ְ-ׇ]")
VOWEL = re.compile("[ֱ-ׇֻ]")
FINALS = {"ך": "כ", "ם": "מ", "ן": "נ", "ף": "פ", "ץ": "צ"}


def divine_name(word):
    """The Name is read Adonai, or Elohim where it is pointed so (as speakable() in app.js)."""
    if not re.fullmatch("[ובלכמשה]{0,2}יהוה", MARKS.sub("", word.replace(STRESS, ""))):
        return word
    prefix = re.match("^(.*?)י[ְ-ׇ]*ה[ְ-ׇ]*ו", word)[1]
    return prefix + ("אֱלֹהִים" if "ִ" in word[word.rfind("ו"):] else "אֲדֹנָי")


def mark_vocal_shva(word):
    """Marks a vocal sheva with a meteg, as Phonikud expects. Same rules as ipa() in app.js:
    the first letter, after a silent sheva, under a dagesh hazak, and before an identical letter."""
    letters = re.findall("[א-ת][^א-ת]*", word)
    tail = word[len("".join(letters)):]
    last, silent = len(letters) - 1, False
    for i, c in enumerate(letters):
        if SHVA not in c or VOWEL.search(c):
            silent = False
            continue
        nxt = letters[i + 1][0] if i < last else ""
        vocal = i < last and (i == 0 or silent or (DAGESH in c and bool(VOWEL.search(letters[i - 1] if i else "")))
                              or FINALS.get(nxt, nxt) == c[0])
        silent = not vocal
        if vocal:
            letters[i] = c.replace(SHVA, SHVA + VOCAL)
    return "".join(letters) + tail


def verse_ipa(verse):
    t = verse.replace("׃", "").replace("־", " ").replace("ׇ", "ֹ")
    words = [(w.rstrip(","), w[len(w.rstrip(",")):]) for w in t.split()]  # a pause comma stays after its word
    return phonemize(" ".join(mark_vocal_shva(divine_name(w)) + pause for w, pause in words))


# Chapter announcement: "פרק" and the chapter's letters by name
LETTER_NAMES = {"א": "אָ֫לֶף", "ב": "בֵּית", "ג": "גִּ֫ימֶל", "ד": "דָּ֫לֶת", "ה": "הֵא", "ו": "וָו", "ז": "זַ֫יִן",
                "ח": "חֵית", "ט": "טֵית", "י": "יוּד", "כ": "כָּף", "ל": "לָ֫מֶד", "מ": "מֵם", "נ": "נוּן",
                "ס": "סָ֫מֶךְ", "ע": "עַ֫יִן", "פ": "פֵּא", "צ": "צָ֫דִי", "ק": "קוּף"}


def chapter_letters(n):
    """The chapter's Hebrew numeral as in hebNum() in app.js, without the geresh: 119 -> קיט."""
    hundred, n = divmod(n, 100)
    s = "ק" * hundred
    if n in (15, 16):
        return s + ("טו" if n == 15 else "טז")
    return s + " יכלמנסעפצ"[n // 10].strip() + " אבגדהוזחט"[n % 10].strip()


def letter_names(n):
    return " ".join(LETTER_NAMES[c] for c in chapter_letters(n))


def chapter_announcement(chapter):
    # The chapter is called by its letters, as it is written: "פרק קוף יוד טית"
    return "פֶּ֫רֶק " + letter_names(chapter)


# The five books by their first chapter in data/chumash.json (all their chapters, one after another)
BOOKS = [(1, "בְּרֵאשִׁית"), (51, "שְׁמוֹת"), (91, "וַיִּקְרָא"), (118, "בְּמִדְבַּר"), (154, "דְּבָרִים")]


def chumash_announcement(chapter):
    first, name = [b for b in BOOKS if b[0] <= chapter][-1]
    return f"{name} פֶּ֫רֶק {letter_names(chapter - first + 1)}"


def tanya_announcement(chapter):
    # The unit's spoken title ("לִקּוּטֵי אֲמָרִים, פֶּ֫רֶק אָ֫לֶף"), written by scripts/build-tanya.mjs
    titles = json.loads((ROOT / "data" / "tanya-announce.json").read_text(encoding="utf-8"))
    return titles[chapter - 1]


# Each app: its data, where its verses are cached and packed, and its chapter announcement (pointed text).
# "speech" (optional): the same verses with commas at the pausing accents, read instead of the data's (build-data.mjs)
APPS = {
    "tehillim": {"data": "data/tehillim.json", "cache": CACHE, "out": ROOT / "audio", "announce": chapter_announcement},
    "chumash": {"data": "data/chumash.json", "speech": "data/chumash-speech.json", "cache": CACHE / "chumash",
                "out": ROOT / "audio-chumash", "announce": chumash_announcement},
    "tanya": {"data": "data/tanya.json", "speech": "data/tanya-speech.json", "cache": CACHE / "tanya",
              "out": ROOT / "audio-tanya", "announce": tanya_announcement},
}


# ---------- Rendering ----------
def ipa_length(ipa):
    return len(re.sub("[ˈ .,]", "", ipa))


def trim(samples, sr, threshold=0.012, margin=0.06):
    loud = np.flatnonzero(np.abs(samples) > threshold)
    if not len(loud):
        return samples
    pad = int(margin * sr)
    return samples[max(0, loud[0] - pad): loud[-1] + pad]


def render(voice, jobs, cache, force=False, threads=2):
    from pocket_tts_onnx import PocketTTS
    tts = PocketTTS(str(MODEL), num_threads=threads)
    folder = cache / voice
    folder.mkdir(parents=True, exist_ok=True)
    meta_path = folder / "meta.json"
    meta = json.loads(meta_path.read_text(encoding="utf-8")) if meta_path.exists() else {}
    mine = {}  # rendered by this process
    done = 0
    for key, ipa in jobs:
        path = folder / f"{key}.ogg"
        digest = hashlib.sha1(ipa.encode()).hexdigest()[:12]
        if not force and path.exists() and meta.get(key, {}).get("ipa") == digest:
            continue
        # The model samples its speech, so now and then a take drops or repeats words.
        # Such a take is far off the usual seconds per phoneme; try other seeds and keep the most typical.
        takes = []
        for seed in (1, 2, 3, 4):
            s, sr = tts.create(ipa, voice=voice, phonemes=True, temperature=0.3, decode_steps=2, seed=seed)
            s = trim(np.asarray(s, dtype=np.float32), sr)
            pace = len(s) / sr / max(1, ipa_length(ipa))
            takes.append((abs(np.log(pace / 0.075)), pace, s, seed))
            if 0.055 < pace < 0.1:
                break
        _, pace, s, seed = min(takes, key=lambda t: t[0])
        buf = io.BytesIO()
        sf.write(buf, s, sr, format="OGG", subtype="OPUS", compression_level=OPUS_LEVEL)
        path.write_bytes(buf.getvalue())
        meta[key] = mine[key] = {"ipa": digest, "pace": round(pace, 4), "seed": seed, "tries": len(takes)}
        done += 1
        save_meta(meta_path, mine)  # every clip, so stopping the render loses nothing
        if done % 20 == 0:
            print(f"{voice}: {key} ({done} rendered)", flush=True)
    return meta


def save_meta(path, mine):
    """Several processes may render the same voice (different chapters): merge this one's entries into
    what is on disk, and replace the file whole so no one reads it half written."""
    for attempt in range(20):
        try:
            meta = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
            meta.update(mine)
            tmp = path.with_name(f"meta.{os.getpid()}.tmp")
            tmp.write_text(json.dumps(meta, indent=0), encoding="utf-8")
            os.replace(tmp, path)
            return
        except (PermissionError, json.JSONDecodeError):  # Windows: another process has the file open right now
            time.sleep(0.2 + 0.1 * attempt)
    raise RuntimeError(f"could not save {path}")


def pack(chapters, cache, out):
    index = {"voices": {}, "chapters": len(chapters)}
    versions = []
    for voice, label in VOICES.items():
        folder = cache / voice
        if not folder.exists():
            continue
        (out / voice).mkdir(parents=True, exist_ok=True)
        lengths = {}
        for c, verses in enumerate(chapters, 1):
            clips = [folder / f"{c:03}-{v:03}.ogg" for v in range(len(verses) + 1)]
            if not all(p.exists() for p in clips):
                continue
            data = [p.read_bytes() for p in clips]
            blob = b"".join(data)
            (out / voice / f"{c:03}.bin").write_bytes(blob)
            lengths[c] = [len(d) for d in data]
            versions.append(hashlib.sha1(blob).hexdigest())
        index["voices"][voice] = {"label": label, "chapters": lengths}
        print(f"{voice}: {len(lengths)} chapters packed")
    # One version for the whole set: the app keys its downloads by it, so re-rendering replaces them
    index["version"] = hashlib.sha1("".join(versions).encode()).hexdigest()[:10]
    (out / "index.json").write_text(json.dumps(index, separators=(",", ":")), encoding="utf-8")


def parse_chapters(spec):
    picked = set()
    for part in spec.split(","):
        a, _, b = part.partition("-")
        picked.update(range(int(a), int(b or a) + 1))
    return picked


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("voice", nargs="?", choices=list(VOICES))
    ap.add_argument("--chapters", help="e.g. 1-10,23,119")
    ap.add_argument("--force", action="store_true", help="re-render even cached verses")
    ap.add_argument("--pack", action="store_true", help="only pack what is cached")
    ap.add_argument("--no-pack", action="store_true", help="render only (for parallel runs; pack once when all are done)")
    ap.add_argument("--threads", type=int, default=2, help="CPU threads for the speech model")
    ap.add_argument("--app", choices=list(APPS), default="tehillim")
    args = ap.parse_args()
    app = APPS[args.app]
    chapters = json.loads((ROOT / app["data"]).read_text(encoding="utf-8"))
    if args.voice and not args.pack:
        spoken = json.loads((ROOT / app["speech"]).read_text(encoding="utf-8")) if "speech" in app else chapters
        wanted = parse_chapters(args.chapters) if args.chapters else range(1, len(chapters) + 1)
        jobs = []
        for c in wanted:
            jobs.append((f"{c:03}-000", phonemize(" ".join(map(mark_vocal_shva, app["announce"](c).split())))))
            jobs += [(f"{c:03}-{v:03}", verse_ipa(text)) for v, text in enumerate(spoken[c - 1], 1)]
        render(args.voice, jobs, app["cache"], args.force, args.threads)
    if not args.no_pack:
        pack(chapters, app["cache"], app["out"])


if __name__ == "__main__":
    sys.exit(main())
