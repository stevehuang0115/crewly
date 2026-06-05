#!/usr/bin/env python3
"""
XHS-Downloader helper script.
Usage: python3 download.py <url> <output_dir>
Outputs JSON: {"success": true/false, "files": [...], "type": "image|video", "error": "..."}

All XHS library logging goes to stderr; only the final JSON result goes to stdout.
"""

import asyncio
import json
import sys
from pathlib import Path

# Add skill source directory to path
SKILL_DIR = Path(__file__).parent
sys.path.insert(0, str(SKILL_DIR))

# ── Redirect stdout → stderr while XHS library initialises/runs ──────────────
# XHS uses rich.print() which writes to stdout. We swap stdout to stderr for
# the duration of the download and restore it just before writing our JSON.
_real_stdout = sys.stdout
sys.stdout = sys.stderr  # XHS logging now goes to stderr

from source import XHS

sys.stdout = _real_stdout  # Restore for our JSON output


async def download_xhs(url: str, output_dir: str) -> dict:
    output_path = Path(output_dir)
    output_path.mkdir(parents=True, exist_ok=True)

    # Snapshot files before download
    before_files = set(output_path.rglob("*"))

    # XHS is a singleton — reset it between calls by clearing __INSTANCE
    XHS._XHS__INSTANCE = None

    # Redirect stdout again during the async download
    sys.stdout = sys.stderr
    try:
        async with XHS(
            work_path=str(output_path),
            folder_name=".",           # Save directly in output_dir (no subfolder)
            name_format="作品标题 作者昵称",
            cookie="",                 # No cookie needed
            proxy=None,
            timeout=30,
            max_retry=3,
            record_data=False,
            image_format="JPEG",       # Full quality JPEG for images
            image_download=True,
            video_download=True,
            live_download=False,
            download_record=False,     # Don't write ID records
            folder_mode=False,         # Flat layout, not per-post subfolders
            author_archive=False,
            write_mtime=False,
            language="zh_CN",
        ) as xhs:
            results = await xhs.extract(url, download=True)
    finally:
        sys.stdout = _real_stdout

    # Snapshot after download
    after_files = set(output_path.rglob("*"))
    new_files = sorted(
        str(f) for f in (after_files - before_files)
        if f.is_file() and not f.name.endswith(".db")
    )

    # Determine content type from results
    content_type = "unknown"
    if results:
        first = results[0]
        type_val = first.get("作品类型", "")
        if "视频" in type_val:
            content_type = "video"
        elif "图" in type_val:
            content_type = "image"

    return {
        "success": len(new_files) > 0,
        "files": new_files,
        "type": content_type,
        "metadata": [
            {
                "title": r.get("作品标题", ""),
                "author": r.get("作者昵称", ""),
                "type": r.get("作品类型", ""),
                "desc": r.get("作品描述", "")[:200] if r.get("作品描述") else "",
            }
            for r in results
        ] if results else [],
    }


def main():
    if len(sys.argv) < 3:
        _real_stdout.write(json.dumps(
            {"success": False, "error": "Usage: download.py <url> <output_dir>"}
        ) + "\n")
        sys.exit(1)

    url = sys.argv[1]
    output_dir = sys.argv[2]

    try:
        result = asyncio.run(download_xhs(url, output_dir))
        _real_stdout.write(json.dumps(result, ensure_ascii=False) + "\n")
    except Exception as e:
        _real_stdout.write(json.dumps({
            "success": False,
            "files": [],
            "error": str(e),
        }, ensure_ascii=False) + "\n")
        sys.exit(1)


if __name__ == "__main__":
    main()
