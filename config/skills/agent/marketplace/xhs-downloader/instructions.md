# XHS (小红书) Note Downloader

Download images and videos from 小红书 (RedNote) share links without needing an account login.

## Prerequisites

- XHS-Downloader Python venv must be present at `~/.crewly/marketplace/skills/xhs-downloader-venv/`
- Network access to reach XHS CDN

## Usage

```bash
bash execute.sh '{"url":"https://xhslink.com/o/..."}'
bash execute.sh '{"url":"https://www.xiaohongshu.com/explore/...", "outputDir":"/tmp/downloads"}'
```

## Input

| Field | Required | Description |
|-------|----------|-------------|
| `url` | Yes | XHS share URL (full URL or xhslink.com short link) |
| `outputDir` | No | Download directory (default: `~/projects/personal-assistant/reports/rednote/downloads/`) |

## Output

```json
{
  "success": true,
  "files": ["/path/to/image1.jpg", "/path/to/image2.jpg"],
  "type": "image",
  "metadata": [{"title": "...", "author": "...", "type": "image", "desc": "..."}]
}
```

| Field | Description |
|-------|-------------|
| `success` | Whether the download succeeded |
| `files` | Array of absolute paths to downloaded files |
| `type` | `"image"`, `"video"`, or `"unknown"` |
| `metadata` | Post metadata: title, author, type, description |
| `error` | Error message (only present on failure) |

## Examples

```bash
# Download from a short link
bash execute.sh '{"url":"http://xhslink.com/o/7457ZK51oun"}'

# Download to a specific directory
bash execute.sh '{"url":"https://www.xiaohongshu.com/explore/abc123","outputDir":"/Users/irisran/Desktop"}'
```
