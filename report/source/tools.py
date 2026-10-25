import os
import subprocess
import pathlib

CHROME = r"C:\Program Files\Google\Chrome\Application\chrome.exe"
HERE = pathlib.Path(__file__).resolve().parent


def html_to_pdf(html_name, pdf_name):
    src = (HERE / html_name).resolve()
    out = (HERE / pdf_name).resolve()
    if out.exists():
        out.unlink()
    subprocess.run([CHROME, "--headless=new", "--disable-gpu", "--no-pdf-header-footer",
                    "--virtual-time-budget=5000", f"--print-to-pdf={out}", src.as_uri()],
                   check=True, capture_output=True)
    if not out.exists():
        raise RuntimeError("chrome produced no pdf")
    return out


def png_pages(pdf_name, prefix, scale=1.3, pages=None):
    import pypdfium2 as p
    d = p.PdfDocument(str(HERE / pdf_name))
    idx = range(len(d)) if pages is None else pages
    for i in idx:
        d[i].render(scale=scale).to_pil().save(str(HERE / f"{prefix}{i + 1:02d}.png"))
    return len(d)
