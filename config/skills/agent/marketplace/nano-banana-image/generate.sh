#!/bin/bash
# Nano Banana Image Generation Script
# This script calls the Gemini API to generate images
# Supports both standard (flash) and pro models

set -e

# Check for required environment variable
if [ -z "$GEMINI_API_KEY" ]; then
    echo "Error: GEMINI_API_KEY environment variable is not set"
    exit 1
fi

# Model selection
# Usage: generate.sh [prompt] [--pro]
#   --pro    Use gemini-3-pro-image-preview (higher quality)
#   default  Use gemini-2.0-flash-exp-image-generation (faster)
MODEL="gemini-2.5-flash-image"
PROMPT=""

for arg in "$@"; do
    if [ "$arg" = "--pro" ]; then
        MODEL="gemini-3-pro-image-preview"
    elif [ -z "$PROMPT" ]; then
        PROMPT="$arg"
    fi
done

if [ -z "$PROMPT" ]; then
    read -r PROMPT
fi

if [ -z "$PROMPT" ]; then
    echo "Error: No prompt provided"
    exit 1
fi

# API endpoint
API_URL="https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent"

# Create the request payload
PAYLOAD=$(cat <<EOF
{
  "contents": [
    {
      "parts": [
        {
          "text": "Generate an image: $PROMPT"
        }
      ]
    }
  ],
  "generationConfig": {
    "responseModalities": ["Text", "Image"]
  }
}
EOF
)

# Make the API call
RESPONSE=$(curl -s -X POST "$API_URL?key=$GEMINI_API_KEY" \
    -H "Content-Type: application/json" \
    -d "$PAYLOAD")

# Check for errors
if echo "$RESPONSE" | grep -q '"error"'; then
    echo "API Error:"
    echo "$RESPONSE" | jq -r '.error.message // .error'
    exit 1
fi

# Output the response
echo "$RESPONSE"
