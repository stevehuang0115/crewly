#!/usr/bin/env python3
"""pdf-tools helper — the Python half of the Crewly `pdf-tools` skill.

Runs inside the skill's venv ($CREWLY_HOME/venv/pdf-tools). Every command
prints one JSON object on stdout and exits non-zero on failure.

Commands:
  md2html  <in.md> <out.html> [--title T] [--css FILE ...] [--lang zh] [--base URL]
  weasyprint <in.html> <out.pdf>
  merge    <out.pdf> <in.pdf> [<in.pdf> ...]
  read     <in.pdf> [--pages 1-3,5] [--max-chars N] [--text-file OUT.txt]
  info     <in.pdf>

Written for Crewly (MIT). Uses pypdf, python-markdown and weasyprint.
"""

import argparse
import html
import json
import os
import shutil
import subprocess
import sys

# Characters of extracted text returned inline before truncating (the rest
# goes to --text-file when given).
DEFAULT_MAX_CHARS = 20000
# Markdown extensions: tables, fenced code, heading ids, sane lists, footnotes.
MARKDOWN_EXTENSIONS = ["extra", "toc", "sane_lists", "smarty"]


def emit(obj, code=0):
    """Print one JSON object and exit."""
    print(json.dumps(obj, ensure_ascii=False))
    sys.exit(code)


def fail(message, **extra):
    """Print a failure object and exit 1."""
    emit(dict(success=False, error=message, **extra), 1)


def cmd_md2html(args):
    """Convert Markdown to a standalone HTML document with the given stylesheets."""
    try:
        import markdown  # noqa: WPS433 — optional dependency, imported on use
    except ImportError:
        fail("python-markdown is not installed in the pdf-tools venv", needsSetup=True, skill="pdf-tools", missing=["python-packages"])
    with open(args.input, encoding="utf-8") as fh:
        body = markdown.markdown(fh.read(), extensions=MARKDOWN_EXTENSIONS, output_format="html5")
    styles = []
    for css in args.css or []:
        with open(css, encoding="utf-8") as fh:
            styles.append(fh.read())
    title = html.escape(args.title or os.path.splitext(os.path.basename(args.input))[0])
    base = f'<base href="{html.escape(args.base)}">' if args.base else ""
    doc = (
        f'<!DOCTYPE html>\n<html lang="{html.escape(args.lang)}"><head><meta charset="utf-8">{base}'
        f"<title>{title}</title><style>\n" + "\n".join(styles) + "\n</style></head>\n"
        f'<body><main class="doc">\n{body}\n</main></body></html>\n'
    )
    with open(args.output, "w", encoding="utf-8") as fh:
        fh.write(doc)
    emit({"success": True, "html": args.output})


def cmd_weasyprint(args):
    """Render HTML to PDF with WeasyPrint (the fallback engine)."""
    try:
        import weasyprint  # noqa: WPS433
    except Exception as exc:  # ImportError, or OSError when pango is missing
        fail(f"weasyprint is not usable: {exc}", needsSetup=True, skill="pdf-tools", missing=["weasyprint-libs"])
    base = os.path.dirname(os.path.abspath(args.input))
    weasyprint.HTML(filename=args.input, base_url=base).write_pdf(args.output)
    emit({"success": True, "pdf": args.output})


def load_pypdf():
    """Import pypdf or fail with a needsSetup object."""
    try:
        import pypdf  # noqa: WPS433
        return pypdf
    except ImportError:
        return None


def cmd_merge(args):
    """Concatenate PDFs in order."""
    pypdf = load_pypdf()
    if pypdf is None:
        fail("pypdf is not installed in the pdf-tools venv", needsSetup=True, skill="pdf-tools", missing=["python-packages"])
    writer = pypdf.PdfWriter()
    pages = 0
    for part in args.inputs:
        reader = pypdf.PdfReader(part)
        for page in reader.pages:
            writer.add_page(page)
            pages += 1
    with open(args.output, "wb") as fh:
        writer.write(fh)
    emit({"success": True, "pdf": args.output, "pages": pages, "parts": len(args.inputs)})


def parse_pages(spec, total):
    """Turn '1-3,5' into zero-based page indexes within range."""
    if not spec:
        return list(range(total))
    wanted = []
    for chunk in spec.split(","):
        chunk = chunk.strip()
        if not chunk:
            continue
        if "-" in chunk:
            lo, hi = chunk.split("-", 1)
            start = int(lo) if lo else 1
            end = int(hi) if hi else total
            wanted.extend(range(start, end + 1))
        else:
            wanted.append(int(chunk))
    return [p - 1 for p in wanted if 1 <= p <= total]


def pdftotext_all(path):
    """Extract text per page with poppler's pdftotext (fallback).

    pdftotext ends every page with a form feed, so splitting on it gives one
    entry per page. Returns None when pdftotext is not installed or fails.
    """
    exe = shutil.which("pdftotext")
    if not exe:
        return None
    out = subprocess.run(
        [exe, "-layout", "-enc", "UTF-8", path, "-"],
        capture_output=True, text=True, check=False, stdin=subprocess.DEVNULL,
    )
    if out.returncode != 0:
        return None
    pages = out.stdout.split("\f")
    if pages and not pages[-1].strip():
        pages = pages[:-1]
    return pages


def cmd_read(args):
    """Extract text from a PDF (pypdf; pdftotext when pypdf finds none)."""
    pypdf = load_pypdf()
    engine = None
    texts = None
    total = None
    indexes = []
    if pypdf is not None:
        reader = pypdf.PdfReader(args.input)
        if reader.is_encrypted:
            try:
                reader.decrypt("")
            except Exception:  # noqa: BLE001 — any failure means we cannot read it
                fail("the PDF is encrypted and needs a password")
        total = len(reader.pages)
        indexes = parse_pages(args.pages, total)
        texts = [(reader.pages[i].extract_text() or "") for i in indexes]
        engine = "pypdf"
    if texts is None or not "".join(texts).strip():
        whole = pdftotext_all(args.input)
        if whole is not None:
            total = len(whole)
            fb_indexes = parse_pages(args.pages, total)
            fallback = [whole[i] for i in fb_indexes]
            if texts is None or "".join(fallback).strip():
                texts, engine, indexes = fallback, "pdftotext", fb_indexes
    if texts is None:
        fail("cannot read PDFs yet: neither pypdf nor pdftotext is installed", needsSetup=True, skill="pdf-tools", missing=["python-packages"])
    full = "\n\n".join(f"--- page {i + 1} ---\n{t.strip()}" for i, t in zip(indexes, texts))
    result = {
        "success": True,
        "engine": engine,
        "pages": total,
        "pagesRead": [i + 1 for i in indexes],
        "chars": len(full),
    }
    if not "".join(texts).strip():
        result["note"] = "No extractable text: the PDF is probably scanned images. Use OCR or read the page images."
    if args.text_file:
        with open(args.text_file, "w", encoding="utf-8") as fh:
            fh.write(full)
        result["textFile"] = args.text_file
    if len(full) > args.max_chars:
        result["text"] = full[: args.max_chars]
        result["truncated"] = True
    else:
        result["text"] = full
        result["truncated"] = False
    emit(result)


def pdf_page_count(path):
    """Page count via pdfinfo (poppler) when pypdf is unavailable."""
    exe = shutil.which("pdfinfo")
    if not exe:
        return None
    out = subprocess.run([exe, path], capture_output=True, text=True, check=False, stdin=subprocess.DEVNULL)
    for line in out.stdout.splitlines():
        if line.startswith("Pages:"):
            return int(line.split(":", 1)[1].strip())
    return None


def cmd_info(args):
    """Page count, encryption and document metadata."""
    pypdf = load_pypdf()
    if pypdf is None:
        pages = pdf_page_count(args.input)
        if pages is None:
            fail("pypdf is not installed in the pdf-tools venv", needsSetup=True, skill="pdf-tools", missing=["python-packages"])
        emit({"success": True, "pages": pages, "engine": "pdfinfo"})
    reader = pypdf.PdfReader(args.input)
    meta = {}
    if reader.metadata:
        for key, value in reader.metadata.items():
            meta[str(key).lstrip("/")] = str(value)
    emit({"success": True, "pages": len(reader.pages), "encrypted": reader.is_encrypted, "metadata": meta, "engine": "pypdf"})


def main():
    """Parse arguments and dispatch."""
    parser = argparse.ArgumentParser(prog="pdf_tools.py")
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("md2html")
    p.add_argument("input")
    p.add_argument("output")
    p.add_argument("--title")
    p.add_argument("--css", action="append")
    p.add_argument("--lang", default="zh")
    p.add_argument("--base", help="<base href> for relative links (file:// URL of the source directory)")
    p.set_defaults(func=cmd_md2html)

    p = sub.add_parser("weasyprint")
    p.add_argument("input")
    p.add_argument("output")
    p.set_defaults(func=cmd_weasyprint)

    p = sub.add_parser("merge")
    p.add_argument("output")
    p.add_argument("inputs", nargs="+")
    p.set_defaults(func=cmd_merge)

    p = sub.add_parser("read")
    p.add_argument("input")
    p.add_argument("--pages")
    p.add_argument("--max-chars", type=int, default=DEFAULT_MAX_CHARS)
    p.add_argument("--text-file")
    p.set_defaults(func=cmd_read)

    p = sub.add_parser("info")
    p.add_argument("input")
    p.set_defaults(func=cmd_info)

    args = parser.parse_args()
    try:
        args.func(args)
    except SystemExit:
        raise
    except Exception as exc:  # noqa: BLE001 — report every failure as JSON
        fail(f"{type(exc).__name__}: {exc}")


if __name__ == "__main__":
    main()
