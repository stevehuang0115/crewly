---
name: Nano Banana Image Generation
description: "Generate images using Google's Gemini Nano Banana API. Supports standard (flash) and pro models. Use --pro flag for higher quality output with gemini-3-pro-image-preview."
version: 1.1.0
category: design
skillType: claude-skill
assignableRoles:
  - designer
triggers:
  - generate image
  - create image
  - nano banana
  - gemini image
  - ai image
tags:
  - image
  - generation
  - ai
  - gemini
  - api
  - pro
execution:
  type: script
  script:
    file: generate.sh
    interpreter: bash
    timeoutMs: 120000
environment:
notices:
  - type: requirement
    message: This skill requires a Gemini API key. Add your API key in the skill settings.
---

# Nano Banana Image Generation

This skill enables AI image generation through Google's Gemini API.

## Overview

The Nano Banana Image Generation skill allows agents to create images from text descriptions using Google's Gemini model. This is useful for:

- Creating concept art and visualizations
- Generating placeholder images for designs
- Producing custom graphics based on descriptions
- Rapid prototyping of visual content

## Usage

To generate an image, provide a detailed text description of what you want to create.

### Example Prompts

- "A futuristic cityscape at sunset with flying cars"
- "A cozy coffee shop interior with warm lighting"
- "An abstract representation of music and sound waves"

## API Configuration

This skill requires a Gemini API key to function. The API key should be stored in the skill's `.env` file:

```
GEMINI_API_KEY=your_api_key_here
```

### Getting an API Key

1. Visit [Google AI Studio](https://aistudio.google.com/apikey)
2. Sign in with your Google account
3. Create a new API key
4. Copy the key and add it to the skill configuration

## Best Practices

- Be specific and detailed in your image descriptions
- Include style preferences (realistic, artistic, minimalist, etc.)
- Specify desired colors, lighting, and mood
- Mention any specific elements that must be included

## Limitations

- Image generation may take 30-60 seconds
- Some content types may be restricted by the API
- Results may vary based on prompt complexity
