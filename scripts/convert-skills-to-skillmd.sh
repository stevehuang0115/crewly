#!/usr/bin/env bash
# Convert all skill.json + instructions.md → SKILL.md (YAML frontmatter + markdown body)
# Deletes skill.json and instructions.md after successful conversion.
#
# Usage: bash scripts/convert-skills-to-skillmd.sh [--dry-run]

set -euo pipefail

DRY_RUN=false
if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN=true
  echo "[DRY RUN] No files will be modified."
fi

CONVERTED=0
SKIPPED=0
FAILED=0

# Find all skill.json files
while IFS= read -r skill_json; do
  skill_dir="$(dirname "$skill_json")"
  skill_md="$skill_dir/SKILL.md"
  instructions_md="$skill_dir/instructions.md"

  # Skip if SKILL.md already exists
  if [[ -f "$skill_md" ]]; then
    echo "[SKIP] $skill_dir (SKILL.md already exists)"
    SKIPPED=$((SKIPPED + 1))
    continue
  fi

  # Read skill.json
  if ! json_content=$(cat "$skill_json" 2>/dev/null); then
    echo "[FAIL] $skill_dir (cannot read skill.json)"
    FAILED=$((FAILED + 1))
    continue
  fi

  # Extract fields from skill.json using python3 (available on macOS)
  frontmatter=$(python3 -c "
import json, sys

data = json.load(sys.stdin)

# Build YAML frontmatter
lines = ['---']

def yaml_str(v):
    if isinstance(v, str):
        # Quote strings that contain special chars
        if any(c in v for c in ':{}[]#&*!|>\\'\"@\`%'):
            return json.dumps(v)
        return v
    return str(v)

def yaml_list(items, indent=2):
    result = []
    for item in items:
        result.append(' ' * indent + '- ' + yaml_str(item))
    return '\n'.join(result)

# Required fields
for key in ['name', 'description']:
    if key in data:
        lines.append(f'{key}: {yaml_str(data[key])}')

# Optional simple fields
for key in ['version', 'category', 'skillType']:
    if key in data and data[key]:
        lines.append(f'{key}: {yaml_str(data[key])}')

# Array fields
for key in ['assignableRoles', 'triggers', 'tags']:
    if key in data and data[key]:
        lines.append(f'{key}:')
        for item in data[key]:
            lines.append(f'  - {yaml_str(item)}')

# Execution config (nested)
if 'execution' in data and data['execution']:
    ex = data['execution']
    lines.append('execution:')
    if 'type' in ex:
        lines.append(f'  type: {ex[\"type\"]}')
    if 'script' in ex and ex['script']:
        lines.append('  script:')
        for sk, sv in ex['script'].items():
            lines.append(f'    {sk}: {sv}')
    if 'browser' in ex and ex['browser']:
        lines.append('  browser:')
        for bk, bv in ex['browser'].items():
            if isinstance(bv, list):
                lines.append(f'    {bk}:')
                for item in bv:
                    if isinstance(item, dict):
                        lines.append(f'      - ' + json.dumps(item))
                    else:
                        lines.append(f'      - {yaml_str(item)}')
            else:
                lines.append(f'    {bk}: {yaml_str(bv)}')
    if 'mcpTool' in ex and ex['mcpTool']:
        lines.append('  mcpTool:')
        for mk, mv in ex['mcpTool'].items():
            if isinstance(mv, dict):
                lines.append(f'    {mk}:')
                for dk, dv in mv.items():
                    lines.append(f'      {dk}: {yaml_str(dv)}')
            else:
                lines.append(f'    {mk}: {yaml_str(mv)}')
    if 'composite' in ex and ex['composite']:
        lines.append('  composite:')
        comp = ex['composite']
        if 'skillSequence' in comp:
            lines.append('    skillSequence:')
            for item in comp['skillSequence']:
                lines.append(f'      - {yaml_str(item)}')
        if 'continueOnError' in comp:
            lines.append(f'    continueOnError: {str(comp[\"continueOnError\"]).lower()}')

# Environment config
if 'environment' in data and data['environment']:
    env = data['environment']
    lines.append('environment:')
    if 'variables' in env:
        lines.append('  variables:')
        for vk, vv in env['variables'].items():
            lines.append(f'    {vk}: {yaml_str(vv)}')
    if 'secrets' in env:
        lines.append('  secrets:')
        for item in env['secrets']:
            lines.append(f'    - {yaml_str(item)}')

# Runtime config
if 'runtime' in data and data['runtime']:
    rt = data['runtime']
    lines.append('runtime:')
    for rk, rv in rt.items():
        if isinstance(rv, list):
            lines.append(f'  {rk}:')
            for item in rv:
                lines.append(f'    - {yaml_str(item)}')
        else:
            lines.append(f'  {rk}: {yaml_str(rv)}')

# Notices
if 'notices' in data and data['notices']:
    lines.append('notices:')
    for notice in data['notices']:
        lines.append(f'  - type: {notice.get(\"type\", \"info\")}')
        lines.append(f'    message: {yaml_str(notice.get(\"message\", \"\"))}')

# Tier fields
if 'requiredTier' in data and data['requiredTier']:
    lines.append(f'requiredTier: {yaml_str(data[\"requiredTier\"])}')
if 'fallbackSkill' in data and data['fallbackSkill']:
    lines.append(f'fallbackSkill: {yaml_str(data[\"fallbackSkill\"])}')

lines.append('---')
print('\n'.join(lines))
" <<< "$json_content") || {
    echo "[FAIL] $skill_dir (failed to generate frontmatter)"
    FAILED=$((FAILED + 1))
    continue
  }

  # Read instructions.md body (if exists)
  body=""
  if [[ -f "$instructions_md" ]]; then
    body=$(cat "$instructions_md")
  fi

  # Combine frontmatter + body
  if [[ -n "$body" ]]; then
    skill_md_content="$frontmatter"$'\n\n'"$body"
  else
    skill_md_content="$frontmatter"$'\n'
  fi

  if $DRY_RUN; then
    echo "[WOULD CONVERT] $skill_dir"
  else
    # Write SKILL.md
    echo "$skill_md_content" > "$skill_md"
    # Remove old files
    rm -f "$skill_json"
    rm -f "$instructions_md"
    echo "[CONVERTED] $skill_dir"
  fi

  CONVERTED=$((CONVERTED + 1))
done < <(find config/skills -name "skill.json" -type f | sort)

echo ""
echo "=== Results ==="
echo "Converted: $CONVERTED"
echo "Skipped: $SKIPPED"
echo "Failed: $FAILED"
