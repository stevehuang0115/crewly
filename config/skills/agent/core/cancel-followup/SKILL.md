# cancel-followup

Cancel a follow-up trigger you previously created with `schedule-followup` or
`watch-for-event`. Accepts either the trigger `id` (returned at creation time)
or the stable `name`.

## When to call

**The moment you confirm the work is done.** `maxIdleFires` will eventually
auto-cancel idle watchers, but relying on it wastes fire cycles and pollutes
the task pool with no-op checks. Be explicit.

## By id vs by name

- **By id** is unambiguous but requires you to have kept the creation result.
- **By name** is scoped to your team — so if you named it semantically
  (e.g. `followup:verify-rex-draft`), anyone on your team can resolve it
  without needing the opaque UUID. The lookup never touches another team's
  triggers, even if names collide.

## Examples

```bash
# By id — most common when you still have the POST response
bash execute.sh --id 123e4567-e89b-12d3-a456-426614174000

# By name — useful when the id is long gone
bash execute.sh --name "followup:verify-rex-draft"
```

## Safety

- Name resolution is team-scoped: you cannot cancel another team's trigger by
  accidentally colliding names.
- If no matching active trigger is found, returns `success:false` with a
  human-readable reason — it does not error out loudly.
- Cancelling a trigger that's already `exhausted` or `cancelled` is a no-op
  (the API handles this idempotently).
