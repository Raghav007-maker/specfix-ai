"""Tiny SVG helpers for the report diagrams. All figures use a 720-unit-wide viewBox."""
from html import escape

FONT = "Arial, Helvetica, sans-serif"
NAVY = "#1F3B5C"
BLUE = "#2F5D8A"
LBLUE = "#E8F0FA"
GREEN = "#E3F2E6"
DGREEN = "#2E7D46"
ORANGE = "#FFF0DC"
DORANGE = "#B8670A"
GREY = "#F2F4F7"
DGREY = "#555F6D"
PURPLE = "#EEE8F8"
DPURPLE = "#5B3E96"
W = 720


class Svg:
    def __init__(self, h, w=W):
        self.w, self.h = w, h
        self.parts = []

    def add(self, s):
        self.parts.append(s)
        return self

    def render(self):
        defs = f"""<defs>
<marker id="ah" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="{DGREY}"/></marker>
<marker id="ahb" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="{BLUE}"/></marker>
<marker id="tri" viewBox="0 0 12 12" refX="11" refY="6" markerWidth="11" markerHeight="11" orient="auto"><path d="M0,0 L12,6 L0,12 z" fill="white" stroke="{DGREY}" stroke-width="1.2"/></marker>
</defs>"""
        return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {self.w} {self.h}" '
                f'font-family="{FONT}" width="100%">' + defs + "".join(self.parts) + "</svg>")

    # --- primitives -------------------------------------------------------
    def text(self, x, y, s, size=14, weight="normal", fill="#1b1b1b", anchor="middle", style="normal"):
        return self.add(f'<text x="{x}" y="{y}" font-size="{size}" font-weight="{weight}" fill="{fill}" '
                        f'text-anchor="{anchor}" font-style="{style}">{escape(s)}</text>')

    def lines(self, cx, top, lines, size=14, gap=None, weight_first=None, fill="#1b1b1b", anchor="middle"):
        gap = gap or size * 1.25
        for i, ln in enumerate(lines):
            w = weight_first if (weight_first and i == 0) else "normal"
            self.text(cx, top + size + i * gap, ln, size, w, fill, anchor)
        return self

    def box(self, x, y, w, h, lines=(), fill=LBLUE, stroke=BLUE, rx=6, size=14, bold_first=True,
            dash=None, tcolor="#1b1b1b", sw=1.4):
        d = f' stroke-dasharray="{dash}"' if dash else ""
        self.add(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{rx}" fill="{fill}" stroke="{stroke}" stroke-width="{sw}"{d}/>')
        if lines:
            gap = size * 1.25
            total = gap * (len(lines) - 1) + size
            top = y + (h - total) / 2 - 2
            self.lines(x + w / 2, top, lines, size, gap, "bold" if bold_first else None, tcolor)
        return self

    def line(self, pts, color=DGREY, width=1.4, arrow=True, dash=None, head="ah", start_arrow=False):
        p = " ".join(f"{a},{b}" for a, b in pts)
        d = f' stroke-dasharray="{dash}"' if dash else ""
        me = f' marker-end="url(#{head})"' if arrow else ""
        ms = f' marker-start="url(#{head})"' if start_arrow else ""
        return self.add(f'<polyline points="{p}" fill="none" stroke="{color}" stroke-width="{width}"{d}{me}{ms}/>')

    def label(self, x, y, s, size=12, fill=DGREY, anchor="middle", bg=True, weight="normal"):
        if bg:
            wid = len(s) * size * 0.56 + 8
            if anchor == "middle":
                bx = x - wid / 2
            elif anchor == "start":
                bx = x - 4
            else:
                bx = x - wid + 4
            self.add(f'<rect x="{bx}" y="{y - size}" width="{wid}" height="{size + 5}" fill="white" opacity="0.92"/>')
        return self.text(x, y, s, size, weight, fill, anchor)

    def ellipse(self, cx, cy, rx, ry, lines=(), fill=LBLUE, stroke=BLUE, size=13):
        self.add(f'<ellipse cx="{cx}" cy="{cy}" rx="{rx}" ry="{ry}" fill="{fill}" stroke="{stroke}" stroke-width="1.4"/>')
        gap = size * 1.2
        top = cy - (gap * (len(lines) - 1) + size) / 2 - 1
        self.lines(cx, top, lines, size, gap)
        return self

    def circle(self, cx, cy, r, lines=(), fill=LBLUE, stroke=BLUE, size=13, bold_first=True):
        self.add(f'<circle cx="{cx}" cy="{cy}" r="{r}" fill="{fill}" stroke="{stroke}" stroke-width="1.6"/>')
        gap = size * 1.22
        top = cy - (gap * (len(lines) - 1) + size) / 2 - 1
        self.lines(cx, top, lines, size, gap, "bold" if bold_first else None)
        return self

    def store(self, x, y, w, h, label, size=13):
        """DFD data store: open-ended rectangle with id cell."""
        self.add(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" fill="{GREY}" stroke="none"/>')
        self.add(f'<polyline points="{x + w},{y} {x},{y} {x},{y + h} {x + w},{y + h}" fill="none" stroke="{DGREY}" stroke-width="1.4"/>')
        self.add(f'<line x1="{x + 38}" y1="{y}" x2="{x + 38}" y2="{y + h}" stroke="{DGREY}" stroke-width="1.2"/>')
        did, name = label
        self.text(x + 19, y + h / 2 + size * 0.35, did, size, "bold")
        self.text(x + 46, y + h / 2 + size * 0.35, name, size, anchor="start")
        return self

    def cylinder(self, x, y, w, h, lines=(), fill=GREY, stroke=DGREY, size=13):
        e = 9
        self.add(f'<path d="M{x},{y + e} A{w / 2},{e} 0 0 1 {x + w},{y + e} L{x + w},{y + h - e} '
                 f'A{w / 2},{e} 0 0 1 {x},{y + h - e} Z" fill="{fill}" stroke="{stroke}" stroke-width="1.4"/>')
        self.add(f'<path d="M{x},{y + e} A{w / 2},{e} 0 0 0 {x + w},{y + e}" fill="none" stroke="{stroke}" stroke-width="1.4"/>')
        gap = size * 1.22
        top = y + e + (h - e - (gap * (len(lines) - 1) + size)) / 2 - 2
        self.lines(x + w / 2, top, lines, size, gap, "bold")
        return self

    def actor(self, cx, top, name_lines, size=13):
        c = DGREY
        self.add(f'<circle cx="{cx}" cy="{top + 9}" r="9" fill="white" stroke="{c}" stroke-width="1.5"/>')
        self.add(f'<line x1="{cx}" y1="{top + 18}" x2="{cx}" y2="{top + 42}" stroke="{c}" stroke-width="1.5"/>')
        self.add(f'<line x1="{cx - 15}" y1="{top + 26}" x2="{cx + 15}" y2="{top + 26}" stroke="{c}" stroke-width="1.5"/>')
        self.add(f'<line x1="{cx}" y1="{top + 42}" x2="{cx - 12}" y2="{top + 60}" stroke="{c}" stroke-width="1.5"/>')
        self.add(f'<line x1="{cx}" y1="{top + 42}" x2="{cx + 12}" y2="{top + 60}" stroke="{c}" stroke-width="1.5"/>')
        self.lines(cx, top + 62, name_lines, size, None, "bold")
        return self

    def classbox(self, x, y, w, name, attrs, ops=(), size=12, head_fill=NAVY):
        lh = size * 1.3
        h_head = 24
        h_attr = lh * len(attrs) + 8
        h_ops = (lh * len(ops) + 8) if ops else 0
        h = h_head + h_attr + h_ops
        self.add(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" fill="white" stroke="{BLUE}" stroke-width="1.4"/>')
        self.add(f'<rect x="{x}" y="{y}" width="{w}" height="{h_head}" fill="{head_fill}" stroke="{BLUE}" stroke-width="1.4"/>')
        self.text(x + w / 2, y + 17, name, 13, "bold", "white")
        for i, a in enumerate(attrs):
            self.text(x + 7, y + h_head + 4 + size + i * lh, a, size, anchor="start")
        if ops:
            yy = y + h_head + h_attr
            self.add(f'<line x1="{x}" y1="{yy}" x2="{x + w}" y2="{yy}" stroke="{BLUE}" stroke-width="1"/>')
            for i, o in enumerate(ops):
                self.text(x + 7, yy + 4 + size + i * lh, o, size, anchor="start", fill=DPURPLE)
        return h
