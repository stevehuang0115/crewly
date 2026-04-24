#!/bin/bash
# Credential Manager — wraps /api/credentials REST endpoints so the
# orchestrator can manage Google OAuth accounts and API keys on user request.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../_common/lib.sh"

INPUT=$(read_json_input "${1:-}")
if [ -z "$INPUT" ]; then
  error_exit "Usage: execute.sh '{\"action\":\"list|import-google|clear-gemini-cli|add-api-key|delete|read-gmail\", ...}'"
fi

ACTION=$(printf '%s' "$INPUT" | jq -r '.action // empty')
require_param "action" "$ACTION"

case "$ACTION" in
  list)
    TYPE=$(printf '%s' "$INPUT" | jq -r '.type // empty')
    PROVIDER=$(printf '%s' "$INPUT" | jq -r '.provider // empty')
    RESP=$(api_call GET "/credentials")
    # Filter client-side
    printf '%s' "$RESP" | jq --arg type "$TYPE" --arg provider "$PROVIDER" '
      .data
      | map(select($type == "" or .type == $type))
      | map(select($provider == "" or .provider == $provider))
      | map({id, name, type, provider, helper, accountEmail, scopes, status, createdAt, lastUsedAt})
    '
    ;;

  import-google)
    # Import from gemini-cli extension's LOCAL file (developer / on-box user).
    # For remote users over Slack, use start-google-oauth + complete-google-oauth instead.
    NAME=$(printf '%s' "$INPUT" | jq -r '.name // empty')
    require_param "name" "$NAME"
    BODY=$(jq -nc --arg name "$NAME" '{name: $name}')
    RESP=$(api_call POST "/credentials/oauth/import-gemini-cli" "$BODY")
    printf '%s' "$RESP" | jq '
      if .success == true then
        {success: true, credential: .data | {id, name, type, provider, helper, accountEmail, scopes}}
      else
        {success: false, error: .error}
      end
    '
    ;;

  start-google-oauth)
    # Headless flow — returns a URL for a remote user to click.
    # Optionally takes scopes override; defaults to broad Workspace set.
    SCOPES_ARG=$(printf '%s' "$INPUT" | jq -c '.scopes // empty')
    if [ -n "$SCOPES_ARG" ]; then
      BODY=$(printf '%s' "$SCOPES_ARG" | jq -c '{scopes: .}')
    else
      BODY='{}'
    fi
    RESP=$(api_call POST "/credentials/oauth/google/start" "$BODY")
    printf '%s' "$RESP" | jq '
      if .success == true then
        {
          success: true,
          authUrl: .data.authUrl,
          instructions: "Send authUrl to the user. They click it on their device, sign in with the Google account they want to add, and copy the JSON shown on the success page. Then call action=complete-google-oauth with the pasted JSON."
        }
      else
        {success: false, error: .error}
      end
    '
    ;;

  complete-google-oauth)
    # Accept the JSON the user pasted from the success page. Save as a new credential.
    NAME=$(printf '%s' "$INPUT" | jq -r '.name // empty')
    require_param "name" "$NAME"
    # Accept either the raw JSON string or a parsed object under .credentialsJson
    CREDS=$(printf '%s' "$INPUT" | jq -c '.credentialsJson // empty')
    if [ -z "$CREDS" ] || [ "$CREDS" = "null" ]; then
      error_exit "credentialsJson is required (paste the JSON block from the OAuth success page)"
    fi
    BODY=$(jq -nc --arg name "$NAME" --argjson creds "$CREDS" '{name: $name, credentialsJson: $creds}')
    RESP=$(api_call POST "/credentials/oauth/google/complete" "$BODY")
    printf '%s' "$RESP" | jq '
      if .success == true then
        {success: true, credential: .data | {id, name, type, provider, helper, accountEmail, scopes, status}}
      else
        {success: false, error: .error}
      end
    '
    ;;

  clear-gemini-cli)
    api_call POST "/credentials/oauth/gemini-cli/clear-extension-file" "" \
      | jq '{cleared: (.success == true), error: .error}'
    ;;

  add-api-key)
    NAME=$(printf '%s' "$INPUT" | jq -r '.name // empty')
    PROVIDER=$(printf '%s' "$INPUT" | jq -r '.provider // empty')
    VALUE=$(printf '%s' "$INPUT" | jq -r '.value // empty')
    require_param "name" "$NAME"
    require_param "provider" "$PROVIDER"
    require_param "value" "$VALUE"
    BODY=$(jq -nc --arg name "$NAME" --arg provider "$PROVIDER" --arg value "$VALUE" \
      '{name: $name, provider: $provider, value: $value}')
    RESP=$(api_call POST "/credentials/api-key" "$BODY")
    printf '%s' "$RESP" | jq '
      if .success == true then
        {success: true, credential: .data | {id, name, type, provider, createdAt}}
      else
        {success: false, error: .error}
      end
    '
    ;;

  delete)
    ID=$(printf '%s' "$INPUT" | jq -r '.id // empty')
    require_param "id" "$ID"
    api_call DELETE "/credentials/${ID}" | jq '{deleted: (.success == true), error: .error}'
    ;;

  read-gmail)
    NAME=$(printf '%s' "$INPUT" | jq -r '.name // empty')
    MAX=$(printf '%s' "$INPUT" | jq -r '.maxResults // 10')
    require_param "name" "$NAME"

    # 1. Find the credential by name
    LIST_RESP=$(api_call GET "/credentials")
    CRED_ID=$(printf '%s' "$LIST_RESP" | jq -r --arg name "$NAME" '
      .data[]? | select(.name == $name and .type == "google-oauth") | .id
    ' | head -n 1)

    if [ -z "$CRED_ID" ]; then
      AVAILABLE=$(printf '%s' "$LIST_RESP" | jq -r '
        .data[]? | select(.type == "google-oauth") | .name
      ' | paste -sd ", " -)
      error_exit "No google-oauth credential named '$NAME'. Available Google accounts: ${AVAILABLE:-none}. Use action=list to confirm."
    fi

    # 2. Execute gmail-reader skill with the credential bound to 'gmail' slot
    EXEC_BODY=$(jq -nc --arg cid "$CRED_ID" --arg max "$MAX" '{
      agentId: "orchestrator",
      roleId: "orchestrator",
      userInput: $max,
      credentialBindings: {gmail: $cid}
    }')
    RESP=$(api_call POST "/skills/skill-gmail-reader/execute" "$EXEC_BODY")
    # Extract the stdout from the skill execution so the orchestrator sees
    # the human-readable summary directly
    printf '%s' "$RESP" | jq '
      if .success == true then
        {
          credential: "'"$NAME"'",
          credentialId: "'"$CRED_ID"'",
          success: .data.success,
          output: .data.output,
          error: .data.error,
          durationMs: .data.durationMs
        }
      else
        {success: false, error: .error}
      end
    '
    ;;

  *)
    error_exit "Unknown action: '$ACTION'. Valid: list, start-google-oauth, complete-google-oauth, import-google, clear-gemini-cli, add-api-key, delete, read-gmail"
    ;;
esac
