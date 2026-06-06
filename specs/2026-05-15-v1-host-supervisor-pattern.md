# V1-Layout Host Supervisor Pattern — systemd auto-restart for `crewly-start.sh`

**Author:** Sam (`crewly-product-sam-9487fefe`, Crewly Product TL)
**Date:** 2026-05-15
**Trigger:** WorkItem `ccbf0472` — CrewlyNode1 silent-down for ~21h (2026-05-14 16:52Z crash, hand-restarted 2026-05-15 13:00Z by Sora). v1 layout had no supervisor.
**Slack:** `D0AC7NF5N7L/1777343156.374869`
**KR4 template candidate:** "next v1-layout host gets supervised in <5 minutes"

---

## Problem this pattern solves

The "v1 layout" of a Crewly host is:
- `/home/crewly` working tree
- `npm install -g crewly` engine (resolved at `/usr/lib/node_modules/crewly`)
- `crewly-start.sh --background` launches a `tmux new-session -d -s crewly-pro` and detaches

When the engine inside tmux crashes (e.g. Slack socket-mode `finity` unhandled-event on 2026-05-14), the tmux session dies, no human notices, and the host stays silently down until somebody hand-runs `crewly-start.sh --background` again.

We need a supervisor that:
1. **Auto-restarts** the engine within ≤30s of any crash, without human-in-the-loop.
2. **Survives reboots** (enabled on `multi-user.target`).
3. **Has bounded restart-storm protection** (5 restarts in 5 minutes, then stop).
4. **Sends logs to journald** so `journalctl -u crewly` is the one-stop debug entry.
5. **Reuses the existing `crewly-start.sh`** entry point — no engine-internal changes.

## Decision: systemd over pm2

| | systemd | pm2 |
|---|---|---|
| Already on Ubuntu 24.04 | ✅ | ❌ (separate install + persistence layer) |
| Restart on exit | ✅ `Restart=always` | ✅ default |
| Survives reboot | ✅ `WantedBy=multi-user.target` | ⚠️ requires `pm2 startup` + `pm2 save` |
| Restart-storm guard | ✅ `StartLimitIntervalSec` + `StartLimitBurst` | ⚠️ `--max-restarts` flag, less granular |
| Log routing | ✅ journald → `journalctl -u crewly` | ⚠️ pm2's own log files, separate from system log |
| Conflict surface on a v1 host | low — no other systemd unit for crewly | medium — Pro layout uses pm2 already, separate persistence files |

Pick: **systemd** for v1 hosts. (v2 / `/opt/crewly` hosts continue using pm2 — different layout, different decision.)

## The unit file

Save as `/etc/systemd/system/crewly.service`:

```ini
[Unit]
Description=Crewly Pro (v1 layout: npm-global + supervised crewly-start.sh)
Documentation=https://github.com/stevehuang0115/crewly
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=300
StartLimitBurst=5

[Service]
Type=simple
User=crewly
Group=crewly
WorkingDirectory=/home/crewly
ExecStart=/home/crewly/crewly-start.sh
Restart=always
RestartSec=10
TimeoutStartSec=60
TimeoutStopSec=30
StandardOutput=journal
StandardError=journal
SyslogIdentifier=crewly

[Install]
WantedBy=multi-user.target
```

### Why these choices

- **`ExecStart=/home/crewly/crewly-start.sh`** (no `--background` flag) — runs in foreground so systemd can supervise the actual process. The `--background` mode spawns tmux and detaches, which would make systemd think the unit exited successfully.
- **`User=crewly` / `Group=crewly`** — keeps the same uid/gid as the previous tmux-launch pattern; no privilege change.
- **`WorkingDirectory=/home/crewly`** — the script `cd`s into `crewly-pro/` itself; this is just the entry directory.
- **No `EnvironmentFile=`** — the script source-loads `/home/crewly/.crewly/.env` itself; adding `EnvironmentFile=` here would double-load and the systemd parser doesn't tolerate shell-style `export KEY=val` lines.
- **`Restart=always` + `RestartSec=10`** — 10s gap between crash and restart attempt. In practice the engine takes another ~5s to boot, so total downtime per crash ≈ 15–20s. Brief target was ≤30s.
- **`StartLimitIntervalSec=300` + `StartLimitBurst=5`** — if the engine crashes 5 times within 5 minutes, systemd will stop trying. Catches a hard config-broken state instead of restart-looping forever.
- **`StandardOutput=journal`** — `journalctl -u crewly` shows all stdout/stderr. The script's `tee /home/crewly/logs/crewly-<TS>.log` still writes file logs as before; nothing lost.

## 5-minute install procedure

For any v1-layout host (CrewlyNode1, or future siblings):

```bash
HOST=104.248.15.63  # CrewlyNode1, replace per host

# 1. Copy unit
scp /etc/systemd/system/crewly.service root@$HOST:/etc/systemd/system/crewly.service
#    (or paste the unit file inline via heredoc if you don't have it locally)

# 2. Reload + enable
ssh root@$HOST 'systemctl daemon-reload && systemctl enable crewly.service'

# 3. Stop the existing tmux session (if any)
ssh root@$HOST 'sudo -u crewly tmux kill-session -t crewly-pro 2>/dev/null; true'

# 4. Start via systemd
ssh root@$HOST 'systemctl start crewly.service && sleep 8 && systemctl status crewly --no-pager | head -10'

# 5. Verify /health
ssh root@$HOST 'curl -s http://localhost:8787/health'
#    Expect: {"status":"healthy","version":"<X.Y.Z>"}

# 6. Kill-test (CRITICAL — proves the supervisor actually restarts)
ssh root@$HOST 'B_PID=$(ps -u crewly -o pid,cmd --no-headers | grep "max-old-space-size" | grep -v grep | awk "{print \$1}" | head -1); echo "killing $B_PID"; kill -9 "$B_PID"; START=$(date +%s); for i in $(seq 1 20); do sleep 2; H=$(curl -s --max-time 2 http://localhost:8787/health 2>/dev/null); if [ -n "$H" ]; then NOW=$(date +%s); echo "recovered after $((NOW-START))s"; break; fi; done'
#    Expect: "recovered after <N>s" where N ≤ 30
```

## Operating-runbook deltas

After install, these commands replace tmux-based ops:

| Old (tmux) | New (systemd) |
|---|---|
| `sudo -u crewly tmux new-session -d -s crewly-pro …` | `systemctl start crewly` |
| `sudo -u crewly tmux kill-session -t crewly-pro` | `systemctl stop crewly` |
| `sudo -u crewly tmux attach -t crewly-pro` | `journalctl -u crewly -f` (read-only; no live PTY) |
| (no-op — manual restart) | `systemctl restart crewly` |
| `tail -f /home/crewly/logs/crewly-*.log` | still works, plus `journalctl -u crewly -f` |

## Verified live — CrewlyNode1 2026-05-15

- Pre-install: tmux session `crewly-pro` running `crewly@1.5.22`
- Unit installed, enabled at 15:06Z UTC
- Tmux session killed; systemd started at 15:06:47Z
- Kill-test 1 (still on 1.5.22): `kill -9` backend node process → recovered in **16s** ✓
- Engine bumped: `npm install -g crewly@1.6.5` → `systemctl restart crewly`
- /health now reports `version: 1.6.5`, `port 8787` bound, agents `active: 1, total: 1`
- Kill-test 2 (post-bump): `kill -9` backend node process → recovered in **17s** ✓

## Failure modes this pattern does NOT solve (out of scope)

1. **State write to install dir** — engine logs `EACCES: permission denied, mkdir '/usr/lib/node_modules/crewly/.crewly'` periodically. The engine is trying to write runtime state to its own npm-install dir instead of `$CREWLY_HOME/.crewly`. Pre-existing on 1.5.22, still present on 1.6.5. Separate fix — likely needs `CREWLY_HOME` plumbing in the engine boot path (PR #452 territory).
2. **`ANTHROPIC_API_KEY` warning at startup** — host's `/home/crewly/.crewly/.env` has the key but the line is empty or mis-cased. Pre-existing config gap, not a supervisor concern.
3. **`__reconciler__` session warns + 403 CloudSync warns** — recurring, pre-existing, non-blocking. Tracked elsewhere.

## Next hosts

- Apply this pattern to **any v1-layout sibling** (anything with `npm install -g crewly` + `crewly-start.sh` + tmux). Expected install time: under 5 minutes per host via the procedure above.
- For **v2-layout / `/opt/crewly` hosts** (ESTestNode etc.) — keep using pm2; do not apply this pattern.
