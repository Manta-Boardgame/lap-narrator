"""Japanese text normalisation for matching a script (PowerPoint notes) against an ASR transcript.

Steps (applied to both sides): NFKC, lower case, katakana -> hiragana, kanji numerals -> Arabic digits
("四歳" -> "4歳", "十二" -> "12", "三千五百" -> "3500"), a few symbols read aloud ("%"), then every character that
is not a letter or a digit is dropped (punctuation, spaces, the long-vowel mark). There is NO conversion to readings
(kana <-> kanji): no morphological analyser is installed in .venv and nothing may be installed.
"""
import unicodedata

KANJI_DIGIT = {"〇": 0, "零": 0, "一": 1, "二": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9}
KANJI_UNIT = {"十": 10, "百": 100, "千": 1000}
NUM_CHARS = set(KANJI_DIGIT) | set(KANJI_UNIT)
# Symbols that are normally read aloud (the kana here go through the same katakana/hiragana step; "ー" is dropped later)
SYMBOL_READ = {"%": "ぱーせんと", "＆": "と", "&": "と", "＋": "たす", "+": "たす", "＝": "いこーる", "=": "いこーる"}


def _kanji_number(run):
    if any(c in KANJI_UNIT for c in run):
        total, cur = 0, 0
        for c in run:
            if c in KANJI_DIGIT:
                cur = KANJI_DIGIT[c]
            else:
                total += (cur if cur else 1) * KANJI_UNIT[c]
                cur = 0
        return str(total + cur)
    return "".join(str(KANJI_DIGIT[c]) for c in run)


def _hira(c):
    o = ord(c)
    if 0x30A1 <= o <= 0x30F6:
        return chr(o - 0x60)
    return c


def normalize_pairs(pairs):
    """pairs: list of (char, tag). Returns list of (char, tag) after normalisation. The tag (e.g. a word index)
    follows the character; characters made from several inputs (numbers) take the tag of the first input."""
    step1 = []
    for ch, tag in pairs:
        for c in unicodedata.normalize("NFKC", ch):
            c = c.lower()
            if c in SYMBOL_READ:
                for r in SYMBOL_READ[c]:
                    step1.append((_hira(r), tag))
            else:
                step1.append((_hira(c), tag))
    step2 = []
    i = 0
    while i < len(step1):
        c, tag = step1[i]
        if c in NUM_CHARS:
            j = i
            while j < len(step1) and step1[j][0] in NUM_CHARS:
                j += 1
            for d in _kanji_number("".join(x[0] for x in step1[i:j])):
                step2.append((d, tag))
            i = j
        else:
            step2.append((c, tag))
            i += 1
    out = []
    for c, tag in step2:
        if c == "ー":
            continue
        cat = unicodedata.category(c)
        if cat[0] in ("L", "N"):
            out.append((c, tag))
    return out


def normalize(text):
    return "".join(c for c, _ in normalize_pairs([(ch, None) for ch in text]))
