"""Renders every verse of data/tehillim.json in the recorded voices, and packs them for the app.

Speech is Pocket TTS (Kyutai, Hebrew adapter by thewh1teagle, CC BY 4.0) fed with IPA from Phonikud.
The stress of each word comes from the te'amim (the U+05AB marks in the data), so mil'el words are
read mil'el; unmarked words are milra.

    cd scripts/audio
    uv run render.py omer            # renders what's missing, then packs
    uv run render.py liat --chapters 1-10
    uv run render.py omer --pack     # pack only
    uv run render.py yaniv --clone me.wav --label "יניב" --chapters 1-3

A cloned voice is encoded once from the first 20 seconds of the recording and kept as
scripts/audio/voices/<name>.npy, with its label in <name>.json; later runs need only the name.
Its verses stay in the cache to listen to; packing leaves it out until it is added to VOICES.

Each verse is cached as scripts/audio/.cache/<voice>/<ccc>-<vvv>.ogg (verse 000 is the chapter
announcement). Packing writes audio/<voice>/<ccc>.bin, the chapter's clips back to back, and
audio/index.json with the byte length of each clip, so the app can slice a chapter into playable files.
"""
import argparse, hashlib, io, json, re, sys
from pathlib import Path

import numpy as np
import soundfile as sf
from phonikud import phonemize

ROOT = Path(__file__).resolve().parents[2]
CACHE = Path(__file__).parent / ".cache"
OUT = ROOT / "audio"
MODEL = Path(__file__).parent / "models" / "pocket-tts-english-ipa.onnx"
VOICES = {"omer": "עומר", "liat": "ליאת"}
CLONED = Path(__file__).parent / "voices"  # personal voice prompts, kept out of git
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
    return phonemize(" ".join(mark_vocal_shva(divine_name(w)) for w in t.split()))


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


def announcement_ipa(chapter):
    # The chapter is called by its letters, as it is written: "פרק קוף יוד טית"
    return phonemize("פֶּ֫רֶק " + " ".join(LETTER_NAMES[c] for c in chapter_letters(chapter)))


# ---------- Rendering ----------
def ipa_length(ipa):
    return len(re.sub("[ˈ .,]", "", ipa))


def trim(samples, sr, threshold=0.012, margin=0.06):
    loud = np.flatnonzero(np.abs(samples) > threshold)
    if not len(loud):
        return samples
    pad = int(margin * sr)
    return samples[max(0, loud[0] - pad): loud[-1] + pad]


def all_voices():
    cloned = {p.stem: json.loads(p.read_text(encoding="utf-8"))["label"] for p in sorted(CLONED.glob("*.json"))}
    return {**VOICES, **cloned}


def clone(name, recording, label):
    from pocket_tts_onnx import PocketTTS
    CLONED.mkdir(exist_ok=True)
    np.save(CLONED / f"{name}.npy", PocketTTS(str(MODEL)).clone_voice(recording))
    (CACHE / name / "meta.json").unlink(missing_ok=True)  # a new recording makes every cached verse stale
    (CLONED / f"{name}.json").write_text(json.dumps({"label": label}, ensure_ascii=False), encoding="utf-8")


def render(voice, jobs, force=False):
    from pocket_tts_onnx import PocketTTS
    tts = PocketTTS(str(MODEL))
    speaker = voice if voice in VOICES else np.load(CLONED / f"{voice}.npy")
    folder = CACHE / voice
    folder.mkdir(parents=True, exist_ok=True)
    meta_path = folder / "meta.json"
    meta = json.loads(meta_path.read_text(encoding="utf-8")) if meta_path.exists() else {}
    # Each voice has its own pace, so takes are judged against the median of the voice's takes so far
    # (omer is ~0.073 s/phoneme, liat ~0.076); a new voice starts from its own first take.
    paces = [m["pace"] for m in meta.values()]
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
            s, sr = tts.create(ipa, voice=speaker, phonemes=True, temperature=0.3, decode_steps=2, seed=seed)
            s = trim(np.asarray(s, dtype=np.float32), sr)
            pace = len(s) / sr / max(1, ipa_length(ipa))
            target = float(np.median(paces or [pace]))
            takes.append((abs(np.log(pace / target)), pace, s, seed))
            if 0.73 < pace / target < 1.33:  # 0.055-0.1 around 0.075
                break
        _, pace, s, seed = min(takes, key=lambda t: t[0])
        paces.append(pace)
        buf = io.BytesIO()
        sf.write(buf, s, sr, format="OGG", subtype="OPUS", compression_level=OPUS_LEVEL)
        path.write_bytes(buf.getvalue())
        meta[key] = {"ipa": digest, "pace": round(pace, 4), "seed": seed, "tries": len(takes)}
        done += 1
        if done % 20 == 0:
            meta_path.write_text(json.dumps(meta, indent=0), encoding="utf-8")
            print(f"{voice}: {key} ({done} rendered)", flush=True)
    meta_path.write_text(json.dumps(meta, indent=0), encoding="utf-8")
    return meta


def pack(chapters):
    index = {"voices": {}, "chapters": len(chapters)}
    versions = []
    for voice, label in VOICES.items():  # cloned voices stay local, in their cache, until one is added here
        folder = CACHE / voice
        if not folder.exists():
            continue
        (OUT / voice).mkdir(parents=True, exist_ok=True)
        lengths = {}
        for c, verses in enumerate(chapters, 1):
            clips = [folder / f"{c:03}-{v:03}.ogg" for v in range(len(verses) + 1)]
            if not all(p.exists() for p in clips):
                continue
            data = [p.read_bytes() for p in clips]
            blob = b"".join(data)
            (OUT / voice / f"{c:03}.bin").write_bytes(blob)
            lengths[c] = [len(d) for d in data]
            versions.append(hashlib.sha1(blob).hexdigest())
        index["voices"][voice] = {"label": label, "chapters": lengths}
        print(f"{voice}: {len(lengths)} chapters packed")
    # One version for the whole set: the app keys its downloads by it, so re-rendering replaces them
    index["version"] = hashlib.sha1("".join(versions).encode()).hexdigest()[:10]
    (OUT / "index.json").write_text(json.dumps(index, separators=(",", ":")), encoding="utf-8")


def parse_chapters(spec):
    picked = set()
    for part in spec.split(","):
        a, _, b = part.partition("-")
        picked.update(range(int(a), int(b or a) + 1))
    return picked


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("voice", nargs="?", help=f"{', '.join(all_voices())}, or a new name with --clone")
    ap.add_argument("--clone", metavar="RECORDING", help="make the voice from a recording (WAV, FLAC, OGG, MP3)")
    ap.add_argument("--label", help="the cloned voice's Hebrew name")
    ap.add_argument("--chapters", help="e.g. 1-10,23,119")
    ap.add_argument("--force", action="store_true", help="re-render even cached verses")
    ap.add_argument("--pack", action="store_true", help="only pack what is cached")
    args = ap.parse_args()
    if args.clone:
        if args.voice in VOICES or not args.voice or not re.fullmatch("[a-z0-9_-]+", args.voice):
            ap.error("--clone needs a new lowercase name for the voice")
        clone(args.voice, args.clone, args.label or args.voice)
    elif args.voice and args.voice not in all_voices():
        ap.error(f"unknown voice {args.voice}; clone it first with --clone")
    chapters = json.loads((ROOT / "data/tehillim.json").read_text(encoding="utf-8"))
    if args.voice and not args.pack:
        wanted = parse_chapters(args.chapters) if args.chapters else range(1, len(chapters) + 1)
        jobs = []
        for c in wanted:
            jobs.append((f"{c:03}-000", announcement_ipa(c)))
            jobs += [(f"{c:03}-{v:03}", verse_ipa(text)) for v, text in enumerate(chapters[c - 1], 1)]
        render(args.voice, jobs, args.force)
    pack(chapters)


if __name__ == "__main__":
    sys.exit(main())
