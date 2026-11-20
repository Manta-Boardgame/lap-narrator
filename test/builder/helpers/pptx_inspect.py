"""Reads what build-a.ps1 put into a pptx copy (owner: D, test helper). One JSON line.
  .venv/Scripts/python.exe -I test/builder/helpers/pptx_inspect.py <deck.pptx>
"""
import json
import re
import sys
import zipfile

z = zipfile.ZipFile(sys.argv[1])
names = z.namelist()
slides = {}
for n in sorted(names):
    m = re.fullmatch(r"ppt/slides/slide(\d+)\.xml", n)
    if not m:
        continue
    idx = int(m.group(1))
    xml = z.read(n).decode("utf-8")
    rels = z.read("ppt/slides/_rels/slide%d.xml.rels" % idx).decode("utf-8")
    audio_rels = re.findall(r'Type="[^"]*/relationships/audio"[^>]*?Target="([^"]*)"([^>]*)', rels)
    external = ['TargetMode="External"' in tail for _t, tail in audio_rels]
    # attribute order differs between PowerPoint versions: also look at the whole element
    elems = re.findall(r"<Relationship [^>]*relationships/audio[^>]*/>", rels)
    slides[idx] = {
        "audioRelCount": len(elems),
        "audioRelExternal": ["TargetMode=\"External\"" in e for e in elems],
        "audioTargets": [re.search(r'Target="([^"]*)"', e).group(1) for e in elems],
        "advTm": re.findall(r'advTm="(\d+)"', xml),
        "advClick": re.findall(r'advClick="(\d)"', xml),
        "delays": re.findall(r'<p:cond delay="(\d+)"/></p:stCondLst><p:childTnLst><p:cmd', xml),
        "hideDuringShow": 'showWhenStopped="0"' in xml,
        "hidden": 'show="0"' in xml.split("<p:cSld", 1)[0],
    }
out = {
    "embeddedWavs": [n for n in names if n.startswith("ppt/media/") and n.lower().endswith(".wav")],
    "mediaFiles": [n for n in names if n.startswith("ppt/media/")],
    "slides": slides,
}
print(json.dumps(out))
