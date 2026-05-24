# parse-session

Export AI coding agent sessions to JSON. Run in any project directory to auto-detect and export all sessions.

## Install

```bash
npm install -g @luswt/parse-session
```

## Usage

### Export sessions for current project

Navigate to your project directory and run:

```bash
parse-session
```

This scans all supported agent databases, finds sessions linked to the current directory, and exports them into `export-<agent>/` folders.

### Export for a specific agent

```bash
parse-session opencode
```

### Export a specific session by ID

```bash
parse-session ses_1a698034affeZJWB0IKPyDsErQ
```

### List recent sessions

```bash
parse-session --list
```

## Supported agents

| Agent | Database path |
|---|---|
| opencode | `~/.local/share/opencode/opencode.db` |

> More agents coming soon.

## Options

| Command | Description |
|---|---|
| `parse-session` | Auto-detect and export all sessions for current directory |
| `parse-session <agent>` | Export sessions for a specific agent |
| `parse-session --agent=<agent>` | Same as above |
| `parse-session <session_id>` | Export a single session by ID |
| `parse-session --list` / `-l` | List 20 most recent sessions |

## Environment variables

| Variable | Description |
|---|---|
| `OPENCODE_DB_PATH` | Override the default opencode database path |

## Output

Sessions are saved as JSON files with the following structure:

```json
{
  "model": "GLM 5.1",
  "summary": "Session title",
  "date": "2026-05-24T16:19:49.627Z",
  "duration": "5m 2s",
  "durationMinutes": 6,
  "tokensIn": 71745,
  "tokensOut": 9283,
  "totalTokens": 81028,
  "costUSD": 0.497667,
  "gitDiffUrl": null,
  "changes": [
    { "path": "src/index.js", "type": "modified", "additions": 12, "deletions": 3 }
  ]
}
```

## License

MIT
