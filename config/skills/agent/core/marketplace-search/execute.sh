#!/bin/bash
# Marketplace Search & Install - search and auto-install skills from the marketplace
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../../_common/lib.sh"

INPUT=$(read_json_input "${1:-}")
[ -z "$INPUT" ] && error_exit "Usage: execute.sh '{\"action\":\"search\",\"query\":\"code review\"}'"

ACTION=$(printf '%s' "$INPUT" | jq -r '.action // "search"')
QUERY=$(printf '%s' "$INPUT" | jq -r '.query // empty')
ITEM_ID=$(printf '%s' "$INPUT" | jq -r '.id // empty')
TYPE_FILTER=$(printf '%s' "$INPUT" | jq -r '.type // empty')
CATEGORY_FILTER=$(printf '%s' "$INPUT" | jq -r '.category // empty')

case "$ACTION" in
  search)
    require_param "query" "$QUERY"
    ENCODED_QUERY=$(printf '%s' "$QUERY" | jq -sRr @uri)
    ENDPOINT="/marketplace?search=${ENCODED_QUERY}"
    [ -n "$TYPE_FILTER" ] && ENDPOINT="${ENDPOINT}&type=${TYPE_FILTER}"
    [ -n "$CATEGORY_FILTER" ] && ENDPOINT="${ENDPOINT}&category=${CATEGORY_FILTER}"
    RESULT=$(api_call GET "$ENDPOINT")
    echo "$RESULT"
    ;;

  install)
    require_param "id" "$ITEM_ID"
    RESULT=$(api_call POST "/marketplace/${ITEM_ID}/install")
    echo "$RESULT"
    ;;

  search-and-install)
    require_param "query" "$QUERY"
    ENCODED_QUERY=$(printf '%s' "$QUERY" | jq -sRr @uri)
    ENDPOINT="/marketplace?search=${ENCODED_QUERY}"
    [ -n "$TYPE_FILTER" ] && ENDPOINT="${ENDPOINT}&type=skill"
    SEARCH_RESULT=$(api_call GET "$ENDPOINT")

    # Parse the first not_installed match
    MATCH=$(echo "$SEARCH_RESULT" | jq -r '
      [.[] | select(.installStatus == "not_installed")] | first // empty
    ')

    if [ -z "$MATCH" ] || [ "$MATCH" = "null" ]; then
      # Check if any are already installed
      INSTALLED=$(echo "$SEARCH_RESULT" | jq -r '
        [.[] | select(.installStatus == "installed")] | first // empty
      ')
      if [ -n "$INSTALLED" ] && [ "$INSTALLED" != "null" ]; then
        INSTALLED_NAME=$(echo "$INSTALLED" | jq -r '.name')
        echo "{\"success\":true,\"message\":\"Skill already installed: ${INSTALLED_NAME}\",\"action\":\"none\",\"item\":${INSTALLED}}"
      else
        echo "{\"success\":false,\"message\":\"No matching skills found for: ${QUERY}\",\"action\":\"none\",\"results\":${SEARCH_RESULT}}"
      fi
    else
      MATCH_ID=$(echo "$MATCH" | jq -r '.id')
      MATCH_NAME=$(echo "$MATCH" | jq -r '.name')
      INSTALL_RESULT=$(api_call POST "/marketplace/${MATCH_ID}/install")
      echo "{\"success\":true,\"message\":\"Installed ${MATCH_NAME}\",\"action\":\"installed\",\"item\":${MATCH},\"installResult\":${INSTALL_RESULT}}"
    fi
    ;;

  installed)
    RESULT=$(api_call GET "/marketplace/installed")
    echo "$RESULT"
    ;;

  updates)
    RESULT=$(api_call GET "/marketplace/updates")
    echo "$RESULT"
    ;;

  *)
    error_exit "Unknown action: ${ACTION}. Use: search, install, search-and-install, installed, updates"
    ;;
esac
