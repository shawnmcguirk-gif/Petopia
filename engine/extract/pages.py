# Petopia D1 S5: a copy of Vitalis engine/extract/pages.py (PyMuPDF helper; only this header line differs). Petopia's own copy, no cross-project import.
#   pages.py text <file>          -> JSON [{"page":1,"text":"..."}, ...] from the PDF's text layer
#   pages.py words <file> <page> -> JSON {"page":n,"width":w,"height":h,"words":[[x0,y0,x1,y1,"text"],...]} (slice 4, source highlight)
#   pages.py png  <file> <page>   -> base64 PNG of one page (150 dpi) on stdout, for OCR
# Reads the file in place and writes nothing to disk.
import sys, json, base64
import pymupdf as fitz

mode, path = sys.argv[1], sys.argv[2]
doc = fitz.open(path)
if mode == "text":
    print(json.dumps([{"page": i + 1, "text": p.get_text("text")} for i, p in enumerate(doc)]))
elif mode == "png":
    page = doc[int(sys.argv[3]) - 1]
    print(base64.b64encode(page.get_pixmap(dpi=150).tobytes("png")).decode())
elif mode == "words":
    n = int(sys.argv[3])
    page = doc[n - 1]
    r = page.rect
    print(json.dumps({"page": n, "width": r.width, "height": r.height,
                      "words": [[w[0], w[1], w[2], w[3], w[4]] for w in page.get_text("words")]}))
else:
    sys.exit("unknown mode")
