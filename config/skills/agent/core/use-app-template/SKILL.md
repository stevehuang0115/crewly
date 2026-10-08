---
name: Use App Template
description: Start a new Crewly App from a Crewly Marketplace template (found with find-app-template). Makes a new app in this account with fresh, empty data and you as its publisher, and writes the template's files into a directory in your project so you can adapt them and republish with publish-app.
version: 1.0.0
category: productivity
skillType: claude-skill
assignableRoles:
  - "*"
triggers:
  - use app template
  - start from a template
  - app from marketplace
tags:
  - apps
  - templates
  - marketplace
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 180000
---

# Use App Template

```bash
bash execute.sh tpl-k3m9p2x7aq --dir ./chores --name "Chores for Milo"
bash execute.sh --app 28au74d9cj --dir ./chores     # an app the owner already started from a template
```

Output:

```json
{"success":true,"appId":"28au74d9cj","name":"Chores for Milo","url":"https://apps.crewlyai.com/28au74d9cj","version":1,
 "fromTemplate":{"templateId":"tpl-k3m9p2x7aq","version":3,"name":"Chore chart"},
 "dir":"/…/chores","files":4,"capabilitiesNeeded":[],
 "dataSchema":[{"collection":"chores","fields":[{"name":"title","type":"string"}]}],
 "next":"…"}
```

1. **It makes the app now**, in this account, private, with the template's code
   as version 1 and **no data**. Using a template counts as creating an app (the
   account's app limit applies).
2. **The files are in `--dir`** (a new or empty directory inside your project).
   `dataSchema` lists the collections and fields the app uses.
3. **Adapt it to the owner**: change texts, fields, colours, add what they asked
   for. Then publish from the same directory — it goes to the same app:
   `publish-app --dir ./chores --notify`.
4. **Tell the owner in one line** which template you started from.
5. `capabilitiesNeeded` (e.g. `media_capture`) are not granted yet: ask the
   owner as the publish-app skill says.

`--app <appId>`: the owner started an app from a template in the portal and
handed it to you; this writes that template's files into `--dir` and makes
`--dir` the app's source, so `publish-app --dir` updates it.

Failures: `quota_exceeded` (the account has its maximum number of apps; tell
the owner), `not_found` (the template was unlisted), `validation` (the message
says what).
