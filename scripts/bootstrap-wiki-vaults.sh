#!/usr/bin/env bash
# Bootstrap missing wiki vaults per v2.1 spec §1:
#   - One Global vault at ~/.crewly/global-wiki/
#   - One Team vault per existing team UUID at ~/.crewly/teams/<uuid>/wiki/
#
# Idempotent. Existing SCHEMA.md files are NOT overwritten — only missing
# vaults get bootstrapped. Frozen sub-dirs (memory/, sop-overrides/, sop/,
# team-norm/) are created empty so OSS skills resolve paths consistently.
#
# Spec: .crewly/specs/2026-05-22-atlas-crewly-llm-wiki-v2-three-scope.md

set -euo pipefail

CREWLY_HOME="${HOME}/.crewly"
GLOBAL_VAULT="${CREWLY_HOME}/global-wiki"
TEAMS_DIR="${CREWLY_HOME}/teams"

# Tally counters reported at the end.
created_global=0
created_teams=0
already_present=0

bootstrap_global_vault() {
  if [[ -f "${GLOBAL_VAULT}/SCHEMA.md" ]]; then
    already_present=$((already_present + 1))
    return 0
  fi
  mkdir -p "${GLOBAL_VAULT}/okr"
  mkdir -p "${GLOBAL_VAULT}/decisions"
  mkdir -p "${GLOBAL_VAULT}/llm-curated"

  cat > "${GLOBAL_VAULT}/SCHEMA.md" <<'YAML'
# Global ORC vault — SCHEMA.md
# Source-of-truth shape per v2.1 spec §1(B).
# This is the cross-project / cross-team vault. ORC's roadmap, OKRs,
# cross-project synthesis memos and customer/pricing decisions that span
# projects live here.

vault_scope: global
vault_id: crewly-global

hardcoded:
  - path: okr/
    frozen: true
    description: "Company OKRs. Authored by Steve; agents read-only."
    referenced_by:
      - skill:get-sops

  - path: decisions/
    frozen: true
    description: "Cross-project decisions (Anthropic-SMB pricing, etc.). TLs promote project-scoped decisions up here when they apply across teams."
    referenced_by:
      - service:sop.service

llm_curated:
  - path: llm-curated/
    frozen: false
    seed_subdirs:
      - roadmap
      - patterns
      - people
      - log.md
      - index.md
    llm_can_create_subdirs: true
    lint_may_restructure: true

write_policy:
  canonical:
    - orchestrator
  proposed_only:
    - team-leader
  schema_writer:
    - steve
    - architect
YAML

  printf '# Activity log\n\nAppend-only log of ingested sources. Each entry: `## [<ISO>] <sourceType> | <caller>`.\n' > "${GLOBAL_VAULT}/llm-curated/log.md"

  created_global=1
}

bootstrap_team_vault() {
  local team_uuid="$1"
  local team_name="$2"
  local vault_dir="${TEAMS_DIR}/${team_uuid}/wiki"

  if [[ -f "${vault_dir}/SCHEMA.md" ]]; then
    already_present=$((already_present + 1))
    return 0
  fi

  mkdir -p "${vault_dir}/sop"
  mkdir -p "${vault_dir}/team-norm"
  mkdir -p "${vault_dir}/llm-curated"

  # Escape literal slashes/quotes from the team name so the heredoc YAML is valid.
  local safe_name
  safe_name="${team_name//\"/\\\"}"

  cat > "${vault_dir}/SCHEMA.md" <<YAML
# ${safe_name} team vault — SCHEMA.md
# Bootstrapped by scripts/bootstrap-wiki-vaults.sh per v2.1 spec §1(A).
# Team UUID: ${team_uuid}

vault_scope: team
vault_id: ${team_uuid}

hardcoded:
  - path: sop/
    frozen: true
    description: "Team SOPs. Canonical source for get-sops once migrated; today config/sops/<role>/ remains the fallback."
    referenced_by:
      - skill:get-sops
      - service:sop.service

  - path: team-norm/
    frozen: true
    description: "Team norms (canDelegate, role conventions, ROE). Maps from config/sops/<role>/team-norm/ over Phase 2 migration."
    referenced_by:
      - skill:get-team-norms

llm_curated:
  - path: llm-curated/
    frozen: false
    seed_subdirs:
      - people
      - decisions
      - patterns
      - log.md
      - index.md
    llm_can_create_subdirs: true
    lint_may_restructure: true

write_policy:
  canonical:
    - team-leader
    - orchestrator
  proposed_only:
    - worker
    - researcher
  schema_writer:
    - steve
    - architect
YAML

  printf '# Activity log\n\nAppend-only log of ingested sources. Each entry: `## [<ISO>] <sourceType> | <caller>`.\n' > "${vault_dir}/llm-curated/log.md"

  created_teams=$((created_teams + 1))
}

# 1) Global vault.
bootstrap_global_vault

# 2) Walk every team UUID dir that has a config.json.
if [[ -d "${TEAMS_DIR}" ]]; then
  for team_dir in "${TEAMS_DIR}"/*/; do
    [[ -d "${team_dir}" ]] || continue
    team_uuid="$(basename "${team_dir}")"
    [[ "${team_uuid}" == "orchestrator" ]] && continue
    config_file="${team_dir}config.json"
    [[ -f "${config_file}" ]] || continue
    # Extract the human-readable team name from config.json. node is more
    # reliable than ad-hoc grep for nested JSON; fall back to UUID on parse
    # failures.
    team_name="$(node -e "try { const c = require('${config_file}'); process.stdout.write(c.name || c.teamName || ''); } catch (e) {}" 2>/dev/null || true)"
    if [[ -z "${team_name}" ]]; then
      team_name="${team_uuid}"
    fi
    bootstrap_team_vault "${team_uuid}" "${team_name}"
  done
fi

created_projects=0

# 3) Walk every registered project from ~/.crewly/projects.json and
#    bootstrap a project vault at <path>/.crewly/wiki/ for each.
#    This complements `wiki-migrate` — that skill handles bootstrap +
#    content import per-project; this script is the lighter "skeleton
#    only" path for fresh installs / CI provisioning.
projects_json="${CREWLY_HOME}/projects.json"
if [[ -f "${projects_json}" ]]; then
  # Extract project paths via node for robustness (jq may not be available).
  while IFS= read -r project_root; do
    [[ -n "${project_root}" ]] || continue
    [[ -d "${project_root}" ]] || continue
    vault_dir="${project_root}/.crewly/wiki"
    if [[ -f "${vault_dir}/SCHEMA.md" ]]; then
      already_present=$((already_present + 1))
      continue
    fi
    mkdir -p "${vault_dir}/memory"
    mkdir -p "${vault_dir}/sop-overrides"
    mkdir -p "${vault_dir}/llm-curated"
    project_name="$(node -e "try { const ps = require('${projects_json}'); const p = ps.find(p => p.path === '${project_root}'); process.stdout.write(p?.name || ''); } catch (e) {}" 2>/dev/null || true)"
    [[ -z "${project_name}" ]] && project_name="$(basename "${project_root}")"
    safe_pname="${project_name//\"/\\\"}"
    cat > "${vault_dir}/SCHEMA.md" <<YAML
# ${safe_pname} project vault — SCHEMA.md
# Bootstrapped by scripts/bootstrap-wiki-vaults.sh per v2.1 spec §1(C).
# Registered in ${projects_json}

vault_scope: project
vault_id: ${project_name}

hardcoded:
  - path: memory/
    frozen: true
    description: "Project-scoped facts agents share."
    referenced_by:
      - skill:remember
      - skill:recall

  - path: sop-overrides/
    frozen: true
    description: "Project-specific SOP deltas. get-sops reads team-vault sop/ first, then this override layer."
    referenced_by:
      - skill:get-sops

llm_curated:
  - path: llm-curated/
    frozen: false
    seed_subdirs:
      - decisions
      - patterns
      - people
      - customers
      - log.md
      - index.md
    llm_can_create_subdirs: true
    lint_may_restructure: true

write_policy:
  canonical:
    - team-leader
    - orchestrator
  proposed_only:
    - worker
    - researcher
  schema_writer:
    - steve
    - architect
YAML
    printf '# Activity log\n\nAppend-only log of ingested sources. Each entry: `## [<ISO>] <sourceType> | <caller>`.\n' > "${vault_dir}/llm-curated/log.md"
    created_projects=$((created_projects + 1))
  done < <(node -e "try { const ps = require('${projects_json}'); ps.forEach(p => p?.path && console.log(p.path)); } catch (e) {}" 2>/dev/null)
fi

echo "Bootstrap complete:"
echo "  global-wiki created    : ${created_global}"
echo "  team vaults created    : ${created_teams}"
echo "  project vaults created : ${created_projects}"
echo "  already present        : ${already_present}"
