"""Build the SpecFix project report PDF.

body*.html  -> numbered figures/tables, inline SVG diagrams -> body.pdf
front.html  -> TOC / LOT / LOF filled with real page numbers -> front.pdf
front.pdf + body.pdf -> SpecFix_Project_Report.pdf
"""
import html as H
import re
import sys
from pypdf import PdfReader, PdfWriter

import figures
import tools

HERE = tools.HERE
CSS = (HERE / "style.css").read_text(encoding="utf-8")


def doc(inner):
    return ('<!doctype html><html lang="en"><head><meta charset="utf-8"><title>SpecFix Project Report</title>'
            f"<style>{CSS}</style></head><body>{inner}</body></html>")


def strip(s):
    return H.unescape(re.sub(r"<[^>]+>", " ", s)).replace(" ", " ").strip()


def squash(s, lower=True):
    s = re.sub(r"\s+", "", s)
    return s.lower() if lower else s


# ------------------------------------------------------------------ body
body = "".join((HERE / f"body{i}.html").read_text(encoding="utf-8") for i in (1, 2, 3))

numbers = {}      # id -> "Figure 3.1"
entries = []      # ordered TOC / LOT / LOF items: (kind, label, text)
out = []
pos = 0
for m in re.finditer(r'<section class="(chapter[^"]*)" data-ch="([^"]+)">(.*?)</section>', body, re.S):
    cls, ch, sec = m.group(1), m.group(2), m.group(3)
    fig_n = tab_n = 0
    title = strip(re.search(r'<div class="chap-title">(.*?)</div>', sec, re.S).group(1))
    if ch.isdigit():
        entries.append(("ch", f"CHAPTER {ch}", f"CHAPTER {ch}: {title}"))
    else:
        entries.append(("ch", title.split(":")[0], title))

    def heading_or_caption(mm):
        global_kind = mm.group(1) or mm.group(4) or mm.group(6)
        return mm

    parts = []
    last = 0
    pattern = re.compile(
        r'<h2>(.*?)</h2>|<h3>(.*?)</h3>|<figure id="([^"]+)"[^>]*>(.*?)<figcaption>(.*?)</figcaption>|'
        r'<div class="tcap-top" id="([^"]+)">(.*?)</div>', re.S)
    for mm in pattern.finditer(sec):
        parts.append(sec[last:mm.start()])
        last = mm.end()
        if mm.group(1) is not None:
            entries.append(("s2", strip(mm.group(1)), strip(mm.group(1))))
            parts.append(mm.group(0))
        elif mm.group(2) is not None:
            entries.append(("s3", strip(mm.group(2)), strip(mm.group(2))))
            parts.append(mm.group(0))
        elif mm.group(3) is not None:
            fig_n += 1
            label = f"Figure {ch}.{fig_n}"
            numbers[mm.group(3)] = label
            cap = strip(mm.group(5))
            entries.append(("fig", label, cap))
            head = mm.group(0)[:mm.group(0).index('>') + 1]
            parts.append(f'{head}{mm.group(4)}<figcaption>{label}: {mm.group(5)}</figcaption>')
        else:
            tab_n += 1
            label = f"Table {ch}.{tab_n}"
            numbers[mm.group(6)] = label
            cap = strip(mm.group(7))
            entries.append(("tab", label, cap))
            parts.append(f'<div class="tcap-top" id="{mm.group(6)}">{label}: {mm.group(7)}</div>')
    parts.append(sec[last:])
    out.append(f'<section class="{cls}" data-ch="{ch}">' + "".join(parts) + "</section>")

body_html = "".join(out)
body_html = re.sub(r"\{\{FIG:([a-z_0-9]+)\}\}",
                   lambda mm: f'<div class="art" style="width:100%">{figures.ALL[mm.group(1)]()}</div>', body_html)


def ref(mm):
    key = mm.group(1)
    if key not in numbers:
        sys.exit(f"unknown ref {key}")
    return numbers[key]


body_html = re.sub(r"\{\{ref:([a-z0-9-]+)\}\}", ref, body_html)
left = re.findall(r"\{\{[^}]+\}\}", body_html)
assert not left, left
(HERE / "body.html").write_text(doc(f'<div class="bodypages">{body_html}</div>'), encoding="utf-8")
tools.html_to_pdf("body.html", "body.pdf")


def page_texts(pdf, lower=True):
    return [squash(p.extract_text() or "", lower) for p in PdfReader(str(HERE / pdf)).pages]


def locate(texts, needles, start=0, lower=True):
    """Return the 1-based page of each needle, scanning forward in document order."""
    pages, p = [], start
    for n in needles:
        key = squash(n, lower)[:60]
        q = p
        while q < len(texts) and key not in texts[q]:
            q += 1
        if q == len(texts):
            print("  !! not found:", n)
            pages.append(None)
        else:
            pages.append(q + 1)
            p = q
    return pages


btexts = page_texts("body.pdf")
needles = []
for kind, label, text in entries:
    if kind == "ch":
        needles.append(label)
    elif kind in ("fig", "tab"):
        needles.append(f"{label}: {text}")
    else:
        needles.append(label)
body_pages = locate(btexts, needles)


def roman(n):
    vals = [(10, "x"), (9, "ix"), (5, "v"), (4, "iv"), (1, "i")]
    r = ""
    for v, s in vals:
        while n >= v:
            r += s
            n -= v
    return r


def build_front(front_pages):
    fp = dict(front_pages)
    toc = ['<table class="toc">']
    for name in ["Declaration", "Certificate", "Acknowledgement", "Abstract", "Table of Contents",
                 "List of Tables", "List of Figures"]:
        toc.append(f'<tr><td class="t">{name}</td><td class="pg">{fp.get(name, "")}</td></tr>')
    for (kind, label, text), pg in zip(entries, body_pages):
        if kind == "ch":
            toc.append(f'<tr class="ch"><td class="t">{H.escape(text)}</td><td class="pg">{pg or ""}</td></tr>')
        elif kind == "s2":
            toc.append(f'<tr class="s2"><td class="t">{H.escape(text)}</td><td class="pg">{pg or ""}</td></tr>')
    toc.append("</table>")
    lot = ['<table class="lst">'] + [
        f'<tr><td class="no">{l}</td><td>{H.escape(t)}</td><td class="pg">{pg or ""}</td></tr>'
        for (k, l, t), pg in zip(entries, body_pages) if k == "tab"] + ["</table>"]
    lof = ['<table class="lst">'] + [
        f'<tr><td class="no">{l}</td><td>{H.escape(t)}</td><td class="pg">{pg or ""}</td></tr>'
        for (k, l, t), pg in zip(entries, body_pages) if k == "fig"] + ["</table>"]
    front = (HERE / "front.html").read_text(encoding="utf-8")
    front = front.replace("{{TOC}}", "".join(toc)).replace("{{LOT}}", "".join(lot)).replace("{{LOF}}", "".join(lof))
    (HERE / "front_built.html").write_text(doc(front), encoding="utf-8")
    tools.html_to_pdf("front_built.html", "front.pdf")


# pass 1: placeholder roman numbers (same width), pass 2: real ones
names = ["Declaration", "Certificate", "Acknowledgement", "Abstract", "Table of Contents", "List of Tables", "List of Figures"]
build_front([(n, "viii") for n in names])
ftexts = page_texts("front.pdf", lower=False)
fpages = locate(ftexts, ["DECLARATION", "CERTIFICATE", "ACKNOWLEDGEMENT", "ABSTRACT", "TABLE OF CONTENTS",
                         "LIST OF TABLES", "LIST OF FIGURES"], lower=False)
print("front-matter pages:", fpages)
build_front([(n, roman(p)) for n, p in zip(names, fpages)])
assert len(PdfReader(str(HERE / "front.pdf")).pages) == len(ftexts), "front page count changed between passes"

w = PdfWriter()
for f in ("front.pdf", "body.pdf"):
    for p in PdfReader(str(HERE / f)).pages:
        w.add_page(p)
w.add_metadata({"/Title": "SpecFix – AI-Driven Requirement Ambiguity Detection and Test Specification System",
                "/Author": "Raghav Bansal, Shrikant Sharma, Udit Bhatt",
                "/Subject": "B.Tech. Project Progress Report, GLA University"})
final = HERE / "SpecFix_Project_Report.pdf"
with open(final, "wb") as fh:
    w.write(fh)
print("front pages:", len(ftexts), "body pages:", len(btexts), "->", final)
missing = [needles[i] for i, p in enumerate(body_pages) if p is None]
print("unlocated:", missing)
